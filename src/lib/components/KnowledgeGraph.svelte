<script lang="ts">
  import { onMount } from 'svelte';
  import { currentDoc } from '$lib/stores/app';
  import { api, type GraphQueryResult } from '$lib/api';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);
  let graphData = $state<GraphQueryResult | null>(null);
  let loading = $state(false);
  let selectedNode = $state<string | null>(null);
  let container = $state<HTMLDivElement | null>(null);
  let transform = $state({ x: 0, y: 0, k: 1 });
  let dragging = $state(false);
  let dragStart = $state({ x: 0, y: 0 });

  async function loadGraph() {
    if (!$currentDoc) return;
    loading = true;
    try {
      graphData = await api.graphQuery({});
      selectedNode = $currentDoc.id;
    } catch (e) {
      console.error('Graph load failed:', e);
    } finally {
      loading = false;
    }
  }

  function openPanel() {
    open = true;
    loadGraph();
  }

  function closePanel() {
    open = false;
    graphData = null;
    selectedNode = null;
  }

  function handleMouseDown(e: MouseEvent) {
    dragging = true;
    dragStart = { x: e.clientX - transform.x, y: e.clientY - transform.y };
  }

  function handleMouseMove(e: MouseEvent) {
    if (!dragging) return;
    transform.x = e.clientX - dragStart.x;
    transform.y = e.clientY - dragStart.y;
  }

  function handleMouseUp() {
    dragging = false;
  }

  function handleWheel(e: WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    transform.k = Math.max(0.1, Math.min(3, transform.k * delta));
  }

  function resetView() {
    transform = { x: 0, y: 0, k: 1 };
  }

  function handleCanvasKey(e: KeyboardEvent) {
    const step = 20;
    if (e.key === 'ArrowLeft') transform.x += step;
    else if (e.key === 'ArrowRight') transform.x -= step;
    else if (e.key === 'ArrowUp') transform.y += step;
    else if (e.key === 'ArrowDown') transform.y -= step;
    else if (e.key === '+' || e.key === '=') transform.k = Math.max(0.1, Math.min(3, transform.k * 1.1));
    else if (e.key === '-') transform.k = Math.max(0.1, Math.min(3, transform.k * 0.9));
    else if (e.key === '0') resetView();
    else return;
    e.preventDefault();
  }

  function handleNodeKey(e: KeyboardEvent, id: string) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      selectedNode = id;
    }
  }

  // Svelte compiles wheel listeners passive by default, which ignores
  // preventDefault (zoom would scroll the page too). Non-passive action:
  function zoomOnWheel(node: HTMLElement) {
    node.addEventListener('wheel', handleWheel, { passive: false });
    return {
      destroy() {
        node.removeEventListener('wheel', handleWheel);
      },
    };
  }

  function getNodeColor(node: { id: string; title: string }): string {
    if (node.id === selectedNode) return 'var(--accent-primary)';
    return 'var(--surface-raised)';
  }

  // O(1) endpoint lookup per edge (was find + indexOf per edge per render).
  let nodeIndexById = $derived(new Map((graphData?.nodes ?? []).map((n, i) => [n.id, i] as const)));

  function getNodeX(index: number, total: number): number {
    const angle = (2 * Math.PI * index) / total;
    return 200 + 150 * Math.cos(angle);
  }

  function getNodeY(index: number, total: number): number {
    const angle = (2 * Math.PI * index) / total;
    return 200 + 150 * Math.sin(angle);
  }
</script>

<button class="graph-trigger icon-btn" onclick={openPanel} title="Knowledge Graph" aria-label="Open knowledge graph">
  <Icon name="graph" size={15} />
</button>

{#if open}
  <div class="graph-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="graph-panel" role="dialog" aria-label="Knowledge graph" tabindex="-1">
      <div class="panel-header">
        <h2>Knowledge Graph</h2>
        <div class="header-actions">
          <button class="reset-btn" onclick={resetView} title="Reset view">Reset</button>
          <button class="close-btn" onclick={closePanel}>&times;</button>
        </div>
      </div>
      <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: custom pan/zoom canvas with full keyboard support (arrows pan, +/- zoom, 0 resets) and per-node buttons below -->
      <div class="graph-container"
        bind:this={container}
        role="application"
        aria-label="Knowledge graph canvas. Drag to pan, scroll to zoom. Arrow keys pan, plus and minus zoom, zero resets."
        tabindex="0"
        onmousedown={handleMouseDown}
        onmousemove={handleMouseMove}
        onmouseup={handleMouseUp}
        onmouseleave={handleMouseUp}
        use:zoomOnWheel
        onkeydown={handleCanvasKey}
      >
        {#if loading}
          <div class="loading">Loading graph...</div>
        {:else if graphData}
          <svg class="graph-svg" viewBox="0 0 400 400" style="transform: translate({transform.x}px, {transform.y}px) scale({transform.k})">
            {#each graphData.edges as edge}
              {@const sourceIdx = nodeIndexById.get(edge.source)}
              {@const targetIdx = nodeIndexById.get(edge.target)}
              {#if sourceIdx !== undefined && targetIdx !== undefined}
                {@const x1 = getNodeX(sourceIdx, graphData.nodes.length)}
                {@const y1 = getNodeY(sourceIdx, graphData.nodes.length)}
                {@const x2 = getNodeX(targetIdx, graphData.nodes.length)}
                {@const y2 = getNodeY(targetIdx, graphData.nodes.length)}
                <line x1={x1} y1={y1} x2={x2} y2={y2} stroke="var(--border-subtle)" stroke-width="1" />
                <text x={(x1 + x2) / 2} y={(y1 + y2) / 2} text-anchor="middle" class="edge-label">{edge.context_snippet?.slice(0, 20) ?? ''}</text>
              {/if}
            {/each}
            {#each graphData.nodes as node, i}
              {@const x = getNodeX(i, graphData.nodes.length)}
              {@const y = getNodeY(i, graphData.nodes.length)}
              <g transform="translate({x}, {y})" role="button" tabindex="0" aria-label={`Graph node ${node.title}`} onclick={() => selectedNode = node.id} onkeydown={(e) => handleNodeKey(e, node.id)} class="graph-node" class:selected={node.id === selectedNode}>
                <circle r="20" fill={getNodeColor(node)} stroke="var(--border-subtle)" stroke-width="1" />
                <text y="4" text-anchor="middle" class="node-label">{node.title?.slice(0, 8) ?? '?'}</text>
              </g>
            {/each}
          </svg>
        {:else}
          <div class="empty">No graph data available</div>
        {/if}
      </div>
      <div class="graph-legend">
        <span>Nodes: {graphData?.nodes.length ?? 0}</span>
        <span>Edges: {graphData?.edges.length ?? 0}</span>
      </div>
    </div>
  </div>
{/if}

<style>
  .graph-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .graph-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .graph-panel {
    width: min(800px, 90vw);
    height: min(600px, 80vh);
    background: var(--surface-base);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .panel-header h2 {
    font-family: var(--font-heading);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
  }

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .reset-btn {
    padding: 6px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }

  .close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 18px;
    cursor: pointer;
  }

  .graph-container {
    flex: 1;
    overflow: hidden;
    position: relative;
    cursor: grab;
  }

  .graph-container:active {
    cursor: grabbing;
  }

  .loading, .empty {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
  }

  .graph-svg {
    width: 100%;
    height: 100%;
  }

  .graph-node {
    cursor: pointer;
  }

  .graph-node:hover circle {
    stroke: var(--accent-primary);
    stroke-width: 2;
  }

  .graph-node.selected circle {
    stroke: var(--accent-primary);
    stroke-width: 2;
  }

  .graph-container:focus-visible,
  .graph-node:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: 2px;
  }

  .node-label {
    font-size: 8px;
    fill: var(--text-primary);
    pointer-events: none;
  }

  .edge-label {
    font-size: 6px;
    fill: var(--text-muted);
    pointer-events: none;
  }

  .graph-legend {
    display: flex;
    gap: 16px;
    padding: 12px 20px;
    border-top: 1px solid var(--border-subtle);
    font-size: 12px;
    color: var(--text-muted);
  }
</style>
