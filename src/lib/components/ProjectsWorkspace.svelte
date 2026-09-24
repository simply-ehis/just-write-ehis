<script lang="ts">
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { api, type Doc } from "$lib/api";
  import { currentDoc, openTabs, currentWorkspace } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import TrendlineChart from "./TrendlineChart.svelte";
  import Icon from "./Icon.svelte";
  import DocDetail from "./DocDetail.svelte";
  import DeleteButton from "./DeleteButton.svelte";
  import DockSplit from "./DockSplit.svelte";
  import BoardColumn from "./BoardColumn.svelte";
  import { statusColor, BOARD_STATUSES } from "$lib/status";
  import { domainError, warnOnce } from "$lib/errors";
  import WorkspaceError from "./WorkspaceError.svelte";

  let projects = $state<Doc[]>([]);
  let selectedProject = $state<Doc | null>(null);
  let childDocs = $state<Doc[]>([]);
  let wordTrend = $state<[string, number][]>([]);
  let aiSuggestion = $state("");
  let loading = $state(false);
  let viewMode = $state<'dashboard' | 'board'>('dashboard');
  let boardColumns = $state<Record<string, Doc[]>>({});
  // Task/project open for reading/editing (master-detail); null = boards.
  let editingDoc = $state<Doc | null>(null);
  let sidebarCollapsed = $state(false);

  function openForEdit(doc: Doc) {
    editingDoc = doc;
    $currentDoc = doc;
    if (!$openTabs.find((t) => t.id === doc.id)) {
      $openTabs = [doc, ...$openTabs];
    }
    api.usageRecord(doc.id, "open").catch((e) => warnOnce("Projects usage telemetry", e));
  }

  function closeDetail() {
    editingDoc = null;
  }

  function dropEditingIfGone(id: string) {
    if (editingDoc?.id === id) editingDoc = null;
    childDocs = childDocs.filter((d) => d.id !== id);
    for (const key of Object.keys(boardColumns)) {
      boardColumns[key] = (boardColumns[key] || []).filter((d) => d.id !== id);
    }
  }

  const statusOrder = BOARD_STATUSES;

  // Visible load failure for the list: never a fake-empty board.
  let projectsLoadError = $state<string | null>(null);
  async function loadProjects() {
    projectsLoadError = null;
    try {
      projects = await api.docListByWorkspace("projects");
    } catch (e) {
      projectsLoadError = e instanceof Error ? e.message : String(e);
      domainError("Projects", "couldn't load projects", e);
    }
  }

  async function selectProject(project: Doc) {
    selectedProject = project;
    loading = true;
    try {
      // Load child docs (docs whose parent_id is this project)
      const allDocs = await api.docListByWorkspace("projects");
      childDocs = allDocs.filter(d => d.parent_id === project.id);

      // Build word count trend from child docs
      wordTrend = childDocs
        .filter(d => d.word_count > 0)
        .sort((a, b) => new Date(a.updated_at).getTime() - new Date(b.updated_at).getTime())
        .map(d => [d.title, d.word_count]);

      // Build board columns by status
      boardColumns = {};
      for (const doc of childDocs) {
        const status = doc.status || 'idea';
        if (!boardColumns[status]) boardColumns[status] = [];
        boardColumns[status].push(doc);
      }

      // Open the project doc in editor
      $currentDoc = project;
      if (!$openTabs.find(t => t.id === project.id)) {
        $openTabs = [project, ...$openTabs];
      }
      await api.usageRecord(project.id, "open").catch((e) => warnOnce("Projects usage telemetry", e));
    } catch (e) {
      domainError("Projects", "couldn't load project details", e);
    }
    loading = false;
  }

  async function addTask() {
    if (!selectedProject) return;
    const title = `New Task`;
    try {
      const doc = await api.docCreate('projects', 'task', title, selectedProject.id, '', JSON.stringify({ status: 'idea' }));
      childDocs = [...childDocs, doc];
      const status = doc.status || 'idea';
      if (!boardColumns[status]) boardColumns[status] = [];
      boardColumns[status].push(doc);
    } catch (e) {
      domainError("Projects", "couldn't add task", e);
    }
  }

  async function createProject() {
    const title = `New Project`;
    try {
      const doc = await api.docCreate('projects', 'project', title, undefined, '', JSON.stringify({ status: 'active' }));
      projects = [...projects, doc];
      await selectProject(doc);
    } catch (e) {
      domainError("Projects", "couldn't create project", e);
    }
  }

  async function moveTask(doc: Doc, newStatus: string) {
    const oldStatus = doc.status || 'idea';
    if (oldStatus === newStatus) return;

    try {
      await api.docSave(doc.id, undefined, undefined, newStatus, undefined, undefined);
      // Update local state
      doc.status = newStatus;
      boardColumns[oldStatus] = (boardColumns[oldStatus] || []).filter(d => d.id !== doc.id);
      if (!boardColumns[newStatus]) boardColumns[newStatus] = [];
      boardColumns[newStatus].push(doc);
    } catch (e) {
      domainError("Projects", "couldn't move task", e);
    }
  }

  function totalWords(): number {
    return childDocs.reduce((sum, d) => sum + d.word_count, 0);
  }

  function progressPercent(): number {
    if (childDocs.length === 0) return 0;
    const done = childDocs.filter(d => ['final', 'done'].includes(d.status || '')).length;
    return Math.round((done / childDocs.length) * 100);
  }

  async function askAiSuggestion() {
    if (!selectedProject) return;
    try {
      const context = childDocs.map(d => `${d.title} (${d.status || 'idea'}, ${d.word_count}w)`).join('\n');
      const s = get(settings);
      const resp = await api.aiGenerate({
        prompt: `Project: ${selectedProject.title}\nTasks:\n${context}\n\nSuggest next steps for this project. Be concise.`,
        mode: 'chat',
        provider: s.mainModelEndpoint || undefined,
        model: s.mainModelName || undefined,
        api_key: s.apiKey || undefined,
      });
      aiSuggestion = resp.content;
    } catch (e) {
      aiSuggestion = 'AI unavailable. Configure a provider in Settings.';
    }
  }

  onMount(loadProjects);

  $effect(() => {
    if ($currentWorkspace === 'projects' && !selectedProject && projects.length > 0) {
      // Auto-select first project
    }
  });
</script>

<div class="projects-workspace" class:sidebar-collapsed={sidebarCollapsed}>
  {#if !sidebarCollapsed}
  <div class="projects-sidebar">
    <div class="sidebar-header">
      <span class="sidebar-title">Projects</span>
      <span class="sidebar-actions">
        <button class="add-btn" onclick={() => (sidebarCollapsed = true)} title="Hide project list — focus editor" aria-label="Hide project list">−</button>
        <button class="add-btn" onclick={createProject} title="New Project">+</button>
      </span>
    </div>
    <div class="project-list">
      {#if projectsLoadError}
        <WorkspaceError message={`Projects — couldn't load projects: ${projectsLoadError}`} onRetry={() => loadProjects()} />
      {/if}
      {#each projects as project}
        <button
          class="project-item"
          class:active={selectedProject?.id === project.id}
          onclick={() => selectProject(project)}
        >
          <span class="project-title">{project.title}</span>
          <span class="project-meta">{project.word_count}w</span>
        </button>
      {/each}
      {#if projects.length === 0}
        <div class="empty-list">No projects yet</div>
      {/if}
    </div>
  </div>
  {/if}

  <div class="projects-content">
    {#if sidebarCollapsed}
      <div class="board-collapsed-note">
        <button class="open-btn" onclick={() => (sidebarCollapsed = false)} title="Show project list" aria-label="Show project list">Show projects</button>
        <span>List hidden — editor has full width.</span>
      </div>
    {/if}
    {#if !selectedProject}
      <div class="empty-state">
        <div class="empty-icon"><Icon name="folder" size={44} /></div>
        <div class="empty-title">Projects</div>
        <div class="empty-desc">Select a project or create a new one.</div>
        <button class="create-btn" onclick={createProject}>New Project</button>
      </div>
    {:else if loading}
      <div class="empty-state">Loading...</div>
    {:else}
      <div class="project-header">
        <h1>{selectedProject.title}</h1>
        <div class="view-toggle">
          <button class:active={viewMode === 'dashboard'} onclick={() => viewMode = 'dashboard'}>Dashboard</button>
          <button class:active={viewMode === 'board'} onclick={() => viewMode = 'board'}>Board</button>
          <button class="ai-btn" onclick={askAiSuggestion}>AI Suggest</button>
          <button class="open-btn" onclick={() => selectedProject && openForEdit(selectedProject)} title="Open project notes in editor" aria-label="Open project notes in editor">Open</button>
          <DeleteButton
            doc={selectedProject}
            label="Delete project and its tasks"
            onDeleted={(id) => {
              dropEditingIfGone(id);
              selectedProject = null;
              projects = projects.filter((p) => p.id !== id);
            }}
          />
        </div>
      </div>

      <DockSplit
        storageKey="jwe-split-projects"
        topLabel="Project board height"
        hasBottom={!!editingDoc}
      >
        {#snippet top()}
      {#if viewMode === 'dashboard'}
        <div class="dashboard">
          <!-- Stats row -->
          <div class="stats-row">
            <div class="stat-card">
              <span class="stat-label">Tasks</span>
              <span class="stat-value">{childDocs.length}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Total Words</span>
              <span class="stat-value">{totalWords().toLocaleString()}</span>
            </div>
            <div class="stat-card">
              <span class="stat-label">Progress</span>
              <span class="stat-value">{progressPercent()}%</span>
            </div>
          </div>

          <!-- Progress bar -->
          <div class="progress-section">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {progressPercent()}%"></div>
            </div>
            <div class="progress-legend">
              {#each statusOrder as status}
                {@const count = childDocs.filter(d => (d.status || 'idea') === status).length}
                {#if count > 0}
                  <span class="legend-item">
                    <span class="legend-dot" style="background: {statusColor(status)}"></span>
                    {status}: {count}
                  </span>
                {/if}
              {/each}
            </div>
          </div>

          <!-- Word count trend -->
          {#if wordTrend.length >= 2}
            <div class="trend-section">
              <TrendlineChart data={wordTrend} label="Word Count by Task" color="var(--accent-primary)" />
            </div>
          {/if}

          <!-- AI suggestion -->
          {#if aiSuggestion}
            <div class="ai-section">
              <h3>AI Suggestion</h3>
              <div class="ai-content">{aiSuggestion}</div>
            </div>
          {/if}
        </div>
      {:else}
        <!-- Board view -->
        <div class="board-view">
          {#each statusOrder as status}
            <BoardColumn
              title={status.charAt(0).toUpperCase() + status.slice(1)}
              count={(boardColumns[status] || []).length}
              dotColor={statusColor(status)}
            >
              {#each (boardColumns[status] || []) as doc}
                <button class="task-card" onclick={() => openForEdit(doc)} title="Open task in editor" aria-label="Open {doc.title} in editor">
                  <div class="task-title">{doc.title}</div>
                  <div class="task-meta">
                    <span class="word-count">{doc.word_count}w</span>
                    {#if doc.deadline}
                      <span class="due" class:overdue={new Date(doc.deadline) < new Date()} title="Deadline (set in the inspector)">due {doc.deadline.slice(0, 10)}</span>
                    {/if}
                    <select class="status-select" value={doc.status || 'idea'} onchange={(e) => moveTask(doc, (e.target as HTMLSelectElement).value)}>
                      {#each statusOrder as s}
                        <option value={s}>{s}</option>
                      {/each}
                    </select>
                  </div>
                </button>
              {/each}
              {#snippet footer()}
                {#if status === 'idea'}
                  <button class="add-task-btn" onclick={addTask}>+ Task</button>
                {/if}
              {/snippet}
            </BoardColumn>
          {/each}
        </div>
      {/if}
        {/snippet}
        {#snippet bottom()}
      {#if editingDoc}
        <div class="project-dock">
          <DocDetail
            backLabel="Project"
            onBack={closeDetail}
            onDeleted={(id) => {
              dropEditingIfGone(id);
              if (selectedProject?.id === id) selectedProject = null;
              projects = projects.filter((p) => p.id !== id);
            }}
          />
        </div>
      {/if}
        {/snippet}
      </DockSplit>
    {/if}
  </div>
</div>

<style>
  .projects-workspace {
    display: flex;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .projects-sidebar {
    width: 240px;
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    flex-shrink: 0;
  }

  .sidebar-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .sidebar-actions {
    display: flex;
    gap: 4px;
  }

  .sidebar-title {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .add-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
  }

  .add-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .project-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
  }

  .project-item {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
  }

  .project-item:hover {
    background: var(--surface-overlay);
  }

  .project-item.active {
    background: var(--bg-active);
    color: var(--accent-primary);
  }

  .project-title {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .project-meta {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .empty-list {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    font-style: italic;
  }

  .projects-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    min-height: 0;
  }

  /* Docked editor: fills the DockSplit bottom slot. */
  .project-dock {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--surface-base);
  }

  .open-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .open-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .empty-state {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--text-muted);
  }

  .empty-icon {
    font-size: 48px;
    opacity: 0.5;
  }

  .empty-title {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--text-primary);
  }

  .empty-desc {
    font-size: var(--font-size-sm);
  }

  .create-btn {
    margin-top: var(--space-2);
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .create-btn:hover {
    opacity: 0.9;
  }

  .project-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .project-header h1 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
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

  .ai-btn {
    background: var(--accent-semantic-purple) !important;
    color: var(--text-on-accent) !important;
    border-color: var(--accent-semantic-purple) !important;
  }

  .dashboard {
    padding: var(--space-4);
    overflow-y: auto;
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    max-width: 720px;
  }

  .stats-row {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }

  .stat-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }

  .stat-value {
    font-size: 24px;
    font-weight: var(--font-weight-bold);
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .progress-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .progress-bar {
    height: 8px;
    background: var(--surface-overlay);
    border-radius: var(--radius-full);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-primary);
    border-radius: var(--radius-full);
    transition: width 0.3s ease;
  }

  .progress-legend {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }

  .legend-item {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    font-size: 11px;
    color: var(--text-muted);
  }

  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .trend-section {
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
  }

  .ai-section {
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
  }

  .ai-section h3 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin: 0 0 var(--space-2);
  }

  .ai-content {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    line-height: var(--line-height-relaxed);
    white-space: pre-wrap;
  }

  .board-view {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
    overflow-x: auto;
    flex: 1;
  }

  /* Column shell lives in BoardColumn.svelte now. */

  .task-card {
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

  .task-card:hover {
    border-color: var(--accent-primary);
  }

  .task-title {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-sm);
  }

  .task-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .word-count {
    font-size: 10px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .due {
    font-size: 10px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .due.overdue {
    color: var(--accent-semantic-red);
    font-weight: 600;
  }

  .status-select {
    font-size: 10px;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    background: var(--surface-base);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .add-task-btn {
    padding: var(--space-2);
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    cursor: pointer;
    text-align: center;
  }

  .add-task-btn:hover {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }
</style>
