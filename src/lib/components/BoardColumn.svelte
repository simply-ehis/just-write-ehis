<script lang="ts">
  /**
   * BoardColumn — one kanban column shared by the Properties database
   * board (read-only cards) and the Projects task board (writable cards).
   * Same chrome, different cards: callers pass card markup + an optional
   * footer (e.g. "+ Task") as snippets. Read-only vs writable is a prop
   * of the cards, not the column.
   */
  import type { Snippet } from "svelte";

  let {
    title,
    count,
    dotColor,
    children,
    footer,
  }: {
    title: string;
    count: number;
    dotColor?: string | null;
    children: Snippet;
    footer?: Snippet;
  } = $props();
</script>

<div class="board-column">
  <div class="column-header">
    {#if dotColor}
      <span class="status-dot" style="background: {dotColor}"></span>
    {/if}
    <span>{title}</span>
    <span class="column-count">{count}</span>
  </div>
  {@render children()}
  {#if footer}
    {@render footer()}
  {/if}
</div>

<style>
  .board-column {
    min-width: 220px;
    max-width: 280px;
    flex-shrink: 0;
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    max-height: 100%;
    overflow-y: auto;
  }

  .column-header {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    padding: 2px 4px;
  }

  /* .status-dot lives in app.css (shared with Novel headers). */

  .column-count {
    margin-left: auto;
    font-size: 11px;
    font-weight: 400;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
