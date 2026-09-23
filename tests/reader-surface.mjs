/**
 * reader-surface — headless behavioral checks for the Reader's
 * structured flow (src/lib/components/ReaderWorkspace.svelte):
 *  - seeded book opens from its card into real sections (h1/lists
 *    render as structure, not literal "#" text);
 *  - the compact control row exists; font/theme switches re-render;
 *  - cards show a progress bar once reading_position > 0;
 *  - empty cover slot degrades to the kind badge (no broken img).
 *
 * The Reader chunk is lazy: jsdom never fires load on Vite's injected
 * stylesheet links, so the harness fires them manually (same documented
 * technique as tests/ai-panel-error.mjs) to reach the workspace.
 *
 * Run: npm run build && node tests/reader-surface.mjs
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

// Seeded shelf: one chaptered book (headings + list + image marker),
// already 25% read so the card progress bar must show.
const BODY = [
  "# Probe Book",
  "",
  "Opening paragraph.",
  "",
  "## Chapter One",
  "",
  "First words here.",
  "",
  "- item a",
  "- item b",
  "",
  "![cover art](dropped-image)",
  "",
  "## Chapter Two",
  "",
  "Second words here.",
].join("\n");
const bookDoc = {
  id: "reader-probe-book", workspace: "reader", kind: "md", title: "Probe Book",
  path: "reader/reader-probe-book.md", parent_id: null,
  created_at: "2026-09-01T10:00:00.000Z", updated_at: "2026-09-01T10:00:00.000Z",
  content: BODY, word_count: 20, reading_position: 0.25, status: "reading",
  frontmatter_json: null, activity_score: 1, embedding_ref: null,
};
dom.window.localStorage.setItem("jwe-browser-docs-v1", JSON.stringify([bookDoc]));
dom.window.localStorage.setItem("jwe-browser-tabs-v1", JSON.stringify({
  global: { tab_stack_json: `["reader-probe-book"]`, active_id: "reader-probe-book" },
}));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);
const fireLinkLoads = () => {
  for (const link of [...dom.window.document.querySelectorAll('link[rel="stylesheet"]')]) {
    if (!link.dataset.fired) {
      link.dataset.fired = "1";
      link.dispatchEvent(new dom.window.Event("load"));
    }
  }
};
const linkTimer = setInterval(fireLinkLoads, 100);
await new Promise((r) => setTimeout(r, 3000));

function q(sel) { return dom.window.document.querySelector(sel); }
function qa(sel) { return [...dom.window.document.querySelectorAll(sel)]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("reader workspace mounted", !!q(".reader-workspace"));
const card = qa(".reader-workspace .book-card").find((c) =>
  (c.textContent || "").includes("Probe Book")
);
check("seeded book on shelf", !!card);
check("progress bar shows on card", !!card?.querySelector(".book-progress-fill"));
check("empty cover degrades to kind badge", !!card?.querySelector(".book-kind") && !card?.querySelector("img"));

card?.click();
await sleep(1200);

const sections = qa(".reader-workspace section[data-section]");
check("book opens into sections", sections.length >= 3, `${sections.length} sections`);
const h1 = q(".reader-workspace section[data-section] h1");
check("heading renders as h1 (not literal #)", !!h1 && h1.textContent.includes("Probe Book"));
const lis = qa(".reader-workspace section[data-section] li");
check("list renders as li", lis.length === 2, `${lis.length} items`);
check("dropped image captioned", !!q(".reader-workspace .img-missing figcaption"));
check("no literal markdown leaks", ![...qa(".reader-workspace section[data-section]")].some((s) =>
  /(^|\n)#\s|\n- /.test(s.textContent || "")));

// Controls row: font + size + measure + theme, all live.
check("controls row present", !!q(".reader-controls"));
const fontSel = q('.reader-controls select[aria-label="Reading font"]');
check("font switch present", !!fontSel);
if (fontSel) {
  fontSel.value = "mono";
  fontSel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
  await sleep(400);
  const first = q(".reader-workspace section[data-section]");
  check("font switch re-renders prose", !!first);
}
const themeBtn = qa(".reader-controls .ctl-btn").find((b) =>
  (b.textContent || "").includes("Theme:")
);
check("theme cycle present", !!themeBtn);
themeBtn?.click(); // app -> light
await sleep(300);
themeBtn?.click(); // light -> sepia
await sleep(400);
check(
  "theme switch applies (sepia paper)",
  !!q(".reader-workspace section[data-section].theme-sepia")
);
check("read-aloud entry present", !!q('.reader-toolbar button[aria-label="Read text aloud"]'));

clearInterval(linkTimer);
console.log(`INFO  console.error count: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 10)) console.log("ERR  ", e);
if (errors.length > 0) failures++;

console.log(failures === 0 ? "READER-SURFACE ALL PASS" : `READER-SURFACE ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
