/**
 * ws-toggles — headless checks for Settings workspace tabs on/off
 * (Area 12) + Files-route retirement.
 *
 * NOTE: SettingsPane itself is a lazy chunk whose stylesheet <link> never resolves under jsdom, so the pane can't render here
 * (same documented limit as lazy-load-probe). This probe therefore
 * verifies the wiring around it, which is all eager:
 * - preset hiddenIds hide workspaces from the sidebar;
 * - palette + mobile More still reach hidden AND virtual (Files) targets;
 * - "Go to Files" selects Library (deep link fires without errors).
 *
 * The checkbox UI (11 toggles incl. persistence) is verified by code
 * inspection + the shared settings write path (onboard-flow.mjs covers
 * hiddenIds/topBarIds persistence end to end).
 *
 * Run: npm run build && node tests/ws-toggles.mjs
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

function rig(dom) {
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
  const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
  if (dom.window.Range) {
    if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
    if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
  }
  if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
  globalThis.devicePixelRatio = 1;
  globalThis.window.devicePixelRatio = 1;
}

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
const bundleUrl = pathToFileURL(join(root, "dist/assets", jsName)).href;

// ── Boot 1: hiddenIds preset hides Novel from sidebar ───────────────
{
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({
    hasOnboarded: true,
    hiddenIds: ["novel", "inbox", "canvas"],
  }));
  console.error = (..._) => {};
  await import(bundleUrl + "?boot=ws-hidden");
  await sleep(2500);

  const qa = (s) => [...dom.window.document.querySelectorAll(s)];
  const navLabels = qa(".workspace-nav .nav-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("hidden Novel leaves the sidebar", !navLabels.includes("Novel"), navLabels.join(","));
  check("visible Write stays", navLabels.includes("Write"));

  // Palette still reaches hidden + virtual destinations.
  dom.window.dispatchEvent(new dom.window.CustomEvent("open-command-palette"));
  await sleep(600);
  const results = qa(".palette-result").map((b) => b.textContent.trim()).join("\n");
  check("palette reaches hidden Novel", results.includes("Go to Novel Studio"));
  check("palette reaches virtual Files", results.includes("Go to Files"));

  // "Go to Files" selects Library without errors (deep link target).
  const filesEntry = qa(".palette-result").find((b) => b.textContent.trim() === "Go to Files");
  const errCount = [];
  console.error = (...a) => errCount.push(a);
  filesEntry?.click();
  await sleep(800);
  check("Go to Files fires without errors", errCount.length === 0, errCount.slice(0, 2).join(" | "));
  console.error = (..._) => {};
}

// ── Boot 2: defaults unchanged (no hiddenIds key) ───────────────────
{
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ hasOnboarded: true }));
  console.error = (..._) => {};
  await import(bundleUrl + "?boot=ws-defaults");
  await sleep(2500);
  const qa = (s) => [...dom.window.document.querySelectorAll(s)];
  const navLabels = qa(".workspace-nav .nav-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("defaults keep Novel visible", navLabels.includes("Novel"));
  check("defaults hide Inbox/Canvas, never Files-route", !navLabels.includes("Inbox") && !navLabels.includes("Canvas") && !navLabels.some((l) => l === "Files"), navLabels.join(","));
  console.error = (..._) => {};
}

console.log(failures === 0 ? "WS-TOGGLES ALL PASS" : `WS-TOGGLES ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
