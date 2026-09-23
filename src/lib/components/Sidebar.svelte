<script lang="ts">
  import {
    currentWorkspace,
    currentDoc,
    openTabs,
    sidebarOpen,
    aiPanelOpen,
    workspaces,
    showSettings,
  } from "$lib/stores/app";
  import { api } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { onMount } from "svelte";
  import { sidebarOrder, sidebarAutoSort, reorderSidebar, recordWorkspaceVisit, lastWorkspaceVisit } from "$lib/stores/uiState";
  import { groupOfWorkspace, groupRankOf } from "$lib/workspaceGroups";
  import Icon from "$lib/components/Icon.svelte";

  // New logo mark — same for all themes.
  let markSrc = "mark.png";

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
  };

  // Tooltips describe the workspace; drag-reorder needs no announcement.
  const wsTips: Record<string, string> = {
    home: "dashboard & recent work",
    logs: "daily notes & journal",
    write: "distraction-free writing",
    inbox: "untriaged captures",
    map: "link graph of your vault",
    canvas: "freeform visual board",
    novel: "Novel Studio",
    script: "screenplays (Fountain)",
    projects: "tasks, boards & deadlines",
    reader: "books & reading",
    files: "vault file browser",
    properties: "library views & files",
    craft: "writing craft",
    stats: "writing stats",
    skills: "AI skills",
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

  // Hidden from the sidebar (still reachable via command palette Ctrl+K
  // and direct navigation): Inbox + Canvas are power-user surfaces, and
  // Files lives inside Library's Files tab.
  const HIDDEN_IDS = ["inbox", "canvas", "files"];

  // Sidebar sections come from the shared grouping module (same categories
  // as mobile's More menu). Headers render when the group changes along the
  // (possibly user-sorted) list, so drag-reorder and auto-sort keep working.
  const wsGroup = groupOfWorkspace;
  const groupRank = groupRankOf;

  let displayWorkspaces = $derived.by(() => {
    const all = [...workspaces].filter((w) => !HIDDEN_IDS.includes(w.id));
    let ordered: typeof all;
    if (!$sidebarAutoSort && $sidebarOrder.length > 0) {
      const rank = new Map($sidebarOrder.map((id, i) => [id, i]));
      ordered = all.sort((a, b) => (rank.get(a.id) ?? 999) - (rank.get(b.id) ?? 999));
    } else {
      // Pinned first: Home stays visible above the recency sort.
      const pinned = all.filter((w) => w.id === "home");
      const rest = all.filter((w) => w.id !== "home");
      rest.sort((a, b) => {
        const ra = workspaceRecency[a.id] ?? 0;
        const rb = workspaceRecency[b.id] ?? 0;
        if (ra === rb) return a.label.localeCompare(b.label);
        return rb - ra;
      });
      ordered = [...pinned, ...rest];
    }
    return ordered
      .map((w, i) => ({ w, i }))
      .sort((a, b) => groupRank(a.w.id) - groupRank(b.w.id) || a.i - b.i)
      .map(({ w }) => w);
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

  // Streak + backup indicator (§A4.1): quiet proof-of-life in the footer.
  let streakDays = $state<number | null>(null);

  let backupState = $derived.by(() => {
    if ($settings.backupFrequency === "never") {
      return { label: "Backups off", stale: false, off: true };
    }
    if (!$settings.lastAutoBackup) {
      return { label: "Never backed up", stale: true, off: false };
    }
    const every =
      $settings.backupFrequency === "daily" ? 86400000
      : $settings.backupFrequency === "weekly" ? 7 * 86400000
      : 30 * 86400000;
    const age = Date.now() - +new Date($settings.lastAutoBackup);
    if (age > every * 1.5) {
      const days = Math.max(1, Math.round(age / 86400000));
      return { label: `Backup ${days}d overdue`, stale: true, off: false };
    }
    return { label: `Backed up ${timeAgoShort($settings.lastAutoBackup)}`, stale: false, off: false };
  });

  function timeAgoShort(iso: string): string {
    const mins = Math.max(0, Math.floor((Date.now() - +new Date(iso)) / 60000));
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  onMount(async () => {
    try {
      const [current] = await api.memoryGetStreak();
      streakDays = current;
    } catch {
      streakDays = null;
    }
  });
</script>

<aside class="sidebar {className}">
  <div class="wordmark">
    <img class="logo" src={markSrc} alt="Just Write ehis logo" />
    <span class="name">Just Write ehis</span>
    <button class="icon-btn sidebar-collapse-btn" onclick={() => ($sidebarOpen = false)} title="Hide sidebar (Ctrl+B)" aria-label="Hide sidebar">
      <Icon name="arrow-left" size={14} />
    </button>
  </div>

  <nav class="workspace-nav" aria-label="Workspaces">
    {#each displayWorkspaces as ws, i}
      {#if wsGroup(ws.id) && wsGroup(ws.id) !== wsGroup(displayWorkspaces[i - 1]?.id ?? "")}
        <div class="nav-group-label" aria-hidden="true">{wsGroup(ws.id)}</div>
      {/if}
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
        title={ws.id === "home" ? ws.label : ws.id === "inbox" ? `${ws.label} — untriaged captures` : `${ws.label} — ${wsTips[ws.id] ?? "workspace"}`}
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
    <button
      class="nav-item"
      class:active={$showSettings}
      onclick={toggleSettings}
      title="Settings"
      aria-label="Settings"
    >
      <span class="nav-icon"><Icon name="settings" size={17} /></span>
      <span>Settings</span>
    </button>
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
    <button class="footer-item" class:active={$aiPanelOpen} onclick={() => ($aiPanelOpen = !$aiPanelOpen)} title="AI panel (Ctrl+J)" aria-label="Toggle AI panel" aria-pressed={$aiPanelOpen}>
      <span class="nav-icon"><Icon name="sparkle" size={15} /></span>
      <span>AI Panel</span>
    </button>
    <div
      class="footer-stats"
      class:stale={backupState.stale}
      title={streakDays != null && streakDays > 0 ? `${streakDays}-day streak · ${backupState.label}` : backupState.label}
      aria-label={streakDays != null && streakDays > 0 ? `${streakDays}-day streak. ${backupState.label}.` : backupState.label}
    >
      <span class="nav-icon"><Icon name="star" size={13} /></span>
      <span class="streak-text">
        {streakDays != null && streakDays > 0 ? `${streakDays}-day streak` : "No streak yet"}
      </span>
      {#if !backupState.off}
        <span class="backup-dot" class:stale={backupState.stale} aria-hidden="true"></span>
      {/if}
    </div>
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

  .nav-group-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 10px 12px 2px;
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

  .footer-stats {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    border-top: 1px solid var(--border-subtle);
    font-size: 11px;
    color: var(--text-muted);
  }

  .footer-stats .streak-text {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .footer-stats.stale {
    color: var(--accent-semantic-yellow);
  }

  .backup-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent-semantic-green);
    flex-shrink: 0;
  }

  .backup-dot.stale {
    background: var(--accent-semantic-yellow);
  }
</style>
