<script lang="ts">
  import { api } from "$lib/api";
  import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";
  import Icon from "./Icon.svelte";

  // Data state
  let reopenNeverFinish = $state<Array<{ doc: any; openCount: number; lastOpened: string }>>([]);
  let streakHeatmap = $state<{ date: string; words: number }[]>([]);
  let writingTimePatterns = $state<{ hour: number; count: number }[]>([]);
  let writingVelocity = $state<{ date: string; words: number }[]>([]);
  let productivityScore = $state<{ score: number; totalWords: number; totalDocs: number; activeDays: number; avgWords: number } | null>(null);
  let loading = $state(true);
  let activeTab = $state<'reopen' | 'streak' | 'patterns' | 'velocity'>('reopen');

  async function loadData() {
    loading = true;
    try {
      const [
        reopenData,
        streakData,
        patternsData,
        velocityData,
        productivityData
      ] = await Promise.all([
        api.getReopenNeverFinish?.() ?? Promise.resolve([]),
        api.dashboardStreakHeatmap?.() ?? Promise.resolve([]),
        api.dashboardWritingTimePatterns?.() ?? Promise.resolve([]),
        api.dashboardWritingVelocity?.() ?? Promise.resolve([]),
        api.dashboardProductivityScore?.() ?? Promise.resolve(null)
      ]);

      reopenNeverFinish = reopenData || [];
      streakHeatmap = streakData || [];
      writingTimePatterns = patternsData || [];
      writingVelocity = velocityData || [];
      productivityScore = productivityData;
    } catch (e) {
      console.error("Failed to load usage memory data:", e);
    } finally {
      loading = false;
    }
  }

  // $effect runs on mount and whenever the open doc/workspace changes.
  $effect(() => {
    if ($currentDoc || $currentWorkspace) {
      loadData();
    }
  });

  function openReopenedDoc(doc: { id: string; workspace: string }) {
    api.docGet(doc.id).then((d) => {
      $currentDoc = d;
      $currentWorkspace = d.workspace;
      openTabs.update((tabs) => (tabs.find((t) => t.id === d.id) ? tabs : [d, ...tabs]));
    }).catch(() => {});
  }

  let maxWords = $derived(streakHeatmap.reduce((m, d) => Math.max(m, d.words), 0));
  let maxPatternCount = $derived(writingTimePatterns.reduce((m, p) => Math.max(m, p.count), 0));
  let maxVelocityWords = $derived(writingVelocity.reduce((m, v) => Math.max(m, v.words), 0));
  let mostActiveHour = $derived.by(() => {
    let best = 0;
    for (const p of writingTimePatterns) {
      if (p.count > (writingTimePatterns[best]?.count ?? -1)) best = p.hour;
    }
    return best;
  });
  let totalSessions = $derived(writingTimePatterns.reduce((n, p) => n + p.count, 0));

  function formatDate(dateStr: string): string {
    return new Date(dateStr).toLocaleDateString();
  }

  function getStreakColor(count: number, max: number): string {
    if (count === 0) return "var(--surface-overlay)";
    const intensity = Math.min(count / Math.max(max, 1), 1);
    const hue = 120 - intensity * 120; // green to red
    return `hsl(${hue}, 70%, ${50 - intensity * 20}%)`;
  }

  function formatHour(h: number): string {
    return `${h.toString().padStart(2, '0')}:00`;
  }
</script>

<div class="usage-memory">
  <div class="usage-memory-header">
    <h2>Usage Memory</h2>
    <div class="tab-switcher">
      <button class={activeTab === 'reopen' ? 'active' : ''} onclick={() => activeTab = 'reopen'}>
        <Icon name="refresh" size={14} /> Reopen & Never Finish
      </button>
      <button class={activeTab === 'streak' ? 'active' : ''} onclick={() => activeTab = 'streak'}>
        <Icon name="calendar" size={14} /> Streak Heatmap
      </button>
      <button class={activeTab === 'patterns' ? 'active' : ''} onclick={() => activeTab = 'patterns'}>
        <Icon name="clock" size={14} /> Writing-Time Patterns
      </button>
      <button class={activeTab === 'velocity' ? 'active' : ''} onclick={() => activeTab = 'velocity'}>
        <Icon name="chart" size={14} /> Writing Velocity
      </button>
    </div>
  </div>

  {#if loading}
    <div class="loading-state">Loading usage memory...</div>
  {:else}
    {#if activeTab === 'reopen'}
      <div class="reopen-panel">
        {#if reopenNeverFinish.length === 0}
          <div class="empty-state">
            <Icon name="info" size={32} />
            <p>No docs found that you reopen but never finish.</p>
            <p class="hint">Open a doc multiple times without saving changes to see it here.</p>
          </div>
        {:else}
          <div class="reopen-list">
            {#each reopenNeverFinish as item}
              <div class="reopen-item">
                <div class="reopen-info">
                  <span class="reopen-title">{item.doc.title}</span>
                  <span class="reopen-meta">
                    Opened {item.openCount}× • Last opened {formatDate(item.lastOpened)} • {item.doc.workspace}
                  </span>
                </div>
                <div class="reopen-actions">
                  <button class="icon-btn" onclick={() => openReopenedDoc(item.doc)} title="Open" aria-label="Open document">
                    <Icon name="arrow-right" size={14} />
                  </button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {:else if activeTab === 'streak'}
      <div class="streak-panel">
        {#if productivityScore}
          <div class="streak-summary">
            <div class="streak-metric">
              <span class="metric-value">{productivityScore.score}</span>
              <span class="metric-label">Productivity Score</span>
            </div>
            <div class="streak-metric">
              <span class="metric-value">{productivityScore.totalWords.toLocaleString()}</span>
              <span class="metric-label">Total Words</span>
            </div>
            <div class="streak-metric">
              <span class="metric-value">{productivityScore.activeDays}</span>
              <span class="metric-label">Active Days</span>
            </div>
            <div class="streak-metric">
              <span class="metric-value">{productivityScore.avgWords.toLocaleString()}</span>
              <span class="metric-label">Avg Words/Day</span>
            </div>
          </div>
        {/if}
        <div class="streak-heatmap">
          {#if streakHeatmap.length === 0}
            <p class="empty-hint">No writing activity yet.</p>
          {:else}
            <div class="heatmap-grid">
              {#each streakHeatmap as day}
                <div 
                  class="heatmap-cell" 
                  style="background: {getStreakColor(day.words, maxWords)};"
                  title="{formatDate(day.date)}: {day.words} words"
                ></div>
              {/each}
            </div>
            <div class="heatmap-legend">
              <span>Less</span>
              <div class="legend-gradient"></div>
              <span>More</span>
            </div>
          {/if}
        </div>
      </div>
    {:else if activeTab === 'patterns'}
      <div class="patterns-panel">
        <h3>Writing Time Patterns (24h)</h3>
        <div class="pattern-chart">
          {#if writingTimePatterns.length === 0}
            <p class="empty-hint">No writing time data yet.</p>
          {:else}
            <div class="bar-chart">
              {#each writingTimePatterns as p}
                <div class="bar-item">
                  <div 
                    class="bar" 
                    style="height: {Math.max((p.count / maxPatternCount) * 100, 2)}%"
                    title="{formatHour(p.hour)}: {p.count} sessions"
                  ></div>
                  <span class="bar-label">{formatHour(p.hour)}</span>
                </div>
              {/each}
            </div>
          {/if}
        </div>
        <div class="pattern-stats">
          <p>Most active: {mostActiveHour}h</p>
          <p>Total sessions: {totalSessions}</p>
        </div>
      </div>
    {:else if activeTab === 'velocity'}
      <div class="velocity-panel">
        <h3>Writing Velocity (Last 7 Days)</h3>
        {#if writingVelocity.length === 0}
          <p class="empty-hint">No writing velocity data yet.</p>
        {:else}
          <div class="velocity-chart">
            {#each writingVelocity as v}
              <div class="velocity-day">
                <div 
                  class="velocity-bar" 
                  style="height: {Math.max((v.words / maxVelocityWords) * 100, 2)}%"
                  title="{formatDate(v.date)}: {v.words} words"
                ></div>
                <span class="velocity-label">{v.date.slice(5)}</span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .usage-memory {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--space-4);
    gap: var(--space-4);
  }

  .usage-memory-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid var(--border);
    padding-bottom: var(--space-3);
  }

  .usage-memory-header h2 {
    margin: 0;
    font-size: 18px;
  }

  .tab-switcher {
    display: flex;
    gap: var(--space-2);
    overflow-x: auto;
  }

  .tab-switcher button {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    transition: all 0.15s;
  }

  .tab-switcher button:hover {
    background: var(--surface-hover);
    color: var(--text-primary);
  }

  .tab-switcher button.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .loading-state {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
    color: var(--text-muted);
  }

  /* Reopen Panel */
  .reopen-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .reopen-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .reopen-info {
    flex: 1;
    min-width: 0;
  }

  .reopen-title {
    display: block;
    font-weight: 500;
    color: var(--text-primary);
    margin-bottom: 2px;
  }

  .reopen-meta {
    font-size: 11px;
    color: var(--text-muted);
  }

  .reopen-actions {
    display: flex;
    gap: var(--space-2);
  }

  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: var(--space-8);
    text-align: center;
    color: var(--text-muted);
  }

  .empty-state .hint {
    margin-top: var(--space-2);
    font-size: 12px;
    color: var(--text-muted);
  }

  /* Streak Panel */
  .streak-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .streak-summary {
    display: flex;
    gap: var(--space-4);
    flex-wrap: wrap;
  }

  .streak-metric {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    min-width: 120px;
  }

  .metric-value {
    font-size: 24px;
    font-weight: 700;
    color: var(--accent-primary);
  }

  .metric-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .streak-heatmap {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .heatmap-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(14px, 1fr));
    gap: 2px;
  }

  .heatmap-cell {
    aspect-ratio: 1;
    border-radius: 2px;
    transition: transform 0.1s;
  }

  .heatmap-cell:hover {
    transform: scale(1.5);
    z-index: 1;
  }

  .heatmap-legend {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 11px;
    color: var(--text-muted);
  }

  .legend-gradient {
    flex: 1;
    height: 8px;
    background: linear-gradient(90deg, var(--surface-overlay), var(--accent-semantic-red));
    border-radius: 4px;
  }

  /* Patterns Panel */
  .patterns-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .patterns-panel h3 {
    margin: 0;
    font-size: 14px;
  }

  .bar-chart {
    display: flex;
    align-items: flex-end;
    gap: 4px;
    height: 200px;
    padding: var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .bar-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    flex: 1;
    height: 100%;
    justify-content: flex-end;
    gap: 4px;
  }

  .bar {
    width: 100%;
    background: var(--accent-primary);
    border-radius: 2px 2px 0 0;
    transition: height 0.3s ease;
  }

  .bar-label {
    font-size: 9px;
    color: var(--text-muted);
    writing-mode: vertical-rl;
    text-orientation: mixed;
    white-space: nowrap;
  }

  .pattern-stats {
    display: flex;
    gap: var(--space-4);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .empty-hint {
    text-align: center;
    color: var(--text-muted);
    padding: var(--space-4);
  }

  /* Velocity Panel */
  .velocity-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .velocity-panel h3 {
    margin: 0;
    font-size: 14px;
  }

  .velocity-chart {
    display: flex;
    align-items: flex-end;
    gap: 8px;
    height: 180px;
    padding: var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
  }

  .velocity-day {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    height: 100%;
    gap: 4px;
  }

  .velocity-bar {
    width: 100%;
    background: linear-gradient(180deg, var(--accent-primary), #8FC7A9);
    border-radius: 2px 2px 0 0;
    transition: height 0.3s ease;
  }

  .velocity-label {
    font-size: 10px;
    color: var(--text-muted);
  }
</style>