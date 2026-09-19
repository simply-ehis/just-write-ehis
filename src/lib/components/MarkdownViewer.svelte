<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { markdown } from "@codemirror/lang-markdown";
  import { api } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";

  let { filePath, onClose }: { filePath: string; onClose?: () => void } = $props();

  let container = $state<HTMLDivElement>();
  // $state.raw: the CodeMirror view is an opaque handle. Deep-proxying it
  // makes Svelte traverse the whole editor graph on assignment (see
  // JustWriteWorkspace — the same pattern busy-loops and starves timers).
  let editorView = $state.raw<EditorView | null>(null);
  let content = $state("");
  let loading = $state(true);
  // Plain .md/.txt files browsed via Files are readable AND editable here
  // (A9.0: Reader covers raw-text files) — edit mode is opt-in per file.
  let editing = $state(false);
  let saving = $state(false);

  function downloadFile() {
    const name = filePath.split(/[/\\]/).pop() ?? "document.md";
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function copyContent() {
    try {
      await navigator.clipboard.writeText(content);
    } catch {
      /* clipboard unavailable: selection copy still works */
    }
  }

  function buildEditor(text: string, editable: boolean) {
    if (editorView) editorView.destroy();
    editorView = null;
    if (!container) return;
    const state = EditorState.create({
      doc: text,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        markdown(),
        EditorState.readOnly.of(!editable),
        EditorView.editable.of(editable),
      ],
    });
    editorView = new EditorView({ state, parent: container });
  }

  function setEditing(next: boolean) {
    editing = next;
    // Rebuild with the editable flag flipped; discards unsaved keystrokes
    // when leaving edit mode (Cancel path reloads the saved baseline).
    buildEditor(editorView?.state.doc.toString() ?? content, next);
    editorView?.focus();
  }

  async function saveFile() {
    if (!editorView || saving) return;
    saving = true;
    try {
      const text = editorView.state.doc.toString();
      await api.fsWriteFile(filePath, text);
      content = text;
      editing = false;
      buildEditor(text, false);
      showToast("File saved", "success");
    } catch (e) {
      showToast(`Save failed: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      saving = false;
    }
  }

  function cancelEdit() {
    // Drop unsaved keystrokes, restore the last-saved baseline.
    editing = false;
    buildEditor(content, false);
  }

  onMount(async () => {
    try {
      content = await api.fsReadFile(filePath);
    } catch (e) {
      content = `Error loading file: ${e}`;
    }
    loading = false;
    buildEditor(content, false);
  });

  onDestroy(() => {
    if (editorView) editorView.destroy();
  });

  $effect(() => {
    // Trigger on file switches only. buildEditor reassigns editorView, so
    // that read stays untracked — otherwise every rebuild would re-fire
    // this effect (same busy-loop as the editors had).
    const path = filePath;
    const hadView = untrack(() => editorView);
    if (path && hadView) {
      // Switching files always lands back in read mode on fresh content.
      editing = false;
      api.fsReadFile(path).then((newContent) => {
        content = newContent;
        buildEditor(newContent, false);
      }).catch(() => {
        content = "Couldn't read file.";
      });
    }
  });
</script>

<div class="md-viewer">
  <div class="viewer-header">
    {#if onClose}
      <button class="back-btn" onclick={onClose} title="Back to files" aria-label="Back to files">← Back</button>
    {/if}
    <span class="file-name">{filePath.split(/[/\\]/).pop()}</span>
    <span class="file-path">{filePath}</span>
    <span class="viewer-actions">
      {#if editing}
        <button class="mini-btn primary" onclick={saveFile} disabled={saving} title="Save to disk" aria-label="Save to disk">{saving ? "Saving…" : "Save"}</button>
        <button class="mini-btn" onclick={cancelEdit} disabled={saving} title="Discard unsaved changes" aria-label="Discard unsaved changes">Cancel</button>
      {:else}
        <button class="mini-btn" onclick={() => setEditing(true)} title="Edit this file" aria-label="Edit this file">Edit</button>
      {/if}
      <button class="mini-btn" onclick={copyContent} title="Copy contents" aria-label="Copy contents">Copy</button>
      <button class="mini-btn" onclick={downloadFile} title="Download a copy (§10 export, global)" aria-label="Download a copy">Download</button>
    </span>
  </div>
  {#if loading}
    <div class="loading">Loading...</div>
  {:else}
    <div class="viewer-content" bind:this={container}></div>
  {/if}
</div>

<style>
  .md-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
    background: var(--surface-base);
  }

  .viewer-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 16px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-raised);
    flex-shrink: 0;
  }

  .file-name {
    font-size: 13px;
    font-weight: 500;
    color: var(--text-primary);
  }

  .file-path {
    font-size: 11px;
    font-family: var(--font-mono);
    color: var(--text-muted);
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .viewer-actions {
    display: flex;
    gap: 6px;
    margin-left: auto;
    flex-shrink: 0;
  }

  .back-btn,
  .mini-btn {
    font-size: 12px;
    padding: 3px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .back-btn:hover,
  .mini-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .mini-btn.primary {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .mini-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    font-size: 13px;
  }

  .viewer-content {
    flex: 1;
    overflow: auto;
  }
</style>
