<script lang="ts">
  /**
   * DeleteButton — uniform two-tap delete for any doc, anywhere.
   * First click arms ("Sure?"), second confirms; auto-disarms after 3s.
   * Clears the tab strip + current doc when they point at the deleted doc,
   * then notifies the parent to refresh its list.
   */
  import { api, type Doc } from "$lib/api";
  import { currentDoc, openTabs } from "$lib/stores/app";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "$lib/components/Icon.svelte";

  let {
    doc,
    onDeleted,
    label = "Delete document",
  }: {
    doc: Doc | null;
    onDeleted?: (id: string) => void;
    label?: string;
  } = $props();

  let armed = $state(false);
  // Plain timer handle: only touched in the click handler (never inside an
  // $effect), so it must NOT be $state — tracking it would re-fire effects.
  let armTimer: ReturnType<typeof setTimeout> | null = null;

  async function handleClick() {
    if (!doc) return;
    if (!armed) {
      armed = true;
      if (armTimer) clearTimeout(armTimer);
      armTimer = setTimeout(() => {
        armed = false;
      }, 3000);
      return;
    }
    if (armTimer) {
      clearTimeout(armTimer);
      armTimer = null;
    }
    armed = false;
    const id = doc.id;
    const title = doc.title;
    try {
      await api.docDelete(id);
      $openTabs = $openTabs.filter((t) => t.id !== id);
      if ($currentDoc?.id === id) $currentDoc = $openTabs[0] ?? null;
      onDeleted?.(id);
      showToast(`Deleted "${title}"`, "success");
    } catch (e) {
      showToast(`Couldn't delete: ${e instanceof Error ? e.message : e}`, "error");
    }
  }
</script>

<button
  class="delete-btn"
  class:armed
  onclick={handleClick}
  disabled={!doc}
  title={armed ? "Click again to confirm delete" : label}
  aria-label={armed ? "Confirm delete" : label}
>
  {#if armed}
    <span class="confirm-text">Sure?</span>
  {:else}
    <Icon name="trash" size={14} />
  {/if}
</button>

<style>
  .delete-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-width: 30px;
    height: 30px;
    padding: 0 8px;
    border: 1px solid transparent;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: 12px;
    cursor: pointer;
    flex-shrink: 0;
  }

  .delete-btn:hover:not(:disabled) {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .delete-btn.armed {
    border-color: var(--accent-semantic-red);
    color: var(--accent-semantic-red);
    font-weight: 600;
  }

  .delete-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .confirm-text {
    white-space: nowrap;
  }
</style>
