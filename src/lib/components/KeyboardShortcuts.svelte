<script lang="ts">
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);

  const shortcuts = [
    { category: 'General', items: [
      { keys: 'Ctrl+K', desc: 'Command palette' },
      { keys: 'Ctrl+B', desc: 'Toggle sidebar' },
      { keys: 'Ctrl+J', desc: 'Toggle AI panel' },
      { keys: 'Ctrl+S', desc: 'Save document' },
      { keys: 'Ctrl+N', desc: 'New document' },
      { keys: 'Ctrl+O', desc: 'Open file' },
      { keys: 'Ctrl+F', desc: 'Find in document' },
      { keys: 'Ctrl+H', desc: 'Version history' },
    ]},
    { category: 'Navigation', items: [
      { keys: 'Alt+1-9', desc: 'Switch workspace' },
      { keys: 'Ctrl+Tab', desc: 'Next tab' },
      { keys: 'Ctrl+Shift+Tab', desc: 'Previous tab' },
      { keys: 'Ctrl+W', desc: 'Close tab' },
      { keys: 'Ctrl+T', desc: 'New tab' },
    ]},
    { category: 'Editor', items: [
      { keys: 'Ctrl+B', desc: 'Bold' },
      { keys: 'Ctrl+I', desc: 'Italic' },
      { keys: 'Ctrl+Shift+K', desc: 'Code block' },
      { keys: 'Ctrl+K', desc: 'Insert link' },
      { keys: 'Ctrl+Shift+L', desc: 'Toggle list' },
      { keys: 'Ctrl+/', desc: 'Comment' },
    ]},
    { category: 'Focus', items: [
      { keys: 'F11', desc: 'Focus mode' },
      { keys: 'Ctrl+Shift+F', desc: 'Fullscreen' },
      { keys: 'Ctrl+Shift+P', desc: 'Pomodoro timer' },
    ]},
  ];

  function openPanel() { open = true; }
  function closePanel() { open = false; }
</script>

<button class="shortcut-trigger icon-btn" onclick={openPanel} title="Keyboard Shortcuts" aria-label="Open keyboard shortcuts">
  <Icon name="keyboard" size={15} />
</button>

{#if open}
  <div class="shortcut-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="shortcut-panel" role="dialog" aria-label="Keyboard shortcuts" tabindex="-1">
      <div class="panel-header">
        <h2>Keyboard Shortcuts</h2>
        <button class="close-btn" onclick={closePanel}>&times;</button>
      </div>
      <div class="shortcut-list">
        {#each shortcuts as group}
          <div class="shortcut-group">
            <h3>{group.category}</h3>
            <div class="shortcut-items">
              {#each group.items as item}
                <div class="shortcut-item">
                  <span class="shortcut-desc">{item.desc}</span>
                  <kbd class="shortcut-keys">{item.keys}</kbd>
                </div>
              {/each}
            </div>
          </div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<style>
  .shortcut-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .shortcut-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .shortcut-panel {
    width: min(560px, 90vw);
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

  .shortcut-list {
    overflow-y: auto;
    padding: 16px 20px;
  }

  .shortcut-group {
    margin-bottom: 20px;
  }

  .shortcut-group h3 {
    font-size: 12px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .shortcut-items {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .shortcut-item {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 6px 0;
  }

  .shortcut-desc {
    font-size: 13px;
  }

  .shortcut-keys {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 2px 8px;
    color: var(--text-secondary);
  }
</style>
