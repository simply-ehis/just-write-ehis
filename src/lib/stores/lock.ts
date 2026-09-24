/**
 * lock — per-doc PIN lock (session-scoped unlocks).
 *
 * Locking is a casual-eyes gate plus a hard backend exclusion: locked docs
 * are filtered out of search, RAG, AI context, and Home stats server-side.
 * Unlocks live only in memory — a reload re-locks everything. (At-rest
 * secrecy is the encrypted Private Vault's job, not this flag's.)
 */
import { writable, get } from "svelte/store";
import { settings, secretsReady } from "$lib/stores/settings";
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

/**
 * Never hang the UI on the keychain: after 5s proceed with whatever is
 * in memory. Fails closed — an unhydrated PIN reads as "no PIN".
 */
function readySoon(): Promise<void> {
  return Promise.race([
    secretsReady,
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

export const MIN_PIN_LENGTH = 4;
const MAX_FAILED_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 2000;
const MAX_BACKOFF_MS = 60000;

let failedAttempts = 0;
let lockoutUntil = 0;

/** Session-scoped backoff: 0 when the PIN may be attempted now. */
export function pinLockoutRemaining(now: number = Date.now()): number {
  return Math.max(0, lockoutUntil - now);
}

export async function hasPin(): Promise<boolean> {
  await readySoon();
  return get(settings).appLockPin.trim().length >= MIN_PIN_LENGTH;
}

export async function verifyPin(pin: string): Promise<boolean> {
  await readySoon();
  if (pinLockoutRemaining() > 0) return false;
  const expected = get(settings).appLockPin.trim();
  const ok = expected.length >= MIN_PIN_LENGTH && pin.trim() === expected;
  if (ok) {
    failedAttempts = 0;
    lockoutUntil = 0;
  } else {
    failedAttempts++;
    if (failedAttempts >= MAX_FAILED_ATTEMPTS) {
      const over = failedAttempts - MAX_FAILED_ATTEMPTS;
      lockoutUntil = Date.now() + Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** over);
    }
  }
  return ok;
}

/** Locked docs never reach any model — not even the current one.
 * No-op while the Document Locking switch is off in Settings. */
export function assertAiAllowedForDoc(doc: Doc | null | undefined): void {
  if (!get(settings).lockEnabled) return;
  if (doc?.locked && !isUnlocked(doc.id)) {
    throw new Error(`"${doc.title}" is locked and excluded from AI. Unlock it first.`);
  }
}
