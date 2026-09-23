<script lang="ts">
  /**
   * ReaderProse — ONE typography renderer for book prose (item 6).
   * Used by ReaderWorkspace's section flow. EditorPane reading mode and
   * MarkdownViewer intentionally stay CodeMirror: both are editable
   * surfaces (edit/save), and swapping them to static prose would delete
   * features in the name of convergence.
   */
  let {
    html,
    font = "serif",
    sizePx = 16,
    measure = "comfortable",
    theme = "app",
    sectionId = undefined,
    active = false,
  }: {
    html: string;
    font?: "serif" | "sans" | "mono";
    sizePx?: number;
    measure?: "narrow" | "comfortable" | "wide";
    theme?: "app" | "light" | "sepia" | "dark";
    sectionId?: string;
    active?: boolean;
  } = $props();

  const fontStack = $derived(
    font === "mono"
      ? "var(--font-mono)"
      : font === "sans"
        ? "var(--font-sans)"
        : "Georgia, 'Times New Roman', serif"
  );

  const maxWidth = $derived(measure === "narrow" ? "560px" : measure === "wide" ? "900px" : "700px");
</script>

<section
  class="reader-prose"
  class:active
  class:theme-light={theme === "light"}
  class:theme-sepia={theme === "sepia"}
  class:theme-dark={theme === "dark"}
  id={sectionId}
  data-section={sectionId}
  style="--prose-font: {fontStack}; --prose-size: {sizePx}px; --prose-measure: {maxWidth};"
>
  {@html html}
</section>

<style>
  .reader-prose {
    max-width: var(--prose-measure);
    margin: 0 auto;
    font-family: var(--prose-font);
    font-size: var(--prose-size);
    line-height: var(--line-height-relaxed);
    color: var(--text-primary);
    /* Native lazy render for long books: off-screen sections skip layout. */
    content-visibility: auto;
    contain-intrinsic-size: auto 600px;
  }

  .reader-prose.active {
    outline: 2px solid var(--accent-primary);
    outline-offset: 6px;
    border-radius: var(--radius-sm);
  }

  /* Fixed reading papers (theme="light|sepia|dark" ignore the app theme). */
  .reader-prose.theme-light {
    --text-primary: #2b2a25;
    --text-secondary: #5f5c50;
    --text-muted: #5f5c50;
    --accent-primary: #3f6656;
    background: #f1efe6;
  }

  .reader-prose.theme-sepia {
    --text-primary: #433422;
    --text-secondary: #6b5a41;
    --text-muted: #6b5a41;
    --accent-primary: #8a6d3b;
    background: #f4ecd8;
  }

  .reader-prose.theme-dark {
    --text-primary: #ece7d8;
    --text-secondary: #9c9686;
    --text-muted: #9c9686;
    --accent-primary: #8fc7a9;
    background: #1b1a15;
  }

  .reader-prose.theme-light,
  .reader-prose.theme-sepia,
  .reader-prose.theme-dark {
    padding: 24px 28px;
    border-radius: var(--radius-md);
  }

  .reader-prose :global(h1),
  .reader-prose :global(h2),
  .reader-prose :global(h3) {
    font-family: var(--prose-font);
    line-height: 1.3;
    margin: 1.2em 0 0.5em;
  }

  .reader-prose :global(p) {
    margin: 0 0 1em;
  }

  .reader-prose :global(ul),
  .reader-prose :global(ol) {
    margin: 0 0 1em 1.5em;
  }

  .reader-prose :global(li) {
    margin-bottom: 0.25em;
  }

  .reader-prose :global(blockquote) {
    border-left: 3px solid var(--accent-primary);
    margin: 0 0 1em;
    padding-left: 1em;
    color: var(--text-secondary);
  }

  .reader-prose :global(code) {
    font-family: var(--font-mono);
    font-size: 0.9em;
  }

  .reader-prose :global(.img-missing) {
    margin: 1em 0;
  }

  .reader-prose :global(.img-missing-box) {
    height: 120px;
    border: 1px dashed var(--border-subtle, var(--border));
    border-radius: var(--radius-sm);
    background: var(--surface-overlay, transparent);
  }

  .reader-prose :global(.img-missing figcaption) {
    font-size: 12px;
    color: var(--text-muted);
    margin-top: 4px;
    font-style: italic;
  }

  /* Transclusion islands render inside this article (injected HTML via
    {@html}), so their selectors live here — not in the parent. */
  .reader-prose :global(.transclude) {
    border-left: 2px solid var(--accent-primary);
    padding-left: var(--space-3);
    margin: var(--space-2) 0;
    background: var(--surface-elevated);
    border-radius: 0 var(--radius-md) var(--radius-md) 0;
    font-size: 0.95em;
  }

  .reader-prose :global(.transclude-content) {
    white-space: pre-wrap;
    word-wrap: break-word;
    line-height: var(--line-height-relaxed);
  }

  .reader-prose :global(.transclude-footer) {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: var(--space-2);
    padding-top: var(--space-2);
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-muted);
  }

  .reader-prose :global(.transclude-source) {
    font-family: var(--font-mono);
  }

  .reader-prose :global(.transclude-open) {
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-base);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 11px;
  }

  .reader-prose :global(.transclude-error) {
    border-left-color: var(--accent-semantic-red);
    color: var(--accent-semantic-red);
  }

  .reader-prose :global(.transclude-retry) {
    margin-left: auto;
    padding: 2px 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-base);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 11px;
  }
</style>
