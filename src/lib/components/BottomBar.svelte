<script lang="ts">
  /**
   * BottomBar — persistent mobile navigation (A7.2).
   * Items: Capture+, Home, Search, Workspaces, More.
   * Shows only on mobile (isMobile breakpoint).
   */
  import { currentWorkspace, showSettings, aiPanelOpen, workspaces } from "$lib/stores/app";
  import { recordWorkspaceVisit } from "$lib/stores/uiState";
  import { saveState } from "$lib/stores/saveState";
  import { settings } from "$lib/stores/settings";
  import type { AppSettings } from "$lib/stores/settings";
  import { WORKSPACE_GROUPS } from "$lib/workspaceGroups";
  import Icon from "$lib/components/Icon.svelte";

  interface BottomBarItem {
    id: string;
    label: string;
    icon: string;
    action: () => void;
  }

  let showMoreMenu = $state(false);

  function handleCapture() {
    // Navigate to Just Write workspace (capture mode)
    $currentWorkspace = "write";
    showMoreMenu = false;
  }

  function handleHome() {
    $currentWorkspace = "home";
    showMoreMenu = false;
  }

  function handleSearch() {
    // CommandPalette listens for this on window (desktop Ctrl+K path reuses
    // the same overlay, sized full-screen on mobile per A7.2).
    window.dispatchEvent(new CustomEvent("open-command-palette"));
    showMoreMenu = false;
  }

  function handleWorkspaces() {
    showMoreMenu = !showMoreMenu;
  }

  // The More menu reads the SAME grouping as the desktop sidebar, so the
  // two can never drift apart again. Write lives in the main row (not
  // repeated here); Craft/Stats/Skills are Settings tabs, not
  // destinations, so they get no entries (single Settings entry below).
  interface MoreSection {
    label: string;
    items: { id: string; label: string; icon: string }[];
  }

  const moreSections: MoreSection[] = [
    ...WORKSPACE_GROUPS.map((g) => ({
      label: g.label,
      items: g.members
        .filter((id) => id !== "write")
        .flatMap((id) => {
          const meta = workspaces.find((w) => w.id === id);
          return meta ? [{ id, label: meta.label, icon: meta.icon }] : [];
        }),
    })).filter((s) => s.items.length > 0),
    {
      label: "Tools",
      items: [
        { id: "ai", label: "AI Panel", icon: "sparkle" },
        { id: "settings", label: "Settings", icon: "settings" },
      ],
    },
  ];

  function handleMoreAction(action: string) {
    showMoreMenu = false;
    if (action === "settings") {
      $showSettings = true;
      return;
    }
    if (action === "ai") {
      $aiPanelOpen = !$aiPanelOpen;
      return;
    }
    // "files" is virtual (no route) — it deep-links to Library's Files tab.
    if (action === "files") {
      $currentWorkspace = "properties";
      recordWorkspaceVisit("properties");
      window.dispatchEvent(new CustomEvent("open-library-files"));
      return;
    }
    $currentWorkspace = action;
    recordWorkspaceVisit(action);
  }

  // Main row: onboarding top-bar pins (first 3) + Search + More.
  // Default ["write","home"] reproduces the classic row exactly.
  // "files" can never pin (virtual destination) — filtered here.
  function navigateTo(id: string) {
    if (id === "files") {
      handleMoreAction("files");
      return;
    }
    $currentWorkspace = id;
    recordWorkspaceVisit(id);
    showMoreMenu = false;
  }

  let pinnedIds = $derived(
    ($settings.topBarIds.length > 0 ? $settings.topBarIds : ["write", "home"])
      .filter((id) => id !== "files" && workspaces.some((w) => w.id === id))
      .slice(0, 3)
  );

  const PIN_ICONS: Record<string, string> = {
    home: "home", logs: "calendar", write: "pencil", inbox: "inbox",
    map: "graph", canvas: "board", novel: "book", script: "film",
    projects: "folder", reader: "book-open", files: "files", properties: "table",
  };

  let mainItems = $derived<BottomBarItem[]>([
    ...pinnedIds.flatMap((id): BottomBarItem[] => {
      const meta = workspaces.find((w) => w.id === id);
      if (!meta) return [];
      if (id === "write") return [{ id: "capture", label: "Write", icon: "pencil", action: handleCapture }];
      if (id === "home") return [{ id: "home", label: "Home", icon: "home", action: handleHome }];
      return [{ id, label: meta.label, icon: PIN_ICONS[id] ?? "files", action: () => navigateTo(id) }];
    }),
    { id: "search", label: "Search", icon: "search", action: handleSearch },
    { id: "workspaces", label: "More", icon: "dots", action: handleWorkspaces },
  ]);
</script>

<nav class="bottom-bar" aria-label="Mobile navigation">
  {#each mainItems as item}
    <button
      class="bottom-bar-item"
      class:active={$currentWorkspace === item.id || (item.id === "workspaces" && showMoreMenu)}
      onclick={item.action}
      aria-label={item.label}
    >
      <span class="bottom-bar-icon"><Icon name={item.icon} size={21} label={item.label} /></span>
      <span class="bottom-bar-label">{item.label}</span>
    </button>
  {/each}
  {#if $saveState !== "idle"}
    <span
      class="save-dot"
      class:saving={$saveState === "saving"}
      title={$saveState === "saving" ? "Saving…" : "Saved"}
      aria-hidden="true"
    ></span>
  {/if}
</nav>

{#if showMoreMenu}
  <div class="more-overlay" onclick={() => showMoreMenu = false} role="presentation"></div>
  <div class="more-menu">
    {#each moreSections as section}
      <div class="more-section-label" aria-hidden="true">{section.label}</div>
      {#each section.items as item}
        <button class="more-item" onclick={() => handleMoreAction(item.id)} aria-label={item.label} title={item.label}>
          <span class="more-icon"><Icon name={item.icon} size={22} /></span>
          <span class="more-label">{item.label}</span>
        </button>
      {/each}
    {/each}
  </div>
{/if}

<style>
  .bottom-bar {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: space-around;
    height: 56px;
    background: var(--surface-base);
    border-top: 1px solid var(--border-subtle);
    z-index: 500;
    padding-bottom: env(safe-area-inset-bottom, 0);
  }

  .bottom-bar-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    flex: 1;
    height: 100%;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    transition: color 0.15s;
    -webkit-tap-highlight-color: transparent;
  }

  .bottom-bar-item.active {
    color: var(--accent-write);
  }

  .bottom-bar-item:active {
    opacity: 0.7;
  }

  .bottom-bar-icon {
    font-size: 20px;
    line-height: 1;
  }

  .bottom-bar-label {
    font-size: 10px;
    font-weight: var(--font-weight-medium);
  }

  .more-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    z-index: 501;
  }

  .more-menu {
    position: fixed;
    bottom: 56px;
    left: 0;
    right: 0;
    background: var(--surface-raised);
    border-top: 1px solid var(--border-subtle);
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1px;
    padding: 8px;
    z-index: 502;
    max-height: 60vh;
    overflow-y: auto;
  }

  .more-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 12px 8px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-md);
    -webkit-tap-highlight-color: transparent;
  }

  .more-item:active {
    background: var(--surface-pressed);
  }

  .more-section-label {
    grid-column: 1 / -1;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 10px 8px 2px;
  }

  /* Save-state signal (StatusBar is desktop-only): quiet proof the
    vault persisted, without a second bottom strip on phones. */
  .save-dot {
    position: absolute;
    top: 5px;
    right: 8px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    pointer-events: none;
  }

  .save-dot.saving {
    background: var(--warning);
  }

  .more-icon {
    font-size: 22px;
  }

  .more-label {
    font-size: 11px;
  }
</style>
