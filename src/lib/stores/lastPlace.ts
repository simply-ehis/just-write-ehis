/**
 * lastPlace — per-workspace "where was I" memory.
 *
 * Remembers the open doc per workspace so bouncing between workspaces
 * doesn't lose anyone's place. Workspaces with their own deterministic
 * landing (Logs → today per spec §8.1, Map → viewport, Home) are excluded.
 */
import { writable, get } from "svelte/store";

const KEY = "jwe-last-place-v1";

/** Workspaces that restore their last open doc on visit. */
export const RESTORED_WORKSPACES = ["write", "novel", "script", "projects", "reader"];

function load(): Record<string, string> {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as Record<string, string>;
  } catch {
    /* corrupted storage reads as empty */
  }
  return {};
}

const store = writable<Record<string, string>>(load());

store.subscribe((m) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {
    /* quota exceeded: memory-only for this session */
  }
});

export function rememberPlace(workspace: string, docId: string): void {
  if (!RESTORED_WORKSPACES.includes(workspace)) return;
  store.update((m) => ({ ...m, [workspace]: docId }));
}

export function forgetPlace(workspace: string, docId: string): void {
  store.update((m) => {
    if (m[workspace] !== docId) return m;
    const next = { ...m };
    delete next[workspace];
    return next;
  });
}

export function placeFor(workspace: string): string | null {
  if (!RESTORED_WORKSPACES.includes(workspace)) return null;
  return get(store)[workspace] ?? null;
}
