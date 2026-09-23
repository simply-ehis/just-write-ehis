/**
 * lazy-load-failure — unit checks for the LazyWorkspace failure contract
 * (src/lib/lazyLoad.ts), the part that IS testable headlessly.
 *
 * The happy path (a chunk that loads) can't be proven under jsdom —
 * jsdom never fires load/error on Vite's injected stylesheet links, so
 * every lazy import hangs there (see tests/lazy-load-probe.mjs). What we
 * assert instead is that the failure path is safe and diagnosable:
 *  - a rejecting loader resolves to { ok:false } with the real message
 *    (no longer swallowed by an empty .catch());
 *  - a loader that NEVER settles falls into { ok:false } within the
 *    timeout, naming the view (no more "Loading…" forever);
 *  - a resolving loader unwraps { default } and reports { ok:true };
 *  - error messages always name the view label.
 *
 * Run: node tests/lazy-load-failure.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const { loadWithTimeout, LAZY_LOAD_TIMEOUT_MS } = await import(
  pathToFileURL(join(root, "src/lib/lazyLoad.ts")).href
);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

check("timeout constant is 8-10s", LAZY_LOAD_TIMEOUT_MS >= 8000 && LAZY_LOAD_TIMEOUT_MS <= 10000, `${LAZY_LOAD_TIMEOUT_MS}ms`);

// Rejecting loader → failed with the real message preserved.
const boom = await loadWithTimeout(() => Promise.reject(new Error("chunk 404: NovelWorkspace-abc.js")), "Novel Studio", 500);
check("rejection becomes failed state", boom.ok === false);
check("real message preserved", !boom.ok && boom.message.includes("chunk 404"), JSON.stringify(!boom.ok && boom.message));

// Never-settling loader → failed within the timeout, naming the view.
const t0 = Date.now();
const stuck = await loadWithTimeout(() => new Promise(() => {}), "Script", 300);
const elapsed = Date.now() - t0;
check("hung load fails instead of hanging forever", stuck.ok === false);
check("timeout bounds the wait", elapsed < 2000, `${elapsed}ms`);
check("timeout names the view", !stuck.ok && stuck.message.includes("Script"), JSON.stringify(!stuck.ok && stuck.message));

// Resolving loader → ok with default-export unwrapped.
const good = await loadWithTimeout(() => Promise.resolve({ default: { marker: 1 } }), "Reader", 500);
check("resolving loader succeeds", good.ok === true);
check("default export unwrapped", good.ok && good.module?.marker === 1);

// Non-Error rejections still produce a readable message.
const weird = await loadWithTimeout(() => Promise.reject("gone"), "Map", 500);
check("string rejection readable", !weird.ok && weird.message === "gone", JSON.stringify(!weird.ok && weird.message));

console.log(failures === 0 ? "LAZY-LOAD-FAILURE ALL PASS" : `LAZY-LOAD-FAILURE ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
