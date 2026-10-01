/**
 * session-health-unit — hang evidence is recorded and readable.
 *
 * sessionHealth: previous-session exit is captured before the flag is
 * overwritten (clean / unclean / unknown-first-run), stuck boot steps
 * surface, boot ms parses (garbage → null).
 * api slow calls: ring keeps the last 10 with shape {cmd, ms, timestamp}.
 *
 * Run: npm run test:sessionhealth (part of npm run test:source)
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

// Writable localStorage stub (the real webview one persists across launches).
const persisted = new Map();
globalThis.localStorage = {
  getItem: (k) => (persisted.has(k) ? persisted.get(k) : null),
  setItem: (k, v) => void persisted.set(k, String(v)),
  removeItem: (k) => void persisted.delete(k),
  clear: () => persisted.clear(),
};

const esbuild = await import("esbuild");
const outdir = join(root, "tests", ".tmp-session");
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

// ── sessionHealth: previous session ended cleanly ────────────────
persisted.set("jwe-clean-exit", "1");
persisted.set("jwe-boot-ms", "1075");
let health = await bundle("src/lib/sessionHealth.ts", "sh1.mjs");
health.markBootStart();
let h = health.readSessionHealth();
check("clean previous session", h.prevExit === "clean" && h.prevBootMs === 1075);
check("flag re-armed to open", persisted.get("jwe-clean-exit") === "0");
health.markCleanExit();
check("clean exit marks 1", persisted.get("jwe-clean-exit") === "1");

// ── previous session died (flag still 0, boot on record) ─────────
persisted.set("jwe-clean-exit", "0");
persisted.set("jwe-boot-ms", "2100");
persisted.set("jwe-boot-step", "file-watcher");
health = await bundle("src/lib/sessionHealth.ts", "sh2.mjs");
health.markBootStart();
h = health.readSessionHealth();
check("unclean previous session", h.prevExit === "unclean" && h.prevBootMs === 2100);
check("stuck step surfaces", h.stuckStep === "file-watcher");

// Kill before the first boot-ms (splash hang): flag "0" alone means unclean.
persisted.delete("jwe-boot-ms");
persisted.delete("jwe-boot-step");
health = await bundle("src/lib/sessionHealth.ts", "sh2b.mjs");
health.markBootStart();
check("pre-boot kill is unclean", health.readSessionHealth().prevExit === "unclean");

// ── first run ever: no flags → unknown, never "unclean" ──────────
persisted.clear();
health = await bundle("src/lib/sessionHealth.ts", "sh3.mjs");
health.markBootStart();
h = health.readSessionHealth();
check("first run is unknown", h.prevExit === "unknown" && h.prevBootMs === null && h.bootMs === null);
persisted.set("jwe-boot-ms", "garbage");
check("garbage boot ms parses to null", health.readSessionHealth().bootMs === null);

// ── slow-call ring (api.ts) ──────────────────────────────────────
const { recordSlowCall, getSlowCalls, shouldRecordSlowCall } = await bundle("src/lib/api.ts", "api.mjs");
check("threshold boundary", shouldRecordSlowCall(2000) && !shouldRecordSlowCall(1999));
for (let i = 0; i < 12; i++) recordSlowCall(`cmd-${i}`, 2000 + i);
const slow = getSlowCalls();
check("ring keeps last 10", slow.length === 10 && slow[0].cmd === "cmd-2" && slow[9].cmd === "cmd-11");
check(
  "entries carry rounded ms + timestamp",
  slow.every((s) => Number.isInteger(s.ms) && typeof s.timestamp === "string" && s.timestamp.length > 0)
);
getSlowCalls().push({ cmd: "intruder", ms: 1, timestamp: "x" });
check("ring is isolated from readers", getSlowCalls().every((s) => s.cmd !== "intruder"));

// Remove the esbuild scratch bundle — never leave build trash behind.
await rm(join(root, "tests", ".tmp-session"), { recursive: true, force: true });
console.log(failures === 0 ? "\nsession-health-unit: all checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
