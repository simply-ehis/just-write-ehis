<script lang="ts">
  import Icon from "./Icon.svelte";

  let { count, onclick }: { count: number; onclick?: () => void } = $props();
</script>

{#if count > 0}
  <button class="ghost-badge" {onclick} title="{count} fork{count !== 1 ? 's' : ''}" aria-label="{count} ghost fork{count !== 1 ? 's' : ''}">
    <Icon name="ghost" size={11} />
    <span>{count}</span>
  </button>
{/if}

<style>
  .ghost-badge {
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    font-size: 10px;
    cursor: pointer;
    line-height: 1;
  }

  .ghost-badge:hover {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
    background: var(--surface-hover);
  }
</style>
