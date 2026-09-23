/**
 * ghost-widget — headless behavioral checks for the inline ghost
 * autocomplete rendering (src/lib/ghostWidget.ts).
 *
 * Builds a real CodeMirror EditorView in jsdom with [ghostField,
 * ghostInlinePlugin()] and verifies: no widget initially; dispatching
 * setGhostEffect renders .cm-ghost-inline with the suggestion text at
 * the cursor; moving the cursor carries it along; clearing removes it;
 * replacing swaps text without crashing. Zero console errors.
 *
 * Run: node tests/ghost-widget.mjs (no build needed — imports the TS
 * module directly via node's type stripping)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dom = new JSDOM(
  `<!DOCTYPE html><html><head></head><body><div id="host"></div></body></html>`,
  { url: "http://localhost/", pretendToBeVisual: true }
);

delete globalThis.CustomEvent;
delete globalThis.Event;
for (const key of [
  "window", "Window", "document", "navigator", "localStorage", "sessionStorage",
  "HTMLElement", "Element", "Node", "Text", "Comment", "Document",
  "DocumentFragment", "DocumentType", "NodeList", "HTMLCollection",
  "Range", "Selection", "NodeFilter", "HTMLElement", "HTMLInputElement",
  "HTMLTextAreaElement", "Event", "CustomEvent", "KeyboardEvent",
  "MouseEvent", "MutationObserver", "MutationRecord",
  "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame",
  "DOMParser", "XMLSerializer", "DOMTokenList",
]) {
  if (key in dom.window && !(key in globalThis)) globalThis[key] = dom.window[key];
}
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (dom.window.Range) {
  if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
  if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
}
if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
if (dom.window.Element && !dom.window.Element.prototype.scrollIntoView) dom.window.Element.prototype.scrollIntoView = function () {};
globalThis.window.innerWidth = 1280;
globalThis.window.innerHeight = 800;

const errors = [];
console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 300));

const { EditorState } = await import("@codemirror/state");
const { EditorView } = await import("@codemirror/view");
const mod = await import(pathToFileURL(join(root, "src/lib/ghostWidget.ts")).href);
const { ghostField, ghostInlinePlugin, setGhostEffect, GHOST_INLINE_CLASS } = mod;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("ghost module exports field/effect/plugin", !!(ghostField && setGhostEffect && ghostInlinePlugin));

const host = dom.window.document.getElementById("host");
const view = new EditorView({
  state: EditorState.create({ doc: "the quick brown fox", extensions: [ghostField, ghostInlinePlugin()] }),
  parent: host,
});
const widget = () => host.querySelector(`.${GHOST_INLINE_CLASS}`);

check("no ghost widget before any suggestion", !widget());
check("field starts null", view.state.field(ghostField) === null);

// Show a suggestion at end of doc.
view.dispatch({ selection: { anchor: view.state.doc.length }, effects: setGhostEffect.of(" jumps") });
await new Promise((r) => setTimeout(r, 30));
const w1 = widget();
check("widget renders after set effect", !!w1);
check("widget shows suggestion text", w1?.textContent === " jumps", JSON.stringify(w1?.textContent));
check("field holds suggestion", view.state.field(ghostField) === " jumps");

// Cursor move carries the inline ghost along (it renders at head).
view.dispatch({ selection: { anchor: 3 } });
await new Promise((r) => setTimeout(r, 30));
const w2 = widget();
check("widget survives cursor move", !!w2 && w2.textContent === " jumps");

// Typing does not crash the plugin and keeps the widget live.
view.dispatch({ changes: { from: 0, insert: "X" } });
await new Promise((r) => setTimeout(r, 30));
check("widget survives typing", !!widget());

// Replace + clear.
view.dispatch({ effects: setGhostEffect.of(" replacement") });
await new Promise((r) => setTimeout(r, 30));
check("widget swaps to new text", widget()?.textContent === " replacement");
view.dispatch({ effects: setGhostEffect.of(null) });
await new Promise((r) => setTimeout(r, 30));
check("widget removed after clear", !widget());
check("field null after clear", view.state.field(ghostField) === null);

view.destroy();

console.log(`INFO  console.error count: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 10)) console.log("ERR  ", e);
if (errors.length > 0) failures++;

console.log(failures === 0 ? "GHOST-WIDGET ALL PASS" : `GHOST-WIDGET ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
