/**
 * theme-sweep — boots the built app once per theme (dark, light,
 * brutalist, glass — the full data-theme set Ehis signed off) and
 * asserts the shell mounts with zero console errors under each.
 *
 * This proves per-theme JS robustness (theme-branched code like the
 * editor surface and panel prefs) — not visual contrast, which needs
 * eyes on a real webview. Pair with a manual look per theme.
 *
 * Run: npm run build && node tests/theme-sweep.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const KEYS = [
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
];

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
const bundleUrl = pathToFileURL(join(root, "dist/assets", jsName)).href;

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

for (const theme of ["dark", "light", "brutalist", "glass"]) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  delete globalThis.CustomEvent;
  delete globalThis.Event;
  for (const key of KEYS) {
    if (!(key in dom.window)) continue;
    try {
      globalThis[key] = dom.window[key];
    } catch {
      try {
        Object.defineProperty(globalThis, key, {
          value: dom.window[key], writable: true, configurable: true,
        });
      } catch { /* keep Node's */ }
    }
  }
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  if (dom.window.Range) {
    if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
    if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  }
  if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;

  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ theme }));
  const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 200));

  await import(`${bundleUrl}?theme=${theme}`);
  await new Promise((r) => setTimeout(r, 2500));

  const html = dom.window.document.getElementById("app")?.innerHTML ?? "";
  check(`[${theme}] shell mounts`, html.includes("app-shell"));
  check(`[${theme}] nav renders`, html.includes("workspace-nav"));
  check(`[${theme}] no console errors`, errors.length === 0, errors.slice(0, 3).join(" | "));
  console.error = (..._) => {};
}

console.log(failures === 0 ? "THEME-SWEEP ALL PASS" : `THEME-SWEEP ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
