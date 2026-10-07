<script lang="ts">
  import { onMount } from "svelte";
  import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
  import { api, isBrowserPreview } from "$lib/api";
  import { currentDoc, currentWorkspace, openTabs, workspaces, type WorkspaceId } from "$lib/stores/app";
  import { appLockConfigured, appLockPinStatus, settings } from "$lib/stores/settings";
  import { appUnlocked, markAppUnlocked, pinLockoutRemaining, verifyPin } from "$lib/stores/lock";
  import { saveState } from "$lib/stores/saveState";
  import { showConflict } from "$lib/stores/conflict";
  import { showToast } from "$lib/stores/notifications";
  import { promptWidgetAutostart } from "$lib/widgetAutostart";
import { waitForBackendReady } from "$lib/bootGate";
  import LazyWorkspace from "$lib/components/LazyWorkspace.svelte";
  import EmptyState from "$lib/components/EmptyState.svelte";
  import ConflictBanner from "$lib/components/ConflictBanner.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import { warnOnce } from "$lib/errors";
  import { applyAppearance, applyEditorTypography } from "$lib/appearance";

  const COLLAPSED_SIZE = 56;
  const EXPANDED_WIDTH = 520;
  const EXPANDED_HEIGHT = 720;

  type DockEdge = "left" | "right" | "top" | "bottom";
  type DockOffset = number;

  let widgetVisible = $state(isBrowserPreview());
  let loadedWorkspace = $state<WorkspaceId | "">("");
  let prepareError = $state("");
  let widgetPin = $state("");
  let widgetPinError = $state("");
  let widgetPinBusy = $state(false);
  let widgetPinWait = $state(0);
  type UnlockResult = { requestId: string; verified: boolean; retry_after_ms: number; error?: string };
  let pendingUnlock: { id: string; resolve: (result: UnlockResult) => void; timer: ReturnType<typeof setTimeout> } | null = null;
  let unlockSequence = 0;
  // Same rule as the main shell: a real configured PIN plus the master
  // switch. The switch alone (or a defaulted "configured") locked the
  // widget behind a PIN nobody set, with no way out.
  let widgetLocked = $derived(
    $appLockPinStatus === "ready" &&
    $appLockConfigured &&
    $settings.lockEnabled &&
    !$appUnlocked
  );
  let prepareLoading = $state(false);
  let loadRequest = 0;
  let collapseTimer: ReturnType<typeof setTimeout> | null = null;
  let logo = $derived($settings.themeMode === "dark" ? "ehis-logo-light.svg" : "ehis-logo-dark.svg");

  function isWorkspaceId(value: string): value is WorkspaceId {
    return workspaces.some((workspace) => workspace.id === value);
  }

  let selectedWorkspace = $derived(isWorkspaceId($settings.widgetWorkspace) ? $settings.widgetWorkspace : "home");
  let selectedLabel = $derived(workspaces.find((workspace) => workspace.id === selectedWorkspace)?.label ?? "Widget");
  let workspaceLoader = $derived.by(() => {
    switch (selectedWorkspace) {
      case "home":
        return () => import("$lib/components/HomePane.svelte");
      case "logs":
        return () => import("$lib/components/LogsWorkspace.svelte");
      case "write":
        return () => import("$lib/components/EditorPane.svelte");
      case "inbox":
        return () => import("$lib/components/InboxWorkspace.svelte");
      case "map":
        return () => import("$lib/components/NodeMapWorkspace.svelte");
      case "canvas":
        return () => import("$lib/components/CanvasWorkspace.svelte");
      case "novel":
        return () => import("$lib/components/NovelWorkspace.svelte");
      case "script":
        return () => import("$lib/components/ScriptWorkspace.svelte");
      case "projects":
        return () => import("$lib/components/ProjectsWorkspace.svelte");
      case "reader":
        return () => import("$lib/components/ReaderWorkspace.svelte");
      case "files":
      case "properties":
        return () => import("$lib/components/LibraryWorkspace.svelte");
      default:
        return () => import("$lib/components/EmptyState.svelte");
    }
  });
  let workspaceComponentProps = $derived(
    selectedWorkspace === "write"
      ? { companionMode: true }
      : selectedWorkspace === "files"
        ? { initialTab: "files" as const }
        : selectedWorkspace === "properties"
          ? { initialTab: "views" as const }
          : {},
  );

  $effect(() => {
    if (!widgetLocked) {
      widgetPinWait = 0;
      return;
    }
    const updateWait = () => {
      widgetPinWait = Math.max(0, Math.ceil(pinLockoutRemaining() / 1000));
    };
    updateWait();
    const timer = setInterval(updateWait, 500);
    return () => clearInterval(timer);
  });

  $effect(() => {
    applyAppearance($settings.theme, $settings.themeMode, $settings.accentOverride);
    applyEditorTypography($settings.fontFamily, $settings.fontSize, $settings.lineHeight);
  });

  $effect(() => {
    const workspace = selectedWorkspace;
    if (!widgetVisible || widgetLocked || $appLockPinStatus !== "ready" || workspace === loadedWorkspace) return;
    loadedWorkspace = workspace;
    void prepareWorkspace(workspace);
  });

  $effect(() => {
    if (!isBrowserPreview() && widgetVisible && !widgetLocked) {
      void placeWidget($settings.widgetCollapsed, $settings.widgetDockEdge, $settings.widgetDockOffset);
    }
  });

  $effect(() => {
    if (!isBrowserPreview() && widgetVisible && widgetLocked) {
      void placeWidget(false, $settings.widgetDockEdge, $settings.widgetDockOffset);
    }
  });

  function requestMainUnlock(pin: string): Promise<UnlockResult> {
    return new Promise((resolve) => {
      const requestId = `unlock-${++unlockSequence}`;
      const timer = setTimeout(() => {
        if (pendingUnlock?.id !== requestId) return;
        pendingUnlock = null;
        resolve({ requestId, verified: false, retry_after_ms: 0, error: "Main app did not respond" });
      }, 5000);
      pendingUnlock = { id: requestId, resolve, timer };
      void emitTo("main", "app-lock-unlock-request", { requestId, pin }).catch(() => {
        if (pendingUnlock?.id !== requestId) return;
        clearTimeout(timer);
        pendingUnlock = null;
        resolve({ requestId, verified: false, retry_after_ms: 0, error: "Main app is unavailable" });
      });
    });
  }

  async function unlockWidget() {
    if (widgetPinBusy || widgetPinWait > 0) return;
    widgetPinBusy = true;
    widgetPinError = "";
    try {
      const result: UnlockResult = isBrowserPreview()
        ? { requestId: "browser", verified: await verifyPin(widgetPin), retry_after_ms: pinLockoutRemaining() }
        : await requestMainUnlock(widgetPin);
      if (result.verified) {
        markAppUnlocked();
        widgetPin = "";
      } else {
        widgetPinWait = Math.max(1, Math.ceil(result.retry_after_ms / 1000));
        widgetPinError = result.error
          ? result.error
          : widgetPinWait > 0
            ? `Wrong PIN. Try again in ${widgetPinWait}s.`
            : "Wrong PIN. Try again.";
        widgetPin = "";
      }
    } catch (error) {
      widgetPinError = error instanceof Error ? error.message : String(error);
    } finally {
      widgetPinBusy = false;
    }
  }

  async function prepareWorkspace(workspace: WorkspaceId) {
    const request = ++loadRequest;
    currentWorkspace.set(workspace);
    prepareError = "";
    if (workspace !== "write") {
      currentDoc.set(null);
      openTabs.set([]);
      return;
    }

    prepareLoading = true;
    try {
      const results = await api.docSearchFull("", workspace);
      if (request !== loadRequest) return;
      const doc = results[0]?.doc;
      if (doc && !doc.locked) {
        currentDoc.set(doc);
        openTabs.set([doc]);
        await api.usageRecord(doc.id, "open").catch((e) => warnOnce("Widget usage telemetry", e));
      } else {
        currentDoc.set(null);
        openTabs.set([]);
      }
    } catch (e) {
      if (request === loadRequest) prepareError = e instanceof Error ? e.message : String(e);
    } finally {
      if (request === loadRequest) prepareLoading = false;
    }
  }

  async function placeWidget(collapsed: boolean, edge: DockEdge, offset: DockOffset) {
    if (isBrowserPreview()) return;
    try {
      const widget = getCurrentWindow();
      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor ?? 1;
      const areaPosition = monitor?.workArea.position.toLogical(scale);
      const areaSize = monitor?.workArea.size.toLogical(scale);
      const size = collapsed
        ? new LogicalSize(COLLAPSED_SIZE, COLLAPSED_SIZE)
        : new LogicalSize(
          Math.min(EXPANDED_WIDTH, areaSize?.width ?? EXPANDED_WIDTH),
          Math.min(EXPANDED_HEIGHT, areaSize?.height ?? EXPANDED_HEIGHT),
        );
      await widget.setSize(size);
      if (!monitor || !areaPosition || !areaSize) return;
      const maxY = Math.max(areaPosition.y, areaPosition.y + areaSize.height - size.height);
      const maxX = Math.max(areaPosition.x, areaPosition.x + areaSize.width - size.width);
      const primary = Math.min(Math.max(offset, 0), edge === "left" || edge === "right" ? maxY - areaPosition.y : maxX - areaPosition.x);
      const x = edge === "left"
        ? areaPosition.x
        : edge === "right"
          ? areaPosition.x + areaSize.width - size.width
          : edge === "top"
            ? areaPosition.x + primary
            : areaPosition.x + primary;
      const y = edge === "top"
        ? areaPosition.y
        : edge === "bottom"
          ? areaPosition.y + areaSize.height - size.height
          : areaPosition.y + primary;
      await widget.setPosition(new LogicalPosition(x, y));
    } catch (e) {
      showToast(`Widget docking failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function updateDockFromMove(x: number, y: number) {
    if (isBrowserPreview()) return;
    try {
      const widget = getCurrentWindow();
      const monitor = await currentMonitor();
      if (!monitor) return;
      const scale = monitor.scaleFactor;
      const position = new LogicalPosition(x / scale, y / scale);
      const size = (await widget.outerSize()).toLogical(scale);
      const areaPosition = monitor.workArea.position.toLogical(scale);
      const areaSize = monitor.workArea.size.toLogical(scale);
      const distances = {
        left: Math.abs(position.x - areaPosition.x),
        right: Math.abs(areaPosition.x + areaSize.width - (position.x + size.width)),
        top: Math.abs(position.y - areaPosition.y),
        bottom: Math.abs(areaPosition.y + areaSize.height - (position.y + size.height)),
      };
      const edge = (Object.keys(distances) as DockEdge[]).reduce((closest, candidate) =>
        distances[candidate] < distances[closest] ? candidate : closest,
      );
      const offset = edge === "left" || edge === "right" ? position.y - areaPosition.y : position.x - areaPosition.x;
      const clampedOffset = Math.max(0, Math.round(offset));
      settings.update((current) => current.widgetDockEdge === edge && current.widgetDockOffset === clampedOffset
        ? current
        : { ...current, widgetDockEdge: edge, widgetDockOffset: clampedOffset });
    } catch (e) {
      showToast(`Widget position could not be saved: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function setCollapsed(collapsed: boolean) {
    settings.update((current) => ({ ...current, widgetCollapsed: collapsed }));
    await placeWidget(collapsed, $settings.widgetDockEdge, $settings.widgetDockOffset);
  }

  async function openInApp() {
    try {
      if (selectedWorkspace === "write" && $currentDoc) {
        await emitTo("main", "widget-open-doc", $currentDoc.id);
      } else {
        await emitTo("main", "widget-open-workspace", selectedWorkspace);
      }
    } catch (e) {
      showToast(`Couldn't open in app: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function closeWidget() {
    try {
      if (!isBrowserPreview()) await getCurrentWindow().hide();
    } catch (e) {
      showToast(`Couldn't hide companion widget: ${e instanceof Error ? e.message : e}`, "error");
      return;
    }
    settings.update((current) => ({ ...current, companionWidgetVisible: false }));
    widgetVisible = false;
  }

  function handleFigureKeydown(event: KeyboardEvent) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    void setCollapsed(false);
  }

  function handleWindowBlur() {
    if ($settings.widgetCollapsed) return;
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(() => {
      if (!isBrowserPreview()) void setCollapsed(true);
    }, 180);
  }

  onMount(() => {
    if (isBrowserPreview()) {
      window.addEventListener("blur", handleWindowBlur);
      return () => window.removeEventListener("blur", handleWindowBlur);
    }

    const cleanups: UnlistenFn[] = [];
    let disposed = false;
    const track = async (pending: Promise<UnlistenFn>) => {
      const cleanup = await pending;
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    };

    void (async () => {
      try {
        // The widget is created in the same pre-setup loop as the main window,
        // so it races Rust `setup` exactly the same way. Without this gate the
        // first `prepareWorkspace` below can hit "state not managed for field
        // `db`", and because that error is surfaced as `prepareError` with no
        // retry, the widget would sit there showing a raw Rust internal error
        // until the user happened to switch workspace.
        if (!(await waitForBackendReady())) {
          console.warn("Widget: backend never reported ready — continuing anyway.");
        }
        const widget = getCurrentWindow();
        await track(widget.onCloseRequested((event) => {
          event.preventDefault();
          void closeWidget();
        }));
        await track(widget.onMoved(({ payload }) => {
          void updateDockFromMove(payload.x, payload.y);
        }));
        await track(widget.onFocusChanged(({ payload }) => {
          if (!payload) handleWindowBlur();
        }));
         await track(listen<boolean>("app-lock-state", (event) => {
           appUnlocked.set(event.payload);
           if (event.payload) appLockPinStatus.set("ready");
         }));
         await track(listen<UnlockResult>("app-lock-unlock-result", (event) => {
           const pending = pendingUnlock;
           if (!pending || pending.id !== event.payload?.requestId) return;
           clearTimeout(pending.timer);
           pendingUnlock = null;
           pending.resolve(event.payload);
         }));
         await track(listen("main-window-shown", () => {
           void closeWidget();
         }));
         await track(listen<string>("widget-open-failed", (event) => {
           showToast(event.payload || "Couldn't open in app", "error");
         }));
         void emitTo("main", "app-lock-request").catch(() => {});
         await track(listen("widget-show", () => {
           widgetVisible = true;
           settings.update((current) => ({ ...current, companionWidgetVisible: true }));
           void emitTo("main", "app-lock-request").catch(() => {});
           void promptWidgetAutostart();
          void placeWidget($settings.widgetCollapsed, $settings.widgetDockEdge, $settings.widgetDockOffset);
        }));
        await track(listen("widget-hide", () => {
          widgetVisible = false;
        }));
        await track(listen<boolean>("widget-tray-visibility", (event) => {
          if (typeof event.payload !== "boolean") return;
          widgetVisible = event.payload;
          settings.update((current) => ({ ...current, companionWidgetVisible: event.payload }));
          if (event.payload) {
            void promptWidgetAutostart();
            void placeWidget($settings.widgetCollapsed, $settings.widgetDockEdge, $settings.widgetDockOffset);
          }
        }));
        await track(listen<string>("file-changed", (event) => {
          if (typeof event.payload !== "string") return;
          if ($currentDoc && event.payload.includes($currentDoc.id)) {
            showConflict($currentDoc.id, event.payload, new Date().toISOString());
          }
        }));
        widgetVisible = await widget.isVisible();
         if (widgetVisible) {
           settings.update((current) => ({ ...current, companionWidgetVisible: true }));
           void emitTo("main", "app-lock-request").catch(() => {});
           await placeWidget($settings.widgetCollapsed, $settings.widgetDockEdge, $settings.widgetDockOffset);
         }
      } catch (e) {
        showToast(`Companion window bridge failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    })();

    return () => {
      disposed = true;
       if (collapseTimer) clearTimeout(collapseTimer);
       if (pendingUnlock) clearTimeout(pendingUnlock.timer);
       cleanups.forEach((cleanup) => cleanup());
    };
  });
</script>

<svelte:head>
  <title>Just Write ehis — {selectedLabel}</title>
</svelte:head>

{#if $appLockPinStatus === "loading"}
  <div class="widget-lock" role="status">Checking app lock…</div>
{:else if $appLockPinStatus === "error"}
  <div class="widget-lock" role="alert">
    <strong>PIN storage unavailable.</strong>
    <div class="widget-lock-actions">
      <button onclick={() => location.reload()}>Retry</button>
      <button onclick={() => void closeWidget()} title="Hide the widget">Hide widget</button>
    </div>
  </div>
{:else if widgetLocked}
  <div class="widget-lock" role="dialog" aria-label="App locked" aria-modal="true">
    <strong>Locked</strong>
    <input
      type="password"
      bind:value={widgetPin}
      aria-label="App lock PIN"
      disabled={widgetPinBusy || widgetPinWait > 0}
      onkeydown={(event) => { if (event.key === "Enter") void unlockWidget(); }}
    />
    <button onclick={() => void unlockWidget()} disabled={widgetPinBusy || widgetPinWait > 0}>
      {widgetPinWait > 0 ? `Wait ${widgetPinWait}s` : widgetPinBusy ? "…" : "Unlock"}
    </button>
    {#if widgetPinError}<span>{widgetPinError}</span>{/if}
    <div class="widget-lock-actions">
      <button onclick={() => void openInApp()} title="Open in the main app">Open main app</button>
      <button onclick={() => void closeWidget()} title="Hide the widget">Hide widget</button>
    </div>
  </div>
{:else if $settings.widgetCollapsed}
  <div
    class="widget-figure"
    role="button"
    tabindex="0"
    aria-label={`Expand ${selectedLabel} widget`}
    title={`Expand ${selectedLabel}`}
    onmousedown={(event) => { if (event.button === 0) void getCurrentWindow().startDragging(); }}
    onclick={() => void setCollapsed(false)}
    onkeydown={handleFigureKeydown}
  >
    <img src={logo} alt="" />
    {#if $saveState !== "idle"}
      <span class="save-signal {$saveState}" aria-label={$saveState === "saving" ? "Saving" : $saveState === "error" ? "Save failed" : "Saved"}></span>
    {/if}
  </div>
{:else}
  <div class="widget-shell">
    <header
      class="widget-titlebar"
      role="toolbar"
      aria-label="Widget controls"
      tabindex="0"
      onmousedown={(event) => { if (event.button === 0) void getCurrentWindow().startDragging(); }}
    >
      <div class="widget-heading">
        <img src={logo} alt="Just Write ehis" />
        <span>{selectedLabel}</span>
        {#if $saveState !== "idle"}
          <span class="save-status" aria-live="polite">{$saveState === "saving" ? "Saving" : $saveState === "error" ? "Save failed" : "Saved"}</span>
        {/if}
      </div>
      <div class="titlebar-actions">
        <button onmousedown={(event) => event.stopPropagation()} onclick={openInApp} title="Open in main app" aria-label="Open workspace in main app">
          <Icon name="arrow-right" size={16} />
        </button>
        <button onmousedown={(event) => event.stopPropagation()} onclick={() => void setCollapsed(true)} title="Collapse widget" aria-label="Collapse widget">
          <Icon name="arrow-right" size={16} />
        </button>
      </div>
    </header>

    {#if prepareError}
      <div class="widget-error" role="alert">
        <span>{prepareError}</span>
        <button onclick={() => { loadedWorkspace = ""; void prepareWorkspace(selectedWorkspace); }}>Retry</button>
      </div>
    {:else if selectedWorkspace === "write" && !$currentDoc && !prepareLoading}
      <EmptyState />
    {:else}
      <ConflictBanner />
      <main class="widget-workspace">
        {#if prepareLoading && selectedWorkspace === "write"}
          <div class="widget-state" role="status">Loading…</div>
        {:else}
          {#key selectedWorkspace}
            <LazyWorkspace loader={workspaceLoader} label={selectedLabel} componentProps={workspaceComponentProps} />
          {/key}
        {/if}
      </main>
    {/if}
  </div>
{/if}

<style>
  :global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; overflow: hidden; background: transparent; }
  .widget-lock { display: grid; place-items: center; align-content: center; gap: 8px; width: 100%; height: 100%; padding: 16px; background: var(--surface-base); color: var(--text-primary); text-align: center; font-size: 12px; }
  .widget-lock input { width: min(220px, 80%); height: 32px; text-align: center; }
  .widget-lock button { min-height: 32px; padding: 0 12px; }
  .widget-lock-actions { display: flex; gap: 8px; justify-content: center; flex-wrap: wrap; }
  .widget-lock span { color: var(--error); font-size: 11px; }
  .widget-figure { display: grid; place-items: center; width: 56px; height: 56px; border: 1px solid var(--border); border-radius: 50%; background: var(--surface-raised); box-shadow: 0 8px 24px rgb(0 0 0 / 24%); color: var(--text-primary); cursor: grab; user-select: none; }
  .widget-figure:active { cursor: grabbing; }
  .widget-figure img { width: 42px; height: 42px; object-fit: contain; }
  .save-signal { position: absolute; width: 8px; height: 8px; border: 2px solid var(--surface-raised); border-radius: 50%; background: var(--accent-primary); }
  .save-signal.saving { background: var(--accent-semantic-orange); }
  .widget-shell { display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--surface-base); color: var(--text-primary); }
  .widget-titlebar { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface-raised); user-select: none; }
  .widget-heading { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .widget-heading img { width: 76px; height: 22px; object-fit: contain; }
  .widget-heading > span:not(.save-status) { overflow: hidden; color: var(--text-secondary); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .save-status { color: var(--text-muted); font-size: 11px; }
  .titlebar-actions { display: flex; gap: 4px; }
  .titlebar-actions button, .widget-error button { min-width: 34px; min-height: 34px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-overlay); color: var(--text-primary); cursor: pointer; }
  .widget-workspace { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .widget-workspace :global(.editor-toolbar), .widget-workspace :global(.format-toolbar), .widget-workspace :global(.rhythm-panel), .widget-workspace :global(.craft-panel) { display: none !important; }
  .widget-workspace :global(.editor-pane) { height: 100%; border: 0; }
  .widget-state, .widget-error { display: grid; place-items: center; min-height: 120px; height: 100%; padding: 24px; color: var(--text-muted); text-align: center; }
  .widget-error { grid-auto-flow: row; gap: 10px; color: var(--accent-semantic-red); }
  .widget-error button { min-height: 36px; padding: 0 12px; }
</style>
