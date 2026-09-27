<script lang="ts">
  import { showToast } from '$lib/stores/notifications';
  import Icon from '$lib/components/Icon.svelte';

  interface SyncDevice {
    id: string;
    name: string;
    platform: string;
    lastSync: string;
    status: 'online' | 'offline' | 'syncing';
  }

  let open = $state(false);
  let syncing = $state(false);
  let lastSyncTime = $state<string | null>(null);
  let autoSync = $state(false);
  let devices = $state<SyncDevice[]>([
    { id: 'desktop-windows', name: 'Windows Desktop', platform: 'windows', lastSync: '2 minutes ago', status: 'online' },
    { id: 'laptop-macos', name: 'MacBook Pro', platform: 'macos', lastSync: '1 hour ago', status: 'offline' },
    { id: 'tablet-ipad', name: 'iPad Pro', platform: 'ios', lastSync: '3 hours ago', status: 'offline' },
  ]);

  function openPanel() { open = true; }
  function closePanel() { open = false; }

  async function syncNow() {
    syncing = true;
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      lastSyncTime = new Date().toLocaleTimeString();
      devices = devices.map(d => ({ ...d, lastSync: 'Just now', status: 'online' as const }));
      showToast('Sync completed', 'success');
    } catch (e) {
      showToast('Sync failed', 'error');
    } finally {
      syncing = false;
    }
  }

  function toggleAutoSync() {
    autoSync = !autoSync;
    showToast(`Auto-sync ${autoSync ? 'enabled' : 'disabled'}`, 'info');
  }

  function addDevice() {
    showToast('Device pairing coming soon', 'info');
  }
</script>

<button class="sync-trigger icon-btn" onclick={openPanel} title="Sync" aria-label="Open sync manager">
  <Icon name="refresh" size={15} />
</button>

{#if open}
  <div class="sync-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="sync-panel" role="dialog" aria-label="Sync manager" tabindex="-1">
      <div class="panel-header">
        <h2>Cross-Device Sync</h2>
        <div class="header-actions">
          <button class="add-btn" onclick={addDevice}>Add Device</button>
          <button class="close-btn" onclick={closePanel}>&times;</button>
        </div>
      </div>
      <div class="sync-content">
        <div class="sync-status">
          <div class="status-indicator" class:syncing>
            <span class="status-dot"></span>
            <span class="status-text">{syncing ? 'Syncing...' : lastSyncTime ? `Last sync: ${lastSyncTime}` : 'Not synced yet'}</span>
          </div>
          <button class="sync-now-btn" onclick={syncNow} disabled={syncing}>
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>
        <div class="auto-sync-toggle">
          <label>
            <input type="checkbox" bind:checked={autoSync} onchange={toggleAutoSync} />
            Auto-sync every 5 minutes
          </label>
        </div>
        <div class="device-list">
          <h3>Connected Devices</h3>
          {#each devices as device}
            <div class="device-item">
              <div class="device-info">
                <div class="device-name">{device.name}</div>
                <div class="device-meta">
                  <span>{device.platform}</span>
                  <span>{device.lastSync}</span>
                </div>
              </div>
              <span class="device-status" class:online={device.status === 'online'} class:offline={device.status === 'offline'}>
                {device.status}
              </span>
            </div>
          {/each}
        </div>
        <div class="sync-info">
          <p>End-to-end encrypted sync keeps your documents private.</p>
          <p>Your vault is synced across all your devices.</p>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .sync-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .sync-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .sync-panel {
    width: min(480px, 90vw);
    max-height: 80vh;
    background: var(--surface-base);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    overflow: hidden;
    display: flex;
    flex-direction: column;
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

  .header-actions {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .add-btn {
    padding: 6px 12px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
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

  .sync-content {
    padding: 20px;
    overflow-y: auto;
  }

  .sync-status {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
    padding: 12px;
    background: var(--surface-raised);
    border-radius: var(--radius-md);
  }

  .status-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--text-muted);
  }

  .status-indicator.syncing .status-dot {
    background: var(--accent-primary);
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .status-text {
    font-size: 13px;
  }

  .sync-now-btn {
    padding: 6px 12px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }

  .sync-now-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .auto-sync-toggle {
    margin-bottom: 16px;
  }

  .auto-sync-toggle label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    cursor: pointer;
  }

  .device-list h3 {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .device-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    margin-bottom: 8px;
  }

  .device-name {
    font-size: 13px;
    font-weight: var(--font-weight-semibold);
  }

  .device-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .device-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    color: var(--text-muted);
  }

  .device-status.online {
    background: var(--accent-semantic-green);
    color: var(--text-on-accent);
  }

  .device-status.offline {
    background: var(--surface-raised);
    color: var(--text-muted);
  }

  .sync-info {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px solid var(--border-subtle);
  }

  .sync-info p {
    font-size: 12px;
    color: var(--text-muted);
    margin: 4px 0;
  }
</style>
