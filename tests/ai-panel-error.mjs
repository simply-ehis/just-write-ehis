/**
 * ai-panel-error — dead-endpoint chat reaches the Error+Retry state in
 * the REAL AiPanel (not a mock): boot with a dead main slot, open the
 * panel, send a message, and assert an "Error: …" assistant bubble with
 * a working Retry button appears — and that Retry re-sends (proving the
 * button is wired, not decorative).
 *
 * The backend half (friendly rejection + local fallback) is covered by
 * tests/ai-error-probe.mjs; this covers the UI half end to end.
 *
 * Run: npm run build && node tests/ai-panel-error.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dom = new JSDOM(
  `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true }
);

delete globalThis.CustomEvent;
delete globalThis.Event;
for (const key of [
  "window", "Window", "document", "navigator", "localStorage", "sessionStorage",
  "HTMLElement", "Element", "Node", "Text", "Comment", "Document",
  "DocumentFragment", "DocumentType", "NodeList", "HTMLCollection",
  "Range", "Selection", "NodeFilter", "HTMLMediaElement", "HTMLAudioElement",
  "HTMLVideoElement", "HTMLImageElement", "Image", "Audio", "SVGElement",
  "SVGSVGElement", "SVGGraphicsElement", "HTMLInputElement", "HTMLTextAreaElement",
  "HTMLSelectElement", "HTMLButtonElement", "HTMLAnchorElement", "HTMLDivElement",
  "HTMLSpanElement", "HTMLCanvasElement", "Event", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "PointerEvent", "WheelEvent", "DragEvent", "ClipboardEvent",
  "FocusEvent", "InputEvent", "MutationObserver", "MutationRecord",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "DOMParser", "XMLSerializer", "DOMTokenList",
]) {
  if (key in dom.window && !(key in globalThis)) globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (dom.window.Range) {
  if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
  if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
}
if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.window.innerWidth = 1280;
globalThis.window.innerHeight = 800;
globalThis.devicePixelRatio = 1;
globalThis.window.devicePixelRatio = 1;

const errors = [];
console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 200));

// Dead main slot (fast refuse) + panel open on boot.
dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({
  mainModelEndpoint: "http://127.0.0.1:9/v1",
  mainModelName: "dead-model",
  aiRateLimitCooldown: 0,
}));
dom.window.localStorage.setItem("jwe-ui-panels", JSON.stringify({ sidebar: true, ai: true, inspector: false }));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);
// jsdom never fires load on Vite's injected stylesheet links, so lazy
// chunks (the AI panel included) would hang forever. Fire them manually:
// this bypasses ONLY the asset mechanism to reach the panel under test
// (the loader failure path itself is covered by tests/novel-surface.mjs).
const fireLinkLoads = () => {
  for (const link of [...dom.window.document.querySelectorAll('link[rel="stylesheet"]')]) {
    if (!link.dataset.fired) {
      link.dataset.fired = "1";
      link.dispatchEvent(new dom.window.Event("load"));
    }
  }
};
const linkTimer = setInterval(fireLinkLoads, 100);
await new Promise((r) => setTimeout(r, 2500));

function q(sel) { return dom.window.document.querySelector(sel); }
function qa(sel) { return [...dom.window.document.querySelectorAll(sel)]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("AI panel open on boot", !!q(".ai-panel"));
if (!q(".ai-panel")) {
  const html = dom.window.document.getElementById("app")?.innerHTML || "";
  console.log(`INFO  app len=${html.length} shell=${html.includes("app-shell")} panels-ls=${dom.window.localStorage.getItem("jwe-ui-panels")}`);
}

// Type into the chat input (Svelte bind:value listens for input events).
const input = q(".ai-input textarea");
check("chat input present", !!input);
if (input) {
  input.value = "hello dead endpoint";
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  await sleep(200);
  const send = q('.ai-input button[aria-label="Send message"]');
  check("send button enabled with text", !!send && !send.disabled);
  send?.click();
  // conversationCreate + failed stream attempt (fast refuse, no retry).
  await sleep(2500);

  const errorBubble = qa(".ai-panel .message .content").find((el) =>
    (el.textContent || "").startsWith("Error:")
  );
  check("dead chat reaches Error bubble", !!errorBubble, (errorBubble?.textContent || "").slice(0, 80));
  const retry = q(".ai-panel .retry-btn");
  check("Retry button rendered", !!retry);

  // Retry re-sends: lastUserMessage restored into the input.
  retry?.click();
  await sleep(2500);
  const bubbles = qa(".ai-panel .message .content").filter((el) =>
    (el.textContent || "").startsWith("Error:")
  );
  check("retry re-sends and fails again (button wired)", bubbles.length >= 2, `${bubbles.length} error bubbles`);
}

console.log(`INFO  console.error count: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 10)) console.log("ERR  ", e);
if (errors.length > 0) failures++;

clearInterval(linkTimer);
console.log(failures === 0 ? "AI-PANEL-ERROR ALL PASS" : `AI-PANEL-ERROR ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
