<script lang="ts">
  import { onMount, onDestroy, untrack } from "svelte";
  import { EditorView, keymap, highlightActiveLine } from "@codemirror/view";
  import { EditorState } from "@codemirror/state";
  import { markdown } from "@codemirror/lang-markdown";
  import { api } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";
  import { renderMarkdownPreview } from "$lib/mdPreview";
  import PdfViewer from "$lib/components/PdfViewer.svelte";

  let { filePath, onClose, externalBase64 = null }: { filePath: string; onClose?: () => void; externalBase64?: string | null } = $props();

  let container = $state<HTMLDivElement>();
  // $state.raw: the CodeMirror view is an opaque handle. Deep-proxying it
  // makes Svelte traverse the whole editor graph on assignment (see
  // JustWriteWorkspace — the same pattern busy-loops and starves timers).
  let editorView = $state.raw<EditorView | null>(null);
  let content = $state("");
  let loading = $state(true);
  let loadError = $state("");
  let binaryBase64 = $state("");
  let loadSeq = 0;
  let lastPath = "";
  // Plain .md/.txt files browsed via Files are readable AND editable here
  // (A9.0: Reader covers raw-text files) — edit mode is opt-in per file.
  let editing = $state(false);
  let saving = $state(false);
  // Markdown files open as a rendered page (tables, lists, code, quotes);
  // Source shows the raw text. Editing always works on source.
  const isMarkdownPath = (path: string) => /\.(md|markdown|mdx)$/i.test(path);
  const extension = (path: string) => path.split(".").pop()?.toLowerCase() ?? "";
  const binaryKind = (path: string): "pdf" | "image" | "docx" | null => {
    const ext = extension(path);
    if (ext === "pdf") return "pdf";
    if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) return "image";
    if (ext === "docx") return "docx";
    return null;
  };
  let fileKind = $derived(binaryKind(filePath));
  let viewOverride = $state<"preview" | "source" | null>(null);
  let view = $derived<"preview" | "source">(viewOverride ?? (isMarkdownPath(filePath) ? "preview" : "source"));
  let previewHtml = $state("");
  let showPreview = $derived(view === "preview" && !editing && !loading);
  let pdfData = $derived.by(() => {
    if (fileKind !== "pdf" || !binaryBase64) return new Uint8Array();
    const raw = atob(binaryBase64);
    return Uint8Array.from(raw, (char) => char.charCodeAt(0));
  });
  let imageUrl = $derived.by(() => {
    if (fileKind !== "image" || !binaryBase64) return "";
    const ext = extension(filePath);
    const mime = ext === "svg" ? "image/svg+xml" : ext === "jpg" ? "image/jpeg" : `image/${ext}`;
    return `data:${mime};base64,${binaryBase64}`;
  });

  $effect(() => {
    // Re-render whenever the saved text changes; stale results are dropped.
    const text = content;
    if (!isMarkdownPath(filePath)) {
      previewHtml = "";
      return;
    }
    let alive = true;
    renderMarkdownPreview(text)
      .then((html) => {
        if (alive) previewHtml = html;
      })
      .catch((e) => {
        console.error("[MarkdownViewer] preview failed:", e);
        if (alive) {
          previewHtml = "";
          viewOverride = "source";
        }
      });
    return () => {
      alive = false;
    };
  });

  function downloadFile() {
    const name = filePath.split(/[/\\]/).pop() ?? "document.md";
    const blob = fileKind && binaryBase64
      ? new Blob([Uint8Array.from(atob(binaryBase64), (char) => char.charCodeAt(0))])
      : new Blob([content], { type: isMarkdownPath(filePath) ? "text/markdown" : "text/plain" });
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
    if (!editorView || saving || fileKind) return;
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

  async function loadFile(path: string) {
    const seq = ++loadSeq;
    loading = true;
    loadError = "";
    binaryBase64 = "";
    content = "";
    editing = false;
    viewOverride = null;
    try {
      const kind = binaryKind(path);
      if (kind) {
        binaryBase64 = externalBase64 ?? await api.fsReadBinary(path);
        if (seq !== loadSeq) return;
        if (kind === "docx") {
          const raw = atob(binaryBase64);
          const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
          const { parseDocx } = await import("$lib/bookparse");
          content = (await parseDocx(bytes)).text;
        }
      } else {
        content = await api.fsReadFile(path);
      }
      if (seq !== loadSeq) return;
    } catch (e) {
      if (seq === loadSeq) loadError = e instanceof Error ? e.message : String(e);
    }
    if (seq !== loadSeq) return;
    loading = false;
    if (!binaryKind(path)) buildEditor(content, false);
    else if (editorView) {
      editorView.destroy();
      editorView = null;
    }
  }

  onMount(() => {
    lastPath = filePath;
    void loadFile(filePath);
  });

  onDestroy(() => {
    loadSeq++;
    if (editorView) editorView.destroy();
  });

  $effect(() => {
    // Trigger on file switches only. buildEditor reassigns editorView, so
    // that read stays untracked — otherwise every rebuild would re-fire
    // this effect (same busy-loop as the editors had).
    const path = filePath;
    untrack(() => editorView);
    if (path && lastPath && path !== lastPath) {
      lastPath = path;
      void loadFile(path);
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
      {#if isMarkdownPath(filePath) && !editing}
        <span class="view-toggle" role="group" aria-label="View mode">
          <button class="mini-btn" class:active={view === "preview"} aria-pressed={view === "preview"} onclick={() => (viewOverride = "preview")}>Preview</button>
          <button class="mini-btn" class:active={view === "source"} aria-pressed={view === "source"} onclick={() => (viewOverride = "source")}>Source</button>
        </span>
      {/if}
      {#if editing}
        <button class="mini-btn primary" onclick={saveFile} disabled={saving} title="Save to disk" aria-label="Save to disk">{saving ? "Saving…" : "Save"}</button>
        <button class="mini-btn" onclick={cancelEdit} disabled={saving} title="Discard unsaved changes" aria-label="Discard unsaved changes">Cancel</button>
      {:else if !fileKind}
        <button class="mini-btn" onclick={() => setEditing(true)} title="Edit this file" aria-label="Edit this file">Edit</button>
      {/if}
      {#if !fileKind || fileKind === "docx"}
        <button class="mini-btn" onclick={copyContent} title="Copy contents" aria-label="Copy contents">Copy</button>
      {/if}
      <button class="mini-btn" onclick={downloadFile} title="Download a copy (§10 export, global)" aria-label="Download a copy">Download</button>
    </span>
  </div>
  {#if loading}
    <div class="loading">Loading...</div>
  {:else if loadError}
    <div class="loading error-message">{loadError}</div>
  {:else if fileKind === "pdf"}
    {#key filePath}<PdfViewer data={pdfData} title={filePath.split(/[/\\]/).pop() ?? "PDF"} />{/key}
  {:else if fileKind === "image"}
    <div class="image-stage"><img src={imageUrl} alt={filePath.split(/[/\\]/).pop() ?? "Image preview"} /></div>
  {:else if fileKind === "docx"}
    <article class="viewer-content docx-text" aria-label="Extracted DOCX text">{content}</article>
  {:else}
    {#if showPreview}
      <article class="viewer-content md-prose" aria-label="Rendered markdown">
        {#if previewHtml}
          {@html previewHtml}
        {:else}
          <p class="md-loading">Rendering…</p>
        {/if}
      </article>
    {/if}
    <div class="viewer-content" bind:this={container} hidden={showPreview}></div>
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

  .error-message { color: var(--text-danger, #b42318); padding: 24px; }
  .image-stage { flex: 1; min-height: 0; overflow: auto; display: grid; place-items: center; padding: 24px; }
  .image-stage img { max-width: 100%; max-height: 100%; object-fit: contain; }
  .docx-text { box-sizing: border-box; width: 100%; max-width: 760px; margin: 0 auto; padding: 40px 24px; white-space: pre-wrap; font: inherit; line-height: var(--line-height-relaxed); color: var(--text-primary); }

  .viewer-content {
    flex: 1;
    overflow: auto;
  }

  /* Centered reading column: the viewer is a reading surface, so the
     text sits in a measure-optimized column, not edge to edge.
     :global because .cm-* nodes are rendered by CodeMirror, not Svelte. */
  .viewer-content :global(.cm-content) {
    max-width: 720px;
    margin: 0 auto;
    padding: 40px 16px;
    font-family: var(--font-body);
    font-size: var(--font-size-base);
    line-height: var(--line-height-relaxed);
  }
  .view-toggle { display: inline-flex; }
  .view-toggle .mini-btn { border-radius: 0; }
  .view-toggle .mini-btn:first-child { border-radius: var(--radius-sm) 0 0 var(--radius-sm); }
  .view-toggle .mini-btn:last-child { margin-left: -1px; border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
  .view-toggle .mini-btn.active { background: var(--surface-overlay, rgb(128 128 128 / 14%)); color: var(--text-primary); }
  .viewer-content[hidden] { display: none; }

  /* Rendered page: one readable column, same family as the editor body. */
  .md-prose {
    box-sizing: border-box;
    padding: 40px max(16px, calc((100% - 720px) / 2));
    color: var(--text-primary);
    font-family: var(--font-body);
    font-size: var(--font-size-base);
    line-height: var(--line-height-relaxed);
    overflow-wrap: anywhere;
  }
  .md-prose :global(h1), .md-prose :global(h2), .md-prose :global(h3), .md-prose :global(h4) { margin: 1.6em 0 0.5em; line-height: 1.25; font-weight: 600; }
  .md-prose :global(h1) { margin-top: 0; font-size: 1.9em; }
  .md-prose :global(h2) { padding-bottom: 0.25em; border-bottom: 1px solid var(--border-subtle); font-size: 1.45em; }
  .md-prose :global(h3) { font-size: 1.2em; }
  .md-prose :global(p), .md-prose :global(ul), .md-prose :global(ol), .md-prose :global(blockquote), .md-prose :global(pre) { margin: 0 0 1em; }
  .md-prose :global(ul), .md-prose :global(ol) { padding-left: 1.6em; }
  .md-prose :global(li > ul), .md-prose :global(li > ol) { margin: 0.25em 0; }
  .md-prose :global(blockquote) { padding: 0.1em 1em; border-left: 3px solid var(--accent-primary, #b8860b); color: var(--text-secondary); }
  .md-prose :global(hr) { margin: 2em 0; border: 0; border-top: 1px solid var(--border-subtle); }
  .md-prose :global(code) { padding: 0.12em 0.4em; border-radius: var(--radius-sm); background: var(--surface-overlay, rgb(128 128 128 / 14%)); font-family: var(--font-mono); font-size: 0.88em; }
  .md-prose :global(pre) { padding: 14px 16px; overflow-x: auto; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-raised); line-height: 1.5; }
  .md-prose :global(pre code) { padding: 0; background: none; font-size: 0.86em; }
  .md-prose :global(.md-table-wrap) { margin: 0 0 1em; overflow-x: auto; }
  .md-prose :global(table) { border-collapse: collapse; min-width: 100%; font-size: 0.95em; }
  .md-prose :global(th), .md-prose :global(td) { padding: 7px 12px; border: 1px solid var(--border-subtle); text-align: left; vertical-align: top; }
  .md-prose :global(th) { background: var(--surface-raised); font-weight: 600; }
  .md-prose :global(tbody tr:nth-child(even) td) { background: color-mix(in srgb, var(--surface-raised) 55%, transparent); }
  .md-prose :global(a) { color: var(--accent-primary, #b8860b); text-decoration: underline; text-underline-offset: 2px; }
  .md-prose :global(a.md-link-inert) { cursor: default; }
  .md-prose :global(del) { color: var(--text-muted); }
  .md-prose :global(input[type="checkbox"]) { margin-right: 0.45em; vertical-align: -1px; }
  .md-prose :global(.md-image-missing) { color: var(--text-muted); font-style: italic; }
  .md-loading { color: var(--text-muted); }
</style>
