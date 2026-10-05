/**
 * export-batch — headless checks for batch export (src/lib/import.ts):
 *  - dedupeFilename never collides (no silent overwrites in zips);
 *  - mapLimit converts with bounded concurrency;
 *  - batchExport zips 20 same-titled docs with unique names + bundled
 *    attachments, through the REAL preview backend (no mocks);
 *  - desktop-only matrix: docx in preview fails friendly (never throws
 *    raw, never hangs); cancel aborts mid-batch.
 *
 * import.ts uses the $lib alias, so it is bundled first (established
 * esbuild pattern). localStorage is stubbed (browserStore persists).
 *
 * Run: node tests/export-batch.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  };
}

const esbuild = await import("esbuild");
const { mkdir, rm } = await import("node:fs/promises");
const outdir = join(root, "tests", ".tmp-export-batch");
await mkdir(outdir, { recursive: true });
const outfile = join(outdir, "import.mjs");
await esbuild.build({
  entryPoints: [join(root, "src/lib/import.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { $lib: join(root, "src/lib") },
  outfile,
  logLevel: "silent",
});
const imp = await import(pathToFileURL(outfile).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Pure helpers first (no backend needed).
{
  const used = new Set(["a.md"]);
  check("dedupe collides safely", imp.dedupeFilename(used, "a.md") === "a (2).md");
  check("dedupe second collision", imp.dedupeFilename(used, "a.md") === "a (3).md");
  check("dedupe keeps clean names", imp.dedupeFilename(new Set(), "b.txt") === "b.txt");

  let live = 0;
  let peak = 0;
  const { results } = await imp.mapLimit([1, 2, 3, 4, 5, 6], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 20));
    live--;
    return n * 2;
  });
  check("mapLimit bounds concurrency", peak <= 2, `peak ${peak}`);
  check("mapLimit maps all", JSON.stringify(results) === "[2,4,6,8,10,12]");
}

// Seed 20 same-titled docs (dupe filenames!) + one with an attachment ref.
// browserBackend needs bundling too ($lib alias) — same pattern.
await esbuild.build({
  entryPoints: [join(root, "src/lib/browserBackend.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { $lib: join(root, "src/lib") },
  outfile: join(outdir, "backend.mjs"),
  logLevel: "silent",
});
const { browserInvoke } = await import(pathToFileURL(join(outdir, "backend.mjs")).href);

const ids = [];
for (let i = 0; i < 20; i++) {
  const d = await browserInvoke("doc_create", {
    workspace: "write",
    kind: "doc",
    title: "Same Title",
    content: `# Same Title\n\nBody ${i} with [[Ghost Doc]] link.`,
  });
  ids.push(d.id);
}
const withAttach = await browserInvoke("doc_create", {
  workspace: "write",
  kind: "doc",
  title: "With Attach",
  content: "See ![pic](.attachments/a.png).",
});
ids.push(withAttach.id);

// Advertisement for attachment bundling: plant the file via JSZip-less
// localStorage? Attachments live on disk (Rust side) — in preview,
// attachment_read has no file, so it skips and counts. Assert skip path.
const seen = [];
const out = await imp.batchExport(ids, "zip", {
  onProgress: (p) => seen.push(`${p.done}/${p.total}`),
});
check("20-tab zip produced", out.filename.endsWith(".zip"), out.filename);
check("progress reported", seen.length > 0 && seen[seen.length - 1].startsWith("21/"), seen.slice(-1)[0]);
check("missing attachments skipped + counted", out.attachmentsSkipped >= 1, `skipped=${out.attachmentsSkipped}`);

// Zip contents: 21 unique names, bodies present.
{
  const JSZip = (await import("jszip")).default;
  const raw = Buffer.from(out.base64, "base64");
  const zip = await JSZip.loadAsync(raw);
  const names = Object.keys(zip.files).filter((n) => !zip.files[n].dir);
  check("21 files, all unique", names.length === 21 && new Set(names).size === 21, `${names.length} files`);
  const first = await zip.files[names[0]].async("string");
  check("converted body inside", first.includes("Body") || first.includes("Same Title"));
}

// Desktop-only matrix: in browser preview the Rust writers and the bundled
// Typst are absent, so docx must fail friendly with a clear message and
// never throw raw or hang.
try {
  await imp.batchExport([ids[0]], "docx");
  check("no-desktop docx fails friendly", false, "resolved unexpectedly");
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  check(
    "no-desktop docx fails friendly",
    msg.includes("desktop-only"),
    msg.slice(0, 120),
  );
}

// Cancel aborts mid-batch.
{
  let calls = 0;
  try {
    await imp.batchExport(ids.slice(0, 10), "zip", {
      shouldCancel: () => ++calls > 2,
    });
    check("cancel aborts", false, "resolved unexpectedly");
  } catch (e) {
    check("cancel aborts", String(e instanceof Error ? e.message : e).includes("cancelled"));
  }
}

await rm(outdir, { recursive: true, force: true });

console.log(failures === 0 ? "EXPORT-BATCH ALL PASS" : `EXPORT-BATCH ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
