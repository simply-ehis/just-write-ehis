/**
 * ai-error-probe — dead-endpoint behavior through the real preview
 * backend (src/lib/browserBackend.ts, no mocks):
 *  - ai_generate against a dead local endpoint rejects with the shared
 *    friendly "Can't reach" message (never a raw TypeError, never "").
 *  - ai_structurize against the same dead endpoint falls back to the
 *    deterministic local structurizer (directives become headings).
 *
 * This is the headless half of "dead-endpoint chat reaches Error+Retry":
 * the panel renders the Error bubble + Retry button from these exact
 * strings (anchored statically in e2e-browser.mjs).
 *
 * Run: node tests/ai-error-probe.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

// browserBackend uses the $lib alias — bundle it first (same esbuild
// pattern as e2e-browser.mjs), then exercise the real module.
const esbuild = await import("esbuild");
const { mkdir, rm } = await import("node:fs/promises");
const outdir = join(root, "tests", ".tmp-ai-error");
await mkdir(outdir, { recursive: true });
const outfile = join(outdir, "backend.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/browserBackend.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { $lib: join(root, "src/lib") },
  outfile,
  logLevel: "silent",
});
const { browserInvoke } = await import(pathToFileURL(outfile).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const DEAD = "http://127.0.0.1:9/v1";

// ai_generate must reject friendly, not raw.
try {
  await browserInvoke("ai_generate", {
    request: { prompt: "hello", provider: DEAD, model: "x" },
  });
  check("dead endpoint rejects", false, "resolved unexpectedly");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  check("dead endpoint rejects friendly", msg.includes("Can't reach"), msg.slice(0, 120));
}

// ai_structurize must fall back deterministic, not throw.
try {
  const out = await browserInvoke("ai_structurize", {
    request: { text: "alpha\n{make this a table}\nbeta", provider: DEAD, model: "x" },
  });
  check(
    "dead endpoint structurize falls back local",
    typeof out?.result === "string" && out.result.includes("##"),
    String(out?.result).slice(0, 80)
  );
} catch (e) {
  check("dead endpoint structurize falls back local", false, String(e).slice(0, 120));
}

await rm(outdir, { recursive: true, force: true });

console.log(failures === 0 ? "AI-ERROR-PROBE ALL PASS" : `AI-ERROR-PROBE ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
