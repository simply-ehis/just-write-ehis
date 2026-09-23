/**
 * lazy-load-probe — clicks through every code-split ("lazy") workspace
 * (Novel, Script, Map, Reader, Projects, Library, Settings — everything
 * wrapped in LazyWorkspace.svelte in App.svelte) and reports whether each
 * one ever gets past its "Loading…" placeholder.
 *
 * IMPORTANT CAVEAT, read before trusting a red result at face value:
 * LazyWorkspace's loader is a plain `import()` of a Svelte component, but
 * in a PRODUCTION Vite build that import is wrapped by Vite's own
 * `__vitePreload` helper, which — for any chunk that has its own CSS file
 * (every one of these does) — injects a `<link rel="stylesheet">` and
 * waits for its `load` event before the import resolves. jsdom (the
 * environment this script runs the built app under) does NOT fetch or
 * fire load/error events for injected stylesheet links by default, so
 * every lazy workspace will show "stuck loading: true" here even if the
 * app is perfectly fine in a real browser/webview. That is why this is a
 * PROBE, not a pass/fail test — a red result here is not proof of a bug.
 *
 * What it IS proof of: this is the exact mechanism ("wait on a <link>'s
 * load event before showing the workspace, with the failure path
 * completely unlogged — see LazyWorkspace.svelte's empty .catch()") that
 * would produce precisely the symptom reported — a workspace that is
 * simply empty, forever, with nothing in the console — if anything about
 * asset/stylesheet loading behaves differently in the packaged Tauri app
 * than it does in `vite dev` (CSP blocking style-src, a wrong base path,
 * an asset-protocol race on cold launch, a stale chunk reference after an
 * update, etc). Use this script to confirm the mechanism is real (it is —
 * see the source dump in the area writeup), then verify on a real machine
 * with devtools open whether it's actually firing in production.
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
  "window", "document", "navigator", "localStorage", "sessionStorage",
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
if (dom.window.Range) {
  dom.window.Range.prototype.getClientRects = () => [];
  dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
}
if (dom.window.Element) dom.window.Element.prototype.getClientRects = function () { return []; };
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.window.innerWidth = 1280;
globalThis.window.innerHeight = 800;
globalThis.devicePixelRatio = 1;
globalThis.window.devicePixelRatio = 1;

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)[1];
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);
await new Promise((r) => setTimeout(r, 1500));

const btns = [...dom.window.document.querySelectorAll(".workspace-nav button")];

for (const label of ["Novel", "Script", "Map", "Reader", "Projects", "Library", "Settings"]) {
  const btn = btns.find((b) => (b.getAttribute("aria-label") || "").trim() === label);
  if (!btn) { console.log(label.padEnd(10), "-> nav button not found"); continue; }
  btn.click();
  await new Promise((r) => setTimeout(r, 1500));
  const html = dom.window.document.getElementById("app").innerHTML;
  const stuck = html.includes("lazy-state") && html.includes("Loading");
  const failed = html.includes("Couldn't load this view") || html.includes("lazy-retry");
  console.log(label.padEnd(10), "-> stuck loading:", stuck, "| shows failed state:", failed);
}
