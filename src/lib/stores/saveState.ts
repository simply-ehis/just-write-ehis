import { writable } from "svelte/store";

export type SavePhase = "idle" | "saving" | "saved" | "error";

export const saveState = writable<SavePhase>("idle");

/** Set while any in-flight save promise is unresolved. */
let inFlight = 0;
/** Monotonic id so a slow save cannot clear the phase of a newer one. */
let epoch = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const errors: unknown[] = [];

/**
 * Mark a save as started. Returns the epoch it belongs to; pass it back to
 * `saveSettled` so a slow save cannot clobber a newer one's phase.
 *
 * The phase is driven by the save PROMISE, not a timer. A previous version
 * flipped "saved" after a fixed 500ms, so the UI claimed "Saved" while the
 * write was still queued — and onDestroy discarded the queue, making the
 * claim a lie the user had no way to see through.
 */
export function recordSave(): number {
  epoch += 1;
  inFlight += 1;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  saveState.set("saving");
  return epoch;
}

/**
 * Mark a save as finished. `failed` flips the indicator to "error" and holds
 * it there long enough for the user to actually see it (no idle decay on the
 * error path: a failed save must not silently look clean again).
 */
export function saveSettled(savedEpoch: number, failed = false): void {
  if (savedEpoch !== epoch) return; // superseded by a newer save
  inFlight = Math.max(0, inFlight - 1);
  if (failed) {
    if (idleTimer) clearTimeout(idleTimer);
    saveState.set("error");
    return;
  }
  if (inFlight > 0) return; // more writes still outstanding
  saveState.set("saved");
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (inFlight === 0) saveState.set("idle");
  }, 2000);
}

/** Record a save failure. Separate from saveSettled so callers can report it. */
export function saveFailed(savedEpoch: number, err: unknown): void {
  if (errors.length < 20) errors.push(err);
  saveSettled(savedEpoch, true);
}

/** Errors seen this session, for diagnostics. */
export function saveErrors(): unknown[] {
  return errors.slice();
}

/** Reset to idle — used by tests and when switching to a doc with no edits. */
export function resetSaveState(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  inFlight = 0;
  epoch += 1;
  saveState.set("idle");
}