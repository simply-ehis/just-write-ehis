<script lang="ts">
  /**
   * BottomBar — persistent mobile navigation (A7.2).
   * Items: Capture+, Home, Search, Workspaces, More.
   * Shows only on mobile (isMobile breakpoint).
   */
  import { currentWorkspace, showSettings, aiPanelOpen } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import type { AppSettings } from "$lib/stores/settings";
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

  function handleMoreAction(action: string) {
    showMoreMenu = false;
    switch (action) {
      case "logs": $currentWorkspace = "logs"; break;
      case "inbox": $currentWorkspace = "inbox"; break;
      case "map": $currentWorkspace = "map"; break;
      case "canvas": $currentWorkspace = "canvas"; break;
      case "novel": $currentWorkspace = "novel"; break;
      case "script": $currentWorkspace = "script"; break;
      case "projects": $currentWorkspace = "projects"; break;
      case "reader": $currentWorkspace = "reader"; break;
      case "files": $currentWorkspace = "files"; break;
      case "properties": $currentWorkspace = "properties"; break;
      case "craft": $currentWorkspace = "craft"; break;
      case "stats": $currentWorkspace = "stats"; break;
      case "skills": $currentWorkspace = "skills"; break;
      case "settings": $showSettings = true; break;
      case "ai": $aiPanelOpen = !$aiPanelOpen; break;
    }
  }

  const mainItems: BottomBarItem[] = [
    { id: "capture", label: "Write", icon: "pencil", action: handleCapture },
    { id: "home", label: "Home", icon: "home", action: handleHome },
    { id: "search", label: "Search", icon: "search", action: handleSearch },
    { id: "workspaces", label: "More", icon: "dots", action: handleWorkspaces },
  ];

  const moreItems = [
    { id: "logs", label: "Logs", icon: "calendar" },
    { id: "inbox", label: "Inbox", icon: "inbox" },
    { id: "map", label: "Map", icon: "graph" },
    { id: "canvas", label: "Canvas", icon: "board" },
    { id: "novel", label: "Novel", icon: "book" },
    { id: "script", label: "Script", icon: "film" },
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "reader", label: "Reader", icon: "book-open" },
    { id: "files", label: "Files", icon: "files" },
    { id: "properties", label: "Library", icon: "table" },
    { id: "craft", label: "Craft", icon: "chart" },
    { id: "stats", label: "Stats", icon: "calendar" },
    { id: "skills", label: "Skills", icon: "sparkle" },
    { id: "ai", label: "AI Panel", icon: "sparkle" },
    { id: "settings", label: "Settings", icon: "settings" },
  ];
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
</nav>

{#if showMoreMenu}
  <div class="more-overlay" onclick={() => showMoreMenu = false} role="presentation"></div>
  <div class="more-menu">
    {#each moreItems as item}
      <button class="more-item" onclick={() => handleMoreAction(item.id)} aria-label={item.label} title={item.label}>
        <span class="more-icon"><Icon name={item.icon} size={22} /></span>
        <span class="more-label">{item.label}</span>
      </button>
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
    background: rgba(0, 0, 0, 0.4);
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

  .more-icon {
    font-size: 22px;
  }

  .more-label {
    font-size: 11px;
  }
</style>
