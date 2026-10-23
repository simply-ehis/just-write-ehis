/**
 * nodeMapGraph — pure visibility + hit-test + cap rules for the Map
 * workspace canvas. Extracted from NodeMapWorkspace.svelte so the set of
 * nodes that DRAWS is by construction the same set that can be hovered,
 * clicked and framed. (Before the extraction, findNodeAt and fitGraph
 * iterated the unfiltered node list: filtered-out docs stayed clickable
 * and fit framed invisible nodes.) Unit-tested in tests/map-surface.mjs —
 * no canvas or DOM needed.
 */
import type { GraphNode, GraphQueryResult } from "$lib/api";

export interface MapFilters {
  /** "all" or a single workspace id. */
  workspace: string;
  /** Active tag chips — a tagged node must carry every one. */
  tags: string[];
  /** false hides orphan docs (no wikilinks in or out). */
  showOrphans: boolean;
  /** true restricts to hub docs + their direct neighbors. */
  hubOnly: boolean;
}

/** Node radius in world units — one formula for draw AND hit-test. */
export function nodeRadius(degree: number): number {
  return 6 + Math.min(degree * 1.5, 12);
}

/**
 * The single visible-node rule. Workspace + tag filters narrow first;
 * hub-only then keeps hubs + direct neighbors. Orphan/hub id sets are
 * accepted so hot paths (per-draw, per-mousemove) don't rebuild them.
 *
 * Tag semantics match what graph_query returns: nodes WITHOUT a tags
 * array pass an active tag filter (the backend already excluded untagged
 * nodes when tags were requested; the client rule only re-narrows).
 */
export function computeVisibleNodes(
  gd: GraphQueryResult,
  filters: MapFilters,
  sets?: { orphanIds: Set<string>; hubIds: Set<string> },
): GraphNode[] {
  const orphanIds = sets?.orphanIds ?? new Set(gd.orphans);
  const hubIds = sets?.hubIds ?? new Set(gd.hubs.map(([id]) => id));

  const filtered = gd.nodes.filter((n) => {
    if (filters.workspace !== "all" && n.workspace !== filters.workspace) return false;
    if (!filters.showOrphans && orphanIds.has(n.id)) return false;
    if (filters.tags.length > 0 && n.tags && !filters.tags.every((t) => n.tags!.includes(t))) return false;
    return true;
  });

  if (!filters.hubOnly) return filtered;

  // Hubs-only view: hub nodes plus their direct neighbors.
  const neighborIds = new Set<string>();
  for (const e of gd.edges) {
    if (hubIds.has(e.source)) neighborIds.add(e.target);
    if (hubIds.has(e.target)) neighborIds.add(e.source);
  }
  return filtered.filter((n) => hubIds.has(n.id) || neighborIds.has(n.id));
}

/** Hit-test in world coordinates against the VISIBLE node list only. */
export function hitTestNode(nodes: GraphNode[], wx: number, wy: number): GraphNode | null {
  for (const node of nodes) {
    if (node.x == null || node.y == null) continue;
    const r = nodeRadius(node.degree);
    const dx = wx - node.x;
    const dy = wy - node.y;
    if (dx * dx + dy * dy < r * r) return node;
  }
  return null;
}

/**
 * Large-vault guard: cap the initial render to the top-`cap` connected
 * docs (highest degree first); edges and orphan ids follow the kept set.
 * showAll=true (the toolbar's "Show all" hatch) skips the cap.
 */
export function applyNodeCap(
  gd: GraphQueryResult,
  cap: number,
  showAll: boolean,
): { data: GraphQueryResult; capped: number } {
  if (showAll || gd.nodes.length <= cap) return { data: gd, capped: 0 };
  const keep = new Set(
    [...gd.nodes].sort((a, b) => b.degree - a.degree).slice(0, cap).map((n) => n.id),
  );
  return {
    data: {
      ...gd,
      nodes: gd.nodes.filter((n) => keep.has(n.id)),
      edges: gd.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
      orphans: gd.orphans.filter((id) => keep.has(id)),
    },
    capped: gd.nodes.length - cap,
  };
}
