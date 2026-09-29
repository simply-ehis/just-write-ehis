/**
 * daily-note-unit — openDailyNote creates the note for the LOCAL day.
 *
 * Regression: the date was built with toISOString (UTC), so opening the
 * daily note at 11pm local created/searched the *next* day's note.
 * The flow runs against the real preview backend: after the call, the
 * persisted preview docs must contain a note whose body starts with the
 * local YYYY-MM-DD.
 *
 * Limitation, stated plainly: on machines running UTC the old code
 * produces the same date, so this test can only fail off-UTC. It still
 * guards the wiring (search-then-create, template variable) everywhere.
 *
 * Run: npm run test:dailynote (part of npm run test:source)
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

// Capture preview-backend persistence.
const persisted = new Map();
globalThis.localStorage = {
  getItem: (k) => (persisted.has(k) ? persisted.get(k) : null),
  setItem: (k, v) => void persisted.set(k, String(v)),
  removeItem: (k) => void persisted.delete(k),
  clear: () => persisted.clear(),
};

const esbuild = await import("esbuild");
const outdir = join(root, "tests", ".tmp-dailynote");
await mkdir(outdir, { recursive: true });
const outfile = join(outdir, "dailyNote.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/dailyNote.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  outfile,
  logLevel: "error",
  alias: { $lib: join(root, "src/lib") },
});
const { openDailyNote } = await import(pathToFileURL(outfile).href);

await openDailyNote();

const now = new Date();
const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
const docs = JSON.parse(persisted.get("jwe-browser-docs-v1") ?? "[]");
const note = docs.find((d) => typeof d.content === "string" && d.content.startsWith(`# ${localToday}`));
check("daily note created for the local day", Boolean(note), localToday);
check("daily note carries the template title", note?.title === "Daily Note", note?.title ?? "none");

// Second call finds the existing note instead of minting a duplicate.
await openDailyNote();
const again = JSON.parse(persisted.get("jwe-browser-docs-v1") ?? "[]");
check(
  "reopen finds rather than duplicates",
  again.filter((d) => typeof d.content === "string" && d.content.startsWith(`# ${localToday}`)).length === 1
);

// Remove the esbuild scratch bundle — never leave build trash behind.
await rm(join(root, "tests", ".tmp-dailynote"), { recursive: true, force: true });
console.log(failures === 0 ? "\ndaily-note-unit: all checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
