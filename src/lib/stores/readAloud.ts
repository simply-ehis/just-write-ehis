/**
 * readAloud — render-ahead orchestration state.
 *
 * The Rust renderer owns PCM production; `tts/player.ts` owns the audio
 * clock; this store owns the app-level pieces they share: UI phase,
 * playhead progress, the transport counters, the pause policy, and the
 * per-job event subscriptions (page/done/error) with renderId filtering
 * so a stale job can never drive the live read.
 */
import { writable } from "svelte/store";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import {
  api,
  type TtsRenderPageEvent,
  type TtsRenderParams,
  type TtsRenderSegment,
} from "$lib/api";

export type ReadAloudPhase = "idle" | "starting" | "waiting" | "playing" | "paused";

/** Pill/spinner phase. */
export const readAloudPhase = writable<ReadAloudPhase>("idle");
/** Underrun hold: renderer behind playback ("catching up…"). */
export const readAloudUnderrun = writable(false);
/** 0..1 across the whole read — derived from the audio clock's segment. */
export const readAloudProgress = writable(0);
/** Transport position over the GLOBAL segment list (restart-safe). */
export const readAloudTransport = writable<{ index: number; total: number } | null>(null);

/**
 * Backend-inserted silence per boundary class (plan §2.4: these are
 * rendered into the PCM, so they apply from the render frontier).
 */
export const PAUSE_MS: Record<"sentence" | "paragraph" | "section", number> = {
  sentence: 220,
  paragraph: 480,
  section: 600,
};

export interface RenderHandlers {
  onPage: (page: TtsRenderPageEvent, pcm: Int16Array) => void;
  onDone: (totalSamples: number, completed: boolean) => void;
  onError: (message: string) => void;
}

/**
 * Subscribe to one render job's events. Payloads carrying a different
 * renderId are ignored — after a restart, the old job's late events can
 * never touch the new read. Resolves with a single unlisten for all.
 */
export async function subscribeRender(
  renderId: number,
  handlers: RenderHandlers,
): Promise<UnlistenFn> {
  const unlisteners = await Promise.all([
    listen<TtsRenderPageEvent>("tts://render-page", (ev) => {
      if (ev.payload.renderId !== renderId) return;
      void api
        .ttsRenderPage(renderId, ev.payload.pageIdx)
        .then((buf) => handlers.onPage(ev.payload, new Int16Array(buf)))
        .catch((e) => handlers.onError(String(e)));
    }),
    listen<{ renderId: number; totalSamples: number; completed: boolean }>(
      "tts://render-done",
      (ev) => {
        if (ev.payload.renderId !== renderId) return;
        handlers.onDone(ev.payload.totalSamples, ev.payload.completed);
      },
    ),
    listen<{ renderId: number; message: string }>("tts://render-error", (ev) => {
      if (ev.payload.renderId !== renderId) return;
      handlers.onError(ev.payload.message);
    }),
  ]);
  return () => {
    for (const unlisten of unlisteners) unlisten();
  };
}

/** Map segmented text to the backend contract (pauses + boundaries). */
export function toRenderSegments(
  segments: { id: number; text: string; pauseAfter: "sentence" | "paragraph" | "section" }[],
): TtsRenderSegment[] {
  return segments.map((s) => ({
    id: s.id,
    text: s.text,
    pauseAfterMs: PAUSE_MS[s.pauseAfter],
    boundary: s.pauseAfter,
  }));
}

/** Start one render job. The voice model must already be ensured. */
export function startRender(
  segments: TtsRenderSegment[],
  params: TtsRenderParams,
): Promise<number> {
  return api.ttsRenderStart(segments, params);
}

/** Cancel a job; idempotent (stop paths can race freely). */
export async function cancelRender(renderId: number | null): Promise<void> {
  if (renderId == null) return;
  try {
    await api.ttsRenderCancel(renderId);
  } catch {
    /* job already gone */
  }
}

/** Reset every store to idle (stop, end, teardown). */
export function resetReadAloud(): void {
  readAloudPhase.set("idle");
  readAloudUnderrun.set(false);
  readAloudProgress.set(0);
  readAloudTransport.set(null);
}
