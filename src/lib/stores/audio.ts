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
  const running = await api.sttIsRunning();
  if (running) {
    sttRunning.set(true);
    return true;
  }
  try {
    await api.sttStart(getPythonPath(), await getSidecarsDir(), get(settings).sttModel || undefined);
    sttRunning.set(true);
    // Wait briefly then check health
    await new Promise((r) => setTimeout(r, 500));
    const health = await api.sttHealth();
    sttModelLoaded.set(health.model_loaded);
    return true;
  } catch (e) {
    sttError.set(String(e));
    sttRunning.set(false);
    return false;
  }
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
  const running = await api.ttsIsRunning();
  if (running) {
    ttsRunning.set(true);
    return true;
  }
  try {
    await api.ttsStart(getPythonPath(), await getSidecarsDir(), get(settings).ttsModel || undefined);
    ttsRunning.set(true);
    await new Promise((r) => setTimeout(r, 500));
    const health = await api.ttsHealth();
    ttsModelLoaded.set(health.model_loaded);
    return true;
  } catch (e) {
    ttsError.set(String(e));
    ttsRunning.set(false);
    return false;
  }
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
      ttsError.set("No voice output — fetch the TTS bundle first (fetch_sidecars.py --tts).");
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
  const running = await api.llmIsRunning();
  if (running) {
    llmRunning.set(true);
    return true;
  }
  try {
    const s = get(settings);
    await api.llmStart(await getSidecarsDir(), s.llmModel || undefined, s.smallModelContextLength || undefined);
    llmRunning.set(true);
    await new Promise((r) => setTimeout(r, 1000));
    const health = await api.llmHealth();
    llmModelLoaded.set(!!health.model);
    return true;
  } catch (e) {
    llmRunning.set(false);
    llmModelLoaded.set(false);
    return false;
  }
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

/** Play base64 WAV audio. Returns a promise that resolves when done. */
export function playWavBase64(b64: string): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      const raw = atob(b64);
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);

      const ctx = getAudioContext();
      ctx.decodeAudioData(bytes.buffer, (buffer) => {
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.onended = () => resolve();
        source.start();
      }, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/* recordFromMic removed: the deprecated ScriptProcessor path was superseded
   by the MediaRecorder flow in MicButton.svelte (no callers remained). */
