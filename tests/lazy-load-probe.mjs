/**
 * lazy-load-probe — clicks through every code-split ("lazy") workspace
 * (Novel, Script, Map, Reader, Projects, Library, Settings — everything
 * wrapped in LazyWorkspace.svelte in App.svelte) and reports whether each
 * one ever gets past its "Loading…" placeholder.
 *
 * HEADLESS NOTE: Vite's `__vitePreload` helper awaits stylesheet <link>
 * load events before resolving chunk imports, and jsdom never fires them
 * — so this script shims link load events (same as smoke-dom). In a real
 * browser/webview they fire normally. Separately, LazyWorkspace itself is
 * hardened at the app layer: `loadWithTimeout` (9s) turns a rejecting or
 * never-settling chunk into a visible, retryable failed state with the
 * reason logged — asset/stylesheet trouble (CSP, wrong base path,
 * asset-protocol race, stale chunk after an update) can never mean a
 * silent infinite "Loading…" in production.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { bootDom, resolveBundle, sleep } from "./helpers/jsdom-boot.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const dom = bootDom(1280, 800);

let bundleUrl;
try {
  bundleUrl = await resolveBundle(root);
} catch {
  console.log("FAIL  no bundle in dist/index.html (run npm run build first)");
  process.exit(1);
}
await import(bundleUrl);
await sleep(1500);

const btns = [...dom.window.document.querySelectorAll(".workspace-nav button")];

let failures = 0;
for (const label of ["Novel", "Script", "Map", "Reader", "Projects", "Library", "Settings"]) {
  const btn = btns.find((b) => (b.getAttribute("aria-label") || "").trim() === label);
  if (!btn) { console.log("FAIL ", label.padEnd(10), "-> nav button not found"); failures++; continue; }
  btn.click();
  await sleep(1500);
  const html = dom.window.document.getElementById("app").innerHTML;
  const stuck = html.includes("lazy-state") && html.includes("Loading");
  const failed = html.includes("Couldn't load this view") || html.includes("lazy-retry");
  console.log(`${!stuck && !failed ? "PASS" : "FAIL"}  ${label.padEnd(10)} -> stuck loading: ${stuck} | shows failed state: ${failed}`);
  if (stuck || failed) failures++;
}
// Mounted workspaces start persistent timers (d3-force sims, clocks),
// so Node would linger forever headless — the report above is complete.
console.log(failures === 0 ? "LAZY-LOAD ALL PASS" : `LAZY-LOAD ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
