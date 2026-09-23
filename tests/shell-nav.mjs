/**
 * shell-nav — headless checks for the app-shell redesign:
 * shared desktop/mobile grouping, no duplicate destinations, palette
 * coverage, and the mobile bottom stack.
 *
 * Boots the built app twice (desktop 1280 + mobile 390, fresh module
 * evaluation per boot) and asserts:
 *  Desktop: sidebar section headers are exactly
 *           Create/Capture/Organize/Explore in order; no Craft/Stats/
 *           Skills nav entries (single Settings); Ctrl+K palette still
 *           surfaces Inbox, Canvas, and Files.
 *  Mobile: BottomBar More menu sections are exactly
 *           Create/Capture/Organize/Explore/Tools in order; one Settings
 *           entry, no Craft/Stats/Skills; every workspace reachable via
 *           main row + More; StatusBar NOT rendered (save signal lives
 *           in BottomBar instead of a second bottom strip).
 *
 * Run: npm run build && node tests/shell-nav.mjs
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

// ── Desktop boot ────────────────────────────────────────────────────
{
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 1280;
  dom.window.innerHeight = 800;
  const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 200));

  await import(bundleUrl);
  await sleep(2500);
  const q = (s) => dom.window.document.querySelector(s);
  const qa = (s) => [...dom.window.document.querySelectorAll(s)];

  const headers = qa(".workspace-nav .nav-group-label").map((el) => el.textContent.trim());
  check("desktop sidebar groups unified", JSON.stringify(headers) === JSON.stringify(["Create", "Capture", "Organize", "Explore"]), headers.join("|"));
  const navLabels = qa(".workspace-nav .nav-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("no Craft/Stats/Skills sidebar entries", !navLabels.some((l) => ["Craft", "Stats", "Skills"].includes(l)), navLabels.join(","));
  check("single Settings entry", navLabels.filter((l) => l === "Settings").length === 1);
  // Promoted Home: persistent top-level button in the breadcrumb row.
  const homeBtn = q('.breadcrumb-bar button[aria-label="Go to Home"]');
  check("breadcrumb promotes Home to top", !!homeBtn);
  // Clicking it from another workspace returns home (write first).
  const writeBtn = qa(".workspace-nav .nav-item").find((b) => (b.getAttribute("aria-label") || "") === "Write");
  writeBtn?.click();
  await sleep(700);
  homeBtn?.click();
  await sleep(700);
  const homeHtml = dom.window.document.getElementById("app")?.innerHTML || "";
  check("promoted Home navigates home", homeHtml.includes("home-pane"));

  // Palette still surfaces the sidebar-hidden destinations.
  dom.window.dispatchEvent(new dom.window.CustomEvent("open-command-palette"));
  await sleep(600);
  const results = qa(".palette-result").map((b) => b.textContent.trim()).join("\n");
  for (const label of ["Go to Canvas", "Go to Files", "Open Inbox"]) {
    check(`palette surfaces "${label}"`, results.includes(label));
  }
  console.log(`INFO  desktop console.error count: ${errors.length}`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.log("ERR  ", e);
  if (errors.length > 0) failures++;
  console.error = (..._) => {};
}

// ── Mobile boot ─────────────────────────────────────────────────────
{
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = 390;
  dom.window.innerHeight = 844;
  const errors = [];
  console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 200));

  await import(bundleUrl + "?boot=mobile");
  await sleep(2500);
  const q = (s) => dom.window.document.querySelector(s);
  const qa = (s) => [...dom.window.document.querySelectorAll(s)];

  check("BottomBar renders on mobile", !!q(".bottom-bar"));
  check("StatusBar hidden on mobile (no double bottom strip)", !q(".status-bar"));

  const moreBtn = qa(".bottom-bar-item").find((b) => (b.getAttribute("aria-label") || "") === "More");
  check("More button present", !!moreBtn);
  moreBtn?.click();
  await sleep(600);
  const sections = qa(".more-section-label").map((el) => el.textContent.trim());
  check("mobile More sections unified", JSON.stringify(sections) === JSON.stringify(["Create", "Capture", "Organize", "Explore", "Tools"]), sections.join("|"));
  const moreLabels = qa(".more-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("one Settings entry, no duplicates", moreLabels.filter((l) => l === "Settings").length === 1 && !moreLabels.some((l) => ["Craft", "Stats", "Skills"].includes(l)), moreLabels.join(","));
  for (const dest of ["Logs", "Inbox", "Map", "Canvas", "Novel", "Script", "Projects", "Reader", "Files", "Library"]) {
    if (!moreLabels.includes(dest)) check(`mobile reaches "${dest}"`, false);
  }
  check("all 10 More destinations reachable", ["Logs", "Inbox", "Map", "Canvas", "Novel", "Script", "Projects", "Reader", "Files", "Library"].every((d) => moreLabels.includes(d)), moreLabels.join(","));
  const mainLabels = qa(".bottom-bar-item").map((b) => (b.getAttribute("aria-label") || "").trim());
  check("main row keeps Write/Home/Search", ["Write", "Home", "Search"].every((d) => mainLabels.includes(d)), mainLabels.join(","));

  console.log(`INFO  mobile console.error count: ${errors.length}`);
  for (const e of [...new Set(errors)].slice(0, 8)) console.log("ERR  ", e);
  if (errors.length > 0) failures++;
}

console.log(failures === 0 ? "SHELL-NAV ALL PASS" : `SHELL-NAV ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
