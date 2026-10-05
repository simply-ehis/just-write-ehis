<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
  import WikilinkPreview from "./WikilinkPreview.svelte";
  import { EditorState } from "@codemirror/state";
  import { basicSetup } from "codemirror";
  import { defaultKeymap, history, historyKeymap, insertTab } from "@codemirror/commands";
  import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
  import { markdown } from "@codemirror/lang-markdown";
  import { currentDoc, currentWorkspace, aiPanelOpen, inspectorOpen, openTabs, structurizePreset } from "$lib/stores/app";
  import { api, type Doc } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { applyWriteBackEvent, writeBack } from "$lib/stores/writeBack";
  import { recordSave } from "$lib/stores/saveState";
  import { ALL_EXPORT_FORMATS, BINARY_FORMATS, exportLabel } from "$lib/exportFormats";
  import { showToast } from "$lib/stores/notifications";
  import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
  import { createAutocorrectPlugin, loadBibleWords } from "$lib/autocorrectPlugin";
  import { AUTOCORRECT_WAVY, editorFontStack, editorPalette } from "$lib/editorTheme";
  import VersionHistory from "./VersionHistory.svelte";
  import TrendlineChart from "./TrendlineChart.svelte";
  import RhythmPanel from "./RhythmPanel.svelte";
  import FormatToolbar from "./FormatToolbar.svelte";
  import MicButton from "./MicButton.svelte";
  import { domainError, warnOnce } from "$lib/errors";
  import ReadAloudButton from "./ReadAloudButton.svelte";
  import Icon from "./Icon.svelte";
  import { downloadConvertOutput, downloadFountain } from "$lib/download";
  import { assertAiAllowedForDoc } from "$lib/stores/lock";
  import { craftStats } from "$lib/browserBackend";
  import { lastSentenceOf, requestGhostContinuation } from "$lib/ghost";
  import { markUsed } from "$lib/features";
  import { scheduleStoryMemory } from "$lib/storyMemory";
  import { createStoryMemoryExtension, setStoryMemoryData, type StoryMemoryData, type StoryMemoryView } from "$lib/storyMemoryEditor";
  import StoryMemoryHoverCard from "./StoryMemoryHoverCard.svelte";
  import { expandSnippet, getSnippetsForWorkspace } from "$lib/stores/templates";
  import { centerCursorIn, focusDimmingPlugin, loadFocusPrefs, saveFocusPrefs } from "$lib/editorFocus";
import { countWords } from "$lib/text";

  let { companionMode = false }: { companionMode?: boolean } = $props();

  let editorContainer = $state<HTMLDivElement>();
  // $state.raw: the CodeMirror view is an opaque handle (never deep-read by
  // the template). Deep-proxying it makes Svelte traverse the whole editor
  // graph on every assignment — a busy-loop that starves timers.
  let editorView = $state.raw<EditorView | null>(null);
  let saveTimeout = $state<ReturnType<typeof setTimeout> | null>(null);
  let flushTimeout = $state<ReturnType<typeof setTimeout> | null>(null);
  let showExportMenu = $state(false);
  let ghostSuggestion = $state('');
  let ghostVisible = $state(false);
  let lastPreviewTitle = $state<string | null>(null);
  let ghostDebounce: ReturnType<typeof setTimeout> | null = null;
  let showCraft = $state(false);
  let showRhythm = $state(false);
  let dialogueTrend = $state<[string, number][]>([]);
  let sentenceTrend = $state<[string, number][]>([]);
  let liveContent = $state("");
  let focusMode = $state(false);
  let readingMode = $state(false);
  // Typewriter + dimming parity with Write (per-doc prefs, same store).
  let typewriterEnabled = $state($settings.typewriterDefault);
  let focusDimming = $state($settings.focusDimmingDefault);

  function toggleTypewriter() {
    typewriterEnabled = !typewriterEnabled;
    if ($currentDoc) {
      saveFocusPrefs($currentDoc.id, {
        typewriter: typewriterEnabled,
        focus: focusDimming,
      });
    }
    if (editorView && editorContainer && $currentDoc) createEditor($currentDoc);
  }

  function toggleFocusDimming() {
    focusDimming = !focusDimming;
    if ($currentDoc) {
      saveFocusPrefs($currentDoc.id, {
        typewriter: typewriterEnabled,
        focus: focusDimming,
      });
    }
    if (editorView && editorContainer && $currentDoc) createEditor($currentDoc);
  }

  // Slash commands (A11.7)
  let slashVisible = $state(false);
  let slashFilter = $state("");
  let slashPos = $state({ x: 0, y: 0 });
  let slashLineStart = $state(0);
  let slashSelectedIdx = $state(0);

  // Wikilink hover preview (A11.3)
  let previewVisible = $state(false);
  let previewPos = $state({ x: 0, y: 0 });
  let previewDocId = $state("");
  let previewDocTitle = $state("");
  let storyMemoryVisible = $state(false);
  let storyMemoryPosition = $state({ x: 0, y: 0 });
  let storyMemoryEntity = $state<StoryMemoryView | null>(null);
  let storyMemoryLoadToken = 0;
  let storyMemoryJumpToken = 0;

  function triggerStructurize() {
    if (companionMode || !editorView) return;
    const { from, to } = editorView.state.selection.main;
    const selected = editorView.state.sliceDoc(from, to);
    structurizePreset.set(selected || null);
    $aiPanelOpen = true;
  }

  const slashCommands = [
    { label: "Heading 1", icon: "H1", insert: "# " },
    { label: "Heading 2", icon: "H2", insert: "## " },
    { label: "Heading 3", icon: "H3", insert: "### " },
    { label: "Bullet List", icon: "•", insert: "- " },
    { label: "Numbered List", icon: "1.", insert: "1. " },
    { label: "Checklist", icon: "☐", insert: "- [ ] " },
    { label: "Blockquote", icon: "❝", insert: "> " },
    { label: "Code Block", icon: "⟨⟩", insert: "```\n\n```" },
    { label: "Horizontal Rule", icon: "—", insert: "---\n" },
    { label: "Table", icon: "▦", insert: "| Col | Col |\n|-----|-----|\n|     |     |" },
    { label: "Wikilink", icon: "[[", insert: "[[]]" },
    { label: "Structurize", icon: "{}", insert: "" },
  ];

  let slashFiltered = $derived(
    slashCommands.filter((command) => !companionMode || command.label !== "Structurize").filter((command) =>
      slashFilter
        ? command.label.toLowerCase().includes(slashFilter.toLowerCase())
        : true
    )
  );

  function handleSlashInsert(insert: string, label?: string) {
    if (!editorView) return;
    if (label === "Structurize" && companionMode) return;
    const view = editorView;
    const pos = slashLineStart;
    // Replace the "/" trigger + filter text with the inserted content
    const line = view.state.doc.lineAt(pos);
    const cursorPos = view.state.selection.main.head;
    const filterLen = cursorPos - pos;
    if (label === "Structurize") {
      // Special: open AI panel in structurize mode with selection
      const { from, to } = view.state.selection.main;
      const selected = view.state.sliceDoc(from, to);
      structurizePreset.set(selected || null);
      $aiPanelOpen = true;
    } else {
      view.dispatch({
        changes: { from: pos, to: pos + filterLen, insert },
      });
    }
    slashVisible = false;
    slashFilter = "";
    view.focus();
  }

  function handleSlashKeydown(e: KeyboardEvent) {
    if (!slashVisible) return false;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      slashSelectedIdx = (slashSelectedIdx + 1) % slashFiltered.length;
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      slashSelectedIdx = (slashSelectedIdx - 1 + slashFiltered.length) % slashFiltered.length;
      return true;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (slashFiltered[slashSelectedIdx]) {
        handleSlashInsert(slashFiltered[slashSelectedIdx].insert, slashFiltered[slashSelectedIdx].label);
      }
      return true;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      slashVisible = false;
      return true;
    }
    return false;
  }

  function handleEditorMousemove(e: MouseEvent) {
    if (companionMode) {
      previewVisible = false;
      return;
    }
    if (!editorView) return;
    const pos = editorView.posAtCoords({ x: e.clientX, y: e.clientY });
    if (pos == null) { previewVisible = false; return; }
    const doc = editorView.state.doc;
    const line = doc.lineAt(pos);
    const lineText = line.text;
    const offset = pos - line.from;
    // Find [[ ... ]] around cursor
    const before = lineText.slice(0, offset);
    const after = lineText.slice(offset);
    const openIdx = before.lastIndexOf("[[");
    if (openIdx === -1 || (openIdx < before.length - 1 && before[openIdx + 1] === "[")) { previewVisible = false; return; }
    const closeIdx = after.indexOf("]]");
    if (closeIdx === -1) { previewVisible = false; return; }
    const linkTitle = before.slice(openIdx + 2) + after.slice(0, closeIdx);
    if (!linkTitle || linkTitle.length > 80) { previewVisible = false; return; }
    // One lookup per link target — mousemove fires per pixel, the backend
    // must not be hammered (and every failure used to log unhandled).
    if (linkTitle === lastPreviewTitle) {
      previewPos = { x: e.clientX, y: e.clientY };
      previewVisible = true;
      return;
    }
    lastPreviewTitle = linkTitle;
    const wantedTitle = linkTitle;
    // Find doc by title (stale-token guarded: rapid hovers resolve out of
    // order, and only the latest title may paint).
    api.docListByWorkspace("write").then((docs) => {
      if (wantedTitle !== lastPreviewTitle) return;
      const match = docs.find((d) => d.title === wantedTitle);
      if (match) {
        previewDocId = match.id;
        previewDocTitle = match.title;
        previewPos = { x: e.clientX, y: e.clientY };
        previewVisible = true;
      } else {
        previewDocTitle = linkTitle;
        previewDocId = "";
        previewPos = { x: e.clientX, y: e.clientY };
        previewVisible = true;
      }
    }).catch((e) => {
      warnOnce("Write link preview", e);
      previewVisible = false;
    });
  }

  function handleEditorMouseleave() {
    previewVisible = false;
    lastPreviewTitle = null;
  }

  function handleStoryMemoryHover(view: StoryMemoryView | null, position: { x: number; y: number }) {
    storyMemoryEntity = view;
    storyMemoryPosition = position;
    storyMemoryVisible = !!view;
  }

  async function refreshStoryMemory(doc: Doc | null): Promise<void> {
    const loadToken = ++storyMemoryLoadToken;
    if (companionMode || !doc) {
      setStoryMemoryData(editorView, null);
      storyMemoryVisible = false;
      return;
    }
    try {
      const scopeId = await api.bibleScopeId(doc.id);
      const [facts, mentions] = await Promise.all([
        api.bibleGetFacts(scopeId),
        api.bibleGetMentions(scopeId),
      ]);
      if (loadToken !== storyMemoryLoadToken || $currentDoc?.id !== doc.id) return;
      setStoryMemoryData(editorView, { facts, mentions } satisfies StoryMemoryData);
    } catch {
      if (loadToken !== storyMemoryLoadToken || $currentDoc?.id !== doc.id) return;
      setStoryMemoryData(editorView, null);
    }
  }

  async function jumpToStoryMemoryMention(mention: { doc_id: string; snippet: string; span_start: number | null }) {
    const jumpToken = ++storyMemoryJumpToken;
    try {
      if ($currentDoc?.id !== mention.doc_id) {
        const doc = await api.docGet(mention.doc_id);
        if (jumpToken !== storyMemoryJumpToken) return;
        $currentDoc = doc;
        if (!$openTabs.find((tab) => tab.id === doc.id)) $openTabs = [doc, ...$openTabs];
      }
      window.setTimeout(() => {
        if (jumpToken !== storyMemoryJumpToken || $currentDoc?.id !== mention.doc_id) return;
        window.dispatchEvent(new CustomEvent("editor-scroll-to-text", {
          detail: { snippet: mention.snippet, spanStart: mention.span_start },
        }));
      }, 80);
    } catch (e) {
      showToast(`Couldn't open appearance: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  // Story Bible vocabulary for autocorrect's custom dictionary (A8.8):
  // refreshed per open doc so invented names are never "fixed".
  let bibleWords = $state<Set<string>>(new Set());

  function refreshBibleWords(doc: Doc | null) {
    if (!doc) {
      bibleWords = new Set();
      return;
    }
    loadBibleWords(doc, api)
      .then((w) => {
        bibleWords = w;
      })
      .catch((e) => {
        warnOnce("Write story-bible vocab", e);
        bibleWords = new Set();
      });
  }

  async function handleFileDrop(e: DragEvent) {
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0 || !$currentDoc || !editorView) return;
    e.preventDefault();
    const { attachFiles } = await import("$lib/attachments");
    await attachFiles(editorView, files);
  }

  async function handlePaste(e: ClipboardEvent) {
    const items = e.clipboardData?.items;
    if (!items || !$currentDoc || !editorView) return;

    const files: File[] = [];
    for (const item of Array.from(items)) {
      if (item.kind === "file") {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length === 0) return;
    e.preventDefault();
    const { attachFiles } = await import("$lib/attachments");
    await attachFiles(editorView, files);
  }

  function makeDarkTheme(font: string, size: number, lh: number, theme = "default", mode = "dark") {
    // Per-style×mode editor surface from the shared palette. Mirrors app.css.
    const p = editorPalette(theme, mode);
    return EditorView.theme({
      "&": {
        backgroundColor: p.bg,
        color: p.fg,
      },
      ".cm-content": {
        caretColor: p.accent,
        fontFamily: editorFontStack(font),
        fontSize: `${size}px`,
        lineHeight: `${lh}`,
        padding: "40px 0",
        maxWidth: "720px",
        margin: "0 auto",
      },
    ".cm-gutters": {
      backgroundColor: p.bg,
      color: p.muted,
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: p.overlay,
    },
    ".cm-activeLine": {
      backgroundColor: p.overlay,
    },
    ".cm-selectionBackground": {
      backgroundColor: `${p.sel} !important`,
    },
    ".cm-cursor": {
      borderLeftColor: p.accent,
    },
    ".cm-focused .cm-selectionBackground": {
      backgroundColor: `${p.selFocus} !important`,
    },
    ".cm-autocorrect-suggest": {
      textDecoration: AUTOCORRECT_WAVY,
      textUnderlineOffset: "3px",
    },
    ".cm-focus-dimmed": {
      opacity: "0.35",
      transition: "opacity 0.3s ease",
    },
    // Find/replace panel: solid theme surfaces, never the default white.
    ".cm-panel.cm-search": {
      backgroundColor: p.overlay,
      color: p.fg,
      borderBottom: `1px solid ${p.muted}`,
      padding: "6px 8px",
      borderRadius: p.radius,
    },
    ".cm-panel.cm-search input": {
      backgroundColor: p.bg,
      color: p.fg,
      border: `1px solid ${p.muted}`,
      borderRadius: p.radius,
    },
    ".cm-panel.cm-search button": {
      backgroundColor: "transparent",
      color: p.fg,
      border: `1px solid ${p.muted}`,
      borderRadius: p.radius,
    },
    ".cm-searchMatch": {
      backgroundColor: p.match,
    },
    ".cm-searchMatch-selected": {
      backgroundColor: p.matchSel,
    },
  });
  }

  function createEditor(doc: Doc | null) {
    if (editorView) {
      editorView.destroy();
    }

    const content = doc?.content ?? "";
    const darkTheme = makeDarkTheme($settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.theme, $settings.themeMode);

    // Snippet expansion plugin. The expansion dispatch is deferred past
    // the update cycle (dispatch is illegal synchronously inside
    // ViewPlugin.update) and revalidated, so a fast typist can never
    // have the deferred fix clobber newer text.
    const snippetPlugin = ViewPlugin.fromClass(
      class {
        lastText = "";
        pendingExpand = false;
        update(update: ViewUpdate) {
          if (!update.docChanged || this.pendingExpand) return;
          const state = update.state;
          const selection = state.selection.main;
          if (!selection.empty) return;
          const pos = selection.head;
          const line = state.doc.lineAt(pos);
          const lineText = line.text.slice(0, pos - line.from);
          // Check for snippet triggers ending at cursor
          for (const snippet of getSnippetsForWorkspace($currentWorkspace ?? "write")) {
            if (lineText.endsWith(snippet.trigger)) {
              const expanded = expandSnippet(snippet.trigger, $currentWorkspace ?? "write");
              if (expanded) {
                const from = pos - snippet.trigger.length;
                const view = update.view;
                this.pendingExpand = true;
                queueMicrotask(() => {
                  this.pendingExpand = false;
                  try {
                    if (
                      view.state.selection.main.empty &&
                      view.state.selection.main.head === pos &&
                      view.state.sliceDoc(from, pos) === snippet.trigger
                    ) {
                      view.dispatch({ changes: { from, to: pos, insert: expanded } });
                    }
                  } catch {
                    /* view destroyed or doc reshaped mid-flight: drop */
                  }
                });
                break;
              }
            }
          }
        }
      }
    );

    const state = EditorState.create({
      doc: content,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        highlightSpecialChars(),
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          // Find/replace (Ctrl+F) via @codemirror/search; panel themed above.
          ...searchKeymap,
          {
            key: "Tab",
            run: () => {
              if (ghostVisible && ghostSuggestion) {
                acceptGhost();
                return true;
              }
              return false;
            },
          },
          {
            key: "Escape",
            run: () => {
              if (ghostVisible) {
                dismissGhost();
                return true;
              }
              return false;
            },
          },
          {
            // Spec §4.1: Ctrl+T inserts a timestamp (desktop shell; browsers
            // reserve Ctrl+T for new tabs).
            key: "Ctrl-t",
            run: (view) => {
              const pos = view.state.selection.main.head;
              const stamp = new Date().toLocaleTimeString("en-US", {
                hour: "2-digit",
                minute: "2-digit",
                hour12: false,
              });
              view.dispatch({ changes: { from: pos, insert: stamp } });
              return true;
            },
          },
          {
            // Ctrl+Shift+S: open AI panel in structurize mode with current selection.
            key: "Ctrl-Shift-s",
            run: (view) => {
              if (companionMode) return false;
              const { from, to } = view.state.selection.main;
              const selected = view.state.sliceDoc(from, to);
              structurizePreset.set(selected || null);
              $aiPanelOpen = true;
              return true;
            },
          },
        ]),
        markdown(),
        darkTheme,
        search({ top: true }),
        highlightSelectionMatches(),
        ...(!companionMode
          ? [createStoryMemoryExtension({ onHover: handleStoryMemoryHover })]
          : []),
        ...(focusDimming ? [focusDimmingPlugin(() => focusDimming)] : []),
        ...(typewriterEnabled
          ? [EditorView.scrollMargins.of(() => ({ top: 200, bottom: 200 }))]
          : []),
        ...($settings.autocorrectEnabled
          ? [
              createAutocorrectPlugin({
                enabled: () => $settings.autocorrectEnabled,
                useEnglishTable: () => $settings.dictionaryLanguage !== "off",
                getCustomWords: () => bibleWords,
              }),
            ]
          : []),
        snippetPlugin,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            handleContentChange(update.state.doc.toString());
            // Typing activity: lets the shell auto-hide chrome for focus.
            window.dispatchEvent(new CustomEvent("editor-typing"));
            // Slash command detection (A11.7)
            const pos = update.state.selection.main.head;
            const line = update.state.doc.lineAt(pos);
            const lineText = line.text;
            const cursorInLine = pos - line.from;
            if (lineText.startsWith("/") && cursorInLine <= lineText.length && cursorInLine > 0) {
              slashFilter = lineText.slice(1, cursorInLine);
              slashLineStart = line.from;
              if (!slashVisible) {
                slashVisible = true;
                slashSelectedIdx = 0;
                const coords = update.view.coordsAtPos(pos);
                if (coords) {
                  slashPos = { x: coords.left, y: coords.bottom + 4 };
                }
              }
            } else if (slashVisible) {
              slashVisible = false;
            }
          }
          return false;
        }),
      ],
    });

    editorView = new EditorView({
      state,
      parent: editorContainer,
    });
  }

  let lastMetricAt = 0;

  let saveQueue: Promise<void> = Promise.resolve();

  function queueDocSave(editingDocId: string, content: string) {
    saveQueue = saveQueue.then(async () => {
      try {
        const updated = await (companionMode
          ? api.widgetDocSave(editingDocId, undefined, content)
          : api.docSave(editingDocId, undefined, content));
        if ($currentDoc?.id === editingDocId) $currentDoc = { ...$currentDoc, word_count: updated.word_count };
        if (!companionMode) scheduleStoryMemory(updated, content);
        const now = Date.now();
        if (now - lastMetricAt > 60000) {
          lastMetricAt = now;
          api.usageRecord(editingDocId, "write").catch((e) => warnOnce("Write usage telemetry", e));
          if (!companionMode && $settings.craftProfilingEnabled) {
            const stats = craftStats(content);
            api.memoryRecordMetric(editingDocId, "filter_words", stats.filterWords).catch((e) => warnOnce("Write craft telemetry", e));
            api.memoryRecordMetric(editingDocId, "dialogue_ratio", stats.dialogue).catch((e) => warnOnce("Write craft telemetry", e));
            api.memoryRecordMetric(editingDocId, "avg_sentence_length", stats.avgSentence).catch((e) => warnOnce("Write craft telemetry", e));
          }
        }
      } catch (e) {
        // Data-loss risk: the user must see this, not just the console.
        domainError("Write", "couldn't save document", e);
      }
    });
  }

  function handleContentChange(content: string) {
    if (!$currentDoc || (companionMode && $currentDoc.locked)) return;
    const editingDocId = $currentDoc.id;
    liveContent = content;

    recordSave();
    if (typewriterEnabled) {
      requestAnimationFrame(() => centerCursorIn(editorView, editorContainer));
    }

    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => queueDocSave(editingDocId, content), 500);

    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(() => {
      saveQueue = saveQueue.then(async () => {
        try {
          await (companionMode
            ? api.widgetAtomicSave(editingDocId, content)
            : api.atomicSave(editingDocId, content));
        } catch (e) {
          domainError("Write", "couldn't flush document to disk", e);
        }
      });
    }, 5000);

    if (!companionMode && $settings.ghostEnabled && content.length > 20) {
      if (ghostDebounce) clearTimeout(ghostDebounce);
      ghostDebounce = setTimeout(() => requestGhostSuggestion(content), 1500);
    }
  }

  async function requestGhostSuggestion(content: string) {
    if (!$settings.ghostEnabled || !$currentDoc) return;
    try {
      assertAiAllowedForDoc($currentDoc);
    } catch {
      return;
    }

    const lastSentence = lastSentenceOf(content);
    if (!lastSentence) return;

    // Provider routing is fixed inside ghost.ts — callers only pass
    // privacy metadata (private workspaces stay local-only).
    const suggestion = await requestGhostContinuation(lastSentence, $currentWorkspace);
    if (suggestion) {
      ghostSuggestion = suggestion;
      ghostVisible = true;
    }
  }

  function acceptGhost() {
    if (!ghostSuggestion || !editorView) return;
    const pos = editorView.state.selection.main.head;
    editorView.dispatch({
      changes: { from: pos, insert: ghostSuggestion },
    });
    ghostSuggestion = '';
    ghostVisible = false;
    markUsed('ghost');
  }

  function dismissGhost() {
    ghostSuggestion = '';
    ghostVisible = false;
  }

  let typstAvailable = $state(true);
  let exportMenuLoaded = $state(false);

  /** Export what's on screen: flush live editor content, then convert. */
  async function exportAs(format: string) {
    if (!$currentDoc) return;
    showExportMenu = false;
    if (format === 'fountain') {
      const content = editorView?.state.doc.toString() ?? $currentDoc.content ?? '';
      downloadFountain($currentDoc.title || 'untitled', content);
      markUsed('export');
      return;
    }
    try {
      const content = editorView?.state.doc.toString() ?? $currentDoc.content ?? '';
      await (companionMode
        ? api.widgetDocSave($currentDoc.id, undefined, content)
        : api.docSave($currentDoc.id, undefined, content));
      const out = await api.convertRun($currentDoc.id, format);
      downloadConvertOutput(out);
      markUsed('export');
      showToast(`Exported ${out.filename}`, 'success');
    } catch (e) {
      showToast(`Export failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  async function toggleExportMenu() {
    showExportMenu = !showExportMenu;
    if (showExportMenu && !exportMenuLoaded) {
      try {
        const status = await api.convertStatus();
        typstAvailable = status.typst;
      } catch {
        typstAvailable = false;
      }
      exportMenuLoaded = true;
    }
  }

  function formatDisabled(fmt: string): string | null {
    if (BINARY_FORMATS.has(fmt) && !typstAvailable) {
      return "Needs the Typst binary — see Settings → About → Export setup";
    }
    return null;
  }

  function closeExportOnOutside(e: MouseEvent) {
    if (!showExportMenu) return;
    if ((e.target as HTMLElement).closest?.(".export-wrapper")) return;
    showExportMenu = false;
  }

  $effect(() => {
    // Triggers: open doc or container mount ONLY. createEditor reads AND
    // writes editorView (destroy-guard + assign) — running it tracked would
    // resubscribe to editorView and re-fire this effect forever (busy-loop
    // that rebuilds the whole editor and starves timers).
    const doc = $currentDoc;
    if (doc && editorContainer) {
      untrack(() => {
        const prefs = loadFocusPrefs(doc.id, {
          typewriter: $settings.typewriterDefault,
          focus: $settings.focusDimmingDefault,
        });
        typewriterEnabled = prefs.typewriter;
        focusDimming = prefs.focus;
        createEditor(doc);
      });
      refreshBibleWords(doc);
      refreshStoryMemory(doc);
      if (!companionMode) loadCraftMetrics(doc.id);
    } else {
      refreshBibleWords(null);
      refreshStoryMemory(null);
    }
  });

  // Rebuild the editor live when theme or type settings change.
  // Same untrack rule: the rebuild must not resubscribe to what it rewrites.
  $effect(() => {
    void [$settings.theme, $settings.themeMode, $settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.autocorrectEnabled, $settings.dictionaryLanguage];
    untrack(() => {
      if (editorView && editorContainer && $currentDoc) createEditor($currentDoc);
    });
  });

  // Settings → typewriter/focus defaults apply to the open doc live when it
  // has no per-doc override (no jwe-focus-<id> entry). Explicit per-doc
  // toggles win; defaults only govern untouched docs.
  $effect(() => {
    const td = $settings.typewriterDefault;
    const fd = $settings.focusDimmingDefault;
    untrack(() => {
      const id = $currentDoc?.id;
      if (!id || !editorView || !editorContainer) return;
      try {
        if (localStorage.getItem(`jwe-focus-${id}`)) return;
      } catch {
        return;
      }
      let changed = false;
      if (typewriterEnabled !== td) {
        typewriterEnabled = td;
        changed = true;
      }
      if (focusDimming !== fd) {
        focusDimming = fd;
        changed = true;
      }
      if (changed) createEditor($currentDoc);
    });
  });

  // Listen for scroll-to-line events from InspectorPanel outline
  $effect(() => {
    function handleScrollToLine(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!editorView || detail.line == null) return;
      const line = Math.max(0, Math.min(detail.line, editorView.state.doc.lines - 1));
      const pos = editorView.state.doc.line(line + 1).from;
      editorView.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
      editorView.focus();
    }
    window.addEventListener("editor-scroll-to-line", handleScrollToLine);
    return () => window.removeEventListener("editor-scroll-to-line", handleScrollToLine);
  });

  $effect(() => {
    function handleScrollToText(e: Event) {
      const detail = (e as CustomEvent).detail;
      if (!editorView) return;
      let pos = typeof detail.spanStart === "number" ? detail.spanStart : -1;
      if (pos < 0 || pos > editorView.state.doc.length) {
        pos = editorView.state.doc.toString().indexOf(String(detail.snippet ?? ""));
      }
      if (pos < 0) return;
      editorView.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
      editorView.focus();
    }
    window.addEventListener("editor-scroll-to-text", handleScrollToText);
    return () => window.removeEventListener("editor-scroll-to-text", handleScrollToText);
  });

  $effect(() => {
    async function handleMemoryUpdated(e: Event) {
      const detail = (e as CustomEvent).detail;
      const doc = $currentDoc;
      if (!doc) return;
      if (detail.scopeId) {
        try {
          const scopeId = await api.bibleScopeId(doc.id);
          if ($currentDoc?.id !== doc.id || scopeId !== detail.scopeId) return;
        } catch {
          return;
        }
      }
      refreshStoryMemory(doc);
    }
    window.addEventListener("story-memory-updated", handleMemoryUpdated);
    return () => window.removeEventListener("story-memory-updated", handleMemoryUpdated);
  });

  async function loadCraftMetrics(docId: string) {
    try {
      const [d, s] = await Promise.all([
        api.craftMetricsTrend(docId, "dialogue_ratio"),
        api.craftMetricsTrend(docId, "avg_sentence_length"),
      ]);
      dialogueTrend = d;
      sentenceTrend = s;
    } catch (e) {
      warnOnce("Write craft trends", e);
    }
  }

  $effect(() => {
    const event = $writeBack;
    if (!event || !editorView) return;

    // Only the open doc consumes the event — anything else clears it so a
    // stale insert can never land in the wrong document later.
    if (!event.docId || event.docId !== $currentDoc?.id) {
      writeBack.clear();
      return;
    }
    applyWriteBackEvent(editorView, event);
    writeBack.clear();
  });

  onDestroy(() => {
    if (editorView) editorView.destroy();
     if (saveTimeout) clearTimeout(saveTimeout);
     if (flushTimeout) clearTimeout(flushTimeout);
     if (ghostDebounce) clearTimeout(ghostDebounce);
  });
</script>

<svelte:window onclick={closeExportOnOutside} />
<!-- svelte-ignore a11y_no_noninteractive_element_interactions: composite editor widget — keydown only drives the slash menu (arrows/Enter/Escape, no-op otherwise); all actions are buttons/inputs. -->
<div
  class="editor-pane"
  class:focus-mode={focusMode}
  class:reading-mode={readingMode}
  onkeydown={handleSlashKeydown}
  role="application"
>
  {#if !companionMode}
  <div class="editor-toolbar">
    <span class="doc-title">{$currentDoc?.title ?? ''}</span>
    <div class="toolbar-actions">
      <div class="toolbar-group" role="group" aria-label="AI and history">
        <button class="icon-btn" class:active={$aiPanelOpen} onclick={() => $aiPanelOpen = !$aiPanelOpen} title="AI panel (Ctrl+J)" aria-label="Toggle AI panel">
          <Icon name="sparkle" size={15} />
        </button>
        <VersionHistory />
      </div>
      <div class="toolbar-group" role="group" aria-label="View modes">
        <button
          class="icon-btn"
          class:active={focusMode}
          onclick={() => focusMode = !focusMode}
          title="Focus Mode (F11)"
          aria-label="Toggle focus mode"
          aria-pressed={focusMode}
        >
          <Icon name={focusMode ? "lock" : "unlock"} size={15} />
        </button>
        <button
          class="icon-btn"
          class:active={readingMode}
          onclick={() => readingMode = !readingMode}
          title="Reading Mode"
          aria-label="Toggle reading mode"
          aria-pressed={readingMode}
        >
          <Icon name="book-open" size={15} />
        </button>
        <button
          class="icon-btn"
          class:active={typewriterEnabled}
          onclick={toggleTypewriter}
          title="Typewriter mode"
          aria-label="Toggle typewriter mode"
          aria-pressed={typewriterEnabled}
        >
          <Icon name="pencil" size={15} />
        </button>
        <button
          class="icon-btn"
          class:active={focusDimming}
          onclick={toggleFocusDimming}
          title="Focus dimming"
          aria-label="Toggle focus dimming"
          aria-pressed={focusDimming}
        >
          <Icon name="eye" size={15} />
        </button>
        <button
          class="icon-btn"
          class:active={$inspectorOpen}
          onclick={() => $inspectorOpen = !$inspectorOpen}
          title="Outline & links (Ctrl+I)"
          aria-label="Toggle inspector"
          aria-pressed={$inspectorOpen}
        >
          <Icon name="panel" size={15} />
        </button>
      </div>
      {#if $settings.sttEnabled || $settings.ttsEnabled}
        <div class="toolbar-group" role="group" aria-label="Voice">
          {#if $settings.sttEnabled}
            <MicButton onTranscribe={(text) => {
              if (editorView) {
                const pos = editorView.state.selection.main.head;
                editorView.dispatch({ changes: { from: pos, insert: text + ' ' } });
                editorView.focus();
              }
            }} />
          {/if}
          {#if $settings.ttsEnabled}
            <ReadAloudButton
              getText={() => $currentDoc?.content ?? ''}
              getSelection={() => {
                if (!editorView) return '';
                const sel = editorView.state.selection.main;
                return sel.from !== sel.to
                  ? editorView.state.sliceDoc(sel.from, sel.to)
                  : '';
              }}
            />
          {/if}
        </div>
      {/if}
      <div class="toolbar-group" role="group" aria-label="File">
        <button class="icon-btn" class:active={showRhythm} onclick={() => { showRhythm = !showRhythm; if (showRhythm) showCraft = false; }} title="Rhythm" aria-label="Toggle rhythm view">
          <Icon name="waveform" size={15} />
        </button>
        <button class="craft-toggle icon-btn" class:active={showCraft} onclick={() => { showCraft = !showCraft; if (showCraft) showRhythm = false; }} title="Craft metrics" aria-label="Toggle craft metrics">
          <Icon name="chart" size={15} />
        </button>
        <div class="export-wrapper">
          <button class="export-btn icon-btn" onclick={toggleExportMenu} title="Export document" aria-label="Export document">
            <Icon name="download" size={15} />
          </button>
          {#if showExportMenu}
            <div class="export-menu" role="menu" aria-label="Export formats">
              {#each ALL_EXPORT_FORMATS as fmt}
                {@const reason = formatDisabled(fmt)}
                <button
                  onclick={() => exportAs(fmt)}
                  disabled={reason !== null}
                  title={reason ?? `Export as ${exportLabel(fmt)}`}
                >{exportLabel(fmt)}</button>
              {/each}
              {#if $currentDoc?.kind === 'fountain'}
                <button onclick={() => exportAs('fountain')} title="Export raw Fountain source">Fountain (.fountain)</button>
              {/if}
            </div>
          {/if}
        </div>
      </div>
    </div>
  </div>
  {/if}
  {#if showRhythm}
    <RhythmPanel content={liveContent} {dialogueTrend} {sentenceTrend} onJumpToLine={(line) => {
      if (!editorView) return;
      const pos = editorView.state.doc.line(line + 1).from;
      editorView.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "start" }) });
      editorView.focus();
    }} />
  {/if}
  {#if showCraft}
    <div class="craft-panel">
      <div class="craft-charts">
        <TrendlineChart data={dialogueTrend} label="Dialogue Ratio" />
        <TrendlineChart data={sentenceTrend} label="Avg Sentence Length" color="var(--accent-semantic-purple)" />
      </div>
    </div>
  {/if}
  {#if !companionMode}
    <FormatToolbar view={editorView} />
  {/if}
  <div
    class="editor-container"
    bind:this={editorContainer}
    ondrop={handleFileDrop}
    onpaste={handlePaste}
    ondragover={(e) => e.preventDefault()}
    onmousemove={handleEditorMousemove}
    onmouseleave={handleEditorMouseleave}
    role="application"
  >
    {#if ghostVisible && ghostSuggestion}
      <div class="ghost-overlay">
        <div class="ghost-suggestion">
          <span class="ghost-text">{ghostSuggestion}</span>
          <div class="ghost-actions">
            <button class="ghost-accept" onclick={acceptGhost}>Tab to accept</button>
            <button class="ghost-dismiss" onclick={dismissGhost}>Esc to dismiss</button>
          </div>
        </div>
      </div>
    {/if}
  </div>

  {#if slashVisible && slashFiltered.length > 0}
    <div class="slash-menu" style="left: {slashPos.x}px; top: {slashPos.y}px;" role="listbox">
      {#each slashFiltered as cmd, i}
        <button
          class="slash-item"
          class:selected={i === slashSelectedIdx}
          role="option"
          aria-selected={i === slashSelectedIdx}
          onmouseenter={() => slashSelectedIdx = i}
          onclick={() => handleSlashInsert(cmd.insert, cmd.label)}
        >
          <span class="slash-icon">{cmd.icon}</span>
          <span class="slash-label">{cmd.label}</span>
        </button>
      {/each}
    </div>
  {/if}

  <WikilinkPreview bind:visible={previewVisible} bind:position={previewPos} bind:docId={previewDocId} bind:docTitle={previewDocTitle} />
  {#if !companionMode}
    <StoryMemoryHoverCard bind:visible={storyMemoryVisible} bind:position={storyMemoryPosition} bind:entity={storyMemoryEntity} onJump={jumpToStoryMemoryMention} />
  {/if}
</div>

<style>
  .editor-pane {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .editor-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-base);
  }

  .doc-title {
    font-size: 12px;
    color: var(--text-muted);
    font-weight: var(--font-weight-semibold);
  }

  .toolbar-actions {
    display: flex;
    gap: 4px;
    align-items: center;
  }

  .toolbar-group {
    display: flex;
    gap: 2px;
    align-items: center;
    padding: 0 8px;
  }

  .toolbar-group:first-child {
    padding-left: 0;
  }

  .toolbar-group + .toolbar-group {
    border-left: 1px solid var(--border-subtle);
  }

  .toolbar-group .icon-btn.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .export-wrapper {
    position: relative;
  }

  .export-btn {
    padding: 4px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
  }

  .export-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 50;
    min-width: 160px;
  }

  .export-menu button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .export-menu button:hover {
    background: var(--surface-overlay);
  }

  .export-menu button:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .craft-toggle {
    padding: 4px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: 12px;
    cursor: pointer;
  }

  .craft-toggle.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .craft-panel {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-base);
  }

  .craft-charts {
    display: flex;
    gap: 24px;
  }

  .editor-container {
    flex: 1;
    overflow: auto;
    position: relative;
    transition: padding 0.2s ease, margin 0.2s ease;
  }

  /* Focus/reading modes live on the pane root so they can reach the
     toolbars (siblings of the container, not children). CodeMirror
     internals (.cm-*) are injected DOM → :global. */
  .editor-pane.focus-mode .editor-container {
    padding: 40px 20%;
    margin: 0 auto;
    max-width: 800px;
  }

  .editor-pane.reading-mode .editor-container {
    padding: 40px 15%;
    margin: 0 auto;
    max-width: 900px;
    font-size: 1.1rem;
    line-height: 1.9;
  }

  .editor-pane.reading-mode :global(.cm-content) {
    font-family: var(--font-body);
    font-size: 1.1rem;
    line-height: 1.9;
  }

  .editor-pane.reading-mode :global(.cm-gutters),
  .editor-pane.focus-mode :global(.cm-gutters),
  .editor-pane.reading-mode .editor-toolbar,
  .editor-pane.reading-mode :global(.format-toolbar) {
    display: none;
  }

  .ghost-overlay {
    position: absolute;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 100;
    pointer-events: auto;
  }

  .ghost-suggestion {
    background: var(--surface-raised);
    border: 1px solid var(--accent-primary);
    border-radius: var(--radius-lg);
    padding: 12px 16px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    max-width: 500px;
  }

  .ghost-text {
    font-family: var(--font-mono);
    font-size: 13px;
    color: var(--text-primary);
    line-height: 1.5;
    display: block;
    margin-bottom: 8px;
    font-style: italic;
    opacity: 0.9;
  }

  .ghost-actions {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .ghost-accept {
    padding: 4px 10px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-sm);
    font-size: 11px;
    cursor: pointer;
  }

  .ghost-dismiss {
    padding: 4px 10px;
    background: transparent;
    color: var(--text-muted);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 11px;
    cursor: pointer;
  }

  .slash-menu {
    position: fixed;
    z-index: 1000;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    min-width: 180px;
    max-height: 280px;
    overflow-y: auto;
    padding: 4px;
  }

  .slash-item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 5px 8px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    border-radius: var(--radius-sm);
    font-size: 13px;
    text-align: left;
  }

  .slash-item.selected {
    background: var(--surface-pressed);
  }

  .slash-item:hover {
    background: var(--surface-hover);
  }

  .slash-icon {
    width: 24px;
    text-align: center;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .slash-label {
    font-size: 13px;
  }
</style>
