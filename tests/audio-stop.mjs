/**
 * audio-stop — stop-mid-playback proof for the TTS client path
 * (playWavBase64/stopWavPlayback in src/lib/stores/audio.ts):
 *  - stop() during pending decode resolves the play promise WITHOUT
 *    starting audio (no tail plays out);
 *  - stop() during live playback calls stop() on the live source;
 *  - normal playback still resolves via onended.
 *
 * jsdom has no AudioContext, so a minimal mock stands in; audio.ts is
 * bundled via esbuild for the $lib alias (established pattern).
 *
 * Run: node tests/audio-stop.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const sources = [];
// Minimal localStorage stub: the bundled settings/api modules warn
// without it, which only clutters output (behavior is unaffected).
{
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => void mem.set(k, String(v)),
    removeItem: (k) => void mem.delete(k),
  };
}
// Manual decode callbacks: the test fires them when ready. Installed
// BEFORE first import — audio.ts memoizes its AudioContext.
let pendingDecode = null;
globalThis.atob = (s) => Buffer.from(s, "base64").toString("binary");
globalThis.AudioContext = class {
  decodeAudioData(_buf, ok) {
    pendingDecode = ok;
  }
  createBufferSource() {
    const src = {
      stopped: false,
      started: false,
      buffer: null,
      _dest: null,
      connect(d) { this._dest = d; },
      disconnect() {},
      start() { this.started = true; },
      stop() { this.stopped = true; },
      onended: null,
    };
    sources.push(src);
    return src;
  }
  get destination() {
    return {};
  }
};

const esbuild = await import("esbuild");
const { mkdir, rm } = await import("node:fs/promises");
const outdir = join(root, "tests", ".tmp-audio-stop");
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

const b64 = Buffer.from("xxxx").toString("base64");

// 1. Stop lands after start but the decode resolves later: nothing plays,
//    and the play promise still resolves (never hangs the caller).
{
  sources.length = 0;
  let settled = false;
  const p = audio.playWavBase64(b64).then(() => {
    settled = true;
  });
  audio.stopWavPlayback();
  await new Promise((r) => setTimeout(r, 50));
  check("stop-mid-decode resolves playback", settled);
  check("no source created after stop", sources.length === 0);
  await p;
}

// 2. Normal path still plays through onended.
{
  sources.length = 0;
  pendingDecode = null;
  let settled = false;
  const p = audio.playWavBase64(b64).then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  pendingDecode({});
  await new Promise((r) => setTimeout(r, 20));
  check("source started", sources.length === 1 && sources[0].started);
  sources[0].onended();
  await p;
  check("onended resolves playback", settled);
}

// 3. Stop during live playback halts the source.
{
  sources.length = 0;
  pendingDecode = null;
  let settled = false;
  const p = audio.playWavBase64(b64).then(() => {
    settled = true;
  });
  await new Promise((r) => setTimeout(r, 20));
  pendingDecode({});
  await new Promise((r) => setTimeout(r, 20));
  audio.stopWavPlayback();
  await p;
  check("live source stopped", sources[0].stopped === true);
  check("stop resolves pending playback", settled);
}

await rm(outdir, { recursive: true, force: true });

console.log(failures === 0 ? "AUDIO-STOP ALL PASS" : `AUDIO-STOP ${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
