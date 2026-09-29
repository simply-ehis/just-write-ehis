<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, type Simulation, type SimulationNodeDatum, type SimulationLinkDatum } from "d3-force";
  import { api, type GraphNode, type GraphEdge, type GraphQueryResult } from "$lib/api";
  import { currentDoc, openTabs, currentWorkspace } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import Icon from "$lib/components/Icon.svelte";
  import { domainError, warnOnce } from "$lib/errors";
  import WorkspaceError from "./WorkspaceError.svelte";

  let canvas: HTMLCanvasElement;
  let ctx: CanvasRenderingContext2D | null = null;
  let simulation: Simulation<SimNode, SimLink> | null = null;

  let graphData = $state<GraphQueryResult | null>(null);
  let loading = $state(true);
  let selectedNodeId = $state<string | null>(null);
  let hoveredNodeId = $state<string | null>(null);
  let showOrphans = $state(true);
  // Hubs-only filter (was a dead toggle that only drew gold rings — the
  // rings stay; this now actually filters to hubs + their neighbors).
  let hubOnly = $state(false);
  let filterWorkspace = $state<string>("all");
  let filterTags = $state<string[]>([]);
  let tagSearch = $state("");
  let showTagSuggestions = $state(false);

  // Large-vault guard: cap the initial render (highest degree first) with
  // an explicit Show-all escape hatch — the force layout + per-frame draw
  // both degrade past this size with no virtualization in place.
  const NODE_CAP = 800;
  let showAllNodes = $state(false);
  let cappedCount = $state(0);

  // Click-after-drag guard: mouseup clears isDragging/isPanning before
  // click fires, so the click handler can't tell a drag from a tap.
  // Distance-tracked suppressClick survives across the two events.
  let downPos = $state<{ x: number; y: number } | null>(null);
  let suppressClick = $state(false);
  let tickCount = $state(0);

  let width = $state(800);
  let height = $state(600);
  let transform = $state({ x: 0, y: 0, k: 1 });

  let isDragging = $state(false);
  let dragStart = $state({ x: 0, y: 0 });
  let lastMouse = $state({ x: 0, y: 0 });
  let isPanning = $state(false);
  let dragNode = $state<SimNode | null>(null);

  interface SimNode extends SimulationNodeDatum {
    id: string;
    title: string;
    workspace: string;
    kind: string;
    wordCount: number;
    activityScore: number;
    degree: number;
    tags?: string[];
    x?: number;
    y?: number;
    vx?: number;
    vy?: number;
  }

  interface SimLink extends SimulationLinkDatum<SimNode> {
    kind: string;
    contextSnippet: string | null;
  }

  // Node fills mirror the --ws-* tokens per theme (canvas can't read
  // var() at draw time, so the mapping is explicit). Hue semantics stay
  // identical across themes; only luminance shifts for the surface.
  const workspacePalettes: Record<string, Record<string, string>> = {
    light: {
      logs: "#C99A3C", write: "#9C9686", map: "#7FBF9A", novel: "#A79BC9",
      script: "#D97B6C", projects: "#8FA3B8", reader: "#5B8C7A", default: "#9C9686",
    },
    dark: {
      logs: "#D9A441", write: "#A39E93", map: "#8FC7A9", novel: "#A79BC9",
      script: "#E08A7A", projects: "#9AA1AD", reader: "#7FBF9A", default: "#A39E93",
    },
    brutalist: {
      logs: "#FFB000", write: "#A8A294", map: "#8FD694", novel: "#C4B5E3",
      script: "#F0857A", projects: "#9AA1AD", reader: "#7FBF9A", default: "#A8A294",
    },
    "brutalist-light": {
      logs: "#9A6B1A", write: "#726F62", map: "#2E7D5B", novel: "#6A5FA8",
      script: "#B54434", projects: "#6B7280", reader: "#3F7A5E", default: "#726F62",
    },
    glass: {
      logs: "#D9A441", write: "#9C9686", map: "#A9E8C6", novel: "#B9A8DC",
      script: "#E89A8B", projects: "#9AA1AD", reader: "#7FBF9A", default: "#9C9686",
    },
    "glass-light": {
      logs: "#9A6B1A", write: "#726F62", map: "#2E7D5B", novel: "#6A5FA8",
      script: "#B54434", projects: "#6B7280", reader: "#3F7A5E", default: "#726F62",
    },
  };

  // Canvas can't use var(); track style + mode instead (cheap $derived,
  // read per draw).
  let isDark = $derived($settings.themeMode !== "light");
  // Selection/hub rings follow the style accent + warning so they read
  // on paper, ink, hazard-amber, and glow-mint alike.
  let ringSelected = $derived(
    $settings.theme === "brutalist" ? "#FFB000"
    : $settings.theme === "glass" ? ($settings.themeMode === "light" ? "#1F7A52" : "#A9E8C6")
    : $settings.themeMode === "light" ? "#3F6656"
    : "#8FC7A9"
  );
  let ringHub = $derived(
    $settings.theme === "brutalist" ? "#FFB000"
    : $settings.themeMode === "light" ? "#9A6B1A"
    : "#D9A441"
  );

  function mapPaletteKey(): string {
    const style = $settings.theme;
    if (style === "default") return $settings.themeMode === "light" ? "light" : "dark";
    return $settings.themeMode === "light" ? `${style}-light` : style;
  }

  function getNodeColor(ws: string): string {
    const palette = workspacePalettes[mapPaletteKey()] ?? workspacePalettes.dark;
    return palette[ws] || palette.default;
  }

  function screenToWorld(sx: number, sy: number): [number, number] {
    return [
      (sx - transform.x) / transform.k,
      (sy - transform.y) / transform.k,
    ];
  }

  function worldToScreen(wx: number, wy: number): [number, number] {
    return [
      wx * transform.k + transform.x,
      wy * transform.k + transform.y,
    ];
  }

  function draw() {
    if (ctx && canvas && graphData) {
      const gd = graphData;

    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const filteredNodes = gd.nodes.filter((n) => {
      if (filterWorkspace !== "all" && n.workspace !== filterWorkspace) return false;
      if (!showOrphans && gd.orphans.includes(n.id)) return false;
      if (filterTags.length > 0 && n.tags && !filterTags.every((t) => n.tags!.includes(t))) return false;
      return true;
    });

    // Per-frame Set lookups (orphans/hubs ship as arrays).
    const orphanIds = new Set(gd.orphans);
    const hubIds = new Set(gd.hubs.map(([id]) => id));

    // Hubs-only view: hub nodes plus their direct neighbors. Off = all.
    let visibleNodes = filteredNodes;
    if (hubOnly) {
      const neighborIds = new Set<string>();
      for (const e of gd.edges) {
        if (hubIds.has(e.source)) neighborIds.add(e.target);
        if (hubIds.has(e.target)) neighborIds.add(e.source);
      }
      visibleNodes = filteredNodes.filter((n) => hubIds.has(n.id) || neighborIds.has(n.id));
    }

    const nodeIds = new Set(visibleNodes.map((n) => n.id));
    const filteredEdges = gd.edges.filter((e) =>
      nodeIds.has(e.source) && nodeIds.has(e.target)
    );

    // O(1) endpoint lookup per edge (was O(N) find per edge per frame).
    const nodeById = new Map(visibleNodes.map((n) => [n.id, n]));
    for (const edge of filteredEdges) {
      const src = nodeById.get(edge.source);
      const tgt = nodeById.get(edge.target);
      if (!src || !tgt || src.x == null || src.y == null || tgt.x == null || tgt.y == null) continue;

      const isHighlighted = selectedNodeId === edge.source || selectedNodeId === edge.target;
      ctx.beginPath();
      ctx.moveTo(src.x, src.y);
      ctx.lineTo(tgt.x, tgt.y);
      ctx.strokeStyle = isHighlighted ? `${ringSelected}60` : "#9C968655";
      ctx.lineWidth = isHighlighted ? 2 : 1;
      ctx.stroke();
    }

    for (const node of visibleNodes) {
      if (node.x == null || node.y == null) continue;

      const isSelected = selectedNodeId === node.id;
      const isHovered = hoveredNodeId === node.id;
      const isOrphan = orphanIds.has(node.id);
      const isHub = hubIds.has(node.id);
      const baseRadius = 6 + Math.min(node.degree * 1.5, 12);
      const radius = isSelected ? baseRadius * 1.3 : isHovered ? baseRadius * 1.15 : baseRadius;

      ctx.beginPath();
      ctx.arc(node.x, node.y, radius, 0, Math.PI * 2);
      ctx.fillStyle = getNodeColor(node.workspace);
      ctx.globalAlpha = isOrphan ? 0.4 : 1;
      ctx.fill();

      if (isSelected || isHub) {
        ctx.beginPath();
        ctx.arc(node.x, node.y, radius + 3, 0, Math.PI * 2);
        ctx.strokeStyle = isSelected ? ringSelected : ringHub;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.globalAlpha = 1;

      if (transform.k > 0.5 || isSelected || isHovered) {
        ctx.fillStyle = isDark ? "#ECE7D8" : "#2B2A25";
        ctx.font = `${isSelected ? "bold " : ""}${12 / transform.k}px Inter, sans-serif`;
        ctx.textAlign = "center";
        ctx.fillText(node.title, node.x, node.y + radius + 14 / transform.k);
      }
    }

    ctx.restore();
    }
    requestAnimationFrame(draw);
  }

  function findNodeAt(wx: number, wy: number): SimNode | null {
    if (!graphData) return null;
    for (const node of graphData.nodes) {
      if (node.x == null || node.y == null) continue;
      const r = 6 + Math.min(node.degree * 1.5, 12);
      const dx = wx - node.x;
      const dy = wy - node.y;
      if (dx * dx + dy * dy < r * r) {
        return node as unknown as SimNode;
      }
    }
    return null;
  }

  function handleMouseDown(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);

    downPos = { x: e.clientX, y: e.clientY };
    suppressClick = false;
    const node = findNodeAt(wx, wy);
    if (node) {
      dragNode = node;
      isDragging = true;
      node.fx = node.x;
      node.fy = node.y;
    } else {
      isPanning = true;
      dragStart = { x: sx - transform.x, y: sy - transform.y };
    }
    lastMouse = { x: e.clientX, y: e.clientY };
  }

  function handleMouseMove(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);

    if (downPos) {
      const dx = e.clientX - downPos.x;
      const dy = e.clientY - downPos.y;
      if (dx * dx + dy * dy > 25) suppressClick = true;
    }
    if (isDragging && dragNode) {
      dragNode.fx = wx;
      dragNode.fy = wy;
      simulation?.alpha(0.3).restart();
    } else if (isPanning) {
      transform = {
        ...transform,
        x: sx - dragStart.x,
        y: sy - dragStart.y,
      };
    } else {
      const node = findNodeAt(wx, wy);
      hoveredNodeId = node?.id ?? null;
      canvas.style.cursor = node ? "pointer" : "grab";
    }
    lastMouse = { x: e.clientX, y: e.clientY };
  }

  function handleMouseUp() {
    if (dragNode) {
      dragNode.fx = null;
      dragNode.fy = null;
    }
    isDragging = false;
    isPanning = false;
    dragNode = null;
    downPos = null;
    // NOTE: suppressClick survives here on purpose — click fires after
    // mouseup and must still see it. handleClick consumes it.
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;

    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const newK = Math.max(0.1, Math.min(5, transform.k * delta));

    transform = {
      k: newK,
      x: sx - (sx - transform.x) * (newK / transform.k),
      y: sy - (sy - transform.y) * (newK / transform.k),
    };
  }

  function handleClick(e: MouseEvent) {
    if (suppressClick) { suppressClick = false; return; }
    if (isDragging || isPanning) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    const node = findNodeAt(wx, wy);
    selectedNodeId = node?.id ?? null;
  }

  function handleDblClick(e: MouseEvent) {
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const [wx, wy] = screenToWorld(sx, sy);
    const node = findNodeAt(wx, wy);
    if (node) {
      openDoc(node.id);
    }
  }

  async function openDoc(docId: string) {
    try {
      const doc = await api.docGet(docId);
      $currentDoc = doc;
      if (!$openTabs.find((t) => t.id === doc.id)) {
        $openTabs = [doc, ...$openTabs];
      }
      await api.usageRecord(doc.id, "open").catch((e) => warnOnce("Map usage telemetry", e));
    } catch (e) {
      domainError("Map", "couldn't open document", e);
    }
  }

  function fitGraph() {
    if (!graphData || graphData.nodes.length === 0) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const node of graphData.nodes) {
      if (node.x !== undefined && node.x !== null && node.y !== undefined && node.y !== null) {
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
      }
    }
    if (minX === Infinity) return;
    const padding = 60;
    const gw = maxX - minX + padding * 2;
    const gh = maxY - minY + padding * 2;
    const k = Math.min(width / gw, height / gh, 2);
    transform = {
      k,
      x: width / 2 - (minX + maxX) / 2 * k,
      y: height / 2 - (minY + maxY) / 2 * k,
    };
  }

  // Visible load failure for the graph: never a fake-empty canvas.
  let graphLoadError = $state<string | null>(null);
  async function loadGraph() {
    loading = true;
    graphLoadError = null;
    try {
      const full = await api.graphQuery({ workspace: filterWorkspace, tags: filterTags });
      // Cap the force layout past NODE_CAP (highest degree first) — the
      // sim + draw both degrade without virtualization. Explicit opt-in
      // to see everything; filters still apply on top.
      if (!showAllNodes && full.nodes.length > NODE_CAP) {
        const keep = new Set(
          [...full.nodes].sort((a, b) => b.degree - a.degree).slice(0, NODE_CAP).map((n) => n.id)
        );
        cappedCount = full.nodes.length - NODE_CAP;
        graphData = {
          ...full,
          nodes: full.nodes.filter((n) => keep.has(n.id)),
          edges: full.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
          orphans: full.orphans.filter((id) => keep.has(id)),
        };
      } else {
        cappedCount = 0;
        graphData = full;
      }
      initSimulation();
    } catch (e) {
      graphLoadError = e instanceof Error ? e.message : String(e);
      domainError("Map", "couldn't load graph", e);
    }
    loading = false;
  }

  // Tag filtering helpers
  function getAllTags(): string[] {
    if (!graphData) return [];
    const tagSet = new Set<string>();
    for (const node of graphData.nodes) {
      if (node.tags) {
        for (const tag of node.tags) tagSet.add(tag);
      }
    }
    return Array.from(tagSet).sort();
  }

  function getTagSuggestions(query: string): string[] {
    if (!query) return getAllTags();
    const allTags = getAllTags();
    return allTags.filter((t) => t.toLowerCase().includes(query.toLowerCase()));
  }

  function addTag(tag: string) {
    if (!filterTags.includes(tag)) {
      filterTags = [...filterTags, tag];
      loadGraph();
    }
  }

  function removeTag(tag: string) {
    filterTags = filterTags.filter((t) => t !== tag);
    loadGraph();
  }

  function initSimulation() {
    if (!graphData) return;

    if (simulation) simulation.stop();

    const nodes: SimNode[] = graphData.nodes.map((n) => ({
      ...n,
      wordCount: n.word_count,
      activityScore: n.activity_score,
    }));

    const links: SimLink[] = graphData.edges.map((e) => ({
      source: e.source,
      target: e.target,
      kind: e.kind,
      contextSnippet: e.context_snippet,
    }));

    simulation = forceSimulation<SimNode, SimLink>(nodes)
      .force("link", forceLink<SimNode, SimLink>(links).id((d) => d.id).distance(100))
      .force("charge", forceManyBody<SimNode>().strength(-200))
      .force("center", forceCenter<SimNode>(0, 0))
      .force("collide", forceCollide<SimNode>().radius((d) => 10 + d.degree * 2))
      .on("tick", () => {
        // Sync positions at ~10fps, not every tick: each write retriggers
        // Svelte reactivity (draw reads graphData), so per-tick sync is a
        // storm for zero visual gain.
        tickCount++;
        if (tickCount % 6 !== 0) return;
        graphData = { ...graphData!, nodes: nodes.map((n) => ({
          id: n.id, title: n.title, workspace: n.workspace, kind: n.kind,
          word_count: n.wordCount, activity_score: n.activityScore, degree: n.degree,
          x: n.x, y: n.y, vx: n.vx, vy: n.vy, fx: n.fx, fy: n.fy,
        })) };
      });

    setTimeout(fitGraph, 500);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "f" || e.key === "F") {
      fitGraph();
    } else if (e.key === "Escape") {
      selectedNodeId = null;
    } else if (e.key === "Enter" && selectedNodeId) {
      openDoc(selectedNodeId);
    }
  }

  function handleResize() {
    if (!canvas) return;
    const parent = canvas.parentElement;
    // window-guarded: bare devicePixelRatio throws where the global is
    // undefined (workers, exotic embeds) — fall back to 1x.
    const dpr = typeof window !== "undefined" && window.devicePixelRatio ? window.devicePixelRatio : 1;
    if (parent) {
      width = parent.clientWidth;
      height = parent.clientHeight;
      canvas.width = width * dpr;
      canvas.height = height * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      if (ctx) {
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      }
    }
  }

  function setWorkspaceFilter(ws: string) {
    filterWorkspace = ws;
    loadGraph();
  }

  onMount(() => {
    if (!canvas) return;
    ctx = canvas.getContext("2d");
    handleResize();
    window.addEventListener("resize", handleResize);
    loadGraph();
    requestAnimationFrame(draw);
  });

  onDestroy(() => {
    window.removeEventListener("resize", handleResize);
    if (simulation) simulation.stop();
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions: graph canvas widget — keydown provides F/Escape/Enter shortcuts alongside toolbar buttons; container is focusable. -->
<div class="node-map-workspace" onkeydown={handleKeydown} tabindex="-1" role="application">
  <div class="graph-toolbar">
    <div class="toolbar-left">
      <button class="toolbar-btn icon-btn" onclick={loadGraph} title="Refresh graph" aria-label="Refresh graph"><Icon name="refresh" size={15} /></button>
      <button class="toolbar-btn icon-btn" onclick={fitGraph} title="Fit to view (F)" aria-label="Fit graph to view"><Icon name="fit" size={15} /></button>
      <select class="filter-select" value={filterWorkspace} onchange={(e) => setWorkspaceFilter((e.target as HTMLSelectElement).value)} aria-label="Filter by workspace">
        <option value="all">All workspaces</option>
        <option value="logs">Logs</option>
        <option value="write">Write</option>
        <option value="novel">Novel</option>
        <option value="script">Script</option>
        <option value="projects">Projects</option>
        <option value="reader">Reader</option>
      </select>
      <div class="tag-filter" style="display: flex; align-items: center; gap: 4px;">
        <Icon name="tag" size={14} class="tag-icon" />
        <div class="tag-input-wrapper" style="position: relative;">
          <input
            type="text"
            class="filter-select"
            style="width: 160px; padding-right: 28px;"
            placeholder="Filter by tags…"
            value={tagSearch}
            oninput={(e: Event) => { tagSearch = (e.target as HTMLInputElement).value; showTagSuggestions = true; }}
            onfocus={() => { showTagSuggestions = tagSearch.length > 0; }}
            onblur={() => { setTimeout(() => showTagSuggestions = false, 150); }}
            aria-label="Filter by tags"
          />
          {#if showTagSuggestions && tagSearch}
            <div class="tag-suggestions" style="position: absolute; top: 100%; left: 0; right: 0; background: var(--surface-raised); border: 1px solid var(--border); border-radius: var(--radius-sm); margin-top: 2px; max-height: 200px; overflow-y: auto; z-index: 10;">
              {#each getTagSuggestions(tagSearch) as suggestion}
                <button
                  type="button"
                  class="tag-suggestion"
                  style="width: 100%; text-align: left; padding: 6px 10px; border: none; background: transparent; color: var(--text-primary); font-size: 12px; cursor: pointer;"
                  onmouseover={() => tagSearch = suggestion}
                  onfocus={() => tagSearch = suggestion}
                  onclick={() => { addTag(suggestion); tagSearch = ""; showTagSuggestions = false; }}
                >
                  # {suggestion}
                </button>
              {/each}
            </div>
          {/if}
        </div>
        {#if filterTags.length > 0}
          <div class="active-tags" style="display: flex; gap: 4px; flex-wrap: wrap;">
            {#each filterTags as tag}
              <span class="active-tag" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; background: var(--accent-primary); color: var(--text-on-accent); border-radius: var(--radius-sm); font-size: 11px;">
                #{tag}
                <button type="button" onclick={() => removeTag(tag)} style="background: none; border: none; color: inherit; cursor: pointer; padding: 0; line-height: 1;">×</button>
              </span>
            {/each}
          </div>
        {/if}
      </div>
    </div>
    <div class="toolbar-right">
      <label class="toggle-label">
        <input type="checkbox" bind:checked={showOrphans} />
        Orphans
      </label>
      <label class="toggle-label">
        <input type="checkbox" bind:checked={hubOnly} />
        Hubs only
      </label>
      {#if graphData}
        <span class="stats">{graphData.nodes.length} nodes / {graphData.edges.length} edges</span>
      {/if}
      {#if cappedCount > 0}
        <span class="stats capped" title="Large vault: showing top {NODE_CAP} connected docs">+{cappedCount} capped</span>
        <button class="toolbar-btn" onclick={() => { showAllNodes = true; loadGraph(); }}>Show all</button>
      {/if}
    </div>
  </div>

  <div class="canvas-container">
    {#if loading}
      <div class="loading">Loading graph...</div>
    {:else if graphLoadError}
      <WorkspaceError message={`Map — couldn't load graph: ${graphLoadError}`} onRetry={() => loadGraph()} />
    {:else if graphData && graphData.nodes.length === 0}
      <div class="empty-graph">
        <span class="icon"><Icon name="graph" size={40} /></span>
        <span>No documents yet</span>
        <span class="hint">Create docs and link them with [[wikilinks]] to see the graph</span>
      </div>
    {/if}
    <canvas
      bind:this={canvas}
      onmousedown={handleMouseDown}
      onmousemove={handleMouseMove}
      onmouseup={handleMouseUp}
      onmouseleave={handleMouseUp}
      onwheel={handleWheel}
      onclick={handleClick}
      ondblclick={handleDblClick}
    ></canvas>
  </div>

  {#if selectedNodeId && graphData}
    {@const node = graphData.nodes.find((n) => n.id === selectedNodeId)}
    {@const allNeighbors = node ? graphData.edges.filter((e) => e.source === node.id || e.target === node.id) : []}
    {@const neighbors = allNeighbors.slice(0, 12)}
    {#if node}
      <div class="node-inspector">
        <div class="inspector-header">
          <span class="node-dot" style="background: {getNodeColor(node.workspace)}"></span>
          <h3>{node.title}</h3>
          <button class="icon-btn" onclick={() => (selectedNodeId = null)} title="Minimize panel" aria-label="Minimize panel">
            <Icon name="minus" size={14} />
          </button>
        </div>
        <div class="inspector-meta">
          <span>{node.workspace}</span>
          <span>{node.word_count} words</span>
          <span>{node.degree} connections</span>
        </div>
        <div class="inspector-actions">
          <button class="btn-primary" onclick={() => openDoc(node.id)}>Open</button>
        </div>
        {#if neighbors.length > 0}
          <div class="neighbor-list">
            <div class="neighbor-head">Linked ({allNeighbors.length})</div>
            {#each neighbors as e}
              {@const otherId = e.source === node.id ? e.target : e.source}
              {@const other = graphData.nodes.find((n) => n.id === otherId)}
              <button class="neighbor-item" onclick={() => { selectedNodeId = otherId; }}>
                <span class="neighbor-kind">{e.kind}</span>
                <span class="neighbor-title">{other?.title ?? otherId}</span>
                {#if e.context_snippet}<span class="neighbor-snippet">{e.context_snippet}</span>{/if}
              </button>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .node-map-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    position: relative;
  }

  .graph-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
    z-index: 10;
  }

  .toolbar-left, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .toolbar-btn {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--text-muted);
  }

  .toolbar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .filter-select {
    height: 30px;
    padding: 0 8px;
    font-size: 12px;
    border-radius: var(--radius-sm);
  }

  .toggle-label {
    display: flex;
    align-items: center;
    gap: 4px;
    font-size: 12px;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .toggle-label input {
    width: 14px;
    height: 14px;
    accent-color: var(--accent);
  }

  .stats {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .canvas-container {
    flex: 1;
    position: relative;
    overflow: hidden;
    background: var(--bg-primary);
  }

  canvas {
    display: block;
    width: 100%;
    height: 100%;
    cursor: grab;
  }

  canvas:active {
    cursor: grabbing;
  }

  .loading, .empty-graph {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    color: var(--text-muted);
    z-index: 5;
    pointer-events: none;
  }

  .empty-graph .icon {
    font-size: 48px;
    opacity: 0.5;
  }

  .empty-graph .hint {
    font-size: 12px;
    max-width: 300px;
    text-align: center;
  }

  .node-inspector {
    position: absolute;
    bottom: 16px;
    left: 16px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: 16px;
    min-width: 240px;
    z-index: 10;
  }

  .inspector-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }

  .node-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .inspector-header h3 {
    font-size: 14px;
    font-weight: 600;
  }

  .inspector-meta {
    display: flex;
    gap: 12px;
    font-size: 12px;
    color: var(--text-muted);
    margin-bottom: 12px;
  }

  .inspector-actions {
    display: flex;
    gap: 8px;
  }

  .btn-primary {
    background: var(--accent);
    color: var(--text-on-accent);
    padding: 6px 14px;
    border-radius: var(--radius-md);
    font-size: 12px;
    font-weight: 500;
  }

  .btn-primary:hover {
    background: var(--accent-hover);
  }

  .neighbor-list {
    margin-top: 12px;
    max-height: 180px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .neighbor-head {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .neighbor-item {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 1px;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
  }

  .neighbor-item:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .neighbor-kind {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
  }

  .neighbor-title {
    font-weight: 600;
    color: var(--text-primary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 100%;
  }

  .neighbor-snippet {
    color: var(--text-muted);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    overflow: hidden;
  }
</style>
