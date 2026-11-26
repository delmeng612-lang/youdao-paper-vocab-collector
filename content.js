function wordFromResultUrl(href) {
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return null;
    if (!["youdao.com", "dict.youdao.com", "www.youdao.com"].includes(url.hostname)) return null;

    let query = null;
    if (url.pathname === "/result" || url.pathname === "/result/") {
      query = url.searchParams.get("word");
    } else {
      const match = url.pathname.match(/^\/w\/(?:eng\/)?([^/]+)\/?$/);
      if (match) query = decodeURIComponent(match[1].replace(/_/g, " "));
    }

    if (!query) return null;
    const entry = query.trim().replace(/\s+/g, " ").toLowerCase();
    const parts = entry.split(" ");
    return entry.length <= 80 && parts.length <= 5 &&
      parts.every((part) => /^[a-z]+(?:['-][a-z]+)*$/.test(part)) ? entry : null;
  } catch {
    return null;
  }
}

function verificationFromPage(word) {
  const root = document.querySelector(".search_result-dict");
  if (!root) return "unknown";

  const title = root.querySelector(".ec.dict-module .word-head .title");
  const headword = title && [...title.childNodes]
    .filter((node) => node.nodeType === Node.TEXT_NODE)
    .map((node) => node.textContent)
    .join("")
    .trim().replace(/\s+/g, " ").toLowerCase();
  const definition = root.querySelector(".dict-book .simple .basic .word-exp .trans");
  if (headword === word && definition?.textContent.trim()) return "valid";
  if (root.querySelector(".maybe")) return "invalid";
  return "unknown";
}

let observedUrl = "";
let observedAt = 0;
let sentVerification = "";
let pollTimer;

function captureNewResult() {
  const href = location.href;
  if (href !== observedUrl) {
    observedUrl = href;
    observedAt = Date.now();
    sentVerification = "";
  }
  const word = wordFromResultUrl(href);
  if (!word) return;
  const verification = verificationFromPage(word);
  if (verification === "unknown" && Date.now() - observedAt < 10000) return;
  if (verification === sentVerification) return;
  sentVerification = verification;
  try {
    chrome.runtime.sendMessage({ type: "CAPTURE_WORD", word, verification })
      .catch(() => {
        if (chrome.runtime?.id) sentVerification = "";
        else clearInterval(pollTimer);
      });
  } catch {
    clearInterval(pollTimer);
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "VERIFY_CURRENT") return;
  const word = wordFromResultUrl(location.href);
  sendResponse({ word, verification: word ? verificationFromPage(word) : "unknown" });
});

captureNewResult();
addEventListener("DOMContentLoaded", captureNewResult);
addEventListener("popstate", captureNewResult);
addEventListener("hashchange", captureNewResult);
pollTimer = setInterval(captureNewResult, 700);
