<script lang="ts">
  import { currentDoc } from '$lib/stores/app';
  import { showToast } from '$lib/stores/notifications';
  import { api } from '$lib/api';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);
  let tags = $state<string[]>([]);
  let newTag = $state('');
  let loading = $state(false);

  async function loadTags() {
    if (!$currentDoc) return;
    loading = true;
    try {
      tags = await api.getDocTags($currentDoc.id);
    } catch (e) {
      console.error('Failed to load tags:', e);
    } finally {
      loading = false;
    }
  }

  function openPanel() {
    open = true;
    loadTags();
  }

  function closePanel() {
    open = false;
    tags = [];
    newTag = '';
  }

  async function addTag() {
    const tag = newTag.trim().toLowerCase();
    if (!tag || !$currentDoc) return;
    if (tags.includes(tag)) {
      showToast('Tag already exists', 'warning');
      return;
    }
    try {
      await api.addDocTag($currentDoc.id, tag);
      tags = [...tags, tag];
      newTag = '';
      showToast(`Added tag "${tag}"`, 'success');
    } catch (e) {
      showToast(`Failed to add tag: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  async function removeTag(tag: string) {
    if (!$currentDoc) return;
    try {
      await api.removeDocTag($currentDoc.id, tag);
      tags = tags.filter(t => t !== tag);
      showToast(`Removed tag "${tag}"`, 'success');
    } catch (e) {
      showToast(`Failed to remove tag: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addTag();
    }
  }
</script>

<button class="tag-trigger icon-btn" onclick={openPanel} title="Document Tags" aria-label="Open tag manager">
  <Icon name="tag" size={15} />
</button>

{#if open}
  <div class="tag-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="tag-panel" role="dialog" aria-label="Document tags">
      <div class="panel-header">
        <h2>Document Tags</h2>
        <button class="close-btn" onclick={closePanel}>&times;</button>
      </div>
      <div class="tag-content">
        {#if loading}
          <div class="loading">Loading...</div>
        {:else}
          <div class="tag-input-row">
            <input
              type="text"
              bind:value={newTag}
              onkeydown={handleKeydown}
              placeholder="Add a tag..."
              class="tag-input"
            />
            <button class="add-tag-btn" onclick={addTag} disabled={!newTag.trim()}>Add</button>
          </div>
          <div class="tag-list">
            {#if tags.length === 0}
              <div class="empty">No tags yet</div>
            {:else}
              {#each tags as tag}
                <div class="tag-item">
                  <span class="tag-name">{tag}</span>
                  <button class="remove-tag-btn" onclick={() => removeTag(tag)}>&times;</button>
                </div>
              {/each}
            {/if}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .tag-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .tag-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .tag-panel {
    width: min(400px, 90vw);
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

  .tag-content {
    padding: 20px;
  }

  .loading {
    text-align: center;
    color: var(--text-muted);
    padding: 40px 0;
  }

  .tag-input-row {
    display: flex;
    gap: 8px;
    margin-bottom: 16px;
  }

  .tag-input {
    flex: 1;
    padding: 8px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 13px;
  }

  .add-tag-btn {
    padding: 8px 16px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }

  .add-tag-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .tag-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .empty {
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
    padding: 20px 0;
  }

  .tag-item {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: 12px;
  }

  .tag-name {
    color: var(--text-primary);
  }

  .remove-tag-btn {
    width: 18px;
    height: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 50%;
    background: transparent;
    border: none;
    color: var(--text-muted);
    font-size: 14px;
    cursor: pointer;
  }

  .remove-tag-btn:hover {
    background: var(--accent-semantic-red);
    color: var(--text-on-accent);
  }
</style>
