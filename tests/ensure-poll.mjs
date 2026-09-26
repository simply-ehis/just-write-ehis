/**
 * ensure-poll — unit checks for the shared sidecar ensure flow
 * (pollUntilHealthy + ensureSidecar in src/lib/stores/audio.ts):
 *  - flaky health (fails twice, then ok) still boots;
 *  - never-healthy hits the cap and reports failure (no hang);
 *  - already-running short-circuits without starting;
 *  - progress ticks name the sidecar with elapsed seconds.
 *
 * audio.ts uses the $lib alias, so it is bundled first (same esbuild
 * pattern as e2e-browser.mjs / ai-error-probe.mjs).
 *
 * Run: node tests/ensure-poll.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const memory = new Map();
globalThis.localStorage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => memory.set(key, String(value)),
  removeItem: (key) => memory.delete(key),
};
const esbuild = await import("esbuild");
const { mkdir, rm } = await import("node:fs/promises");
const outdir = join(root, "tests", ".tmp-ensure-poll");
await mkdir(outdir, { recursive: true });
const outfile = join(outdir, "audio.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/stores/audio.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { $lib: join(root, "src/lib") },
  outfile,
  logLevel: "silent",
});
const audio = await import(pathToFileURL(outfile).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Flaky health: two failures, then ok.
{
  let calls = 0;
  const ticks = [];
  const res = await audio.pollUntilHealthy(
    async () => {
      calls++;
      if (calls < 3) throw new Error("not up");
      return { ok: true };
    },
    (h) => h.ok,
    "Moonshine",
    (msg) => ticks.push(msg),
    5000,
    100,
  );
  check("flaky health still boots", res.healthy === true && calls === 3, `${calls} checks`);
  check("progress names sidecar + seconds", ticks.length > 0 && ticks[0].includes("Moonshine"), ticks[0] || "no ticks");
}

// Never healthy: cap hit, no hang.
{
  const t0 = Date.now();
  const res = await audio.pollUntilHealthy(
    async () => { throw new Error("down"); },
    () => true,
    "Kokoro",
    () => {},
    600,
    100,
  );
  const elapsed = Date.now() - t0;
  check("dead sidecar fails (not hangs)", res.healthy === false);
  check("cap bounds the wait", elapsed < 3000, `${elapsed}ms`);
}

// ensureSidecar: already-running short-circuits start.
{
  let started = 0;
  let healthChecks = 0;
  const events = [];
  const ok = await audio.ensureSidecar({
    kind: "Test",
    isRunning: async () => true,
    start: async () => { started++; },
    health: async () => { healthChecks++; return {}; },
    modelReady: () => true,
    setRunning: (v) => events.push(["running", v]),
    setLoaded: (v) => events.push(["loaded", v]),
    setError: (e) => events.push(["error", e]),
    setProgress: () => {},
    setProbed: () => events.push(["probed"]),
  });
  check("running short-circuits start", ok === true && started === 0);
  check("running process still health-checks", healthChecks === 1, `${healthChecks} checks`);
  check("probed flagged", events.some(([k]) => k === "probed"));
}

// ensureSidecar: an owned process may still be loading its HTTP server.
{
  let started = 0;
  let healthChecks = 0;
  const ok = await audio.ensureSidecar({
    kind: "Loading",
    isRunning: async () => true,
    start: async () => { started++; },
    health: async () => {
      healthChecks++;
      if (healthChecks < 3) throw new Error("still loading");
      return { ready: true };
    },
    modelReady: (h) => h.ready,
    setRunning: () => {},
    setLoaded: () => {},
    setError: () => {},
    setProgress: () => {},
    setProbed: () => {},
  });
  check("running process waits for health", ok === true && healthChecks === 3, `${healthChecks} checks`);
  check("loading process is not restarted", started === 0);
}

// ensureSidecar: start failure surfaces error + not running.
{
  const events = [];
  const ok = await audio.ensureSidecar({
    kind: "Test",
    isRunning: async () => false,
    start: async () => { throw new Error("spawn ENOENT"); },
    health: async () => ({}),
    modelReady: () => true,
    setRunning: (v) => events.push(["running", v]),
    setLoaded: (v) => events.push(["loaded", v]),
    setError: (e) => events.push(["error", e]),
    setProgress: () => {},
    setProbed: () => events.push(["probed"]),
  });
  check("start failure returns false", ok === false);
  check("start failure sets error", events.some(([k, v]) => k === "error" && String(v).includes("ENOENT")));
  check("start failure marks down", events.some(([k, v]) => k === "running" && v === false));
}

check("TTS server is ready before lazy model load", audio.ttsModelReady({ ready: true, model_loaded: false }));
check("TTS incomplete bundle is not ready", !audio.ttsModelReady({ ready: false, model_loaded: false }));
check("STT health requires a loaded runtime", !audio.sttModelReady({ ready: false, model_loaded: false }));
check("LLM health accepts native ok status", audio.llmModelReady({ status: "ok" }));

// ensureSidecar: an unhealthy model is not reported as usable.
{
  const events = [];
  const ok = await audio.ensureSidecar({
    kind: "Voice",
    isRunning: async () => false,
    start: async () => {},
    health: async () => ({ ready: false, error: "runtime missing" }),
    modelReady: (h) => h.ready,
    unavailableMessage: (h) => h.error,
    setRunning: () => {},
    setLoaded: (v) => events.push(["loaded", v]),
    setError: (e) => events.push(["error", e]),
    setProgress: () => {},
    setProbed: () => {},
  });
  check("unready model returns false", ok === false);
  check("unready model surfaces detail", events.some(([k, v]) => k === "error" && v === "runtime missing"));
  check("unready model is not marked loaded", events.some(([k, v]) => k === "loaded" && v === false));
}

await rm(outdir, { recursive: true, force: true });

console.log(failures === 0 ? "ENSURE-POLL ALL PASS" : `ENSURE-POLL ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
