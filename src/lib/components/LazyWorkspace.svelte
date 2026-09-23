<script lang="ts">
  /**
   * LazyWorkspace — code-split heavy workspaces so startup stays fast.
   * Failure handling is load-bearing here: a chunk that rejects OR never
   * settles must reach a visible, retryable failed state with the reason
   * logged — never "Loading…" forever in silence.
   */
  import { untrack } from "svelte";
  import { loadWithTimeout } from "$lib/lazyLoad";

  let { loader, label = "view" }: { loader: () => Promise<unknown>; label?: string } = $props();

  let comp = $state<unknown>(null);
  let failed = $state(false);
  let errorMessage = $state("");
  let attempt = $state(0);

  $effect(() => {
    // Retry trigger (tracked). loader/label are read inside untrack:
    // inline `loader={() => import(...)}` arrows get a fresh identity on
    // every parent render, and resubscribing to those would flicker the
    // view back to Loading. Only `attempt` retriggers.
    void attempt;
    let alive = true;
    comp = null;
    failed = false;
    errorMessage = "";
    untrack(() => {
      void (async () => {
        const result = await loadWithTimeout(loader, label);
        if (!alive) return;
        if (result.ok) {
          comp = result.module;
        } else {
          failed = true;
          errorMessage = result.message;
          console.error(`[LazyWorkspace] failed to load ${label}: ${result.message}`);
        }
      })();
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
  <div class="lazy-state lazy-failed" role="alert">
    <span>Couldn't load this view{errorMessage ? `: ${errorMessage}` : "."}</span>
    <button class="lazy-retry" onclick={() => (attempt += 1)}>Retry</button>
  </div>
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

  .lazy-failed {
    flex-direction: column;
    gap: 10px;
    text-align: center;
    padding: 16px;
  }

  .lazy-retry {
    padding: 6px 16px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .lazy-retry:hover {
    background: var(--surface-hover);
  }
</style>
