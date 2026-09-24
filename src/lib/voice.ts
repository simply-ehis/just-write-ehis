/**
 * voice — browser speech for web capture and read-aloud surfaces.
 *
 * The desktop app keeps using its local Moonshine/Kokoro sidecars. The web
 * build has no sidecars, so it uses the browser's built-in speech
 * recognition and synthesis instead. Both paths are feature-detected.
 */

export function voiceSupported(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as Record<string, unknown>;
  return typeof w.SpeechRecognition === "function" || typeof w.webkitSpeechRecognition === "function";
}

export interface VoiceHandle {
  stop: () => void;
}

interface SpeechResultLike {
  isFinal: boolean;
  [index: number]: { transcript: string };
}

interface SpeechEventLike {
  resultIndex: number;
  results: SpeechResultLike[];
}

export type VoiceErrorKind = "not-allowed" | "no-speech" | "network" | "aborted" | "unknown";

/** One-line human reason per Web Speech error kind (never silent). */
export function voiceErrorReason(kind: string): string {
  switch (kind) {
    case "not-allowed":
    case "service-not-allowed":
      return "Microphone blocked — allow mic access in the browser/site settings.";
    case "no-speech":
      return "No speech heard — try again, closer to the mic.";
    case "network":
      return "Speech service unreachable — check the network connection.";
    case "aborted":
      return "Dictation stopped.";
    default:
      return `Dictation stopped (${kind || "unknown error"}).`;
  }
}

/**
 * Start dictation. `onUpdate(fullText, isFinal)` fires as results stream;
 * callers typically write interim text into the box and commit on final.
 * `onError(reason)` fires once per recognition error with a one-line
 * human reason (not-allowed vs no-speech vs network).
 * Returns a handle whose `stop()` ends the session (also auto-ends on
 * `onend`). Throws if unsupported — check `voiceSupported()` first.
 */
export function startDictation(
  onUpdate: (text: string, isFinal: boolean) => void,
  onError?: (reason: string, kind: VoiceErrorKind) => void,
): VoiceHandle {
  const w = window as unknown as Record<string, new () => {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((e: SpeechEventLike) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  }>;
  const Ctor = (w.SpeechRecognition ?? w.webkitSpeechRecognition) as unknown as new () => {
    continuous: boolean;
    interimResults: boolean;
    lang: string;
    onresult: ((e: SpeechEventLike) => void) | null;
    onerror: ((e: { error: string }) => void) | null;
    onend: (() => void) | null;
    start: () => void;
    stop: () => void;
  };
  if (typeof Ctor !== "function") throw new Error("Voice input not supported in this browser.");
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = true;
  try {
    rec.lang = navigator.language || "en-US";
  } catch {
    rec.lang = "en-US";
  }
  let stopped = false;
  rec.onresult = (e: SpeechEventLike) => {
    let interim = "";
    let finals = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      const text = r[0]?.transcript ?? "";
      if (r.isFinal) finals += text;
      else interim += text;
    }
    // Interim replaces the in-flight tail; finals commit.
    if (finals) onUpdate(finals, true);
    else if (interim) onUpdate(interim, false);
  };
  rec.onerror = (e: { error: string }) => {
    const kind = (e?.error || "unknown") as VoiceErrorKind;
    onError?.(voiceErrorReason(kind), kind);
    try {
      rec.stop();
    } catch {
      /* already stopped */
    }
  };
  rec.onend = () => {
    stopped = true;
  };
  rec.start();
  return {
    stop: () => {
      if (!stopped) {
        try {
          rec.stop();
        } catch {
          /* already stopped */
        }
      }
    },
  };
}

/** Settings language codes mapped to browser speech locales. */
const TTS_LANG_LOCALES: Record<string, string> = {
  a: "en-US",
  b: "en-GB",
  j: "ja-JP",
  z: "zh-CN",
  e: "es-ES",
  f: "fr-FR",
  h: "hi-IN",
  i: "it-IT",
  p: "pt-PT",
};

/** Browser locale for read-aloud, falling back to the browser language. */
export function browserTtsLocale(langCode?: string): string {
  if (langCode && TTS_LANG_LOCALES[langCode]) return TTS_LANG_LOCALES[langCode];
  try {
    return navigator.language || "en-US";
  } catch {
    return "en-US";
  }
}

/** True when the browser exposes built-in speech synthesis. */
export function ttsSupported(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.speechSynthesis) && typeof SpeechSynthesisUtterance !== "undefined";
}

export interface BrowserSpeechOptions {
  langCode?: string;
  rate?: number;
}

function clampSpeechRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(2, Math.max(0.5, rate));
}

/**
 * Speak text with the browser's built-in voice. Empty text resolves
 * immediately; unsupported browsers reject with a human-readable error.
 */
export function speakBrowserText(text: string, options: BrowserSpeechOptions = {}): Promise<void> {
  const cleaned = text.trim();
  if (!cleaned) return Promise.resolve();
  if (!ttsSupported()) {
    return Promise.reject(new Error("Read-aloud is not supported in this browser."));
  }
  return new Promise((resolve, reject) => {
    const utterance = new SpeechSynthesisUtterance(cleaned);
    utterance.lang = browserTtsLocale(options.langCode);
    utterance.rate = clampSpeechRate(options.rate ?? 1);
    utterance.onend = () => resolve();
    utterance.onerror = (event) => {
      reject(new Error(`Browser speech failed (${event?.error || "unknown error"}).`));
    };
    // One utterance at a time: a fresh call replaces any live speech.
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(utterance);
  });
}

/** Stop browser read-aloud. Safe to call when nothing is speaking. */
export function stopBrowserSpeech(): void {
  try {
    window.speechSynthesis?.cancel();
  } catch {
    /* already stopped */
  }
}
