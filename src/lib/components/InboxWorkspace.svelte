<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Doc } from "$lib/api";
  import { currentDoc, openTabs } from "$lib/stores/app";
  import { capturePrefill, captureFocus } from "$lib/stores/capture";
  import Icon from "$lib/components/Icon.svelte";
  import QuickCaptureInput from "$lib/components/QuickCaptureInput.svelte";
  import DocDetail from "$lib/components/DocDetail.svelte";
  import DockSplit from "$lib/components/DockSplit.svelte";

  let inboxItems = $state<Doc[]>([]);
  let loading = $state(false);
  let quickCapture = $state("");
  let selectedIds = $state<Set<string>>(new Set());
  let bulkTarget = $state("logs");
  // Item open for reading/editing (master-detail); null = triage list.
  let viewing = $state<Doc | null>(null);
  let listCollapsed = $state(false);
  let captureInput = $state<HTMLInputElement | null>(null);
  // Last consumed focus request (monotonic counter from the capture store).
  let lastFocusSeen = $state(0);

  const triageTargets = ["logs", "write", "novel", "script", "projects", "reader"];

  async function loadInbox() {
    loading = true;
    try {
      const allDocs = await api.docListByWorkspace("inbox");
      inboxItems = allDocs.sort((a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
      );
    } catch (e) {
      console.error("Failed to load inbox:", e);
    }
    loading = false;
  }

  async function handleQuickCapture() {
    if (!quickCapture.trim()) return;
    try {
      const doc = await api.docCreate("inbox", "snippet", quickCapture.trim().slice(0, 80), undefined, quickCapture.trim());
      inboxItems = [doc, ...inboxItems];
      quickCapture = "";
    } catch (e) {
      console.error("Quick capture failed:", e);
    }
  }

  async function openItem(item: Doc) {
    $currentDoc = item;
    viewing = item;
    if (!$openTabs.find(t => t.id === item.id)) {
      $openTabs = [item, ...$openTabs];
    }
    await api.usageRecord(item.id, "open");
  }

  function closeDetail() {
    viewing = null;
  }

  async function moveItem(item: Doc, targetWorkspace: string) {
    try {
      // Triage = re-home the capture: recreate in the target workspace
      // (keeping body + frontmatter), then delete the inbox original.
      const newDoc = await api.docCreate(targetWorkspace, "doc", item.title, undefined, item.content, item.frontmatter_json ?? undefined);
      await api.docDelete(item.id);
      inboxItems = inboxItems.filter(i => i.id !== item.id);
      selectedIds.delete(item.id);
      selectedIds = new Set(selectedIds);
      if (viewing?.id === item.id) viewing = null;
      // The inbox original is gone: drop it from tabs, point at the new doc.
      $openTabs = $openTabs.filter((t) => t.id !== item.id);
      if ($currentDoc?.id === item.id) $currentDoc = newDoc;
      if (!$openTabs.find((t) => t.id === newDoc.id)) $openTabs = [newDoc, ...$openTabs];
    } catch (e) {
      console.error("Failed to move item:", e);
    }
  }

  async function deleteItem(item: Doc) {
    try {
      await api.docDelete(item.id);
      inboxItems = inboxItems.filter(i => i.id !== item.id);
      selectedIds.delete(item.id);
      selectedIds = new Set(selectedIds);
      $openTabs = $openTabs.filter((t) => t.id !== item.id);
      if (viewing?.id === item.id) {
        viewing = null;
        if ($currentDoc?.id === item.id) $currentDoc = $openTabs[0] ?? null;
      } else if ($currentDoc?.id === item.id) {
        $currentDoc = $openTabs[0] ?? null;
      }
    } catch (e) {
      console.error("Failed to delete item:", e);
    }
  }

  function toggleSelect(id: string) {
    if (selectedIds.has(id)) selectedIds.delete(id);
    else selectedIds.add(id);
    selectedIds = new Set(selectedIds);
  }

  function toggleSelectAll() {
    selectedIds = selectedIds.size === inboxItems.length
      ? new Set()
      : new Set(inboxItems.map(i => i.id));
  }

  async function bulkMove() {
    const targets = inboxItems.filter(i => selectedIds.has(i.id));
    for (const item of targets) await moveItem(item, bulkTarget);
    selectedIds = new Set();
  }

  async function bulkDelete() {
    const targets = inboxItems.filter(i => selectedIds.has(i.id));
    for (const item of targets) await deleteItem(item);
    selectedIds = new Set();
  }

  function timeAgo(dateStr: string): string {
    const now = Date.now();
    const then = new Date(dateStr).getTime();
    const diff = now - then;
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  onMount(() => {
    loadInbox();
  });

  // Launch handoff: prefill queued by share target / shortcuts /
  // notification taps is appended once, then a focus request focuses the box.
  $effect(() => {
    const pre = $capturePrefill;
    if (pre) {
      quickCapture = quickCapture ? quickCapture + "\n" + pre : pre;
      capturePrefill.set("");
    }
    const f = $captureFocus;
    if (f !== lastFocusSeen) {
      lastFocusSeen = f;
      captureInput?.focus();
    }
  });
</script>

<div class="inbox-workspace">
  <div class="inbox-header">
    <div class="header-left">
      {#if inboxItems.length > 0}
        <input
          type="checkbox"
          class="select-all"
          checked={selectedIds.size === inboxItems.length && inboxItems.length > 0}
          onchange={toggleSelectAll}
          title="Select all"
          aria-label="Select all inbox items"
        />
      {/if}
      <h1>Inbox</h1>
      <span class="item-count">{inboxItems.length} items</span>
      {#if viewing}
        <button class="bulk-btn" onclick={() => (listCollapsed = !listCollapsed)} title={listCollapsed ? "Show list" : "Focus editor — hide list"} aria-pressed={listCollapsed}>
          {listCollapsed ? "Show list" : "Focus editor"}
        </button>
      {/if}
    </div>
    <button class="refresh-btn" onclick={loadInbox} disabled={loading} title="Refresh inbox" aria-label="Refresh inbox">
      <Icon name="refresh" size={15} />
    </button>
  </div>

  {#if selectedIds.size > 0}
    <div class="bulk-bar">
      <span class="bulk-count">{selectedIds.size} selected</span>
      <select bind:value={bulkTarget} title="Move target workspace" aria-label="Move target workspace">
        {#each triageTargets as ws}
          <option value={ws}>{ws}</option>
        {/each}
      </select>
      <button class="bulk-btn" onclick={bulkMove} title="Move selected to workspace">
        <Icon name="send" size={13} /><span>Move</span>
      </button>
      <button class="bulk-btn danger" onclick={bulkDelete} title="Delete selected">
        <Icon name="trash" size={13} /><span>Delete</span>
      </button>
      <button class="bulk-btn ghost" onclick={() => selectedIds = new Set()} title="Clear selection" aria-label="Clear selection">
        <Icon name="x" size={13} />
      </button>
    </div>
  {/if}

  {#if !viewing}
  <div class="quick-capture">
    <QuickCaptureInput
      bind:value={quickCapture}
      bind:inputRef={captureInput}
      placeholder="Quick capture... (Enter to save to inbox)"
      disabled={loading}
      webFallback={true}
      onSubmit={handleQuickCapture}
    />
  </div>
  {/if}

  <DockSplit
    storageKey="jwe-split-inbox"
    topLabel="Inbox list height"
    hasBottom={!!viewing}
    topCompact={listCollapsed && !!viewing}
  >
    {#snippet top()}
  <div class="inbox-list" class:collapsed-list={listCollapsed && viewing}>
    {#if listCollapsed && viewing}
      <div class="board-collapsed-note">
        <span>List hidden — editor has full height.</span>
        <button class="bulk-btn" onclick={() => (listCollapsed = false)}>Show list</button>
      </div>
    {:else if loading}
      <div class="empty-state">Loading...</div>
    {:else if inboxItems.length === 0}
      <div class="empty-state">
        <div class="empty-icon"><Icon name="inbox" size={44} /></div>
        <div class="empty-title">Inbox is empty</div>
        <div class="empty-desc">Capture quick ideas here. Triage them into your workspaces later.</div>
      </div>
    {:else}
      {#each inboxItems as item}
        <div class="inbox-item" class:selected={selectedIds.has(item.id)}>
          <input
            type="checkbox"
            class="select-box"
            checked={selectedIds.has(item.id)}
            onchange={() => toggleSelect(item.id)}
            onclick={(e) => e.stopPropagation()}
            title="Select item"
            aria-label="Select {item.title}"
          />
          <div class="item-content" role="button" tabindex="0" onclick={() => openItem(item)} onkeydown={(e) => { if (e.key === 'Enter') openItem(item); }}>
            <div class="item-title">
              {#if item.locked}<span class="inline-lock" title="Locked"><Icon name="lock" size={11} /></span>{/if}
              {item.title}
            </div>
            {#if item.locked}
              <div class="item-preview locked-hint">Locked — content hidden until unlocked.</div>
            {:else if item.content}
              <div class="item-preview">{item.content.slice(0, 120)}{item.content.length > 120 ? '...' : ''}</div>
            {/if}
            <div class="item-meta">
              <span class="item-time">{timeAgo(item.created_at)}</span>
              <span class="item-words">{item.word_count}w</span>
            </div>
          </div>
          <div class="item-actions">
            <select
              class="move-select"
              value=""
              onchange={(e) => { const t = (e.target as HTMLSelectElement).value; if (t) { moveItem(item, t); (e.target as HTMLSelectElement).value = ""; } }}
              title="Move to workspace"
              aria-label="Move {item.title} to workspace"
            >
              <option value="" disabled>Move to…</option>
              {#each triageTargets as ws}
                <option value={ws}>{ws}</option>
              {/each}
            </select>
            <button class="action-btn delete" onclick={() => deleteItem(item)} title="Delete" aria-label="Delete"><Icon name="trash" size={15} /></button>
          </div>
        </div>
      {/each}
    {/if}
  </div>
    {/snippet}
    {#snippet bottom()}
  {#if viewing}
    <div class="inbox-dock">
      <DocDetail
        backLabel="Inbox"
        onBack={closeDetail}
        onDeleted={(id) => {
          inboxItems = inboxItems.filter((i) => i.id !== id);
          selectedIds.delete(id);
          selectedIds = new Set(selectedIds);
          viewing = null;
        }}
      />
    </div>
  {/if}
    {/snippet}
  </DockSplit>
</div>

<style>
  .inbox-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  /* Docked editor: fills the DockSplit bottom slot. */
  .inbox-dock {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--surface-base);
  }

  .inbox-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .header-left {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .inbox-header h1 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .item-count {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .refresh-btn {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-secondary);
    font-size: 16px;
    cursor: pointer;
  }

  .refresh-btn:hover {
    background: var(--surface-overlay);
  }

  .quick-capture {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .inbox-list {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-2);
  }

  .inbox-list.collapsed-list {
    flex: 0 0 auto;
    max-height: none;
    padding: 0;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: var(--space-2);
    padding: var(--space-8);
    text-align: center;
  }

  .empty-icon {
    font-size: 48px;
    opacity: 0.4;
  }

  .empty-title {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .empty-desc {
    font-size: var(--font-size-sm);
    max-width: 300px;
  }

  .inbox-item {
    display: flex;
    align-items: stretch;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    margin-bottom: var(--space-2);
    background: var(--surface-raised);
    overflow: hidden;
  }

  .inbox-item.selected {
    border-color: var(--accent-primary);
  }

  .select-box,
  .select-all {
    accent-color: var(--accent-primary);
    width: 15px;
    height: 15px;
    flex-shrink: 0;
  }

  .select-box {
    margin: auto 0 auto var(--space-2);
  }

  .bulk-bar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-overlay);
    font-size: var(--font-size-sm);
    flex-wrap: wrap;
  }

  .bulk-count {
    color: var(--text-secondary);
    margin-right: auto;
  }

  .bulk-bar select {
    height: 30px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .bulk-btn {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    height: 30px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .bulk-btn:hover {
    background: var(--surface-pressed);
  }

  .bulk-btn.danger {
    color: var(--accent-semantic-red);
  }

  .bulk-btn.ghost {
    padding: 0 var(--space-2);
  }

  .item-content {
    flex: 1;
    padding: var(--space-3);
    cursor: pointer;
    min-width: 0;
  }

  .item-content:hover {
    background: var(--surface-overlay);
  }

  .item-title {
    display: flex;
    align-items: center;
    gap: 5px;
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-1);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .inline-lock {
    display: inline-flex;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .item-preview.locked-hint {
    font-style: italic;
    color: var(--text-muted);
  }

  .item-preview {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin-bottom: var(--space-2);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    line-clamp: 2;
    overflow: hidden;
    line-height: var(--line-height-relaxed);
  }

  .item-meta {
    display: flex;
    gap: var(--space-3);
    font-size: 10px;
    color: var(--text-muted);
  }

  .item-actions {
    display: flex;
    align-items: center;
    gap: 4px;
    padding-right: var(--space-2);
  }

  .move-select {
    height: 30px;
    max-width: 110px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .action-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 var(--space-2);
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
    min-width: 36px;
  }

  .action-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .action-btn.delete:hover {
    color: var(--accent-semantic-red);
  }
</style>
