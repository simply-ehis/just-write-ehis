import { writable } from "svelte/store";

export type SavePhase = "idle" | "saving" | "saved";

export const saveState = writable<SavePhase>("idle");

let resetTimer: ReturnType<typeof setTimeout> | null = null;

export function recordSave() {
  if (resetTimer) clearTimeout(resetTimer);

  saveState.set("saving");

  queueMicrotask(() => {
    saveState.set("saved");

    resetTimer = setTimeout(() => {
      saveState.set("idle");
    }, 2000);
  });
}
