<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Doc } from "$lib/api";
  import { currentDoc, openTabs } from "$lib/stores/app";
  import { settings, type SavedView } from "$lib/stores/settings";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "$lib/components/Icon.svelte";
  import DocDetail from "$lib/components/DocDetail.svelte";

  let allDocs = $state<Doc[]>([]);
  let filteredDocs = $state<Doc[]>([]);
  let loading = $state(false);
  let viewMode = $state<'table' | 'board' | 'calendar'>('table');
  let sortField = $state<'title' | 'workspace' | 'status' | 'word_count' | 'updated_at'>('updated_at');
  let sortDir = $state<'asc' | 'desc'>('desc');
  let filterWorkspace = $state<string>('all');
  let filterStatus = $state<string>('all');
  let boardGroupBy = $state<'workspace' | 'status'>('status');
  let searchQuery = $state('');
  let newViewName = $state('');
  let calCursor = $state(new Date());
  let calSelectedDay = $state<string | null>(null);
  // Doc open for reading/editing (master-detail); null = table/board/calendar.
  let openedDoc = $state<Doc | null>(null);

  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  function saveCurrentView() {
    const name = newViewName.trim();
    if (!name) return;
    const view: SavedView = {
      name, viewMode, filterWorkspace, filterStatus, searchQuery,
      sortField, sortDir, boardGroupBy,
    };
    $settings = {
      ...$settings,
      savedViews: [...$settings.savedViews.filter((v) => v.name !== name), view],
    };
    newViewName = "";
    showToast(`Saved view "${name}"`, "success");
  }

  function applyView(view: SavedView) {
    viewMode = view.viewMode;
    filterWorkspace = view.filterWorkspace;
    filterStatus = view.filterStatus;
    searchQuery = view.searchQuery;
    sortField = view.sortField as typeof sortField;
    sortDir = view.sortDir;
    boardGroupBy = view.boardGroupBy;
    applyFilters();
  }

  function deleteView(name: string) {
    $settings = { ...$settings, savedViews: $settings.savedViews.filter((v) => v.name !== name) };
  }

  /** Local day key (no UTC shift) for created_at timestamps. */
  function dayKey(iso: string): string {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }

  function calendarCells(): (string | null)[] {
    const year = calCursor.getFullYear();
    const month = calCursor.getMonth();
    const first = new Date(year, month, 1).getDay();
    const days = new Date(year, month + 1, 0).getDate();
    const cells: (string | null)[] = [];
    for (let i = 0; i < first; i++) cells.push(null);
    for (let d = 1; d <= days; d++) {
      cells.push(`${year}-${String(month + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
    }
    return cells;
  }

  function docsOnDay(day: string): Doc[] {
    return filteredDocs.filter((d) => dayKey(d.created_at) === day);
  }

  const statuses = ['draft', 'revised', 'final', 'done', 'idea', 'cut'];

  async function loadDocs() {
    loading = true;
    try {
      // Load docs from all workspaces
      const workspaces = ['logs', 'write', 'novel', 'script', 'projects', 'reader', 'inbox'];
      const results: Doc[] = [];
      for (const ws of workspaces) {
        try {
          const docs = await api.docListByWorkspace(ws);
          results.push(...docs);
        } catch {}
      }
      allDocs = results;
      applyFilters();
    } catch (e) {
      console.error("Failed to load docs:", e);
    }
    loading = false;
  }

  function applyFilters() {
    let docs = [...allDocs];

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      docs = docs.filter(d =>
        d.title.toLowerCase().includes(q) ||
        d.content.toLowerCase().includes(q)
      );
    }

    // Workspace filter
    if (filterWorkspace !== 'all') {
      docs = docs.filter(d => d.workspace === filterWorkspace);
    }

    // Status filter
    if (filterStatus !== 'all') {
      docs = docs.filter(d => (d.status || 'draft') === filterStatus);
    }

    // Sort
    docs.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'title': cmp = a.title.localeCompare(b.title); break;
        case 'workspace': cmp = a.workspace.localeCompare(b.workspace); break;
        case 'status': cmp = (a.status || '').localeCompare(b.status || ''); break;
        case 'word_count': cmp = a.word_count - b.word_count; break;
        case 'updated_at': cmp = new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime(); break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    filteredDocs = docs;
  }

  function toggleSort(field: typeof sortField) {
    if (sortField === field) {
      sortDir = sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      sortField = field;
      sortDir = 'asc';
    }
    applyFilters();
  }

  function getBoardGroups(): Map<string, Doc[]> {
    const groups = new Map<string, Doc[]>();
    const field = boardGroupBy;

    for (const doc of filteredDocs) {
      const key = field === 'status' ? (doc.status || 'draft') : doc.workspace;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(doc);
    }

    // Sort groups by status order or alphabetically
    const sorted = new Map([...groups.entries()].sort((a, b) => {
      if (field === 'status') {
        return statuses.indexOf(a[0]) - statuses.indexOf(b[0]);
      }
      return a[0].localeCompare(b[0]);
    }));

    return sorted;
  }

  function parseProperties(fmJson: string | null): Record<string, unknown> {
    if (!fmJson) return {};
    try { return JSON.parse(fmJson); } catch { return {}; }
  }

  async function openDoc(doc: Doc) {
    // In-place detail: no workspace jump, no context loss. Back returns here.
    openedDoc = doc;
    $currentDoc = doc;
    if (!$openTabs.find(t => t.id === doc.id)) {
      $openTabs = [doc, ...$openTabs];
    }
    await api.usageRecord(doc.id, "open");
  }

  function closeDetail() {
    openedDoc = null;
  }

  async function refreshAfterDelete(id: string) {
    openedDoc = null;
    allDocs = allDocs.filter((d) => d.id !== id);
    applyFilters();
  }

  function formatDate(iso: string): string {
    try {
      return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch { return iso; }
  }

  function statusColor(status: string): string {
    switch (status) {
      case 'draft': return 'var(--accent-primary)';
      case 'revised': return 'var(--accent-semantic-green)';
      case 'final': case 'done': return 'var(--accent-semantic-purple)';
      case 'cut': return 'var(--accent-semantic-red)';
      default: return 'var(--text-muted)';
    }
  }

  onMount(loadDocs);

  $effect(() => {
    applyFilters();
  });
</script>

<div class="properties-view">
  <div class="pv-header">
    <div class="header-left">
      <h1>All Documents</h1>
      <span class="doc-count">{filteredDocs.length} docs</span>
    </div>
    <div class="header-actions">
      <div class="view-toggle" role="group" aria-label="View mode">
        <button class:active={viewMode === 'table'} onclick={() => viewMode = 'table'} title="Table view" aria-label="Table view">
          <Icon name="table" size={14} /><span>Table</span>
        </button>
        <button class:active={viewMode === 'board'} onclick={() => viewMode = 'board'} title="Board view" aria-label="Board view">
          <Icon name="panel" size={14} /><span>Board</span>
        </button>
        <button class:active={viewMode === 'calendar'} onclick={() => viewMode = 'calendar'} title="Calendar view" aria-label="Calendar view">
          <Icon name="calendar" size={14} /><span>Calendar</span>
        </button>
      </div>
      <button class="refresh-btn icon-btn" onclick={loadDocs} disabled={loading} title="Refresh documents" aria-label="Refresh documents">
        <Icon name="refresh" size={15} />
      </button>
    </div>
  </div>

  <div class="pv-toolbar">
    <input
      class="search-input"
      bind:value={searchQuery}
      oninput={applyFilters}
      placeholder="Search docs..."
    />
    <select bind:value={filterWorkspace} onchange={applyFilters}>
      <option value="all">All Workspaces</option>
      <option value="logs">Logs</option>
      <option value="write">Write</option>
      <option value="novel">Novel</option>
      <option value="script">Script</option>
      <option value="projects">Projects</option>
      <option value="reader">Reader</option>
      <option value="inbox">Inbox</option>
    </select>
    <select bind:value={filterStatus} onchange={applyFilters}>
      <option value="all">All Statuses</option>
      {#each statuses as s}
        <option value={s}>{s}</option>
      {/each}
    </select>
    {#if viewMode === 'board'}
      <select bind:value={boardGroupBy} onchange={applyFilters}>
        <option value="status">Group by Status</option>
        <option value="workspace">Group by Workspace</option>
      </select>
    {/if}
    {#if viewMode === 'calendar'}
      <button class="month-btn" onclick={() => calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1)} title="Previous month" aria-label="Previous month">‹</button>
      <span class="month-label">{MONTHS[calCursor.getMonth()]} {calCursor.getFullYear()}</span>
      <button class="month-btn" onclick={() => calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1)} title="Next month" aria-label="Next month">›</button>
    {/if}
  </div>

  <div class="saved-views">
    {#each $settings.savedViews as view}
      <span class="saved-view">
        <button class="saved-apply" onclick={() => applyView(view)} title="Apply saved view">{view.name}</button>
        <button class="saved-delete" onclick={() => deleteView(view.name)} title="Delete saved view {view.name}" aria-label="Delete saved view {view.name}">×</button>
      </span>
    {/each}
    <input
      class="saved-name"
      bind:value={newViewName}
      placeholder="Save current as view…"
      aria-label="Saved view name"
      onkeydown={(e) => { if (e.key === "Enter") saveCurrentView(); }}
    />
    <button class="saved-save" onclick={saveCurrentView} disabled={!newViewName.trim()}>Save</button>
  </div>

  <div class="pv-content">
    {#if openedDoc}
      <div class="pv-detail">
        <DocDetail
          backLabel="All Documents"
          onBack={closeDetail}
          onDeleted={refreshAfterDelete}
        />
      </div>
    {:else if loading}
      <div class="empty-state">Loading...</div>
    {:else if filteredDocs.length === 0}
      <div class="empty-state">
        <div class="empty-icon"><Icon name="files" size={40} /></div>
        <div class="empty-title">No documents found</div>
      </div>
    {:else if viewMode === 'calendar'}
      <div class="calendar-view">
        <div class="cal-grid">
          {#each ["S", "M", "T", "W", "T", "F", "S"] as dow}
            <div class="cal-dow">{dow}</div>
          {/each}
          {#each calendarCells() as day}
            {#if day}
              {@const count = docsOnDay(day).length}
              <button
                class="cal-day"
                class:selected={calSelectedDay === day}
                class:has-docs={count > 0}
                onclick={() => calSelectedDay = calSelectedDay === day ? null : day}
                title="{day}: {count} doc{count === 1 ? '' : 's'}"
              >
                <span class="cal-num">{parseInt(day.slice(8))}</span>
                {#if count > 0}<span class="cal-count">{count}</span>{/if}
              </button>
            {:else}
              <div class="cal-empty"></div>
            {/if}
          {/each}
        </div>
        {#if calSelectedDay}
          <div class="cal-day-docs">
            <div class="cal-day-header">{calSelectedDay}</div>
            {#each docsOnDay(calSelectedDay) as doc}
              <button class="cal-doc" onclick={() => openDoc(doc)}>
                <span class="doc-title">{doc.title}</span>
                <span class="ws-tag">{doc.workspace}</span>
              </button>
            {:else}
              <div class="empty-state">Nothing created this day.</div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if viewMode === 'table'}
      <div class="table-wrap">
        <table class="doc-table">
          <thead>
            <tr>
              <th class="sortable" onclick={() => toggleSort('title')}>
                Title {sortField === 'title' ? (sortDir === 'asc' ? '&#9650;' : '&#9660;') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('workspace')}>
                Workspace {sortField === 'workspace' ? (sortDir === 'asc' ? '&#9650;' : '&#9660;') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('status')}>
                Status {sortField === 'status' ? (sortDir === 'asc' ? '&#9650;' : '&#9660;') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('word_count')}>
                Words {sortField === 'word_count' ? (sortDir === 'asc' ? '&#9650;' : '&#9660;') : ''}
              </th>
              <th class="sortable" onclick={() => toggleSort('updated_at')}>
                Modified {sortField === 'updated_at' ? (sortDir === 'asc' ? '&#9650;' : '&#9660;') : ''}
              </th>
            </tr>
          </thead>
          <tbody>
            {#each filteredDocs as doc}
              {@const props = parseProperties(doc.frontmatter_json)}
              <tr onclick={() => openDoc(doc)} class="clickable">
                <td class="title-cell">
                  <span class="doc-title">{doc.title}</span>
                  {#if Object.keys(props).length > 0}
                    <span class="props-badge">{Object.keys(props).length} props</span>
                  {/if}
                </td>
                <td><span class="ws-tag">{doc.workspace}</span></td>
                <td>
                  <span class="status-tag" style="color: {statusColor(doc.status || 'draft')}">
                    {doc.status || 'draft'}
                  </span>
                </td>
                <td class="num-cell">{doc.word_count.toLocaleString()}</td>
                <td class="date-cell">{formatDate(doc.updated_at)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {:else}
      <div class="board-view">
        {#each getBoardGroups() as [group, docs]}
          <div class="board-column">
            <div class="column-header">
              {#if boardGroupBy === 'status'}
                <span class="status-dot" style="background: {statusColor(group)}"></span>
              {/if}
              <span>{group}</span>
              <span class="column-count">{docs.length}</span>
            </div>
            {#each docs as doc}
              <button class="board-card" onclick={() => openDoc(doc)}>
                <div class="card-title">{doc.title}</div>
                <div class="card-meta">
                  <span class="ws-tag">{doc.workspace}</span>
                  <span class="word-count">{doc.word_count}w</span>
                </div>
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .properties-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .pv-header {
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

  .pv-header h1 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .doc-count {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
  }

  .header-actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .view-toggle {
    display: flex;
    gap: var(--space-1);
  }

  .view-toggle button {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .view-toggle button.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .month-btn {
    width: 28px;
    height: 28px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
    font-size: 15px;
  }

  .month-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .month-label {
    font-size: 13px;
    font-weight: 600;
    min-width: 130px;
    text-align: center;
  }

  .saved-views {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .saved-view {
    display: inline-flex;
    align-items: center;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    overflow: hidden;
    font-size: 12px;
  }

  .saved-apply {
    padding: 3px 8px 3px 12px;
    color: var(--text-secondary);
  }

  .saved-apply:hover {
    color: var(--accent-primary);
  }

  .saved-delete {
    padding: 3px 8px;
    color: var(--text-muted);
  }

  .saved-delete:hover {
    color: var(--accent-semantic-red);
  }

  .saved-name {
    height: 26px;
    font-size: 12px;
    width: 170px;
  }

  .saved-save {
    height: 26px;
    padding: 0 12px;
    font-size: 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-secondary);
  }

  .saved-save:hover:not(:disabled) {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  .saved-save:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .calendar-view {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 3px;
    max-width: 640px;
  }

  .cal-dow {
    font-size: 10px;
    color: var(--text-muted);
    text-align: center;
    padding: 2px 0;
  }

  .cal-day {
    position: relative;
    aspect-ratio: 1.4;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .cal-day:hover {
    background: var(--surface-overlay);
  }

  .cal-day.has-docs {
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }

  .cal-day.selected {
    background: var(--surface-pressed);
    border-color: var(--accent-primary);
  }

  .cal-count {
    position: absolute;
    right: 4px;
    bottom: 2px;
    font-size: 10px;
    color: var(--accent-primary);
    font-family: var(--font-mono);
  }

  .cal-empty {
    aspect-ratio: 1.4;
  }

  .cal-day-docs {
    margin-top: 12px;
    max-width: 640px;
  }

  .cal-day-header {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    margin-bottom: 6px;
  }

  .cal-doc {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 7px 10px;
    margin-bottom: 4px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: 12px;
    text-align: left;
  }

  .cal-doc:hover {
    border-color: var(--accent-primary);
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

  .pv-toolbar {
    display: flex;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }

  .search-input {
    flex: 1;
    min-width: 200px;
    height: 32px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .search-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .pv-toolbar select {
    height: 32px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .pv-content {
    flex: 1;
    overflow: auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .pv-detail {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    gap: var(--space-2);
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

  /* Table view */
  .table-wrap {
    overflow-x: auto;
  }

  .doc-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--font-size-sm);
  }

  .doc-table th {
    padding: var(--space-2) var(--space-3);
    text-align: left;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    border-bottom: 1px solid var(--border-subtle);
    white-space: nowrap;
    user-select: none;
  }

  .doc-table th.sortable {
    cursor: pointer;
  }

  .doc-table th.sortable:hover {
    color: var(--text-primary);
  }

  .doc-table td {
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-secondary);
  }

  .doc-table tr.clickable {
    cursor: pointer;
  }

  .doc-table tr.clickable:hover td {
    background: var(--surface-overlay);
  }

  .title-cell {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 300px;
  }

  .doc-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
    font-weight: 500;
  }

  .props-badge {
    font-size: 9px;
    padding: 1px 4px;
    border-radius: 3px;
    background: var(--surface-overlay);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .ws-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    color: var(--text-muted);
  }

  .status-tag {
    font-size: 11px;
    font-weight: 500;
  }

  .num-cell {
    font-family: var(--font-mono);
    text-align: right;
  }

  .date-cell {
    font-family: var(--font-mono);
    font-size: 11px;
  }

  /* Board view */
  .board-view {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
    overflow-x: auto;
    height: 100%;
  }

  .board-column {
    min-width: 260px;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .column-count {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .board-card {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .board-card:hover {
    border-color: var(--accent-primary);
  }

  .card-title {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-sm);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .word-count {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
