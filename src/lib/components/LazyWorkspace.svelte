<script lang="ts">
  /**
   * LazyWorkspace — code-split heavy workspaces so startup stays fast.
   * Shows a compact inline loader (no floating UI, solid surfaces only).
   */
  let { loader }: { loader: () => Promise<unknown> } = $props();

  let comp = $state<unknown>(null);
  let failed = $state(false);

  $effect(() => {
    let alive = true;
    loader()
      .then((m) => {
        if (!alive) return;
        comp = (m as { default?: unknown }).default ?? m;
      })
      .catch(() => {
        if (alive) failed = true;
      });
    return () => {
      alive = false;
    };
  });
</script>

{#if comp}
  {@const C = comp as import("svelte").Component}
  <C />
{:else if failed}
  <div class="lazy-state">Couldn't load this view. Reopen it to retry.</div>
{:else}
  <div class="lazy-state" role="status">Loading…</div>
{/if}

<style>
  .lazy-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    min-height: 120px;
    color: var(--text-muted);
    font-size: 13px;
    background: var(--surface-base);
  }
</style>
