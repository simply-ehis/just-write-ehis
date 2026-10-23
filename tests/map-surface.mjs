/**
 * map-surface — acceptance tests for the Map workspace graph canvas
 * (src/lib/components/NodeMapWorkspace.svelte + src/lib/nodeMapGraph.ts).
 *
 * Acceptance criteria (proper fix, 2026-10-22 — the workspace was audited
 * for cutting, then fixed instead):
 *  AC1  Map mounts from the sidebar nav: canvas + toolbar stats render
 *       from seeded vault data with no console errors; the workspace
 *       filter select narrows the graph end-to-end.
 *  AC2  Drawing is effect-driven: the component schedules NO
 *       requestAnimationFrame of its own (source pin), and a settled
 *       graph produces exactly ZERO animation frames per idle window
 *       (runtime count — the old loop redrew an idle frame 60x/s).
 *  AC3  Destroy fully silences the workspace: after navigating away, the
 *       frame stream stays at zero (sim stopped, fit timer cleared,
 *       resize observer disconnected — source-pinned on onDestroy).
 *  AC4  Interaction respects filters: hit-testing goes through the same
 *       visible node set as drawing (unit-pinned), so filtered-out docs
 *       can never be hovered/clicked/selected — even at their exact
 *       world position.
 *  AC5  Fit frames only the visible nodes (source pin: fitGraph reads the
 *       shared visibleNodes derived).
 *  AC6  The canvas buffer tracks its CONTAINER (ResizeObserver, with a
 *       window-resize fallback for jsdom), so a sidebar collapse cannot
 *       desync hit-testing from the drawn pixels.
 *  AC7  Map shortcuts (f/F/Enter) are inert while typing in the tag
 *       filter or any other editable toolbar control.
 *  AC8  Large-vault cap: >cap nodes keeps the top-degree nodes, drops
 *       edges/orphans touching dropped nodes, reports the capped count
 *       (applyNodeCap unit-pinned; Show-all skips the cap).
 *  AC9  A failed graph load surfaces WorkspaceError with retry and an
 *       empty vault shows the "No documents yet" state (source pins).
 *
 * Sections A (pure-module units) and B (source pins) need no build;
 * section C boots the built bundle in jsdom:
 *   npm run build && node tests/map-surface.mjs
 */
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const ids = (nodes) => nodes.map((n) => n.id).sort();

// ---------------------------------------------------------------------------
// Section A — pure visibility/hit-test/cap rules (no DOM, no build).
// ---------------------------------------------------------------------------
{
  const G = await import(pathToFileURL(join(root, "src/lib/nodeMapGraph.ts")).href);

  // Radius: one formula for draw + hit-test, capped at degree 8.
  check("radius: base 6 at degree 0", G.nodeRadius(0) === 6);
  check("radius: grows with degree", G.nodeRadius(4) === 12);
  check("radius: caps at 18", G.nodeRadius(8) === 18 && G.nodeRadius(50) === 18);

  const gd = {
    nodes: [
      { id: "hub1", title: "Hub", workspace: "write", kind: "doc", word_count: 10, activity_score: 1, degree: 5, tags: ["alpha", "beta"], x: 0, y: 0 },
      { id: "nbr1", title: "Neighbor", workspace: "novel", kind: "doc", word_count: 10, activity_score: 1, degree: 2, x: 100, y: 0 },
      { id: "orphan1", title: "Lonely", workspace: "write", kind: "doc", word_count: 10, activity_score: 1, degree: 0, tags: ["alpha"], x: 200, y: 0 },
      { id: "plain", title: "Plain", workspace: "logs", kind: "doc", word_count: 10, activity_score: 1, degree: 1 },
    ],
    edges: [{ source: "hub1", target: "nbr1", kind: "wikilink", context_snippet: null }],
    orphans: ["orphan1"],
    hubs: [["hub1", 5]],
  };
  const filters = (over = {}) => ({ workspace: "all", tags: [], showOrphans: true, hubOnly: false, ...over });

  check("visible: default shows everything", ids(G.computeVisibleNodes(gd, filters())).join(",") === "hub1,nbr1,orphan1,plain");
  check("visible: orphans off hides orphans", ids(G.computeVisibleNodes(gd, filters({ showOrphans: false }))).join(",") === "hub1,nbr1,plain");
  check("visible: workspace filter narrows", ids(G.computeVisibleNodes(gd, filters({ workspace: "write" }))).join(",") === "hub1,orphan1");
  check("visible: tags require every chip (untagged pass)", ids(G.computeVisibleNodes(gd, filters({ tags: ["beta"] }))).join(",") === "hub1,nbr1,plain");
  check("visible: hubs-only keeps hubs + neighbors", ids(G.computeVisibleNodes(gd, filters({ hubOnly: true }))).join(",") === "hub1,nbr1");
  check("visible: hubOnly composes with workspace filter", ids(G.computeVisibleNodes(gd, filters({ hubOnly: true, workspace: "novel" }))).join(",") === "nbr1");
  check("visible: precomputed sets accepted", ids(G.computeVisibleNodes(gd, filters(), { orphanIds: new Set(["orphan1"]), hubIds: new Set(["hub1"]) })).length === 4);

  // Hit-test — AC4: only the passed (visible) list can be hit.
  check("hit: exact center hits", G.hitTestNode(gd.nodes, 0, 0)?.id === "hub1");
  check("hit: inside radius hits", G.hitTestNode(gd.nodes, 13, 0)?.id === "hub1");
  check("hit: outside radius misses", G.hitTestNode(gd.nodes, 14, 0) === null);
  check("hit: null-position nodes never hit", G.hitTestNode([{ ...gd.nodes[3] }], 0, 0) === null);
  const withoutOrphan = G.computeVisibleNodes(gd, filters({ showOrphans: false }));
  check("hit: filtered-out doc unreachable at its own position", G.hitTestNode(withoutOrphan, 200, 0) === null);
  check("hit: empty list misses", G.hitTestNode([], 0, 0) === null);

  // Cap — AC8.
  const big = {
    nodes: [1, 5, 3, 2, 4].map((d, i) => ({ id: `n${i}`, title: `N${i}`, workspace: "write", kind: "doc", word_count: 1, activity_score: 1, degree: d })),
    edges: [
      { source: "n1", target: "n2", kind: "wikilink", context_snippet: null }, // degree 5 <-> 3: kept
      { source: "n0", target: "n4", kind: "wikilink", context_snippet: null }, // degree 1 <-> 4: kept
      { source: "n0", target: "n2", kind: "wikilink", context_snippet: null }, // touches dropped n0: pruned
    ],
    orphans: ["n0", "n4"],
    hubs: [],
  };
  const capped = G.applyNodeCap(big, 3, false);
  check("cap: keeps top-degree nodes", ids(capped.data.nodes).join(",") === "n1,n2,n4");
  check("cap: prunes edges touching dropped nodes", capped.data.edges.length === 1);
  check("cap: orphan list follows kept set", capped.data.orphans.join(",") === "n4");
  check("cap: reports the capped count", capped.capped === 2);
  check("cap: show-all skips the cap", G.applyNodeCap(big, 3, true).capped === 0 && G.applyNodeCap(big, 3, true).data.nodes.length === 5);
  check("cap: under-cap graph untouched", G.applyNodeCap(gd, 800, false).capped === 0);
}

// ---------------------------------------------------------------------------
// Section B — source pins on the component (repo convention: pins keep
// lifecycle invariants from silently regressing).
// ---------------------------------------------------------------------------
{
  const src = await readFile(join(root, "src/lib/components/NodeMapWorkspace.svelte"), "utf8");

  check("AC2 component schedules no rAF of its own", !src.includes("requestAnimationFrame"));
  check("AC2 draw wired through $effect", /\$effect\(\(\) => \{\s*draw\(\);?\s*\}\)/.test(src));
  check("AC6 ResizeObserver tracks the canvas container", src.includes("new ResizeObserver"));
  check("AC6 window-resize fallback kept for jsdom", src.includes('window.addEventListener("resize", handleResize)'));

  const onDestroySrc = src.slice(src.indexOf("onDestroy("), src.indexOf("</script>"));
  check("AC3 destroy stops the simulation", onDestroySrc.includes("simulation.stop()"));
  check("AC3 destroy clears the pending fit timer", onDestroySrc.includes("clearTimeout(fitTimer)"));
  check("AC3 destroy disconnects the resize observer", onDestroySrc.includes("resizeObserver?.disconnect()"));
  check("fit timer re-armed cleanly (cleared before re-set)", src.includes("if (fitTimer !== null) clearTimeout(fitTimer);"));

  const hitSrc = src.slice(src.indexOf("function findNodeAt"), src.indexOf("function handleMouseDown"));
  check("AC4 hit-test goes through the visible set", hitSrc.includes("hitTestNode(visibleNodes"));

  const fitSrc = src.slice(src.indexOf("function fitGraph"), src.indexOf("// Tag filtering helpers"));
  check("AC5 fit frames only visible nodes", fitSrc.includes("visibleNodes") && !fitSrc.includes("graphData.nodes"));

  const keySrc = src.slice(src.indexOf("function handleKeydown"), src.indexOf("function handleResize"));
  check("AC7 shortcuts inert in editable targets", keySrc.includes('tagName === "INPUT"') && keySrc.includes("isContentEditable"));

  check("AC9 load failure renders WorkspaceError with retry", src.includes("<WorkspaceError") && src.includes("onRetry"));
  check("AC9 empty vault renders the empty state", src.includes("No documents yet"));
}

// ---------------------------------------------------------------------------
// Section C — runtime: boot the built bundle with a seeded fixture vault.
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
const emptyRect = () => ({ left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 });
if (dom.window.Range) {
  if (!dom.window.Range.prototype.getClientRects) dom.window.Range.prototype.getClientRects = () => [];
  if (!dom.window.Range.prototype.getBoundingClientRect) dom.window.Range.prototype.getBoundingClientRect = emptyRect;
}
if (dom.window.Element && !dom.window.Element.prototype.getClientRects) dom.window.Element.prototype.getClientRects = function () { return []; };

// Frame accounting (AC2/AC3): count every requestAnimationFrame SCHEDULED
// from bundle load on. d3-timer captures window.requestAnimationFrame at
// module init, so the wrapper must be installed BEFORE the bundle import.
let rafCalls = 0;
const origRaf = dom.window.requestAnimationFrame.bind(dom.window);
dom.window.requestAnimationFrame = (cb) => { rafCalls++; return origRaf(cb); };
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame;
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
// jsdom without the canvas npm package logs "Not implemented: getContext"
// through the virtual console — environment noise, not an app error.
const appErrors = () => errors.filter((e) => !/Not implemented/.test(e));

dom.window.localStorage.setItem("writing-app-settings", JSON.stringify({ theme: "dark" }));

// Seeded fixture vault: two linked docs in write + one unlinked log.
// Expected graph_query: 3 nodes; alpha->beta and beta->alpha = 2 edges.
const now = new Date().toISOString();
const mkDoc = (id, workspace, title, content) => ({
  id, workspace, kind: "doc", title, path: `${workspace}/${id}.md`,
  parent_id: null, created_at: now, updated_at: now, content,
  word_count: content.split(/\s+/).length, reading_position: null,
  status: "draft", frontmatter_json: null, activity_score: 1, embedding_ref: null,
});
dom.window.localStorage.setItem("jwe-browser-docs-v1", JSON.stringify([
  mkDoc("alpha", "write", "Alpha Notes", "See [[Beta Notes]] for the follow-up."),
  mkDoc("beta", "write", "Beta Notes", "Back to [[Alpha Notes]] next."),
  mkDoc("gamma", "logs", "Gamma Log", "Plain log entry, no links."),
]));

const distHtml = await readFile(join(root, "dist/index.html"), "utf8");
const jsName = distHtml.match(/assets\/(index-.*\.js)/)?.[1];
if (!jsName) {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(pathToFileURL(join(root, "dist/assets", jsName)).href);

const doc = dom.window.document;
async function waitFor(fn, timeoutMs) {
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

check("shell mounts", await waitFor(() => doc.getElementById("app")?.innerHTML.includes("app-shell"), 15000));
check("nav renders", await waitFor(() => doc.querySelectorAll(".workspace-nav .nav-item").length >= 10, 8000));

// AC1 — mount from nav with the seeded graph.
check("nav has Map", clickNav("Map"));
check("AC1 Map canvas mounts", await waitFor(() => !!doc.querySelector(".node-map-workspace canvas"), 15000));
check("AC1 toolbar renders stats", await waitFor(() => /3 nodes \/ 2 edges/.test(text()), 15000));
check("AC1 no console errors on mount", appErrors().length === 0, appErrors()[0] ?? "");
check("AC7 tag filter input lives inside the map container", !!doc.querySelector('.node-map-workspace input[aria-label="Filter by tags"]'));

// AC1 — the workspace filter narrows end-to-end through the backend.
{
  const wsSel = doc.querySelector('select[aria-label="Filter by workspace"]');
  check("workspace filter select present", !!wsSel);
  if (wsSel) {
    wsSel.value = "write";
    wsSel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    check("workspace filter narrows the graph", await waitFor(() => /2 nodes \/ 2 edges/.test(text()), 8000));
    wsSel.value = "all";
    wsSel.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    check("workspace filter restores", await waitFor(() => /3 nodes \/ 2 edges/.test(text()), 8000));
  }
}

// AC2 — runtime: once the force layout settles (default d3 cooling is
// ~300 ticks ≈ 5s at 60fps), an idle Map must schedule ZERO frames.
await sleep(8000);
{
  const before = rafCalls;
  await sleep(800);
  check("AC2 idle Map schedules no animation frames", rafCalls === before, `${rafCalls - before} frames`);
}

// AC3 — runtime: leaving the workspace leaves no frame stream behind.
check("nav has Home", clickNav("Home"));
check("Map unmounts on navigate-away", await waitFor(() => !doc.querySelector(".node-map-workspace"), 5000));
await sleep(400);
{
  const before = rafCalls;
  await sleep(800);
  check("AC3 destroyed Map schedules no frames", rafCalls === before, `${rafCalls - before} frames`);
}
check("no console errors across the run", appErrors().length === 0, appErrors()[0] ?? "");

if (failures > 0) {
  console.log(`\n${failures} failure(s)`);
  process.exit(1);
}
console.log("\nAll map-surface checks passed.");
