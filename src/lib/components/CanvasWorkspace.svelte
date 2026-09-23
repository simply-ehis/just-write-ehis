<script lang="ts">
  /**
   * CanvasWorkspace — freeform corkboard (spec A11.1).
   * Manually place cards, connect them, link cards to docs.
   * deliberately NOT the auto-laid-out Node Map: this is for
   * arranging things that don't have a structure yet.
   */
  import { onMount } from "svelte";
  import { api, type CanvasEdge, type CanvasNode, type Doc } from "$lib/api";
  import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "$lib/components/Icon.svelte";
  import DockSplit from "$lib/components/DockSplit.svelte";
  import { settings } from "$lib/stores/settings";

  const CARD_W = 200;
  // Card accent hues keep their meaning (amber = warning, forest = done…)
  // in every theme; only luminance shifts. Paper gets deepened shades for
  // contrast, ink surfaces keep the bright originals.
  const CARD_COLORS_INK: Record<string, string> = {
    slate: "#94a3b8",
    amber: "#f59e0b",
    teal: "#14b8a6",
    indigo: "#818cf8",
    rose: "#fb7185",
    forest: "#4ade80",
  };
  const CARD_COLORS_PAPER: Record<string, string> = {
    slate: "#64748B",
    amber: "#B45309",
    teal: "#0F766E",
    indigo: "#4F46E5",
    rose: "#E11D48",
    forest: "#15803D",
  };
  let COLORS = $derived($settings.theme === "light" ? CARD_COLORS_PAPER : CARD_COLORS_INK);

  let nodes = $state<CanvasNode[]>([]);
  let edges = $state<CanvasEdge[]>([]);
  let loading = $state(true);
  let transform = $state({ x: 40, y: 40, k: 1 });
  let selectedNodeId = $state<string | null>(null);
  let selectedEdgeId = $state<string | null>(null);
  let connectMode = $state(false);
  let pendingSourceId = $state<string | null>(null);
  let boardEl = $state<HTMLElement | null>(null);
  let dragNode = $state<{ id: string; dx: number; dy: number } | null>(null);
  let panning = $state<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  // Per-node save timers: a single shared timer meant a fast A→B edit
  // run silently dropped A's save (only the last closure ever fired).
  const nodeSaveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let edgeSaveTimer: ReturnType<typeof setTimeout> | null = null;
  // Edge-label generation: the backend has no label-update command, so a
  // label save is delete+reconnect. Overlapping saves (slow backend +
  // fast typing) 404'd on the already-deleted id — stale generations bail.
  let edgeLabelGen = 0;
  let editingNodeId = $state<string | null>(null);
  let editingTitle = $state("");
  let editingBody = $state("");
  let docQuery = $state("");
  let docResults = $state<Doc[]>([]);
  let docSearchTimer: ReturnType<typeof setTimeout> | null = null;

  const selectedNode = $derived(nodes.find((n) => n.id === selectedNodeId) ?? null);
  const selectedEdge = $derived(edges.find((e) => e.id === selectedEdgeId) ?? null);

  async function load() {
    loading = true;
    try {
      const [ns, es] = await api.canvasList();
      nodes = ns;
      edges = es;
    } catch (e) {
      showToast(`Canvas failed to load: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      loading = false;
    }
  }

  function scheduleSave(node: CanvasNode) {
    const prev = nodeSaveTimers.get(node.id);
    if (prev) clearTimeout(prev);
    nodeSaveTimers.set(node.id, setTimeout(async () => {
      nodeSaveTimers.delete(node.id);
      try {
        const saved = await api.canvasUpsertNode(node);
        nodes = nodes.map((n) => (n.id === saved.id ? saved : n));
      } catch (e) {
        showToast(`Card save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    }, 400));
  }

  function toWorld(clientX: number, clientY: number): { x: number; y: number } {
    const rect = boardEl!.getBoundingClientRect();
    return {
      x: (clientX - rect.left - transform.x) / transform.k,
      y: (clientY - rect.top - transform.y) / transform.k,
    };
  }

  async function addCard() {
    if (!boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    const center = toWorld(rect.left + rect.width / 2, rect.top + rect.height / 2);
    try {
      const node = await api.canvasUpsertNode({
        id: "",
        title: "New card",
        body: "",
        x: Math.round(center.x - CARD_W / 2),
        y: Math.round(center.y - 40),
        color: "slate",
        doc_id: null,
        updated_at: "",
      });
      nodes = [...nodes, node];
      selectedNodeId = node.id;
      selectedEdgeId = null;
    } catch (e) {
      showToast(`Couldn't add card: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function deleteSelected() {
    try {
      if (selectedNodeId) {
        await api.canvasDeleteNode(selectedNodeId);
        edges = edges.filter((e) => e.source_id !== selectedNodeId && e.target_id !== selectedNodeId);
        nodes = nodes.filter((n) => n.id !== selectedNodeId);
        selectedNodeId = null;
      } else if (selectedEdgeId) {
        await api.canvasDeleteEdge(selectedEdgeId);
        edges = edges.filter((e) => e.id !== selectedEdgeId);
        selectedEdgeId = null;
      }
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  function onCardPointerDown(e: PointerEvent, node: CanvasNode) {
    if (connectMode) {
      e.stopPropagation();
      if (!pendingSourceId) {
        pendingSourceId = node.id;
      } else if (pendingSourceId !== node.id) {
        const from = pendingSourceId;
        pendingSourceId = null;
        api.canvasConnect(from, node.id, "")
          .then((edge) => {
            edges = [...edges, edge];
          })
          .catch((err) => showToast(`Couldn't connect: ${err instanceof Error ? err.message : err}`, "error"));
      } else {
        pendingSourceId = null;
      }
      return;
    }
    selectedNodeId = node.id;
    selectedEdgeId = null;
    const p = toWorld(e.clientX, e.clientY);
    dragNode = { id: node.id, dx: p.x - node.x, dy: p.y - node.y };
    // Capture on the card itself (not the inner target) so moves keep flowing.
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onBoardPointerMove(e: PointerEvent) {
    if (dragNode) {
      const p = toWorld(e.clientX, e.clientY);
      const node = nodes.find((n) => n.id === dragNode!.id);
      if (!node) return;
      node.x = Math.round(p.x - dragNode.dx);
      node.y = Math.round(p.y - dragNode.dy);
      nodes = [...nodes];
    } else if (panning && boardEl) {
      transform = {
        ...transform,
        x: panning.ox + (e.clientX - panning.sx),
        y: panning.oy + (e.clientY - panning.sy),
      };
    }
  }

  function onBoardPointerUp(e: PointerEvent, node?: CanvasNode) {
    if (dragNode && node && node.id === dragNode.id) scheduleSave(node);
    dragNode = null;
    panning = null;
  }

  function onBackgroundPointerDown(e: PointerEvent) {
    if (connectMode) {
      pendingSourceId = null;
      return;
    }
    selectedNodeId = null;
    selectedEdgeId = null;
    panning = { sx: e.clientX, sy: e.clientY, ox: transform.x, oy: transform.y };
  }

  function onWheel(e: WheelEvent) {
    // Attached non-passively via effect below so pinch/wheel zoom can preventDefault.
    e.preventDefault();
    if (!boardEl) return;
    const rect = boardEl.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const k2 = Math.min(2, Math.max(0.25, transform.k * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    const wx = (mx - transform.x) / transform.k;
    const wy = (my - transform.y) / transform.k;
    transform = { k: k2, x: mx - wx * k2, y: my - wy * k2 };
  }

  function fitView() {
    if (!boardEl || nodes.length === 0) {
      transform = { x: 40, y: 40, k: 1 };
      return;
    }
    const rect = boardEl.getBoundingClientRect();
    const minX = Math.min(...nodes.map((n) => n.x));
    const minY = Math.min(...nodes.map((n) => n.y));
    const maxX = Math.max(...nodes.map((n) => n.x + CARD_W));
    const maxY = Math.max(...nodes.map((n) => n.y + 120));
    const k = Math.min(1.5, Math.max(0.25, Math.min(rect.width / (maxX - minX + 80), rect.height / (maxY - minY + 80))));
    transform = {
      k,
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: rect.height / 2 - ((minY + maxY) / 2) * k,
    };
  }

  function edgePath(edge: CanvasEdge): string {
    const a = nodes.find((n) => n.id === edge.source_id);
    const b = nodes.find((n) => n.id === edge.target_id);
    if (!a || !b) return "";
    const x1 = a.x + CARD_W;
    const y1 = a.y + 40;
    const x2 = b.x;
    const y2 = b.y + 40;
    const dx = Math.max(30, Math.abs(x2 - x1) / 2);
    return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
  }

  function edgeMid(edge: CanvasEdge): { x: number; y: number } {
    const a = nodes.find((n) => n.id === edge.source_id);
    const b = nodes.find((n) => n.id === edge.target_id);
    if (!a || !b) return { x: 0, y: 0 };
    return { x: (a.x + CARD_W + b.x) / 2, y: (a.y + b.y) / 2 + 40 };
  }

  function editSelected(patch: Partial<CanvasNode>) {
    if (!selectedNode) return;
    const next = { ...selectedNode, ...patch };
    nodes = nodes.map((n) => (n.id === next.id ? next : n));
    scheduleSave(next);
  }

  function editEdgeLabel(label: string) {
    if (!selectedEdge) return;
    const myGen = ++edgeLabelGen;
    // Labels persist with the edge; the backend stores them as given.
    selectedEdge.label = label;
    edges = [...edges];
    if (edgeSaveTimer) clearTimeout(edgeSaveTimer);
    edgeSaveTimer = setTimeout(async () => {
      try {
        // A newer keystroke scheduled its own save — it owns the outcome.
        if (myGen !== edgeLabelGen) return;
        const cur = selectedEdge;
        if (!cur) return;
        await api.canvasDeleteEdge(cur.id);
        const fresh = await api.canvasConnect(cur.source_id, cur.target_id, label);
        if (myGen !== edgeLabelGen) return;
        edges = edges.map((e) => (e.id === cur.id ? fresh : e));
        selectedEdgeId = fresh.id;
      } catch (e) {
        showToast(`Label save failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    }, 600);
  }

  function startInlineEdit(node: CanvasNode) {
    editingNodeId = node.id;
    editingTitle = node.title;
    editingBody = node.body;
  }

  function commitInlineEdit() {
    if (!editingNodeId) return;
    const node = nodes.find((n) => n.id === editingNodeId);
    if (node) {
      const next = { ...node, title: editingTitle, body: editingBody };
      nodes = nodes.map((n) => (n.id === next.id ? next : n));
      scheduleSave(next);
    }
    editingNodeId = null;
  }

  function cancelInlineEdit() {
    editingNodeId = null;
  }

  function searchDocs(q: string) {
    docQuery = q;
    if (docSearchTimer) clearTimeout(docSearchTimer);
    if (!q.trim()) {
      docResults = [];
      return;
    }
    docSearchTimer = setTimeout(async () => {
      try {
        const hits = await api.docSearchFull(q.trim());
        docResults = hits.slice(0, 6).map((h) => h.doc);
      } catch {
        docResults = [];
      }
    }, 250);
  }

  async function openLinkedDoc(id: string) {
    try {
      const doc = await api.docGet(id);
      $currentDoc = doc;
      if (!$openTabs.find((t) => t.id === doc.id)) $openTabs = [doc, ...$openTabs];
      $currentWorkspace = doc.workspace;
      await api.usageRecord(doc.id, "open").catch(() => {});
    } catch (e) {
      showToast(`Couldn't open doc: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    const tag = (document.activeElement?.tagName ?? "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      if (editingNodeId && e.key === "Escape") {
        e.preventDefault();
        cancelInlineEdit();
      }
      if (editingNodeId && e.key === "Enter" && !e.shiftKey && tag !== "textarea") {
        e.preventDefault();
        commitInlineEdit();
      }
      return;
    }
    if (e.key === "Delete" || e.key === "Backspace") {
      if (selectedNodeId || selectedEdgeId) {
        e.preventDefault();
        deleteSelected();
      }
    } else if (e.key === "Escape") {
      if (editingNodeId) {
        cancelInlineEdit();
      } else {
        selectedNodeId = null;
        selectedEdgeId = null;
        pendingSourceId = null;
        connectMode = false;
      }
    }
  }

  onMount(load);

  $effect(() => {
    const el = boardEl;
    if (!el) return;
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  });
</script>

<svelte:window onkeydown={handleKeydown} />

<div class="canvas-workspace">
  <div class="canvas-toolbar">
    <div class="toolbar-left">
      <button class="toolbar-btn icon-btn" onclick={addCard} title="New card (or double-click the board)" aria-label="New card">
        <Icon name="plus" size={15} />
      </button>
      <button
        class="toolbar-btn icon-btn"
        class:active={connectMode}
        onclick={() => { connectMode = !connectMode; pendingSourceId = null; }}
        title={connectMode ? "Connecting: click two cards (Esc to stop)" : "Connect cards"}
        aria-label="Connect cards"
        aria-pressed={connectMode}
      >
        <Icon name="link" size={15} />
      </button>
      <button class="toolbar-btn icon-btn" onclick={fitView} title="Fit board to view" aria-label="Fit board to view">
        <Icon name="fit" size={15} />
      </button>
      <button class="toolbar-btn icon-btn" onclick={load} title="Reload board" aria-label="Reload board">
        <Icon name="refresh" size={15} />
      </button>
    </div>
    <div class="toolbar-right">
      {#if connectMode}
        <span class="mode-hint">{pendingSourceId ? "Click the second card…" : "Click the first card…"}</span>
      {/if}
      <span class="stats">{nodes.length} cards / {edges.length} links</span>
    </div>
  </div>

  <DockSplit
    storageKey="jwe-split-canvas"
    topLabel="Board height"
    hasBottom={!!selectedNode || !!selectedEdge}
  >
    {#snippet top()}
  <div
    class="board"
    class:connecting={connectMode}
    bind:this={boardEl}
    onpointerdown={onBackgroundPointerDown}
    onpointermove={onBoardPointerMove}
    onpointerup={(e) => onBoardPointerUp(e)}
    ondblclick={(e) => {
      if ((e.target as HTMLElement).closest(".card")) return;
      addCard();
    }}
    role="application"
  >
    {#if loading}
      <div class="board-msg">Loading board…</div>
    {:else if nodes.length === 0}
      <div class="board-msg">
        <span class="msg-icon"><Icon name="panel" size={36} /></span>
        <span>Empty board</span>
        <span class="hint">Double-click anywhere (or press +) to drop your first card</span>
      </div>
    {/if}
    <div
      class="world"
      style="transform: translate({transform.x}px, {transform.y}px) scale({transform.k});"
    >
      <svg class="edges" width="10000" height="10000" style="left: -5000px; top: -5000px;">
        <g transform="translate(5000, 5000)">
          {#each edges as edge (edge.id)}
            {@const mid = edgeMid(edge)}
            <path
              d={edgePath(edge)}
              class="edge"
              class:selected={edge.id === selectedEdgeId}
              role="button"
              tabindex="0"
              onclick={(e) => { e.stopPropagation(); selectedEdgeId = edge.id; selectedNodeId = null; }}
              onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); selectedEdgeId = edge.id; selectedNodeId = null; } }}
            />
            {#if edge.label}
              <text x={mid.x} y={mid.y - 6} text-anchor="middle" class="edge-label">{edge.label}</text>
            {/if}
            {#if edge.id === selectedEdgeId}
              <circle cx={mid.x} cy={mid.y} r={5 / transform.k + 4} class="edge-handle" />
            {/if}
          {/each}
        </g>
      </svg>
      {#each nodes as node (node.id)}
        <div
          class="card"
          class:selected={node.id === selectedNodeId}
          class:pending={node.id === pendingSourceId}
          class:editing={node.id === editingNodeId}
          style="left: {node.x}px; top: {node.y}px; --card-accent: {COLORS[node.color] ?? COLORS.slate};"
          onpointerdown={(e) => { if (node.id !== editingNodeId) onCardPointerDown(e, node); }}
          onpointermove={onBoardPointerMove}
          onpointerup={(e) => onBoardPointerUp(e, node)}
          ondblclick={(e) => { e.stopPropagation(); startInlineEdit(node); }}
          role="button"
          tabindex="0"
          aria-label="Card {node.title || 'untitled'}"
          onkeydown={(e) => {
            if (e.key === "Enter" && node.id !== editingNodeId) {
              selectedNodeId = node.id;
              selectedEdgeId = null;
            }
          }}
        >
          {#if node.id === editingNodeId}
            <input
              class="inline-title"
              value={editingTitle}
              placeholder="Card title"
              aria-label="Card title"
              oninput={(e) => { editingTitle = (e.target as HTMLInputElement).value; }}
              onblur={commitInlineEdit}
              onkeydown={(e) => {
                if (e.key === "Escape") { e.stopPropagation(); cancelInlineEdit(); }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitInlineEdit(); }
              }}
            />
            <textarea
              class="inline-body"
              value={editingBody}
              placeholder="Card notes…"
              aria-label="Card notes"
              rows="3"
              oninput={(e) => { editingBody = (e.target as HTMLTextAreaElement).value; }}
              onblur={commitInlineEdit}
              onkeydown={(e) => {
                if (e.key === "Escape") { e.stopPropagation(); cancelInlineEdit(); }
                if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); commitInlineEdit(); }
              }}
            ></textarea>
          {:else}
            <div class="card-title">{node.title || "Untitled"}</div>
            {#if node.body}
              <div class="card-body">{node.body.length > 140 ? node.body.slice(0, 140) + "…" : node.body}</div>
            {/if}
          {/if}
          {#if node.doc_id && node.id !== editingNodeId}
            <button
              class="card-doc"
              title="Open linked document"
              onclick={(e) => { e.stopPropagation(); openLinkedDoc(node.doc_id!); }}
            >
              <Icon name="files" size={12} /><span>Open doc</span>
            </button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
    {/snippet}
    {#snippet bottom()}
  {#if selectedNode}
    <div class="inspector">
      <div class="inspector-row">
        <input
          class="inspector-title"
          value={selectedNode.title}
          placeholder="Card title"
          aria-label="Card title"
          oninput={(e) => editSelected({ title: (e.target as HTMLInputElement).value })}
        />
        <button class="icon-btn" onclick={() => (selectedNodeId = null)} title="Minimize panel" aria-label="Minimize panel">
          <Icon name="minus" size={14} />
        </button>
        <button class="icon-btn" onclick={deleteSelected} title="Delete card" aria-label="Delete card">
          <Icon name="trash" size={14} />
        </button>
      </div>
      <textarea
        class="inspector-body"
        value={selectedNode.body}
        placeholder="Card notes…"
        aria-label="Card notes"
        rows="4"
        oninput={(e) => editSelected({ body: (e.target as HTMLTextAreaElement).value })}
      ></textarea>
      <div class="inspector-row">
        <select
          value={selectedNode.color}
          aria-label="Card color"
          title="Card color"
          onchange={(e) => editSelected({ color: (e.target as HTMLSelectElement).value })}
        >
          {#each Object.keys(COLORS) as c}
            <option value={c}>{c}</option>
          {/each}
        </select>
        {#if selectedNode.doc_id}
          <button class="mini-btn" onclick={() => openLinkedDoc(selectedNode!.doc_id!)}>Open doc</button>
          <button class="mini-btn" onclick={() => editSelected({ doc_id: null })}>Unlink</button>
        {:else}
          <input
            class="doc-search"
            placeholder="Link a doc…"
            aria-label="Link a document"
            value={docQuery}
            oninput={(e) => searchDocs((e.target as HTMLInputElement).value)}
          />
        {/if}
      </div>
      {#if !selectedNode.doc_id && docResults.length > 0}
        <div class="doc-results">
          {#each docResults as d}
            <button class="doc-result" onclick={() => { editSelected({ doc_id: d.id }); docResults = []; docQuery = ""; }}>
              <span class="doc-result-title">{d.title}</span>
              <span class="doc-result-ws">{d.workspace}</span>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else if selectedEdge}
    <div class="inspector">
      <div class="inspector-row">
        <input
          class="inspector-title"
          value={selectedEdge.label}
          placeholder="Link label (optional)"
          aria-label="Link label"
          oninput={(e) => editEdgeLabel((e.target as HTMLInputElement).value)}
        />
        <button class="icon-btn" onclick={() => (selectedEdgeId = null)} title="Minimize panel" aria-label="Minimize panel">
          <Icon name="minus" size={14} />
        </button>
        <button class="icon-btn" onclick={deleteSelected} title="Delete link" aria-label="Delete link">
          <Icon name="trash" size={14} />
        </button>
      </div>
    </div>
  {/if}
    {/snippet}
  </DockSplit>
</div>

<style>
  .canvas-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
    overflow: hidden;
  }

  .canvas-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .toolbar-left {
    display: flex;
    gap: 2px;
  }

  .toolbar-btn.active {
    background: var(--surface-pressed);
    color: var(--accent-primary);
  }

  .toolbar-right {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .mode-hint {
    color: var(--accent-primary);
  }

  .board {
    position: relative;
    flex: 1;
    overflow: hidden;
    cursor: grab;
    touch-action: none;
    background-image: radial-gradient(circle, var(--border-subtle) 1px, transparent 1px);
    background-size: 24px 24px;
  }

  .board.connecting {
    cursor: crosshair;
  }

  .board-msg {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--text-muted);
    pointer-events: none;
    z-index: 5;
  }

  .msg-icon {
    opacity: 0.5;
    display: inline-flex;
  }

  .board-msg .hint {
    font-size: 12px;
  }

  .world {
    position: absolute;
    left: 0;
    top: 0;
    width: 0;
    height: 0;
    overflow: visible;
    transform-origin: 0 0;
  }

  .edges {
    position: absolute;
    pointer-events: none;
    overflow: visible;
  }

  .edge {
    fill: none;
    stroke: var(--text-muted);
    stroke-width: 2;
    pointer-events: stroke;
    cursor: pointer;
    opacity: 0.7;
  }

  .edge:hover {
    opacity: 1;
  }

  .edge.selected {
    stroke: var(--accent-primary);
    opacity: 1;
  }

  .edge-label {
    fill: var(--text-secondary);
    font-size: 12px;
    paint-order: stroke;
    stroke: var(--surface-base);
    stroke-width: 3px;
  }

  .edge-handle {
    fill: var(--accent-primary);
  }

  .card {
    position: absolute;
    width: 200px;
    min-height: 64px;
    padding: 10px 12px 10px 14px;
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--card-accent, var(--text-muted));
    cursor: grab;
    user-select: none;
    touch-action: none;
  }

  .card:active {
    cursor: grabbing;
  }

  .card.selected {
    border-color: var(--accent-primary);
  }

  .card.pending {
    border-color: var(--accent-primary);
    box-shadow: 0 0 0 2px var(--accent-primary);
  }

  .card.editing {
    cursor: default;
    z-index: 10;
    padding: 6px 8px;
    min-width: 200px;
    width: 200px;
  }

  .inline-title {
    width: 100%;
    height: 26px;
    font-size: 13px;
    font-weight: 600;
    padding: 2px 4px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-base);
    color: var(--text-primary);
    outline: none;
  }

  .inline-title:focus {
    border-color: var(--accent-primary);
  }

  .inline-body {
    width: 100%;
    min-height: 40px;
    font-size: 11px;
    padding: 4px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-base);
    color: var(--text-secondary);
    resize: vertical;
    outline: none;
    margin-top: 4px;
  }

  .inline-body:focus {
    border-color: var(--accent-primary);
  }

  .card-title {
    font-size: 13px;
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-body {
    margin-top: 4px;
    font-size: 11px;
    color: var(--text-secondary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .card-doc {
    margin-top: 6px;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--accent-primary);
    padding: 2px 0;
  }

  .inspector {
    flex: 1 1 auto;
    min-height: 0;
    background: var(--surface-raised);
    padding: 8px 12px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
  }

  .inspector-row {
    display: flex;
    gap: 6px;
    align-items: center;
  }

  .inspector-title {
    flex: 1;
    height: 30px;
  }

  .inspector-body {
    resize: vertical;
    min-height: 60px;
    font-size: 12px;
  }

  .inspector-row select,
  .doc-search {
    height: 30px;
    font-size: 12px;
  }

  .doc-search {
    flex: 1;
  }

  .mini-btn {
    height: 30px;
    padding: 0 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .mini-btn:hover {
    color: var(--text-primary);
    background: var(--surface-overlay);
  }

  .doc-results {
    display: flex;
    flex-direction: column;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .doc-result {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 10px;
    font-size: 12px;
    text-align: left;
  }

  .doc-result:hover {
    background: var(--surface-overlay);
  }

  .doc-result-ws {
    color: var(--text-muted);
    font-size: 11px;
  }
</style>
