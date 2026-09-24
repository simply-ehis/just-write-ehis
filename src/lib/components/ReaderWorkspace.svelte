<script lang="ts">
  import { tick } from "svelte";
  import { api, type Doc, type BookshelfEntry } from '$lib/api';
  import { currentDoc, openTabs } from '$lib/stores/app';
  import { showToast } from '$lib/stores/notifications';
  import { domainError } from '$lib/errors';
  import WorkspaceError from './WorkspaceError.svelte';
  import { settings } from '$lib/stores/settings';
  import { processTransclusions } from '$lib/transclude';
  import { readImportFile } from '$lib/importFile';
  import { markdownToHtmlFragment } from '$lib/markdown';
  import {
    anchorFor,
    scrollTopFor,
    sectionText,
    splitSections,
    type ReaderAnchor,
    type ReaderSection,
  } from '$lib/readerSections';
  import ReadAloudButton from '$lib/components/ReadAloudButton.svelte';
  import ReaderProse from '$lib/components/ReaderProse.svelte';
  import PdfViewer from '$lib/components/PdfViewer.svelte';
  import { downloadConvertOutput } from '$lib/download';
  import Icon from '$lib/components/Icon.svelte';
  import DockSplit from '$lib/components/DockSplit.svelte';

  let shelfFilter = $state<string>('all');
  let books = $state<BookshelfEntry[]>([]);
  let selectedBook = $state<BookshelfEntry | null>(null);
  let importInput = $state<HTMLInputElement | null>(null);
  let previewInput = $state<HTMLInputElement | null>(null);
  // Stashed PDF bytes for faithful page preview (import still extracts text).
  let pdfPreview = $state<{ data: Uint8Array; name: string } | null>(null);
  let loading = $state(false);
  let readerContent = $state('');
  let readerPosition = $state(0);
  let scrollEl = $state<HTMLElement | null>(null);
  let posSaveTimer: ReturnType<typeof setTimeout> | null = null;

  // Structured reading flow: the stored body (markdown + transclude
  // islands) is split into sections, each rendered through the shared
  // markdown→HTML path (escape-first, so {@html} below is safe).
  let readSections = $state<ReaderSection[]>([]);
  // Progressive window: first N sections render, more append near the
  // bottom (plus content-visibility in ReaderProse for layout cost).
  let renderedCount = $state(12);
  // Section currently read aloud (highlight + autoscroll target).
  let readSectionIdx = $state<number | null>(null);

  /** Rendered HTML per section, in section order. */
  let sectionHtml = $derived(
    readSections.map((s) =>
      s.parts.map((p) => (p.type === "md" ? markdownToHtmlFragment(p.text) : p.text)).join("\n")
    )
  );

  /** Plain text per section (TTS + progress), in section order. */
  let sectionTexts = $derived(readSections.map((s) => sectionText(s)));

  function bookCover(doc: Doc | null): string | null {
    if (!doc?.frontmatter_json) return null;
    try {
      return (JSON.parse(doc.frontmatter_json) as { cover?: string }).cover ?? null;
    } catch {
      return null;
    }
  }

  function bookProgress(entry: BookshelfEntry): number {
    const r = entry.doc.reading_position ?? 0;
    return Math.max(0, Math.min(100, Math.round(r * 100)));
  }

  interface MarginNote {
    id: string;
    text: string;
    quote: string;
    /** Scroll ratio (0..1) captured when noted — jump target. */
    pos: number;
    created_at: string;
  }

  let marginNotes = $state<MarginNote[]>([]);
  let showNotes = $state(false);
  let noteDraft = $state('');
  let noteQuote = $state('');

  function readMarginNotes(fmJson: string | null): MarginNote[] {
    if (!fmJson) return [];
    try {
      const fm = JSON.parse(fmJson) as Record<string, unknown>;
      const notes = fm["marginNotes"];
      if (!Array.isArray(notes)) return [];
      return notes.filter(
        (n): n is MarginNote =>
          !!n && typeof n === "object" && typeof (n as MarginNote).text === "string"
      );
    } catch {
      return [];
    }
  }

  async function persistMarginNotes(notes: MarginNote[]) {
    if (!selectedBook) return;
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(selectedBook.doc.frontmatter_json ?? "{}");
    } catch {
      fm = {};
    }
    fm["marginNotes"] = notes;
    try {
      const updated = await api.docSave(selectedBook.doc.id, undefined, undefined, undefined, JSON.stringify(fm));
      selectedBook.doc = updated;
      $currentDoc = updated;
      $openTabs = $openTabs.map((t) => (t.id === updated.id ? updated : t));
      marginNotes = notes;
    } catch (e) {
      showToast(`Couldn't save note: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  function captureQuote() {
    const selection = window.getSelection();
    const text = selection && selection.rangeCount > 0 ? selection.toString().trim() : "";
    noteQuote = text.slice(0, 280);
    if (!text) showToast("Select a passage first, then quote it", "info");
  }

  async function addNote() {
    if (!selectedBook || !noteDraft.trim()) return;
    const el = scrollEl;
    const pos = el ? el.scrollTop / (el.scrollHeight - el.clientHeight || 1) : readerPosition;
    const note: MarginNote = {
      id: `note-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
      text: noteDraft.trim(),
      quote: noteQuote,
      pos: Math.max(0, Math.min(1, pos)),
      created_at: new Date().toISOString(),
    };
    await persistMarginNotes([...marginNotes, note]);
    noteDraft = "";
    noteQuote = "";
  }

  async function deleteNote(id: string) {
    await persistMarginNotes(marginNotes.filter((n) => n.id !== id));
  }

  /** Export margin notes as a new doc. */
  async function exportNotes() {
    if (!selectedBook || marginNotes.length === 0) {
      showToast("No notes to export", "info");
      return;
    }
    try {
      const bookTitle = selectedBook.doc.title;
      const lines = [`# Margin Notes — ${bookTitle}`, ""];
      for (const note of [...marginNotes].sort((a, b) => a.pos - b.pos)) {
        lines.push(`## ${noteTime(note.created_at)}`);
        if (note.quote) lines.push(`> ${note.quote}`);
        lines.push(note.text);
        lines.push("");
      }
      const markdown = lines.join("\n");
      const title = `Notes — ${bookTitle}`;
      const doc = await api.docCreate("reader", "md", title, undefined, markdown);
      $currentDoc = doc;
      $openTabs = [doc, ...$openTabs];
      showToast(`Exported ${marginNotes.length} notes as "${title}"`, "success");
    } catch (err) {
      showToast(`Export failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  function jumpToNote(note: MarginNote) {
    const el = scrollEl;
    if (!el) return;
    el.scrollTo({ top: note.pos * (el.scrollHeight - el.clientHeight), behavior: "smooth" });
  }

  function noteTime(iso: string): string {
    try {
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch {
      return "";
    }
  }

  // Visible load failure for the shelf: never a fake-empty bookshelf.
  let booksLoadError = $state<string | null>(null);
  async function loadBooks() {
    loading = true;
    booksLoadError = null;
    try {
      const filter = shelfFilter === 'all' ? undefined : shelfFilter;
      books = await api.readerGetBookshelf(filter);
    } catch (e) {
      booksLoadError = e instanceof Error ? e.message : String(e);
      domainError('Reader', "couldn't load bookshelf", e);
    } finally {
      loading = false;
    }
  }

  function setFilter(f: string) {
    shelfFilter = f;
    loadBooks();
  }

  // Reading controls (one compact row; persisted per-Reader in settings).
  function bumpSize(delta: number) {
    const next = Math.max(12, Math.min(24, $settings.readerSize + delta));
    $settings = { ...$settings, readerSize: next };
  }

  function resetSize() {
    $settings = { ...$settings, readerSize: $settings.fontSize };
  }

  function cycleMeasure() {
    const order = ["narrow", "comfortable", "wide"] as const;
    const next = order[(order.indexOf($settings.readerMeasure) + 1) % order.length];
    $settings = { ...$settings, readerMeasure: next };
  }

  function cycleReaderTheme() {
    const order = ["app", "light", "sepia", "dark"] as const;
    const next = order[(order.indexOf($settings.readerTheme) + 1) % order.length];
    $settings = { ...$settings, readerTheme: next };
  }

  /** Section texts for read-aloud (chunked per call, never one giant call). */
  function ttsSections(): { id: string; title: string; text: string }[] {
    return readSections
      .map((s, i) => ({ id: s.id, title: s.title, text: sectionTexts[i] ?? "" }))
      .filter((s) => s.text.trim().length > 0);
  }

  /** Highlight + autoscroll the section being read; expand the window first. */
  function handleTtsSection(idx: number | null) {
    if (idx == null || idx < 0 || idx >= readSections.length) {
      readSectionIdx = null;
      return;
    }
    if (idx + 2 > renderedCount) renderedCount = Math.min(readSections.length, idx + 2);
    readSectionIdx = idx;
    requestAnimationFrame(() => {
      const el = scrollEl?.querySelector(`section[data-section="${readSections[idx].id}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
  }

  /** Measured section boxes for anchoring (offsetTop/offsetHeight). */
  function measuredSections(): { id: string; top: number; height: number }[] {
    const root = scrollEl;
    if (!root) return [];
    const out: { id: string; top: number; height: number }[] = [];
    for (const el of root.querySelectorAll("section[data-section]")) {
      const h = el as HTMLElement;
      if (h.offsetHeight > 0) out.push({ id: h.dataset.section ?? "", top: h.offsetTop, height: h.offsetHeight });
    }
    return out;
  }

  function readAnchor(): ReaderAnchor | null {
    try {
      const fm = JSON.parse(selectedBook?.doc.frontmatter_json ?? "{}") as {
        readerAnchor?: ReaderAnchor;
      };
      const a = fm.readerAnchor;
      if (a && typeof a.ratio === "number") return { section: a.section ?? null, ratio: a.ratio };
    } catch {
      /* no anchor yet */
    }
    return null;
  }

  async function openBook(entry: BookshelfEntry) {
    selectedBook = entry;
    $currentDoc = entry.doc;
    if (!$openTabs.find((t) => t.id === entry.doc.id)) $openTabs = [entry.doc, ...$openTabs];
    readerContent = await processTransclusions(entry.doc.content || '');
    readSections = splitSections(readerContent);
    readerPosition = entry.doc.reading_position || 0;
    marginNotes = readMarginNotes(entry.doc.frontmatter_json);
    noteDraft = "";
    noteQuote = "";
    readSectionIdx = null;
    const anchor = readAnchor();
    // Render at least through the anchored section, then restore once
    // fonts settle (document.fonts.ready, not a single rAF that fires
    // before webfonts shift layout). Falls back to the plain ratio.
    const anchorIdx = anchor?.section
      ? Math.max(0, readSections.findIndex((s) => s.id === anchor.section))
      : -1;
    renderedCount = Math.min(readSections.length, Math.max(12, anchorIdx + 2));
    // Wait for Svelte to flush the sections first (restore() measuring a
    // pre-flush DOM saw scrollHeight=0 and gave up permanently), then for
    // fonts, retrying a few frames — layout shifts under us otherwise.
    const restore = async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        await tick();
        const el = scrollEl;
        if (!el) return;
        const max = el.scrollHeight - el.clientHeight;
        if (max > 0) {
          if (anchor?.section) {
            const at = scrollTopFor(anchor, measuredSections(), max);
            if (at !== null) {
              el.scrollTop = at;
              return;
            }
          }
          if (readerPosition > 0) el.scrollTop = readerPosition * max;
          return;
        }
        await new Promise((r) => requestAnimationFrame(r));
      }
    };
    if (typeof document !== "undefined" && document.fonts?.ready) {
      let done = false;
      const go = () => {
        if (!done) {
          done = true;
          void restore();
        }
      };
      document.fonts.ready.then(go).catch(go);
      setTimeout(go, 1500);
    } else {
      void restore();
    }

    if (entry.shelf_status === 'to-read') {
      await api.readerSetShelfStatus(entry.doc.id, 'reading');
      entry.shelf_status = 'reading';
    }
  }

  function closeBook() {
    void savePosition();
    selectedBook = null;
    readerContent = '';
    marginNotes = [];
    showNotes = false;
  }

  async function handleScroll(e: Event) {
    if (!selectedBook) return;
    const el = e.target as HTMLElement;
    const max = el.scrollHeight - el.clientHeight;
    const pct = max > 0 ? el.scrollTop / max : 0;
    readerPosition = pct;
    // Progressive window: append sections near the bottom (cheap,
    // scroll-driven — no observer lifecycle to leak).
    if (max > 0 && el.scrollTop + el.clientHeight > max - 2000) {
      if (renderedCount < readSections.length) renderedCount = Math.min(readSections.length, renderedCount + 8);
    }
    // Debounced position sync (plain handle: event context only).
    if (posSaveTimer) clearTimeout(posSaveTimer);
    posSaveTimer = setTimeout(() => {
      void savePosition();
    }, 1500);
  }

  async function savePosition() {
    if (!selectedBook) return;
    const el = scrollEl;
    // Heading-anchored position (survives reflow); the plain ratio stays
    // as fallback AND as the persisted reading_position (back-compat).
    let anchor: ReaderAnchor = { section: null, ratio: readerPosition };
    if (el && el.scrollHeight > el.clientHeight) {
      anchor = anchorFor(measuredSections(), el.scrollTop + el.clientHeight * 0.4);
      if (!anchor.section) anchor = { section: null, ratio: readerPosition };
    }
    await api.readerUpdatePosition(selectedBook.doc.id, readerPosition);
    try {
      const fm = JSON.parse(selectedBook.doc.frontmatter_json ?? "{}");
      fm.readerAnchor = anchor;
      const updated = await api.docSave(selectedBook.doc.id, undefined, undefined, undefined, JSON.stringify(fm));
      selectedBook.doc = { ...selectedBook.doc, frontmatter_json: updated.frontmatter_json };
    } catch {
      /* anchor is best-effort; the ratio already persisted */
    }
  }

  async function finishBook() {
    if (!selectedBook) return;
    await savePosition();
    await api.readerSetShelfStatus(selectedBook.doc.id, 'finished');
    selectedBook.shelf_status = 'finished';
  }

  /** Tap a star to rate; tap the current rating again to clear it. */
  async function setRating(n: number) {
    if (!selectedBook) return;
    const next = selectedBook.rating === n ? null : n;
    try {
      await api.readerSetRating(selectedBook.doc.id, next);
      selectedBook.rating = next;
    } catch (e) {
      showToast(`Couldn't save rating: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  async function handleImport(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".epub") || lower.endsWith(".pdf") || lower.endsWith(".docx")) {
        showToast(`Extracting text from ${file.name}…`, "info");
      }
      const res = await readImportFile(file);
      if (res.encodingNote) showToast(res.encodingNote, "warning");
      // Fountain keeps its kind so Script-style structure survives the
      // round trip; everything else shelves as md text.
      const kind = res.ext === "fountain" ? "fountain" : "md";
      const doc = await api.readerImportBook(res.title, res.text, kind);
      await shelveCover(doc, res.cover);
      const entry: BookshelfEntry = { doc, shelf_status: 'to-read', rating: null };
      books.unshift(entry);
      showToast(`Imported "${res.title}"`, 'success');
    } catch (err) {
      domainError('Reader', "couldn't import book", err);
    }

    if (importInput) importInput.value = '';
  }

  /**
   * Parse book bytes (epub/pdf/docx via $lib/bookparse, lazy-loaded so the
   * heavy pdf.js engine only downloads on first book import) and shelve the
   * extracted text. Text lands in the doc body, so position sync, search,
   * and export keep working. Shared by file import and PDF preview import.
   */
  async function importBookBytes(ext: string, fileName: string, data: Uint8Array): Promise<void> {
    showToast(`Extracting text from ${fileName}…`, 'info');
    const { parseBookFile } = await import('$lib/bookparse');
    let worker: string | undefined;
    if (ext === 'pdf') {
      worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
    }
    const book = await parseBookFile(fileName, data, worker);
    const doc = await api.readerImportBook(book.title, book.text, ext);
    await shelveCover(doc, book.cover ?? null);
    const entry: BookshelfEntry = { doc, shelf_status: 'to-read', rating: null };
    books.unshift(entry);
    showToast(`Imported "${book.title}"`, 'success');
  }

  /**
   * EPUB cover art → vault attachment referenced from frontmatter (same
   * pattern as Novel projects). Cover extraction itself is Area 9's job;
   * this only renders the slot (kind badge when empty).
   */
  async function shelveCover(doc: Doc, cover: { b64: string; mime: string } | null | undefined) {
    if (!cover?.b64) return;
    try {
      const ext = cover.mime.includes("png") ? "png" : "jpg";
      const ref = await api.attachmentSave(`cover.${ext}`, cover.b64);
      const updated = await api.docSave(doc.id, undefined, undefined, undefined, JSON.stringify({ cover: ref }));
      doc.frontmatter_json = updated.frontmatter_json;
    } catch {
      /* cover art is dressing — a bad image never fails the import */
    }
  }

  /** PDF page preview: stash bytes for PdfViewer (import stays text-only). */
  async function handlePreviewPick(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (previewInput) previewInput.value = '';
    if (!file) return;
    try {
      pdfPreview = { data: new Uint8Array(await file.arrayBuffer()), name: file.name };
    } catch (err) {
      showToast(`Couldn't read ${file.name}: ${err instanceof Error ? err.message : err}`, 'error');
    }
  }

  async function importPreviewedPdf() {
    if (!pdfPreview) return;
    try {
      await importBookBytes('pdf', pdfPreview.name, pdfPreview.data);
      pdfPreview = null;
    } catch (err) {
      domainError('Reader', "couldn't import book", err);
    }
  }

  function renderStars(rating: number | null): string {
    if (rating == null) return '☆☆☆☆☆';
    return '★'.repeat(rating) + '☆'.repeat(5 - rating);
  }

  loadBooks();
</script>

<div class="reader-workspace">
  {#if !selectedBook}
    <div class="bookshelf">
      <div class="shelf-header">
        <h1>Reader</h1>
        <div class="shelf-actions">
          <button class="import-btn" onclick={() => previewInput?.click()} title="Preview PDF pages before importing">
            Preview PDF
          </button>
          <input
            bind:this={previewInput}
            type="file"
            accept=".pdf"
            onchange={handlePreviewPick}
            hidden
          />
          <button class="import-btn" onclick={() => importInput?.click()}>
            + Import
          </button>
          <input
            bind:this={importInput}
            type="file"
            accept=".epub,.pdf,.docx,.md,.txt,.fountain"
            onchange={handleImport}
            hidden
          />
        </div>
      </div>

      <div class="shelf-tabs">
        {#each [['all','All'], ['to-read','To Read'], ['reading','Reading'], ['finished','Finished']] as [key, label]}
          <button
            class="shelf-tab"
            class:active={shelfFilter === key}
            onclick={() => setFilter(key)}
          >
            {label}
          </button>
        {/each}
      </div>

      {#if loading}
        <div class="shelf-empty">Loading...</div>
      {:else if booksLoadError}
        <WorkspaceError message={`Reader — couldn't load bookshelf: ${booksLoadError}`} onRetry={() => loadBooks()} />
      {:else if books.length === 0}
        <div class="shelf-empty">
          <p>Your bookshelf is empty.</p>
          <p>Import an EPUB, PDF, DOCX, Markdown, or Fountain file — text is extracted for reading, search, and position sync.</p>
        </div>
      {:else}
        <div class="shelf-grid">
          {#each books as entry}
            <button class="book-card" onclick={() => openBook(entry)}>
              <div class="book-cover">
                {#if bookCover(entry.doc)}
                  <img class="book-cover-img" src={bookCover(entry.doc)} alt="" />
                {:else}
                  <span class="book-kind">{entry.doc.kind.toUpperCase()}</span>
                {/if}
              </div>
              <div class="book-info">
                <div class="book-title">{entry.doc.title}</div>
                <div class="book-status">{entry.shelf_status}</div>
                {#if (entry.doc.reading_position ?? 0) > 0}
                  <div
                    class="book-progress"
                    role="progressbar"
                    aria-label="Reading progress"
                    aria-valuenow={bookProgress(entry)}
                    aria-valuemin={0}
                    aria-valuemax={100}
                  >
                    <span class="book-progress-fill" style="width: {bookProgress(entry)}%"></span>
                  </div>
                {/if}
                {#if entry.rating != null}
                  <div class="book-rating">{renderStars(entry.rating)}</div>
                {/if}
              </div>
            </button>
          {/each}
        </div>
      {/if}
    </div>
  {:else}
    <div class="reader-view">
      <div class="reader-toolbar">
        <button class="back-btn" onclick={closeBook}>← Back</button>
        <span class="reader-title">{selectedBook.doc.title}</span>
        <div class="rate-group" role="group" aria-label="Rate this book">
          {#each [1, 2, 3, 4, 5] as n}
            <button
              class="rate-star"
              class:lit={selectedBook.rating != null && n <= selectedBook.rating}
              onclick={() => setRating(n)}
              title={selectedBook.rating === n ? 'Clear rating' : `Rate ${n} star${n > 1 ? 's' : ''}`}
              aria-label={selectedBook.rating === n ? 'Clear rating' : `Rate ${n} star${n > 1 ? 's' : ''}`}
            >{selectedBook.rating != null && n <= selectedBook.rating ? '★' : '☆'}</button>
          {/each}
        </div>
        <button class="finish-btn" onclick={finishBook}>Mark Finished</button>
        <button
          class="notes-btn"
          class:active={showNotes}
          onclick={() => (showNotes = !showNotes)}
          title={showNotes ? "Hide margin notes" : "Show margin notes"}
          aria-label={showNotes ? "Hide margin notes" : "Show margin notes"}
          aria-pressed={showNotes}
        >
          Notes{#if marginNotes.length > 0} ({marginNotes.length}){/if}
        </button>
        {#if $settings.ttsEnabled}
          <ReadAloudButton
            getText={() => sectionTexts.join("\n\n")}
            getSelection={() => {
              const selection = window.getSelection();
              return selection && selection.rangeCount > 0 ? selection.toString() : '';
            }}
            getSections={ttsSections}
            onSection={handleTtsSection}
          />
        {/if}
      </div>
      <div class="reader-controls" role="toolbar" aria-label="Reading controls">
        <label class="ctl">
          <span class="ctl-label">Font</span>
          <select
            bind:value={$settings.readerFont}
            aria-label="Reading font"
          >
            <option value="serif">Serif</option>
            <option value="sans">Sans</option>
            <option value="mono">Mono</option>
          </select>
        </label>
        <div class="ctl size-ctl" role="group" aria-label="Text size">
          <button onclick={() => bumpSize(-1)} title="Smaller text" aria-label="Smaller text">A−</button>
          <span class="size-val">{$settings.readerSize}</span>
          <button onclick={() => bumpSize(1)} title="Larger text" aria-label="Larger text">A+</button>
          <button onclick={resetSize} title="Reset to base font size" aria-label="Reset text size">Reset</button>
        </div>
        <button class="ctl-btn" onclick={cycleMeasure} title="Reading measure">
          {$settings.readerMeasure === "narrow" ? "Narrow" : $settings.readerMeasure === "wide" ? "Wide" : "Comfortable"}
        </button>
        <button class="ctl-btn" onclick={cycleReaderTheme} title="Reading theme">
          {$settings.readerTheme === "app" ? "Theme: App" : $settings.readerTheme === "light" ? "Theme: Light" : $settings.readerTheme === "sepia" ? "Theme: Sepia" : "Theme: Dark"}
        </button>
      </div>
      <div class="reader-body">
        <DockSplit
          direction="horizontal"
          defaultPct={72}
          storageKey="jwe-split-reader"
          topLabel="Notes panel width"
          hasBottom={showNotes}
        >
          {#snippet top()}
        <div class="reader-content" bind:this={scrollEl} onscroll={handleScroll}>
          {#each readSections.slice(0, renderedCount) as section, i (section.id)}
            <ReaderProse
              html={sectionHtml[i] ?? ""}
              font={$settings.readerFont}
              sizePx={$settings.readerSize}
              measure={$settings.readerMeasure}
              theme={$settings.readerTheme}
              sectionId={section.id}
              active={readSectionIdx === i}
            />
          {/each}
          {#if renderedCount < readSections.length}
            <div class="reader-more" aria-hidden="true">Continuing…</div>
          {/if}
        </div>
          {/snippet}
          {#snippet bottom()}
        {#if showNotes}
          <aside class="notes-panel" aria-label="Margin notes">
            <div class="notes-header">
              <span class="notes-title">Margin notes</span>
              <span class="notes-count">{marginNotes.length}</span>
              {#if marginNotes.length > 0}
                <button class="note-export" onclick={exportNotes} title="Export notes as new doc" aria-label="Export notes">
                  <Icon name="download" size={14} />
                </button>
              {/if}
            </div>
            <div class="note-composer">
              {#if noteQuote}
                <div class="note-quote">
                  <span>{noteQuote}</span>
                  <button onclick={() => (noteQuote = "")} title="Clear quote" aria-label="Clear quote">×</button>
                </div>
              {:else}
                <button class="quote-btn" onclick={captureQuote} title="Quote the selected passage">
                  Quote selection
                </button>
              {/if}
              <textarea
                class="note-input"
                bind:value={noteDraft}
                placeholder="Write in the margin…"
                aria-label="New margin note"
                rows={2}
              ></textarea>
              <button class="note-add" onclick={addNote} disabled={!noteDraft.trim()}>
                Add note here
              </button>
            </div>
            <div class="notes-list">
              {#each [...marginNotes].reverse() as note}
                <div class="note-card">
                  {#if note.quote}
                    <button class="note-card-quote" onclick={() => jumpToNote(note)} title="Jump to passage">
                      “{note.quote}”
                    </button>
                  {/if}
                  <div class="note-card-text">{note.text}</div>
                  <div class="note-card-meta">
                    <button onclick={() => jumpToNote(note)} title="Jump to position">{noteTime(note.created_at)}</button>
                    <button
                      class="note-delete"
                      onclick={() => deleteNote(note.id)}
                      title="Delete note"
                      aria-label="Delete note"
                    >×</button>
                  </div>
                </div>
              {:else}
                <div class="notes-empty">No margin notes yet — select a passage, quote it, write.</div>
              {/each}
            </div>
          </aside>
        {/if}
          {/snippet}
        </DockSplit>
      </div>
    </div>
  {/if}
  {#if pdfPreview}
    <div class="pdf-preview-overlay" onclick={(e) => { if (e.target === e.currentTarget) pdfPreview = null; }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') pdfPreview = null; }}>
      <div class="pdf-preview-panel" role="dialog" aria-label="PDF preview" tabindex="-1">
        <PdfViewer
          data={pdfPreview.data}
          title={pdfPreview.name}
          onClose={() => (pdfPreview = null)}
          onImport={importPreviewedPdf}
        />
      </div>
    </div>
  {/if}
</div>

<style>
  .reader-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .bookshelf {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--space-4);
  }

  .shelf-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-3);
  }

  .shelf-header h1 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
    color: var(--text-primary);
  }

  .shelf-tabs {
    display: flex;
    gap: var(--space-1);
    margin-bottom: var(--space-4);
  }

  .shelf-tab {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-full);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .shelf-tab.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .shelf-empty {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
  }

  .shelf-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: var(--space-4);
  }

  .book-card {
    display: flex;
    flex-direction: column;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    overflow: hidden;
    cursor: pointer;
    text-align: left;
    padding: 0;
    color: var(--text-primary);
  }

  .book-cover {
    height: 180px;
    background: var(--surface-overlay);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .book-kind {
    font-family: var(--font-mono);
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    letter-spacing: 0.05em;
  }

  .book-info {
    padding: var(--space-3);
  }

  .book-title {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    margin-bottom: var(--space-1);
  }

  .book-status {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    text-transform: capitalize;
  }

  .book-rating {
    font-size: var(--font-size-xs);
    color: var(--accent-primary);
    margin-top: var(--space-1);
  }

  .import-btn {
    padding: var(--space-2) var(--space-4);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .reader-view {
    display: flex;
    flex-direction: column;
    height: 100%;
  }

  .reader-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .back-btn,
  .finish-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .finish-btn {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .notes-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .notes-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .notes-btn.active {
    border-color: var(--accent-primary);
    color: var(--accent-primary);
  }

  .reader-body {
    flex: 1;
    min-height: 0;
    display: flex;
    overflow: hidden;
  }

  .notes-panel {
    flex: 1 1 auto;
    min-height: 0;
    background: var(--surface-base);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .notes-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    padding: var(--space-3) var(--space-4) var(--space-2);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .notes-title {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-secondary);
  }

  .notes-count {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .note-composer {
    padding: var(--space-3) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .quote-btn {
    align-self: flex-start;
    font-size: 11px;
    padding: 3px 10px;
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }

  .quote-btn:hover {
    color: var(--text-primary);
    border-color: var(--accent-primary);
  }

  .note-quote {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    font-size: 11px;
    font-style: italic;
    color: var(--text-secondary);
    border-left: 2px solid var(--accent-primary);
    padding-left: var(--space-2);
  }

  .note-quote button {
    flex-shrink: 0;
    color: var(--text-muted);
    font-size: 13px;
    line-height: 1;
  }

  .note-input {
    min-height: 52px;
    resize: vertical;
    padding: var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: 13px;
    font-family: var(--font-body);
  }

  .note-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .note-add {
    align-self: flex-end;
    font-size: 12px;
    padding: 4px 12px;
    border-radius: var(--radius-md);
    border: 1px solid var(--accent-primary);
    background: transparent;
    color: var(--accent-primary);
    cursor: pointer;
  }

  .note-add:hover:not(:disabled) {
    background: var(--surface-overlay);
  }

  .note-add:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .notes-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .note-card {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-raised);
  }

  .note-card-quote {
    display: block;
    width: 100%;
    text-align: left;
    font-size: 11px;
    font-style: italic;
    color: var(--text-secondary);
    border-left: 2px solid var(--accent-primary);
    padding-left: var(--space-2);
    margin-bottom: var(--space-1);
    cursor: pointer;
  }

  .note-card-quote:hover {
    color: var(--accent-primary);
  }

  .note-card-text {
    font-size: 13px;
    line-height: var(--line-height-relaxed);
    white-space: pre-wrap;
    word-break: break-word;
  }

  .note-card-meta {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: var(--space-1);
    font-size: 10px;
    color: var(--text-muted);
  }

  .note-card-meta button {
    color: var(--text-muted);
    cursor: pointer;
    font-size: 10px;
  }

  .note-card-meta button:hover {
    color: var(--text-primary);
  }

  .note-delete:hover {
    color: var(--accent-semantic-red) !important;
  }

  .notes-empty {
    font-size: 12px;
    font-style: italic;
    color: var(--text-muted);
    text-align: center;
    padding: var(--space-4) 0;
  }

  .reader-title {
    flex: 1;
    text-align: center;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
  }

  .rate-group {
    display: flex;
    gap: 2px;
    align-items: center;
  }

  .rate-star {
    background: none;
    border: none;
    padding: 2px;
    font-size: 16px;
    line-height: 1;
    color: var(--text-muted);
    cursor: pointer;
  }

  .rate-star:hover {
    color: var(--accent-primary);
    transform: scale(1.15);
  }

  .rate-star.lit {
    color: var(--accent-primary);
  }

  .reader-content {
    flex: 1;
    min-width: 0;
    overflow-y: auto;
    padding: var(--space-6);
  }

  /* One compact control row: font, size, measure, theme. Wraps on mobile. */
  .reader-controls {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-base);
    flex-shrink: 0;
  }

  .reader-controls .ctl {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-size: 12px;
    color: var(--text-secondary);
  }

  .reader-controls select {
    font-size: 12px;
    padding: 3px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    color: var(--text-primary);
  }

  .reader-controls .size-ctl {
    display: inline-flex;
    align-items: center;
    gap: 2px;
  }

  .reader-controls .size-ctl button,
  .reader-controls .ctl-btn {
    font-size: 12px;
    padding: 3px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    white-space: nowrap;
  }

  .reader-controls .size-ctl button:hover,
  .reader-controls .ctl-btn:hover {
    color: var(--text-primary);
    border-color: var(--accent-primary);
  }

  .reader-controls .size-val {
    min-width: 20px;
    text-align: center;
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-primary);
  }

  .reader-more {
    text-align: center;
    font-size: 12px;
    color: var(--text-muted);
    padding: var(--space-4);
  }

  .book-cover-img {
    width: 100%;
    height: 180px;
    object-fit: cover;
    display: block;
  }

  .book-progress {
    height: 4px;
    border-radius: 2px;
    background: var(--surface-overlay);
    overflow: hidden;
    margin-top: 6px;
  }

  .book-progress-fill {
    display: block;
    height: 100%;
    background: var(--accent-primary);
    border-radius: 2px;
  }

  @media (max-width: 480px) {
    .reader-content {
      padding: var(--space-3);
    }

    .reader-toolbar {
      flex-wrap: wrap;
      row-gap: 6px;
    }
  }



  .pdf-preview-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: var(--bg-primary);
  }

  .pdf-preview-panel {
    width: min(880px, 100%);
    height: min(90vh, 900px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    background: var(--surface-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
  }

  .note-export {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    color: var(--text-secondary);
    background: transparent;
  }

  .note-export:hover {
    color: var(--accent-primary);
    border-color: var(--accent-primary);
  }
</style>
