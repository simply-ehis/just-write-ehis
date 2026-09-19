/**
 * ghost — shared inline-autocomplete request logic.
 * Used by every editing surface so Ghost behaves identically everywhere.
 * Gating (enabled flag, lock, workspace privacy) stays with the caller.
 */
import { api } from "$lib/api";

export interface GhostConfig {
  workspace?: string;
  provider?: string;
  model?: string;
  maxTokens?: number;
  apiKey?: string;
}

/** Last substantial sentence of the recent text, or "" when unusable. */
export function lastSentenceOf(content: string): string {
  const recentText = content.slice(-500);
  const sentences = recentText.split(/[.!?]+/).filter(Boolean);
  const last = sentences[sentences.length - 1]?.trim() || "";
  return last.length >= 10 ? last : "";
}

/** Continuation text or null. Never throws — callers treat null as "stay silent". */
export async function requestGhostContinuation(
  lastSentence: string,
  config: GhostConfig = {}
): Promise<string | null> {
  try {
    const response = await api.aiGenerate({
      prompt: `Continue this text naturally. Do not repeat what came before. Write only the continuation, no quotes or explanation:\n\n${lastSentence}`,
      system_prompt:
        "You are a writing ghost assistant. Continue the user's text naturally and concisely. Output only the continuation text, nothing else.",
      mode: "ghost",
      workspace: config.workspace,
      provider: config.provider,
      model: config.model,
      max_tokens: config.maxTokens ?? 100,
      api_key: config.apiKey,
    });
    const text = response.content.trim();
    return text || null;
  } catch (e) {
    console.warn("Ghost suggestion failed:", e);
    return null;
  }
}
