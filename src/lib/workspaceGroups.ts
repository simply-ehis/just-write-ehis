/**
 * workspaceGroups — ONE grouping definition for every navigation surface.
 *
 * Sidebar.svelte's section headers and BottomBar.svelte's mobile More menu
 * used to be two independently hand-maintained lists that drifted apart
 * (BottomBar even kept Craft/Stats/Tips entries long after they became
 * Settings tabs). Both now read this module, so desktop and mobile always
 * present the same categories.
 *
 * Group membership covers the union of both surfaces: the sidebar hides
 * HIDDEN_IDS (inbox/canvas stay palette-only on desktop) while the
 * mobile More menu shows everything. "files" is virtual — no route, it
 * deep-links to Library's Files tab — but stays listed so More/palette
 * keep reaching it. Home is pinned and ungrouped;
 * Settings is a separate entry, not a workspace.
 */
export interface WorkspaceGroupDef {
  id: string;
  label: string;
  members: string[];
}

export const WORKSPACE_GROUPS: WorkspaceGroupDef[] = [
  { id: "create", label: "Create", members: ["write", "novel", "script"] },
  { id: "capture", label: "Capture", members: ["logs", "inbox"] },
  { id: "organize", label: "Organize", members: ["projects", "properties", "files"] },
  { id: "explore", label: "Explore", members: ["map", "reader", "canvas"] },
];

/** Group rank drives group-major order; home stays pinned first. */
const GROUP_ORDER = ["create", "capture", "organize", "explore"];

/** Section label for a workspace id, or null when ungrouped (home). */
export function groupOfWorkspace(id: string): string | null {
  if (id === "home") return null;
  const found = WORKSPACE_GROUPS.find((g) => g.members.includes(id));
  return found ? found.label : null;
}

/** Sort rank for group-major ordering (home 0, then group order). */
export function groupRankOf(id: string): number {
  if (id === "home") return 0;
  const found = WORKSPACE_GROUPS.findIndex((g) => g.members.includes(id));
  return found === -1 ? GROUP_ORDER.length + 1 : found + 1;
}
