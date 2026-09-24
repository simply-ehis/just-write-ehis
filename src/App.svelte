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
  import { settings, ONBOARD_VERSION } from "$lib/stores/settings";
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
  import Toast from "$lib/components/Toast.svelte";
  import Banner from "$lib/components/Banner.svelte";
  import OnboardingOverlay from "$lib/components/OnboardingOverlay.svelte";
  import ConflictBanner from "$lib/components/ConflictBanner.svelte";
  import BottomBar from "$lib/components/BottomBar.svelte";
  import LockScreen from "$lib/components/LockScreen.svelte";
import BootLoader from "$lib/components/BootLoader.svelte";
  import { unlockedDocs } from "$lib/stores/lock";
  import HelpOverlay from "$lib/components/HelpOverlay.svelte";
  import { showConflict } from "$lib/stores/conflict";
  import { settingsCategory } from "$lib/stores/settings";
  import { consumeLaunchParams, setupLaunchBridge } from "$lib/launch";
  import { consumeNativeLaunchFile, listenForNativeFileOpen } from "$lib/nativeLaunch";
  import { initializeMainWindowBridge } from "$lib/widgetBridge";
  let showOnboarding = $state(false);
  // Freshness snapshot at component init: mount effects (trackFeature on
  // currentWorkspace) pollute featuresUsed before the async boot block
  // below runs, so the check must use this, not the live store.
  const freshInstallAtBoot = $settings.featuresUsed.length === 0;

  // Tips/Craft/Stats now live in Settings: old workspace ids redirect.
  $effect(() => {
    const ws = $currentWorkspace;
    if (ws === "craft" || ws === "stats" || ws === "skills") {
      settingsCategory.set(ws);
      $showSettings = true;
      $currentWorkspace = "home";
    }
  });

  // Workspaces that render the open doc's content: a locked-out doc
  // covers the pane with the PIN gate (lists/graphs show titles only).
  const lockCoveredWorkspaces = ["write", "novel", "script", "reader", "logs", "inbox", "projects", "properties", "canvas"];
  let lockCover = $derived(
    $settings.lockEnabled &&
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
  let disposeWidgetBridge: (() => void) | null = null;
  let disposeNativeFileListener: (() => void) | null = null;

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
      const wanted = ids.slice(0, 30);
      const getDoc = (id: string) => api.docGet(id).catch(() => null);
      // Active doc first for instant paint; the rest of the strip streams
      // in behind it in batches of 8 so cold SQLite never faces a 30-wide
      // fan-out before the shell is useful.
      const activeId = saved?.active_id;
      const rest = activeId ? wanted.filter((id: string) => id !== activeId) : wanted;
      if (activeId) {
        const first = await getDoc(activeId);
        if (first) {
          $openTabs = [first];
          $currentDoc = first;
          $currentWorkspace = first.workspace;
        }
      }
      const seen = new Set(($openTabs as Doc[]).map((d) => d.id));
      for (let i = 0; i < rest.length; i += 8) {
        const batch = await Promise.all(rest.slice(i, i + 8).map(getDoc));
        const fresh = batch.filter((d): d is Doc => d !== null && !seen.has(d.id));
        if (fresh.length === 0) continue;
        fresh.forEach((d) => seen.add(d.id));
        $openTabs = [...$openTabs, ...fresh];
        if (!$currentDoc) {
          $currentDoc = fresh[0];
          $currentWorkspace = fresh[0].workspace;
        }
      }
      // Restore the saved strip order once everything resolved.
      const byId = new Map(($openTabs as Doc[]).map((d) => [d.id, d]));
      const ordered = wanted.map((id: string) => byId.get(id)).filter((d): d is Doc => !!d);
      if (ordered.length > 0) $openTabs = ordered;
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

  /**
   * Boot resilience: every awaited startup step races a timeout so a single
   * hung call (event listener, watcher, restore) can never trap the app on
   * the splash screen. Returns null on timeout/failure and records the step
   * in localStorage (`jwe-boot-step`) for diagnosis.
   */
  let bootSlowSteps: string[] = [];
  function markBootStep(step: string): void {
    try {
      localStorage.setItem("jwe-boot-step", step);
    } catch {
      /* storage unavailable: keep booting */
    }
  }
  /** Report navigation-start → interactive-shell milliseconds once. */
  let bootReported = false;
  function reportBootMs(): void {
    if (bootReported) return;
    bootReported = true;
    try {
      const t0 = (window as unknown as { __jweBootT0?: number }).__jweBootT0;
      if (typeof t0 === "number") {
        const ms = Math.round(performance.now() - t0);
        console.info(`[boot] shell interactive in ${ms}ms${bootSlowSteps.length > 0 ? ` (slow steps: ${bootSlowSteps.join(", ")})` : ""}`);
        localStorage.setItem("jwe-boot-ms", String(ms));
      }
      localStorage.removeItem("jwe-boot-step");
    } catch {
      /* timing unavailable: boot continues */
    }
  }
  async function bootStep<T>(step: string, ms: number, fn: () => Promise<T>): Promise<T | null> {
    markBootStep(step);
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        fn(),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), ms);
        }),
      ]);
      if (result === null && timer !== null) {
        // fn() is still pending — stop waiting, keep booting.
        bootSlowSteps.push(step);
        console.warn(`Boot step "${step}" timed out after ${ms}ms — continuing without it.`);
      }
      return result;
    } catch (e) {
      console.warn(`Boot step "${step}" failed:`, e);
      return null;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // Tab persist failure would silently lose the strip on next launch —
  // warn once per session instead of every 800ms.
  let tabPersistWarned = false;
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
        }).catch((e) => {
          warnOnce("Tabs persist", e);
          if (!tabPersistWarned) {
            tabPersistWarned = true;
            showToast("Tabs — couldn't save tab strip: reopened tabs may be lost on restart", "warning");
          }
        });
      }, 800);
    });
  });
  function checkMobile() {
    // Soft-keyboard squeeze: visualViewport shrinks on focus in mobile
    // browsers while innerWidth does not, so the breakpoint follows the
    // smaller of the two.
    const viewport = window.visualViewport;
    isMobile = Math.min(window.innerWidth, viewport?.width ?? window.innerWidth) <= 768;
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
    // Record where we came from for the global Back button. If the doc
    // moved with the workspace, the remembered per-workspace doc is the
    // right return target; popNavHistory's suppressPush skips re-recording.
    const leavingDoc =
      $currentDoc?.workspace === outgoing ? $currentDoc.id : placeFor(outgoing);
    pushNavHistory({ workspace: outgoing, docId: leavingDoc });
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
      .catch((e) => {
        warnOnce("Tabs last-place", e);
        forgetPlace(ws, id);
      });
  });

  $effect(() => {
    if ($aiPanelOpen) trackFeature("ai-panel");
  });

  import { listen } from "@tauri-apps/api/event";
  import { checkForUpdate } from "$lib/updates";
  import { showBanner, showToast } from "$lib/stores/notifications";
  import { warnOnce } from "$lib/errors";
  import { forgetPlace, placeFor, rememberPlace, pushNavHistory } from "$lib/stores/lastPlace";

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
        } catch (e) {
          console.warn("Inbox triage banner failed:", e);
        }
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
      } catch (e) {
        console.warn("Streak nudge failed:", e);
      }
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
    window.visualViewport?.addEventListener('resize', checkMobile);
    window.addEventListener('keydown', handleGlobalKeydown);
    window.addEventListener('editor-typing', handleEditorTyping);
    window.addEventListener('mousemove', handleMouseNearTop);
    // Re-entry: Settings → General and the command palette dispatch this.
    const replayOnboarding = () => { showOnboarding = true; };
    window.addEventListener('replay-onboarding', replayOnboarding);

    // Async init (fire and forget) — with an absolute failsafe: the
    // splash screen must never trap the user, even if every step hangs.
    const bootFailsafe = setTimeout(() => {
      if (!ready) {
        console.warn("Boot failsafe fired — showing the shell anyway.");
        try {
          showBanner("Startup took too long — some services may still be starting.", "warning");
        } catch {
          /* banners unavailable: shell still shows */
        }
        ready = true;
        reportBootMs();
      }
    }, 20000);
    (async () => {
    try {
      // File watching only exists under the Tauri shell; the browser
      // preview persists to localStorage instead.
      if (!isBrowserPreview()) {
        // Independent subscriptions boot concurrently: one slow IPC must
        // not serialize the rest (previously sequential awaits).
        const [bridge, nativeFile] = await Promise.all([
          bootStep("widget-bridge", 8000, () => initializeMainWindowBridge()),
          bootStep("native-file-listener", 8000, () => listenForNativeFileOpen()),
          bootStep("file-watcher", 8000, () => api.setupFileWatcher()),
          bootStep("file-changed-listener", 8000, () => listen<string>("file-changed", (event) => {
            const changedPath = event.payload;
            // If the changed file matches the current doc, show conflict banner
            if ($currentDoc && changedPath.includes($currentDoc.id)) {
              showConflict($currentDoc.id, changedPath, new Date().toISOString());
            }
          })),
          // System-tray "Quick capture to Inbox" (§4.8): surface the window
          // on the inbox and focus its capture box.
          bootStep("tray-capture-listener", 8000, () => listen("tray-capture", () => {
            $showSettings = false;
            $currentWorkspace = "inbox";
            setTimeout(() => {
              document.querySelector<HTMLInputElement>(".quick-capture input")?.focus();
            }, 350);
          })),
        ]);
        disposeWidgetBridge = bridge;
        disposeNativeFileListener = nativeFile;
      }

      // Onboarding: explicit versioned flag. Veterans (pre-flag settings
      // with real usage) are migrated silently — never re-prompt them.
      // Freshness comes from the init-time snapshot: trackFeature() runs
      // on mount and would otherwise make every fresh boot look "used".
      if (!$settings.hasOnboarded) {
        if (!freshInstallAtBoot) {
          $settings = { ...$settings, hasOnboarded: true, onboardedVersion: ONBOARD_VERSION };
        } else {
          showOnboarding = true;
        }
      }

      // Re-entry is wired in the onMount body above (replay-onboarding).

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

    // Reminders + automatic backup + activity decay are heavy post-boot
    // work (whole-vault zip, full-table update, inbox scans). They wait for
    // an idle moment so they never contend first paint or the tab restore.
    const runPostBoot = () => {
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
              } catch (e) {
                console.warn("Failed to record decay key:", e);
              }
            },
            () => {}
          );
        }
      } catch (e) {
        console.warn("Activity decay check failed:", e);
      }
    };
    if (typeof requestIdleCallback === "function") {
      requestIdleCallback(() => runPostBoot(), { timeout: 8000 });
    } else {
      setTimeout(runPostBoot, 5000);
    }

      // Landing workspace (onboarding choice, default "home"): applies
      // only when nothing restores over it — open tabs and launch
      // intents below both win.
      $currentWorkspace = $settings.defaultWorkspace || "home";

      // Restore pre-restart tabs before first paint of the shell.
      await bootStep("restore-tabs", 15000, () => restoreTabs());

      // PWA entry points (share target, shortcuts, notification taps) win
      // over the restore: a launch intent is an explicit user action.
      // SW → app message bridge for shares while already open.
       setupLaunchBridge();
       try {
         await bootStep("launch-params", 8000, () => consumeLaunchParams());
       } catch {
         /* boot URL unreadable: normal startup continues */
       }
        await bootStep("native-launch-file", 8000, () => consumeNativeLaunchFile());

        markBootStep("done");
        ready = true;
        reportBootMs();
      } finally {
        clearTimeout(bootFailsafe);
        // ready is set even if a step threw outside bootStep.
        ready = true;
        reportBootMs();
      }
    })();

    return () => {
      window.removeEventListener('resize', checkMobile);
      window.visualViewport?.removeEventListener('resize', checkMobile);
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('editor-typing', handleEditorTyping);
      window.removeEventListener('mousemove', handleMouseNearTop);
      window.removeEventListener('replay-onboarding', replayOnboarding);
       if (typingIdleTimer) clearTimeout(typingIdleTimer);
       disposeNativeFileListener?.();
       disposeWidgetBridge?.();

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
          <LazyWorkspace loader={() => import("$lib/components/SettingsPane.svelte")} label="Settings" />
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
          <LazyWorkspace loader={() => import("$lib/components/NodeMapWorkspace.svelte")} label="Node Map" />
        {:else if $currentWorkspace === "canvas"}
          <LazyWorkspace loader={() => import("$lib/components/CanvasWorkspace.svelte")} label="Canvas" />
        {:else if $currentWorkspace === "reader"}
          <LazyWorkspace loader={() => import("$lib/components/ReaderWorkspace.svelte")} label="Reader" />
        {:else if $currentWorkspace === "novel"}
          <LazyWorkspace loader={() => import("$lib/components/NovelWorkspace.svelte")} label="Novel Studio" />
        {:else if $currentWorkspace === "script"}
          <LazyWorkspace loader={() => import("$lib/components/ScriptWorkspace.svelte")} label="Script" />
        {:else if $currentWorkspace === "projects"}
          <LazyWorkspace loader={() => import("$lib/components/ProjectsWorkspace.svelte")} label="Projects" />
        {:else if $currentWorkspace === "inbox"}
          <InboxWorkspace />
        {:else if $currentWorkspace === "properties"}
          <LazyWorkspace loader={() => import("$lib/components/LibraryWorkspace.svelte")} label="Library" />
        {:else if $currentDoc}
          <EditorPane />
        {:else}
          <EmptyState />
        {/if}
      </div>
    </div>

    {#if $inspectorOpen}
      {#if isMobile}
        <div class="mobile-ai-overlay" onclick={(e) => { if (e.target === e.currentTarget) $inspectorOpen = false; }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') $inspectorOpen = false; }}>
          <div class="mobile-ai-container" role="dialog" tabindex="-1">
            <InspectorPanel />
          </div>
        </div>
      {:else}
        <InspectorPanel />
      {/if}
    {/if}

    {#if $aiPanelOpen}
      {#if isMobile}
        <div class="mobile-ai-overlay" onclick={(e) => { if (e.target === e.currentTarget) $aiPanelOpen = false; }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') $aiPanelOpen = false; }}>
          <div class="mobile-ai-container" role="dialog" tabindex="-1">
            <LazyWorkspace loader={() => import("$lib/components/AiPanel.svelte")} label="AI panel" />
          </div>
        </div>
      {:else}
        <LazyWorkspace loader={() => import("$lib/components/AiPanel.svelte")} label="AI panel" />
      {/if}
    {/if}

    <CommandPalette />
    <QuickCaptureOverlay />
    <SkillNudges />
    {#if !isMobile}
      <StatusBar />
    {/if}
  </div>
{:else}
  <div class="empty-state">
    <BootLoader />
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
    padding-bottom: env(safe-area-inset-bottom, 0);
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

</style>
