/**
 * Audio store — STT (Moonshine Voice) + TTS (Kokoro-82M) state.
 * Lazy-loads sidecars on first tap (A7.6).
 */
import { writable, derived } from 'svelte/store';
import { api, isBrowserPreview } from '$lib/api';
import { get } from 'svelte/store';
import { settings } from './settings';
import { showToast } from './notifications';
import { validateModelForTask, getLlmMetadata, type LlmQuantization } from '$lib/modelRegistry';

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
export const llmError = writable<string | null>(null);

// ── Startup progress + probe flags ──────────────────────────────
// Progress text while poll-until-healthy runs ("Starting Moonshine… 3s").
// Probed flags let buttons gate on model_loaded only AFTER a first
// ensure attempt — never disabled on cold boot before trying.
export const sttStarting = writable<string | null>(null);
export const ttsStarting = writable<string | null>(null);
export const llmStarting = writable<string | null>(null);
export const sttProbed = writable(false);
export const ttsProbed = writable(false);
export const llmProbed = writable(false);

export const STT_FETCH_HINT =
  "Moonshine is unavailable. Check the bundled model and Python runtime in Settings → AI & Providers.";
export const TTS_FETCH_HINT =
  "Kokoro is unavailable. Check the bundled voice model and Python runtime in Settings → AI & Providers.";

/** Shared lock for the voice keyboard shortcuts (3.10). When two button
 * instances are mounted at once (e.g. Quick Capture over a workspace),
 * both listen for the same chord — the first to handle it wins and the
 * rest no-op within the window. */
export const voiceShortcutLock = { mic: 0, tts: 0 };

/** Poll `check` until `ok` (500ms interval, 15s cap). Never throws. */
async function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("health probe timed out")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function pollUntilHealthy<T>(
  check: () => Promise<T>,
  ok: (h: T) => boolean,
  label: string,
  onTick: (msg: string, elapsedSec: number) => void,
  capMs = 15000,
  intervalMs = 500,
): Promise<{ healthy: boolean; elapsedMs: number; value?: T }> {
  const t0 = Date.now();
  for (;;) {
    const remaining = capMs - (Date.now() - t0);
    if (remaining <= 0) return { healthy: false, elapsedMs: Date.now() - t0 };
    try {
      const value = await within(check(), remaining);
      if (ok(value)) return { healthy: true, elapsedMs: Date.now() - t0, value };
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
  unavailableMessage?: (h: THealth) => string | null | undefined;
  setRunning: (v: boolean) => void;
  setLoaded: (v: boolean) => void;
  setError: (e: string | null) => void;
  setProgress: (msg: string | null, elapsedSec: number) => void;
  setProbed: () => void;
}

/**
 * In-flight ensure promises keyed by sidecar kind. Concurrent taps
 * (mic hover + click, Ghost-on + Settings test) share one start/poll
 * instead of racing two spawns against the same process (slice E).
 */
const inflightEnsures = new Map<string, Promise<boolean>>();

/**
 * ONE ensure flow for every sidecar (STT/TTS/LLM/memory): running → true;
 * else start → poll-until-healthy (replaces the old fixed 500ms/1s
 * sleeps that raced cold loads) → model flag from health. Returns false
 * with the store error set on any failure. Notably, an LLM cold load
 * (1–5s) now awaits readiness instead of letting ghost fall back.
 *
 * Single-flight: concurrent calls for the same `kind` share one promise.
 * Failure NEVER stops the process — a model that outran the 15s health
 * poll keeps loading, and the next ensure reuses the live process via
 * `isRunning()` + a fresh poll (slice E).
 */
export async function ensureSidecar<THealth>(spec: SidecarSpec<THealth>): Promise<boolean> {
  const existing = inflightEnsures.get(spec.kind);
  if (existing) return existing;
  const run = ensureSidecarOnce(spec).finally(() => {
    inflightEnsures.delete(spec.kind);
  });
  inflightEnsures.set(spec.kind, run);
  return run;
}

async function ensureSidecarOnce<THealth>(spec: SidecarSpec<THealth>): Promise<boolean> {
  const fail = async (message: string) => {
    // Never stop() here: a slow model may still be loading, and killing
    // it wastes the work. Sync the running store with reality instead —
    // a live-but-not-ready process stays "running" for the next ensure.
    spec.setError(message);
    spec.setLoaded(false);
    spec.setProgress(null, 0);
    spec.setProbed();
    try {
      spec.setRunning(await spec.isRunning());
    } catch {
      spec.setRunning(false);
    }
  };
  try {
    if (!(await spec.isRunning())) await spec.start();
    spec.setRunning(true);
    const result = await pollUntilHealthy(
      spec.health,
      () => true,
      spec.kind,
      (message, elapsedSec) => spec.setProgress(message, elapsedSec),
    );
    spec.setProgress(null, 0);
    spec.setProbed();
    if (!result.healthy) {
      const stillUp = await spec.isRunning().catch(() => false);
      if (stillUp) {
        await fail(`${spec.kind} is still starting — try again shortly.`);
      } else {
        await fail(`${spec.kind} exited before it became ready.`);
      }
      return false;
    }
    const health = result.value ?? await spec.health();
    const ready = spec.modelReady(health);
    spec.setLoaded(ready);
    if (!ready) {
      await fail(spec.unavailableMessage?.(health) || `${spec.kind} is not ready.`);
      return false;
    }
    spec.setError(null);
    return true;
  } catch (error) {
    await fail(String(error));
    return false;
  }
}

// ── Derived ─────────────────────────────────────────────────────
export const sttReady = derived(sttRunning, ($r) => $r);
export const ttsReady = derived(ttsRunning, ($r) => $r);
export const llmReady = derived(llmRunning, ($r) => $r);

// ── Sidecar paths (from settings) ───────────────────────────────
export function resolvePythonPath(): string {
  return get(settings).pythonPath?.trim() || "python";
}

/**
 * Probed interpreter resolution for sidecar starts (all three call sites
 * are async): the Settings value first, then the Windows launchers (`py`,
 * `python3`, `python`). Raw portable exes often run where `python` is not
 * on PATH but `py` is — without this the sidecar fails with a bare
 * "Python not found" and STT/TTS/memory read as dead. Falls back to the
 * configured value (whose probe error then surfaces verbatim) when none
 * of the candidates respond.
 */
export async function resolvePythonPathProbed(): Promise<string> {
  const configured = resolvePythonPath();
  for (const candidate of [...new Set([configured, "py", "python3", "python"])]) {
    try {
      await api.sidecarPythonProbe(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return configured;
}

/**
 * Directory holding the sidecar scripts + models — resolved by the ONE
 * Rust-side command (resource dir → beside exe → source checkout), so dev
 * runs stop failing closed on a resourceDir/sidecars that is never copied
 * there. The backend errors list every tried path. Preview (no Tauri) keeps
 * the dev-path string — sidecar spawn fails closed there anyway.
 */
export async function getSidecarsDir(): Promise<string> {
  try {
    const { isTauri } = await import('@tauri-apps/api/core');
    if (!isTauri()) return 'src-tauri/sidecars';
  } catch {
    return 'src-tauri/sidecars';
  }
  return await api.sidecarsDir();
}

// ── STT actions ─────────────────────────────────────────────────

export function sttModelReady(health: { ready?: boolean; model_loaded: boolean }): boolean {
  return Boolean(health.ready ?? health.model_loaded);
}

/** Start the Moonshine sidecar (lazy, first tap). */
export async function ensureStt(): Promise<boolean> {
  const s = get(settings);
  if (s.sttModel && s.sttModel.trim()) {
    const validation = validateModelForTask(s.sttModel.trim(), "stt");
    if (!validation.ok) {
      sttError.set(validation.error || "Invalid STT model");
      sttRunning.set(false);
      sttModelLoaded.set(false);
      return false;
    }
  }
  
  const ok = await ensureSidecar({
    kind: "Moonshine",
    isRunning: () => api.sttIsRunning(),
    start: async () => {
      await api.sttStart(await resolvePythonPathProbed(), await getSidecarsDir(), s.sttModel || undefined);
    },
    health: () => api.sttHealth(),
    modelReady: sttModelReady,
    unavailableMessage: (h) => h.error || STT_FETCH_HINT,
    setRunning: (v) => sttRunning.set(v),
    setLoaded: (v) => sttModelLoaded.set(v),
    setError: (e) => sttError.set(e),
    setProgress: (m) => sttStarting.set(m),
    setProbed: () => sttProbed.set(true),
  });
  if (ok) markUsed("stt");
  return ok;
}

/** Stop the Moonshine sidecar (e.g. when STT is toggled off). Best-effort. */
export async function stopStt(): Promise<void> {
  try {
    await api.sttStop();
    sttRunning.set(false);
    sttModelLoaded.set(false);
  } catch (error) {
    sttError.set(String(error));
    throw error;
  }
}

/** Transcribe a full audio blob (one-shot). */
export async function transcribeAudio(
  audioB64: string,
  format: string = 'wav'
): Promise<string | null> {
  sttTranscribing.set(true);
  sttError.set(null);
  markUsed("stt");
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

export function ttsModelReady(health: { ready?: boolean; model_loaded: boolean }): boolean {
  return Boolean(health.ready ?? health.model_loaded);
}

/** Start the Kokoro sidecar (lazy, first tap). */
export async function ensureTts(): Promise<boolean> {
  const s = get(settings);
  if (s.ttsModel && s.ttsModel.trim()) {
    const validation = validateModelForTask(s.ttsModel.trim(), "tts");
    if (!validation.ok) {
      ttsError.set(validation.error || "Invalid TTS model");
      ttsRunning.set(false);
      ttsModelLoaded.set(false);
      return false;
    }
  }
  
  const ok = await ensureSidecar({
    kind: "Kokoro",
    isRunning: () => api.ttsIsRunning(),
    start: async () => {
      await api.ttsStart(await resolvePythonPathProbed(), await getSidecarsDir(), s.ttsModel || undefined);
    },
    health: () => api.ttsHealth(),
    modelReady: ttsModelReady,
    unavailableMessage: (h) => h.error || TTS_FETCH_HINT,
    setRunning: (v) => ttsRunning.set(v),
    setLoaded: (v) => ttsModelLoaded.set(v),
    setError: (e) => ttsError.set(e),
    setProgress: (m) => ttsStarting.set(m),
    setProbed: () => ttsProbed.set(true),
  });
  if (ok) markUsed("tts");
  return ok;
}

/** Synthesize text → returns base64 WAV audio. Uses settings for all params. */
export async function synthesizeText(
  text: string,
  overrides?: { voice?: string; speed?: number; langCode?: string; splitPattern?: string; chunkSize?: number }
): Promise<{ audio: string; sampleRate: number } | null> {
  ttsError.set(null);
  markUsed("tts");
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
    ttsRunning.set(false);
    ttsModelLoaded.set(false);
  } catch (error) {
    ttsError.set(String(error));
    throw error;
  }
}

// ── LLM actions ─────────────────────────────────────────────────

export function llmModelReady(health: { status: string }): boolean {
  return health.status.toLowerCase() === "ok";
}

/** Start the llama.cpp server sidecar (lazy, first ghost autocomplete). */
export async function ensureLlm(): Promise<boolean> {
  const s = get(settings);
  
  // Validate quantization setting
  const quant = (s.smallModelQuantization || "q4_k_m") as LlmQuantization;
  const meta = getLlmMetadata(quant);
  if (!meta) {
    llmError.set(`Unknown quantization: ${quant}. Valid: q4_k_m, q5_k_m, q8_0, q2_k, q3_k_m, q6_k`);
    llmRunning.set(false);
    llmModelLoaded.set(false);
    return false;
  }
  
  // Validate model file matches quantization (if user provided explicit model)
  if (s.llmModel && s.llmModel.trim()) {
    const validation = validateModelForTask(s.llmModel.trim(), "llm");
    if (!validation.ok) {
      llmError.set(validation.error || "Invalid LLM model");
      llmRunning.set(false);
      llmModelLoaded.set(false);
      return false;
    }
  }
  
  const ok = await ensureSidecar({
    kind: "llama",
    isRunning: () => api.llmIsRunning(),
    start: async () => {
      await api.llmStart(
        await getSidecarsDir(),
        s.llmModel || undefined,
        s.smallModelContextLength || undefined,
        s.smallModelQuantization || undefined,
      );
    },
    health: () => api.llmHealth(),
    modelReady: llmModelReady,
    unavailableMessage: (h) => h.error || "The bundled LLM server is not ready.",
    setRunning: (v) => llmRunning.set(v),
    setLoaded: (v) => llmModelLoaded.set(v),
    setError: (e) => llmError.set(e),
    setProgress: (m) => llmStarting.set(m),
    setProbed: () => llmProbed.set(true),
  });
  if (ok) markUsed("llm");
  return ok;
}

/**
 * True when `endpoint` is the bundled LLM's sentinel address — the one Rust
 * routes over its private AF_UNIX socket instead of HTTP. Mirrors
 * `is_local_llm_sentinel` in commands.rs (which also tolerates a trailing
 * slash). The default small slot IS this address, which is why a default
 * small-slot request can reach a sidecar nobody started.
 */
export function isLocalLlmSentinel(endpoint: string | null | undefined): boolean {
  const trimmed = (endpoint ?? "").trim().replace(/\/+$/, "");
  return trimmed === "http://127.0.0.1:8093/v1" || trimmed === "http://localhost:8093/v1";
}

/**
 * Guard for any request Rust will route to the bundled LLM's socket: that
 * socket only has a listener once the sidecar is up, so connecting cold fails
 * with a raw `os error 10061` the writer can't act on.
 *
 * Returns false only when the local server needed to be up and could not be
 * brought up — callers report that instead of firing the request. Remote
 * providers and browser preview return true: there is no local socket to
 * ensure there (preview keeps its own backend path untouched).
 */
export async function ensureLlmFor(endpoint: string | null | undefined): Promise<boolean> {
  if (!isLocalLlmSentinel(endpoint)) return true;
  if (isBrowserPreview()) return true;
  return ensureLlm();
}

/** Stop the llama.cpp server sidecar (e.g. when LLM is toggled off). Best-effort. */
export async function stopLlm(): Promise<void> {
  try {
    await api.llmStop();
    llmRunning.set(false);
    llmModelLoaded.set(false);
    llmError.set(null);
  } catch (error) {
    llmError.set(String(error));
    throw error;
  }
}

// ── Warm-on-intent (slice 4B) ───────────────────────────────────
// Hovering a voice control is a strong signal the user is about to use
// it — pre-warm the matching sidecar so the first tap is instant. No
// boot pre-warm (cold boot stays silent); 120ms dwell lives at the
// call site so a brush-past never spawns a process. Every warm is
// best-effort: errors and progress are swallowed (the real tap will
// surface them via ensure*).

export async function warmStt(): Promise<void> {
  try {
    await ensureStt();
  } catch {
    /* warm is best-effort */
  }
}

/** Warm Kokoro, then silent first-synthesis: the ONNX voice model loads
 * lazily on the first synthesize, so ensureTts alone still leaves the
 * first real read-aloud slow. Synthesize one period and drop the audio. */
export async function warmTts(): Promise<void> {
  try {
    if (!(await ensureTts())) return;
    const s = get(settings);
    await api.ttsSynthesize(".", s.ttsVoice, s.ttsSpeed, s.ttsLangCode, s.ttsSplitPattern, s.ttsChunkSize);
  } catch {
    /* warm is best-effort */
  }
}

export async function warmLlm(): Promise<void> {
  try {
    await ensureLlm();
  } catch {
    /* warm is best-effort */
  }
}

// ── Idle offload (slice 4D) ───────────────────────────────────────
// Keep models warm after use; offload after idle period per modelRetention:
//   idle-5min (default): offload 5 min after last use
//   session:             offload 30 min after last use
//   always:              never idle-offload (until user toggles the feature off)

const lastUsedAt = new Map<string, number>();
let idleCheckTimer: ReturnType<typeof setInterval> | null = null;

const IDLE_TIMEOUTS: Record<string, number> = {
  "idle-5min": 5 * 60_000,
  session: 30 * 60_000,
  // "always" has no entry → checkIdleOffload returns early
};

function idleTimeoutMs(): number | null {
  const retention = get(settings).modelRetention || "idle-5min";
  return IDLE_TIMEOUTS[retention] ?? null;
}

function markUsed(kind: string): void {
  lastUsedAt.set(kind, Date.now());
  ensureIdleWatcher();
}

function ensureIdleWatcher(): void {
  if (idleCheckTimer) return;
  idleCheckTimer = setInterval(checkIdleOffload, 30_000);
}

function checkIdleOffload(): void {
  const timeout = idleTimeoutMs();
  if (timeout === null) return; // "always" → never idle-offload
  const now = Date.now();

  // STT — skip while recording or transcribing
  if (get(sttRunning) && !get(sttRecording) && !get(sttTranscribing)) {
    const last = lastUsedAt.get("stt");
    if (last !== undefined && now - last > timeout) {
      void stopStt().catch(() => {});
      lastUsedAt.delete("stt");
      showToast("Moonshine voice model unloaded to save RAM.", "info");
    }
  }
  // TTS — skip while playing
  if (get(ttsRunning) && !get(ttsPlaying)) {
    const last = lastUsedAt.get("tts");
    if (last !== undefined && now - last > timeout) {
      void stopTts().catch(() => {});
      lastUsedAt.delete("tts");
      showToast("Kokoro voice model unloaded to save RAM.", "info");
    }
  }
  // LLM
  if (get(llmRunning)) {
    const last = lastUsedAt.get("llm");
    if (last !== undefined && now - last > timeout) {
      void stopLlm().catch(() => {});
      lastUsedAt.delete("llm");
      showToast("Bundled LLM unloaded to save RAM.", "info");
    }
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
  // A paused (suspended) context would silently swallow the NEXT play —
  // always resume before clearing so stop-from-pause leaves audio usable.
  void _audioCtx?.resume().catch(() => {});
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

/** Pause/resume the live WAV playback via AudioContext suspend. The
 * pending playWavBase64 promise stays alive (onended fires after resume),
 * so a paused read-aloud keeps its place in the chunk sequence. */
export function pauseWavPlayback(): void {
  void _audioCtx?.suspend().catch(() => {});
}
export function resumeWavPlayback(): void {
  void _audioCtx?.resume().catch(() => {});
}

/** Play base64 WAV audio. Resolves when done — or on stop (never hangs). */
export function playWavBase64(b64: string): Promise<void> {
  stopWavPlayback();
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
