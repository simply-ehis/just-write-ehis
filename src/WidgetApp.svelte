<script lang="ts">
  import { onMount } from "svelte";
  import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
  import { getCurrentWindow } from "@tauri-apps/api/window";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { exit } from "@tauri-apps/plugin-process";
  import { api, isBrowserPreview, type Doc } from "$lib/api";
  import { currentDoc, currentWorkspace, openTabs } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import { showConflict } from "$lib/stores/conflict";
  import { showToast } from "$lib/stores/notifications";
  import type EditorPane from "$lib/components/EditorPane.svelte";
  import QuickCaptureInput from "$lib/components/QuickCaptureInput.svelte";
  import ConflictBanner from "$lib/components/ConflictBanner.svelte";
  import Icon from "$lib/components/Icon.svelte";

  type WidgetWorkspace = "write" | "logs" | "inbox";

  const WORKSPACES: { id: WidgetWorkspace; label: string }[] = [
    { id: "write", label: "Write" },
    { id: "logs", label: "Logs" },
    { id: "inbox", label: "Inbox" },
  ];

  type DocOption = Pick<Doc, "id" | "title" | "updated_at">;

  let docs = $state<DocOption[]>([]);
  let selectedDocId = $state("");
  let EditorComponent = $state<typeof EditorPane | null>(null);
  let widgetVisible = $state(isBrowserPreview());
  let quickCapture = $state("");
  let loading = $state(true);
  let captureSaving = $state(false);
  let error = $state("");
  let editorError = $state("");
  let mainHidden = $state(false);
  let loadedWorkspace = $state<WidgetWorkspace | "">("");
  let loadRequest = 0;
  let logo = $derived($settings.theme === "dark" || $settings.theme === "glass" ? "ehis-logo-light.svg" : "ehis-logo-dark.svg");

  $effect(() => {
    document.documentElement.dataset.theme = $settings.theme;
  });

  $effect(() => {
    if ($settings.companionWidgetVisible || isBrowserPreview() || !widgetVisible) return;
    widgetVisible = false;
    void getCurrentWindow().hide().catch((e) => {
      showToast(`Couldn't hide companion widget: ${e instanceof Error ? e.message : e}`, "error");
    });
  });

  $effect(() => {
    const workspace = $settings.widgetWorkspace;
    if (!widgetVisible || workspace === loadedWorkspace) return;
    loadedWorkspace = workspace;
    void loadWorkspace(workspace);
  });

  async function ensureEditor() {
    if (EditorComponent) return;
    try {
      EditorComponent = (await import("$lib/components/EditorPane.svelte")).default;
      editorError = "";
    } catch (e) {
      editorError = `Editor failed to load: ${e instanceof Error ? e.message : e}`;
    }
  }

  function localDate(date: Date): string {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }

  async function selectDoc(doc: DocOption, workspace: WidgetWorkspace, expectedRequest = loadRequest) {
    const full = await api.docGet(doc.id);
    if (expectedRequest !== loadRequest || full.locked) return;
    selectedDocId = full.id;
    currentDoc.set(full);
    currentWorkspace.set(workspace);
    openTabs.set([full]);
    await api.usageRecord(full.id, "open").catch(() => {});
  }

  async function loadWorkspace(workspace: WidgetWorkspace) {
    const request = ++loadRequest;
    loading = true;
    error = "";
    try {
      const results = await api.docSearchFull("", workspace);
      if (request !== loadRequest) return;
      docs = results
        .map(({ doc }) => ({ id: doc.id, title: doc.title, updated_at: doc.updated_at }))
        .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
      if (docs.length > 0) await selectDoc(docs[0], workspace, request);
      else {
        selectedDocId = "";
        currentDoc.set(null);
        currentWorkspace.set(workspace);
        openTabs.set([]);
      }
    } catch (e) {
      if (request === loadRequest) error = e instanceof Error ? e.message : String(e);
    } finally {
      if (request === loadRequest) loading = false;
    }
  }

  function chooseDoc(id: string) {
    const doc = docs.find((item) => item.id === id);
    if (doc) void selectDoc(doc, $settings.widgetWorkspace);
  }

  async function capture() {
    const text = quickCapture.trim();
    if (!text || captureSaving) return;
    captureSaving = true;
    try {
      const workspace = $settings.widgetWorkspace;
      if (workspace === "logs") {
        const log = await api.logGetOrCreate(localDate(new Date()));
        const timestamp = new Date().toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
        const block = `\n\n## ${timestamp}\n\n${text}\n`;
        await api.docSave(log.id, undefined, `${log.content ?? ""}${block}`);
        quickCapture = "";
        await loadWorkspace("logs");
      } else {
        const kind = workspace === "inbox" ? "snippet" : "doc";
        await api.docCreate(workspace, kind, text.slice(0, 80), undefined, text);
        quickCapture = "";
        await loadWorkspace(workspace);
      }
    } catch (e) {
      showToast(`Quick capture failed: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      captureSaving = false;
    }
  }

  async function openInApp() {
    if (!$currentDoc) return;
    try {
      await emitTo("main", "widget-open-doc", $currentDoc.id);
      await closeWidget();
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

  async function reopenMain() {
    if (isBrowserPreview()) return;
    try {
      const main = await WebviewWindow.getByLabel("main");
      if (!main) throw new Error("main window is unavailable");
      await main.show();
      await main.unminimize();
      await main.setFocus();
      mainHidden = false;
    } catch (e) {
      showToast(`Couldn't reopen main window: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function quitApp() {
    if (!isBrowserPreview()) await exit(0);
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
        const widget = getCurrentWindow();
        await track(widget.onCloseRequested((event) => {
          event.preventDefault();
          void closeWidget();
        }));
        await track(listen("widget-show", () => {
          widgetVisible = true;
          void ensureEditor();
        }));
        await track(listen("widget-hide", () => { widgetVisible = false; }));
        await track(listen("main-window-hidden", () => { mainHidden = true; }));
        await track(listen("main-window-shown", () => { mainHidden = false; }));
        await track(listen<boolean>("widget-tray-visibility", (event) => {
          if (typeof event.payload !== "boolean") return;
          widgetVisible = event.payload;
          settings.update((current) => ({ ...current, companionWidgetVisible: event.payload }));
          if (event.payload) void ensureEditor();
        }));
        await track(listen<string>("file-changed", (event) => {
          if (typeof event.payload !== "string") return;
          if ($currentDoc && event.payload.includes($currentDoc.id)) {
            showConflict($currentDoc.id, event.payload, new Date().toISOString());
          }
        }));
        widgetVisible = await widget.isVisible();
        if (widgetVisible) void ensureEditor();
        const main = await WebviewWindow.getByLabel("main");
        if (main) mainHidden = !(await main.isVisible());
      } catch (e) {
        mainHidden = true;
        showToast(`Companion window bridge failed: ${e instanceof Error ? e.message : e}`, "error");
      }
    })();
    return () => {
      disposed = true;
      cleanups.forEach((cleanup) => cleanup());
    };
  });
</script>

<svelte:head>
  <title>Just Write ehis — Companion</title>
</svelte:head>

<div class="widget-shell">
  <header class="widget-titlebar" role="toolbar" aria-label="Companion window controls" tabindex="0" onmousedown={(event) => { if (event.button === 0) void getCurrentWindow().startDragging(); }}>
    <img src={logo} alt="Just Write ehis" />
    <div class="titlebar-actions">
      <button onmousedown={(event) => event.stopPropagation()} onclick={openInApp} disabled={!$currentDoc} title="Open in app" aria-label="Open document in main app">
        <Icon name="arrow-right" size={16} />
      </button>
      <button onmousedown={(event) => event.stopPropagation()} onclick={closeWidget} title="Hide to tray" aria-label="Hide companion widget to tray">
        <Icon name="x" size={16} />
      </button>
    </div>
  </header>

  {#if mainHidden}
    <div class="orphan-state">
      <img src={logo} alt="Just Write ehis" />
      <h1>Main window is hidden</h1>
      <p>The companion remains available without duplicating app services.</p>
      <div class="orphan-actions">
        <button class="primary" onclick={reopenMain}>Reopen main</button>
        <button onclick={quitApp}>Quit app</button>
      </div>
    </div>
  {:else}
    <div class="widget-controls">
      <div class="workspace-picker" role="group" aria-label="Widget workspace">
        {#each WORKSPACES as workspace}
          <button
            class:active={$settings.widgetWorkspace === workspace.id}
            onclick={() => settings.update((current) => ({ ...current, widgetWorkspace: workspace.id }))}
          >{workspace.label}</button>
        {/each}
      </div>
      <QuickCaptureInput bind:value={quickCapture} voiceEnabled={false} disabled={captureSaving} onSubmit={capture} />
      {#if docs.length > 0}
        <select aria-label="Widget document" bind:value={selectedDocId} onchange={() => chooseDoc(selectedDocId)}>
          {#each docs as doc}
            <option value={doc.id}>{doc.title || "Untitled"}</option>
          {/each}
        </select>
      {/if}
    </div>

    <ConflictBanner />

    <main class="widget-editor">
      {#if loading}
        <div class="state">Loading…</div>
      {:else if error}
        <div class="state error">
          <span>{error}</span>
          <button onclick={() => { loadedWorkspace = ""; void loadWorkspace($settings.widgetWorkspace); }}>Retry</button>
        </div>
      {:else if editorError}
        <div class="state error">{editorError}</div>
      {:else if $currentDoc && EditorComponent}
        <EditorComponent companionMode />
      {:else if $currentDoc}
        <div class="state">Loading editor…</div>
      {:else}
        <div class="state">No document yet. Use quick capture to start one.</div>
      {/if}
    </main>
  {/if}
</div>

<style>
  :global(html), :global(body), :global(#app) { width: 100%; height: 100%; margin: 0; overflow: hidden; }
  .widget-shell { display: flex; flex-direction: column; width: 100%; height: 100%; background: var(--surface-base); color: var(--text-primary); }
  .widget-titlebar { display: flex; align-items: center; justify-content: space-between; min-height: 42px; padding: 6px 8px 6px 12px; border-bottom: 1px solid var(--border); background: var(--surface-raised); user-select: none; }
  .widget-titlebar img { width: 92px; height: 24px; object-fit: contain; }
  .titlebar-actions { display: flex; gap: 4px; }
  .titlebar-actions button, .orphan-actions button { min-width: 34px; min-height: 34px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-overlay); color: var(--text-primary); cursor: pointer; }
  .titlebar-actions button:disabled { opacity: 0.4; cursor: not-allowed; }
  .widget-controls { display: grid; gap: 8px; padding: 10px; border-bottom: 1px solid var(--border); }
  .workspace-picker { display: grid; grid-template-columns: repeat(3, 1fr); gap: 4px; }
  .workspace-picker button { min-height: 34px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-raised); color: var(--text-secondary); cursor: pointer; }
  .workspace-picker button.active { border-color: var(--accent-primary); color: var(--accent-primary); background: color-mix(in srgb, var(--accent-primary) 10%, var(--surface-raised)); }
  .widget-controls select { width: 100%; min-height: 36px; padding: 0 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--surface-raised); color: var(--text-primary); }
  .widget-editor { position: relative; flex: 1; min-height: 0; overflow: hidden; }
  .widget-editor :global(.editor-toolbar), .widget-editor :global(.format-toolbar), .widget-editor :global(.rhythm-panel), .widget-editor :global(.craft-panel) { display: none !important; }
  .widget-editor :global(.editor-pane) { height: 100%; border: 0; }
  .state { display: grid; place-items: center; height: 100%; padding: 24px; color: var(--text-muted); text-align: center; }
  .state.error { color: var(--accent-semantic-red); }
  .state button { min-height: 36px; padding: 0 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-overlay); color: var(--text-primary); cursor: pointer; }
  .orphan-state { display: flex; flex: 1; flex-direction: column; align-items: center; justify-content: center; gap: 12px; padding: 24px; text-align: center; }
  .orphan-state img { width: 140px; height: 38px; object-fit: contain; }
  .orphan-state h1 { margin: 0; font-size: 18px; }
  .orphan-state p { margin: 0; color: var(--text-muted); }
  .orphan-actions { display: flex; gap: 8px; }
  .orphan-actions .primary { border-color: var(--accent-primary); background: var(--accent-primary); color: var(--text-on-accent); }
  @media (max-width: 320px), (max-height: 440px) {
    .widget-titlebar { min-height: 38px; padding-block: 4px; }
    .widget-titlebar img { width: 72px; height: 20px; }
    .widget-controls { padding: 7px; gap: 6px; }
    .titlebar-actions button, .orphan-actions button, .workspace-picker button { min-height: 40px; }
  }
</style>
