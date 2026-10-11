/**
 * tabs-functional — every tab must DO its core job, not just mount.
 * Boots the built app once in jsdom, clicks each workspace nav item, and
 * asserts workspace-specific functional markers (plus real actions: inbox
 * capture creates a doc, new script/project buttons create docs, theme
 * select actually switches the theme).
 *
 * Run: npm run build && node tests/tabs-functional.mjs
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
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (dom.window.Range) {
  if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
  if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
}
if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
const appendChild = dom.window.document.head.appendChild.bind(dom.window.document.head);
dom.window.document.head.appendChild = (node) => {
  const result = appendChild(node);
  if (node.tagName === "LINK" && node.rel === "stylesheet") {
    setTimeout(() => node.dispatchEvent(new dom.window.Event("load")), 0);
  }
  return result;
};
globalThis.window.innerWidth = 1280;
globalThis.window.innerHeight = 800;
globalThis.devicePixelRatio = 1;
globalThis.window.devicePixelRatio = 1;

const errors = [];
console.error = (...a) => errors.push(a.map(String).join(" ").slice(0, 300));

dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ theme: "dark" }));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const doc = dom.window.document;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  for (;;) {
    let v = false;
    try { v = fn(); } catch { v = false; }
    if (v) return true;
    if (Date.now() - t0 > timeoutMs) return false;
    await sleep(400);
  }
}
function clickNav(label) {
  // Labels can carry live suffixes ("Capture, 3 untriaged") — prefix match.
  const btn = [...doc.querySelectorAll(".workspace-nav .nav-item")]
    .find((b) => {
      const a = (b.getAttribute("aria-label") || "").trim();
      return a === label || a.startsWith(label + ",") || a.startsWith(label + " ");
    });
  if (!btn) return false;
  btn.click();
  return true;
}
const text = () => doc.getElementById("app")?.textContent ?? "";

// Hidden-by-default tabs (canvas) open via the command palette.
async function openViaPalette(query, label) {
  globalThis.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true }));
  const opened = await waitFor(() => !!doc.querySelector(".palette-input"), 5000);
  if (!opened) return false;
  const input = doc.querySelector(".palette-input");
  input.value = query;
  input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  const found = await waitFor(
    () => [...doc.querySelectorAll(".palette-result .result-label")].some((el) => (el.textContent || "").trim() === label),
    5000
  );
  if (!found) return false;
  const picked = [...doc.querySelectorAll(".palette-result .result-label")]
    .find((el) => (el.textContent || "").trim() === label);
  picked?.closest("button")?.click();
  return true;
}

// Boot: shell + nav must appear.
check("shell mounts", await waitFor(() => doc.getElementById("app")?.innerHTML.includes("app-shell"), 15000));
check("nav renders", await waitFor(() => doc.querySelectorAll(".workspace-nav .nav-item").length >= 10, 8000));

// Write: empty vault shows EmptyState; New Document creates + mounts an editor.
check("nav has Write", clickNav("Write"));
check("Write empty state renders", await waitFor(() => /Start writing/.test(text()), 8000));
{
  const btn = [...doc.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "New Document");
  check("Write New Document button present", !!btn);
  btn?.click();
  check("Write editor mounts after create", await waitFor(() => !!doc.querySelector(".cm-editor"), 8000));
}

// Home: greeting renders.
check("nav has Home", clickNav("Home"));
check("Home greeting renders", await waitFor(() => /Good (morning|afternoon|evening)/.test(text()), 8000));

// Logs: today's log surface renders. Local date like the app's formatDate
// (toISOString is UTC — wrong near local midnight).
const _d = new Date();
const todayStr = `${_d.getFullYear()}-${String(_d.getMonth() + 1).padStart(2, "0")}-${String(_d.getDate()).padStart(2, "0")}`;
check("nav has Logs", clickNav("Logs"));
check("Logs shows today", await waitFor(() => text().includes(todayStr), 12000));

// Workspace-scoped strip: a doc open in one workspace must not surface in
// another (daily logs used to leak into the Write strip — the global tab
// stack is now filtered per workspace, with the active doc as the only
// exception).
check("nav back to Write", clickNav("Write"));
check("Write strip shows write tabs only", await waitFor(() => {
  const badges = [...doc.querySelectorAll(".tab .ws-badge")];
  return badges.length > 0 && badges.every((b) => b.getAttribute("title") === "write");
}, 8000), `found ${[...doc.querySelectorAll(".tab .ws-badge")].map((b) => b.getAttribute("title")).join(",")}`);
check("nav back to Logs", clickNav("Logs"));
check("Logs strip shows logs tabs only", await waitFor(() => {
  const badges = [...doc.querySelectorAll(".tab .ws-badge")];
  return badges.length > 0 && badges.every((b) => b.getAttribute("title") === "logs");
}, 8000), `found ${[...doc.querySelectorAll(".tab .ws-badge")].map((b) => b.getAttribute("title")).join(",")}`);

// Tab shortcuts (documented in KeyboardShortcuts; forwarded from App's
// keydown to the TabBar that owns the strip).
check("nav to Write for shortcut probe", clickNav("Write"));
{
  const tabsBefore = doc.querySelectorAll(".tab").length;
  globalThis.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "t", ctrlKey: true, bubbles: true }));
  check("Ctrl+T opens a new tab in Write", await waitFor(() => doc.querySelectorAll(".tab").length === tabsBefore + 1, 8000));
  const activeBefore = [...doc.querySelectorAll(".tab")].findIndex((t) => t.classList.contains("active"));
  globalThis.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Tab", ctrlKey: true, bubbles: true }));
  check("Ctrl+Tab cycles to the next tab", await waitFor(() => {
    const idx = [...doc.querySelectorAll(".tab")].findIndex((t) => t.classList.contains("active"));
    return idx !== -1 && activeBefore !== -1 && idx !== activeBefore;
  }, 5000));
  globalThis.window.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true }));
  check("Ctrl+W closes the active tab", await waitFor(() => doc.querySelectorAll(".tab").length === tabsBefore, 5000));
}

// Capture (workspace id "inbox"): visible in the sidebar by default —
// opens via nav; the capture box creates a snippet doc.
check("Capture opens from sidebar", clickNav("Capture"));
{
  check("Capture box renders", await waitFor(() => !!doc.querySelector('.quick-capture input[aria-label="Quick capture text"]'), 8000));
  {
    const input = doc.querySelector('.quick-capture input[aria-label="Quick capture text"]');
    if (!input) {
      check("Capture save button present", false, "no input element");
      check("Capture creates item", false, "no input element");
    } else {
      const before = doc.querySelectorAll(".inbox-item").length;
      input.value = "PROBE_CAPTURE_123";
      input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      // Let Svelte flush the bound value (enables the save button).
      await sleep(500);
      const save = doc.querySelector('.quick-capture button[aria-label="Save capture"]');
      check("Capture save button present", !!save);
      save?.click();
      check("Capture creates item", await waitFor(
        () => [...doc.querySelectorAll(".inbox-item")].some((el) => (el.textContent || "").includes("PROBE_CAPTURE_123")) || doc.querySelectorAll(".inbox-item").length > before,
        8000
      ));
    }
  }
}

// Novel: studio surface renders.
check("nav has Novel", clickNav("Novel"));
check("Novel studio renders", await waitFor(
  () => !!doc.querySelector(".project-picker, .beat-board, .empty-board") || /Start writing|New project/i.test(text()),
  15000
));

// Script: list renders + New Script creates a script.
check("nav has Script", clickNav("Script"));
check("Script list renders", await waitFor(() => /New Script/.test(text()), 15000));
{
  const before = doc.querySelectorAll(".script-item").length;
  const btn = [...doc.querySelectorAll("button")].find((b) => (b.textContent || "").trim() === "+ New Script");
  check("New Script button present", !!btn);
  btn?.click();
  // Creating selects the script into the editor — the new doc must exist
  // and open (list count alone can't prove it: selection leaves the list).
  check("New Script creates + opens script", await waitFor(
    () => doc.querySelectorAll(".script-item").length > before || /Untitled Script/.test(text()),
    8000
  ));
}

// Map: graph surface mounts without crashing.
check("nav has Map", clickNav("Map"));
check("Map canvas mounts", await waitFor(() => !!doc.querySelector("canvas"), 15000));

// Reader: shelf renders.
check("nav has Reader", clickNav("Reader"));
check("Reader shelf renders", await waitFor(() => /To Read/.test(text()), 15000));

// Projects: list renders + New Project creates a project.
check("nav has Projects", clickNav("Projects"));
check("Projects list renders", await waitFor(() => !!doc.querySelector(".project-list"), 15000));
{
  const before = doc.querySelectorAll(".project-item").length;
  const btn = doc.querySelector('.add-btn[title="New Project"]');
  check("New Project button present", !!btn);
  btn?.click();
  check("New Project creates project", await waitFor(() => doc.querySelectorAll(".project-item").length > before, 8000));
}

// Library: views render.
check("nav has Library", clickNav("Library"));
check("Library views render", await waitFor(() => !!doc.querySelector('[aria-label="Library views"]'), 15000));

// Canvas: hidden from sidebar by default — opens via palette, board renders.
check("Canvas opens via palette", await openViaPalette("canvas", "Go to Canvas"));
check("Canvas board renders", await waitFor(
  () => !!doc.querySelector(".world") || /Empty board/.test(text()),
  15000
));

// Settings: panel renders + theme select actually switches the theme.
{
  const settingsBtn = [...doc.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") || "") === "Settings")
    || [...doc.querySelectorAll(".workspace-nav .nav-item")].find((b) => (b.getAttribute("aria-label") || "").trim() === "Settings");
  check("Settings entry present", !!settingsBtn);
  settingsBtn?.click();
  check("Settings style select renders", await waitFor(() => !!doc.querySelector("#setting-theme"), 15000));
  {
    const sel = doc.querySelector("#setting-theme");
    if (!sel) {
      check("style select switches to brutalist", false, "no select element");
    } else {
      sel.value = "brutalist";
      sel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
      await sleep(500);
      check("style select switches to brutalist", doc.documentElement.dataset.theme === "brutalist");
    }
    const lightBtn = [...doc.querySelectorAll('[role="radio"]')].find((b) => (b.textContent || "").trim() === "Light");
    check("mode segmented renders", !!lightBtn);
    lightBtn?.click();
    await sleep(500);
    check("mode switches to light", doc.documentElement.dataset.mode === "light");
    const accent = doc.querySelector('#setting-accent');
    check("accent picker renders", !!accent);
    if (accent) {
      accent.value = "#ff8800";
      accent.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      await sleep(500);
      check("accent override applies", (doc.documentElement.style.getPropertyValue("--accent") || "").trim() === "#ff8800");
    }
    const stored = JSON.parse(dom.window.localStorage.getItem("writing-app-settings") || "{}");
    check("appearance persists to settings", stored.theme === "brutalist" && stored.themeMode === "light" && stored.accentOverride === "#ff8800");
  }
  const editorCategory = [...doc.querySelectorAll(".settings-nav .nav-item")].find((b) => (b.textContent || "").includes("Editor & Writing"));
  editorCategory?.click();
  await sleep(250);
  const scriptFontSize = doc.querySelector("#setting-font-size");
  const scriptLineHeight = doc.querySelector("#setting-line-height");
  const scriptFontFamily = doc.querySelector("#setting-font-family");
  if (scriptFontSize && scriptLineHeight && scriptFontFamily) {
    scriptFontSize.value = "21";
    scriptFontSize.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    scriptLineHeight.value = "2.2";
    scriptLineHeight.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    scriptFontFamily.value = "IBM Plex Mono";
    scriptFontFamily.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await sleep(350);
  }
  doc.querySelector('.workspace-nav [data-ws="script"]')?.click();
  check("Script list returns", await waitFor(() => !!doc.querySelector(".script-item"), 10000));
  doc.querySelector(".script-item")?.click();
  check("Script editor returns with shared typography", await waitFor(() => !!doc.querySelector(".fountain-input"), 10000));
  const scriptSource = await readFile(join(root, "src/lib/components/ScriptWorkspace.svelte"), "utf8");
  check("Script uses shared typography contract", scriptSource.includes("font-family: var(--editor-font-family)") && scriptSource.includes("font-size: var(--editor-font-size)") && scriptSource.includes("line-height: var(--editor-line-height)"));
}

// jsdom ships no canvas implementation — the getContext "not implemented"
// notice is a harness limitation, not an app error. Everything else must
// be silent.
const realErrors = errors.filter((e) => !(e.includes("getContext") && e.includes("canvas")));
check("zero console errors", realErrors.length === 0, realErrors.slice(0, 5).join(" | "));
console.log(failures === 0 ? "TABS-FUNCTIONAL ALL PASS" : `TABS-FUNCTIONAL ${failures} FAILURE(S)`);
// Lazy chunks leave live handles (d3 timers) — results are in, exit now.
process.exit(failures === 0 ? 0 : 1);
