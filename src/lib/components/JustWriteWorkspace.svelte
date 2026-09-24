<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap } from "@codemirror/view";
  import { Compartment, EditorState } from "@codemirror/state";
  import { ghostField, ghostInlinePlugin, setGhostEffect } from "$lib/ghostWidget";
  import { AUTOCORRECT_WAVY, editorPalette } from "$lib/editorTheme";
  import { basicSetup } from "codemirror";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
  import { markdown } from "@codemirror/lang-markdown";
  import { aiPanelOpen, currentDoc, currentWorkspace, inspectorOpen, openTabs, structurizePreset } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import { api, type Doc } from "$lib/api";
  import { createAutocorrectPlugin, loadBibleWords } from "$lib/autocorrectPlugin";
  import { assertAiAllowedForDoc } from "$lib/stores/lock";
  import { lastSentenceOf, requestGhostContinuation } from "$lib/ghost";
  import { showToast } from "$lib/stores/notifications";
import MicButton from "./MicButton.svelte";
import ReadAloudButton from "./ReadAloudButton.svelte";
import VersionHistory from "./VersionHistory.svelte";
  import FormatToolbar from "./FormatToolbar.svelte";
  import Icon from "./Icon.svelte";
  import { craftStats } from "$lib/browserBackend";
  import { centerCursorIn, focusDimmingPlugin, loadFocusPrefs, saveFocusPrefs } from "$lib/editorFocus";
  import { applyWriteBackEvent, writeBack } from "$lib/stores/writeBack";
  import { splitTarget } from "$lib/stores/split";
  import { markUsed } from "$lib/features";
  import { scheduleStoryMemory } from "$lib/storyMemory";
  import { createStoryMemoryExtension, setStoryMemoryData, type StoryMemoryData, type StoryMemoryView } from "$lib/storyMemoryEditor";
  import StoryMemoryHoverCard from "./StoryMemoryHoverCard.svelte";
 import { countWords } from "$lib/text";

  let editorContainer = $state<HTMLDivElement>();
  // $state.raw: the CodeMirror view is an opaque handle (never deep-read by
  // the template). Deep-proxying it makes Svelte traverse the whole editor
  // graph on every assignment — a busy-loop that starves timers.
  let editorView = $state.raw<EditorView | null>(null);
  let saveTimeout = $state<ReturnType<typeof setTimeout> | null>(null);
  let typewriterEnabled = $state($settings.typewriterDefault);
  let focusDimming = $state($settings.focusDimmingDefault);
  let sessionStartTime = $state(Date.now());
  let sessionWords = $state(0);
  let elapsed = $state("00:00:00");
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let lastMetricAt = 0;

  // Split editor: second doc side-by-side (session-only working state).
  // The primary pane keeps the full power (ghost/slash/mic); the split
  // pane is a clean second edit surface with the same theme + autosave.
  let splitDoc = $state<Doc | null>(null);
  let splitDocId = $state<string | null>(null);
  let splitContainer = $state<HTMLDivElement>();
  let splitView = $state.raw<EditorView | null>(null);
  let splitSaveTimeout: ReturnType<typeof setTimeout> | null = null;
  let splitWords = $state(0);

  // Ghost autocomplete (same board behavior as the main editor; longer
  // pause per spec — Just Write must never interrupt active typing).
  // Rendered INLINE at the cursor (Copilot-style greyed text), not as a
  // detached popup: a StateField holds the text, a ViewPlugin draws the
  // widget at the live selection head so it tracks the cursor.
  let ghostSuggestion = $state("");
  let ghostVisible = $state(false);
  let ghostDebounce: ReturnType<typeof setTimeout> | null = null;
  let storyMemoryVisible = $state(false);
  let storyMemoryPosition = $state({ x: 0, y: 0 });
  let storyMemoryEntity = $state<StoryMemoryView | null>(null);
  let storyMemoryLoadToken = 0;
  let storyMemoryJumpToken = 0;


  // Appearance/behavior compartments: theme, focus-dimming, typewriter
  // margins, and autocorrect reconfigure IN PLACE via reconfigureAppearance().
  // Destroying the EditorView (createEditor) resets CodeMirror's history()
  // — so settings changes must never take the destroy path, or every
  // font-size tweak silently wipes the session's undo/redo stack.
  // Full destroy/recreate is reserved for DOCUMENT changes (new doc.id).
  let themeCompartment = new Compartment();
  let focusCompartment = new Compartment();
  let typewriterCompartment = new Compartment();
  let autocorrectCompartment = new Compartment();

  // Story Bible vocabulary for autocorrect's custom dictionary (A8.8).
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

  function handleStoryMemoryHover(view: StoryMemoryView | null, position: { x: number; y: number }) {
    storyMemoryEntity = view;
    storyMemoryPosition = position;
    storyMemoryVisible = !!view;
  }

  async function refreshStoryMemory(doc: Doc | null): Promise<void> {
    const loadToken = ++storyMemoryLoadToken;
    if (!doc) {
      setStoryMemoryData(editorView, null);
      storyMemoryVisible = false;
      return;
    }
    try {
      const scopeId = await api.bibleScopeId(doc.id);
      const [facts, mentions] = await Promise.all([api.bibleGetFacts(scopeId), api.bibleGetMentions(scopeId)]);
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
        window.dispatchEvent(new CustomEvent("editor-scroll-to-text", { detail: { snippet: mention.snippet, spanStart: mention.span_start } }));
      }, 80);
    } catch (e) {
      showToast(`Couldn't open appearance: ${e instanceof Error ? e.message : e}`, "error");
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
    // Provider routing is fixed inside ghost.ts (local :8093 if enabled,
    // else the small slot) — callers only pass privacy metadata.
    const suggestion = await requestGhostContinuation(lastSentence, $currentWorkspace);
    if (suggestion) {
      ghostSuggestion = suggestion;
      ghostVisible = true;
      // Publish to the inline widget (no-op if the doc closed mid-flight).
      if (editorView) editorView.dispatch({ effects: setGhostEffect.of(suggestion) });
    }
  }

  function acceptGhost() {
    if (!ghostSuggestion || !editorView) return;
    const pos = editorView.state.selection.main.head;
    editorView.dispatch({
      changes: { from: pos, insert: ghostSuggestion },
      effects: setGhostEffect.of(null),
    });
    ghostSuggestion = "";
    ghostVisible = false;
    editorView.focus();
    markUsed("ghost");
  }

  function dismissGhost() {
    ghostSuggestion = "";
    ghostVisible = false;
    if (editorView) editorView.dispatch({ effects: setGhostEffect.of(null) });
  }

  // Slash commands (A11.7)
  let slashVisible = $state(false);
  let slashFilter = $state("");
  let slashPos = $state({ x: 0, y: 0 });
  let slashLineStart = $state(0);
  let slashSelectedIdx = $state(0);

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
    slashFilter
      ? slashCommands.filter(c => c.label.toLowerCase().includes(slashFilter.toLowerCase()))
      : slashCommands
  );

  function handleSlashInsert(insert: string, label?: string) {
    if (!editorView) return;
    const pos = slashLineStart;
    const line = editorView.state.doc.lineAt(pos);
    const cursorPos = editorView.state.selection.main.head;
    const filterLen = cursorPos - pos;
    if (label === "Structurize") {
      const { from, to } = editorView.state.selection.main;
      const selected = editorView.state.sliceDoc(from, to);
      structurizePreset.set(selected || null);
      $aiPanelOpen = true;
    } else {
      editorView.dispatch({ changes: { from: pos, to: pos + filterLen, insert } });
    }
    slashVisible = false;
    slashFilter = "";
    editorView.focus();
  }

  function handleSlashKeydown(e: KeyboardEvent) {
    if (!slashVisible) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx + 1) % slashFiltered.length; return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx - 1 + slashFiltered.length) % slashFiltered.length; return true; }
    if (e.key === "Enter") { e.preventDefault(); if (slashFiltered[slashSelectedIdx]) handleSlashInsert(slashFiltered[slashSelectedIdx].insert, slashFiltered[slashSelectedIdx].label); return true; }
    if (e.key === "Escape") { e.preventDefault(); slashVisible = false; return true; }
    return false;
  }

  function makeDarkTheme(font: string, size: number, lh: number, theme = "dark") {
    // Per-theme editor surface, in lockstep with app.css via the shared
    // palette (brutalist gets flat amber, glass translucent mint — never
    // dark's editor by default).
    const p = editorPalette(theme);
    return EditorView.theme({
      "&": {
        backgroundColor: p.bg,
        color: p.fg,
      },
      ".cm-content": {
        caretColor: p.accent,
        fontFamily: `'${font}', monospace`,
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
    ".cm-focus-dimmed": {
      opacity: "0.35",
      transition: "opacity 0.3s ease",
    },
    ".cm-autocorrect-suggest": {
      textDecoration: AUTOCORRECT_WAVY,
      textUnderlineOffset: "3px",
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

  function currentThemeExt() {
    return makeDarkTheme($settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.theme);
  }

  function currentAutocorrectExt() {
    return $settings.autocorrectEnabled
      ? createAutocorrectPlugin({
          enabled: () => $settings.autocorrectEnabled,
          useEnglishTable: () => $settings.dictionaryLanguage !== "off",
          getCustomWords: () => bibleWords,
        })
      : [];
  }

  function currentFocusExt() {
    return focusDimming ? focusDimmingPlugin(() => focusDimming) : [];
  }

  function currentTypewriterExt() {
    return typewriterEnabled
      ? EditorView.scrollMargins.of(() => ({ top: 200, bottom: 200 }))
      : [];
  }

  /**
   * Apply theme/font/autocorrect/focus/typewriter changes WITHOUT
   * destroying the view — history, cursor, and scroll position survive.
   */
  function reconfigureAppearance() {
    const effects = [
      themeCompartment.reconfigure(currentThemeExt()),
      focusCompartment.reconfigure(currentFocusExt()),
      typewriterCompartment.reconfigure(currentTypewriterExt()),
      autocorrectCompartment.reconfigure(currentAutocorrectExt()),
    ];
    if (editorView) editorView.dispatch({ effects });
    if (splitView) splitView.dispatch({ effects });
  }

  function createEditor(doc: any) {
    if (editorView) {
      editorView.destroy();
    }

    const content = doc?.content ?? "";
    const extensions = [
      basicSetup,
      markdown(),
      themeCompartment.of(currentThemeExt()),
       search({ top: true }),
       highlightSelectionMatches(),
       createStoryMemoryExtension({ onHover: handleStoryMemoryHover }),
       ghostField,
      ghostInlinePlugin(),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          handleContentChange(update.state.doc.toString());
          // Typing activity: lets the shell auto-hide chrome for focus.
          window.dispatchEvent(new CustomEvent("editor-typing"));
        }
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
        return false;
      }),
    ];

    extensions.push(focusCompartment.of(currentFocusExt()));
    extensions.push(typewriterCompartment.of(currentTypewriterExt()));

    extensions.push(
      keymap.of([
        // Find/replace (Ctrl+F) via @codemirror/search; panel themed below.
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
            const { from, to } = view.state.selection.main;
            const selected = view.state.sliceDoc(from, to);
            structurizePreset.set(selected || null);
            $aiPanelOpen = true;
            return true;
          },
        },
      ])
    );

    extensions.push(autocorrectCompartment.of(currentAutocorrectExt()));

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    editorView = new EditorView({
      state,
      parent: editorContainer,
    });

    if (typewriterEnabled && editorView) {
      centerCursorIn(editorView, editorContainer);
    }
  }

  let saveQueue: Promise<void> = Promise.resolve();

  function queueDocSave(editingDocId: string, content: string) {
    saveQueue = saveQueue.then(async () => {
      try {
        const updated = await api.docSave(editingDocId, undefined, content);
        if ($currentDoc?.id === editingDocId) $currentDoc = { ...$currentDoc, word_count: updated.word_count };
        scheduleStoryMemory(updated, content);
        const now = Date.now();
        if (now - lastMetricAt > 60000) {
          lastMetricAt = now;
          api.usageRecord(editingDocId, "write").catch(() => {});
          if ($settings.craftProfilingEnabled) {
            const stats = craftStats(content);
            api.memoryRecordMetric(editingDocId, "filter_words", stats.filterWords).catch(() => {});
            api.memoryRecordMetric(editingDocId, "dialogue_ratio", stats.dialogue).catch(() => {});
            api.memoryRecordMetric(editingDocId, "avg_sentence_length", stats.avgSentence).catch(() => {});
          }
        }
      } catch (e) {
        console.error("Failed to save:", e);
      }
    });
  }

  function handleContentChange(content: string) {
    if (!$currentDoc) return;
    const editingDocId = $currentDoc.id;
    const words = countWords(content);
    sessionWords = words;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => queueDocSave(editingDocId, content), 500);
    if (typewriterEnabled) {
      requestAnimationFrame(() => centerCursorIn(editorView, editorContainer));
    }
    // Ghost waits for a real pause here (3s) — flow comes first.
    // The doc-id guard stops a stale timer from publishing one doc's
    // suggestion into another doc opened within the pause window.
    if ($settings.ghostEnabled && content.length > 20) {
      if (ghostDebounce) clearTimeout(ghostDebounce);
      const docId = $currentDoc?.id;
      ghostDebounce = setTimeout(() => {
        if ($currentDoc?.id === docId) requestGhostSuggestion(content);
      }, 3000);
    } else if (ghostVisible) {
      dismissGhost();
    }
  }

  function toggleTypewriter() {
    typewriterEnabled = !typewriterEnabled;
    if ($currentDoc) {
      saveFocusPrefs($currentDoc.id, {
        typewriter: typewriterEnabled,
        focus: focusDimming,
      });
    }
    // Reconfigure in place: keeps undo history, cursor, and scroll.
    reconfigureAppearance();
    if (typewriterEnabled && editorView) {
      centerCursorIn(editorView, editorContainer);
    }
  }

  function toggleFocusDimming() {
    focusDimming = !focusDimming;
    if ($currentDoc) {
      saveFocusPrefs($currentDoc.id, {
        typewriter: typewriterEnabled,
        focus: focusDimming,
      });
    }
    // Reconfigure in place: keeps undo history, cursor, and scroll.
    reconfigureAppearance();
  }

  function openSplit(id: string) {
    if (!id || id === $currentDoc?.id) return;
    splitDocId = id;
  }

  function closeSplit() {
    if (splitView) {
      splitView.destroy();
      splitView = null;
    }
    if (splitSaveTimeout) clearTimeout(splitSaveTimeout);
    splitDocId = null;
    splitDoc = null;
    splitTarget.set(null);
  }

  /** Swap panes: the split doc becomes primary and vice versa. */
  function swapSplit() {
    const primary = $currentDoc;
    const secondary = splitDoc;
    if (!primary || !secondary) return;
    splitDocId = primary.id;
    splitTarget.set({ id: primary.id, title: primary.title });
    $currentDoc = secondary;
    if (!$openTabs.find((t) => t.id === secondary.id)) $openTabs = [secondary, ...$openTabs];
  }

  function createSplitEditor(doc: Doc) {
    if (splitView) {
      splitView.destroy();
    }
    const docId = doc.id;
    const state = EditorState.create({
      doc: doc.content ?? "",
      extensions: [
        basicSetup,
        markdown(),
        themeCompartment.of(currentThemeExt()),
        search({ top: true }),
        highlightSelectionMatches(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            handleSplitChange(docId, update.state.doc.toString());
          }
          return false;
        }),
        focusCompartment.of(currentFocusExt()),
        typewriterCompartment.of(currentTypewriterExt()),
        keymap.of([
          // Find/replace, same as every other edit surface (Ctrl+F).
          ...searchKeymap,
          {
            // Same timestamp shortcut as the primary pane (§4.1).
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
              const { from, to } = view.state.selection.main;
              const selected = view.state.sliceDoc(from, to);
              structurizePreset.set(selected || null);
              $aiPanelOpen = true;
              return true;
            },
          },
        ]),
        autocorrectCompartment.of(currentAutocorrectExt()),
      ],
    });

    splitView = new EditorView({
      state,
      parent: splitContainer,
    });
    splitWords = doc.word_count;
  }

  function handleSplitChange(docId: string, content: string) {
    const words = countWords(content);
    if (splitDoc?.id === docId) splitWords = words;
    if (splitSaveTimeout) clearTimeout(splitSaveTimeout);
     splitSaveTimeout = setTimeout(() => {
       saveQueue = saveQueue.then(async () => {
         try {
           const updated = await api.docSave(docId, undefined, content);
           scheduleStoryMemory(updated, content);
           if (splitDoc?.id === docId) {
             splitDoc = { ...splitDoc, word_count: words };
           }
           $openTabs = $openTabs.map((t) => (t.id === docId ? { ...t, word_count: words } : t));
         } catch (e) {
           console.error("Failed to save split doc:", e);
         }
       });
     }, 500);
  }

  /** Drop/paste files as vault attachments (A8.9), same as the main editor. */
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

  function updateElapsed() {
    const diff = Date.now() - sessionStartTime;
    const h = Math.floor(diff / 3600000);
    const m = Math.floor((diff % 3600000) / 60000);
    const s = Math.floor((diff % 60000) / 1000);
    elapsed = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // Id of the doc the live EditorView was built for. The effect below
  // re-fires on EVERY $currentDoc assignment — including the autosave
  // metadata refresh ({...doc, word_count}) that handleContentChange does
  // ~500ms after each pause in typing. Rebuilding there destroys the view
  // mid-session (losing undo history AND visibly snapping back to stale
  // store content, discarding what was just typed). Only a NEW doc id —
  // or first mount — may take the destroy/recreate path.
  let openDocId: string | null = null;

  $effect(() => {
    // Triggers: open doc or container mount ONLY. createEditor reads AND
    // writes editorView (destroy-guard + assign) — running it tracked would
    // resubscribe to editorView and re-fire this effect forever (busy-loop
    // that rebuilds the whole editor and starves timers).
    const doc = $currentDoc;
    if (doc && editorContainer) {
      untrack(() => {
        if (openDocId !== doc.id) {
          openDocId = doc.id;
          const prefs = loadFocusPrefs(doc.id, {
            typewriter: $settings.typewriterDefault,
            focus: $settings.focusDimmingDefault,
          });
          typewriterEnabled = prefs.typewriter;
          focusDimming = prefs.focus;
          createEditor(doc);
          // A pending suggestion belongs to the previous doc — never let
          // it render (or Tab-accept) into the newly opened one.
          if (ghostDebounce) clearTimeout(ghostDebounce);
           dismissGhost();
           refreshBibleWords(doc);
           refreshStoryMemory(doc);
           sessionStartTime = Date.now();
          sessionWords = doc.word_count;
        }
      });
    } else {
      untrack(() => {
        openDocId = null;
       });
       refreshBibleWords(null);
       refreshStoryMemory(null);
     }
   });

  // Apply theme/type changes live WITHOUT rebuilding: reconfigure keeps
  // document history, cursor, and scroll position (a full rebuild would
  // silently wipe the session's undo/redo stack on every font-size tweak).
  // Same untrack rule: the reconfigure must not resubscribe to what it rewrites.
  $effect(() => {
    void [$settings.theme, $settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.autocorrectEnabled, $settings.dictionaryLanguage];
    untrack(() => {
      reconfigureAppearance();
    });
  });

  // Split doc loading: container mount + id change ONLY (same busy-loop
  // guard as the primary pane — never track what this effect rewrites).
  $effect(() => {
    const id = splitDocId;
    const ready = !!splitContainer;
    if (id && ready) {
      untrack(() => {
        api.docGet(id)
          .then((d) => {
            if (splitDocId !== id) return;
            splitDoc = d;
            splitTarget.set({ id: d.id, title: d.title });
            createSplitEditor(d);
          })
          .catch(() => {
            if (splitDocId === id) {
              splitDocId = null;
              splitDoc = null;
              splitTarget.set(null);
            }
          });
      });
    }
  });

  // The split pane never edits the open doc: if the primary catches up
  // to the split id (tab switch), the split closes instead of forking.
  $effect(() => {
    if (splitDocId && $currentDoc && splitDocId === $currentDoc.id) closeSplit();
  });

  // AI write-back lands here exactly like the main editor (same board).
  // Either pane may own the event; only an event targeting neither open
  // doc is stale and cleared.
  $effect(() => {
    const event = $writeBack;
    if (!event || !editorView) return;
    if (!event.docId || (event.docId !== $currentDoc?.id && event.docId !== splitDoc?.id)) {
      writeBack.clear();
      return;
    }
    if (event.docId !== $currentDoc?.id) return;
    applyWriteBackEvent(editorView, event);
    writeBack.clear();
  });

  // Split-pane write-back: same shared applier, own doc id.
  $effect(() => {
    const event = $writeBack;
    if (!event || !splitView) return;
    if (event.docId && splitDoc && event.docId === splitDoc.id) {
      applyWriteBackEvent(splitView, event);
      writeBack.clear();
    }
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
      if (pos < 0 || pos > editorView.state.doc.length) pos = editorView.state.doc.toString().indexOf(String(detail.snippet ?? ""));
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

  onMount(() => {
    timerInterval = setInterval(updateElapsed, 1000);
  });

  onDestroy(() => {
    // Session-end recap (A7.5): show once when closing Just Write session
    if (elapsed !== "00:00:00" && sessionWords > 0) {
      const diff = Date.now() - sessionStartTime;
      const mins = Math.floor(diff / 60000);
      const timeStr = mins > 0 ? `${mins} min` : `${Math.floor(diff / 1000)} sec`;
      showToast(`${sessionWords.toLocaleString()} words in ${timeStr}`, "info");
    }
    if (editorView) editorView.destroy();
    if (splitView) splitView.destroy();
    splitTarget.set(null);
    if (saveTimeout) clearTimeout(saveTimeout);
    if (splitSaveTimeout) clearTimeout(splitSaveTimeout);
    if (timerInterval) clearInterval(timerInterval);
    if (ghostDebounce) clearTimeout(ghostDebounce);
  });
</script>

<div class="just-write-workspace">
  <div class="write-toolbar">
    <div class="toolbar-left">
      <button class="toolbar-btn icon-btn" class:active={typewriterEnabled} onclick={toggleTypewriter} title="Typewriter mode" aria-label="Toggle typewriter mode">
        <Icon name="pencil" size={15} />
      </button>
      <button class="toolbar-btn icon-btn" class:active={focusDimming} onclick={toggleFocusDimming} title="Focus dimming" aria-label="Toggle focus dimming">
        <Icon name="eye" size={15} />
      </button>
      <button class="toolbar-btn icon-btn" class:active={$aiPanelOpen} onclick={() => $aiPanelOpen = !$aiPanelOpen} title="AI panel (Ctrl+J)" aria-label="Toggle AI panel">
        <Icon name="sparkle" size={15} />
      </button>
      <button class="toolbar-btn icon-btn" class:active={$inspectorOpen} onclick={() => $inspectorOpen = !$inspectorOpen} title="Outline & links (Ctrl+I)" aria-label="Toggle inspector">
        <Icon name="panel" size={15} />
      </button>
      <button
        class="toolbar-btn icon-btn"
        class:active={!!splitDocId}
        onclick={() => {
          if (splitDocId) {
            closeSplit();
          } else {
            const candidate = $openTabs.find((t) => t.id !== $currentDoc?.id);
            if (candidate) openSplit(candidate.id);
            else showToast("Open another tab first, then split", "info");
          }
        }}
        title="Split editor side-by-side"
        aria-label="Toggle split editor"
        aria-pressed={!!splitDocId}
      >
        <Icon name="board" size={15} />
      </button>
      {#if splitDocId}
        <select
          class="split-picker"
          value={splitDocId}
          onchange={(e) => openSplit((e.target as HTMLSelectElement).value)}
          title="Split document"
          aria-label="Split document"
        >
          {#each $openTabs.filter((t) => t.id !== $currentDoc?.id) as t}
            <option value={t.id}>{t.title}</option>
          {/each}
        </select>
      {/if}
      <VersionHistory />
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
    <div class="toolbar-right">
      <span class="session-timer">{elapsed}</span>
      <span class="session-words">{sessionWords.toLocaleString()} words</span>
      {#if $currentDoc?.goal_words}
        {@const goalPct = Math.min(100, Math.round((sessionWords / $currentDoc.goal_words) * 100))}
        <span
          class="goal-progress"
          class:done={goalPct >= 100}
          title="Goal: {$currentDoc.goal_words.toLocaleString()} words{$currentDoc.deadline ? ` by ${$currentDoc.deadline.slice(0, 10)}` : ''}"
        >
          <span class="goal-bar"><span class="goal-fill" style="width: {goalPct}%"></span></span>
          <span class="goal-text">{goalPct}%</span>
        </span>
      {/if}
    </div>
  </div>

  <FormatToolbar view={editorView} />

  <div class="split-wrap" class:split-on={!!splitDocId}>
    <div class="split-pane">
      <!-- svelte-ignore a11y_no_noninteractive_element_interactions: composite editor widget — keydown only drives the slash menu (arrows/Enter/Escape, no-op otherwise); all actions are buttons/inputs. -->
      <div class="editor-container" bind:this={editorContainer} onkeydown={handleSlashKeydown} ondrop={handleFileDrop} onpaste={handlePaste} ondragover={(e) => e.preventDefault()} role="application"></div>
    </div>
    {#if splitDocId}
      <div class="split-pane split-second">
        <div class="split-header">
          <span class="split-title" title={splitDoc?.title ?? "Loading…"}>{splitDoc?.title ?? "Loading…"}</span>
          <span class="split-words">{splitWords.toLocaleString()} words</span>
          <button class="icon-btn split-swap" onclick={swapSplit} title="Swap panes" aria-label="Swap panes">
            <Icon name="arrow-left" size={14} />
          </button>
          <button class="icon-btn split-close" onclick={closeSplit} title="Close split" aria-label="Close split">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div class="editor-container" bind:this={splitContainer} role="application" aria-label="Split editor"></div>
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
  <StoryMemoryHoverCard bind:visible={storyMemoryVisible} bind:position={storyMemoryPosition} bind:entity={storyMemoryEntity} onJump={jumpToStoryMemoryMention} />
</div>

<style>
  .just-write-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .write-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-secondary);
    flex-shrink: 0;
  }

  .toolbar-left, .toolbar-right {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .toolbar-btn {
    width: 30px;
    height: 30px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 14px;
    color: var(--text-muted);
  }

  .toolbar-btn:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .toolbar-btn.active {
    background: var(--bg-active);
    color: var(--accent);
  }

  .session-timer {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
  }

  .session-words {
    font-size: 12px;
    color: var(--text-muted);
  }

  .goal-progress {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .goal-bar {
    width: 90px;
    height: 6px;
    border-radius: 3px;
    background: var(--surface-overlay);
    overflow: hidden;
  }

  .goal-fill {
    display: block;
    height: 100%;
    background: var(--accent-primary);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .goal-progress.done .goal-fill {
    background: var(--accent-semantic-green);
  }

  .goal-text {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .goal-progress.done .goal-text {
    color: var(--accent-semantic-green);
    font-weight: 600;
  }

  .editor-container {
    flex: 1;
    min-height: 0;
    overflow: auto;
    position: relative;
  }

  .split-wrap {
    flex: 1;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .split-wrap.split-on {
    flex-direction: row;
  }

  .split-pane {
    flex: 1;
    min-width: 0;
    min-height: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .split-second {
    border-left: 1px solid var(--border-subtle);
  }

  .split-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 4px 12px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-base);
    flex-shrink: 0;
  }

  .split-title {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 12px;
    font-weight: 600;
  }

  .split-words {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .split-picker {
    height: 28px;
    font-size: 12px;
    max-width: 160px;
  }

  @media (max-width: 768px) {
    .split-wrap.split-on {
      flex-direction: column;
    }

    .split-second {
      border-left: none;
      border-top: 1px solid var(--border-subtle);
    }
  }

  /* Inline ghost autocomplete (rendered by CodeMirror at the cursor). */
  :global(.cm-ghost-inline) {
    opacity: 0.55;
    font-style: italic;
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
