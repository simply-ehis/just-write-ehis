<script lang="ts">
  import { onMount, untrack } from "svelte";
  import { api, isBrowserPreview, type Doc } from "$lib/api";
  import {
    currentWorkspace,
    currentDoc,
    openTabs,
    sidebarOpen,
    aiPanelOpen,
    inspectorOpen,
    workspaces,
    showSettings,
    zenMode,
  } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import TabBar from "$lib/components/TabBar.svelte";
  import BreadcrumbBar from "$lib/components/BreadcrumbBar.svelte";
  import StatusBar from "$lib/components/StatusBar.svelte";
  import EditorPane from "$lib/components/EditorPane.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import LogsWorkspace from "$lib/components/LogsWorkspace.svelte";
  import JustWriteWorkspace from "$lib/components/JustWriteWorkspace.svelte";
  import LazyWorkspace from "$lib/components/LazyWorkspace.svelte";
  import InspectorPanel from "$lib/components/InspectorPanel.svelte";
  import InboxWorkspace from "$lib/components/InboxWorkspace.svelte";
  import CommandPalette from "$lib/components/CommandPalette.svelte";
  import QuickCaptureOverlay from "$lib/components/QuickCaptureOverlay.svelte";
  import SkillNudges from "$lib/components/SkillNudges.svelte";
  import HomePane from "$lib/components/HomePane.svelte";
  import FileBrowser from "$lib/components/FileBrowser.svelte";
  import MarkdownViewer from "$lib/components/MarkdownViewer.svelte";
  import Toast from "$lib/components/Toast.svelte";
  import Banner from "$lib/components/Banner.svelte";
  import OnboardingOverlay from "$lib/components/OnboardingOverlay.svelte";
  import ConflictBanner from "$lib/components/ConflictBanner.svelte";
  import BottomBar from "$lib/components/BottomBar.svelte";
  import LockScreen from "$lib/components/LockScreen.svelte";
  import { unlockedDocs } from "$lib/stores/lock";
  import HelpOverlay from "$lib/components/HelpOverlay.svelte";
  import { showConflict } from "$lib/stores/conflict";
  import { settingsCategory } from "$lib/stores/settings";
  import { consumeLaunchParams, setupLaunchBridge } from "$lib/launch";
  let viewedFile = $state<string | null>(null);
  let showOnboarding = $state(false);

  // Skills/Craft/Stats now live in Settings: old workspace ids redirect.
  $effect(() => {
    const ws = $currentWorkspace;
    if (ws === "craft" || ws === "stats" || ws === "skills") {
      settingsCategory.set(ws);
      $showSettings = true;
      $currentWorkspace = "home";
    }
  });

  // Leaving Files drops the raw-file view so returning later starts at the
  // browser, not a stale file with no Back context.
  $effect(() => {
    if ($currentWorkspace !== "files" && viewedFile) viewedFile = null;
  });

  // Workspaces that render the open doc's content: a locked-out doc
  // covers the pane with the PIN gate (lists/graphs show titles only).
  const lockCoveredWorkspaces = ["write", "novel", "script", "reader", "logs", "files", "inbox", "projects", "craft", "properties", "canvas"];
  let lockCover = $derived(
    !$showSettings &&
    !!$currentDoc?.locked &&
    !$unlockedDocs.has($currentDoc.id) &&
    lockCoveredWorkspaces.includes($currentWorkspace)
  );

  let ready = $state(false);
  let isMobile = $state(false);
  let sidebarVisible = $state(false);
  // Typing focus: tab bar + breadcrumb collapse while prose is flowing,
  // restore after 2.5s idle, mouse-to-top, or Escape. Plain let timer:
  // only touched in event handlers, never inside an $effect.
  let typingFocus = $state(false);
  let typingIdleTimer: ReturnType<typeof setTimeout> | null = null;

  function handleEditorTyping() {
    if (!$settings.autoHideChrome || $zenMode || $showSettings) return;
    typingFocus = true;
    if (typingIdleTimer) clearTimeout(typingIdleTimer);
    typingIdleTimer = setTimeout(() => {
      typingFocus = false;
    }, 2500);
  }

  function handleMouseNearTop(e: MouseEvent) {
    if (typingFocus && e.clientY < 64) {
      typingFocus = false;
      if (typingIdleTimer) clearTimeout(typingIdleTimer);
    }
  }
  // Tab persistence guard: never write until the startup restore has run,
  // or the empty initial strip would clobber the saved one.
  let tabsRestored = false;

  /**
   * Restore the pre-restart tab strip (single global list, saved under the
   * "global" key — the UI model is one strip, not per-workspace strips).
   * Docs deleted since last session are dropped silently.
   */
  async function restoreTabs() {
    try {
      const saved = await api.tabsGet("global");
      const ids = saved?.tab_stack_json ? JSON.parse(saved.tab_stack_json) : [];
      if (!Array.isArray(ids) || ids.length === 0) return;
      const settled = await Promise.all(
        ids.slice(0, 30).map((id: string) => api.docGet(id).catch(() => null))
      );
      const docs = settled.filter((d): d is Doc => d !== null);
      if (docs.length === 0) return;
      $openTabs = docs;
      $currentDoc = (saved?.active_id && docs.find((d) => d.id === saved.active_id)) || docs[0];
      // Open on the active doc's workspace, not a bare home shell.
      if ($currentDoc) $currentWorkspace = $currentDoc.workspace;
    } catch {
      /* corrupted state or backend hiccup: start clean */
    } finally {
      tabsRestored = true;
    }
  }

  // Untracked box (not $state): reading+writing a reactive timer inside the
  // effect below would resubscribe and re-fire it forever, resetting the
  // debounce so tabs never persist.
  const tabSaveTimerBox: { id: ReturnType<typeof setTimeout> | null } = { id: null };

  $effect(() => {
    const tabs = $openTabs;
    const activeId = $currentDoc?.id ?? null;
    if (!tabsRestored || !ready) return;
    untrack(() => {
      if (tabSaveTimerBox.id) clearTimeout(tabSaveTimerBox.id);
      tabSaveTimerBox.id = setTimeout(() => {
        api.tabsSet({
          workspace: "global",
          tab_stack_json: JSON.stringify(tabs.map((t) => t.id)),
          active_id: activeId,
          cursor: null,
          scroll: null,
        }).catch(() => {});
      }, 800);
    });
  });
  function checkMobile() {
    isMobile = window.innerWidth <= 768;
    if (!isMobile) sidebarVisible = false;
  }

  function toggleSidebar() {
    sidebarVisible = !sidebarVisible;
  }

  function closeSidebar() {
    sidebarVisible = false;
  }

  function trackFeature(feature: string) {
    if (!$settings.featuresUsed.includes(feature)) {
      $settings = { ...$settings, featuresUsed: [...$settings.featuresUsed, feature] };
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (e.key === "F11") {
      e.preventDefault();
      $zenMode = !$zenMode;
    } else if (e.key === "Escape" && $zenMode) {
      $zenMode = false;
    } else if (e.key === "Escape" && typingFocus) {
      typingFocus = false;
    } else if (mod && (e.key === "j" || e.key === "J")) {
      e.preventDefault();
      $aiPanelOpen = !$aiPanelOpen;
    } else if (mod && (e.key === "b" || e.key === "B")) {
      e.preventDefault();
      $sidebarOpen = !$sidebarOpen;
    } else if (mod && (e.key === "i" || e.key === "I")) {
      e.preventDefault();
      $inspectorOpen = !$inspectorOpen;
    }
  }

  $effect(() => {
    if ($currentWorkspace) trackFeature($currentWorkspace);
  });

  // Apply the Settings → General theme to the document root.
  $effect(() => {
    document.documentElement.dataset.theme = $settings.theme;
  });

  // Per-workspace last place: remember the open doc when leaving a
  // workspace, restore it when coming back empty-handed. Open-doc flows
  // set workspace + doc together, so they never trigger a restore.
  let prevWorkspace = $state("home");

  $effect(() => {
    const ws = $currentWorkspace;
    if (ws === prevWorkspace) return;
    const outgoing = prevWorkspace;
    prevWorkspace = ws;
    if ($currentDoc) rememberPlace(outgoing, $currentDoc.id);
    if ($currentDoc?.workspace === ws || $showSettings) return;
    const id = placeFor(ws);
    if (!id || id === $currentDoc?.id) return;
    api.docGet(id)
      .then((d) => {
        if ($currentWorkspace !== ws) return;
        $currentDoc = d;
        if (!$openTabs.find((t) => t.id === d.id)) $openTabs = [d, ...$openTabs];
      })
      .catch(() => {
        forgetPlace(ws, id);
      });
  });

  $effect(() => {
    if ($aiPanelOpen) trackFeature("ai-panel");
  });

  import { listen } from "@tauri-apps/api/event";
  import { checkForUpdate } from "$lib/updates";
  import { showBanner, showToast } from "$lib/stores/notifications";
  import { forgetPlace, placeFor, rememberPlace } from "$lib/stores/lastPlace";

  const DAY_MS = 86400000;

  /** Weekly triage nudge, streak nudge, and scheduled auto-backup. */
  async function runStartupMaintenance() {
    const now = Date.now();
    const today = new Date().toISOString().slice(0, 10);

    // Inbox triage: stale captures + a week since the last nudge.
    if ($settings.weeklyTriageReminder) {
      const last = $settings.lastTriageShown ? +new Date($settings.lastTriageShown) : 0;
      if (now - last > 7 * DAY_MS) {
        try {
          const inbox = await api.docListByWorkspace("inbox");
          const stale = inbox.filter((d) => now - +new Date(d.created_at) > 7 * DAY_MS);
          if (stale.length > 0) {
            const oldest = Math.round((now - Math.min(...stale.map((d) => +new Date(d.created_at)))) / DAY_MS);
            showBanner(
              `${stale.length} inbox capture${stale.length === 1 ? "" : "s"} waiting triage (oldest ${oldest}d) — open Inbox to clear it.`,
              "info"
            );
            $settings = { ...$settings, lastTriageShown: new Date().toISOString() };
          }
        } catch {}
      }
    }

    // Streak nudge: an live streak with nothing written today, once a day.
    if ($settings.streakReminder && $settings.lastStreakShown?.slice(0, 10) !== today) {
      try {
        const [current] = await api.memoryGetStreak();
        if (current > 0) {
          const days = await api.dashboardWritingDays();
          if (!days.includes(today)) {
            showToast(`Day ${current + 1} starts with a sentence — your ${current}-day streak is waiting.`, "info", 6000);
            $settings = { ...$settings, lastStreakShown: new Date().toISOString() };
          }
        }
      } catch {}
    }

    // Automatic backup per Vaults → Backup Frequency (desktop shell only:
    // in the browser preview a backup is a file download, never silent).
    if (!isBrowserPreview() && $settings.backupFrequency !== "never") {
      const every = $settings.backupFrequency === "daily" ? DAY_MS : $settings.backupFrequency === "weekly" ? 7 * DAY_MS : 30 * DAY_MS;
      const last = $settings.lastAutoBackup ? +new Date($settings.lastAutoBackup) : 0;
      if (now - last > every) {
        try {
          await api.backupCreate();
          $settings = { ...$settings, lastAutoBackup: new Date().toISOString() };
          showToast("Automatic backup complete", "success");
        } catch (e) {
          console.warn("Auto-backup failed:", e);
        }
      }
    }
  }

  onMount(() => {
    checkMobile();
    window.addEventListener('resize', checkMobile);
    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('editor-typing', handleEditorTyping);
    window.addEventListener('mousemove', handleMouseNearTop);

    // Async init (fire and forget)
    (async () => {
      // File watching only exists under the Tauri shell; the browser
      // preview persists to localStorage instead.
      if (!isBrowserPreview()) {
        try {
          await api.setupFileWatcher();
          await listen<string>("file-changed", (event) => {
            const changedPath = event.payload;
            // If the changed file matches the current doc, show conflict banner
            if ($currentDoc && changedPath.includes($currentDoc.id)) {
              showConflict($currentDoc.id, changedPath, new Date().toISOString());
            }
          });
          // System-tray "Quick capture to Inbox" (§4.8): surface the window
          // on the inbox and focus its capture box.
          await listen("tray-capture", () => {
            $showSettings = false;
            $currentWorkspace = "inbox";
            setTimeout(() => {
              document.querySelector<HTMLInputElement>(".quick-capture input")?.focus();
            }, 350);
          });
        } catch {}
      }

      // Show onboarding on first launch
      if ($settings.featuresUsed.length === 0) {
        showOnboarding = true;
      }

      // Silent update check (desktop shell only, opt-out in Settings → About)
      if (!isBrowserPreview() && $settings.autoCheckUpdates) {
        checkForUpdate()
          .then((update) => {
            if (update) {
              showBanner(`Update ${update.version} available — open Settings → About to install.`, "info");
            }
          })
          .catch(() => {
            // Offline, unconfigured, or up to date: stay silent on startup.
          });
      }

    // Reminders + automatic backup live here so the toggles in
    // Settings → Capture and Vaults actually do something.
    runStartupMaintenance().catch(() => {});

    // Activity decay (powers smart-tab ranking): at most once a day —
    // the engine damps stale docs 5% per run, so every launch would over-decay.
    try {
      const todayKey = new Date().toISOString().slice(0, 10);
      if (localStorage.getItem("jwe-last-decay") !== todayKey) {
        api.memoryDecayActivity().then(
          () => {
            try {
              localStorage.setItem("jwe-last-decay", todayKey);
            } catch {}
          },
          () => {}
        );
      }
    } catch {}

      // Restore pre-restart tabs before first paint of the shell.
      await restoreTabs();

      // PWA entry points (share target, shortcuts, notification taps) win
      // over the restore: a launch intent is an explicit user action.
      // SW → app message bridge for shares while already open.
      setupLaunchBridge();
      try {
        await consumeLaunchParams();
      } catch {
        /* boot URL unreadable: normal startup continues */
      }

      ready = true;
    })();

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('editor-typing', handleEditorTyping);
      window.removeEventListener('mousemove', handleMouseNearTop);
      if (typingIdleTimer) clearTimeout(typingIdleTimer);
    };
  });

  $effect(() => {
    if (isMobile && sidebarVisible) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
  });
</script>

{#if ready}
  <div
    class="app-shell"
    class:with-ai-panel={$aiPanelOpen && !isMobile}
    class:with-inspector={$inspectorOpen && !isMobile}
    class:sidebar-collapsed={!$sidebarOpen}
    class:compact={$settings.compactMode}
    class:typing-focus={typingFocus && !$zenMode}
    class:mobile={isMobile}
    class:zen={$zenMode}
  >
    {#if isMobile}
      <div class="sidebar-overlay" class:open={sidebarVisible} onclick={closeSidebar} role="presentation"></div>
    {/if}

    <Sidebar class={isMobile ? (sidebarVisible ? 'open' : '') : ''} />

    <div class="main-area">
      {#if !$showSettings}
        <TabBar />
        {#if !isMobile}
          <BreadcrumbBar />
        {/if}
      {/if}
      <div class="content-pane" data-workspace={$currentWorkspace}>
        {#if isBrowserPreview()}
          <div class="preview-banner" title="Browser preview stores docs in localStorage. The desktop app uses the full Rust backend with files on disk.">
            Browser preview — docs persist to localStorage
          </div>
        {/if}
        <ConflictBanner />
        {#if lockCover && $currentDoc}
          <LockScreen doc={$currentDoc} />
        {/if}
        {#if $showSettings}
          <LazyWorkspace loader={() => import("$lib/components/SettingsPane.svelte")} />
        {:else if $currentWorkspace === "home"}
          <HomePane />
        {:else if $currentWorkspace === "logs"}
          <LogsWorkspace />
        {:else if $currentWorkspace === "write"}
          {#if $currentDoc}
            <JustWriteWorkspace />
          {:else}
            <EmptyState />
          {/if}
        {:else if $currentWorkspace === "map"}
          <LazyWorkspace loader={() => import("$lib/components/NodeMapWorkspace.svelte")} />
        {:else if $currentWorkspace === "canvas"}
          <LazyWorkspace loader={() => import("$lib/components/CanvasWorkspace.svelte")} />
        {:else if $currentWorkspace === "reader"}
          <LazyWorkspace loader={() => import("$lib/components/ReaderWorkspace.svelte")} />
        {:else if $currentWorkspace === "novel"}
          <LazyWorkspace loader={() => import("$lib/components/NovelWorkspace.svelte")} />
        {:else if $currentWorkspace === "script"}
          <LazyWorkspace loader={() => import("$lib/components/ScriptWorkspace.svelte")} />
        {:else if $currentWorkspace === "projects"}
          <LazyWorkspace loader={() => import("$lib/components/ProjectsWorkspace.svelte")} />
        {:else if $currentWorkspace === "inbox"}
          <InboxWorkspace />
        {:else if $currentWorkspace === "properties"}
          <LazyWorkspace loader={() => import("$lib/components/PropertiesView.svelte")} />
        {:else if $currentWorkspace === "files"}
          {#if viewedFile}
            <MarkdownViewer filePath={viewedFile} onClose={() => (viewedFile = null)} />
          {:else}
            <FileBrowser onSelect={(path, isDir) => { if (!isDir && (path.endsWith('.md') || path.endsWith('.txt'))) { viewedFile = path; } else if (!isDir) { api.docGet(path).then(d => { $currentDoc = d; if (!$openTabs.find(t => t.id === d.id)) $openTabs = [d, ...$openTabs]; }).catch(() => {}); } }} />
          {/if}
        {:else if $currentDoc}
          <EditorPane />
        {:else}
          <EmptyState />
        {/if}
      </div>
    </div>

    {#if $inspectorOpen && !isMobile}
      <InspectorPanel />
    {/if}

    {#if $aiPanelOpen}
      {#if isMobile}
        <div class="mobile-ai-overlay" onclick={(e) => { if (e.target === e.currentTarget) $aiPanelOpen = false; }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') $aiPanelOpen = false; }}>
          <div class="mobile-ai-container" role="dialog" tabindex="-1">
            <LazyWorkspace loader={() => import("$lib/components/AiPanel.svelte")} />
          </div>
        </div>
      {:else}
        <LazyWorkspace loader={() => import("$lib/components/AiPanel.svelte")} />
      {/if}
    {/if}

    <CommandPalette />
    <QuickCaptureOverlay />
    <SkillNudges />
    <StatusBar />
  </div>
{:else}
  <div class="empty-state">
    <img class="boot-logo" src="boot-logo.png" alt="Just Write ehis" />
    <div class="message">Loading...</div>
  </div>
{/if}

<Banner />
<Toast />
{#if isMobile}
  <BottomBar />
{/if}
<HelpOverlay />
{#if showOnboarding}
  <OnboardingOverlay onComplete={() => { showOnboarding = false; }} />
{/if}

<style>
  .sidebar-overlay {
    display: none;
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    z-index: 499;
  }

  .sidebar-overlay.open {
    display: block;
  }

  .mobile-ai-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    z-index: 300;
    display: flex;
    align-items: flex-end;
    justify-content: center;
  }

  .mobile-ai-container {
    width: 100%;
    max-height: 80vh;
    background: var(--surface-base);
    border-top: 1px solid var(--border-subtle);
    overflow: hidden;
  }

  .preview-banner {
    flex-shrink: 0;
    padding: 4px 12px;
    font-size: 11px;
    text-align: center;
    color: var(--text-secondary);
    background: var(--surface-overlay);
    border-bottom: 1px solid var(--border-subtle);
  }

  .boot-logo {
    height: 64px;
    width: auto;
  }
</style>
