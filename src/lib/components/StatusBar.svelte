<script lang="ts">
  import { api, isBrowserPreview } from "$lib/api";
  import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";
  import { saveState } from "$lib/stores/saveState";
  import Icon from "$lib/components/Icon.svelte";
  import RhythmHeatmap from "$lib/components/RhythmHeatmap.svelte";
  import { settings } from "$lib/stores/settings";
  import { warnOnce } from "$lib/errors";
  import { showToast } from "$lib/stores/notifications";

  function openStats() {
    window.dispatchEvent(new CustomEvent("open-stats"));
  }

  function handleStatsKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      openStats();
    }
  }

  function handleWorkspaceKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      $currentWorkspace = 'write';
    }
  }

  const browserVoice = isBrowserPreview();
  let wordCount = $derived($currentDoc?.word_count ?? 0);
  let stats = $state<{ totalDocs: number; totalWords: number; totalBacklinks: number } | null>(null);
  let streak = $state<[number, number] | null>(null);
  let rhythm = $state<[number, number][]>([]);
  let statsTimer: ReturnType<typeof setTimeout> | null = null;

  async function loadStats() {
    try {
      const [docStats, streakResult, rhythmResult] = await Promise.all([
        api.docGetStats(),
        api.memoryGetStreak(),
        api.dashboardTodayRhythm(),
      ]);
      const [docs, words, backlinks] = docStats;
      stats = { totalDocs: docs, totalWords: words, totalBacklinks: backlinks };
      streak = streakResult;
      rhythm = rhythmResult;
    } catch (e) {
      warnOnce("Status bar stats", e);
    }
  }

  function scheduleLoadStats() {
    if (statsTimer) clearTimeout(statsTimer);
    statsTimer = setTimeout(loadStats, 800);
  }

  $effect(() => {
    void [$currentDoc?.id, $currentDoc?.word_count];
    scheduleLoadStats();
  });

  $effect(() => {
    $saveState;
    scheduleLoadStats();
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
  <div class="item" title="Words in current document — click for stats" role="button" tabindex="0" onclick={openStats} onkeydown={handleStatsKeydown}>
    <Icon name="pencil" size={12} />
    <span>{wordCount.toLocaleString()} words</span>
  </div>
  {#if $settings.rhythmHeatmapInStatusBar && $currentDoc?.content}
    <div class="item heatmap-item" title="Paragraph density">
      <RhythmHeatmap content={$currentDoc.content} height={10} />
    </div>
  {/if}
  <div class="item save-indicator" class:saving={$saveState === "saving"} class:error={$saveState === "error"}>
    <span class="save-dot" class:pulse={$saveState === "saving"}></span>
    <span>{$saveState === "saving" ? "Saving..." : $saveState === "error" ? "Save failed" : "Saved"}</span>
  </div>
  {#if browserVoice}
    <div class="item browser-badge" title="Voice features use your browser's speech APIs (no local models in web preview)">
      <Icon name="mic" size={12} />
      <span>Browser voice</span>
    </div>
  {/if}
  <div class="spacer"></div>
  {#if streak}
    <div class="item streak" title="Writing streak (days in a row) — click for stats" role="button" tabindex="0" onclick={openStats} onkeydown={handleStatsKeydown}>
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
    <div class="item" title="Total stats — click for details" role="button" tabindex="0" onclick={openStats} onkeydown={handleStatsKeydown}>
      <span>{stats.totalDocs} docs | {stats.totalWords.toLocaleString()} words</span>
    </div>
  {/if}
  <div class="item" role="button" tabindex="0" onclick={() => $currentWorkspace = 'write'} onkeydown={handleWorkspaceKeydown} title="Switch workspace">
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

  .browser-badge {
    color: var(--warning);
    border: 1px solid var(--warning);
    border-radius: var(--radius-sm);
    padding: 1px 6px;
    flex-shrink: 0;
  }

  .sparkline {
    opacity: 0.85;
    flex-shrink: 0;
  }

  .heatmap-item {
    width: 80px;
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
