<script lang="ts">
  import { api } from '$lib/api';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);
  let totalDocs = $state(0);
  let totalWords = $state(0);
  let totalBacklinks = $state(0);
  let streakDays = $state(0);
  let loading = $state(false);

  async function loadStats() {
    loading = true;
    try {
      const [stats, writingDays] = await Promise.all([
        api.docGetStats(),
        api.dashboardWritingDays(),
      ]);
      totalDocs = stats[0];
      totalWords = stats[1];
      totalBacklinks = stats[2];

      const activeDays = new Set(writingDays);
      const day = new Date();
      day.setUTCHours(0, 0, 0, 0);
      const today = day.toISOString().slice(0, 10);
      if (!activeDays.has(today)) day.setUTCDate(day.getUTCDate() - 1);
      streakDays = 0;
      while (activeDays.has(day.toISOString().slice(0, 10))) {
        streakDays += 1;
        day.setUTCDate(day.getUTCDate() - 1);
      }
    } catch {
    } finally {
      loading = false;
    }
  }

  function openPanel() {
    open = true;
    loadStats();
  }

  function closePanel() {
    open = false;
  }

  function formatNumber(n: number): string {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return n.toLocaleString();
  }
</script>

<button class="analytics-trigger icon-btn" onclick={openPanel} title="Writing Analytics" aria-label="Open writing analytics">
  <Icon name="chart" size={15} />
</button>

{#if open}
  <div class="analytics-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="analytics-panel" role="dialog" aria-label="Writing analytics" tabindex="-1">
      <div class="panel-header">
        <h2>Writing Analytics</h2>
        <button class="close-btn" onclick={closePanel}>&times;</button>
      </div>
      <div class="analytics-content">
        {#if loading}
          <div class="loading">Loading...</div>
        {:else}
          <div class="stats-grid">
            <div class="stat-card">
              <span class="stat-number">{formatNumber(totalDocs)}</span>
              <span class="stat-label">Documents</span>
            </div>
            <div class="stat-card">
              <span class="stat-number">{formatNumber(totalWords)}</span>
              <span class="stat-label">Words in Library</span>
            </div>
            <div class="stat-card">
              <span class="stat-number">{formatNumber(totalBacklinks)}</span>
              <span class="stat-label">Backlinks</span>
            </div>
            <div class="stat-card">
              <span class="stat-number">{streakDays}</span>
              <span class="stat-label">Day Streak</span>
            </div>
          </div>
          <div class="analytics-hint">
            <p>Words in Library includes imported documents. Day Streak counts days with saved writing activity.</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .analytics-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .analytics-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .analytics-panel {
    width: min(480px, 90vw);
    background: var(--surface-base);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    overflow: hidden;
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

  .analytics-content {
    padding: 20px;
  }

  .loading {
    text-align: center;
    color: var(--text-muted);
    padding: 40px 0;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }

  .stat-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    padding: 16px;
    background: var(--surface-raised);
    border-radius: var(--radius-md);
  }

  .stat-number {
    font-size: 24px;
    font-weight: var(--font-weight-bold);
    color: var(--accent-primary);
  }

  .stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    margin-top: 4px;
  }

  .analytics-hint {
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .analytics-hint p {
    margin: 4px 0;
  }
</style>
