/**
 * write-probe — actually types into the Just Write editor (via real
 * EditorView.dispatch transactions retrieved from the live DOM, exactly
 * the same pipeline a keystroke uses) and checks whether the content
 * (a) renders in the DOM and (b) survives the autosave debounce into
 * the store. This goes further than smoke-dom.mjs, which only checks
 * that workspaces mount without throwing.
 *
 * Extended coverage:
 *  - Phase 1/2: typing into an EXISTING (seeded) document + debounce persist.
 *  - Phase 3: switching between two open documents (tab click) with no
 *    cross-contamination, then typing + persisting in the second doc.
 *  - Phase 4: split-pane editor (Toggle split editor) gets its own
 *    EditorView; typing there persists to the split doc only.
 *  - Phase 5: non-AI autocorrect Layer 1 ("teh" -> "the") fires live.
 *
 * Seeded vault (2 docs + restored tab strip) exercises the open-existing
 * path instead of only the empty-state New Document path.
 *
 * Run: npm run build && node tests/write-probe.mjs
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

// Seed BEFORE the bundle boots: two existing docs + a restored tab strip
// (the shape App.svelte restoreTabs reads) + autocorrect enabled.
const seedDoc = (id, title, content) => ({
  id, workspace: "write", kind: "doc", title, path: `write/${id}.md`,
  parent_id: null, created_at: "2026-09-01T10:00:00.000Z",
  updated_at: "2026-09-01T10:00:00.000Z", content,
  word_count: content.split(/\s+/).length, reading_position: null,
  status: "draft", frontmatter_json: null, activity_score: 1,
  embedding_ref: null,
});
dom.window.localStorage.setItem("jwe-browser-docs-v1", JSON.stringify([
  seedDoc("doc-probe-a", "Alpha", "Alpha seed content."),
  seedDoc("doc-probe-b", "Beta", "Beta seed content."),
]));
dom.window.localStorage.setItem("jwe-browser-tabs-v1", JSON.stringify({
  global: { tab_stack_json: `["doc-probe-a","doc-probe-b"]`, active_id: "doc-probe-a" },
}));
dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ autocorrectEnabled: true }));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);
// Restore (async docGet per tab) + editor mount + focus-prefs settle.
await new Promise((r) => setTimeout(r, 2500));

function q(sel) { return dom.window.document.querySelector(sel); }
function qa(sel) { return [...dom.window.document.querySelectorAll(sel)]; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
function storedDocs() {
  try {
    return JSON.parse(dom.window.localStorage.getItem("jwe-browser-docs-v1") || "[]");
  } catch {
    return [];
  }
}
const storedById = (id) => storedDocs().find((d) => d.id === id);
const editors = () => qa(".cm-editor");
const viewOf = (el) => {
  try {
    return EditorView.findFromDOM(el);
  } catch {
    return null;
  }
};

// Make sure we are on the Just Write workspace (restore should land there
// via the active tab's workspace; click through if not).
if (editors().length === 0) {
  const navBtn = qa(".workspace-nav button").find((b) =>
    /just write|^write$/i.test((b.getAttribute("aria-label") || b.textContent || "").trim())
  );
  check("found Just Write nav button", !!navBtn);
  navBtn?.click();
  await sleep(800);
} else {
  console.log("INFO  editor already mounted via restored tabs (existing-doc path)");
}

// ── Phase 1: existing document renders ──────────────────────────────
let primary = editors()[0];
check("primary .cm-editor mounted in DOM", !!primary);
let view = primary ? viewOf(primary) : null;
check("EditorView instance recovered from DOM", !!view);
if (!view) {
  console.log(`INFO  console.error count so far: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log("ERR  ", e);
  process.exit(1);
}
check("existing doc content renders in editor", view.state.doc.toString().includes("Alpha seed content"));

// ── Phase 2: type into the existing doc, debounce persists ───────────
const probe1 = "PROBE1_" + Date.now();
view.dispatch({ changes: { from: view.state.doc.length, insert: " " + probe1 } });
await sleep(80);
check("editor state contains typed text (existing doc)", view.state.doc.toString().includes(probe1));
check("typed text rendered into DOM", (primary.textContent || "").includes(probe1));
await sleep(1000); // past the 500ms content-change autosave debounce
check(
  "typed text persisted to store after debounce",
  (storedById("doc-probe-a")?.content || "").includes(probe1)
);
// Regression: the autosave metadata refresh ($currentDoc reassignment)
// must not destroy/recreate the editor — the rebuilt view would load
// stale store content and visibly snap back, discarding typed text.
const liveView1 = editors()[0] ? viewOf(editors()[0]) : null;
check("editor instance survived autosave (no destroy/recreate)", liveView1 === view);
check(
  "live editor still shows typed text after autosave",
  !!liveView1 && liveView1.state.doc.toString().includes(probe1)
);

// ── Phase 3: switch tabs, no cross-contamination ─────────────────────
const tabBeta = qa(".tab-bar .tab").find((t) =>
  (t.querySelector(".tab-title")?.textContent || "").trim() === "Beta"
);
check("Beta tab present in tab strip", !!tabBeta);
tabBeta?.click();
await sleep(800);
primary = editors()[0];
view = primary ? viewOf(primary) : null;
check("editor mounted after tab switch", !!view);
if (view) {
  const text = view.state.doc.toString();
  check("switched editor shows Beta content", text.includes("Beta seed content"));
  check("no cross-contamination from Alpha", !text.includes(probe1));
  const probe2 = "PROBE2_" + Date.now();
  view.dispatch({ changes: { from: view.state.doc.length, insert: " " + probe2 } });
  await sleep(1000);
  const a = storedById("doc-probe-a")?.content || "";
  const b = storedById("doc-probe-b")?.content || "";
  check("typed text persisted to Beta after debounce", b.includes(probe2));
  check("Alpha keeps probe1, untouched by probe2", a.includes(probe1) && !a.includes(probe2));
}

// ── Phase 4: split pane is an independent edit surface ───────────────
const splitToggle = q('button[aria-label="Toggle split editor"]');
check("split editor toggle present", !!splitToggle);
splitToggle?.click();
await sleep(1000); // split doc loads via async docGet
const panes = editors();
check("split opens a second editor", panes.length === 2, `found ${panes.length}`);
if (panes.length === 2) {
  const splitView = viewOf(panes[1]);
  check("split EditorView recovered from DOM", !!splitView);
  if (splitView) {
    check("split pane shows the other tab (Alpha)", splitView.state.doc.toString().includes(probe1));
    const probe3 = "PROBE3_" + Date.now();
    splitView.dispatch({ changes: { from: splitView.state.doc.length, insert: " " + probe3 } });
    await sleep(1000);
    const a = storedById("doc-probe-a")?.content || "";
    const b = storedById("doc-probe-b")?.content || "";
    check("split typing persisted to Alpha", a.includes(probe3));
    check("split typing did not leak into Beta", !b.includes(probe3));
  }
}

// ── Phase 5: non-AI autocorrect Layer 1 fires live ───────────────────
primary = editors()[0];
view = primary ? viewOf(primary) : null;
if (view) {
  // Primary pane is Beta now. The plugin inspects the word BEFORE the
  // boundary keystroke (toA is old-coords), so a real typo fix needs the
  // word insert followed by a word-boundary insert, like live typing.
  view.dispatch({ changes: { from: view.state.doc.length, insert: " teh" } });
  await sleep(80);
  view.dispatch({ changes: { from: view.state.doc.length, insert: " " } });
  await sleep(300); // plugin re-dispatch settles
  const text = view.state.doc.toString();
  check("autocorrect fixed 'teh' -> 'the'", /\bthe\b/.test(text) && !/\bteh\b/.test(text), text.slice(-60));
  await sleep(1000);
  const b = storedById("doc-probe-b")?.content || "";
  check("autocorrected text persisted", /\bthe\b/.test(b) && !/\bteh\b/.test(b));
}

// ── Phase 6: find/replace panel actually opens on Ctrl+F ────────────
// (Resolves the stale "never wired" comment: searchKeymap IS spread into
// the keymap — this proves the panel renders, not just that the keymap
// strings exist in the bundle.)
primary = editors()[0];
view = primary ? viewOf(primary) : null;
if (view) {
  view.focus();
  const keyEvt = new KeyboardEvent("keydown", {
    key: "f", code: "KeyF", ctrlKey: true, bubbles: true, cancelable: true,
  });
  view.contentDOM.dispatchEvent(keyEvt);
  await sleep(400);
  const panel = primary.querySelector(".cm-panel.cm-search");
  check("Ctrl+F opens the find/replace panel", !!panel);
  check("search panel has a query input", !!panel?.querySelector("input"));
}

console.log(`INFO  console.error count: ${errors.length}`);
for (const e of [...new Set(errors)].slice(0, 15)) console.log("ERR  ", e);
if (errors.length > 0) failures++;

console.log(failures === 0 ? "WRITE-PROBE ALL PASS" : `WRITE-PROBE ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
