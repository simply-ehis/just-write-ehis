<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars } from "@codemirror/view";
  import WikilinkPreview from "./WikilinkPreview.svelte";
  import { EditorState } from "@codemirror/state";
  import { basicSetup } from "codemirror";
  import { defaultKeymap, history, historyKeymap, insertTab } from "@codemirror/commands";
  import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
  import { markdown } from "@codemirror/lang-markdown";
  import { currentDoc, aiPanelOpen, currentWorkspace, inspectorOpen } from "$lib/stores/app";
  import { api, type Doc } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { applyWriteBackEvent, writeBack } from "$lib/stores/writeBack";
  import { recordSave } from "$lib/stores/saveState";
  import { showToast } from "$lib/stores/notifications";
  import { ViewPlugin, type ViewUpdate } from "@codemirror/view";
  import { createAutocorrectPlugin, loadBibleWords } from "$lib/autocorrectPlugin";
  import VersionHistory from "./VersionHistory.svelte";
  import TrendlineChart from "./TrendlineChart.svelte";
  import FormatToolbar from "./FormatToolbar.svelte";
  import MicButton from "./MicButton.svelte";
  import ReadAloudButton from "./ReadAloudButton.svelte";
  import Icon from "./Icon.svelte";
  import { downloadConvertOutput } from "$lib/download";
  import { assertAiAllowedForDoc } from "$lib/stores/lock";
  import { filterWordRatio } from "$lib/browserBackend";
  import { lastSentenceOf, requestGhostContinuation } from "$lib/ghost";
  import { markUsed } from "$lib/features";
  import { expandSnippet, getSnippetsForWorkspace } from "$lib/stores/templates";
  import { centerCursorIn, focusDimmingPlugin, loadFocusPrefs, saveFocusPrefs } from "$lib/editorFocus";

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
  let dialogueTrend = $state<[string, number][]>([]);
  let sentenceTrend = $state<[string, number][]>([]);
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
  ];

  let slashFiltered = $derived(
    slashFilter
      ? slashCommands.filter(c => c.label.toLowerCase().includes(slashFilter.toLowerCase()))
      : slashCommands
  );

  function handleSlashInsert(insert: string) {
    if (!editorView) return;
    const view = editorView;
    const pos = slashLineStart;
    // Replace the "/" trigger + filter text with the inserted content
    const line = view.state.doc.lineAt(pos);
    const cursorPos = view.state.selection.main.head;
    const filterLen = cursorPos - pos;
    view.dispatch({
      changes: { from: pos, to: pos + filterLen, insert },
    });
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
        handleSlashInsert(slashFiltered[slashSelectedIdx].insert);
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
    // Find doc by title
    api.docListByWorkspace("write").then((docs) => {
      const match = docs.find((d: any) => d.title === linkTitle);
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
    }).catch(() => {
      previewVisible = false;
    });
  }

  function handleEditorMouseleave() {
    previewVisible = false;
    lastPreviewTitle = null;
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
      .catch(() => {
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

  function makeDarkTheme(font: string, size: number, lh: number, dark = true) {
    // Paper & pine: keep the CodeMirror surface in lockstep with app.css.
    const bg = dark ? "#1B1A15" : "#F1EFE6";
    const fg = dark ? "#ECE7D8" : "#2B2A25";
    const muted = dark ? "#9C9686" : "#726F62";
    const overlay = dark ? "#2A2721" : "#EBE7D9";
    const accent = dark ? "#8FC7A9" : "#3F6656";
    return EditorView.theme({
      "&": {
        backgroundColor: bg,
        color: fg,
      },
      ".cm-content": {
        caretColor: accent,
        fontFamily: `'${font}', monospace`,
        fontSize: `${size}px`,
        lineHeight: `${lh}`,
        padding: "40px 0",
        maxWidth: "720px",
        margin: "0 auto",
      },
    ".cm-gutters": {
      backgroundColor: bg,
      color: muted,
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: overlay,
    },
    ".cm-activeLine": {
      backgroundColor: dark ? "#2A272160" : "#EBE7D980",
    },
    ".cm-selectionBackground": {
      backgroundColor: dark ? "#8FC7A930 !important" : "#3F665630 !important",
    },
    ".cm-cursor": {
      borderLeftColor: accent,
    },
    ".cm-focused .cm-selectionBackground": {
      backgroundColor: dark ? "#8FC7A940 !important" : "#3F665640 !important",
    },
    ".cm-autocorrect-suggest": {
      textDecoration: "underline wavy #d9a521 1px",
      textUnderlineOffset: "3px",
    },
    ".cm-focus-dimmed": {
      opacity: "0.35",
      transition: "opacity 0.3s ease",
    },
    // Find/replace panel: solid theme surfaces, never the default white.
    ".cm-panel.cm-search": {
      backgroundColor: overlay,
      color: fg,
      borderBottom: `1px solid ${muted}`,
      padding: "6px 8px",
    },
    ".cm-panel.cm-search input": {
      backgroundColor: bg,
      color: fg,
      border: `1px solid ${muted}`,
    },
    ".cm-panel.cm-search button": {
      backgroundColor: "transparent",
      color: fg,
      border: `1px solid ${muted}`,
    },
    ".cm-searchMatch": {
      backgroundColor: dark ? "#8FC7A940" : "#3F665640",
    },
    ".cm-searchMatch-selected": {
      backgroundColor: dark ? "#8FC7A980" : "#3F665680",
    },
  });
  }

  function createEditor(doc: any) {
    if (editorView) {
      editorView.destroy();
    }

    const content = doc?.content ?? "";
    const darkTheme = makeDarkTheme($settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.theme !== "light");

    // Snippet expansion plugin
    const snippetPlugin = ViewPlugin.fromClass(
      class {
        lastText = "";
        update(update: ViewUpdate) {
          if (!update.docChanged) return;
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
                update.view.dispatch({
                  changes: { from, to: pos, insert: expanded },
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
          // Paid for in package.json but never wired: find/replace (Ctrl+F).
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
        ]),
        markdown(),
        darkTheme,
        search({ top: true }),
        highlightSelectionMatches(),
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

  function handleContentChange(content: string) {
    if (!$currentDoc) return;

    recordSave();
    if (typewriterEnabled) {
      requestAnimationFrame(() => centerCursorIn(editorView, editorContainer));
    }

    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        const wordCount = content.split(/\s+/).filter(Boolean).length;
        await api.docSave($currentDoc!.id, undefined, content);
        $currentDoc = { ...$currentDoc!, word_count: wordCount };
        // Craft profiling + write heartbeat, at most once a minute per doc.
        // (Drives streaks, heatmaps, patterns, and the craft skill nudge.)
        const now = Date.now();
        if (now - lastMetricAt > 60000) {
          lastMetricAt = now;
          const docId = $currentDoc!.id;
          api.usageRecord(docId, "write").catch(() => {});
          api.memoryRecordMetric(docId, "filter_words", filterWordRatio(content)).catch(() => {});
        }
      } catch (e) {
        console.error("Failed to save:", e);
      }
    }, 500);

    if (flushTimeout) clearTimeout(flushTimeout);
    flushTimeout = setTimeout(async () => {
      try {
        await api.atomicSave($currentDoc!.id, content);
      } catch (e) {
        console.error("Failed to flush to disk:", e);
      }
    }, 5000);

    if ($settings.ghostEnabled && content.length > 20) {
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

    const suggestion = await requestGhostContinuation(lastSentence, {
      // Workspace travels too: private workspaces (e.g. Logs) stay local-only.
      workspace: $currentWorkspace,
      provider: $settings.smallModelEndpoint || undefined,
      model: $settings.smallModelName || undefined,
      apiKey: $settings.apiKey || undefined,
    });
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

  let exportFormats = $state<string[]>(["md", "txt", "html"]);
  let exportMenuLoaded = $state(false);

  /** Export what's on screen: flush live editor content, then convert. */
  async function exportAs(format: string) {
    if (!$currentDoc) return;
    showExportMenu = false;
    if (format === 'fountain') {
      const content = editorView?.state.doc.toString() ?? $currentDoc.content ?? '';
      const title = $currentDoc.title || 'untitled';
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title}.fountain`;
      a.click();
      URL.revokeObjectURL(url);
      markUsed('export');
      return;
    }
    try {
      const content = editorView?.state.doc.toString() ?? $currentDoc.content ?? '';
      await api.docSave($currentDoc.id, undefined, content);
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
        exportFormats = status.formats;
      } catch {
        exportFormats = ["md", "txt", "html"];
      }
      exportMenuLoaded = true;
    }
  }

  function closeExportOnOutside(e: MouseEvent) {
    if (!showExportMenu) return;
    if ((e.target as HTMLElement).closest?.(".export-wrapper")) return;
    showExportMenu = false;
  }

  function exportLabel(format: string): string {
    switch (format) {
      case 'md': return 'Markdown (.md)';
      case 'txt': return 'Plain Text (.txt)';
      case 'html': return 'HTML (.html)';
      case 'docx': return 'Word (.docx)';
      case 'epub': return 'eBook (.epub)';
      case 'pdf': return 'PDF (.pdf)';
      default: return format;
    }
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
      loadCraftMetrics(doc.id);
    } else {
      refreshBibleWords(null);
    }
  });

  // Rebuild the editor live when theme or type settings change.
  // Same untrack rule: the rebuild must not resubscribe to what it rewrites.
  $effect(() => {
    void [$settings.theme, $settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.autocorrectEnabled, $settings.dictionaryLanguage];
    untrack(() => {
      if (editorView && editorContainer && $currentDoc) createEditor($currentDoc);
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

  async function loadCraftMetrics(docId: string) {
    try {
      const [d, s] = await Promise.all([
        api.craftMetricsTrend(docId, "dialogue_ratio"),
        api.craftMetricsTrend(docId, "avg_sentence_length"),
      ]);
      dialogueTrend = d;
      sentenceTrend = s;
    } catch {}
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
        <button class="craft-toggle icon-btn" class:active={showCraft} onclick={() => showCraft = !showCraft} title="Craft metrics" aria-label="Toggle craft metrics">
          <Icon name="chart" size={15} />
        </button>
        <div class="export-wrapper">
          <button class="export-btn icon-btn" onclick={toggleExportMenu} title="Export document" aria-label="Export document">
            <Icon name="download" size={15} />
          </button>
          {#if showExportMenu}
            <div class="export-menu" role="menu" aria-label="Export formats">
              {#each exportFormats as fmt}
                <button onclick={() => exportAs(fmt)} title="Export as {exportLabel(fmt)}">{exportLabel(fmt)}</button>
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
  {#if showCraft}
    <div class="craft-panel">
      <div class="craft-charts">
        <TrendlineChart data={dialogueTrend} label="Dialogue Ratio" />
        <TrendlineChart data={sentenceTrend} label="Avg Sentence Length" color="#6e8efb" />
      </div>
    </div>
  {/if}
  <FormatToolbar view={editorView} />
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
          onclick={() => handleSlashInsert(cmd.insert)}
        >
          <span class="slash-icon">{cmd.icon}</span>
          <span class="slash-label">{cmd.label}</span>
        </button>
      {/each}
    </div>
  {/if}

  <WikilinkPreview bind:visible={previewVisible} bind:position={previewPos} bind:docId={previewDocId} bind:docTitle={previewDocTitle} />
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
