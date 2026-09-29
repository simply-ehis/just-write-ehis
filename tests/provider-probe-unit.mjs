/**
 * provider-probe-unit — the Settings → Test path actually works.
 *
 * Covers the two halves of finding 8 that ship no Rust UI:
 * 1. testProvider (browser/preview fetch): attaches the API key as a
 *    Bearer header when given (the old code never sent one, so hosted
 *    providers always 401'd), sends none when omitted, matches model
 *    names exactly + by `org/model` suffix, caps at 20, and maps HTTP
 *    failures and network throws to `ok: false` (never rejects).
 * 2. api.providerProbe end to end through the preview backend: the same
 *    result shape, never rejects on dead endpoints, and forwards the key.
 *
 * Run: npm run test:providerprobe (part of npm run test:source)
 */
import { mkdir, rm } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let failures = 0;

function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Backend stores touch localStorage at import: stub it before anything loads.
if (typeof globalThis.localStorage === "undefined") {
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => void store.set(k, String(v)),
    removeItem: (k) => void store.delete(k),
    clear: () => store.clear(),
  };
}

// Scenario-driven fetch stub: the "endpoint" under test.
let scenario = { ok: true, status: 200, body: { data: [] }, throw: null };
const seen = [];
globalThis.fetch = async (url, init = {}) => {
  seen.push({ url, headers: init.headers ?? {} });
  if (scenario.throw) throw scenario.throw;
  return { ok: scenario.ok, status: scenario.status, json: async () => scenario.body };
};

const esbuild = await import("esbuild");
const outdir = join(root, "tests", ".tmp-provider");
await mkdir(outdir, { recursive: true });
async function bundle(entry, out) {
  const outfile = join(outdir, out);
  await esbuild.build({
    entryPoints: [join(root, entry)],
    bundle: true,
    platform: "node",
    format: "esm",
    outfile,
    logLevel: "error",
    alias: { $lib: join(root, "src/lib") },
  });
  return import(pathToFileURL(outfile).href);
}

const { testProvider } = await bundle("src/lib/providerTest.ts", "providerTest.mjs");
const { api } = await bundle("src/lib/api.ts", "api.mjs");

// ── 1. testProvider ──────────────────────────────────────────────
scenario = { ok: true, status: 200, body: { data: [{ id: "gpt-4o-mini" }, { id: "other" }] }, throw: null };
seen.length = 0;
let r = await testProvider("https://api.openai.com/v1/", "gpt-4o-mini", "sk-test-key");
check("sends Bearer key when given", seen[0]?.headers?.Authorization === "Bearer sk-test-key");
check("exact model match", r.ok && r.modelFound && r.models.includes("gpt-4o-mini"));
check("latency reported", Number.isFinite(r.latencyMs) && r.latencyMs >= 0);

seen.length = 0;
r = await testProvider("https://api.openai.com/v1", "gpt-4o-mini");
check("no Authorization header without key", !("Authorization" in (seen[0]?.headers ?? {})));

scenario = { ok: true, status: 200, body: { data: [{ id: "org/llama3.2" }] }, throw: null };
r = await testProvider("http://localhost:11434/v1", "llama3.2");
check("suffix model match (org/model)", r.ok && r.modelFound);

r = await testProvider("http://localhost:11434/v1", "missing-model");
check("unknown model is reachable-but-unlisted", r.ok && !r.modelFound && r.error === "");

scenario = {
  ok: true, status: 200,
  body: { data: Array.from({ length: 30 }, (_, i) => ({ id: `m-${i}` })) },
  throw: null,
};
r = await testProvider("http://localhost:11434/v1", "m-0");
check("models capped at 20", r.models.length === 20 && r.modelFound);

scenario = { ok: false, status: 401, body: {}, throw: null };
r = await testProvider("https://api.openai.com/v1", "gpt-4o-mini", "sk-bad");
check("HTTP 401 maps to ok:false (was the misleading case)", !r.ok && r.error === "HTTP 401" && !r.modelFound);

scenario = { ok: true, status: 200, body: {}, throw: new TypeError("fetch failed") };
r = await testProvider("https://nope.invalid/v1", "x");
check("network throw maps to ok:false, never rejects", !r.ok && r.error === "fetch failed" && Number.isFinite(r.latencyMs));

seen.length = 0;
r = await testProvider("", "x");
check("empty endpoint rejected without fetching", !r.ok && r.error.includes("http(s)") && seen.length === 0);
r = await testProvider("notaurl", "x");
check("non-URL endpoint rejected without fetching", !r.ok && seen.length === 0);

// ── 2. api.providerProbe (preview path) ──────────────────────────
scenario = { ok: true, status: 200, body: { data: [{ id: "gpt-4o-mini" }] }, throw: null };
seen.length = 0;
const p = await api.providerProbe("https://api.openai.com/v1", "gpt-4o-mini", "sk-test-key");
check("providerProbe maps models + match", p.ok && p.modelFound && p.models.join() === "gpt-4o-mini");
check("providerProbe forwards the key", seen[0]?.headers?.Authorization === "Bearer sk-test-key");

scenario = { ok: true, status: 200, body: {}, throw: new Error("CSP blocked") };
const dead = await api.providerProbe("https://blocked.example/v1", "x");
check("providerProbe never rejects on dead endpoints", !dead.ok && dead.models.length === 0);

// Remove the esbuild scratch bundle — never leave build trash behind.
await rm(join(root, "tests", ".tmp-provider"), { recursive: true, force: true });
console.log(failures === 0 ? "\nprovider-probe-unit: all checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
