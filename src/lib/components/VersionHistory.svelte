<script lang="ts">
  import { api, type Snapshot } from '$lib/api';
  import { currentDoc } from '$lib/stores/app';
  import { showToast } from '$lib/stores/notifications';
  import Icon from '$lib/components/Icon.svelte';
  import { domainError } from '$lib/errors';

  let snapshots = $state<Snapshot[]>([]);
  let selectedSnapshot = $state<Snapshot | null>(null);
  let previewContent = $state('');
  let loading = $state(false);
  let open = $state(false);

  async function loadSnapshots() {
    if (!$currentDoc) return;
    loading = true;
    try {
      snapshots = await api.snapshotList($currentDoc.id);
    } catch (e) {
      domainError('History', "couldn't load versions", e);
    } finally {
      loading = false;
    }
  }

  function openPanel() {
    open = true;
    loadSnapshots();
  }

  function closePanel() {
    open = false;
    selectedSnapshot = null;
    previewContent = '';
  }

  async function createSnapshot() {
    if (!$currentDoc) return;
    try {
      const snap = await api.snapshotCreate($currentDoc.id);
      snapshots.unshift(snap);
    } catch (e) {
      domainError('History', "couldn't save version", e);
    }
  }

  function selectSnapshot(snap: Snapshot) {
    selectedSnapshot = snap;
    previewContent = snap.content ?? '';
  }

  async function restoreSnapshot() {
    if (!selectedSnapshot) return;
    try {
      const doc = await api.snapshotRestore(selectedSnapshot.id);
      $currentDoc = doc;
      showToast('Version restored', 'success');
      closePanel();
    } catch (e) {
      domainError('History', "couldn't restore version", e);
    }
  }

  function formatTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
      return iso;
    }
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function getDiffLines(): { type: 'same' | 'add' | 'del'; text: string }[] {
    if (!selectedSnapshot || !$currentDoc?.content) return [];
    const oldText = selectedSnapshot.content ?? '';
    const newText = $currentDoc.content ?? '';
    const oldLines = oldText.split('\n');
    const newLines = newText.split('\n');
    const maxLen = Math.max(oldLines.length, newLines.length);
    const result: { type: 'same' | 'add' | 'del'; text: string }[] = [];
    for (let i = 0; i < maxLen; i++) {
      const oldLine = oldLines[i];
      const newLine = newLines[i];
      if (oldLine === newLine) {
        result.push({ type: 'same', text: oldLine ?? '' });
      } else {
        if (oldLine !== undefined) result.push({ type: 'del', text: oldLine });
        if (newLine !== undefined) result.push({ type: 'add', text: newLine });
      }
    }
    return result;
  }

  function getDiffStats(): { added: number; removed: number } {
    const lines = getDiffLines();
    return {
      added: lines.filter(l => l.type === 'add').length,
      removed: lines.filter(l => l.type === 'del').length,
    };
  }
</script>

<button class="version-trigger icon-btn" onclick={openPanel} title="Version History" aria-label="Open version history">
  <Icon name="history" size={15} />
</button>

{#if open}
  <div class="version-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="version-panel" role="dialog" aria-label="Version history" tabindex="-1">
      <div class="panel-header">
        <h2>Version History</h2>
        <div class="header-actions">
          <button class="snapshot-btn" onclick={createSnapshot}>Save Snapshot</button>
          <button class="close-btn" onclick={closePanel}>&times;</button>
        </div>
      </div>

      <div class="panel-body">
        <div class="snapshot-list">
          {#if loading}
            <div class="empty-msg">Loading...</div>
          {:else if snapshots.length === 0}
            <div class="empty-msg">
              <p>No snapshots yet.</p>
              <p>Save a snapshot to track changes over time.</p>
            </div>
          {:else}
            {#each snapshots as snap, i}
              <button
                class="snapshot-item"
                class:selected={selectedSnapshot?.id === snap.id}
                onclick={() => selectSnapshot(snap)}
              >
                <div class="snap-label">{snap.label}</div>
                <div class="snap-meta">
                  <span>{formatTime(snap.created_at)}</span>
                  <span>{snap.word_count.toLocaleString()} words</span>
                </div>
              </button>
            {/each}
          {/if}
        </div>

        {#if selectedSnapshot}
          <div class="snapshot-preview">
            <div class="preview-header">
              <span>{selectedSnapshot.label}</span>
              <button class="restore-btn" onclick={restoreSnapshot}>Restore This Version</button>
            </div>
            <div class="diff-section">
              <h4>Changes from current:</h4>
              <div class="diff-stats">
                <span class="diff-add">+{getDiffStats().added}</span>
                <span class="diff-del">-{getDiffStats().removed}</span>
              </div>
              <div class="diff-content">
                {#each getDiffLines() as line}
                  <div class="diff-line" class:diff-add={line.type === 'add'} class:diff-del={line.type === 'del'}>
                    <span class="diff-marker">{line.type === 'add' ? '+' : line.type === 'del' ? '-' : ' '}</span>
                    <span class="diff-text">{line.text}</span>
                  </div>
                {/each}
              </div>
            </div>
            <div class="content-section">
              <h4>Snapshot content:</h4>
              <pre class="snapshot-content">{previewContent}</pre>
            </div>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .version-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .version-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    justify-content: flex-end;
    z-index: 250;
  }

  .version-panel {
    width: min(640px, 100vw);
    height: 100%;
    background: var(--surface-base);
    border-left: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    box-shadow: -4px 0 24px rgba(0,0,0,0.3);
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

  .snapshot-btn {
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

  .panel-body {
    flex: 1;
    display: flex;
    overflow: hidden;
  }

  .snapshot-list {
    width: 240px;
    border-right: 1px solid var(--border-subtle);
    overflow-y: auto;
    padding: 8px;
  }

  .empty-msg {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .snapshot-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: 10px 12px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    margin-bottom: 4px;
  }

  .snapshot-item:hover {
    background: var(--surface-raised);
  }

  .snapshot-item.selected {
    background: var(--surface-overlay);
    border-left: 2px solid var(--accent-primary);
  }

  .snap-label {
    font-size: 13px;
    font-weight: var(--font-weight-semibold);
    margin-bottom: 4px;
  }

  .snap-meta {
    display: flex;
    gap: 8px;
    font-size: 11px;
    color: var(--text-muted);
  }

  .snapshot-preview {
    flex: 1;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .preview-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 13px;
    font-weight: var(--font-weight-semibold);
  }

  .restore-btn {
    padding: 6px 12px;
    background: var(--accent-semantic-green);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }

  .diff-section,
  .content-section {
    flex: 1;
    overflow-y: auto;
    padding: 12px 16px;
  }

  .diff-section {
    border-bottom: 1px solid var(--border-subtle);
    max-height: 200px;
  }

  h4 {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }

  .diff-content {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    color: var(--text-primary);
  }

  .diff-content :global(*) {
    color: inherit;
  }

  .snapshot-content {
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    color: var(--text-secondary);
  }
</style>
