import { writable } from "svelte/store";
import type { Doc, TabState } from "$lib/api";

export const currentWorkspace = writable<string>("home");
export const currentDoc = writable<Doc | null>(null);
export const openTabs = writable<Doc[]>([]);
export const sidebarOpen = writable<boolean>(true);
export const aiPanelOpen = writable<boolean>(false);
export const inspectorOpen = writable<boolean>(false);
export const showSettings = writable<boolean>(false);
export const zenMode = writable<boolean>(false);

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
  { id: "craft", label: "Craft", icon: "chart" },
  { id: "stats", label: "Stats", icon: "calendar" },
  { id: "skills", label: "Skills", icon: "sparkle" },
] as const;
