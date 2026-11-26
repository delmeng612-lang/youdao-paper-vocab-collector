const el = (id) => document.getElementById(id);
let state = null;
el("buildVersion").textContent = `v${chrome.runtime.getManifest().version}`;

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    if (response?.error === "未知操作。") {
      throw new Error("扩展后台仍是旧版：请到扩展管理页点“重新加载”，然后关掉并重开弹窗。");
    }
    throw new Error(response?.error || "操作失败。");
  }
  return response.data;
}

function notice(text, isError = false) {
  el("message").textContent = text;
  el("message").classList.toggle("error", isError);
}

function activePaper() {
  return state?.papers.find((paper) => paper.id === state.activePaperId);
}

function render() {
  if (!state) return;
  const paper = activePaper();
  const select = el("paperSelect");
  select.replaceChildren();

  if (!state.papers.length) {
    const option = new Option("请先创建文献", "");
    select.add(option);
  } else {
    for (const item of state.papers) select.add(new Option(item.title, item.id));
    select.value = state.activePaperId || state.papers[0].id;
  }
  select.disabled = !state.papers.length;

  el("statusText").textContent = !paper ? "尚未开始" : state.paused ? "已暂停" : "正在核对并自动收录";
  el("pauseButton").textContent = state.paused ? "继续收集" : "暂停收集";
  el("pauseButton").disabled = !paper;
  el("captureCurrent").disabled = !paper || state.paused;

  const words = paper?.words || [];
  const pending = paper?.pending || [];
  const ignored = paper?.ignored || [];
  el("pendingCount").textContent = String(pending.length);
  el("ignoredCount").textContent = String(ignored.length);
  el("paperCount").textContent = String(words.length);
  const total = new Set(state.papers.flatMap((item) => item.words)).size;
  el("allCount").textContent = `累计 ${total}`;
  el("exportPaper").disabled = !words.some((word) => !word.includes(" "));
  el("exportAll").disabled = !state.papers.some((item) => item.words.some((word) => !word.includes(" ")));
  el("exportEntriesPaper").disabled = !words.length;
  el("exportEntriesAll").disabled = !total;
  el("exportBackup").disabled = !state.papers.length;
  el("emptyHint").hidden = words.length > 0;
  el("pendingHint").hidden = pending.length > 0;
  el("ignoredHint").hidden = ignored.length > 0;

  const pendingList = el("pendingList");
  pendingList.replaceChildren();
  for (const word of pending) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.className = "entry-label";
    label.textContent = word;
    const otherPapers = state.papers.filter((other) => other.id !== paper.id && other.words.includes(word));
    if (otherPapers.length) {
      const badge = document.createElement("small");
      badge.className = "other-paper";
      badge.textContent = `已在其他 ${otherPapers.length} 篇文献收录`;
      badge.title = otherPapers.map((other) => other.title).join("；");
      label.append(badge);
    }
    const actions = document.createElement("span");
    actions.className = "entry-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.textContent = "收录";
    approve.className = "approve";
    approve.setAttribute("aria-label", `收录 ${word}`);
    approve.addEventListener("click", () => act("APPROVE_PENDING", { paperId: paper.id, word }));
    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.textContent = "忽略";
    ignore.className = "ignore";
    ignore.setAttribute("aria-label", `忽略 ${word}`);
    ignore.addEventListener("click", () => act("IGNORE_PENDING", { paperId: paper.id, word }));
    actions.append(approve, ignore);
    item.append(label, actions);
    pendingList.append(item);
  }

  const list = el("wordList");
  list.replaceChildren();
  for (const word of words) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = word;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.textContent = "删除";
    remove.setAttribute("aria-label", `删除 ${word}`);
    remove.addEventListener("click", () => act("DELETE_WORD", { paperId: paper.id, word }));
    item.append(label, remove);
    list.append(item);
  }

  const ignoredList = el("ignoredList");
  ignoredList.replaceChildren();
  for (const word of ignored) {
    const item = document.createElement("li");
    const label = document.createElement("span");
    label.textContent = word;
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "重新检查";
    restore.setAttribute("aria-label", `重新检查 ${word}`);
    restore.addEventListener("click", () => act("RESTORE_IGNORED", { paperId: paper.id, word }));
    item.append(label, restore);
    ignoredList.append(item);
  }
}

async function refresh() {
  state = await request("GET_STATE");
  render();
}

async function act(type, payload) {
  try {
    const result = await request(type, payload);
    if (type.startsWith("EXPORT_")) notice(`已开始导出 ${result.count} 个单词。`);
    else { state = result; render(); notice(""); }
  } catch (error) {
    notice(error.message, true);
  }
}

el("newPaperForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = el("paperTitle").value;
  await act("START_PAPER", { title });
  if (activePaper()?.title.toLocaleLowerCase() === title.trim().replace(/\s+/g, " ").toLocaleLowerCase()) {
    el("paperTitle").value = "";
  }
});

el("paperSelect").addEventListener("change", (event) => act("SELECT_PAPER", { paperId: event.target.value }));
el("pauseButton").addEventListener("click", () => act("SET_PAUSED", { paused: !state.paused }));
el("captureCurrent").addEventListener("click", async () => {
  try {
    const result = await request("CAPTURE_CURRENT");
    await refresh();
    const messages = {
      collected: `${result.word} 已核对并自动收录。`,
      invalid: `有道没有找到 ${result.word} 的对应词条，未收录。`,
      cross_paper: `${result.word} 已在其他文献收录，请决定是否加入本篇。`,
      queued: `${result.word} 的释义暂无法自动核实，已放入待确认。`,
      pending: `${result.word} 已在待确认列表中。`,
      approved: `${result.word} 已在本篇词表中。`,
      ignored: `${result.word} 已被忽略，可在下方重新检查。`
    };
    notice(messages[result.status] || "当前未收集。");
  } catch (error) {
    notice(error.message, true);
  }
});
el("exportPaper").addEventListener("click", () => act("EXPORT_PAPER", { paperId: state.activePaperId }));
el("exportAll").addEventListener("click", () => act("EXPORT_ALL"));
el("exportEntriesPaper").addEventListener("click", () => act("EXPORT_ENTRIES_PAPER", { paperId: state.activePaperId }));
el("exportEntriesAll").addEventListener("click", () => act("EXPORT_ENTRIES_ALL"));
el("exportBackup").addEventListener("click", async () => {
  try {
    const result = await request("EXPORT_BACKUP");
    notice(`已开始备份 ${result.count} 篇文献。`);
  } catch (error) {
    notice(error.message, true);
  }
});
el("chooseBackup").addEventListener("click", () => el("importBackup").click());
el("importBackup").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const result = await request("IMPORT_BACKUP", { backup });
    await refresh();
    notice(`已恢复 ${result.addedPapers} 篇文献、${result.addedWords} 个单词；原有记录已保留。`);
  } catch (error) {
    notice(`导入失败：${error.message}`, true);
  } finally {
    event.target.value = "";
  }
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.vocabState) refresh().catch((error) => notice(error.message, true));
});

refresh().then(async () => {
  const updates = [];
  if (state.papers.some((paper) => paper.pending?.length)) {
    notice("正在用有道词典核对已有待确认词条…");
    const result = await request("RECHECK_PENDING");
    await refresh();
    if (result.collected || result.rejected) updates.push(`待确认中自动收录 ${result.collected} 条，排除 ${result.rejected} 条。`);
  }
  if (state.confirmedAuditVersion !== 1) {
    notice("正在复核旧版已收录词条…");
    const result = await request("RECHECK_CONFIRMED");
    await refresh();
    updates.push(`旧词条核对完成：${result.verified} 条有释义，${result.pending} 条待确认，${result.rejected} 条未找到。`);
    if (result.unavailable) updates.push(`${result.unavailable} 条暂时无法联网核实，原记录已保留。`);
  }
  notice(updates.join(" "));
}).catch((error) => notice(error.message, true));
