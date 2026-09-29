import { writable } from "svelte/store";

export type SavePhase = "idle" | "saving" | "saved";

export const saveState = writable<SavePhase>("idle");

let resetTimer: ReturnType<typeof setTimeout> | null = null;
let saveEpoch = 0;

export function recordSave() {
  // Epoch-guarded: burst saves restart the visible "saving" window instead
  // of stacking idle timers, and "saved" only lands for the latest call.
  // (The old microtask flipped saving→saved before a frame could paint.)
  saveEpoch += 1;
  const epoch = saveEpoch;
  if (resetTimer) clearTimeout(resetTimer);
  resetTimer = null;

  saveState.set("saving");

  setTimeout(() => {
    if (epoch !== saveEpoch) return;
    saveState.set("saved");
    resetTimer = setTimeout(() => {
      if (epoch !== saveEpoch) return;
      saveState.set("idle");
    }, 2000);
  }, 500);
}
