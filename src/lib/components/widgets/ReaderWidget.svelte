<script lang="ts">
  /**
   * ReaderWidget: ONE job. Read the book you're on, one section at a time.
   * No bookshelf management, no notes, no import, no read-aloud: those stay
   * in the Reader tab. It remembers its own place (it never writes the main
   * Reader's position, so the two cannot overwrite each other).
   */
  import { onMount, tick } from "svelte";
  import { api, type BookshelfEntry } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { splitSections, type ReaderSection } from "$lib/readerSections";
  import { renderMarkdownPreview } from "$lib/mdPreview";
  import ReaderProse from "$lib/components/ReaderProse.svelte";
  import Icon from "$lib/components/Icon.svelte";

  let { onOpenReader }: { onOpenReader: () => void } = $props();

  let books = $state<BookshelfEntry[]>([]);
  let loading = $state(true);
  let error = $state("");
  let bookId = $state("");
  let sections = $state<ReaderSection[]>([]);
  let idx = $state(0);
  let html = $state("");
  let scroller = $state<HTMLElement>();
  let renderToken = 0;

  const hasPrev = $derived(idx > 0);
  const hasNext = $derived(idx < sections.length - 1);

  function sectionMarkdown(section: ReaderSection): string {
    return section.parts.filter((part) => part.type === "md").map((part) => part.text).join("\n");
  }

  /** Where the main Reader left off in this book (section id), if it recorded one. */
  function readerAnchorSection(entry: BookshelfEntry): string {
    try {
      const fm = JSON.parse(entry.doc.frontmatter_json ?? "{}") as { readerAnchor?: { section?: string | null } };
      return fm.readerAnchor?.section ?? "";
    } catch {
      return "";
    }
  }

  async function show(index: number, resetScroll = true) {
    if (!sections.length) {
      html = "";
      return;
    }
    idx = Math.min(sections.length - 1, Math.max(0, index));
    const token = ++renderToken;
    const rendered = await renderMarkdownPreview(sectionMarkdown(sections[idx]));
    if (token !== renderToken) return;
    html = rendered;
    const sectionId = sections[idx].id;
    settings.update((current) => (current.widgetReaderSection === sectionId ? current : { ...current, widgetReaderSection: sectionId }));
    if (resetScroll) {
      await tick();
      if (scroller) scroller.scrollTop = 0;
    }
  }

  function openBook(id: string, restore: boolean) {
    const entry = books.find((book) => book.doc.id === id);
    if (!entry) return;
    bookId = id;
    sections = splitSections(entry.doc.content ?? "");
    let start = 0;
    if (restore) {
      const wanted = $settings.widgetReaderDocId === id ? $settings.widgetReaderSection : readerAnchorSection(entry);
      const found = wanted ? sections.findIndex((section) => section.id === wanted) : -1;
      start = found >= 0 ? found : 0;
    }
    settings.update((current) => ({ ...current, widgetReaderDocId: id, widgetReaderSection: "" }));
    void show(start);
  }

  async function load() {
    loading = true;
    error = "";
    try {
      books = await api.readerGetBookshelf();
      const remembered = books.find((book) => book.doc.id === $settings.widgetReaderDocId);
      const pick = remembered ?? books.find((book) => book.shelf_status === "reading") ?? books[0];
      if (pick) openBook(pick.doc.id, true);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function changeSize(delta: number) {
    settings.update((current) => ({ ...current, widgetReaderSize: Math.min(28, Math.max(12, current.widgetReaderSize + delta)) }));
  }

  function onKeydown(event: KeyboardEvent) {
    if ((event.target as HTMLElement | null)?.closest("select, input, textarea")) return;
    if (event.key === "ArrowRight" && hasNext) {
      event.preventDefault();
      void show(idx + 1);
    } else if (event.key === "ArrowLeft" && hasPrev) {
      event.preventDefault();
      void show(idx - 1);
    }
  }

  onMount(() => {
    void load();
  });
</script>

<svelte:window onkeydown={onKeydown} />

<section class="reader" aria-label="Reader widget">
  {#if loading}
    <p class="state" role="status">Loading…</p>
  {:else if error}
    <div class="state" role="alert">
      <span class="err">{error}</span>
      <button class="text-btn" onclick={load}>Retry</button>
    </div>
  {:else if books.length === 0}
    <div class="state">
      <span>Your bookshelf is empty.</span>
      <button class="text-btn" onclick={onOpenReader}>Open Reader to add a book</button>
    </div>
  {:else}
    <div class="top">
      <select
        value={bookId}
        onchange={(e) => openBook(e.currentTarget.value, false)}
        aria-label="Book"
      >
        {#each books as entry (entry.doc.id)}
          <option value={entry.doc.id}>{entry.doc.title || "Untitled"}</option>
        {/each}
      </select>
      <button class="icon-btn" onclick={() => changeSize(-1)} disabled={$settings.widgetReaderSize <= 12} aria-label="Smaller text" title="Smaller text">A−</button>
      <button class="icon-btn" onclick={() => changeSize(1)} disabled={$settings.widgetReaderSize >= 28} aria-label="Larger text" title="Larger text">A+</button>
    </div>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex: a scrollable text region must be keyboard-focusable so arrow/page keys can scroll it -->
    <div class="page" role="region" bind:this={scroller} tabindex="0" aria-label="Section text. Left and right arrows change section.">
      {#if html}
        <ReaderProse {html} font={$settings.readerFont} sizePx={$settings.widgetReaderSize} measure="wide" theme={$settings.readerTheme} sectionId={sections[idx]?.id} />
      {:else}
        <p class="state">This book has no text.</p>
      {/if}
    </div>
    <div class="nav">
      <button class="icon-btn" onclick={() => show(idx - 1)} disabled={!hasPrev} aria-label="Previous section" title="Previous section"><Icon name="arrow-left" size={14} /></button>
      <span class="count" aria-live="polite">{idx + 1} / {sections.length}</span>
      <button class="icon-btn" onclick={() => show(idx + 1)} disabled={!hasNext} aria-label="Next section" title="Next section"><Icon name="arrow-right" size={14} /></button>
    </div>
  {/if}
</section>

<style>
  .reader { display: flex; flex-direction: column; height: 100%; min-height: 0; }
  .top { display: flex; align-items: center; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--border-subtle, rgb(128 128 128 / 25%)); }
  select {
    flex: 1;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid var(--border-subtle, rgb(128 128 128 / 30%));
    border-radius: var(--radius-sm, 6px);
    background: var(--surface-raised, #fffdf8);
    color: var(--text-primary, #1a1a1a);
    font-size: 12px;
  }
  .page { flex: 1; min-height: 0; padding: 10px 14px; overflow-y: auto; }
  .page:focus-visible { outline: 2px solid var(--accent-primary, #b8860b); outline-offset: -2px; }
  .nav { display: flex; align-items: center; justify-content: space-between; padding: 4px 8px; border-top: 1px solid var(--border-subtle, rgb(128 128 128 / 25%)); }
  .count { color: var(--text-muted, #777); font-size: 12px; font-variant-numeric: tabular-nums; }
  .icon-btn {
    display: grid;
    place-items: center;
    min-width: 30px;
    height: 28px;
    padding: 0 6px;
    border: 1px solid var(--border-subtle, rgb(128 128 128 / 30%));
    border-radius: var(--radius-sm, 6px);
    background: transparent;
    color: var(--text-primary, #1a1a1a);
    font-size: 12px;
    cursor: pointer;
  }
  .icon-btn:hover:not(:disabled) { background: var(--surface-overlay, rgb(128 128 128 / 14%)); }
  .icon-btn:disabled { opacity: 0.35; cursor: default; }
  .state { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 8px; height: 100%; margin: 0; padding: 16px; color: var(--text-muted, #777); font-size: 13px; text-align: center; }
  .err { color: var(--accent-semantic-red, #c0392b); }
  .text-btn { padding: 4px 10px; border: 1px solid var(--accent-primary, #b8860b); border-radius: var(--radius-sm, 6px); background: transparent; color: var(--accent-primary, #b8860b); font-size: 12px; cursor: pointer; }
</style>
