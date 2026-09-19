/**
 * Conflict state — tracks when an external file change is detected
 * while there are unsaved local edits. Shows a docked banner per A9.5.
 */
import { writable } from 'svelte/store';

export interface FileConflict {
  docId: string;
  path: string;
  timestamp: string;
}

export const activeConflict = writable<FileConflict | null>(null);

/** Show conflict banner. */
export function showConflict(docId: string, path: string, timestamp: string) {
  activeConflict.set({ docId, path, timestamp });
}

/** Dismiss conflict banner. */
export function dismissConflict() {
  activeConflict.set(null);
}
