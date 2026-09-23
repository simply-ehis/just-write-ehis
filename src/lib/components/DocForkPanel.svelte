<script lang="ts">
  import { api, type Doc } from "$lib/api";
  import Icon from "./Icon.svelte";

  let {
    forkId,
    originalId,
    onClose,
    onMerged,
  }: {
    forkId: string;
    originalId: string;
    onClose: () => void;
    onMerged?: () => void;
  } = $props();

  let original = $state<Doc | null>(null);
  let fork = $state<Doc | null>(null);
  let changedWords = $state<{ original: string; fork: string }[]>([]);
  let loading = $state(true);

  $effect(() => {
    loadData();
  });

  async function loadData() {
    loading = true;
    try {
      const [o, g] = await Promise.all([api.docGet(originalId), api.docGet(forkId)]);
      original = o;
      fork = g;
      changedWords = computeWordDiff(o.content, g.content);
    } catch (e) {
      console.error("Failed to load fork data:", e);
    }
    loading = false;
  }

  function computeWordDiff(a: string, b: string): { original: string; fork: string }[] {
    const wordsA = a.split(/\s+/);
    const wordsB = b.split(/\s+/);
    const maxLen = Math.max(wordsA.length, wordsB.length);
    const result: { original: string; fork: string }[] = [];
    for (let i = 0; i < maxLen; i++) {
      const wA = wordsA[i] ?? "";
      const wB = wordsB[i] ?? "";
      if (wA !== wB) {
        result.push({ original: wA, fork: wB });
      }
    }
    return result.slice(0, 50); // cap at 50 changed words
  }

  async function handleMerge() {
    try {
      await api.ghostMerge(forkId, originalId);
      onMerged?.();
      onClose();
    } catch (e) {
      console.error("Failed to merge fork:", e);
    }
  }

  async function handleDismiss() {
    try {
      await api.ghostDismiss(forkId);
      onClose();
    } catch (e) {
      console.error("Failed to dismiss fork:", e);
    }
  }
</script>

<div class="fork-panel">
  <div class="fork-header">
    <span class="fork-title">{original?.title ?? "Original"}</span>
    <Icon name="ghost" size={14} />
    <span class="fork-title">{fork?.title ?? "Fork"}</span>
    <div class="fork-actions">
      <button class="fork-btn merge" onclick={handleMerge} title="Copy fork content into original">
        <Icon name="check" size={12} /> Keep Fork
      </button>
      <button class="fork-btn dismiss" onclick={handleDismiss} title="Delete this fork">
        <Icon name="trash" size={12} /> Dismiss
      </button>
      <button class="fork-btn close" onclick={onClose} title="Close comparison">
        <Icon name="x" size={12} />
      </button>
    </div>
  </div>
  {#if loading}
    <div class="fork-loading">Loading...</div>
  {:else if original && fork}
    <div class="fork-split">
      <div class="fork-pane">
        <div class="fork-pane-label">Original</div>
        <div class="fork-content">{original.content}</div>
      </div>
      <div class="fork-pane">
        <div class="fork-pane-label">Fork</div>
        <div class="fork-content">{fork.content}</div>
      </div>
    </div>
    {#if changedWords.length > 0}
      <div class="fork-diff-bar">
        <span class="diff-label">{changedWords.length} changes</span>
        <div class="diff-words">
          {#each changedWords.slice(0, 20) as diff}
            {#if diff.original}
              <span class="diff-removed">{diff.original}</span>
            {/if}
            {#if diff.fork}
              <span class="diff-added">{diff.fork}</span>
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
  .fork-panel {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    overflow: hidden;
  }

  .fork-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    font-size: 12px;
    color: var(--text-muted);
  }

  .fork-title {
    font-weight: 600;
    color: var(--text-primary);
  }

  .fork-actions {
    margin-left: auto;
    display: flex;
    gap: 4px;
  }

  .fork-btn {
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

  .fork-btn:hover {
    background: var(--surface-hover);
  }

  .fork-btn.merge {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .fork-btn.dismiss:hover {
    border-color: var(--danger, #B54434);
    color: var(--danger, #B54434);
  }

  .fork-loading {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
  }

  .fork-split {
    display: grid;
    grid-template-columns: 1fr 1fr;
    max-height: 400px;
    overflow: auto;
  }

  .fork-pane {
    padding: 12px;
    border-right: 1px solid var(--border-subtle);
    overflow: auto;
  }

  .fork-pane:last-child {
    border-right: none;
  }

  .fork-pane-label {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 8px;
    font-weight: 600;
  }

  .fork-content {
    font-family: var(--font-mono);
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-primary);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .fork-diff-bar {
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
