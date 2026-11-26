const STORAGE_KEY = "vocabState";
let queue = Promise.resolve();

function serial(task) {
  const next = queue.then(task);
  queue = next.catch(() => {});
  return next;
}

function emptyState() {
  return { version: 1, confirmedAuditVersion: 1, activePaperId: null, paused: false, papers: [] };
}

async function readState() {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  if (!stored || stored.version !== 1 || !Array.isArray(stored.papers)) {
    return emptyState();
  }
  for (const paper of stored.papers) {
    if (!Array.isArray(paper.pending)) paper.pending = [];
    if (!Array.isArray(paper.ignored)) paper.ignored = [];
  }
  return stored;
}

async function writeState(state) {
  await chrome.storage.local.set({ [STORAGE_KEY]: state });
  return state;
}

function cleanEntry(value) {
  if (typeof value !== "string") return null;
  const entry = value.trim().replace(/\s+/g, " ").toLowerCase();
  const parts = entry.split(" ");
  return entry.length <= 80 && parts.length <= 5 &&
    parts.every((part) => /^[a-z]+(?:['-][a-z]+)*$/.test(part)) ? entry : null;
}

function wordFromResultUrl(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return null;
    if (!["youdao.com", "dict.youdao.com", "www.youdao.com"].includes(url.hostname)) return null;
    if (url.pathname === "/result" || url.pathname === "/result/") {
      return cleanEntry(url.searchParams.get("word"));
    }
    const match = url.pathname.match(/^\/w\/(?:eng\/)?([^/]+)\/?$/);
    return match ? cleanEntry(decodeURIComponent(match[1].replace(/_/g, " "))) : null;
  } catch {
    return null;
  }
}

function isYoudaoResult(urlValue) {
  try {
    const url = new URL(urlValue);
    if (url.protocol !== "https:") return false;
    if (!["youdao.com", "dict.youdao.com", "www.youdao.com"].includes(url.hostname)) return false;
    return url.pathname === "/result" || url.pathname === "/result/" || /^\/w\/(?:eng\/)?[^/]+\/?$/.test(url.pathname);
  } catch {
    return false;
  }
}

async function captureWord(state, word, verification = "unknown") {
  const paper = state.papers.find((item) => item.id === state.activePaperId);
  if (!word || !paper || state.paused) return "inactive";
  if (paper.words.includes(word)) return "approved";
  if (paper.ignored.includes(word)) return "ignored";
  if (verification === "invalid") {
    if (paper.pending.includes(word)) {
      paper.pending = paper.pending.filter((item) => item !== word);
      await writeState(state);
    }
    return "invalid";
  }
  const inOtherPaper = state.papers.some((item) => item.id !== paper.id && item.words.includes(word));
  if (verification === "valid" && !inOtherPaper) {
    paper.pending = paper.pending.filter((item) => item !== word);
    paper.words.push(word);
    await writeState(state);
    return "collected";
  }
  if (paper.pending.includes(word)) return inOtherPaper ? "cross_paper" : "pending";
  paper.pending.push(word);
  await writeState(state);
  return inOtherPaper ? "cross_paper" : "queued";
}

async function verificationFromTab(tab, word) {
  if (!tab?.id) return "unknown";
  try {
    const result = await chrome.tabs.sendMessage(tab.id, { type: "VERIFY_CURRENT" });
    if (result?.word === word && ["valid", "invalid"].includes(result.verification)) {
      return result.verification;
    }
  } catch {
    // Existing Youdao tabs may need a refresh after the extension is reloaded.
  }
  return "unknown";
}

function decodeHtmlText(value) {
  return value
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_match, code) => {
      const point = code[0].toLowerCase() === "x" ? parseInt(code.slice(1), 16) : Number(code);
      return point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    })
    .replace(/&(amp|apos|quot|lt|gt);/gi, (_match, name) => ({
      amp: "&", apos: "'", quot: '"', lt: "<", gt: ">"
    })[name.toLowerCase()]);
}

function verificationFromHtml(html, word) {
  const titles = [...html.matchAll(/<div class="title"[^>]*>([^<]+)/g)]
    .map((match) => decodeHtmlText(match[1]).trim().replace(/\s+/g, " ").toLowerCase());
  const hasDefinition = /<ul class="basic"[^>]*>\s*<li class="word-exp"[^>]*>[\s\S]{0,500}<span class="trans"[^>]*>[^<\s]/.test(html);
  if (titles.includes(word) && hasDefinition) return "valid";
  if (/<div class="maybe"(?:\s|>)/.test(html)) return "invalid";
  return "unknown";
}

async function verifyPendingWord(word) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`https://youdao.com/result?word=${encodeURIComponent(word)}&lang=en`, { signal: controller.signal });
    if (!response.ok) throw new Error("有道词典暂时无法访问。");
    return verificationFromHtml(await response.text(), word);
  } finally {
    clearTimeout(timeout);
  }
}

async function recheckPending(state) {
  const candidates = state.papers.flatMap((paper) => paper.pending
    .filter((word) => !state.papers.some((other) => other.id !== paper.id && other.words.includes(word)))
    .map((word) => ({ paperId: paper.id, word })));
  const results = [];
  for (let start = 0; start < candidates.length; start += 4) {
    const batch = await Promise.all(candidates.slice(start, start + 4).map(async (candidate) => {
      try { return await verifyPendingWord(candidate.word); }
      catch { return "unknown"; }
    }));
    results.push(...batch);
  }
  let collected = 0;
  let rejected = 0;
  for (const [index, candidate] of candidates.entries()) {
    const paper = state.papers.find((item) => item.id === candidate.paperId);
    if (!paper?.pending.includes(candidate.word)) continue;
    const verification = results[index];
    if (verification === "invalid") {
      paper.pending = paper.pending.filter((item) => item !== candidate.word);
      rejected++;
    } else if (verification === "valid" && !state.papers.some((item) => item.id !== paper.id && item.words.includes(candidate.word))) {
      paper.pending = paper.pending.filter((item) => item !== candidate.word);
      if (!paper.words.includes(candidate.word)) paper.words.push(candidate.word);
      collected++;
    }
  }
  if (collected || rejected) await writeState(state);
  return { collected, rejected };
}

async function recheckConfirmed(state) {
  if (state.confirmedAuditVersion === 1) return { verified: 0, pending: 0, rejected: 0, unavailable: 0 };
  const words = [...new Set(state.papers.flatMap((paper) => paper.words))];
  const verdicts = new Map();
  for (let start = 0; start < words.length; start += 6) {
    const batch = await Promise.all(words.slice(start, start + 6).map(async (word) => {
      try { return await verifyPendingWord(word); }
      catch { return "unavailable"; }
    }));
    words.slice(start, start + 6).forEach((word, index) => verdicts.set(word, batch[index]));
  }
  let verified = 0;
  let pending = 0;
  let rejected = 0;
  let unavailable = 0;
  for (const paper of state.papers) {
    for (const word of [...paper.words]) {
      const verdict = verdicts.get(word);
      if (verdict === "valid") verified++;
      else if (verdict === "invalid") {
        paper.words = paper.words.filter((item) => item !== word);
        if (!paper.ignored.includes(word)) paper.ignored.push(word);
        rejected++;
      } else if (verdict === "unknown") {
        paper.words = paper.words.filter((item) => item !== word);
        if (!paper.pending.includes(word)) paper.pending.push(word);
        pending++;
      } else unavailable++;
    }
  }
  if (!unavailable) state.confirmedAuditVersion = 1;
  await writeState(state);
  return { verified, pending, rejected, unavailable };
}

function safeFilename(value) {
  return value
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "-")
    .replace(/[. ]+$/g, "")
    .slice(0, 70) || "paper";
}

function singleWords(entries) {
  return entries.filter((entry) => !entry.includes(" "));
}

async function downloadWords(words, filename) {
  if (!words.length) throw new Error("词表为空，暂时无法导出。");
  await downloadText(`${words.join("\n")}\n`, filename);
  return { count: words.length };
}

async function downloadText(text, filename) {
  const url = `data:text/plain;charset=utf-8,${encodeURIComponent(text)}`;
  await chrome.downloads.download({ url, filename, saveAs: true });
}

function validateBackup(backup) {
  if (backup?.format !== "youdao-vocab-collector-backup" || backup.formatVersion !== 1) {
    throw new Error("请选择本扩展导出的完整备份 JSON 文件。");
  }
  const incoming = backup.state;
  if (incoming?.version !== 1 || !Array.isArray(incoming.papers)) {
    throw new Error("备份内容不完整。");
  }
  for (const paper of incoming.papers) {
    if (typeof paper.id !== "string" || typeof paper.title !== "string" ||
        !paper.title.trim() || !Array.isArray(paper.words) ||
        paper.words.some((word) => cleanEntry(word) !== word) ||
        (paper.pending !== undefined && (!Array.isArray(paper.pending) || paper.pending.some((word) => cleanEntry(word) !== word))) ||
        (paper.ignored !== undefined && (!Array.isArray(paper.ignored) || paper.ignored.some((word) => cleanEntry(word) !== word)))) {
      throw new Error("备份中有无效的文献或单词记录。");
    }
  }
  return incoming;
}

async function dispatch(message, sender) {
  if (!message || typeof message.type !== "string") throw new Error("无效请求。");
  const state = await readState();

  switch (message.type) {
    case "GET_STATE":
      return state;

    case "RECHECK_PENDING":
      return recheckPending(state);

    case "RECHECK_CONFIRMED":
      return recheckConfirmed(state);

    case "START_PAPER": {
      const title = typeof message.title === "string" ? message.title.trim().replace(/\s+/g, " ") : "";
      if (!title || title.length > 180) throw new Error("请输入不超过 180 字的文献标题。");
      let paper = state.papers.find((item) => item.title.toLocaleLowerCase() === title.toLocaleLowerCase());
      if (!paper) {
        paper = { id: crypto.randomUUID(), title, createdAt: new Date().toISOString(), words: [], pending: [], ignored: [] };
        state.papers.push(paper);
      }
      state.activePaperId = paper.id;
      state.paused = false;
      await writeState(state);
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const currentWord = tab?.url ? wordFromResultUrl(tab.url) : null;
        if (currentWord) await captureWord(state, currentWord, await verificationFromTab(tab, currentWord));
      } catch {
        // A missing active tab must not prevent starting a reading session.
      }
      return state;
    }

    case "SELECT_PAPER": {
      if (!state.papers.some((paper) => paper.id === message.paperId)) throw new Error("未找到这篇文献。");
      state.activePaperId = message.paperId;
      state.paused = false;
      return writeState(state);
    }

    case "SET_PAUSED":
      state.paused = Boolean(message.paused);
      return writeState(state);

    case "CAPTURE_CURRENT": {
      if (!state.activePaperId) throw new Error("请先选择当前文献。");
      if (state.paused) throw new Error("请先继续收集。");
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      const word = tab?.url ? wordFromResultUrl(tab.url) : null;
      if (!word) throw new Error("当前标签页不是可识别的有道单词结果页。请复制地址栏网址以便排查。");
      return { word, status: await captureWord(state, word, await verificationFromTab(tab, word)) };
    }

    case "CAPTURE_WORD": {
      if (!sender.tab || !isYoudaoResult(sender.url)) return { status: "inactive" };
      const word = cleanEntry(message.word);
      if (!word || wordFromResultUrl(sender.url) !== word) return { status: "inactive" };
      return { status: await captureWord(state, word, message.verification) };
    }

    case "APPROVE_PENDING": {
      const paper = state.papers.find((item) => item.id === message.paperId);
      const word = cleanEntry(message.word);
      if (!paper || !word || !paper.pending.includes(word)) throw new Error("待确认列表中没有这个词条。");
      paper.pending = paper.pending.filter((item) => item !== word);
      if (!paper.words.includes(word)) paper.words.push(word);
      return writeState(state);
    }

    case "IGNORE_PENDING": {
      const paper = state.papers.find((item) => item.id === message.paperId);
      const word = cleanEntry(message.word);
      if (!paper || !word || !paper.pending.includes(word)) throw new Error("待确认列表中没有这个词条。");
      paper.pending = paper.pending.filter((item) => item !== word);
      if (!paper.ignored.includes(word)) paper.ignored.push(word);
      return writeState(state);
    }

    case "RESTORE_IGNORED": {
      const paper = state.papers.find((item) => item.id === message.paperId);
      const word = cleanEntry(message.word);
      if (!paper || !word || !paper.ignored.includes(word)) throw new Error("已忽略列表中没有这个词条。");
      paper.ignored = paper.ignored.filter((item) => item !== word);
      if (!paper.words.includes(word) && !paper.pending.includes(word)) paper.pending.push(word);
      return writeState(state);
    }

    case "DELETE_WORD": {
      const paper = state.papers.find((item) => item.id === message.paperId);
      const word = cleanEntry(message.word);
      if (!paper || !word) throw new Error("未找到这个单词。");
      if (!paper.words.includes(word)) throw new Error("已收录列表中没有这个词条。");
      paper.words = paper.words.filter((item) => item !== word);
      if (!paper.ignored.includes(word)) paper.ignored.push(word);
      return writeState(state);
    }

    case "EXPORT_PAPER": {
      const paper = state.papers.find((item) => item.id === message.paperId);
      if (!paper) throw new Error("请先选择一篇文献。");
      return downloadWords(singleWords(paper.words), `文献单词-${safeFilename(paper.title)}.txt`);
    }

    case "EXPORT_ALL": {
      const words = [...new Set(state.papers.flatMap((paper) => singleWords(paper.words)))];
      return downloadWords(words, "文献单词-累计总词表.txt");
    }

    case "EXPORT_ENTRIES_PAPER": {
      const paper = state.papers.find((item) => item.id === message.paperId);
      if (!paper) throw new Error("请先选择一篇文献。");
      return downloadWords(paper.words, `文献全部词条-${safeFilename(paper.title)}.txt`);
    }

    case "EXPORT_ENTRIES_ALL": {
      const entries = [...new Set(state.papers.flatMap((paper) => paper.words))];
      return downloadWords(entries, "文献全部词条-累计总表.txt");
    }

    case "EXPORT_BACKUP": {
      const backup = { format: "youdao-vocab-collector-backup", formatVersion: 1, state };
      await downloadText(`${JSON.stringify(backup, null, 2)}\n`, "文献生词-完整备份.json");
      return { count: state.papers.length };
    }

    case "IMPORT_BACKUP": {
      const incoming = validateBackup(message.backup);
      const wasEmpty = state.papers.length === 0;
      let addedPapers = 0;
      let addedWords = 0;
      const importedIds = new Map();
      for (const source of incoming.papers) {
        let target = state.papers.find((paper) => paper.title.toLocaleLowerCase() === source.title.toLocaleLowerCase());
        if (!target) {
          const id = state.papers.some((paper) => paper.id === source.id) ? crypto.randomUUID() : source.id;
          target = { id, title: source.title, createdAt: source.createdAt, words: [], pending: [], ignored: [] };
          state.papers.push(target);
          addedPapers++;
        }
        importedIds.set(source.id, target.id);
        for (const word of source.words) {
          target.pending = target.pending.filter((item) => item !== word);
          target.ignored = target.ignored.filter((item) => item !== word);
          if (!target.words.includes(word)) {
            target.words.push(word);
            addedWords++;
          }
        }
        for (const word of source.ignored || []) {
          if (!target.words.includes(word) && !target.ignored.includes(word)) {
            target.pending = target.pending.filter((item) => item !== word);
            target.ignored.push(word);
          }
        }
        for (const word of source.pending || []) {
          if (!target.words.includes(word) && !target.ignored.includes(word) && !target.pending.includes(word)) target.pending.push(word);
        }
      }
      if (wasEmpty) {
        state.activePaperId = importedIds.get(incoming.activePaperId) || state.papers[0]?.id || null;
        state.paused = Boolean(incoming.paused);
      }
      if (addedWords) state.confirmedAuditVersion = 0;
      await writeState(state);
      return { addedPapers, addedWords };
    }

    default:
      throw new Error("未知操作。");
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  serial(() => dispatch(message, sender))
    .then((data) => sendResponse({ ok: true, data }))
    .catch((error) => sendResponse({ ok: false, error: error.message || "操作失败。" }));
  return true;
});
