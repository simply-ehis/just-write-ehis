/**
 * smoke-dom — headless Svelte mount of the built bundle in jsdom.
 * Catches render-time crashes (e.g. mobile blank screen) and counts
 * console errors/warnings per viewport. No mocks: real browserBackend
 * over jsdom localStorage.
 *
 * Run: npm run build && node tests/smoke-dom.mjs [--width=390]
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootDom, resolveBundle } from "./helpers/jsdom-boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const widthArg = process.argv.find((a) => a.startsWith("--width="));
const WIDTH = widthArg ? parseInt(widthArg.split("=")[1], 10) : 1280;

const errors = [];
const warnings = [];

let bundleUrl;
try {
  bundleUrl = await resolveBundle(root);
} catch {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}

const dom = bootDom(WIDTH, 800);

const origError = console.error;
const origWarn = console.warn;
console.error = (...a) => { errors.push(a.map(String).join(" ").slice(0, 300)); };
console.warn = (...a) => { warnings.push(a.map(String).join(" ").slice(0, 300)); };

// --dirty: simulate a veteran vault — legacy settings shape, pre-lock docs,
// yesterday's seed remnants, stale tabs — then verify clean boot + purge.
if (process.argv.includes("--dirty")) {
  const ls = dom.window.localStorage;
  const oldDoc = (id, ws, title, content) => ({
    id, workspace: ws, kind: "doc", title, path: `${ws}/${id}.md`,
    parent_id: null, created_at: "2026-08-01T10:00:00.000Z",
    updated_at: "2026-09-01T10:00:00.000Z", content,
    word_count: 10, reading_position: null, status: "draft",
    frontmatter_json: null, activity_score: 5, embedding_ref: null,
  });
  ls.setItem("writing-app-settings", JSON.stringify({ theme: "dark", fontSize: 15 }));
  ls.setItem("jwe-browser-docs-v1", JSON.stringify([
    oldDoc("seed-1", "write", "Welcome", "# Welcome to Just Write ehis (browser preview)\n\nTry the [[Sample Chapter]] link."),
    oldDoc("seed-2", "novel", "Sample Chapter", "# Sample Chapter\n\nElena stared at the harbor."),
    oldDoc("mine-1", "write", "My real doc", "Hello world, this one stays."),
  ]));
  ls.setItem("jwe-browser-snaps-v1", JSON.stringify([
    { id: "snap-1", doc_id: "seed-1", label: "old", content: "x", word_count: 1, created_at: "2026-09-01T10:00:00.000Z" },
  ]));
  ls.setItem("jwe-browser-tabs-v1", JSON.stringify({
    write: { tab_stack_json: "[\"seed-1\"]", active_id: "seed-1" },
  }));
  console.log("INFO  dirty vault seeded (legacy shape + seed remnants)");
}

try {
  await import(bundleUrl);
} catch (e) {
  errors.push(`MOUNT THREW: ${String(e).split("\n").slice(0, 4).join(" | ")}`);
}

// Let onMount + async init settle
await new Promise((r) => setTimeout(r, 2500));

console.error = origError;
console.warn = origWarn;

const html = dom.window.document.getElementById("app")?.innerHTML ?? "";
const hasShell = html.includes("app-shell");
const hasSidebar = html.includes("sidebar");
const hasContent = html.length;

console.log(`viewport width: ${WIDTH}`);
console.log(`${hasShell ? "PASS" : "FAIL"}  app-shell renders`);
console.log(`${hasSidebar ? "PASS" : "FAIL"}  sidebar renders`);
console.log(`INFO  #app html length: ${hasContent}`);

// Click through every workspace nav item — each mount + its data
// loading must survive headless. Records per-workspace new errors.
const navButtons = [...dom.window.document.querySelectorAll(".workspace-nav button")];
console.log(`INFO  nav items: ${navButtons.length}`);
const wsErrors = {};
for (const btn of navButtons) {
  const label = (btn.getAttribute("aria-label") || btn.textContent || "?").trim().slice(0, 24);
  const before = errors.length;
  try {
    btn.click();
  } catch (e) {
    errors.push(`CLICK ${label} THREW: ${String(e).split("\n")[0]}`);
  }
  await new Promise((r) => setTimeout(r, 600));
  // In write workspace with no doc, create one via the empty state.
  const newDocBtn = [...dom.window.document.querySelectorAll("button")].find((b) =>
    /new document/i.test(b.textContent || "")
  );
  if (newDocBtn) {
    try {
      newDocBtn.click();
    } catch (e) {
      errors.push(`NEWDOC THREW: ${String(e).split("\n")[0]}`);
    }
    await new Promise((r) => setTimeout(r, 600));
  }
  const fresh = errors.slice(before);
  if (fresh.length > 0) wsErrors[label] = [...new Set(fresh)].slice(0, 4);
}
for (const [ws, list] of Object.entries(wsErrors)) {
  console.log(`WSERR ${ws}:`);
  for (const e of list) console.log(`  ${e}`);
}

if (process.argv.includes("--dirty")) {
  const docs = JSON.parse(dom.window.localStorage.getItem("jwe-browser-docs-v1") || "[]");
  const titles = docs.map((d) => d.title);
  const seedGone = !titles.includes("Welcome") && !titles.includes("Sample Chapter");
  const realKept = titles.includes("My real doc");
  const snaps = JSON.parse(dom.window.localStorage.getItem("jwe-browser-snaps-v1") || "[]");
  const orphansGone = !snaps.some((s) => s.doc_id === "seed-1");
  console.log(`${seedGone ? "PASS" : "FAIL"}  stale seed purged, real docs kept (${titles.join(", ") || "empty"})`);
  console.log(`${realKept && orphansGone ? "PASS" : "FAIL"}  real doc kept, orphan snapshots gone`);
  if (!seedGone || !realKept || !orphansGone) errors.push("DIRTY VAULT ASSERTION FAILED");
}

console.log(`INFO  console.error count: ${errors.length}`);
console.log(`INFO  console.warn count: ${warnings.length}`);
for (const e of [...new Set(errors)].slice(0, 15)) console.log(`ERR   ${e}`);
for (const w of [...new Set(warnings)].slice(0, 8)) console.log(`WARN  ${w}`);

const failed = !hasShell || !hasSidebar || errors.length > 0;
process.exit(failed ? 1 : 0);
