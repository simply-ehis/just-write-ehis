<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { basicSetup } from "codemirror";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
  import { markdown } from "@codemirror/lang-markdown";
  import { aiPanelOpen, currentDoc, currentWorkspace, inspectorOpen, openTabs } from "$lib/stores/app";
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
  import { filterWordRatio } from "$lib/browserBackend";
  import { centerCursorIn, focusDimmingPlugin, loadFocusPrefs, saveFocusPrefs } from "$lib/editorFocus";
  import { applyWriteBackEvent, writeBack } from "$lib/stores/writeBack";
  import { splitTarget } from "$lib/stores/split";
  import { markUsed } from "$lib/features";

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
  let ghostSuggestion = $state("");
  let ghostVisible = $state(false);
  let ghostDebounce: ReturnType<typeof setTimeout> | null = null;

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
    ghostSuggestion = "";
    ghostVisible = false;
    editorView.focus();
    markUsed("ghost");
  }

  function dismissGhost() {
    ghostSuggestion = "";
    ghostVisible = false;
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
  ];

  let slashFiltered = $derived(
    slashFilter
      ? slashCommands.filter(c => c.label.toLowerCase().includes(slashFilter.toLowerCase()))
      : slashCommands
  );

  function handleSlashInsert(insert: string) {
    if (!editorView) return;
    const pos = slashLineStart;
    const line = editorView.state.doc.lineAt(pos);
    const cursorPos = editorView.state.selection.main.head;
    const filterLen = cursorPos - pos;
    editorView.dispatch({ changes: { from: pos, to: pos + filterLen, insert } });
    slashVisible = false;
    slashFilter = "";
    editorView.focus();
  }

  function handleSlashKeydown(e: KeyboardEvent) {
    if (!slashVisible) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx + 1) % slashFiltered.length; return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashSelectedIdx = (slashSelectedIdx - 1 + slashFiltered.length) % slashFiltered.length; return true; }
    if (e.key === "Enter") { e.preventDefault(); if (slashFiltered[slashSelectedIdx]) handleSlashInsert(slashFiltered[slashSelectedIdx].insert); return true; }
    if (e.key === "Escape") { e.preventDefault(); slashVisible = false; return true; }
    return false;
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
    ".cm-focus-dimmed": {
      opacity: "0.35",
      transition: "opacity 0.3s ease",
    },
    ".cm-autocorrect-suggest": {
      textDecoration: "underline wavy #d9a521 1px",
      textUnderlineOffset: "3px",
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
    const extensions = [
      basicSetup,
      markdown(),
      darkTheme,
      search({ top: true }),
      highlightSelectionMatches(),
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

    if (focusDimming) {
      extensions.push(focusDimmingPlugin(() => focusDimming));
    }

    if (typewriterEnabled) {
      extensions.push(
        EditorView.scrollMargins.of(() => ({ top: 200, bottom: 200 }))
      );
    }

    extensions.push(
      keymap.of([
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
      ])
    );

    if ($settings.autocorrectEnabled) {
      extensions.push(
        createAutocorrectPlugin({
          enabled: () => $settings.autocorrectEnabled,
          useEnglishTable: () => $settings.dictionaryLanguage !== "off",
          getCustomWords: () => bibleWords,
        })
      );
    }

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

  function handleContentChange(content: string) {
    if (!$currentDoc) return;
    const words = content.split(/\s+/).filter(Boolean).length;
    sessionWords = words;
    if (saveTimeout) clearTimeout(saveTimeout);
    saveTimeout = setTimeout(async () => {
      try {
        await api.docSave($currentDoc!.id, undefined, content);
        $currentDoc = { ...$currentDoc!, word_count: words };
        // Same craft/write heartbeat as the main editor (at most 1/min).
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
    if (typewriterEnabled) {
      requestAnimationFrame(() => centerCursorIn(editorView, editorContainer));
    }
    // Ghost waits for a real pause here (3s) — flow comes first.
    if ($settings.ghostEnabled && content.length > 20) {
      if (ghostDebounce) clearTimeout(ghostDebounce);
      ghostDebounce = setTimeout(() => requestGhostSuggestion(content), 3000);
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
    if (editorView) {
      createEditor($currentDoc);
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
    if (editorView) {
      createEditor($currentDoc);
    }
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
    const darkTheme = makeDarkTheme($settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.theme !== "light");
    const docId = doc.id;
    const state = EditorState.create({
      doc: doc.content ?? "",
      extensions: [
        basicSetup,
        markdown(),
        darkTheme,
        search({ top: true }),
        highlightSelectionMatches(),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            handleSplitChange(docId, update.state.doc.toString());
          }
          return false;
        }),
        ...(focusDimming ? [focusDimmingPlugin(() => focusDimming)] : []),
        ...(typewriterEnabled
          ? [EditorView.scrollMargins.of(() => ({ top: 200, bottom: 200 }))]
          : []),
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
        ]),
        ...($settings.autocorrectEnabled
          ? [
              createAutocorrectPlugin({
                enabled: () => $settings.autocorrectEnabled,
                useEnglishTable: () => $settings.dictionaryLanguage !== "off",
                getCustomWords: () => bibleWords,
              }),
            ]
          : []),
      ],
    });

    splitView = new EditorView({
      state,
      parent: splitContainer,
    });
    splitWords = doc.word_count;
  }

  function handleSplitChange(docId: string, content: string) {
    const words = content.split(/\s+/).filter(Boolean).length;
    if (splitDoc?.id === docId) splitWords = words;
    if (splitSaveTimeout) clearTimeout(splitSaveTimeout);
    splitSaveTimeout = setTimeout(async () => {
      try {
        await api.docSave(docId, undefined, content);
        if (splitDoc?.id === docId) {
          splitDoc = { ...splitDoc, word_count: words };
        }
        $openTabs = $openTabs.map((t) => (t.id === docId ? { ...t, word_count: words } : t));
      } catch (e) {
        console.error("Failed to save split doc:", e);
      }
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
      sessionStartTime = Date.now();
      sessionWords = doc.word_count;
    } else {
      refreshBibleWords(null);
    }
  });

  // Rebuild the editor live on theme/type changes (without resetting the session).
  // Same untrack rule: the rebuild must not resubscribe to what it rewrites.
  $effect(() => {
    void [$settings.theme, $settings.fontFamily, $settings.fontSize, $settings.lineHeight, $settings.autocorrectEnabled, $settings.dictionaryLanguage];
    untrack(() => {
      if (editorView && editorContainer && $currentDoc) createEditor($currentDoc);
      if (splitView && splitContainer && splitDoc) createSplitEditor(splitDoc);
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
      <div class="editor-container" bind:this={editorContainer} onkeydown={handleSlashKeydown} ondrop={handleFileDrop} onpaste={handlePaste} ondragover={(e) => e.preventDefault()} role="application">
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
          onclick={() => handleSlashInsert(cmd.insert)}
        >
          <span class="slash-icon">{cmd.icon}</span>
          <span class="slash-label">{cmd.label}</span>
        </button>
      {/each}
    </div>
  {/if}
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
