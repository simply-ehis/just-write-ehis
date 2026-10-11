<script lang="ts">
  import { SHORTCUT_GROUPS } from '$lib/shortcuts';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);

  const shortcuts = SHORTCUT_GROUPS;

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
