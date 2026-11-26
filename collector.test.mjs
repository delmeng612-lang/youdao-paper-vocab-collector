import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const background = readFileSync(new URL("./background.js", import.meta.url), "utf8");
const content = readFileSync(new URL("./content.js", import.meta.url), "utf8");
const storage = {};
let onMessage;
let activeUrl = "https://youdao.com/";
let currentVerification = "unknown";
let download;
const chrome = {
  storage: { local: {
    get: async (key) => ({ [key]: storage[key] }),
    set: async (values) => Object.assign(storage, values),
  } },
  runtime: { onMessage: { addListener: (listener) => { onMessage = listener; } } },
  tabs: {
    query: async () => [{ id: 1, url: activeUrl }],
    sendMessage: async () => ({ word: new URL(activeUrl).searchParams.get("word"), verification: currentVerification }),
    onUpdated: { addListener: () => {} },
  },
  downloads: { download: async (options) => { download = options; return 1; } },
};
function definitionPage(word) {
  return `<div class="title">${word}</div><ul class="basic"><li class="word-exp"><span class="trans">测试释义</span></li></ul>`;
}

const htmlByWord = new Map([
  ["imputation", definitionPage("imputation")],
  ["imputatoin", '<div class="maybe">您要找的是不是其他词条？</div>'],
  ["in concert with", definitionPage("in concert with")],
  ["example-only", "<html></html>"],
]);
const fetchPage = async (url) => {
  const word = new URL(url).searchParams.get("word");
  const html = htmlByWord.get(word);
  return html ? { ok: true, text: async () => html } : { ok: false };
};
vm.runInNewContext(background, { chrome, URL, crypto, console, fetch: fetchPage, AbortController, setTimeout, clearTimeout });

const send = (type, payload = {}, sender = {}) => new Promise((resolve) => onMessage({ type, ...payload }, sender, resolve));
const query = (word, verification) => {
  const url = `https://youdao.com/result?word=${encodeURIComponent(word)}&lang=en`;
  return send("CAPTURE_WORD", { word, verification }, { tab: { id: 1 }, url });
};
const contents = () => decodeURIComponent(download.url.split(",", 2)[1]);

let result = await send("START_PAPER", { title: "Paper A" });
const paperA = result.data.activePaperId;
result = await query("imputation", "valid");
assert.equal(result.data.status, "collected");
assert.equal((await query("imputation", "valid")).data.status, "approved");
assert.equal((await query("imputatoin", "invalid")).data.status, "invalid");
assert.equal((await query("in concert with", "valid")).data.status, "collected");
result = await send("GET_STATE");
assert.deepEqual(Array.from(result.data.papers[0].words), ["imputation", "in concert with"]);
assert.equal(result.data.papers[0].pending.length, 0);

result = await send("EXPORT_PAPER", { paperId: paperA });
assert.equal(contents(), "imputation\n");
result = await send("EXPORT_ENTRIES_PAPER", { paperId: paperA });
assert.equal(contents(), "imputation\nin concert with\n");

result = await send("START_PAPER", { title: "Paper B" });
const paperB = result.data.activePaperId;
result = await query("imputation", "valid");
assert.equal(result.data.status, "cross_paper");
assert.equal((await query("imputation", "valid")).data.status, "cross_paper");
result = await send("GET_STATE");
assert.deepEqual(Array.from(result.data.papers[1].pending), ["imputation"]);
assert.equal(result.data.papers[1].words.length, 0);
result = await send("APPROVE_PENDING", { paperId: paperB, word: "imputation" });
assert.equal(result.ok, true);
result = await send("EXPORT_ALL");
assert.equal(contents(), "imputation\n");

result = await query("unknownterm", "unknown");
assert.equal(result.data.status, "queued");
result = await query("unknownterm", "invalid");
assert.equal(result.data.status, "invalid");
assert.equal((await send("GET_STATE")).data.papers[1].pending.length, 0);

activeUrl = "https://youdao.com/result?word=cohort&lang=en";
currentVerification = "valid";
result = await send("CAPTURE_CURRENT");
assert.equal(result.data.status, "collected");
assert.equal((await send("GET_STATE")).data.papers[1].words.includes("cohort"), true);

result = await send("DELETE_WORD", { paperId: paperB, word: "cohort" });
assert.equal(result.ok, true);
assert.equal((await query("cohort", "valid")).data.status, "ignored");

function pageResult(word, headword, definition, missing = false) {
  const root = {
    querySelector(selector) {
      if (selector === ".ec.dict-module .word-head .title") return headword ? { childNodes: [{ nodeType: 3, textContent: headword }] } : null;
      if (selector === ".dict-book .simple .basic .word-exp .trans") return definition ? { textContent: definition } : null;
      if (selector === ".maybe") return missing ? {} : null;
      return null;
    },
  };
  const context = vm.createContext({
    URL, Node: { TEXT_NODE: 3 }, Date,
    location: { href: `https://youdao.com/result?word=${encodeURIComponent(word)}&lang=en` },
    document: { querySelector: (selector) => selector === ".search_result-dict" ? root : null },
    chrome: { runtime: { onMessage: { addListener: () => {} }, sendMessage: async () => ({}) } },
    addEventListener: () => {}, setInterval: () => {},
  });
  vm.runInContext(content, context);
  return vm.runInContext(`verificationFromPage(${JSON.stringify(word)})`, context);
}
assert.equal(pageResult("imputation", "imputation", "归罪"), "valid");
assert.equal(pageResult("in concert with", "in concert with", "与……一起"), "valid");
assert.equal(pageResult("imputatoin", null, null, true), "invalid");
assert.equal(pageResult("imputation", "imputatoin", "归罪"), "unknown");
assert.equal(pageResult("imputation", null, null), "unknown");

storage.vocabState = {
  version: 1, activePaperId: "legacy", paused: false,
  papers: [{ id: "legacy", title: "Older pending records", createdAt: "2026-11-26", words: [],
    pending: ["imputation", "in concert with", "imputatoin"], ignored: [] }],
};
result = await send("RECHECK_PENDING");
assert.equal(result.ok, true);
assert.equal(result.data.collected, 2);
assert.equal(result.data.rejected, 1);
assert.deepEqual(Array.from(storage.vocabState.papers[0].words), ["imputation", "in concert with"]);
assert.equal(storage.vocabState.papers[0].pending.length, 0);

storage.vocabState = {
  version: 1, activePaperId: "legacy", paused: false,
  papers: [{ id: "legacy", title: "Older approved records", createdAt: "2026-11-26",
    words: ["imputation", "imputatoin", "example-only"], pending: [], ignored: [] }],
};
result = await send("RECHECK_CONFIRMED");
assert.equal(result.ok, true);
assert.equal(result.data.verified, 1);
assert.equal(result.data.pending, 1);
assert.equal(result.data.rejected, 1);
assert.deepEqual(Array.from(storage.vocabState.papers[0].words), ["imputation"]);
assert.deepEqual(Array.from(storage.vocabState.papers[0].pending), ["example-only"]);
assert.deepEqual(Array.from(storage.vocabState.papers[0].ignored), ["imputatoin"]);
assert.equal(storage.vocabState.confirmedAuditVersion, 1);

console.log("PASS: auto verification, typo rejection, phrase capture, dedupe, cross-paper review, TXT export, legacy audits");
