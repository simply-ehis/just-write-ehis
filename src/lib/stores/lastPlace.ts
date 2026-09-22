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

// ── Global back navigation ──────────────────────────────────────
// Linear history of {workspace, doc} visits. App pushes on every
// user-driven navigation; the breadcrumb Back button pops. Going back
// sets `suppressPush` so the return trip isn't re-recorded.

export interface NavEntry {
  workspace: string;
  docId: string | null;
}

export const navControl = { suppressPush: false };

const backStack: NavEntry[] = [];
export const navDepth = writable(0);

export function pushNavHistory(entry: NavEntry): void {
  if (navControl.suppressPush) return;
  const top = backStack[backStack.length - 1];
  if (top && top.workspace === entry.workspace && top.docId === entry.docId) return;
  backStack.push(entry);
  if (backStack.length > 50) backStack.shift();
  navDepth.set(backStack.length);
}

export function popNavHistory(): NavEntry | null {
  const entry = backStack.pop() ?? null;
  navDepth.set(backStack.length);
  return entry;
}

export function clearNavHistory(): void {
  backStack.length = 0;
  navDepth.set(0);
}
