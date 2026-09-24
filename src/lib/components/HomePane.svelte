<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Doc } from "$lib/api";
  import { currentDoc, openTabs, currentWorkspace, showSettings } from "$lib/stores/app";
  import { openSettingsAt } from "$lib/stores/settings";
  import { smartTasks, openTasks, addTask, toggleTask, removeTask } from "$lib/stores/uiState";
  import Icon from "$lib/components/Icon.svelte";
  import { domainError, warnOnce } from "$lib/errors";

  let recentDocs: [string, string, string][] = $state([]);
  let workspaceCounts: [string, number][] = $state([]);
  let writingDays: string[] = $state([]);
  let patterns: { peak_hour: string | null; most_active_workspace: { workspace: string; this_week: number; last_week: number } | null; momentum: number; avg_session_minutes: number } | null = $state(null);
  let goals: { id: string; title: string; workspace: string; goal_words: number; word_count: number; deadline: string | null }[] = $state([]);
  let pinnedDocs: Doc[] = $state([]);
  let suggestedDocs: Doc[] = $state([]);
  let greeting = $state("");
  let newTaskTitle = $state("");
  let atlasStars: { id: string; title: string; workspace: string; word_count: number; activity_score: number; updated_at: string }[] = $state([]);
  let atlasEligible = $state(false);
  let atlasCanvas: HTMLCanvasElement | null = $state(null);

  function submitTask() {
    if (!newTaskTitle.trim()) return;
    addTask(newTaskTitle, $currentWorkspace === "home" ? "inbox" : $currentWorkspace, $currentDoc?.id ?? "");
    newTaskTitle = "";
  }

  async function openPinned(doc: Doc) {
    $currentDoc = doc;
    if (!$openTabs.find((t) => t.id === doc.id)) $openTabs = [doc, ...$openTabs];
    $currentWorkspace = doc.workspace;
    await api.usageRecord(doc.id, "open").catch((e) => warnOnce("Home usage telemetry", e));
  }

  onMount(async () => {
    const hour = new Date().getHours();
    if (hour < 12) greeting = "Good morning";
    else if (hour < 17) greeting = "Good afternoon";
    else greeting = "Good evening";

    try {
      const [docs, counts, days, p, pinned, g] = await Promise.all([
        api.dashboardRecentDocs(8),
        api.dashboardWorkspaceCounts(),
        api.dashboardWritingDays(),
        api.dashboardPatterns(),
        api.docListPinned(),
        api.dashboardGoals(),
      ]);
      recentDocs = docs;
      workspaceCounts = counts;
      writingDays = days;
      patterns = p;
      pinnedDocs = pinned;
      goals = g;
      loadSuggestions(counts);

      // Atlas eligibility: 20+ writing days AND 30+ docs
      const allDocCount = counts.reduce((sum, [, c]) => sum + c, 0);
      atlasEligible = writingDays.length >= 20 && allDocCount >= 30;
      if (atlasEligible) {
        atlasStars = await api.atlasGetStars().catch(() => []);
      }
    } catch (e) {
      console.warn("Home dashboard load failed:", e);
    }
  });

  /**
   * Smart-tab suggestions: highest-activity docs from the busiest
   * workspaces, minus anything already open, pinned, or current.
   */
  async function loadSuggestions(counts: [string, number][]) {
    try {
      const topWs = counts
        .map(([ws]) => ws)
        .filter((ws) => ws !== "home")
        .slice(0, 3);
      const perWs = await Promise.all(topWs.map((ws) => api.memorySmartTabs(ws).catch(() => [] as Doc[])));
      const seen = new Set<string>([
        ...$openTabs.map((t) => t.id),
        ...pinnedDocs.map((d) => d.id),
        ...($currentDoc ? [$currentDoc.id] : []),
      ]);
      const merged: Doc[] = [];
      for (const list of perWs) {
        for (const d of list) {
          if (!seen.has(d.id)) {
            seen.add(d.id);
            merged.push(d);
          }
          if (merged.length >= 6) break;
        }
        if (merged.length >= 6) break;
      }
      suggestedDocs = merged;
    } catch {
      suggestedDocs = [];
    }
  }

  function heatOpacity(key: string): number {
    // Recency shading (not per-day intensity): the writing-days list has
    // no per-day counts, so later entries read brighter. The label below
    // says exactly this — brightness must never imply word counts.
    const idx = writingDays.indexOf(key);
    if (idx < 0) return 0;
    return 0.45 + (idx / Math.max(1, writingDays.length)) * 0.55;
  }

  function drawAtlas() {
    const canvas = atlasCanvas;
    if (!canvas || atlasStars.length === 0) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const W = canvas.width;
    const H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Simple layout: arrange stars in a spiral-like pattern based on activity_score
    const sorted = [...atlasStars].sort((a, b) => b.activity_score - a.activity_score);
    const cx = W / 2;
    const cy = H / 2;
    const positions: { x: number; y: number }[] = [];

    for (let i = 0; i < sorted.length; i++) {
      const angle = (i * 2.399) + (i * 0.618); // golden angle spiral
      const radius = 20 + Math.sqrt(i) * 28;
      positions.push({
        x: cx + Math.cos(angle) * radius,
        y: cy + Math.sin(angle) * radius,
      });
    }

    // Draw constellation lines between similar-workspace stars
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        if (sorted[i].workspace === sorted[j].workspace) {
          const dx = positions[i].x - positions[j].x;
          const dy = positions[i].y - positions[j].y;
          if (Math.sqrt(dx * dx + dy * dy) < 80) {
            ctx.beginPath();
            ctx.moveTo(positions[i].x, positions[i].y);
            ctx.lineTo(positions[j].x, positions[j].y);
            ctx.strokeStyle = "rgba(128, 128, 128, 0.15)";
            ctx.lineWidth = 0.5;
            ctx.stroke();
          }
        }
      }
    }

    // Draw stars
    const maxActivity = Math.max(1, ...sorted.map((s) => s.activity_score));
    for (let i = 0; i < sorted.length; i++) {
      const star = sorted[i];
      const pos = positions[i];
      const brightness = 0.3 + (star.activity_score / maxActivity) * 0.7;
      const size = 1.5 + (star.activity_score / maxActivity) * 2.5;

      ctx.beginPath();
      ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(200, 200, 220, ${brightness})`;
      ctx.fill();

      // Glow for high-activity stars
      if (star.activity_score > maxActivity * 0.6) {
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, size + 2, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(180, 180, 210, ${brightness * 0.2})`;
        ctx.fill();
      }

      // Label for top stars
      if (star.activity_score > maxActivity * 0.5 && sorted.length <= 30) {
        ctx.font = "9px sans-serif";
        ctx.fillStyle = `rgba(160, 160, 180, ${brightness * 0.8})`;
        ctx.textAlign = "center";
        ctx.fillText(star.title.slice(0, 18), pos.x, pos.y + size + 10);
      }
    }
  }

  $effect(() => {
    if (atlasStars.length > 0 && atlasCanvas) {
      // Set canvas size to container
      const container = atlasCanvas.parentElement;
      if (container) {
        atlasCanvas.width = container.clientWidth;
        atlasCanvas.height = container.clientHeight;
      }
      drawAtlas();
    }
  });

  const workspaceIcons: Record<string, string> = {
    map: "graph",
    canvas: "board",
    write: "pencil",
    novel: "book",
    script: "film",
    reader: "book-open",
    logs: "calendar",
    projects: "folder",
    inbox: "inbox",
    home: "home",
    craft: "chart",
    stats: "calendar",
    skills: "sparkle",
    properties: "table",
  };

  function workspaceLabel(ws: string): string {
    const labels: Record<string, string> = {
      map: "Node Map",
      canvas: "Canvas",
      novel: "Novel",
      script: "Script",
      reader: "Reader",
      logs: "Logs",
      inbox: "Inbox",
      properties: "Library",
      craft: "Craft",
      stats: "Stats",
      skills: "Tips",
    };
    return labels[ws] ?? ws;
  }

  function openWorkspace(ws: string) {
    if (ws === "craft" || ws === "stats" || ws === "skills") {
      openSettingsAt(ws as "craft" | "stats" | "skills");
      $showSettings = true;
      return;
    }
    $currentWorkspace = ws;
  }

  function formatDate(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    } catch {
      return iso;
    }
  }
</script>

<div class="home-pane">
  <header class="home-header">
    <h1>{greeting}</h1>
    <p class="home-sub">Welcome back to your writing vault.</p>
  </header>

  <div class="home-grid">
    <!-- Recent Documents -->
    <section class="home-section">
      <h2>Recent Documents</h2>
      {#if recentDocs.length === 0}
        <p class="empty">No documents yet. Start writing!</p>
      {:else}
        <ul class="recent-list">
          {#each recentDocs as [id, title, updatedAt]}
            <li>
              <button class="recent-item" onclick={async () => {
                try {
                  const doc = await api.docGet(id);
                  $currentDoc = doc;
                  if (!$openTabs.find(t => t.id === doc.id)) $openTabs = [doc, ...$openTabs];
                  $currentWorkspace = doc.workspace;
                } catch (e) {
                  domainError("Home", "couldn't open recent document", e);
                }
              }}>
                <span class="recent-title">{title}</span>
                <span class="recent-date">{formatDate(updatedAt)}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Pinned quick-launch -->
    {#if pinnedDocs.length > 0}
      <section class="home-section">
        <h2>Pinned</h2>
        <div class="pinned-grid">
          {#each pinnedDocs as doc}
            <button class="pinned-card" onclick={() => openPinned(doc)} title="Open {doc.title}">
              <span class="ws-icon"><Icon name={workspaceIcons[doc.workspace] ?? "files"} size={18} /></span>
              <span class="pinned-title">{doc.title}</span>
              {#if doc.locked}
                <span class="pinned-lock" title="Locked"><Icon name="lock" size={12} label="Locked" /></span>
              {/if}
            </button>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Tasks (lightweight, device-local) -->
    <section class="home-section">
      <h2>Tasks</h2>
      <div class="task-add">
        <input
          class="task-input"
          type="text"
          bind:value={newTaskTitle}
          placeholder="New task… (Enter to add)"
          aria-label="New task"
          onkeydown={(e) => { if (e.key === "Enter") submitTask(); }}
        />
        <button class="task-add-btn" onclick={submitTask} disabled={!newTaskTitle.trim()} aria-label="Add task">
          <Icon name="plus" size={14} />
        </button>
      </div>
      {#if $openTasks.length === 0}
        <p class="empty">No open tasks. Capture one above.</p>
      {:else}
        <ul class="recent-list">
          {#each $openTasks.slice(0, 8) as task}
            <li class="task-row">
              <button
                class="task-check"
                onclick={() => toggleTask(task.id)}
                title="Mark done"
                aria-label="Mark {task.title} done"
              >
                <Icon name="check" size={12} />
              </button>
              <span class="recent-title">{task.title}</span>
              <span class="recent-date">{task.workspace}</span>
              <button
                class="task-remove"
                onclick={() => removeTask(task.id)}
                title="Delete task"
                aria-label="Delete {task.title}"
              >
                ×
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Smart suggestions (activity-ranked) -->
    {#if suggestedDocs.length > 0}
      <section class="home-section">
        <h2>Pick Up Where You Left Off</h2>
        <ul class="recent-list">
          {#each suggestedDocs as doc}
            <li>
              <button class="recent-item" onclick={() => openPinned(doc)}>
                <span class="ws-icon"><Icon name={workspaceIcons[doc.workspace] ?? "files"} size={15} /></span>
                <span class="recent-title">{doc.title}</span>
                <span class="recent-date">{workspaceLabel(doc.workspace)}</span>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- Workspace Overview -->
    <section class="home-section">
      <h2>Workspaces</h2>
      {#if workspaceCounts.length === 0}
        <p class="empty">No documents in any workspace.</p>
      {:else}
        <div class="workspace-grid">
          {#each workspaceCounts as [ws, count]}
            <button class="workspace-card" onclick={() => openWorkspace(ws)} title={workspaceLabel(ws)} aria-label={workspaceLabel(ws)}>
              <span class="ws-icon"><Icon name={workspaceIcons[ws] ?? "files"} size={20} /></span>
              <span class="ws-name">{workspaceLabel(ws)}</span>
              <span class="ws-count">{count}</span>
            </button>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Writing Streak -->
    <section class="home-section">
      <h2>Writing Streak</h2>
      <div class="heatmap">
        {#each Array(90) as _, i}
          {@const heatDate = new Date()}
          {@const heatDateMs = heatDate.setDate(heatDate.getDate() - (89 - i))}
          {@const key = new Date(heatDateMs).toISOString().slice(0, 10)}
          {@const active = writingDays.includes(key)}
          <div
            class="heat-cell"
            class:active
            style={active ? `opacity: ${heatOpacity(key).toFixed(2)}` : undefined}
            title={key}
          ></div>
        {/each}
      </div>
      <p class="streak-label">
        {writingDays.length} of last 90 days with writing activity — brighter means more recent
      </p>
    </section>

    <!-- Patterns -->
    {#if patterns}
      <section class="home-section">
        <h2>Patterns</h2>
        <div class="patterns-grid">
          {#if patterns.peak_hour}
            <div class="pattern-card">
              <span class="pattern-label">Peak Writing Hour</span>
              <span class="pattern-value">{patterns.peak_hour}:00</span>
            </div>
          {/if}
          {#if patterns.most_active_workspace}
            <div class="pattern-card">
              <span class="pattern-label">Most Active Workspace</span>
              <span class="pattern-value">{workspaceLabel(patterns.most_active_workspace.workspace)}</span>
              <span class="pattern-delta">
                {patterns.most_active_workspace.this_week > patterns.most_active_workspace.last_week ? "↑" : "↓"}
                {Math.abs(patterns.most_active_workspace.this_week - patterns.most_active_workspace.last_week)} from last week
              </span>
            </div>
          {/if}
          <div class="pattern-card">
            <span class="pattern-label">Momentum</span>
            <span class="pattern-value" class:positive={patterns.momentum > 0} class:negative={patterns.momentum < 0}>
              {patterns.momentum > 0 ? "+" : ""}{patterns.momentum}%
            </span>
            <span class="pattern-delta">vs 4-week average</span>
          </div>
          {#if patterns.avg_session_minutes > 0}
            <div class="pattern-card">
              <span class="pattern-label">Avg Session</span>
              <span class="pattern-value">{Math.round(patterns.avg_session_minutes)} min</span>
            </div>
          {/if}
        </div>
      </section>
    {/if}

    <!-- Goals (read-only here — set per doc in the inspector's Goal & Deadline section) -->
    {#if goals.length > 0}
      <section class="home-section">
        <h2>Goals</h2>
        <p class="section-note">Tracked here, set per document in the inspector (Goal & Deadline).</p>
        <div class="goals-grid">
          {#each goals as goal}
            <div class="goal-card">
              <div class="goal-header">
                <span class="goal-title">{goal.title}</span>
                <span class="goal-workspace">{workspaceLabel(goal.workspace)}</span>
              </div>
              <div class="goal-progress">
                <div class="goal-bar">
                  <div class="goal-fill" style="width: {Math.min(100, Math.round((goal.word_count / goal.goal_words) * 100))}%"></div>
                </div>
                <span class="goal-text">{goal.word_count.toLocaleString()} / {goal.goal_words.toLocaleString()} words ({Math.min(100, Math.round((goal.word_count / goal.goal_words) * 100))}%)</span>
              </div>
              {#if goal.deadline}
                <div class="goal-deadline" class:overdue={new Date(goal.deadline) < new Date()}>
                  <Icon name="calendar" size={12} />
                  <span>{goal.deadline.slice(0, 10)}</span>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Atlas (star-sky memory) -->
    {#if atlasEligible && atlasStars.length > 0}
      <section class="home-section atlas-section">
        <h2>Atlas</h2>
        <div class="atlas-canvas-wrap">
          <canvas bind:this={atlasCanvas} class="atlas-canvas"></canvas>
        </div>
      </section>
    {:else}
      <section class="home-section atlas-section">
        <h2>Atlas</h2>
        <p class="section-note">Your vault as a star-sky unlocks at 20 writing days and 30 documents — currently {writingDays.length} days. Keep writing; it appears here on its own.</p>
      </section>
    {/if}
  </div>
</div>

<style>
  .home-pane {
    height: 100%;
    overflow-y: auto;
    padding: 32px 40px;
    background: var(--surface-base);
  }

  .home-header h1 {
    font-size: 28px;
    font-weight: 700;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .home-sub {
    font-size: 14px;
    color: var(--text-muted);
    margin: 0 0 28px;
  }

  .home-grid {
    display: flex;
    flex-direction: column;
    gap: 28px;
    max-width: 720px;
  }

  .home-section h2 {
    font-size: 13px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    margin: 0 0 10px;
  }

  .section-note {
    font-size: 12px;
    color: var(--text-muted);
    margin: 0 0 10px;
  }

  .empty {
    font-size: 13px;
    color: var(--text-muted);
    font-style: italic;
  }

  .recent-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .recent-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    padding: 8px 12px;
    border-radius: var(--radius-md);
    font-size: 13px;
    color: var(--text-primary);
    text-align: left;
    background: transparent;
    border: none;
  }

  .recent-item:hover {
    background: var(--surface-overlay);
  }

  .recent-date {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .task-add {
    display: flex;
    gap: 6px;
    margin-bottom: 8px;
  }

  .task-input {
    flex: 1;
    padding: 8px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: 13px;
  }

  .task-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 34px;
    border-radius: var(--radius-md);
    border: none;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    cursor: pointer;
  }

  .task-add-btn:disabled {
    opacity: 0.4;
    cursor: default;
  }

  .task-row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 8px 12px;
  }

  .task-check {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    border: 1px solid var(--border-subtle);
    background: transparent;
    color: transparent;
    cursor: pointer;
    flex-shrink: 0;
  }

  .task-check:hover {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }

  .task-remove {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }

  .task-remove:hover {
    color: var(--error);
  }

  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 8px;
  }

  .workspace-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    padding: 14px 8px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    cursor: pointer;
  }

  .workspace-card:hover {
    border-color: var(--accent-primary);
    background: var(--surface-overlay);
  }

  .ws-icon {
    font-size: 20px;
    color: var(--text-secondary);
  }

  .ws-name {
    font-size: 11px;
    color: var(--text-secondary);
  }

  .ws-count {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .pinned-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: 8px;
  }

  .pinned-card {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    color: var(--text-primary);
    cursor: pointer;
    min-width: 0;
  }

  .pinned-card:hover {
    border-color: var(--accent-primary);
    background: var(--surface-overlay);
  }

  .pinned-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    text-align: left;
  }

  .pinned-lock {
    display: inline-flex;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .heatmap {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
  }

  .heat-cell {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--surface-overlay);
  }

  .heat-cell.active {
    background: var(--accent-primary);
    opacity: 0.8;
  }

  .streak-label {
    font-size: 11px;
    color: var(--text-muted);
    margin: 8px 0 0;
  }

  .patterns-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 8px;
  }

  .pattern-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }

  .pattern-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }

  .pattern-value {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    font-family: var(--font-mono);
  }

  .pattern-value.positive { color: var(--success); }
  .pattern-value.negative { color: var(--error); }

  .pattern-delta {
    font-size: 11px;
    color: var(--text-muted);
  }

  .goals-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }

  .goal-card {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 16px;
    background: var(--surface-raised);
  }

  .goal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }

  .goal-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-weight: 600;
    font-size: 14px;
  }

  .goal-workspace {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    color: var(--text-muted);
    text-transform: uppercase;
    white-space: nowrap;
  }

  .goal-progress {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 8px;
  }

  .goal-bar {
    height: 8px;
    background: var(--surface-overlay);
    border-radius: var(--radius-full);
    overflow: hidden;
  }

  .goal-fill {
    height: 100%;
    background: var(--accent-primary);
    border-radius: var(--radius-full);
    transition: width 0.3s ease;
  }

  .goal-text {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .goal-deadline {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .goal-deadline.overdue {
    color: var(--error);
  }

  .atlas-section {
    min-height: 0;
  }

  .atlas-canvas-wrap {
    width: 100%;
    height: 320px;
    background: var(--surface-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    overflow: hidden;
  }

  .atlas-canvas {
    width: 100%;
    height: 100%;
  }
</style>
