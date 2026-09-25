<script lang="ts">
  import { onMount } from "svelte";
  import { api, isBrowserPreview } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "$lib/components/Icon.svelte";
  import { domainError } from "$lib/errors";

  let { onSelect }: { onSelect?: (path: string, isDir: boolean) => void } = $props();

  let currentPath = $state("");
  let entries: [string, boolean, number][] = $state([]);
  let pathInput = $state("");
  let editingPath = $state(false);
  let contextMenu = $state<{ x: number; y: number; path: string; name: string; isDir: boolean } | null>(null);
  let renamingPath = $state<string | null>(null);
  let renameValue = $state("");
  let confirmingDelete = $state<{ path: string; name: string } | null>(null);
  let confirmTimer: ReturnType<typeof setTimeout> | null = null;
  let creatingFolder = $state(false);
  let newFolderName = $state("");
  let movingEntry = $state<{ path: string; name: string } | null>(null);
  let moveDest = $state("");

  function sep(): string {
    return currentPath.includes("\\") ? "\\" : "/";
  }

  onMount(() => {
    const vault = localStorage.getItem("vault-path") || "";
    if (vault) {
      navigateTo(vault);
      return;
    }
    api.getVaultPath().then((p) => {
      if (p) {
        try { localStorage.setItem("vault-path", p); } catch (e) { console.warn("Failed to save vault path:", e); }
        navigateTo(p);
      }
    }).catch((e) => domainError("Files", "couldn't locate vault", e));
  });

  async function navigateTo(path: string) {
    try {
      entries = await api.fsListDir(path);
      currentPath = path;
      pathInput = path;
    } catch (e) {
      domainError("Files", "couldn't list folder", e);
    }
  }

  function navigateUp() {
    const parts = currentPath.replace(/\\/g, "/").split("/");
    parts.pop();
    navigateTo(parts.join("/") || parts[0]);
  }

  function handleEntryClick(name: string, isDir: boolean) {
    const sep = currentPath.includes("\\") ? "\\" : "/";
    const fullPath = currentPath + sep + name;
    if (isDir) {
      navigateTo(fullPath);
    } else {
      onSelect?.(fullPath, false);
    }
  }

  function handlePathSubmit() {
    editingPath = false;
    navigateTo(pathInput.trim());
  }

  function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
  }

  function handleContext(e: MouseEvent, name: string, isDir: boolean) {
    e.preventDefault();
    const sep = currentPath.includes("\\") ? "\\" : "/";
    contextMenu = { x: e.clientX, y: e.clientY, path: currentPath + sep + name, name, isDir };
  }

  function closeContext() {
    contextMenu = null;
  }

  async function handleContextAction(action: string) {
    if (!contextMenu) return;
    const { path, name, isDir } = contextMenu;
    closeContext();

    switch (action) {
      case "rename": {
        renamingPath = path;
        renameValue = name;
        confirmingDelete = null;
        break;
      }
      case "delete": {
        renamingPath = null;
        confirmingDelete = { path, name };
        if (confirmTimer) clearTimeout(confirmTimer);
        confirmTimer = setTimeout(() => (confirmingDelete = null), 8000);
        break;
      }
      case "reveal": {
        // Real OS reveal (desktop shell). Preview/mobile have no file
        // manager — fall back to copying the path so it's still actionable.
        try {
          await api.fsReveal(path);
        } catch {
          try {
            await navigator.clipboard.writeText(path);
            showToast("No file manager here — path copied instead", "info");
          } catch {
            showToast(`Path: ${path}`, "info");
          }
        }
        break;
      }
      case "move": {
        movingEntry = { path, name };
        moveDest = currentPath;
        renamingPath = null;
        confirmingDelete = null;
        break;
      }
      case "open-with": {
        onSelect?.(path, isDir);
        break;
      }
    }
  }

  async function commitRename(path: string) {
    const newName = renameValue.trim();
    renamingPath = null;
    if (!newName) return;
    const oldName = path.split(/[/\\]/).pop();
    if (newName === oldName) return;
    try {
      await api.fsRename(path, newName);
      navigateTo(currentPath);
    } catch (e) {
      showToast(`Rename failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function confirmDelete() {
    if (!confirmingDelete) return;
    const { path } = confirmingDelete;
    confirmingDelete = null;
    if (confirmTimer) clearTimeout(confirmTimer);
    try {
      await api.fsDelete(path);
      navigateTo(currentPath);
    } catch (e) {
      showToast(`Delete failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function commitNewFolder() {
    const name = newFolderName.trim();
    creatingFolder = false;
    newFolderName = "";
    if (!name || !currentPath) return;
    try {
      await api.fsCreateDir(currentPath + sep() + name);
      navigateTo(currentPath);
    } catch (e) {
      showToast(`Couldn't create folder: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function commitMove() {
    if (!movingEntry) return;
    const dest = moveDest.trim();
    const { path, name } = movingEntry;
    movingEntry = null;
    if (!dest) return;
    try {
      await api.fsMove(path, dest);
      showToast(`Moved ${name}`, "success");
      navigateTo(currentPath);
    } catch (e) {
      showToast(`Move failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions: click-anywhere dismisses the context menu (Escape also closes it); every action inside is a real button. -->
<div class="file-browser" onclick={closeContext} onkeydown={(e) => { if (e.key === 'Escape') closeContext(); }} role="application">
  <div class="browser-header">
    <button class="nav-btn" onclick={navigateUp} title="Up">↑</button>
    {#if editingPath}
      <input
        class="path-input"
        bind:value={pathInput}
        onkeydown={(e) => { if (e.key === "Enter") handlePathSubmit(); if (e.key === "Escape") { editingPath = false; pathInput = currentPath; } }}
        onblur={handlePathSubmit}
      />
    {:else}
      <button class="path-display" onclick={() => editingPath = true} title="Click to edit path">
        {currentPath || "Select folder..."}
      </button>
      {#if currentPath}
        <button class="nav-btn" onclick={() => { creatingFolder = true; newFolderName = ""; }} title="New folder" aria-label="New folder">
          <Icon name="plus" size={13} />
        </button>
      {/if}
    {/if}
  </div>

  {#if creatingFolder}
    <div class="confirm-strip" role="dialog" aria-label="New folder">
      <input
        class="rename-input"
        placeholder="Folder name"
        bind:value={newFolderName}
        aria-label="New folder name"
        onkeydown={(e) => {
          if (e.key === "Enter") commitNewFolder();
          if (e.key === "Escape") creatingFolder = false;
          e.stopPropagation();
        }}
        onclick={(e) => e.stopPropagation()}
      />
      <button class="confirm-yes" onclick={commitNewFolder} disabled={!newFolderName.trim()}>Create</button>
      <button class="confirm-no" onclick={() => (creatingFolder = false)}>Cancel</button>
    </div>
  {/if}

  {#if movingEntry}
    <div class="confirm-strip" role="dialog" aria-label="Move entry">
      <span class="confirm-text">Move {movingEntry.name} to:</span>
      <!-- svelte-ignore a11y_autofocus -->
      <input
        class="rename-input"
        bind:value={moveDest}
        aria-label="Destination folder"
        onkeydown={(e) => {
          if (e.key === "Enter") commitMove();
          if (e.key === "Escape") movingEntry = null;
          e.stopPropagation();
        }}
        onclick={(e) => e.stopPropagation()}
      />
      <button class="confirm-yes" onclick={commitMove} disabled={!moveDest.trim()}>Move</button>
      <button class="confirm-no" onclick={() => (movingEntry = null)}>Cancel</button>
    </div>
  {/if}

  {#if confirmingDelete}
    <div class="confirm-strip" role="alertdialog" aria-label="Confirm delete">
      <span class="confirm-text">Delete {confirmingDelete.name}?</span>
      <button class="confirm-yes" onclick={confirmDelete}>Delete</button>
      <button class="confirm-no" onclick={() => (confirmingDelete = null)}>Cancel</button>
    </div>
  {/if}

  <div class="entry-list">
    {#if entries.length === 0}
      {#if currentPath}
        <p class="empty">Empty folder</p>
      {:else}
        <div class="empty-vault">
          <p class="empty">No folder selected</p>
          <button class="nav-btn open-vault" onclick={() => { editingPath = true; pathInput = ""; setTimeout(() => document.querySelector<HTMLInputElement>(".path-input")?.focus(), 10); }} title="Type or paste a folder path">Choose folder…</button>
        </div>
      {/if}
    {:else}
      {#each entries as [name, isDir, size]}
        {@const fullPath = currentPath + (currentPath.includes("\\") ? "\\" : "/") + name}
        {#if renamingPath === fullPath}
          <div class="entry renaming">
            <span class="entry-icon"><Icon name={isDir ? "folder" : "files"} size={15} /></span>
            <input
              class="rename-input"
              bind:value={renameValue}
              aria-label="New name"
              onkeydown={(e) => {
                if (e.key === "Enter") commitRename(fullPath);
                if (e.key === "Escape") renamingPath = null;
                e.stopPropagation();
              }}
              onclick={(e) => e.stopPropagation()}
            />
          </div>
        {:else}
          <button
            class="entry"
            class:dir={isDir}
            onclick={() => handleEntryClick(name, isDir)}
            oncontextmenu={(e) => handleContext(e, name, isDir)}
          >
            <span class="entry-icon"><Icon name={isDir ? "folder" : "files"} size={15} /></span>
            <span class="entry-name">{name}</span>
            {#if !isDir}
              <span class="entry-size">{formatSize(size)}</span>
            {/if}
          </button>
        {/if}
      {/each}
    {/if}
  </div>
</div>

{#if contextMenu}
  <div class="ctx-overlay" onclick={closeContext} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closeContext(); }}>
    <div class="ctx-menu" role="menu" tabindex="-1" style="left: {contextMenu.x}px; top: {contextMenu.y}px;" onkeydown={(e) => { if (e.key === 'Escape') closeContext(); }}>
      <button role="menuitem" onclick={() => { handleContextAction("open-with"); closeContext(); }}>Open</button>
      <button role="menuitem" onclick={() => { handleContextAction("rename"); closeContext(); }}>Rename</button>
      <button role="menuitem" onclick={() => { handleContextAction("move"); closeContext(); }}>Move to…</button>
      <button role="menuitem" onclick={() => { handleContextAction("reveal"); closeContext(); }}>{isBrowserPreview() ? "Copy path" : "Reveal in Explorer"}</button>
      <button role="menuitem" class="danger" onclick={() => { handleContextAction("delete"); closeContext(); }}>Delete</button>
    </div>
  </div>
{/if}

<style>
  .file-browser {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--surface-base);
  }

  .browser-header {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px 8px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
  }

  .nav-btn {
    width: 24px;
    height: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .nav-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .path-display, .path-input {
    flex: 1;
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    background: transparent;
    border: none;
    text-align: left;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 2px 4px;
    border-radius: var(--radius-sm);
  }

  .path-display:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .path-input {
    color: var(--text-primary);
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    outline: none;
  }

  .entry-list {
    flex: 1;
    overflow-y: auto;
    padding: 4px;
  }

  .empty {
    font-size: 12px;
    color: var(--text-muted);
    text-align: center;
    padding: 20px;
    font-style: italic;
  }

  .empty-vault {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 20px;
  }

  .open-vault {
    width: auto;
    padding: 6px 14px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: 12px;
  }

  .entry {
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    padding: 4px 8px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-primary);
    text-align: left;
  }

  .entry:hover {
    background: var(--surface-overlay);
  }

  .entry.dir .entry-name {
    font-weight: 500;
  }

  .entry-icon {
    font-size: 12px;
    flex-shrink: 0;
  }

  .entry-name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-size {
    font-size: 10px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .entry.renaming {
    background: var(--surface-overlay);
  }

  .rename-input {
    flex: 1;
    min-width: 0;
    height: 24px;
    font-size: 12px;
  }

  .confirm-strip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-overlay);
    font-size: 12px;
  }

  .confirm-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-primary);
  }

  .confirm-yes {
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent-semantic-red);
    color: var(--accent-semantic-red);
    font-size: 12px;
    white-space: nowrap;
  }

  .confirm-yes:hover {
    background: var(--accent-semantic-red);
    color: var(--text-on-accent);
  }

  .confirm-no {
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    font-size: 12px;
  }

  .confirm-no:hover {
    background: var(--surface-pressed);
    color: var(--text-primary);
  }

  .ctx-overlay {
    position: fixed;
    inset: 0;
    z-index: 1000;
  }

  .ctx-menu {
    position: fixed;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px;
    min-width: 160px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
  }

  .ctx-menu button {
    display: block;
    width: 100%;
    padding: 6px 10px;
    text-align: left;
    font-size: 12px;
    color: var(--text-primary);
    border-radius: var(--radius-sm);
  }

  .ctx-menu button:hover {
    background: var(--surface-overlay);
  }

  .ctx-menu button.danger {
    color: var(--error);
  }
</style>
