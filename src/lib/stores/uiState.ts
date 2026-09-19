/**
 * uiState — device-local UI state that needs no backend.
 *
 * Sidebar order, workspace links, the cross-tab clipboard, and smart
 * tasks are presentation state, not vault data: localStorage is the
 * correct store, and it works identically in the browser preview and
 * the Tauri webview. Nothing here ever touches the network.
 */
import { writable, derived, get } from "svelte/store";
import { api, type Doc } from "$lib/api";
import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* corrupted storage reads as empty */
  }
  return fallback;
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded: keep running in memory */
  }
}

export interface SmartTask {
  id: string;
  title: string;
  workspace: string;
  docId: string;
  completed: boolean;
  createdAt: string;
}

// ── Sidebar order + auto-sort ─────────────────────────────────────
const SIDEBAR_ORDER_KEY = "jwe-sidebar-order-v1";
const SIDEBAR_AUTOSORT_KEY = "jwe-sidebar-autosort-v1";

export const sidebarOrder = writable<string[]>(load<string[]>(SIDEBAR_ORDER_KEY, []));
export const sidebarAutoSort = writable<boolean>(load<boolean>(SIDEBAR_AUTOSORT_KEY, true));

sidebarOrder.subscribe((v) => save(SIDEBAR_ORDER_KEY, v));
sidebarAutoSort.subscribe((v) => save(SIDEBAR_AUTOSORT_KEY, v));

/** Last-visit timestamps per workspace: the auto-sort signal. */
const WS_VISIT_KEY = "jwe-workspace-visit-v1";

export const lastWorkspaceVisit = writable<Record<string, number>>(
  load<Record<string, number>>(WS_VISIT_KEY, {})
);

lastWorkspaceVisit.subscribe((v) => save(WS_VISIT_KEY, v));

export function recordWorkspaceVisit(id: string): void {
  lastWorkspaceVisit.update((visits) => ({ ...visits, [id]: Date.now() }));
}

/** Manual drag-reorder: persists the new order and disables auto-sort. */
export function reorderSidebar(order: string[]): void {
  sidebarOrder.set(order);
  sidebarAutoSort.set(false);
}

// ── Workspace links ───────────────────────────────────────────────
const WS_LINKS_KEY = "jwe-workspace-links-v1";

export const workspaceLinks = writable<Record<string, string[]>>(
  load<Record<string, string[]>>(WS_LINKS_KEY, {})
);

workspaceLinks.subscribe((v) => save(WS_LINKS_KEY, v));

export function toggleWorkspaceLink(a: string, b: string): void {
  workspaceLinks.update((links) => {
    const next: Record<string, string[]> = { ...links };
    const la = new Set(next[a] ?? []);
    if (la.has(b)) {
      la.delete(b);
      next[a] = [...la];
      next[b] = (next[b] ?? []).filter((w) => w !== a);
    } else {
      la.add(b);
      next[a] = [...la];
      next[b] = [...new Set([...(next[b] ?? []), a])];
    }
    return next;
  });
}

// ── Cross-tab clipboard ───────────────────────────────────────────
const SHARED_KEY = "jwe-cross-tab-shared-v1";

export interface SharedItem {
  content: string;
  sourceWorkspace: string;
  timestamp: string;
}

export const sharedClipboard = writable<Record<string, SharedItem[]>>(
  load<Record<string, SharedItem[]>>(SHARED_KEY, {})
);

sharedClipboard.subscribe((v) => save(SHARED_KEY, v));

/** Stage the current selection/doc text for one or more workspaces. */
export function shareToWorkspaces(content: string, sourceWorkspace: string, targets: string[]): void {
  if (!content.trim() || targets.length === 0) return;
  sharedClipboard.update((shared) => {
    const next = { ...shared };
    for (const ws of targets) {
      next[ws] = [...(next[ws] ?? []), { content, sourceWorkspace, timestamp: new Date().toISOString() }];
    }
    return next;
  });
}

export function consumeShared(workspace: string): SharedItem[] {
  const items = get(sharedClipboard)[workspace] ?? [];
  sharedClipboard.update((shared) => ({ ...shared, [workspace]: [] }));
  return items;
}

/**
 * Cross-tab transfer: duplicate open docs into another workspace's vault
 * location (new ids, same content) and open them there. Real backend
 * writes — nothing half-done.
 */
export async function transferDocsToWorkspace(docIds: string[], targetWorkspace: string): Promise<Doc[]> {
  const made: Doc[] = [];
  const ws = get(currentWorkspace);
  for (const id of docIds) {
    const src = await api.docGet(id);
    const copy = await api.docCreate(targetWorkspace, src.kind, src.title, undefined, src.content, src.frontmatter_json ?? undefined);
    made.push(copy);
  }
  currentWorkspace.set(targetWorkspace);
  const first = made[0];
  if (first) {
    currentDoc.set(first);
    openTabs.update((tabs) => (tabs.find((t) => t.id === first.id) ? tabs : [first, ...tabs]));
  }
  void ws;
  return made;
}

// ── Smart tasks ───────────────────────────────────────────────────
const TASKS_KEY = "jwe-smart-tasks-v1";

export const smartTasks = writable<SmartTask[]>(load<SmartTask[]>(TASKS_KEY, []));

smartTasks.subscribe((v) => save(TASKS_KEY, v));

export function addTask(title: string, workspace: string, docId = ""): SmartTask {
  const task: SmartTask = {
    id: `task-${Date.now().toString(36)}`,
    title: title.trim(),
    workspace,
    docId,
    completed: false,
    createdAt: new Date().toISOString(),
  };
  smartTasks.update((tasks) => [...tasks, task]);
  return task;
}

export function toggleTask(id: string): void {
  smartTasks.update((tasks) => tasks.map((t) => (t.id === id ? { ...t, completed: !t.completed } : t)));
}

export function removeTask(id: string): void {
  smartTasks.update((tasks) => tasks.filter((t) => t.id !== id));
}

export const openTasks = derived(smartTasks, ($tasks) => $tasks.filter((t) => !t.completed));
