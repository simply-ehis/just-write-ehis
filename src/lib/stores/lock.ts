/**
 * lock — per-doc PIN lock (session-scoped unlocks).
 *
 * Locking is a casual-eyes gate plus a hard backend exclusion: locked docs
 * are filtered out of search, RAG, AI context, and Home stats server-side.
 * Unlocks live only in memory — a reload re-locks everything. (At-rest
 * secrecy is the encrypted Private Vault's job, not this flag's.)
 */
import { writable, get } from "svelte/store";
import { appLockConfigured, appLockPinStatus, settings, secretsReady } from "$lib/stores/settings";
import { APP_LOCK_MIN_PIN_LENGTH } from "$lib/settingsValidate";
import type { Doc } from "$lib/api";

export const unlockedDocs = writable<Set<string>>(new Set());

/**
 * Global app lock (session-scoped). Setting an App Lock PIN in
 * Settings → Privacy & Security gates the whole shell on next boot until
 * the PIN is verified — previously the PIN only gated per-doc locks, so a
 * set PIN with no locked docs never asked for anything (read as a hoax).
 * False = locked (gate shown); true = unlocked for this session only.
 */
export const appUnlocked = writable<boolean>(false);

export function markAppUnlocked(): void {
  appUnlocked.set(true);
}

export function lockAppNow(): void {
  appUnlocked.set(false);
}

async function requirePinStorage(): Promise<void> {
  await readySoon();
  if (get(appLockPinStatus) !== "ready") {
    throw new Error("PIN storage is unavailable. Restart the app and try again.");
  }
}

export async function configurePin(pin: string, confirmation: string): Promise<void> {
  const normalized = pin.trim();
  if (normalized !== (confirmation ?? "").trim()) {
    throw new Error("PINs do not match.");
  }
  if (normalized.length < MIN_PIN_LENGTH) {
    throw new Error(`PIN must be at least ${MIN_PIN_LENGTH} characters.`);
  }
  await requirePinStorage();
  const { api } = await import("$lib/api");
  await api.appLockReset();
  await api.secretSet("appLockPin", normalized);
  lockoutUntil = 0;
  appLockConfigured.set(true);
  settings.update((current) => ({ ...current, appLockPin: normalized, lockEnabled: true }));
  markAppUnlocked();
}

export async function removePin(): Promise<void> {
  await requirePinStorage();
  const { api } = await import("$lib/api");
  await api.appLockReset();
  await api.secretSet("appLockPin", "");
  lockoutUntil = 0;
  appLockConfigured.set(false);
  settings.update((current) => ({ ...current, appLockPin: "", lockEnabled: false }));
}

export async function resetPinConfiguration(): Promise<void> {
  const { api } = await import("$lib/api");
  try {
    await api.secretSet("appLockPin", "");
  } catch (error) {
    console.warn("PIN recovery could not clear the keychain entry:", error);
  }
  try {
    await api.appLockReset();
  } catch (error) {
    console.warn("PIN recovery could not reset the retry state:", error);
  } finally {
    lockoutUntil = 0;
    appLockConfigured.set(false);
    settings.update((current) => ({ ...current, appLockPin: "", lockEnabled: false }));
    appLockPinStatus.set("ready");
    markAppUnlocked();
  }
}

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
 * Never hang the UI on keychain access: after 5s callers must report that
 * storage is unavailable rather than treating an unknown PIN as absent.
 */
function readySoon(): Promise<void> {
  return Promise.race([
    secretsReady,
    new Promise<void>((resolve) => setTimeout(resolve, 5000)),
  ]);
}

export const MIN_PIN_LENGTH = APP_LOCK_MIN_PIN_LENGTH;
let lockoutUntil = 0;

/** Session-scoped backoff: 0 when the PIN may be attempted now. */
export function pinLockoutRemaining(now: number = Date.now()): number {
  return Math.max(0, lockoutUntil - now);
}

export async function hasPin(): Promise<boolean> {
  await requirePinStorage();
  if (get(settings).appLockPin.trim().length >= MIN_PIN_LENGTH) return true;
  const { api } = await import("$lib/api");
  return api.appLockConfigured();
}

export async function verifyPin(pin: string): Promise<boolean> {
  await requirePinStorage();
  const { api } = await import("$lib/api");
  const result = await api.appLockVerify(pin);
  if (result.verified) {
    lockoutUntil = 0;
    return true;
  }
  if (result.retry_after_ms > 0) {
    lockoutUntil = Math.max(lockoutUntil, Date.now() + result.retry_after_ms);
  }
  return false;
}

/** Locked docs never reach any model — not even the current one.
 * No-op while the Document Locking switch is off in Settings. */
export function assertAiAllowedForDoc(doc: Doc | null | undefined): void {
  if (!get(settings).lockEnabled) return;
  if (doc?.locked && !isUnlocked(doc.id)) {
    throw new Error(`"${doc.title}" is locked and excluded from AI. Unlock it first.`);
  }
}
