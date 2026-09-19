/**
 * lock — per-doc PIN lock (session-scoped unlocks).
 *
 * Locking is a casual-eyes gate plus a hard backend exclusion: locked docs
 * are filtered out of search, RAG, AI context, and Home stats server-side.
 * Unlocks live only in memory — a reload re-locks everything. (At-rest
 * secrecy is the encrypted Private Vault's job, not this flag's.)
 */
import { writable, get } from "svelte/store";
import { settings } from "$lib/stores/settings";
import type { Doc } from "$lib/api";

export const unlockedDocs = writable<Set<string>>(new Set());

export function isUnlocked(id: string): boolean {
  return get(unlockedDocs).has(id);
}

export function markUnlocked(id: string): void {
  unlockedDocs.update((s) => new Set(s).add(id));
}

export function markLocked(id: string): void {
  unlockedDocs.update((s) => {
    const next = new Set(s);
    next.delete(id);
    return next;
  });
}

export function hasPin(): boolean {
  return get(settings).appLockPin.trim().length > 0;
}

export function verifyPin(pin: string): boolean {
  const expected = get(settings).appLockPin;
  return expected.trim().length > 0 && pin === expected;
}

/** Locked docs never reach any model — not even the current one. */
export function assertAiAllowedForDoc(doc: Doc | null | undefined): void {
  if (doc?.locked && !isUnlocked(doc.id)) {
    throw new Error(`"${doc.title}" is locked and excluded from AI. Unlock it first.`);
  }
}
