<script lang="ts">
  /**
   * WikilinkPreview — hover tooltip showing preview of [[linked]] doc (A11.3).
   * Detects mouse position over wikilinks in the editor, fetches first lines.
   */
  import { api } from "$lib/api";

  let { visible = $bindable(false), position = $bindable({ x: 0, y: 0 }), docId = $bindable(""), docTitle = $bindable("") }: {
    visible: boolean;
    position: { x: number; y: number };
    docId: string;
    docTitle: string;
  } = $props();

  let preview = $state("");
  let loading = $state(false);

  $effect(() => {
    if (docId && visible) {
      loading = true;
      preview = "";
      api.docGet(docId).then((doc) => {
        // Show first ~300 chars of content
        const text = (doc.content || "").replace(/^#+\s+.+\n?/, "").trim();
        preview = text.slice(0, 300) + (text.length > 300 ? "..." : "");
        loading = false;
      }).catch(() => {
        preview = "Document not found";
        loading = false;
      });
    }
  });
</script>

{#if visible && docTitle}
  <div class="wikilink-preview" style="left: {Math.min(position.x, window.innerWidth - 320)}px; top: {position.y + 8}px;">
    <div class="preview-title">{docTitle}</div>
    {#if loading}
      <div class="preview-loading">Loading...</div>
    {:else if preview}
      <div class="preview-body">{preview}</div>
    {:else}
      <div class="preview-empty">Empty document</div>
    {/if}
  </div>
{/if}

<style>
  .wikilink-preview {
    position: fixed;
    z-index: 999;
    width: 300px;
    max-height: 200px;
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    padding: 10px 12px;
    pointer-events: none;
  }

  .preview-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    margin-bottom: 6px;
    padding-bottom: 6px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .preview-body {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .preview-loading,
  .preview-empty {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }
</style>
