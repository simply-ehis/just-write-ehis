<script lang="ts">
  import { currentDoc, currentWorkspace, openTabs, showSettings, sidebarOpen, aiPanelOpen, inspectorOpen, zenMode } from "$lib/stores/app";
  import { api } from "$lib/api";
  import { navControl, navDepth, popNavHistory } from "$lib/stores/lastPlace";
  import Icon from "$lib/components/Icon.svelte";

  function getBreadcrumb(doc: any): string[] {
    if (!doc) return [];
    const parts = doc.path.split("/");
    return parts.slice(0, -1);
  }

  /** Global back: return to the previous workspace+doc. The App
   * workspace effect skips recording while suppressPush is set; it is
   * cleared on a macrotask so Svelte effects flush first. */
  async function goBack() {
    const entry = popNavHistory();
    if (!entry) return;
    navControl.suppressPush = true;
    try {
      $showSettings = false;
      if (entry.docId) {
        try {
          const d = await api.docGet(entry.docId);
          $currentDoc = d;
          if (!$openTabs.find((t) => t.id === d.id)) $openTabs = [d, ...$openTabs];
        } catch {
          $currentDoc = null;
        }
      } else {
        $currentDoc = null;
      }
      $currentWorkspace = entry.workspace;
    } finally {
      setTimeout(() => {
        navControl.suppressPush = false;
      }, 0);
    }
  }
</script>

<div class="breadcrumb-bar">
  <button class="icon-btn crumb-btn" onclick={goBack} disabled={$navDepth === 0} title="Back" aria-label="Back">
    <Icon name="arrow-left" size={14} />
  </button>
  <button class="icon-btn crumb-btn" onclick={() => ($sidebarOpen = !$sidebarOpen)} title="Toggle sidebar (Ctrl+B)" aria-label="Toggle sidebar" aria-pressed={$sidebarOpen}>
    <Icon name="menu" size={14} />
  </button>
  <div class="crumb-path">
    {#if $currentDoc}
      {#each getBreadcrumb($currentDoc) as part, i}
        {#if i > 0}
          <span class="separator">/</span>
        {/if}
        <span>{part}</span>
      {/each}
      <span class="separator">/</span>
      <span class="current">{$currentDoc.title}</span>
    {:else}
      <span>No document open</span>
    {/if}
  </div>
  <span class="crumb-spacer"></span>
  <button class="icon-btn crumb-btn" class:active={$inspectorOpen} onclick={() => ($inspectorOpen = !$inspectorOpen)} title="Toggle outline & links (Ctrl+I)" aria-label="Toggle inspector" aria-pressed={$inspectorOpen}>
    <Icon name="panel" size={14} />
  </button>
  <button class="icon-btn crumb-btn" class:active={$aiPanelOpen} onclick={() => ($aiPanelOpen = !$aiPanelOpen)} title="Toggle AI panel (Ctrl+J)" aria-label="Toggle AI panel" aria-pressed={$aiPanelOpen}>
    <Icon name="sparkle" size={14} />
  </button>
  <button class="icon-btn crumb-btn" class:active={$zenMode} onclick={() => ($zenMode = !$zenMode)} title="Zen mode (F11)" aria-label="Toggle zen mode" aria-pressed={$zenMode}>
    <Icon name="eye" size={14} />
  </button>
</div>

<style>
  .crumb-btn {
    width: 26px;
    height: 26px;
  }

  .crumb-btn.active {
    background: var(--surface-pressed);
    color: var(--accent-primary);
  }

  .crumb-path {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    flex: 1;
  }

  .crumb-spacer {
    flex: 0 0 8px;
  }
</style>
