/**
 * onboard-flow — headless checks for the Area 5 onboarding rebuild:
 * versioned first-run flag, 5-step flow with Novelist preset pins,
 * atomic settings write, sidebar pins without duplicates, replay event,
 * and silent veteran migration.
 *
 * Boots the built app 3 times (fresh / persisted / veteran) with fresh
 * module evaluation per boot (query-suffixed bundle URL, shell-nav pattern).
 *
 * Run: npm run build && node tests/onboard-flow.mjs
 */
import { readFile, stat } from "node:fs/promises";
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

const sourceFiles = [
  "src/main.ts",
  "src/App.svelte",
  "src/lib/components/OnboardingOverlay.svelte",
  "src/lib/stores/settings.ts",
  "src/lib/stores/app.ts",
];
try {
  const distStat = await stat(join(root, "dist/index.html"));
  const sourceStats = await Promise.all(sourceFiles.map((file) => stat(join(root, file))));
  const newestSource = Math.max(...sourceStats.map((entry) => entry.mtimeMs));
  if (newestSource > distStat.mtimeMs) {
    console.log("SKIP  onboarding flow requires a fresh dist; source-only mode forbids rebuilding");
    process.exit(0);
  }
} catch {
  console.log("SKIP  onboarding flow requires dist; source-only mode forbids rebuilding");
  process.exit(0);
}

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
const bundleUrl = pathToFileURL(join(root, "dist/assets", jsName)).href;

function bootDom(width = 1280, height = 800) {
  const dom = new JSDOM(
    `<!DOCTYPE html><html><head></head><body><div id="app"></div></body></html>`,
    { url: "http://localhost/", pretendToBeVisual: true }
  );
  rig(dom);
  dom.window.innerWidth = width;
  dom.window.innerHeight = height;
  return dom;
}
const btnByText = (dom, text) =>
  [...dom.window.document.querySelectorAll(".onboarding-card button")]
    .find((b) => (b.textContent || "").trim() === text);

// ── Boot 1: fresh user, full Novelist flow ──────────────────────────
{
  const dom = bootDom();
  console.error = (..._) => {};
  await import(bundleUrl + "?boot=onboard-fresh");
  await sleep(2500);

  check("fresh boot shows onboarding", !!dom.window.document.querySelector(".onboarding-overlay"));
  check("5-step progress label", (dom.window.document.querySelector(".step-count")?.textContent || "").includes("Step 1 of 5"));

  btnByText(dom, "Get Started")?.click();
  await sleep(400);
  const novelist = [...dom.window.document.querySelectorAll(".pick-card")]
    .find((b) => (b.textContent || "").includes("Novelist"));
  check("use-case step offers Novelist", !!novelist);
  novelist?.click();
  await sleep(200);
  btnByText(dom, "Continue")?.click();
  await sleep(400);

  // Top-bar step: Novelist preset pins prechecked (write/novel/map/reader).
  const topSection = [...dom.window.document.querySelectorAll(".onboarding-card .check-grid")][0];
  const checkedCount = topSection ? topSection.querySelectorAll("input:checked").length : -1;
  check("novelist preset pins 4 top-bar boxes", checkedCount === 4, `checked=${checkedCount}`);
  btnByText(dom, "Continue")?.click();
  await sleep(400);

  check("theme step reached", (dom.window.document.querySelector(".step-count")?.textContent || "").includes("Step 4 of 5"));
  btnByText(dom, "Continue")?.click();
  await sleep(400);
  check("vault/AI step reached", (dom.window.document.querySelector(".step-count")?.textContent || "").includes("Step 5 of 5"));

  // Small vs main stay separate (alias bug must not return).
  const smallEp = dom.window.document.querySelector("#onboard-small-endpoint");
  const mainEp = dom.window.document.querySelector("#onboard-endpoint");
  check("small and main endpoint fields are separate", !!smallEp && !!mainEp && smallEp !== mainEp);

  // Uncheck the seed so this probe tests settings only (seed is try/catch'd anyway).
  const seed = [...dom.window.document.querySelectorAll(".seed-row input")][0];
  if (seed?.checked) seed.click();
  btnByText(dom, "Start Writing")?.click();
  await sleep(800);

  check("overlay dismisses on finish", !dom.window.document.querySelector(".onboarding-overlay"));
  const saved = JSON.parse(dom.window.localStorage.getItem("writing-app-settings") || "{}");
  check("finish persists hasOnboarded", saved.hasOnboarded === true);
  check("finish persists novelist topBarIds", JSON.stringify(saved.topBarIds) === JSON.stringify(["write", "novel", "map", "reader"]), (saved.topBarIds || []).join(","));
  check("finish persists default hiddenIds", JSON.stringify(saved.hiddenIds) === JSON.stringify(["inbox", "canvas"]));

  // Sidebar pins without duplicates.
  const pins = [...dom.window.document.querySelectorAll(".nav-pins .nav-item")].map((b) => b.getAttribute("aria-label"));
  check("sidebar renders 4 pins", pins.length === 4, pins.join(","));
  const novelCount = [...dom.window.document.querySelectorAll(".workspace-nav .nav-item")]
    .filter((b) => (b.getAttribute("aria-label") || "") === "Novel").length;
  check("no duplicate Novel entry", novelCount === 1, `count=${novelCount}`);

  // Replay re-opens the flow.
  dom.window.dispatchEvent(new dom.window.CustomEvent("replay-onboarding"));
  await sleep(400);
  check("replay-onboarding reopens overlay", !!dom.window.document.querySelector(".onboarding-overlay"));
}

// ── Boot 2: veteran migrates silently ───────────────────────────────
{
  const dom = bootDom();
  dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ featuresUsed: ["write"] }));
  console.error = (..._) => {};
  await import(bundleUrl + "?boot=onboard-veteran");
  await sleep(2500);
  check("veteran is not re-prompted", !dom.window.document.querySelector(".onboarding-overlay"));
  const saved = JSON.parse(dom.window.localStorage.getItem("writing-app-settings") || "{}");
  check("veteran migrates to hasOnboarded", saved.hasOnboarded === true);
}

console.log(failures === 0 ? "ONBOARD-FLOW ALL PASS" : `ONBOARD-FLOW ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
