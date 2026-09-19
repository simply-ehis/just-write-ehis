<script lang="ts">
  import {
    currentWorkspace,
    currentDoc,
    openTabs,
    sidebarOpen,
    workspaces,
    showSettings,
  } from "$lib/stores/app";
  import { api } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { sidebarOrder, sidebarAutoSort, reorderSidebar, recordWorkspaceVisit, lastWorkspaceVisit } from "$lib/stores/uiState";
  import Icon from "$lib/components/Icon.svelte";

  // Black master artwork on light theme, white variant on dark.
  let markSrc = $derived($settings.theme === "light" ? "logo.svg" : "logo-light.svg");

  const wsIcons: Record<string, string> = {
    home: "home",
    logs: "calendar",
    write: "pencil",
    inbox: "inbox",
    map: "graph",
    canvas: "board",
    novel: "book",
    script: "film",
    projects: "folder",
    reader: "book-open",
    files: "files",
    properties: "table",
    craft: "chart",
    stats: "calendar",
    skills: "sparkle",
  };

  let { class: className = '' } = $props();

  // Sidebar auto-sort: home pinned first, the rest by most recently
  // visited. Manual drag-reorder persists and disables auto-sort.
  let workspaceRecency = $derived($lastWorkspaceVisit);
  let dragWsId = $state<string | null>(null);
  // Inbox badge: live untriaged count so capture is always visible (§4.8, A4.1).
  let inboxCount = $state<number | null>(null);

  async function refreshInboxCount() {
    try {
      const docs = await api.docListByWorkspace("inbox");
      inboxCount = docs.length;
    } catch {
      inboxCount = null;
    }
  }

  $effect(() => {
    // Refresh badge on mount and whenever we visit/leave the inbox.
    void $currentWorkspace;
    refreshInboxCount();
  });

  let displayWorkspaces = $derived.by(() => {
    const all = [...workspaces];
    if (!$sidebarAutoSort && $sidebarOrder.length > 0) {
      const rank = new Map($sidebarOrder.map((id, i) => [id, i]));
      return all.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    }
    // Pinned first: Home + Inbox stay visible above the recency sort so
    // global capture (§4.8) is never buried by visit order.
    const pinnedIds = ["home", "inbox"];
    const pinned = pinnedIds.flatMap((id) => all.filter((w) => w.id === id));
    const rest = all.filter((w) => !pinnedIds.includes(w.id));
    rest.sort((a, b) => {
      const ra = workspaceRecency[a.id] ?? 0;
      const rb = workspaceRecency[b.id] ?? 0;
      if (ra === rb) return a.label.localeCompare(b.label);
      return rb - ra;
    });
    return [...pinned, ...rest];
  });

  function handleWsDragStart(id: string, e: DragEvent) {
    dragWsId = id;
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", id);
    }
  }

  function handleWsDrop(targetId: string, e: DragEvent) {
    e.preventDefault();
    if (!dragWsId || dragWsId === targetId || dragWsId === "home" || targetId === "home" || dragWsId === "inbox" || targetId === "inbox") {
      dragWsId = null;
      return;
    }
    const ids: string[] = displayWorkspaces.map((w) => w.id).filter((id) => id !== "home");
    const from = ids.indexOf(dragWsId);
    const to = ids.indexOf(targetId);
    if (from === -1 || to === -1) {
      dragWsId = null;
      return;
    }
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    reorderSidebar(["home", ...ids]);
    dragWsId = null;
  }

  function selectWorkspace(id: string) {
    $currentWorkspace = id;
    $showSettings = false;
    recordWorkspaceVisit(id);
  }

  function toggleSettings() {
    $showSettings = !$showSettings;
  }

  async function handleNewDoc() {
    try {
      const doc = await api.docCreate(
        $currentWorkspace,
        "doc",
        "Untitled"
      );
      $currentDoc = doc;
      $openTabs = [doc, ...$openTabs];
      $showSettings = false;
    } catch (e) {
      console.error("Failed to create doc:", e);
    }
  }
</script>

<aside class="sidebar {className}">
  <div class="wordmark">
    <img class="logo" src={markSrc} alt="Just Write ehis logo" />
    <span class="name">Just Write ehis</span>
  </div>

  <nav class="workspace-nav" aria-label="Workspaces">
    {#each displayWorkspaces as ws}
      <button
        class="nav-item"
        class:active={$currentWorkspace === ws.id && !$showSettings}
        data-ws={ws.id}
        draggable={ws.id !== "home" && ws.id !== "inbox" ? "true" : undefined}
        onclick={() => selectWorkspace(ws.id)}
        ondragstart={(e) => handleWsDragStart(ws.id, e)}
        ondragover={(e) => e.preventDefault()}
        ondrop={(e) => handleWsDrop(ws.id, e)}
        ondragend={() => (dragWsId = null)}
        title={ws.id === "home" ? ws.label : ws.id === "inbox" ? `${ws.label} — untriaged captures` : `${ws.label} — drag to reorder`}
        aria-label={ws.id === "inbox" && inboxCount ? `Inbox, ${inboxCount} untriaged` : ws.label}
      >
        <span class="nav-icon">
          {#if ws.id === "home"}
            <img class="home-mark" src={markSrc} alt="" aria-hidden="true" />
          {:else}
            <Icon name={wsIcons[ws.id] ?? "files"} size={17} />
          {/if}
        </span>
        <span>{ws.label}</span>
        {#if ws.id === "inbox" && inboxCount != null && inboxCount > 0}
          <span class="nav-badge" aria-hidden="true">{inboxCount > 99 ? "99+" : inboxCount}</span>
        {/if}
      </button>
    {/each}
  </nav>

  <div class="sidebar-footer">
    <button
      class="footer-item"
      class:active={$sidebarAutoSort}
      onclick={() => sidebarAutoSort.set(!$sidebarAutoSort)}
      title={$sidebarAutoSort ? "Auto-sort on: most visited first" : "Auto-sort off: manual order"}
      aria-label="Toggle sidebar auto-sort"
      aria-pressed={$sidebarAutoSort}
    >
      <span class="nav-icon"><Icon name="refresh" size={15} /></span>
      <span>Auto-sort</span>
    </button>
    <button class="footer-item" onclick={handleNewDoc} title="New document" aria-label="New document">
      <span class="nav-icon"><Icon name="plus" size={15} /></span>
      <span>New Doc</span>
    </button>
    <button class="footer-item" class:active={$showSettings} onclick={toggleSettings} title="Settings" aria-label="Settings">
      <span class="nav-icon"><Icon name="settings" size={15} /></span>
      <span>Settings</span>
    </button>
  </div>
</aside>

<style>
  .wordmark {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 16px 12px;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    height: 30px;
    width: auto;
    flex-shrink: 0;
  }

  .nav-icon {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    justify-content: center;
    width: 20px;
    height: 20px;
  }

  .home-mark {
    width: 20px;
    height: auto;
  }

  .nav-badge {
    margin-left: auto;
    min-width: 20px;
    height: 18px;
    padding: 0 6px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: 999px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: 11px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .name {
    font-weight: 600;
    font-size: 15px;
  }
</style>
