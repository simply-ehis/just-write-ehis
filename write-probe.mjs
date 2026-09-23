/**
 * write-probe — actually types into the Just Write editor (via a real
 * EditorView.dispatch transaction retrieved from the live DOM, exactly
 * the same pipeline a keystroke uses) and checks whether the content
 * (a) renders in the DOM and (b) survives the autosave debounce into
 * localStorage. This goes further than smoke-dom.mjs, which only checks
 * that workspaces mount without throwing.
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import { EditorView } from "@codemirror/view";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dom = new JSDOM(
  `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true }
);

// Node has native CustomEvent/Event globals that are a DIFFERENT class
// than jsdom's window.CustomEvent/Event. The app calls window.dispatchEvent
// with `new CustomEvent(...)`, so both must come from the same realm
// (jsdom's) or dispatchEvent throws "parameter 1 is not of type 'Event'".
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
console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 300));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);
await new Promise((r) => setTimeout(r, 1500));

function q(sel) { return dom.window.document.querySelector(sel); }
function qa(sel) { return [...dom.window.document.querySelectorAll(sel)]; }

// 1. Navigate to Just Write workspace.
const navBtn = qa(".workspace-nav button").find((b) =>
  /just write|^write$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim())
);
console.log(navBtn ? "PASS  found Just Write nav button" : "FAIL  no Just Write nav button found");
navBtn?.click();
await new Promise((r) => setTimeout(r, 600));

// 2. Create a doc if we landed on an empty state.
const newDocBtn = qa("button").find((b) => /new document/i.test(b.textContent || ""));
if (newDocBtn) {
  newDocBtn.click();
  await new Promise((r) => setTimeout(r, 600));
  console.log("INFO  clicked New Document (empty state present)");
} else {
  console.log("INFO  no empty-state New Document button (doc already open, or button not found)");
}

// 3. Find the live CodeMirror view via the real DOM node.
const cmRoot = q(".cm-editor");
console.log(cmRoot ? "PASS  .cm-editor mounted in DOM" : "FAIL  .cm-editor NOT found in DOM — editor never mounted");
if (!cmRoot) {
  console.log(`INFO  console.error count so far: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log("ERR  ", e);
  process.exit(1);
}
const view = EditorView.findFromDOM(cmRoot);
console.log(view ? "PASS  EditorView instance recovered from DOM" : "FAIL  could not recover EditorView instance");
if (!view) process.exit(1);

const before = view.state.doc.toString();
const probe = "PROBE_TEXT_" + Date.now();

// 4. Dispatch a real transaction — identical to what a keystroke produces.
view.dispatch({ changes: { from: view.state.doc.length, insert: probe } });
await new Promise((r) => setTimeout(r, 50));

const afterState = view.state.doc.toString();
console.log(afterState.includes(probe) ? "PASS  editor state contains typed text" : "FAIL  editor state does NOT contain typed text");

const domText = cmRoot.textContent || "";
console.log(domText.includes(probe) ? "PASS  typed text rendered into DOM" : "FAIL  typed text NOT rendered into DOM (state/view desync)");

// 5. Wait past the autosave debounce (component uses 500ms) and check persistence.
await new Promise((r) => setTimeout(r, 900));
const docsRaw = dom.window.localStorage.getItem("jwe-browser-docs-v1") || "[]";
let persisted = false;
try {
  const docs = JSON.parse(docsRaw);
  persisted = docs.some((d) => (d.content || "").includes(probe));
} catch {}
console.log(persisted ? "PASS  typed text persisted to localStorage after debounce" : "FAIL  typed text NOT found in persisted store after debounce");

console.log(`INFO  console.error count: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 15)) console.log("ERR  ", e);

const ok = view && afterState.includes(probe) && domText.includes(probe) && persisted && errors.length === 0;
process.exit(ok ? 0 : 1);
