/**
 * voice — Web Speech API dictation for capture surfaces.
 *
 * The STT sidecar (MicButton) needs the desktop app beside it; on a phone
 * PWA there is no sidecar, so capture falls back to the platform speech
 * recognizer (on-device on Android Chrome / Samsung Internet / Edge).
 * Feature-detected: `voiceSupported()` is false on desktop Firefox etc.,
 * and those surfaces simply don't render the mic button.
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
