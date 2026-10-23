<script lang="ts">
  /**
   * WidgetApp: the companion window. It is a FRAME around one mini widget.
   *
   * A widget is not a second window that hosts a whole tab. It is a small,
   * single-job version of a tab (see lib/widgets/registry.ts). This file only
   * owns the window: the bar (drag, open-in-app, hide), remembering size and
   * position, and keeping the window between the real-widget min and max size.
   */
  import { onMount } from "svelte";
  import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from "@tauri-apps/api/window";
  import { isBrowserPreview } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { waitForBackendReady } from "$lib/bootGate";
  import { warnOnce } from "$lib/errors";
  import { applyAppearance, applyEditorTypography, applyFocusDimStyle, watchSystemTheme } from "$lib/appearance";
  import { clampWidgetSize, widgetSpec } from "$lib/widgets/registry";
  import QuickNoteWidget from "$lib/components/widgets/QuickNoteWidget.svelte";
  import ReaderWidget from "$lib/components/widgets/ReaderWidget.svelte";
  import Icon from "$lib/components/Icon.svelte";

  /** Window-moved/resized events this soon after we placed the window are our own echo. */
  const PLACE_ECHO_MS = 500;
  /** Gap between the widget and the screen corner it first appears in. */
  const CORNER_MARGIN = 24;

  let widgetVisible = $state(isBrowserPreview());
  let notice = $state("");
  let noticeTimer: ReturnType<typeof setTimeout> | null = null;
  let spec = $derived(widgetSpec($settings.widgetKind));

  let placingUntil = 0;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let placeQueue: Promise<void> = Promise.resolve();
  let lastKind: string | null = null;

  $effect(() => {
    applyAppearance($settings.theme, $settings.themeMode, $settings.accentOverride);
    applyEditorTypography($settings.fontFamily, $settings.fontSize, $settings.lineHeight);
    applyFocusDimStyle($settings.focusDimStrength);
    if ($settings.themeMode !== "system") return;
    return watchSystemTheme(() =>
      applyAppearance($settings.theme, $settings.themeMode, $settings.accentOverride)
    );
  });

  // Switching the widget type in Settings resizes the window to the new kind.
  $effect(() => {
    const kind = spec.id;
    if (isBrowserPreview() || !widgetVisible) return;
    if (lastKind === null) {
      lastKind = kind;
      return;
    }
    if (kind !== lastKind) {
      lastKind = kind;
      void place("resize-to-kind");
    }
  });

  function showNotice(message: string) {
    notice = message;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => (notice = ""), 5000);
  }

  function parseGeometry(raw: string): { x: number; y: number; w: number; h: number } | null {
    const parts = raw.split(",").map(Number);
    if (parts.length !== 4 || !parts.every(Number.isFinite)) return null;
    return { x: parts[0], y: parts[1], w: parts[2], h: parts[3] };
  }

  /** Is enough of a window at (x, y) on this screen for the user to grab it? */
  function reachable(x: number, y: number, area: { x: number; y: number; w: number; h: number }): boolean {
    return x + 80 > area.x && x < area.x + area.w - 80 && y >= area.y - 1 && y < area.y + area.h - 40;
  }

  /** One placement at a time: overlapping setSize/setPosition pairs left the window half-sized. */
  function place(mode: "restore" | "resize-to-kind"): Promise<void> {
    placeQueue = placeQueue.then(() => applyPlacement(mode));
    return placeQueue;
  }

  async function applyPlacement(mode: "restore" | "resize-to-kind") {
    if (isBrowserPreview()) return;
    try {
      const win = getCurrentWindow();
      const monitor = await currentMonitor();
      const scale = monitor?.scaleFactor ?? 1;
      const workPos = monitor?.workArea.position.toLogical(scale);
      const workSize = monitor?.workArea.size.toLogical(scale);
      const area = workPos && workSize ? { x: workPos.x, y: workPos.y, w: workSize.width, h: workSize.height } : null;
      const saved = mode === "restore" ? parseGeometry($settings.widgetGeometry) : null;
      const size = clampWidgetSize(saved?.w ?? spec.initial.w, saved?.h ?? spec.initial.h);

      placingUntil = Date.now() + PLACE_ECHO_MS;
      await win.setSize(new LogicalSize(size.w, size.h));
      if (mode === "resize-to-kind" || !area) return;

      const x = saved && reachable(saved.x, saved.y, area) ? saved.x : area.x + area.w - size.w - CORNER_MARGIN;
      const y = saved && reachable(saved.x, saved.y, area) ? saved.y : area.y + area.h - size.h - CORNER_MARGIN;
      placingUntil = Date.now() + PLACE_ECHO_MS;
      await win.setPosition(new LogicalPosition(x, y));
    } catch (e) {
      warnOnce("Widget placement", e);
    }
  }

  /** Remember where the user put the widget and how big they made it. */
  function scheduleGeometrySave() {
    if (isBrowserPreview() || Date.now() < placingUntil) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        const win = getCurrentWindow();
        const scale = await win.scaleFactor();
        const pos = (await win.outerPosition()).toLogical(scale);
        const size = (await win.outerSize()).toLogical(scale);
        const geometry = [pos.x, pos.y, size.width, size.height].map(Math.round).join(",");
        settings.update((current) => (current.widgetGeometry === geometry ? current : { ...current, widgetGeometry: geometry }));
      } catch (e) {
        warnOnce("Widget geometry save", e);
      }
    }, 400);
  }

  function startDrag(event: MouseEvent) {
    if (event.button !== 0 || isBrowserPreview()) return;
    if ((event.target as HTMLElement | null)?.closest("button")) return;
    void getCurrentWindow().startDragging().catch((e) => warnOnce("Widget drag", e));
  }

  async function openInApp() {
    try {
      await emitTo("main", "widget-open-workspace", spec.opens);
    } catch (e) {
      showNotice(`Couldn't open in app: ${e instanceof Error ? e.message : e}`);
    }
  }

  async function closeWidget() {
    try {
      if (!isBrowserPreview()) await getCurrentWindow().hide();
    } catch (e) {
      showNotice(`Couldn't hide the widget: ${e instanceof Error ? e.message : e}`);
      return;
    }
    settings.update((current) => ({ ...current, companionWidgetVisible: false }));
    widgetVisible = false;
  }

  onMount(() => {
    if (isBrowserPreview()) return;

    const cleanups: UnlistenFn[] = [];
    let disposed = false;
    const track = async (pending: Promise<UnlistenFn>) => {
      const cleanup = await pending;
      if (disposed) cleanup();
      else cleanups.push(cleanup);
    };

    void (async () => {
      try {
        // The widget loads in the same pre-setup window as the main app, so
        // it races Rust `setup`; commands issued before it finishes fail.
        if (!(await waitForBackendReady())) {
          console.warn("Widget: backend never reported ready, continuing anyway.");
        }
        const win = getCurrentWindow();
        await track(win.onCloseRequested((event) => {
          event.preventDefault();
          void closeWidget();
        }));
        await track(win.onMoved(scheduleGeometrySave));
        await track(win.onResized(scheduleGeometrySave));
        await track(listen("main-window-shown", () => void closeWidget()));
        await track(listen<string>("widget-open-failed", (event) => {
          showNotice(event.payload || "Couldn't open in app");
        }));
        await track(listen("widget-show", () => {
          widgetVisible = true;
          settings.update((current) => ({ ...current, companionWidgetVisible: true }));
          void place("restore");
        }));
        await track(listen("widget-hide", () => {
          widgetVisible = false;
        }));
        await track(listen<boolean>("widget-tray-visibility", (event) => {
          if (typeof event.payload !== "boolean") return;
          widgetVisible = event.payload;
          settings.update((current) => ({ ...current, companionWidgetVisible: event.payload }));
          if (event.payload) void place("restore");
        }));
        widgetVisible = await win.isVisible();
        if (widgetVisible) {
          settings.update((current) => ({ ...current, companionWidgetVisible: true }));
          await place("restore");
        }
      } catch (e) {
        showNotice(`Widget setup failed: ${e instanceof Error ? e.message : e}`);
      }
    })();

    return () => {
      disposed = true;
      if (saveTimer) clearTimeout(saveTimer);
      if (noticeTimer) clearTimeout(noticeTimer);
      cleanups.forEach((cleanup) => cleanup());
    };
  });
</script>

<svelte:head>
  <title>Just Write ehis: {spec.label}</title>
</svelte:head>

<div class="widget" data-kind={spec.id}>
  <header class="bar" role="toolbar" tabindex="0" aria-label="Widget controls" onmousedown={startDrag}>
    <span class="bar-title"><Icon name={spec.opens === "logs" ? "pencil" : "book-open"} size={14} />{spec.label}</span>
    {#if notice}<span class="bar-notice" role="alert">{notice}</span>{/if}
    <span class="bar-actions">
      <button onclick={openInApp} title={`Open ${spec.opens === "logs" ? "Logs" : "Reader"} in the app`} aria-label={`Open ${spec.opens === "logs" ? "Logs" : "Reader"} in the app`}>
        <Icon name="arrow-right" size={14} />
      </button>
      <button class="close" onclick={closeWidget} title="Hide widget" aria-label="Hide widget">
        <Icon name="x" size={14} />
      </button>
    </span>
  </header>
  <main class="body">
    {#if spec.id === "reader"}
      <ReaderWidget onOpenReader={openInApp} />
    {:else}
      <QuickNoteWidget />
    {/if}
  </main>
</div>

<style>
  :global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; overflow: hidden; background: var(--surface-base, #faf9f6); }
  .widget { box-sizing: border-box; display: flex; flex-direction: column; width: 100%; height: 100%; border: 1px solid var(--border, rgb(128 128 128 / 45%)); background: var(--surface-base, #faf9f6); color: var(--text-primary, #1a1a1a); }
  .bar { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 0 6px 0 10px; border-bottom: 1px solid var(--border-subtle, rgb(128 128 128 / 25%)); background: var(--surface-raised, #fffdf8); user-select: none; cursor: grab; }
  .bar:active { cursor: grabbing; }
  .bar-title { display: inline-flex; align-items: center; gap: 6px; color: var(--text-secondary, #555); font-size: 12px; font-weight: 500; white-space: nowrap; }
  .bar-notice { flex: 1; min-width: 0; overflow: hidden; color: var(--accent-semantic-red, #c0392b); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .bar-actions { display: flex; gap: 2px; margin-left: auto; }
  .bar-actions button { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: var(--radius-sm, 6px); background: transparent; color: var(--text-secondary, #555); cursor: pointer; }
  .bar-actions button:hover { background: var(--surface-overlay, rgb(128 128 128 / 16%)); color: var(--text-primary, #1a1a1a); }
  .bar-actions .close:hover { color: var(--accent-semantic-red, #c0392b); }
  .body { flex: 1; min-height: 0; overflow: hidden; }
</style>
