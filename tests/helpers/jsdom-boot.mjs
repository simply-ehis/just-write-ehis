/**
 * jsdom-boot — shared harness for headless probes that mount the built app.
 *
 * One realm per process: boot exactly ONE JSDOM + bundle import per Node
 * process. A second bundle evaluation in the same realm (e.g. via a
 * `?query`-suffixed import) creates a duplicate Svelte runtime while lazy
 * chunks still bind the first, surfacing a spurious `effect_orphan` that
 * cannot happen in production (one webview per realm).
 *
 * jsdom never fires stylesheet <link> load/error events, but Vite's chunk
 * preload helper awaits them before resolving dynamic imports — without
 * rigLinkLoads() the App shell never mounts headless. Real browsers and
 * the Tauri webview fire these normally; the shim is test-only.
 */
import { JSDOM } from "jsdom";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const KEYS = [
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
  "DOMParser", "XMLSerializer", "DOMTokenList", "VisualViewport",
];

const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });

/** Install jsdom globals + geometry stubs + stylesheet-link load shim. */
export function rig(dom) {
  delete globalThis.CustomEvent;
  delete globalThis.Event;
  for (const key of KEYS) {
    if (!(key in dom.window)) continue;
    try {
      globalThis[key] = dom.window[key];
    } catch {
      // Node 24 ships getter-only globals (e.g. navigator): replace the
      // property so the harness realm wins for every boot.
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
    if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  }
  if (dom.window.Element && !dom.window.Element.prototype.getClientRects) {
    dom.window.Element.prototype.getClientRects = function () { return []; };
  }
  {
    const doc = dom.window.document;
    const origCreate = doc.createElement.bind(doc);
    doc.createElement = (tag, opts) => {
      const el = origCreate(tag, opts);
      if (String(tag).toLowerCase() === "link") {
        queueMicrotask(() => el.dispatchEvent(new dom.window.Event("load")));
      }
      return el;
    };
  }
  globalThis.devicePixelRatio = 1;
  if (globalThis.window) globalThis.window.devicePixelRatio = 1;
}

/** Fresh rigged DOM at the given viewport. */
export function bootDom(width = 1280, height = 800) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = width;
  dom.window.innerHeight = height;
  return dom;
}

/** Resolve the built entry chunk URL from dist/index.html. */
export async function resolveBundle(root) {
  const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
  const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
  if (!jsName) throw new Error("no bundle in dist/index.html (run npm run build first)");
  return pathToFileURL(join(root, "dist/assets", jsName)).href;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
