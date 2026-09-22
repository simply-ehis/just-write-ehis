<script lang="ts">
  import { currentDoc, openTabs, workspaces, currentWorkspace } from "$lib/stores/app";
  import { transferDocsToWorkspace } from "$lib/stores/uiState";
  import { globalLoading } from "$lib/stores/loading";
  import { api } from "$lib/api";
  import type { Doc } from "$lib/api";
  import Icon from "$lib/components/Icon.svelte";
  import { settings } from "$lib/stores/settings";
  import { hasPin, markLocked } from "$lib/stores/lock";
  import { showToast } from "$lib/stores/notifications";
  import { onMount } from "svelte";

  // Tab underlines track the app theme (see --ws-* in app.css).
  const wsAccents: Record<string, string> = {
    logs: "var(--ws-logs)", write: "var(--ws-write)", map: "var(--ws-map)",
    canvas: "var(--ws-canvas)",
    novel: "var(--ws-novel)", script: "var(--ws-script)", projects: "var(--ws-projects)",
    reader: "var(--ws-reader)", home: "var(--ws-home)",
    inbox: "var(--ws-inbox)", files: "var(--ws-files)",
    properties: "var(--ws-properties)",
  };

  function wsAccent(ws: string): string {
    return wsAccents[ws] || "var(--accent-primary)";
  }

  // Tab order is stable insertion order (manual drag-reorder included).
  // Opening, selecting, or re-visiting a doc NEVER reshuffles the strip:
  // activity scores still feed Home suggestions + smart tabs, but the tab
  // bar itself only changes when the user adds, closes, or drags a tab.
  // (Deliberate deviation from §8.2's score-sorting: visible shuffling on
  // open breaks spatial memory and was reported as a bug.)
  let draggedId = $state<string | null>(null);
  let dragOverId = $state<string | null>(null);
  let contextMenu = $state<{ doc: Doc; x: number; y: number } | null>(null);
  let pinnedIds = $state<Set<string>>(new Set());
  let tabContainer = $state<HTMLElement | null>(null);
  let showOverflow = $state(false);

  function selectTab(doc: Doc) {
    $currentDoc = doc;
    api.usageRecord(doc.id, "open").catch(console.error);
  }

  function closeTab(doc: Doc, event?: Event) {
    event?.stopPropagation();
    const idx = $openTabs.findIndex((t) => t.id === doc.id);
    $openTabs = $openTabs.filter((t) => t.id !== doc.id);
    pinnedIds.delete(doc.id);
    if ($currentDoc?.id === doc.id) {
      if ($openTabs.length > 0) {
        const nextIdx = Math.min(idx, $openTabs.length - 1);
        $currentDoc = $openTabs[nextIdx];
      } else {
        $currentDoc = null;
      }
    }
    contextMenu = null;
  }

  function closeOthers(doc: Doc) {
    $openTabs = $openTabs.filter((t) => t.id === doc.id || pinnedIds.has(t.id));
    if (!$openTabs.find(t => t.id === $currentDoc?.id)) {
      $currentDoc = doc;
    }
    contextMenu = null;
  }

  function closeAll() {
    $openTabs = $openTabs.filter(t => pinnedIds.has(t.id));
    if ($openTabs.length > 0) {
      $currentDoc = $openTabs[0];
    } else {
      $currentDoc = null;
    }
    contextMenu = null;
  }

  function closeToRight(doc: Doc) {
    const idx = $openTabs.findIndex(t => t.id === doc.id);
    const keep = $openTabs.filter((_, i) => i <= idx || pinnedIds.has($openTabs[i].id));
    $openTabs = keep;
    if (!$openTabs.find(t => t.id === $currentDoc?.id)) {
      $currentDoc = doc;
    }
    contextMenu = null;
  }

  function togglePin(doc: Doc) {
    if (pinnedIds.has(doc.id)) {
      pinnedIds.delete(doc.id);
    } else {
      pinnedIds.add(doc.id);
    }
    pinnedIds = new Set(pinnedIds);
    contextMenu = null;
  }

  function refreshDocInStores(updated: Partial<Doc> & { id: string }) {
    if ($currentDoc?.id === updated.id) $currentDoc = { ...$currentDoc, ...updated };
    $openTabs = $openTabs.map((t) => (t.id === updated.id ? { ...t, ...updated } : t));
  }

  async function toggleLock(doc: Doc) {
    if (!doc.locked && !(await hasPin())) {
      showToast("Set a PIN in Settings → Privacy & Security first", "warning");
      contextMenu = null;
      return;
    }
    try {
      await api.docSetLocked(doc.id, !doc.locked);
      if (!doc.locked) markLocked(doc.id);
      refreshDocInStores({ id: doc.id, locked: !doc.locked });
      showToast(!doc.locked ? `Locked "${doc.title}" — excluded from AI, search, and stats` : `Unlocked "${doc.title}"`, "success");
    } catch (e) {
      showToast(`Lock failed: ${e instanceof Error ? e.message : e}`, "error");
    }
    contextMenu = null;
  }

  function handleMiddleClick(doc: Doc, event: MouseEvent) {
    if (event.button === 1) {
      event.preventDefault();
      closeTab(doc);
    }
  }

  function handleContextMenu(doc: Doc, event: MouseEvent) {
    event.preventDefault();
    event.stopPropagation();
    contextMenu = { doc, x: event.clientX, y: event.clientY };
  }

  function closeContextMenu() {
    contextMenu = null;
  }

  // Drag and drop reorder
  function handleDragStart(doc: Doc, event: DragEvent) {
    draggedId = doc.id;
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", doc.id);
    }
  }

  function handleDragOver(doc: Doc, event: DragEvent) {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragOverId = doc.id;
  }

  function handleDrop(targetDoc: Doc, event: DragEvent) {
    event.preventDefault();
    if (!draggedId || draggedId === targetDoc.id) {
      draggedId = null;
      dragOverId = null;
      return;
    }

    const fromIdx = $openTabs.findIndex(t => t.id === draggedId);
    const toIdx = $openTabs.findIndex(t => t.id === targetDoc.id);
    if (fromIdx === -1 || toIdx === -1) return;

    const newTabs = [...$openTabs];
    const [moved] = newTabs.splice(fromIdx, 1);
    newTabs.splice(toIdx, 0, moved);
    $openTabs = newTabs;

    draggedId = null;
    dragOverId = null;
  }

  function handleDragEnd() {
    draggedId = null;
    dragOverId = null;
  }

  function getTabTitle(doc: Doc): string {
    if (doc.title && doc.title !== "Untitled") return doc.title;
    return "Untitled";
  }

  function getWorkspaceLabel(doc: Doc): string {
    const labels: Record<string, string> = {
      home: "H", logs: "L", write: "W", map: "M", canvas: "C",
      novel: "N", script: "S", projects: "P", reader: "R", files: "F",
      inbox: "I", properties: "L", craft: "C", stats: "S", skills: "K",
    };
    return labels[doc.workspace] ?? doc.workspace[0]?.toUpperCase() ?? "?";
  }

  // Close context menu on outside click
  function handleDocClick() {
    if (contextMenu) contextMenu = null;
  }

  /** Cross-tab transfer: duplicate this tab's doc into another workspace. */
  async function sendCopyTo(workspaceId: string) {
    const target = contextMenu?.doc;
    contextMenu = null;
    if (!target) return;
    try {
      await transferDocsToWorkspace([target.id], workspaceId);
      showToast(`Copied "${target.title}" to ${workspaceId}`, "success");
    } catch (e) {
      showToast(`Couldn't copy tab: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function newTabDoc() {
    try {
      const doc = await api.docCreate($currentWorkspace === "home" ? "write" : $currentWorkspace, "doc", "Untitled");
      $currentDoc = doc;
      $openTabs = [doc, ...$openTabs];
    } catch (e) {
      showToast(`Couldn't create doc: ${e instanceof Error ? e.message : e}`, "error");
    }
  }
</script>

<svelte:window onclick={handleDocClick} onkeydown={(e) => { if (e.key === 'Escape') contextMenu = null; }} />

<div class="tab-bar" role="toolbar" aria-label="Open documents" tabindex="-1" bind:this={tabContainer}>
  <div class="loading-line" class:active={$globalLoading}></div>
  {#each $openTabs as doc (doc.id)}
    {@const isPinned = pinnedIds.has(doc.id)}
    {@const isDraggedOver = dragOverId === doc.id && draggedId !== doc.id}
    <button
      class="tab"
      class:active={$currentDoc?.id === doc.id}
      class:pinned={isPinned}
      class:drag-over={isDraggedOver}
      class:dragging={draggedId === doc.id}
      style={$currentDoc?.id === doc.id ? `border-bottom-color: ${wsAccent(doc.workspace)}` : undefined}
      draggable="true"
      onclick={() => selectTab(doc)}
      onmousedown={(e) => handleMiddleClick(doc, e)}
      oncontextmenu={(e) => handleContextMenu(doc, e)}
      ondragstart={(e) => handleDragStart(doc, e)}
      ondragover={(e) => handleDragOver(doc, e)}
      ondrop={(e) => handleDrop(doc, e)}
      ondragend={handleDragEnd}
    >
      <span class="ws-badge" title={doc.workspace}>{getWorkspaceLabel(doc)}</span>
      {#if doc.locked}
        <span class="lock-badge" title="Locked — excluded from AI, search, and stats"><Icon name="lock" size={10} label="Locked" /></span>
      {/if}
      <span class="tab-title">{getTabTitle(doc)}</span>
      {#if !isPinned}
        <span
          class="close"
          role="button"
          tabindex="-1"
          onclick={(e) => closeTab(doc, e)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') closeTab(doc, e); }}
          aria-label="Close tab"
        >
          &times;
        </span>
      {:else}
        <span class="pin-indicator" title="Pinned"><Icon name="pin" size={11} label="Pinned" /></span>
      {/if}
    </button>
  {/each}

  {#if $openTabs.length === 0}
    <div class="tab-placeholder">No open documents</div>
    <button class="new-tab-btn" onclick={newTabDoc} title="New document in this workspace" aria-label="New document">+ New</button>
  {/if}
</div>

<!-- Context menu -->
{#if contextMenu}
  <div
    class="context-menu"
    role="menu"
    tabindex="-1"
    style="left: {contextMenu.x}px; top: {contextMenu.y}px"
    onkeydown={(e) => { if (e.key === 'Escape') contextMenu = null; }}
  >
    <button role="menuitem" onclick={() => { closeTab(contextMenu!.doc); }}>Close</button>
    <button role="menuitem" onclick={() => { closeOthers(contextMenu!.doc); }}>Close Others</button>
    <button role="menuitem" onclick={() => { closeToRight(contextMenu!.doc); }}>Close to Right</button>
    <button role="menuitem" onclick={() => { closeAll(); }}>Close All</button>
    <div class="menu-divider" role="separator"></div>
    <button role="menuitem" onclick={() => { togglePin(contextMenu!.doc); }}>
      {pinnedIds.has(contextMenu!.doc.id) ? 'Unpin' : 'Pin'}
    </button>
    <button role="menuitem" onclick={() => { toggleLock(contextMenu!.doc); }} title="Locked docs stay out of AI context, search, and stats">
      {contextMenu!.doc.locked ? 'Unlock' : 'Lock'}
    </button>
    <div class="menu-divider" role="separator"></div>
    <div class="menu-label" role="presentation">Send a copy to…</div>
    {#each workspaces.filter((w) => w.id !== contextMenu!.doc.workspace) as ws}
      <button role="menuitem" onclick={() => { sendCopyTo(ws.id); }}>
        {ws.label}
      </button>
    {/each}
  </div>
{/if}

<style>
  .tab-bar {
    position: relative;
    display: flex;
    align-items: stretch;
    height: 36px;
    background: var(--surface-base);
    border-bottom: 1px solid var(--border-subtle);
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
  }

  .tab-bar::-webkit-scrollbar {
    display: none;
  }

  .loading-line {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 2px;
    background: var(--accent-primary);
    transform: scaleX(0);
    transform-origin: left;
    transition: transform 0.3s ease;
  }

  .loading-line.active {
    transform: scaleX(0.7);
    animation: loading-slide 1.5s ease-in-out infinite;
  }

  @keyframes loading-slide {
    0% { transform: scaleX(0); transform-origin: left; }
    50% { transform: scaleX(0.7); transform-origin: left; }
    50.01% { transform: scaleX(0.7); transform-origin: right; }
    100% { transform: scaleX(0); transform-origin: right; }
  }

  .tab {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 12px;
    height: 100%;
    min-width: 0;
    max-width: 200px;
    border: none;
    border-right: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
    transition: background 0.1s;
    position: relative;
  }

  .tab:hover {
    background: var(--surface-overlay);
  }

  .tab.active {
    background: var(--surface-raised);
    color: var(--text-primary);
    border-bottom: 2px solid var(--accent-primary);
    /* border-bottom-color overridden by inline style per workspace */
  }

  .tab.pinned {
    background: var(--surface-overlay);
    opacity: 0.8;
  }

  .tab.drag-over {
    border-left: 2px solid var(--accent-primary);
  }

  .tab.dragging {
    opacity: 0.5;
  }

  .ws-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 3px;
    background: var(--surface-overlay);
    color: var(--text-muted);
    font-size: 9px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .tab.active .ws-badge {
    background: var(--accent-primary);
    color: var(--text-on-accent);
  }

  .tab-title {
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  .close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 3px;
    font-size: 14px;
    line-height: 1;
    color: var(--text-muted);
    flex-shrink: 0;
    opacity: 0;
    transition: opacity 0.1s, background 0.1s;
  }

  .tab:hover .close {
    opacity: 1;
  }

  .close:hover {
    background: var(--accent-semantic-red);
    color: white;
  }

  .pin-indicator {
    font-size: 10px;
    opacity: 0.6;
    flex-shrink: 0;
  }

  .lock-badge {
    display: inline-flex;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .tab-placeholder {
    padding: 0 8px 0 16px;
    display: flex;
    align-items: center;
    color: var(--text-muted);
    font-size: 12px;
    font-style: italic;
  }

  .new-tab-btn {
    margin-left: 4px;
    padding: 4px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--text-secondary);
    white-space: nowrap;
  }

  .new-tab-btn:hover {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .context-menu {
    position: fixed;
    z-index: 1000;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
    padding: var(--space-1) 0;
    min-width: 160px;
  }

  .context-menu button {
    display: block;
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
  }

  .context-menu button:hover {
    background: var(--surface-overlay);
  }

  .menu-divider {
    height: 1px;
    background: var(--border-subtle);
    margin: var(--space-1) 0;
  }

  .menu-label {
    padding: 6px 12px 2px;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }
</style>
