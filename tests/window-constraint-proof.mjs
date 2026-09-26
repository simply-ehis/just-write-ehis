import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { watch } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { spawn } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let failures = 0;

function expect(name, condition, detail) {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

function run(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

const sqliteScript = [
  "import sqlite3,tempfile,os",
  "p=os.path.join(tempfile.mkdtemp(),'widget-proof.db')",
  "a=sqlite3.connect(p,timeout=0.1)",
  "b=sqlite3.connect(p,timeout=0.1)",
  "a.execute('pragma journal_mode=WAL')",
  "a.execute('create table t(x)')",
  "a.commit()",
  "a.execute('begin immediate')",
  "a.execute('insert into t values (1)')",
  "try:",
  " b.execute('begin immediate')",
  " print('SECOND_WRITE=UNEXPECTED_SUCCESS')",
  "except sqlite3.OperationalError as e:",
  " print('SECOND_WRITE=LOCKED:'+str(e))",
  "a.rollback()",
].join("\n");
const sqlite = await run("python", ["-c", sqliteScript]);
const sqliteResult = sqlite.stdout.trim() || sqlite.stderr.trim();
console.log("CONSTRAINT 1A: two writers, one WAL vault");
console.log(sqliteResult);
expect("second WAL writer is locked", sqlite.code === 0 && sqliteResult.includes("SECOND_WRITE=LOCKED"), sqliteResult);

async function bind(port, hold = false) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", (error) => resolve({ ok: false, code: error.code }));
    server.listen(port, "127.0.0.1", () => {
      if (hold) resolve({ ok: true, server });
      else server.close(() => resolve({ ok: true }));
    });
  });
}

const initial = await bind(8093, true);
if (initial.ok) {
  const second = await bind(8093);
  const result = second.ok ? "UNEXPECTED_SUCCESS" : second.code;
  console.log("CONSTRAINT 1B: fixed sidecar port 8093");
  console.log(`SECOND_BIND=${result}`);
  expect("fixed sidecar port rejects second bind", !second.ok, result);
  initial.server.close();
  await sleep(150);
} else {
  console.log("CONSTRAINT 1B: fixed sidecar port 8093");
  console.log(`SECOND_BIND=ALREADY_BOUND:${initial.code}`);
  expect("port 8093 was free for proof", false, initial.code);
}

const docStore = await readFile(join(root, "src-tauri/src/doc_store.rs"), "utf8");
const setupStart = docStore.indexOf("pub fn setup_file_watcher");
const setupEnd = docStore.indexOf("\n    }", setupStart);
const setupSource = docStore.slice(setupStart, setupEnd);
console.log("CONSTRAINT 2: setup_file_watcher called twice");
const registrations = (setupSource.match(/recommended_watcher/g) ?? []).length;
const guarded = /OnceLock|AtomicBool|already.*watch/i.test(setupSource);
const leaked = setupSource.includes("std::mem::forget(watcher)");
console.log(`WATCHER_REGISTRATION_PER_CALL=${registrations}`);
console.log(`IDEMPOTENCE_GUARD_PRESENT=${guarded}`);
console.log(`WATCHER_LEAKED_TO_APP_LIFETIME=${leaked}`);
expect("watcher call registers a fresh watcher", registrations === 1);
expect("watcher has no idempotence guard", guarded === false);
expect("watcher survives for process lifetime", leaked === true);

const watchDir = await mkdtemp(join(tmpdir(), "widget-watch-"));
const watchFile = join(watchDir, "proof.md");
await writeFile(watchFile, "start\n");
let firstEvents = 0;
let secondEvents = 0;
const first = watch(watchFile, () => { firstEvents += 1; });
const second = watch(watchFile, () => { secondEvents += 1; });
await sleep(100);
await writeFile(watchFile, "changed\n");
await sleep(500);
first.close();
second.close();
console.log(`SAME_CHANGE_OBSERVED_BY_WATCHER_A=${firstEvents > 0}`);
console.log(`SAME_CHANGE_OBSERVED_BY_WATCHER_B=${secondEvents > 0}`);
expect("first watcher observes one change", firstEvents > 0, String(firstEvents));
expect("second watcher observes the same change", secondEvents > 0, String(secondEvents));

const capability = JSON.parse(await readFile(join(root, "src-tauri/capabilities/default.json"), "utf8"));
console.log("CONSTRAINT 3: invoke from an unlisted window label");
console.log(`CAPABLE_LABELS=${capability.windows.join(",")}`);
console.log(`ROGUE_LABEL_CAPABLE=${capability.windows.includes("rogue")}`);
console.log("RUNTIME_OBSERVATION=SKIPPED_BUILD_NOT_ALLOWED");
expect("unlisted rogue label has no capability", capability.windows.includes("rogue") === false);

if (failures) {
  console.error(`${failures} constraint proof failure(s)`);
  process.exit(1);
}
