/**
 * Audio store — STT (Moonshine Voice) + TTS (Kokoro-82M) state.
 * Lazy-loads sidecars on first tap (A7.6).
 */
import { writable, derived } from 'svelte/store';
import { api } from '$lib/api';
import { get } from 'svelte/store';
import { settings } from './settings';

// ── STT state ───────────────────────────────────────────────────
export const sttRunning = writable(false);
export const sttModelLoaded = writable(false);
export const sttRecording = writable(false);
export const sttTranscribing = writable(false);
export const sttError = writable<string | null>(null);

// ── TTS state ───────────────────────────────────────────────────
export const ttsRunning = writable(false);
export const ttsModelLoaded = writable(false);
export const ttsPlaying = writable(false);
export const ttsError = writable<string | null>(null);

// ── LLM state ───────────────────────────────────────────────────
export const llmRunning = writable(false);
export const llmModelLoaded = writable(false);

// ── Startup progress + probe flags ──────────────────────────────
// Progress text while poll-until-healthy runs ("Starting Moonshine… 3s").
// Probed flags let buttons gate on model_loaded only AFTER a first
// ensure attempt — never disabled on cold boot before trying.
export const sttStarting = writable<string | null>(null);
export const ttsStarting = writable<string | null>(null);
export const llmStarting = writable<string | null>(null);
export const sttProbed = writable(false);
export const ttsProbed = writable(false);

export const STT_FETCH_HINT =
  "Moonshine model not loaded — fetch it first (fetch_sidecars.py, see docs/MODELS.md).";
export const TTS_FETCH_HINT =
  "No voice output — fetch the TTS bundle first (fetch_sidecars.py --tts).";

/** Poll `check` until `ok` (500ms interval, 15s cap). Never throws. */
export async function pollUntilHealthy<T>(
  check: () => Promise<T>,
  ok: (h: T) => boolean,
  label: string,
  onTick: (msg: string, elapsedSec: number) => void,
  capMs = 15000,
  intervalMs = 500,
): Promise<{ healthy: boolean; elapsedMs: number }> {
  const t0 = Date.now();
  for (;;) {
    try {
      if (ok(await check())) return { healthy: true, elapsedMs: Date.now() - t0 };
    } catch {
      /* not up yet — keep polling */
    }
    const elapsed = Date.now() - t0;
    if (elapsed >= capMs) return { healthy: false, elapsedMs: elapsed };
    onTick(`Starting ${label}… ${Math.floor(elapsed / 1000)}s`, Math.floor(elapsed / 1000));
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface SidecarSpec<THealth> {
  kind: string;
  isRunning: () => Promise<boolean>;
  start: () => Promise<void>;
  health: () => Promise<THealth>;
  /** True when the health payload means "loaded enough to use". */
  modelReady: (h: THealth) => boolean;
  setRunning: (v: boolean) => void;
  setLoaded: (v: boolean) => void;
  setError: (e: string | null) => void;
  setProgress: (msg: string | null, elapsedSec: number) => void;
  setProbed: () => void;
}

/**
 * ONE ensure flow for every sidecar (STT/TTS/LLM/memory): running → true;
 * else start → poll-until-healthy (replaces the old fixed 500ms/1s
 * sleeps that raced cold loads) → model flag from health. Returns false
 * with the store error set on any failure. Notably, an LLM cold load
 * (1–5s) now awaits readiness instead of letting ghost fall back.
 */
export async function ensureSidecar<THealth>(spec: SidecarSpec<THealth>): Promise<boolean> {
  try {
    if (await spec.isRunning()) {
      spec.setRunning(true);
      spec.setProbed();
      return true;
    }
  } catch (e) {
    spec.setError(String(e));
    spec.setProbed();
    return false;
  }
  try {
    await spec.start();
    spec.setRunning(true);
    const res = await pollUntilHealthy(spec.health, () => true, spec.kind, (m, s) => spec.setProgress(m, s));
    spec.setProgress(null, 0);
    spec.setProbed();
    if (!res.healthy) {
      spec.setError(`${spec.kind} sidecar started but never became healthy.`);
      spec.setRunning(false);
      return false;
    }
    const h = await spec.health();
    spec.setLoaded(spec.modelReady(h));
    return true;
  } catch (e) {
    spec.setError(String(e));
    spec.setRunning(false);
    spec.setLoaded(false);
    spec.setProgress(null, 0);
    spec.setProbed();
    return false;
  }
}

// ── Derived ─────────────────────────────────────────────────────
export const sttReady = derived(sttRunning, ($r) => $r);
export const ttsReady = derived(ttsRunning, ($r) => $r);
export const llmReady = derived(llmRunning, ($r) => $r);

// ── Sidecar paths (from settings) ───────────────────────────────
export function getPythonPath(): string {
  return get(settings).pythonPath || 'python';
}

/**
 * Directory holding the sidecar scripts + models. In dev this is the repo
 * path; in a packaged app the scripts live under Tauri's resource dir, so
 * resolve it there (async import keeps the path plugin out of the preview
 * bundle). Preview falls back to the dev path — sidecar spawn fails closed
 * there anyway (no python), surfaced as a clear sidecar error.
 */
export async function getSidecarsDir(): Promise<string> {
  const devPath = 'src-tauri/sidecars';
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    if (!isTauri()) return devPath;
    const { resourceDir, join } = await import('@tauri-apps/api/path');
    return await join(await resourceDir(), 'sidecars');
  } catch {
    return devPath;
  }
}

// ── STT actions ─────────────────────────────────────────────────

/** Start the Moonshine sidecar (lazy, first tap). */
export async function ensureStt(): Promise<boolean> {
  return ensureSidecar({
    kind: "Moonshine",
    isRunning: () => api.sttIsRunning(),
    start: async () => {
      await api.sttStart(getPythonPath(), await getSidecarsDir(), get(settings).sttModel || undefined);
    },
    health: () => api.sttHealth(),
    modelReady: (h) => h.model_loaded,
    setRunning: (v) => sttRunning.set(v),
    setLoaded: (v) => sttModelLoaded.set(v),
    setError: (e) => sttError.set(e),
    setProgress: (m) => sttStarting.set(m),
    setProbed: () => sttProbed.set(true),
  });
}

/** Stop the Moonshine sidecar (e.g. when STT is toggled off). Best-effort. */
export async function stopStt(): Promise<void> {
  try {
    await api.sttStop();
  } catch {
    /* already down */
  } finally {
    sttRunning.set(false);
    sttModelLoaded.set(false);
  }
}

/** Transcribe a full audio blob (one-shot). */
export async function transcribeAudio(
  audioB64: string,
  format: string = 'wav'
): Promise<string | null> {
  sttTranscribing.set(true);
  sttError.set(null);
  try {
    const text = await api.sttTranscribe(audioB64, format);
    return text;
  } catch (e) {
    sttError.set(String(e));
    return null;
  } finally {
    sttTranscribing.set(false);
  }
}

// ── TTS actions ─────────────────────────────────────────────────

/** Start the Kokoro sidecar (lazy, first tap). */
export async function ensureTts(): Promise<boolean> {
  return ensureSidecar({
    kind: "Kokoro",
    isRunning: () => api.ttsIsRunning(),
    start: async () => {
      await api.ttsStart(getPythonPath(), await getSidecarsDir(), get(settings).ttsModel || undefined);
    },
    health: () => api.ttsHealth(),
    modelReady: (h) => h.model_loaded,
    setRunning: (v) => ttsRunning.set(v),
    setLoaded: (v) => ttsModelLoaded.set(v),
    setError: (e) => ttsError.set(e),
    setProgress: (m) => ttsStarting.set(m),
    setProbed: () => ttsProbed.set(true),
  });
}

/** Synthesize text → returns base64 WAV audio. Uses settings for all params. */
export async function synthesizeText(
  text: string,
  overrides?: { voice?: string; speed?: number; langCode?: string; splitPattern?: string; chunkSize?: number }
): Promise<{ audio: string; sampleRate: number } | null> {
  ttsError.set(null);
  const s = get(settings);
  const voice = overrides?.voice ?? s.ttsVoice;
  const speed = overrides?.speed ?? s.ttsSpeed;
  const langCode = overrides?.langCode ?? s.ttsLangCode;
  const splitPattern = overrides?.splitPattern ?? s.ttsSplitPattern;
  const chunkSize = overrides?.chunkSize ?? s.ttsChunkSize;
  try {
    const [audio, sampleRate] = await api.ttsSynthesize(text, voice, speed, langCode, splitPattern, chunkSize);
    if (!audio) {
      // Server reachable but voiceless: bundle not fetched (or all chunks
      // failed). Say so plainly instead of a cryptic decode error.
      ttsError.set(TTS_FETCH_HINT);
      return null;
    }
    return { audio, sampleRate };
  } catch (e) {
    ttsError.set(String(e));
    return null;
  }
}

/** Stop current TTS playback (client-side audio element). */
export async function stopTtsPlayback(): Promise<void> {
  stopWavPlayback();
  ttsPlaying.set(false);
  try {
    await api.ttsStopPlayback();
  } catch {
    // Best effort
  }
}

/** Stop the Kokoro sidecar (e.g. when TTS is toggled off). Best-effort. */
export async function stopTts(): Promise<void> {
  try {
    await api.ttsStop();
  } catch {
    /* already down */
  } finally {
    ttsRunning.set(false);
    ttsModelLoaded.set(false);
  }
}

// ── LLM actions ─────────────────────────────────────────────────

/** Start the llama.cpp server sidecar (lazy, first ghost autocomplete). */
export async function ensureLlm(): Promise<boolean> {
  return ensureSidecar({
    kind: "llama",
    isRunning: () => api.llmIsRunning(),
    start: async () => {
      const s = get(settings);
      await api.llmStart(await getSidecarsDir(), s.llmModel || undefined, s.smallModelContextLength || undefined);
    },
    health: () => api.llmHealth(),
    modelReady: (h) => !!h.model,
    setRunning: (v) => llmRunning.set(v),
    setLoaded: (v) => llmModelLoaded.set(v),
    setError: () => {},
    setProgress: (m) => llmStarting.set(m),
    setProbed: () => {},
  });
}

/** Stop the llama.cpp server sidecar (e.g. when LLM is toggled off). Best-effort. */
export async function stopLlm(): Promise<void> {
  try {
    await api.llmStop();
  } catch {
    /* already down */
  } finally {
    llmRunning.set(false);
    llmModelLoaded.set(false);
  }
}

// ── Browser audio helpers ───────────────────────────────────────

let _audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext {
  if (!_audioCtx) {
    _audioCtx = new AudioContext();
  }
  return _audioCtx;
}

let currentSource: AudioBufferSourceNode | null = null;
let playSeq = 0;
const pendingResolves = new Set<() => void>();

/** Actually stop client-side playback: stop()+disconnect the live source.
 * Decode caveat: decodeAudioData has no cancel — if stop lands mid-decode,
 * the decoded buffer is dropped via the generation check below and at most
 * a short tail (already-scheduled audio) plays out. Pending play promises
 * resolve on stop so `await playWavBase64` never hangs the caller. */
export function stopWavPlayback(): void {
  playSeq++;
  try {
    currentSource?.stop();
  } catch {
    /* already stopped */
  }
  try {
    currentSource?.disconnect();
  } catch {
    /* already disconnected */
  }
  currentSource = null;
  for (const resolve of [...pendingResolves]) resolve();
  pendingResolves.clear();
}

/** Play base64 WAV audio. Resolves when done — or on stop (never hangs). */
export function playWavBase64(b64: string): Promise<void> {
  const seq = ++playSeq;
  return new Promise((resolve, reject) => {
    pendingResolves.add(resolve);
    const done = (fn: () => void) => {
      pendingResolves.delete(resolve);
      fn();
    };
    try {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      const ctx = getAudioContext();
      ctx.decodeAudioData(bytes.buffer, (buffer) => {
        if (seq !== playSeq) {
          done(resolve); // stopped mid-decode: drop, don't play the tail
          return;
        }
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        currentSource = source;
        source.onended = () => {
          if (currentSource === source) currentSource = null;
          done(resolve);
        };
        source.start();
      }, (e) => done(() => reject(e)));
    } catch (e) {
      done(() => reject(e));
    }
  });
}

/* recordFromMic removed: the deprecated ScriptProcessor path was superseded
   by the MediaRecorder flow in MicButton.svelte (no callers remained). */
