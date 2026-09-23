<script lang="ts">
  /**
   * ConflictBanner — docked banner for file conflict resolution (A9.5).
   * Appears at top of ContentPane when external change detected while local edits exist.
   * Options: Keep Mine / Keep Theirs / View Diff.
   */
  import { activeConflict, dismissConflict } from '$lib/stores/conflict';
  import { currentDoc } from '$lib/stores/app';
  import { api } from '$lib/api';
  import { showToast } from '$lib/stores/notifications';
  import Icon from '$lib/components/Icon.svelte';

  let resolving = $state(false);
  let diffOpen = $state(false);
  let diffLines = $state<{ kind: "same" | "del" | "add"; text: string }[]>([]);
  let diffLoading = $state(false);

  async function keepMine() {
    if (!$activeConflict) return;
    resolving = true;
    try {
      // Force-flush local content to disk, overwriting external change
      if ($currentDoc) {
        await api.atomicSave($currentDoc.id, $currentDoc.content);
      }
      showToast('Kept local version', 'success');
    } catch (e) {
      showToast(`Error: ${e}`, 'error');
    } finally {
      resolving = false;
      dismissConflict();
    }
  }

  async function keepTheirs() {
    if (!$activeConflict) return;
    resolving = true;
    try {
      // Reload doc from disk (external version)
      const doc = await api.docGet($activeConflict.docId);
      showToast('Loaded external version', 'success');
      // The doc store will update on next load
    } catch (e) {
      showToast(`Error: ${e}`, 'error');
    } finally {
      resolving = false;
      dismissConflict();
    }
  }

  /** Line diff of current content vs the latest snapshot (last clean state). */
  async function viewDiff() {
    if (!$activeConflict || !$currentDoc) return;
    diffLoading = true;
    diffOpen = true;
    try {
      const snaps = await api.snapshotList($activeConflict.docId);
      const base = (snaps[0]?.content ?? "").split("\n");
      const current = ($currentDoc.content ?? "").split("\n");
      const baseSet = new Set(base);
      const curSet = new Set(current);
      const out: { kind: "same" | "del" | "add"; text: string }[] = [];
      for (const line of base) {
        out.push(curSet.has(line) ? { kind: "same", text: line } : { kind: "del", text: line });
      }
      for (const line of current) {
        if (!baseSet.has(line)) out.push({ kind: "add", text: line });
      }
      diffLines = out.slice(0, 300);
    } catch (e) {
      showToast(`Diff failed: ${e}`, 'error');
      diffOpen = false;
    } finally {
      diffLoading = false;
    }
  }
</script>

{#if $activeConflict}
  <div class="conflict-banner">
    <div class="conflict-icon"><Icon name="warn" size={16} /></div>
    <div class="conflict-text">
      <span class="conflict-title">File changed externally</span>
      <span class="conflict-path">{$activeConflict.path}</span>
    </div>
    <div class="conflict-actions">
      <button class="conflict-btn mine" onclick={keepMine} disabled={resolving}>
        Keep Mine
      </button>
      <button class="conflict-btn theirs" onclick={keepTheirs} disabled={resolving}>
        Keep Theirs
      </button>
      <button class="conflict-btn diff" onclick={viewDiff} disabled={resolving} title="Compare against latest snapshot">
        View Diff
      </button>
      <button class="conflict-btn dismiss" onclick={dismissConflict} disabled={resolving} title="Dismiss" aria-label="Dismiss conflict">
        ×
      </button>
    </div>
  </div>
{/if}

{#if diffOpen}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    class="diff-overlay"
    onclick={() => { diffOpen = false; dismissConflict(); }}
    onkeydown={(e) => { if (e.key === "Escape") { diffOpen = false; dismissConflict(); } }}
    role="presentation"
  >
    <div class="diff-panel" onclick={(e) => e.stopPropagation()} role="dialog" aria-label="Conflict diff" tabindex="-1">
      <div class="diff-header">
        <h3>Local vs latest snapshot</h3>
        <button class="conflict-btn dismiss" onclick={() => { diffOpen = false; dismissConflict(); }} aria-label="Close diff">×</button>
      </div>
      <div class="diff-body">
        {#if diffLoading}
          <p class="diff-empty">Loading diff…</p>
        {:else if diffLines.length === 0}
          <p class="diff-empty">No differences.</p>
        {:else}
          {#each diffLines as line}
            <div class="diff-line {line.kind}">{line.kind === "del" ? "− " : line.kind === "add" ? "+ " : "  "}{line.text || " "}</div>
          {/each}
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .conflict-banner {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 16px;
    /* Warning tint that follows the theme; flat overlay if color-mix is unavailable. */
    background: var(--surface-overlay);
    background: color-mix(in srgb, var(--warning) 22%, var(--bg-primary));
    border-bottom: 1px solid var(--warning);
    color: var(--text-primary);
    font-size: 13px;
    min-height: 40px;
  }
  .conflict-icon {
    font-size: 16px;
    flex-shrink: 0;
  }
  .conflict-text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    flex: 1;
    min-width: 0;
  }
  .conflict-title {
    font-weight: 600;
  }
  .conflict-path {
    font-size: 11px;
    opacity: 0.8;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .conflict-actions {
    display: flex;
    gap: 6px;
    flex-shrink: 0;
  }
  .conflict-btn {
    padding: 4px 10px;
    border: 1px solid rgba(255,255,255,0.2);
    border-radius: 4px;
    background: transparent;
    color: inherit;
    font-size: 12px;
    cursor: pointer;
    white-space: nowrap;
  }
  .conflict-btn:hover {
    background: rgba(255,255,255,0.1);
  }
  .conflict-btn.mine {
    border-color: var(--accent-semantic-green);
    color: var(--accent-semantic-green);
  }
  .conflict-btn.theirs {
    border-color: var(--accent-semantic-blue);
    color: var(--accent-semantic-blue);
  }
  .conflict-btn.dismiss {
    padding: 4px 8px;
    font-size: 14px;
  }
  .conflict-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }
  .diff-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    z-index: 600;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 16px;
  }
  .diff-panel {
    width: min(640px, 94vw);
    max-height: 76vh;
    display: flex;
    flex-direction: column;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    color: var(--text-primary);
  }
  .diff-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 10px 14px;
    border-bottom: 1px solid var(--border-subtle);
  }
  .diff-header h3 {
    margin: 0;
    font-size: 14px;
  }
  .diff-body {
    overflow-y: auto;
    padding: 10px 14px;
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.6;
  }
  .diff-line {
    white-space: pre-wrap;
    word-break: break-word;
    padding: 1px 6px;
    border-radius: 3px;
  }
  .diff-line.del { background: rgba(255, 107, 107, 0.12); color: var(--accent-semantic-red); }
  .diff-line.add { background: rgba(78, 205, 196, 0.12); color: var(--accent-semantic-green); }
  .diff-line.same { color: var(--text-muted); }
  .diff-empty { color: var(--text-muted); font-family: inherit; }
</style>
