/**
 * writeback-queue — order checks for the write-back FIFO
 * (src/lib/stores/writeBack.ts). Rapid Insert/Replace/Append clicks
 * used to overwrite the single slot and drop all but the last event;
 * now they queue: head visible, clear() advances.
 *
 * Run: node tests/writeback-queue.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm } from "node:fs/promises";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = await import("esbuild");
const outDir = join(root, "tests", ".tmp-writeback-flow");
const outFile = join(outDir, "writeback.mjs");
await mkdir(outDir, { recursive: true });
await esbuild.build({
  entryPoints: [join(root, "src/lib/stores/writeBack.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { $lib: join(root, "src/lib") },
  outfile: outFile,
  logLevel: "silent",
});
const { writeBack } = await import(`${pathToFileURL(outFile).href}?${Date.now()}`);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

let current = "unset";
const unsub = writeBack.subscribe((v) => {
  current = v;
});

writeBack.insert("one", "doc-a");
writeBack.replace("two", "doc-a");
writeBack.append("three", "doc-a");
check("queue depth is 3", writeBack.depth() === 3, String(writeBack.depth()));
check("head is the first event (insert)", current?.action === "insert" && current?.content === "one");
check("head targets doc-a", current?.docId === "doc-a");

writeBack.clear();
check("clear advances to replace", current?.action === "replace" && current?.content === "two");
writeBack.clear();
check("clear advances to append", current?.action === "append" && current?.content === "three");
writeBack.clear();
check("clear drains to null", current === null);
check("depth is 0", writeBack.depth() === 0);
writeBack.clear();
check("extra clear is a safe no-op", current === null && writeBack.depth() === 0);

unsub();
await rm(outDir, { recursive: true, force: true });
console.log(failures === 0 ? "WRITEBACK-QUEUE ALL PASS" : `WRITEBACK-QUEUE ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
