<script lang="ts">
  /**
   * LibraryWorkspace — Library database views + vault file browser in one
   * place, switchable via tabs. The standalone Files route still exists
   * (palette/back-compat) with its own viewer state.
   */
  import { currentDoc, openTabs } from "$lib/stores/app";
  import { api } from "$lib/api";
  import FileBrowser from "$lib/components/FileBrowser.svelte";
  import MarkdownViewer from "$lib/components/MarkdownViewer.svelte";
  import LazyWorkspace from "$lib/components/LazyWorkspace.svelte";

  let tab = $state<"views" | "files">("views");
  let viewedFile = $state<string | null>(null);

  async function handleSelect(path: string, isDir: boolean) {
    if (!isDir && (path.endsWith(".md") || path.endsWith(".txt"))) {
      viewedFile = path;
      return;
    }
    if (!isDir) {
      try {
        const d = await api.docGet(path);
        $currentDoc = d;
        if (!$openTabs.find((t) => t.id === d.id)) $openTabs = [d, ...$openTabs];
      } catch {
        /* unknown path: stay on the browser */
      }
    }
  }
</script>

<div class="library-workspace">
  <div class="lib-tabs" role="tablist" aria-label="Library views">
    <button
      class="lib-tab"
      class:active={tab === "views"}
      role="tab"
      aria-selected={tab === "views"}
      onclick={() => (tab = "views")}
    >Views</button>
    <button
      class="lib-tab"
      class:active={tab === "files"}
      role="tab"
      aria-selected={tab === "files"}
      onclick={() => (tab = "files")}
    >Files</button>
  </div>
  <div class="lib-content">
    {#if tab === "views"}
      <LazyWorkspace loader={() => import("$lib/components/PropertiesView.svelte")} />
    {:else if viewedFile}
      <MarkdownViewer filePath={viewedFile} onClose={() => (viewedFile = null)} />
    {:else}
      <FileBrowser onSelect={handleSelect} />
    {/if}
  </div>
</div>

<style>
  .library-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
  }

  .lib-tabs {
    display: flex;
    gap: 4px;
    padding: 8px 12px 0;
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .lib-tab {
    padding: 6px 14px;
    font-size: 12px;
    color: var(--text-secondary);
    border-bottom: 2px solid transparent;
  }

  .lib-tab:hover {
    color: var(--text-primary);
  }

  .lib-tab.active {
    color: var(--accent-primary);
    border-bottom-color: var(--accent-primary);
  }

  .lib-content {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }
</style>
