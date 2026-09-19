<script lang="ts">
  /**
   * DocDetail — uniform master-detail editing pane for every doc-list
   * workspace (Novel beats, Inbox items, Projects tasks, Library rows,
   * Script list is separate: Fountain textarea). Header (Back + title +
   * delete) over the shared EditorPane, which fills the majority of the
   * pane and scrolls. The open doc comes from the $currentDoc store, which
   * the parent sets when selecting.
   */
  import { currentDoc } from "$lib/stores/app";
  import EditorPane from "$lib/components/EditorPane.svelte";
  import DeleteButton from "$lib/components/DeleteButton.svelte";
  import Icon from "$lib/components/Icon.svelte";

  let {
    onBack,
    onDeleted,
    backLabel = "Back",
  }: {
    onBack: () => void;
    onDeleted?: (id: string) => void;
    backLabel?: string;
  } = $props();
</script>

{#if $currentDoc}
  <div class="doc-detail">
    <div class="detail-bar">
      <button class="back-btn" onclick={onBack} title={backLabel} aria-label={backLabel}>
        <span aria-hidden="true">←</span>
        <span class="back-label">{backLabel}</span>
      </button>
      <span class="detail-title" title={$currentDoc.title}>{$currentDoc.title}</span>
      <span class="detail-words">{$currentDoc.word_count.toLocaleString()} words · ~{Math.max(1, Math.round($currentDoc.word_count / 200))} min</span>
      <DeleteButton doc={$currentDoc} {onDeleted} />
    </div>
    <div class="detail-editor">
      <EditorPane />
    </div>
  </div>
{:else}
  <div class="doc-detail-empty">
    <Icon name="files" size={40} />
    <p>Select a document to read and edit it here.</p>
    <button class="back-btn" onclick={onBack}>{backLabel}</button>
  </div>
{/if}

<style>
  .doc-detail {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .detail-bar {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 6px 12px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    flex-shrink: 0;
    min-height: 42px;
  }

  .back-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
    flex-shrink: 0;
  }

  .back-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .detail-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 13px;
    font-weight: 600;
  }

  .detail-words {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .detail-editor {
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .doc-detail-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    height: 100%;
    color: var(--text-muted);
    font-size: 13px;
  }
</style>
