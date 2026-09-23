/**
 * ghost — shared inline-autocomplete request logic.
 * Used by every editing surface so Ghost behaves identically everywhere.
 * Gating (enabled flag, lock, workspace privacy) stays with the caller.
 *
 * ROUTING (canonical — enforced here, not at call sites):
 *   ghost → local llama-server (:8093) when settings.llmEnabled,
 *   else → the SMALL slot (smallModelEndpoint/smallModelName, no API key).
 * Ghost NEVER touches the main slot: callers pass no provider config at
 * all (there is no config parameter), so main-slot values cannot leak in.
 */
import { api } from "$lib/api";
import { ensureLlm } from "$lib/stores/audio";
import { settings } from "$lib/stores/settings";
import { get, writable } from "svelte/store";

export type GhostState = "idle" | "ok" | "unavailable";

export interface GhostStatus {
  state: GhostState;
  /** Round-trip ms of the last attempt, or null when none ran yet. */
  latencyMs: number | null;
  /** When the last attempt finished (epoch ms), or null. */
  at: number | null;
  /** Human-readable failure reason when unavailable, else "". */
  detail: string;
}

const initialStatus: GhostStatus = { state: "idle", latencyMs: null, at: null, detail: "" };

/**
 * Last-suggestion status. Surfaces ghost health in the AI panel's Ghost
 * tab instead of warn→null silence. Never throws; read-only for callers.
 */
export const ghostStatus = writable<GhostStatus>({ ...initialStatus });

function recordStatus(patch: Partial<GhostStatus>): void {
  ghostStatus.update((s) => ({ ...s, ...patch, at: Date.now() }));
}

/** Last substantial sentence of the recent text, or "" when unusable. */
export function lastSentenceOf(content: string): string {
  const recentText = content.slice(-500);
  const sentences = recentText.split(/[.!?]+/).filter(Boolean);
  const last = sentences[sentences.length - 1]?.trim() || "";
  return last.length >= 10 ? last : "";
}

/**
 * Continuation text or null. Never throws — callers treat null as "stay silent".
 * `workspace` is privacy metadata only (backend gating); provider routing is
 * fixed above and cannot be overridden per call.
 */
export async function requestGhostContinuation(
  lastSentence: string,
  workspace?: string
): Promise<string | null> {
  const t0 = Date.now();
  try {
    // Local model first when enabled (fastest, private, no key).
    if (get(settings).llmEnabled) {
      const ok = await ensureLlm();
      if (ok) {
        const text = await api.llmCompletion(
          `Continue this text naturally. Do not repeat what came before. Write only the continuation, no quotes or explanation:\n\n${lastSentence}`,
          100,
          0.7
        );
        const out = text.trim() || null;
        recordStatus({
          state: out ? "ok" : "unavailable",
          latencyMs: Date.now() - t0,
          detail: out ? "" : "Local model returned empty.",
        });
        return out;
      }
      // Fall through to the small slot when the local LLM fails.
    }

    const s = get(settings);
    const response = await api.aiGenerate({
      prompt: `Continue this text naturally. Do not repeat what came before. Write only the continuation, no quotes or explanation:\n\n${lastSentence}`,
      system_prompt:
        "You are a writing ghost assistant. Continue the user's text naturally and concisely. Output only the continuation text, nothing else.",
      mode: "ghost",
      workspace,
      provider: s.smallModelEndpoint || undefined,
      model: s.smallModelName || undefined,
    });
    const text = response.content.trim();
    const out = text || null;
    recordStatus({
      state: out ? "ok" : "unavailable",
      latencyMs: Date.now() - t0,
      detail: out ? "" : "Small slot returned empty.",
    });
    return out;
  } catch (e) {
    recordStatus({
      state: "unavailable",
      latencyMs: Date.now() - t0,
      detail: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}
