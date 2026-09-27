<script lang="ts">
  import { showToast } from '$lib/stores/notifications';
  import Icon from '$lib/components/Icon.svelte';

  interface PluginManifest {
    id: string;
    name: string;
    version: string;
    minAppVersion: string;
    description: string;
    author: string;
    authorUrl?: string;
    isDesktopOnly: boolean;
  }

  interface Plugin {
    manifest: PluginManifest;
    enabled: boolean;
    installed: boolean;
  }

  let open = $state(false);
  let plugins = $state<Plugin[]>([
    {
      manifest: { id: 'markdown-export', name: 'Markdown Export', version: '1.0.0', minAppVersion: '0.1.0', description: 'Export documents as Markdown files with frontmatter support.', author: 'Just Write ehis', isDesktopOnly: false },
      enabled: true,
      installed: true,
    },
    {
      manifest: { id: 'word-count', name: 'Word Count', version: '1.0.0', minAppVersion: '0.1.0', description: 'Track word count statistics and writing streaks.', author: 'Just Write ehis', isDesktopOnly: false },
      enabled: true,
      installed: true,
    },
    {
      manifest: { id: 'auto-save', name: 'Auto Save', version: '1.0.0', minAppVersion: '0.1.0', description: 'Automatically save documents every 30 seconds.', author: 'Just Write ehis', isDesktopOnly: false },
      enabled: true,
      installed: true,
    },
    {
      manifest: { id: 'focus-timer', name: 'Focus Timer', version: '1.0.0', minAppVersion: '0.1.0', description: 'Pomodoro-style focus timer with session tracking.', author: 'Just Write ehis', isDesktopOnly: false },
      enabled: false,
      installed: true,
    },
    {
      manifest: { id: 'git-sync', name: 'Git Sync', version: '1.0.0', minAppVersion: '0.1.0', description: 'Sync documents with a Git repository for version control.', author: 'Just Write ehis', isDesktopOnly: true },
      enabled: false,
      installed: false,
    },
    {
      manifest: { id: 'template-library', name: 'Template Library', version: '1.0.0', minAppVersion: '0.1.0', description: 'Pre-built templates for novels, scripts, and academic papers.', author: 'Just Write ehis', isDesktopOnly: false },
      enabled: false,
      installed: false,
    },
  ]);

  function openPanel() { open = true; }
  function closePanel() { open = false; }

  function togglePlugin(plugin: Plugin) {
    plugin.enabled = !plugin.enabled;
    showToast(`${plugin.manifest.name} ${plugin.enabled ? 'enabled' : 'disabled'}`, 'success');
  }

  function installPlugin(plugin: Plugin) {
    plugin.installed = true;
    plugin.enabled = true;
    showToast(`${plugin.manifest.name} installed`, 'success');
  }

  function uninstallPlugin(plugin: Plugin) {
    plugin.installed = false;
    plugin.enabled = false;
    showToast(`${plugin.manifest.name} uninstalled`, 'info');
  }
</script>

<button class="plugin-trigger icon-btn" onclick={openPanel} title="Community Plugins" aria-label="Open plugin manager">
  <Icon name="puzzle" size={15} />
</button>

{#if open}
  <div class="plugin-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="plugin-panel" role="dialog" aria-label="Plugin manager">
      <div class="panel-header">
        <h2>Community Plugins</h2>
        <button class="close-btn" onclick={closePanel}>&times;</button>
      </div>
      <div class="plugin-list">
        {#each plugins as plugin}
          <div class="plugin-item" class:enabled={plugin.enabled} class:installed={plugin.installed}>
            <div class="plugin-info">
              <div class="plugin-name">{plugin.manifest.name}</div>
              <div class="plugin-desc">{plugin.manifest.description}</div>
              <div class="plugin-meta">
                <span>v{plugin.manifest.version}</span>
                <span>by {plugin.manifest.author}</span>
                {#if plugin.manifest.isDesktopOnly}
                  <span class="badge">Desktop</span>
                {/if}
              </div>
            </div>
            <div class="plugin-actions">
              {#if plugin.installed}
                <button class="plugin-toggle" class:on={plugin.enabled} onclick={() => togglePlugin(plugin)}>
                  {plugin.enabled ? 'Enabled' : 'Disabled'}
                </button>
                <button class="plugin-uninstall" onclick={() => uninstallPlugin(plugin)}>Uninstall</button>
              {:else}
                <button class="plugin-install" onclick={() => installPlugin(plugin)}>Install</button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .plugin-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .plugin-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .plugin-panel {
    width: min(600px, 90vw);
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

  .plugin-list {
    overflow-y: auto;
    padding: 16px 20px;
  }

  .plugin-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    margin-bottom: 8px;
    opacity: 0.6;
  }

  .plugin-item.installed {
    opacity: 1;
  }

  .plugin-item.enabled {
    border-color: var(--accent-primary);
  }

  .plugin-info {
    flex: 1;
  }

  .plugin-name {
    font-size: 14px;
    font-weight: var(--font-weight-semibold);
  }

  .plugin-desc {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .plugin-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 4px;
  }

  .badge {
    padding: 1px 6px;
    background: var(--surface-raised);
    border-radius: var(--radius-sm);
    font-size: 10px;
  }

  .plugin-actions {
    display: flex;
    gap: 8px;
  }

  .plugin-toggle, .plugin-install, .plugin-uninstall {
    padding: 6px 12px;
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
    border: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }

  .plugin-toggle.on {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .plugin-install {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .plugin-uninstall {
    color: var(--accent-semantic-red);
  }
</style>
