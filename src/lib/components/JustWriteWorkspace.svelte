<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightSpecialChars, Decoration, ViewPlugin, ViewUpdate } from "@codemirror/view";
  import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
  import { basicSetup } from "codemirror";
  import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
  import { markdown } from "@codemirror/lang-markdown";
  import { aiPanelOpen, currentDoc, currentWorkspace } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import { api } from "$lib/api";
  import { assertAiAllowedForDoc } from "$lib/stores/lock";
  import { lastSentenceOf, requestGhostContinuation } from "$lib/ghost";
  import { showToast } from "$lib/stores/notifications";
import MicButton from "./MicButton.svelte";
import ReadAloudButton from "./ReadAloudButton.svelte";
import VersionHistory from "./VersionHistory.svelte";
  import FormatToolbar from "./FormatToolbar.svelte";
  import Icon from "./Icon.svelte";
  import { filterWordRatio } from "$lib/browserBackend";
  import { applyWriteBackEvent, writeBack } from "$lib/stores/writeBack";
  import { markUsed } from "$lib/features";

  let editorContainer = $state<HTMLDivElement>();
  // $state.raw: the CodeMirror view is an opaque handle (never deep-read by
  // the template). Deep-proxying it makes Svelte traverse the whole editor
  // graph on every assignment — a busy-loop that starves timers.
  let editorView = $state.raw<EditorView | null>(null);
  let saveTimeout = $state<ReturnType<typeof setTimeout> | null>(null);
  let typewriterEnabled = $state(true);
  let focusDimming = $state(true);
  let sessionStartTime = $state(Date.now());
  let sessionWords = $state(0);
  let elapsed = $state("00:00:00");
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let lastMetricAt = 0;

  // Ghost autocomplete (same board behavior as the main editor; longer
  // pause per spec — Just Write must never interrupt active typing).
  let ghostSuggestion = $state("");
  let ghostVisible = $state(false);
  let ghostDebounce: ReturnType<typeof setTimeout> | null = null;

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

  const focusMark = Decoration.mark({ class: "cm-focus-dimmed" });

  function focusDimmingPlugin() {
    return ViewPlugin.fromClass(
      class {
        decorations: RangeSet<Decoration>;
        constructor(view: EditorView) {
          this.decorations = this.computeDecorations(view);
        }
        update(update: ViewUpdate) {
          if (update.docChanged || update.selectionSet) {
            this.decorations = this.computeDecorations(update.view);
          }
        }
        computeDecorations(view: EditorView): RangeSet<Decoration> {
          if (!focusDimming) return RangeSet.empty;
          const selection = view.state.selection.main;
          const doc = view.state.doc;
          const builder: { from: number; to: number; value: Decoration }[] = [];
          const contextLines = 2;
          const focusStart = Math.max(0, selection.from - contextLines * 100);
          const focusEnd = Math.min(doc.length, selection.to + contextLines * 100);
          if (focusStart > 0) {
            builder.push({ from: 0, to: focusStart, value: focusMark });
          }
          if (focusEnd < doc.length) {
            builder.push({ from: focusEnd, to: doc.length, value: focusMark });
          }
          return RangeSet.of(builder);
        }
      },
      { decorations: (v) => v.decorations }
    );
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
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          handleContentChange(update.state.doc.toString());
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
      extensions.push(focusDimmingPlugin());
    }

    if (typewriterEnabled) {
      extensions.push(
        EditorView.scrollMargins.of(() => ({ top: 200, bottom: 200 }))
      );
    }

    extensions.push(
      keymap.of([
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
      ])
    );

    const state = EditorState.create({
      doc: content,
      extensions,
    });

    editorView = new EditorView({
      state,
      parent: editorContainer,
    });

    if (typewriterEnabled && editorView) {
      centerCursor();
    }
  }

  function centerCursor() {
    if (!editorView || !editorContainer) return;
    const pos = editorView.state.selection.main.head;
    const coords = editorView.coordsAtPos(pos);
    if (coords) {
      const containerRect = editorContainer.getBoundingClientRect();
      const targetY = containerRect.height / 2;
      const currentY = coords.top - containerRect.top;
      const scrollDiff = currentY - targetY;
      editorContainer.scrollBy({ top: scrollDiff, behavior: "smooth" });
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
      requestAnimationFrame(() => centerCursor());
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
    if (editorView) {
      createEditor($currentDoc);
    }
  }

  function toggleFocusDimming() {
    focusDimming = !focusDimming;
    if (editorView) {
      createEditor($currentDoc);
    }
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
      untrack(() => createEditor(doc));
      sessionStartTime = Date.now();
      sessionWords = doc.word_count;
    }
  });

  // Rebuild the editor live on theme/type changes (without resetting the session).
  // Same untrack rule: the rebuild must not resubscribe to what it rewrites.
  $effect(() => {
    void [$settings.theme, $settings.fontFamily, $settings.fontSize, $settings.lineHeight];
    untrack(() => {
      if (editorView && editorContainer && $currentDoc) createEditor($currentDoc);
    });
  });

  // AI write-back lands here exactly like the main editor (same board).
  $effect(() => {
    const event = $writeBack;
    if (!event || !editorView) return;
    if (!event.docId || event.docId !== $currentDoc?.id) {
      writeBack.clear();
      return;
    }
    applyWriteBackEvent(editorView, event);
    writeBack.clear();
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
    if (saveTimeout) clearTimeout(saveTimeout);
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
    </div>
  </div>

  <FormatToolbar view={editorView} />

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

  .editor-container {
    flex: 1;
    overflow: auto;
    position: relative;
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
