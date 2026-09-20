<script lang="ts">
  import { api } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";

  let { open = false, onClose }: { open: boolean; onClose: () => void } = $props();

  let oldTitle = $state("");
  let newTitle = $state("");
  let preview: [string, string, string][] = $state([]);
  let loading = $state(false);
  let renamed = $state(false);
  let renamedCount = $state(0);

  async function loadPreview() {
    if (!oldTitle.trim()) { preview = []; return; }
    loading = true;
    try {
      preview = await api.vaultRenamePreview(oldTitle.trim());
    } catch {
      preview = [];
    }
    loading = false;
  }

  async function executeRename() {
    if (!newTitle.trim()) return;
    loading = true;
    try {
      renamedCount = await api.vaultRenameExecute(oldTitle.trim(), newTitle.trim());
      renamed = true;
      showToast(`Renamed across ${preview.length} document${preview.length !== 1 ? 's' : ''}`, 'success');
      setTimeout(() => { renamed = false; onClose(); }, 1500);
    } catch {}
    loading = false;
  }

  function countOccurrences(body: string, needle: string): number {
    const link = `[[${needle}]]`;
    let count = 0;
    let pos = 0;
    while ((pos = body.indexOf(link, pos)) !== -1) {
      count++;
      pos += link.length;
    }
    return count;
  }

  let previewCount = $derived(preview.reduce((sum, [, , body]) => sum + countOccurrences(body, oldTitle), 0));
</script>

{#if open}
  <div class="rename-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }} onkeydown={(e) => { if (e.key === 'Escape') onClose(); }}>
    <div class="rename-dialog" role="dialog" tabindex="-1">
      <h2>Vault-Wide Rename</h2>
      <p class="rename-desc">Rename [[{oldTitle || "..."}]] across all documents in the vault.</p>

      <div class="rename-form">
        <label>
          <span>Current title</span>
          <input
            type="text"
            bind:value={oldTitle}
            placeholder="Old wikilink title..."
            onchange={loadPreview}
          />
        </label>
        <label>
          <span>New title</span>
          <input
            type="text"
            bind:value={newTitle}
            placeholder="New wikilink title..."
            disabled={renamed}
          />
        </label>
      </div>

      {#if loading}
        <p class="loading">Scanning vault...</p>
      {:else if renamed}
        <p class="success">Renamed {renamedCount} link{renamedCount !== 1 ? 's' : ''} across {preview.length} document{preview.length !== 1 ? 's' : ''}.</p>
      {:else if preview.length > 0}
        <div class="preview-section">
          <h3>Preview ({previewCount} occurrence{previewCount !== 1 ? 's' : ''} across {preview.length} doc{preview.length !== 1 ? 's' : ''})</h3>
          <ul class="preview-list">
            {#each preview as [id, title, body]}
              {@const count = countOccurrences(body, oldTitle)}
              <li>
                <span class="preview-doc-title">{title}</span>
                <span class="preview-count">{count}x</span>
              </li>
            {/each}
          </ul>
        </div>
      {:else if oldTitle.trim()}
        <p class="empty">No documents contain [[{oldTitle}]].</p>
      {/if}

      <div class="rename-actions">
        <button class="btn-cancel" onclick={onClose}>Cancel</button>
        <button
          class="btn-rename"
          disabled={!oldTitle.trim() || !newTitle.trim() || previewCount === 0 || renamed || loading}
          onclick={executeRename}
        >
          Rename {previewCount} link{previewCount !== 1 ? 's' : ''}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .rename-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .rename-dialog {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    padding: 24px;
    width: 480px;
    max-height: 80vh;
    overflow-y: auto;
  }

  .rename-dialog h2 {
    font-size: 18px;
    font-weight: 600;
    color: var(--text-primary);
    margin: 0 0 4px;
  }

  .rename-desc {
    font-size: 13px;
    color: var(--text-muted);
    margin: 0 0 20px;
  }

  .rename-form {
    display: flex;
    flex-direction: column;
    gap: 12px;
    margin-bottom: 16px;
  }

  .rename-form label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
    color: var(--text-muted);
  }

  .rename-form input {
    padding: 8px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    color: var(--text-primary);
    font-size: 14px;
  }

  .loading {
    font-size: 13px;
    color: var(--text-muted);
    font-style: italic;
  }

  .success {
    font-size: 13px;
    color: var(--accent-green);
    font-weight: 500;
  }

  .empty {
    font-size: 13px;
    color: var(--text-muted);
    font-style: italic;
  }

  .preview-section h3 {
    font-size: 12px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin: 0 0 8px;
  }

  .preview-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 200px;
    overflow-y: auto;
  }

  .preview-list li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 10px;
    border-radius: var(--radius-md);
    background: var(--surface-overlay);
    font-size: 13px;
  }

  .preview-doc-title {
    color: var(--text-primary);
  }

  .preview-count {
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--accent-primary);
    font-weight: 600;
  }

  .rename-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .btn-cancel {
    padding: 6px 14px;
    border-radius: var(--radius-md);
    font-size: 13px;
    color: var(--text-secondary);
  }

  .btn-cancel:hover {
    background: var(--surface-overlay);
  }

  .btn-rename {
    padding: 6px 14px;
    border-radius: var(--radius-md);
    font-size: 13px;
    font-weight: 500;
    background: var(--accent-primary);
    color: white;
  }

  .btn-rename:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
</style>
