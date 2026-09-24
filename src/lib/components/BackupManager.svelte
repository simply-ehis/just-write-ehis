<script lang="ts">
  import { api } from '$lib/api';
  import { settings } from '$lib/stores/settings';
  import { domainError } from '$lib/errors';

  let backups = $state<[string, string, number][]>([]);
  let loading = $state(false);
  let creating = $state(false);
  let message = $state('');

  async function loadBackups() {
    loading = true;
    try {
      backups = await api.backupList();
    } catch (e) {
      domainError('Backup', "couldn't list backups", e);
    } finally {
      loading = false;
    }
  }

  async function createBackup() {
    creating = true;
    message = '';
    try {
      const path = await api.backupCreate();
      message = `Backup created: ${path.split(/[/\\]/).pop()}`;
      await loadBackups();
    } catch (e) {
      message = `Backup failed: ${e}`;
    } finally {
      creating = false;
    }
  }

  async function cleanupOldSnapshots() {
    try {
      const deleted = await api.snapshotDeleteOld($settings.snapshotRetentionDays);
      message = `Cleaned up ${deleted} old snapshots`;
    } catch (e) {
      message = `Cleanup failed: ${e}`;
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  loadBackups();
</script>

<div class="backup-manager">
  <div class="backup-actions">
    <button class="backup-btn" onclick={createBackup} disabled={creating}>
      {creating ? 'Creating...' : 'Create Backup Now'}
    </button>
    <button class="cleanup-btn" onclick={cleanupOldSnapshots}>
      Clean Old Snapshots (>{ $settings.snapshotRetentionDays } days)
    </button>
  </div>

  {#if message}
    <div class="backup-message">{message}</div>
  {/if}

  <div class="backup-list">
    <h4>Recent Backups</h4>
    {#if loading}
      <div class="empty">Loading...</div>
    {:else if backups.length === 0}
      <div class="empty">No backups yet. Create one to protect your work.</div>
    {:else}
      {#each backups as [name, date, size]}
        <div class="backup-item">
          <div class="backup-name">{name}</div>
          <div class="backup-meta">
            <span>{formatTime(date)}</span>
            <span>{formatSize(size)}</span>
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .backup-manager {
    padding: 12px 0;
  }

  .backup-actions {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }

  .backup-btn {
    padding: 8px 16px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }

  .backup-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .cleanup-btn {
    padding: 8px 16px;
    background: transparent;
    color: var(--text-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }

  .backup-message {
    padding: 8px 12px;
    background: var(--surface-overlay);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--accent-primary);
    margin-bottom: 12px;
  }

  .backup-list h4 {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .empty {
    padding: 16px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }

  .backup-item {
    padding: 10px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    margin-bottom: 6px;
  }

  .backup-name {
    font-size: 12px;
    font-weight: var(--font-weight-semibold);
    margin-bottom: 4px;
  }

  .backup-meta {
    display: flex;
    gap: 12px;
    font-size: 11px;
    color: var(--text-muted);
  }
</style>
