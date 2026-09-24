<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import type { EditorView } from "@codemirror/view";
  import Icon from "$lib/components/Icon.svelte";
  import { settings } from "$lib/stores/settings";

  let { view }: { view: EditorView | null } = $props();

  // Visibility lives in settings (persisted, shared by every editor) so
  // the writing area stays dominant exactly how the writer left it.
  function setOpen(next: boolean) {
    $settings = { ...$settings, formatToolbarOpen: next };
  }

  function insertMarkdown(syntax: string, wrap = false) {
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);

    if (wrap && selected) {
      view.dispatch({
        changes: { from, to, insert: `${syntax}${selected}${syntax}` },
      });
    } else if (wrap) {
      view.dispatch({
        changes: { from, to, insert: `${syntax}${syntax}` },
        selection: { anchor: from + syntax.length },
      });
    } else {
      view.dispatch({
        changes: { from, to, insert: syntax },
      });
    }
    view.focus();
  }

  function insertAtLineStart(prefix: string) {
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: prefix },
    });
    view.focus();
  }

  function insertBlock(content: string) {
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    const insertAt = line.to;
    view.dispatch({
      changes: { from: insertAt, to: insertAt, insert: "\n\n" + content + "\n" },
      selection: { anchor: insertAt + content.length + 2 },
    });
    view.focus();
  }

  const textActions = [
    { label: "B", title: "Bold", action: () => insertMarkdown("**", true) },
    { label: "I", title: "Italic", action: () => insertMarkdown("*", true) },
    { label: "U", title: "Underline", action: () => insertMarkdown("__", true) },
    { label: "S", title: "Strikethrough", action: () => insertMarkdown("~~", true) },
    { label: "<>", title: "Inline code", action: () => insertMarkdown("`", true) },
  ];

  const structureActions = [
    { label: "H1", title: "Heading 1", action: () => insertAtLineStart("# ") },
    { label: "H2", title: "Heading 2", action: () => insertAtLineStart("## ") },
    { label: "H3", title: "Heading 3", action: () => insertAtLineStart("### ") },
    { label: "H4", title: "Heading 4", action: () => insertAtLineStart("#### ") },
    { label: "H5", title: "Heading 5", action: () => insertAtLineStart("##### ") },
    { label: "H6", title: "Heading 6", action: () => insertAtLineStart("###### ") },
    { label: ">", title: "Blockquote", action: () => insertAtLineStart("> ") },
    { label: "---", title: "Horizontal rule", action: () => insertBlock("---") },
  ];

  const listActions = [
    { label: "•", title: "Bullet list", action: () => insertAtLineStart("- ") },
    { label: "1.", title: "Numbered list", action: () => insertAtLineStart("1. ") },
    { label: "☐", title: "Checklist", action: () => insertAtLineStart("- [ ] ") },
  ];

  const insertActions = [
    { icon: "link", title: "Link", action: () => insertMarkdown("[text](url)") },
    { icon: "image", title: "Image", action: () => insertMarkdown("![alt](url)") },
    { icon: "table", title: "Table", action: () => insertBlock("| Col 1 | Col 2 |\n|-------|-------|\n|       |       |") },
    { label: "¹", title: "Footnote", action: () => insertBlock("[^1]: ") },
  ];

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape" && $settings.formatToolbarOpen) {
      setOpen(false);
      e.preventDefault();
    }
  }

  onMount(() => window.addEventListener("keydown", handleKeydown));
  onDestroy(() => window.removeEventListener("keydown", handleKeydown));
</script>

<div class="format-toolbar" class:expanded={$settings.formatToolbarOpen}>
  <button
    class="toolbar-toggle"
    onclick={() => setOpen(!$settings.formatToolbarOpen)}
    title={$settings.formatToolbarOpen ? "Hide formatting toolbar" : "Show formatting toolbar"}
    aria-label={$settings.formatToolbarOpen ? "Hide formatting toolbar" : "Show formatting toolbar"}
    aria-expanded={$settings.formatToolbarOpen}
  >
    <span class="toggle-icon">{$settings.formatToolbarOpen ? "✕" : "Aa"}</span>
  </button>

  {#if $settings.formatToolbarOpen}
    <div class="toolbar-clusters">
      <div class="cluster">
        <span class="cluster-label">Text</span>
        <div class="cluster-actions">
          {#each textActions as a}
            <button class="fmt-btn" title={a.title} aria-label={a.title} onclick={a.action}>{a.label}</button>
          {/each}
        </div>
      </div>

      <div class="cluster">
        <span class="cluster-label">Structure</span>
        <div class="cluster-actions">
          {#each structureActions as a}
            <button class="fmt-btn" title={a.title} aria-label={a.title} onclick={a.action}>{a.label}</button>
          {/each}
        </div>
      </div>

      <div class="cluster">
        <span class="cluster-label">Lists</span>
        <div class="cluster-actions">
          {#each listActions as a}
            <button class="fmt-btn" title={a.title} aria-label={a.title} onclick={a.action}>{a.label}</button>
          {/each}
        </div>
      </div>

      <div class="cluster">
        <span class="cluster-label">Insert</span>
        <div class="cluster-actions">
          {#each insertActions as a}
            <button class="fmt-btn" title={a.title} aria-label={a.title} onclick={a.action}>
              {#if a.icon}<Icon name={a.icon} size={14} />{:else}{a.label}{/if}
            </button>
          {/each}
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .format-toolbar {
    display: flex;
    align-items: center;
    gap: 0;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    flex-shrink: 0;
    min-height: 32px;
  }

  /* Formatting strip scrolls sideways on phones instead of clipping. */
  @media (max-width: 480px) {
    .format-toolbar {
      overflow-x: auto;
      scrollbar-width: none;
    }
    .format-toolbar::-webkit-scrollbar {
      display: none;
    }
  }

  .toolbar-toggle {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 600;
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .toolbar-toggle:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .toggle-icon {
    font-family: var(--font-mono);
  }

  .toolbar-clusters {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 2px 4px;
    overflow-x: auto;
  }

  .cluster {
    display: flex;
    align-items: center;
    gap: 1px;
  }

  .cluster-label {
    font-size: 9px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    padding: 0 4px;
    white-space: nowrap;
  }

  .cluster:not(:last-child)::after {
    content: "";
    display: block;
    width: 1px;
    height: 16px;
    background: var(--border-subtle);
    margin-left: 6px;
  }

  .cluster-actions {
    display: flex;
    gap: 1px;
  }

  .fmt-btn {
    width: 26px;
    height: 26px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  .fmt-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }
</style>
