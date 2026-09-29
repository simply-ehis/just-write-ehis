<script lang="ts">
  import { api, type SearchResult, type Doc } from '$lib/api';
  import { aiPanelOpen, currentDoc, currentWorkspace, showSettings, openTabs, sidebarOpen, inspectorOpen, zenMode } from '$lib/stores/app';
  import { settings, openSettingsAt } from '$lib/stores/settings';
  import { showToast } from '$lib/stores/notifications';
  import { get } from 'svelte/store';
  import VaultRenameDialog from './VaultRenameDialog.svelte';
  import TemplatePicker from './TemplatePicker.svelte';
  import { markUsed } from '$lib/features';
  import Icon from '$lib/components/Icon.svelte';
  import { openDailyNote } from '$lib/dailyNote';
  import { ALL_EXPORT_FORMATS, PANDOC_FORMATS } from '$lib/exportFormats';
  import { untrack } from 'svelte';
  import { domainError } from '$lib/errors';

  let open = $state(false);
  let query = $state('');
  let results = $state<SearchResult[]>([]);
  let selectedIndex = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);
  let showRename = $state(false);
  let showTemplatePicker = $state(false);

  const commands = [
    { id: 'settings', label: 'Open Settings', icon: 'settings', action: () => { $showSettings = true; close(); } },
    { id: 'home', label: 'Go to Home', icon: 'home', action: () => { $currentWorkspace = 'home'; close(); } },
    { id: 'logs', label: 'Go to Logs', icon: 'calendar', action: () => { $currentWorkspace = 'logs'; close(); } },
    { id: 'write', label: 'Go to Write', icon: 'pencil', action: () => { $currentWorkspace = 'write'; close(); } },
    { id: 'map', label: 'Go to Node Map', icon: 'graph', action: () => { $currentWorkspace = 'map'; close(); } },
    { id: 'canvas', label: 'Go to Canvas', icon: 'board', action: () => { $currentWorkspace = 'canvas'; close(); } },
    { id: 'novel', label: 'Go to Novel Studio', icon: 'book', action: () => { $currentWorkspace = 'novel'; close(); } },
    { id: 'script', label: 'Go to Scripts', icon: 'film', action: () => { $currentWorkspace = 'script'; close(); } },
    { id: 'projects', label: 'Go to Projects', icon: 'folder', action: () => { $currentWorkspace = 'projects'; close(); } },
    { id: 'reader', label: 'Go to Reader', icon: 'book-open', action: () => { $currentWorkspace = 'reader'; close(); } },
    { id: 'files', label: 'Go to Files', icon: 'files', action: () => { $currentWorkspace = 'properties'; window.dispatchEvent(new CustomEvent('open-library-files')); close(); } },
    { id: 'inbox', label: 'Open Inbox', icon: 'inbox', action: () => { $currentWorkspace = 'inbox'; close(); } },
    { id: 'craft', label: 'Open Craft Analytics (Settings)', icon: 'chart', action: () => { openSettingsAt('craft'); $showSettings = true; close(); } },
    { id: 'stats', label: 'Open Usage Stats (Settings)', icon: 'calendar', action: () => { openSettingsAt('stats'); $showSettings = true; close(); } },
    { id: 'skills', label: 'Open Tips (Settings)', icon: 'sparkle', action: () => { openSettingsAt('skills'); $showSettings = true; close(); } },
    { id: 'support', label: 'Open Support (Settings)', icon: 'send', action: () => { openSettingsAt('support'); $showSettings = true; close(); } },
    { id: 'properties', label: 'All Documents (Table/Board)', icon: 'table', action: () => { $currentWorkspace = 'properties'; close(); } },
    { id: 'daily-note', label: 'Open Today\'s Daily Note', icon: 'calendar', action: () => { void openDailyNotePalette(); } },
    { id: 'quick-capture', label: 'Quick Capture (Inbox)', icon: 'inbox', action: () => { quickCapture(); close(); } },
    { id: 'templates', label: 'New from Template…', icon: 'file', action: () => { showTemplatePicker = true; close(); } },
    { id: 'save-template', label: 'Save Current as Template', icon: 'download', action: () => { saveAsTemplate(); close(); } },
    { id: 'new-doc', label: 'New Document', icon: 'plus', action: async () => { await createNewDoc(); close(); } },
    { id: 'save', label: 'Save Current Document', icon: 'check', action: async () => { await saveCurrentDoc(); close(); } },
    { id: 'close-tab', label: 'Close Current Tab', icon: 'x', action: () => { closeCurrentTab(); close(); } },
    { id: 'ai-panel', label: 'Toggle AI Panel (Ctrl+J)', icon: 'sparkle', action: () => { $aiPanelOpen = !$aiPanelOpen; close(); } },
    { id: 'sidebar', label: 'Toggle Sidebar (Ctrl+B)', icon: 'menu', action: () => { $sidebarOpen = !$sidebarOpen; close(); } },
    { id: 'replay-onboarding', label: 'Replay Onboarding Setup', icon: 'sparkle', action: () => { window.dispatchEvent(new CustomEvent('replay-onboarding')); close(); } },
    { id: 'inspector', label: 'Toggle Outline & Links (Ctrl+I)', icon: 'panel', action: () => { $inspectorOpen = !$inspectorOpen; close(); } },
    { id: 'zen', label: 'Toggle Zen Mode (F11)', icon: 'eye', action: () => { $zenMode = !$zenMode; close(); } },
    { id: 'vault-rename', label: 'Vault-Wide Rename', icon: 'edit', action: () => { showRename = true; close(); } },
    { id: 'publish', label: 'Publish Static Site…', icon: 'send', action: () => { publishSite(); close(); } },
    { id: 'compile-tabs', label: 'Compile Open Tabs…', icon: 'download', action: () => { compileOpenTabs(); close(); } },
    { id: 'export-tabs-zip', label: 'Export Open Tabs (.zip)…', icon: 'download', action: () => { exportTabsZip(); } },
  ];

  /** Saved templates appear as first-class palette entries — no popups. */
  let templateCommands = $derived(
    $settings.templates.map(t => ({
      id: `template:${t.workspace}:${t.name}`,
      label: `New from template: ${t.name}`,
      icon: 'files',
      action: () => { createFromTemplate(t.name); close(); },
    }))
  );

  let allCommands = $derived([...commands, ...templateCommands]);

  let filteredCommands = $derived(
    query.trim() === ''
      ? allCommands
      : allCommands.filter(c => c.label.toLowerCase().includes(query.toLowerCase()))
  );

  type CommandItem = { type: 'command'; id: string; label: string; icon: string; action: () => void };
  type DocItem = { type: 'doc'; id: string; label: string; icon: string; title: string; workspace: string; rank: number; snippet: string | null; doc: Doc };
  type PaletteItem = CommandItem | DocItem;

  let allResults = $derived(
    query.trim().length < 2
      ? filteredCommands.map<PaletteItem>(c => ({ ...c, type: 'command' }))
      : [...filteredCommands.map<PaletteItem>(c => ({ ...c, type: 'command' })), ...results.map<PaletteItem>(r => ({
          type: 'doc',
          id: r.doc.id,
          label: r.doc.title,
          icon: 'files',
          title: r.doc.title,
          workspace: r.doc.workspace,
          rank: r.rank,
          snippet: r.snippet,
          doc: r.doc,
        }))]
  );

  function openPalette() {
    open = true;
    query = '';
    results = [];
    selectedIndex = 0;
    markUsed('palette');
    api.convertStatus().then(
      (s) => {
        compilePandoc = s.pandoc;
      },
      () => {
        compilePandoc = false;
      },
    );
    setTimeout(() => inputEl?.focus(), 10);
  }

  function close() {
    open = false;
    query = '';
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, allResults.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      executeSelected();
    }
  }

  function executeSelected() {
    const item = allResults[selectedIndex];
    if (!item) return;
    if (item.type === 'command') {
      const cmd = allCommands.find(c => c.id === item.id);
      cmd?.action();
    } else {
      openDocFromResult(item as SearchResult);
    }
  }

  async function handleSearch() {
    const asked = query.trim();
    if (asked.length < 2) {
      results = [];
      return;
    }
    try {
      const found = await api.searchDocsFts(asked);
      if (query.trim() === asked) results = found;
    } catch (e) {
      domainError('Palette', "couldn't search", e);
    }
  }

  function openDocFromResult(result: SearchResult) {
    $currentDoc = result.doc;
    $currentWorkspace = result.doc.workspace;
    if (!$openTabs.find(t => t.id === result.doc.id)) {
      $openTabs = [...$openTabs, result.doc];
    }
    close();
  }

  async function openDailyNotePalette() {
    await openDailyNote();
    close();
  }

  function quickCapture() {
    $currentWorkspace = 'inbox';
    createNewDoc();
  }

  async function createNewDoc() {
    try {
      const doc = await api.docCreate($currentWorkspace, 'doc', 'Untitled');
      $currentDoc = doc;
      $openTabs = [doc, ...$openTabs];
    } catch (e) {
      domainError('Palette', "couldn't create document", e);
    }
  }

  async function saveCurrentDoc() {
    if (!$currentDoc) return;
    try {
      await api.docSave($currentDoc.id);
    } catch (e) {
      domainError('Palette', "couldn't save document", e);
    }
  }

  function closeCurrentTab() {
    if (!$currentDoc) return;
    $openTabs = $openTabs.filter(t => t.id !== $currentDoc?.id);
    $currentDoc = $openTabs[0] ?? null;
  }

  function saveAsTemplate() {
    if (!$currentDoc) return;
    const base = $currentDoc.title || "Untitled";
    const taken = new Set($settings.templates.map(t => t.name));
    let name = base;
    for (let n = 2; taken.has(name); n++) name = `${base} (${n})`;
    $settings = {
      ...$settings,
      templates: [...$settings.templates.filter(t => t.name !== name), {
        name,
        content: $currentDoc.content,
        workspace: $currentDoc.workspace,
      }],
    };
    showToast(`Saved template "${name}"`, "success");
  }

  function createFromTemplate(name: string) {
    const tmpl = $settings.templates.find(t => t.name === name);
    if (!tmpl) {
      showToast("Template no longer exists", "error");
      return;
    }
    api.docCreate(tmpl.workspace, "doc", tmpl.name, undefined, tmpl.content).then(doc => {
      $currentDoc = doc;
      $currentWorkspace = tmpl.workspace;
      $openTabs = [doc, ...$openTabs];
    }).catch(e => {
      showToast(`Couldn't create from template: ${e instanceof Error ? e.message : e}`, "error");
    });
  }

  /** Global Publish (§10): single Rust implementation (pulldown + ammonia). */
  async function publishSite() {
    try {
      const result = await api.publishStaticSite({});
      const extra =
        typeof result.imagesSkipped === "number" && result.imagesSkipped > 0
          ? ` (${result.imagesInlined ?? 0} images inlined, ${result.imagesSkipped} skipped as too large)`
          : "";
      const blob = new Blob([result.indexHtml], { type: "text/html" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "index.html";
      a.click();
      URL.revokeObjectURL(url);
      showToast(`Published index.html${extra}`, "success");
    } catch (e) {
      showToast(`Publish failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  let compileFormat = $state("md");
  let compilePandoc = $state(true);
  let bulkOp = $state<{ label: string; done: number; total: number } | null>(null);
  let bulkCancelFlag = $state<{ cancelled: boolean } | null>(null);

  /** Preflight pandoc formats before any click can throw at the backend. */
  async function preflightBulkFormat(fmt: string): Promise<boolean> {
    if (!PANDOC_FORMATS.has(fmt)) return true;
    try {
      const status = await api.convertStatus();
      compilePandoc = status.pandoc;
    } catch {
      compilePandoc = false;
    }
    if (!compilePandoc) {
      showToast(`.${fmt} needs pandoc — see Settings → About → Export setup`, "warning");
      return false;
    }
    return true;
  }

  /** Global Compile (A5.1): manuscript from the open tab strip, any workspace. */
  async function compileOpenTabs() {
    const tabs = get(openTabs);
    if (tabs.length === 0) {
      showToast("No open tabs to compile", "warning");
      return;
    }
    if (!(await preflightBulkFormat(compileFormat))) return;
    try {
      const title = tabs.length === 1 ? tabs[0].title : "compiled";
      const out = await api.compileRun(tabs.map((t) => t.id), compileFormat, title);
      const { downloadConvertOutput } = await import("$lib/download");
      downloadConvertOutput(out);
      showToast(`Compiled ${out.filename}`, "success");
    } catch (e) {
      showToast(`Compile failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  /** Global bulk export: each open tab converted, bundled as one zip. */
  async function exportTabsZip() {
    const tabs = get(openTabs);
    if (tabs.length === 0) {
      showToast("No open tabs to export", "warning");
      return;
    }
    const cancelState = { cancelled: false };
    bulkCancelFlag = cancelState;
    bulkOp = { label: "Exporting", done: 0, total: tabs.length };
    try {
      const { batchExport } = await import("$lib/import");
      const out = await batchExport(tabs.map((t) => t.id), "zip", {
        onProgress: (p) => {
          bulkOp = { label: "Exporting", done: p.done, total: p.total };
        },
        shouldCancel: () => cancelState.cancelled,
      });
      const { downloadConvertOutput } = await import("$lib/download");
      downloadConvertOutput({ filename: out.filename, mime: "application/zip", base64: out.base64 });
      const attachNote =
        out.attachmentsBundled > 0 || out.attachmentsSkipped > 0
          ? ` (${out.attachmentsBundled} attachments bundled${out.attachmentsSkipped > 0 ? `, ${out.attachmentsSkipped} skipped` : ""})`
          : "";
      showToast(`Exported ${out.filename}${attachNote}`, "success");
      close();
    } catch (e) {
      if (cancelState.cancelled) showToast("Export cancelled", "info");
      else showToast(`Export failed: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      bulkOp = null;
      bulkCancelFlag = null;
    }
  }

  function handleGlobalKeydown(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (open) close();
      else openPalette();
    }
  }

  $effect(() => {
    window.addEventListener('keydown', handleGlobalKeydown);
    // Mobile BottomBar Search reuses this overlay (A7.2 full-screen on touch).
    const openFromBar = () => openPalette();
    window.addEventListener('open-command-palette', openFromBar);
    return () => {
      window.removeEventListener('keydown', handleGlobalKeydown);
      window.removeEventListener('open-command-palette', openFromBar);
    };
  });

  // Search-as-you-type: re-runs on every keystroke (query is tracked),
  // debounced so fast typing fires one backend search, not N. The timer
  // lives untracked in a box: a $state timer read+written here would
  // resubscribe and re-fire this effect forever, resetting the debounce.
  const searchTimerBox: { id: ReturnType<typeof setTimeout> | null } = { id: null };
  $effect(() => {
    if (!open) return;
    void query;
    untrack(() => {
      if (searchTimerBox.id) clearTimeout(searchTimerBox.id);
      searchTimerBox.id = setTimeout(() => { void handleSearch(); }, 150);
    });
  });
</script>

{#if open}
  <div class="palette-overlay" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') close(); }}>
    <div class="palette" role="dialog" aria-label="Command palette" tabindex="-1">
      <div class="palette-input-row">
        <span class="palette-icon"><Icon name="search" size={16} /></span>
        <input
          bind:this={inputEl}
          bind:value={query}
          onkeydown={handleKeydown}
          placeholder="Type a command or search..."
          class="palette-input"
        />
        <span class="palette-hint">Esc</span>
      </div>
      <div class="palette-footer">
        <label class="compile-format" title="Format for Compile Open Tabs">
          Compile:
          <select
            bind:value={compileFormat}
            aria-label="Compile format"
            onclick={(e) => e.stopPropagation()}
          >
            {#each ALL_EXPORT_FORMATS as fmt}
              <option
                value={fmt}
                disabled={PANDOC_FORMATS.has(fmt) && !compilePandoc}
                title={PANDOC_FORMATS.has(fmt) && !compilePandoc ? "Needs pandoc — see Settings → About → Export setup" : `Compile as .${fmt}`}
              >.{fmt}</option>
            {/each}
          </select>
        </label>
        {#if bulkOp}
          <div class="bulk-progress" role="status" aria-label="Export progress">
            <span>{bulkOp.label} {bulkOp.done}/{bulkOp.total}</span>
            <span class="bulk-bar"><span class="bulk-fill" style="width: {bulkOp.total ? Math.round((bulkOp.done / bulkOp.total) * 100) : 0}%"></span></span>
            <button
              class="bulk-cancel"
              onclick={() => {
                if (bulkCancelFlag) bulkCancelFlag.cancelled = true;
              }}
              aria-label="Cancel export"
            >Cancel</button>
          </div>
        {/if}
      </div>
      <div class="palette-results">
        {#each allResults as item, i}
          <button
            class="palette-result"
            class:selected={i === selectedIndex}
            onclick={() => { selectedIndex = i; executeSelected(); }}
            onmouseenter={() => selectedIndex = i}
          >
            {#if item.type === 'command'}
              <span class="result-icon"><Icon name={item.icon} size={15} /></span>
              <span class="result-label">{item.label}</span>
            {:else}
              <span class="result-icon"><Icon name="files" size={15} /></span>
              <span class="result-label">{item.title}</span>
              <span class="result-workspace">{item.workspace}</span>
            {/if}
          </button>
        {:else}
          <div class="palette-empty">No results</div>
        {/each}
      </div>
    </div>
  </div>
{/if}

<VaultRenameDialog open={showRename} onClose={() => showRename = false} />

{#if showTemplatePicker}
  <TemplatePicker
    workspace={$currentWorkspace}
    onClose={() => (showTemplatePicker = false)}
    onCreate={(docId) => {
      showTemplatePicker = false;
      api.docGet(docId).then(doc => {
        $currentDoc = doc;
        $currentWorkspace = doc.workspace;
        $openTabs = [doc, ...$openTabs];
      });
    }}
  />
{/if}

<style>
  .palette-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    justify-content: center;
    padding-top: 15vh;
    z-index: 300;
  }

  .palette {
    width: 560px;
    max-height: 420px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .palette-input-row {
    display: flex;
    align-items: center;
    padding: 12px 16px;
    border-bottom: 1px solid var(--border-subtle);
    gap: 8px;
  }

  .palette-icon {
    font-size: 16px;
    color: var(--text-muted);
  }

  .palette-input {
    flex: 1;
    border: none;
    background: transparent;
    font-size: 15px;
    color: var(--text-primary);
    outline: none;
    font-family: var(--font-body);
  }

  .palette-hint {
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
  }

  .palette-results {
    overflow-y: auto;
    padding: 8px;
  }

  .palette-footer {
    display: flex;
    align-items: center;
    gap: 12px;
    flex-wrap: wrap;
    padding: 8px 16px;
    border-top: 1px solid var(--border-subtle);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .compile-format {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .compile-format select {
    font-size: 12px;
    padding: 2px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    color: var(--text-primary);
  }

  .bulk-progress {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex: 1;
    min-width: 180px;
  }

  .bulk-bar {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: var(--surface-overlay);
    overflow: hidden;
  }

  .bulk-fill {
    display: block;
    height: 100%;
    background: var(--accent-primary);
    transition: width 0.2s ease;
  }

  .bulk-cancel {
    font-size: 12px;
    padding: 2px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
  }

  .palette-result {
    display: flex;
    align-items: center;
    gap: 10px;
    width: 100%;
    padding: 8px 12px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-primary);
    font-size: 14px;
    text-align: left;
    cursor: pointer;
  }

  .palette-result.selected {
    background: var(--surface-overlay);
  }

  .result-icon {
    font-size: 14px;
    width: 24px;
    text-align: center;
  }

  .result-label {
    flex: 1;
  }

  .result-workspace {
    font-size: 11px;
    color: var(--text-muted);
    padding: 2px 6px;
    background: var(--surface-overlay);
    border-radius: var(--radius-sm);
  }

  .palette-empty {
    padding: 24px;
    text-align: center;
    color: var(--text-muted);
  }
</style>
