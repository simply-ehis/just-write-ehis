<script lang="ts">
  import { api, type Doc } from "$lib/api";
  import Icon from "./Icon.svelte";

  let {
    ghostId,
    originalId,
    onClose,
    onMerged,
  }: {
    ghostId: string;
    originalId: string;
    onClose: () => void;
    onMerged?: () => void;
  } = $props();

  let original = $state<Doc | null>(null);
  let ghost = $state<Doc | null>(null);
  let changedWords = $state<{ original: string; ghost: string }[]>([]);
  let loading = $state(true);

  $effect(() => {
    loadData();
  });

  async function loadData() {
    loading = true;
    try {
      const [o, g] = await Promise.all([api.docGet(originalId), api.docGet(ghostId)]);
      original = o;
      ghost = g;
      changedWords = computeWordDiff(o.content, g.content);
    } catch (e) {
      console.error("Failed to load ghost data:", e);
    }
    loading = false;
  }

  function computeWordDiff(a: string, b: string): { original: string; ghost: string }[] {
    const wordsA = a.split(/\s+/);
    const wordsB = b.split(/\s+/);
    const maxLen = Math.max(wordsA.length, wordsB.length);
    const result: { original: string; ghost: string }[] = [];
    for (let i = 0; i < maxLen; i++) {
      const wA = wordsA[i] ?? "";
      const wB = wordsB[i] ?? "";
      if (wA !== wB) {
        result.push({ original: wA, ghost: wB });
      }
    }
    return result.slice(0, 50); // cap at 50 changed words
  }

  async function handleMerge() {
    try {
      await api.ghostMerge(ghostId, originalId);
      onMerged?.();
      onClose();
    } catch (e) {
      console.error("Failed to merge ghost:", e);
    }
  }

  async function handleDismiss() {
    try {
      await api.ghostDismiss(ghostId);
      onClose();
    } catch (e) {
      console.error("Failed to dismiss ghost:", e);
    }
  }
</script>

<div class="ghost-panel">
  <div class="ghost-header">
    <span class="ghost-title">{original?.title ?? "Original"}</span>
    <Icon name="ghost" size={14} />
    <span class="ghost-title">{ghost?.title ?? "Ghost"}</span>
    <div class="ghost-actions">
      <button class="ghost-btn merge" onclick={handleMerge} title="Copy ghost content into original">
        <Icon name="check" size={12} /> Keep Ghost
      </button>
      <button class="ghost-btn dismiss" onclick={handleDismiss} title="Delete this ghost">
        <Icon name="trash" size={12} /> Dismiss
      </button>
      <button class="ghost-btn close" onclick={onClose} title="Close comparison">
        <Icon name="x" size={12} />
      </button>
    </div>
  </div>
  {#if loading}
    <div class="ghost-loading">Loading...</div>
  {:else if original && ghost}
    <div class="ghost-split">
      <div class="ghost-pane">
        <div class="ghost-pane-label">Original</div>
        <div class="ghost-content">{original.content}</div>
      </div>
      <div class="ghost-pane">
        <div class="ghost-pane-label">Ghost</div>
        <div class="ghost-content">{ghost.content}</div>
      </div>
    </div>
    {#if changedWords.length > 0}
      <div class="ghost-diff-bar">
        <span class="diff-label">{changedWords.length} changes</span>
        <div class="diff-words">
          {#each changedWords.slice(0, 20) as diff}
            {#if diff.original}
              <span class="diff-removed">{diff.original}</span>
            {/if}
            {#if diff.ghost}
              <span class="diff-added">{diff.ghost}</span>
            {/if}
          {/each}
          {#if changedWords.length > 20}
            <span class="diff-more">+{changedWords.length - 20} more</span>
          {/if}
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .ghost-panel {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    overflow: hidden;
  }

  .ghost-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    font-size: 12px;
    color: var(--text-muted);
  }

  .ghost-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .ghost-actions {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }

  .ghost-btn {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
  }

  .ghost-btn:hover {
    background: var(--surface-hover);
  }

  .ghost-btn.merge {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .ghost-btn.dismiss:hover {
    border-color: var(--danger, #B54434);
    color: var(--danger, #B54434);
  }

  .ghost-loading {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }

  .ghost-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    max-height: 400px;
    overflow: auto;
  }

  .ghost-pane {
    padding: 12px;
    border-right: 1px solid var(--border-subtle);
    overflow: auto;
  }

  .ghost-pane:last-child {
    border-right: none;
  }

  .ghost-pane-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 8px;
    font-weight: 600;
  }

  .ghost-content {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .ghost-diff-bar {
    padding: 8px 12px;
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    font-size: 11px;
  }

  .diff-label {
    font-weight: 600;
    color: var(--text-muted);
    margin-right: 8px;
  }

  .diff-words {
    display: inline;
    gap: 4px;
  }

  .diff-removed {
    background: rgba(181, 68, 52, 0.15);
    color: var(--danger, #B54434);
    padding: 1px 4px;
    border-radius: 2px;
    text-decoration: line-through;
  }

  .diff-added {
    background: rgba(63, 102, 86, 0.15);
    color: var(--accent-primary);
    padding: 1px 4px;
    border-radius: 2px;
  }

  .diff-more {
    color: var(--text-muted);
    font-style: italic;
  }
</style>
