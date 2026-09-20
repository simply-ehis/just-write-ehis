import { writable } from "svelte/store";
import type { Doc, TabState } from "$lib/api";

export const currentWorkspace = writable<string>("home");
export const currentDoc = writable<Doc | null>(null);
export const openTabs = writable<Doc[]>([]);

/** Persisted chrome prefs: sidebar/AI/inspector survive restart. */
function loadPanels(): { sidebar: boolean; ai: boolean; inspector: boolean } {
  try {
    const raw = localStorage.getItem("jwe-ui-panels");
    if (raw) {
      const p = JSON.parse(raw);
      return {
        sidebar: p.sidebar !== false,
        ai: p.ai === true,
        inspector: p.inspector === true,
      };
    }
  } catch {}
  return { sidebar: true, ai: false, inspector: false };
}

const initialPanels = loadPanels();

export const sidebarOpen = writable<boolean>(initialPanels.sidebar);
export const aiPanelOpen = writable<boolean>(initialPanels.ai);
export const inspectorOpen = writable<boolean>(initialPanels.inspector);
export const showSettings = writable<boolean>(false);
export const zenMode = writable<boolean>(false);

// Persist chrome prefs (debounced by Svelte batching: one write per toggle).
if (typeof localStorage !== "undefined") {
  let panelTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleSave = (sidebar: boolean, ai: boolean, inspector: boolean) => {
    if (panelTimer) clearTimeout(panelTimer);
    panelTimer = setTimeout(() => {
      try {
        localStorage.setItem("jwe-ui-panels", JSON.stringify({ sidebar, ai, inspector }));
      } catch {}
    }, 300);
  };
  let latest = { sidebar: initialPanels.sidebar, ai: initialPanels.ai, inspector: initialPanels.inspector };
  sidebarOpen.subscribe((v) => { latest.sidebar = v; scheduleSave(latest.sidebar, latest.ai, latest.inspector); });
  aiPanelOpen.subscribe((v) => { latest.ai = v; scheduleSave(latest.sidebar, latest.ai, latest.inspector); });
  inspectorOpen.subscribe((v) => { latest.inspector = v; scheduleSave(latest.sidebar, latest.ai, latest.inspector); });
}

export interface WorkspaceState {
  tabs: Doc[];
  activeId: string | null;
}

export const workspaceStates: Record<string, WorkspaceState> = {
  home: { tabs: [], activeId: null },
  logs: { tabs: [], activeId: null },
  write: { tabs: [], activeId: null },
  map: { tabs: [], activeId: null },
  novel: { tabs: [], activeId: null },
  script: { tabs: [], activeId: null },
  projects: { tabs: [], activeId: null },
  reader: { tabs: [], activeId: null },
  files: { tabs: [], activeId: null },
  inbox: { tabs: [], activeId: null },
  properties: { tabs: [], activeId: null },
  canvas: { tabs: [], activeId: null },
  craft: { tabs: [], activeId: null },
  stats: { tabs: [], activeId: null },
  skills: { tabs: [], activeId: null },
};

export const workspaces = [
  { id: "home", label: "Home", icon: "home" },
  { id: "logs", label: "Logs", icon: "calendar" },
  { id: "write", label: "Write", icon: "pencil" },
  { id: "inbox", label: "Inbox", icon: "inbox" },
  { id: "map", label: "Map", icon: "graph" },
  { id: "canvas", label: "Canvas", icon: "board" },
  { id: "novel", label: "Novel", icon: "book" },
  { id: "script", label: "Script", icon: "film" },
  { id: "projects", label: "Projects", icon: "folder" },
  { id: "reader", label: "Reader", icon: "book-open" },
  { id: "files", label: "Files", icon: "files" },
  { id: "properties", label: "Library", icon: "table" },
] as const;
