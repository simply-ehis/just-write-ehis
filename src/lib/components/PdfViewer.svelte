<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import Icon from "./Icon.svelte";
  import { warnOnce } from "$lib/errors";

  /**
   * PdfViewer — faithful page rendering via the already-bundled pdf.js
   * (same engine + worker wiring as book text extraction). Canvas per
   * page, prev/next + zoom controls, works offline in shell and PWA.
   */
  let {
    data,
    title,
    onClose,
    onImport,
  }: {
    data: Uint8Array;
    title: string;
    onClose?: () => void;
    onImport?: () => void;
  } = $props();

  let canvas = $state<HTMLCanvasElement | null>(null);
  let pdfDoc: { numPages: number; getPage: (n: number) => Promise<unknown>; destroy: () => Promise<void> } | null = null;
  let numPages = $state(0);
  let pageNum = $state(1);
  let scale = $state(1.25);
  let loading = $state(true);
  let error = $state<string | null>(null);
  // Render token: a slow page render must not overwrite a newer one.
  let renderSeq = 0;

  async function renderPage() {
    if (!pdfDoc || !canvas) return;
    const seq = ++renderSeq;
    try {
      const page = (await pdfDoc.getPage(pageNum)) as {
        getViewport: (o: { scale: number }) => { width: number; height: number };
        render: (o: { canvasContext: CanvasRenderingContext2D; viewport: unknown }) => { promise: Promise<void>; cancel: () => void };
      };
      if (seq !== renderSeq) return;
      const viewport = page.getViewport({ scale });
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("Canvas 2D unavailable.");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      await page.render({ canvasContext: ctx, viewport }).promise;
    } catch (e) {
      if (seq !== renderSeq) return;
      error = e instanceof Error ? e.message : "Couldn't render this page.";
    }
  }

  function gotoPage(n: number) {
    if (!numPages) return;
    pageNum = Math.min(numPages, Math.max(1, n));
    error = null;
    void renderPage();
  }

  function zoom(delta: number) {
    scale = Math.min(4, Math.max(0.5, +(scale + delta).toFixed(2)));
    error = null;
    void renderPage();
  }

  onMount(async () => {
    try {
      const pdfjs = await import("pdfjs-dist");
      const worker = (await import("pdfjs-dist/build/pdf.worker.min.mjs?url")).default;
      pdfjs.GlobalWorkerOptions.workerSrc = worker;
      const copy = new Uint8Array(data);
      const doc = (await pdfjs.getDocument({ data: copy, useWorkerFetch: false, verbosity: 0 }).promise) as unknown as {
        numPages: number;
        getPage: (n: number) => Promise<unknown>;
        destroy: () => Promise<void>;
      };
      pdfDoc = doc;
      numPages = doc.numPages;
      loading = false;
      await renderPage();
    } catch (e) {
      error = e instanceof Error ? e.message : "Couldn't open this PDF.";
      loading = false;
    }
  });

  onDestroy(() => {
    renderSeq++;
    if (pdfDoc) pdfDoc.destroy().catch((e) => warnOnce("Reader PDF teardown", e));
    pdfDoc = null;
  });
</script>

<div class="pdf-viewer">
  <div class="pdf-toolbar">
    {#if onClose}
      <button class="icon-btn" onclick={onClose} title="Close preview" aria-label="Close PDF preview">
        <Icon name="x" size={15} />
      </button>
    {/if}
    <span class="pdf-title">{title}</span>
    <div class="pdf-nav" role="group" aria-label="Page navigation">
      <button class="icon-btn" onclick={() => gotoPage(pageNum - 1)} disabled={pageNum <= 1} title="Previous page" aria-label="Previous page">
        <Icon name="arrow-left" size={15} />
      </button>
      <span class="pdf-page" aria-live="polite">{numPages ? `${pageNum} / ${numPages}` : "…"}</span>
      <button class="icon-btn" onclick={() => gotoPage(pageNum + 1)} disabled={pageNum >= numPages} title="Next page" aria-label="Next page">
        <Icon name="arrow-right" size={15} />
      </button>
    </div>
    <div class="pdf-nav" role="group" aria-label="Zoom">
      <button class="icon-btn" onclick={() => zoom(-0.25)} disabled={scale <= 0.5} title="Zoom out" aria-label="Zoom out">
        <Icon name="minus" size={15} />
      </button>
      <span class="pdf-page">{Math.round(scale * 100)}%</span>
      <button class="icon-btn" onclick={() => zoom(0.25)} disabled={scale >= 4} title="Zoom in" aria-label="Zoom in">
        <Icon name="plus" size={15} />
      </button>
    </div>
    {#if onImport}
      <button class="import-btn" onclick={onImport} title="Extract text into the Reader library">
        Import text
      </button>
    {/if}
  </div>

  <div class="pdf-stage">
    {#if loading}
      <div class="pdf-status">Opening PDF…</div>
    {:else if error}
      <div class="pdf-status error">{error}</div>
    {/if}
    <canvas bind:this={canvas} class="pdf-canvas" class:hidden={loading || !!error} title="Themed preview only — the PDF file itself is unchanged"></canvas>
  </div>
</div>

<style>
  .pdf-viewer {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .pdf-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    flex-wrap: wrap;
  }

  .pdf-title {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-right: auto;
  }

  .pdf-nav {
    display: flex;
    align-items: center;
    gap: var(--space-1);
  }

  .pdf-page {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    min-width: 52px;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }

  .import-btn {
    height: 30px;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    border: 1px solid var(--border-subtle);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .pdf-stage {
    flex: 1;
    overflow: auto;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding: var(--space-4);
    background: var(--surface-overlay);
  }

  .pdf-status {
    margin: auto;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .pdf-status.error {
    color: var(--accent-semantic-red);
  }

  .pdf-canvas {
    /* The page itself is white paper (correct for documents). On dark
      surfaces the render is dimmed for viewing comfort only — the
      source PDF is never modified. */
    background: #fff;
    border-radius: var(--radius-sm);
    box-shadow: 0 2px 12px rgba(0, 0, 0, 0.35);
    max-width: none;
  }

  :global(:root[data-theme="dark"]) .pdf-canvas,
  :global(:root[data-theme="glass"]) .pdf-canvas,
  :global(:root[data-theme="brutalist"]) .pdf-canvas {
    filter: brightness(0.86) contrast(0.96);
  }

  .pdf-canvas.hidden {
    display: none;
  }
</style>
