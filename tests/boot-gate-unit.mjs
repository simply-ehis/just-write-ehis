/**
 * boot-gate-unit — checks for src/lib/bootGate.ts, the startup gate that stops
 * the frontend from racing the Rust backend's `setup`.
 *
 * Tauri starts the webviews before setup() finishes managing `db` and the
 * sidecar managers. Boot steps that fired in that window failed with "state
 * not managed for field `db`" and never retried, so the file watcher, Home
 * dashboard, status-bar stats, inbox banner, streak nudge and the companion
 * widget were dead for the whole session.
 *
 * Run: node tests/boot-gate-unit.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const g = await import(pathToFileURL(join(root, "src/lib/bootGate.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Virtual clock so timeout behaviour is tested without real waiting.
function fakeClock() {
  let now = 0;
  return {
    now: () => now,
    advance: (ms) => {
      now += ms;
    },
  };
}

const noSleep = async () => {};

// 1. A backend that is already ready costs exactly one probe.
{
  let calls = 0;
  const ok = await g.waitForBackend({
    isReady: async () => {
      calls++;
      return true;
    },
    sleep: noSleep,
  });
  check("already-ready backend resolves true", ok === true);
  check("already-ready backend costs a single probe", calls === 1, `calls=${calls}`);
}

// 2. The real race: probes throw "state not managed" until setup lands.
{
  let calls = 0;
  const clock = fakeClock();
  const ok = await g.waitForBackend({
    isReady: async () => {
      calls++;
      if (calls < 4) throw new Error("state not managed for field `db`");
      return true;
    },
    sleep: async (ms) => clock.advance(ms),
  });
  check("recovers when early probes throw not-managed", ok === true, `calls=${calls}`);
  check("retries rather than failing on the first error", calls === 4, `calls=${calls}`);
}

// 3. Still not ready: must fail OPEN, never hang or throw.
{
  const clock = fakeClock();
  const ok = await g.waitForBackend({
    isReady: async () => false,
    sleep: async (ms) => clock.advance(ms),
    timeoutMs: 100,
    intervalMs: 10,
  });
  check("never-ready backend fails open (false, no throw)", ok === false);
}

{
  const clock = fakeClock();
  const ok = await g.waitForBackend({
    isReady: async () => {
      throw new Error("backend gone");
    },
    sleep: async (ms) => clock.advance(ms),
    timeoutMs: 50,
    intervalMs: 10,
  });
  check("throwing backend fails open (false, no throw)", ok === false);
}

// 4. It really does give up at the timeout instead of spinning forever.
{
  let calls = 0;
  const ok = await g.waitForBackend({
    isReady: async () => {
      calls++;
      return false;
    },
    sleep: noSleep,
    timeoutMs: 100,
    intervalMs: 25,
  });
  check(
    "stops polling at the timeout",
    calls === 6,
    `calls=${calls} (1 initial + 4 polls + 1 final confirmation probe)`
  );
  check("timeout fails open", ok === false);
}

// 5. A backend that turns ready late is still caught before the deadline.
{
  const clock = fakeClock();
  let calls = 0;
  const ok = await g.waitForBackend({
    isReady: async () => ++calls >= 3,
    sleep: async (ms) => clock.advance(ms),
    timeoutMs: 1000,
    intervalMs: 10,
  });
  check("late-but-in-time backend is awaited", ok === true, `calls=${calls}`);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
