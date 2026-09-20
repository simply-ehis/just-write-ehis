<script lang="ts">
  import { api } from "$lib/api";
  import { currentDoc, currentWorkspace } from "$lib/stores/app";
  import { saveState } from "$lib/stores/saveState";
  import Icon from "$lib/components/Icon.svelte";

  let wordCount = $derived($currentDoc?.word_count ?? 0);
  let stats = $state<{ totalDocs: number; totalWords: number; totalBacklinks: number } | null>(null);
  let streak = $state<[number, number] | null>(null);
  let rhythm = $state<[number, number][]>([]);

  async function loadStats() {
    try {
      const [docs, words, backlinks] = await api.docGetStats();
      stats = { totalDocs: docs, totalWords: words, totalBacklinks: backlinks };
      streak = await api.memoryGetStreak();
      rhythm = await api.dashboardTodayRhythm();
    } catch (e) {
      console.error('Failed to load stats:', e);
    }
  }

  $effect(() => {
    // Refresh stats (and today's rhythm) as the open doc changes.
    void $currentDoc?.id;
    loadStats();
  });

  /** Today's activity by hour as a tiny sparkline path (64x18). */
  let sparkPath = $derived.by(() => {
    const counts = rhythm.map(([, c]) => c);
    const max = Math.max(1, ...counts);
    const pts = counts.map((c, h) => {
      const x = (h / 23) * 62 + 1;
      const y = 16 - (c / max) * 14;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    return `M${pts.join(" L")}`;
  });
</script>

<div class="status-bar">
  <button class="item status-btn" onclick={() => window.dispatchEvent(new CustomEvent("open-command-palette"))} title="Command palette (Ctrl+K)" aria-label="Open command palette">
    <Icon name="search" size={12} />
    <span>Search</span>
  </button>
  <button class="item status-btn" onclick={() => window.dispatchEvent(new CustomEvent("open-quick-capture"))} title="Quick capture (Ctrl+Shift+F)" aria-label="Open quick capture">
    <Icon name="plus" size={12} />
    <span>Capture</span>
  </button>
  <div class="item" title="Words in current document">
    <Icon name="pencil" size={12} />
    <span>{wordCount.toLocaleString()} words</span>
  </div>
  <div class="item save-indicator" class:saving={$saveState === "saving"}>
    <span class="save-dot" class:pulse={$saveState === "saving"}></span>
    <span>{$saveState === "saving" ? "Saving..." : "Saved"}</span>
  </div>
  <div class="spacer"></div>
  {#if streak}
    <div class="item streak" title="Writing streak (days in a row)">
      <Icon name="star" size={12} />
      <span>{streak[0]} day streak</span>
      {#if rhythm.some(([, c]) => c > 0)}
        <svg class="sparkline" width="64" height="18" viewBox="0 0 64 18" aria-hidden="true">
          <title>Today's activity by hour</title>
          <path d={sparkPath} fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        </svg>
      {/if}
    </div>
  {/if}
  {#if stats}
    <div class="item" title="Total stats">
      <span>{stats.totalDocs} docs | {stats.totalWords.toLocaleString()} words</span>
    </div>
  {/if}
  <div class="item">
    <span>{$currentWorkspace}</span>
  </div>
  <div class="item">
    <span>v0.2.1</span>
  </div>
</div>

<style>
  .status-bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 4px 12px;
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-base);
    font-size: 11px;
    color: var(--text-muted);
    min-height: 24px;
  }

  .item {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .status-btn {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    color: var(--text-secondary);
    background: var(--surface-raised);
  }

  .status-btn:hover {
    color: var(--text-primary);
    border-color: var(--accent-primary);
  }

  .streak {
    color: var(--accent-primary);
  }

  .sparkline {
    opacity: 0.85;
    flex-shrink: 0;
  }

  .spacer {
    flex: 1;
  }

  .save-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    display: inline-block;
    transition: background 0.2s;
  }

  .save-indicator.saving .save-dot {
    background: var(--warning);
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  .save-dot.pulse {
    animation: pulse 1s ease-in-out infinite;
  }
</style>
