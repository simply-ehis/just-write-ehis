<script lang="ts">
  import { api, type Doc, type BookshelfEntry } from '$lib/api';
  import { currentDoc } from '$lib/stores/app';
  import { showToast } from '$lib/stores/notifications';
  import { settings } from '$lib/stores/settings';
  import { processTransclusions } from '$lib/transclude';
  import ReadAloudButton from '$lib/components/ReadAloudButton.svelte';
  import PdfViewer from '$lib/components/PdfViewer.svelte';

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

  async function loadBooks() {
    loading = true;
    try {
      const filter = shelfFilter === 'all' ? undefined : shelfFilter;
      books = await api.readerGetBookshelf(filter);
    } catch (e) {
      console.error('Failed to load bookshelf:', e);
    } finally {
      loading = false;
    }
  }

  function setFilter(f: string) {
    shelfFilter = f;
    loadBooks();
  }

  async function openBook(entry: BookshelfEntry) {
    selectedBook = entry;
    currentDoc.set(entry.doc);
    readerContent = await processTransclusions(entry.doc.content || '');
    readerPosition = entry.doc.reading_position || 0;

    if (entry.shelf_status === 'to-read') {
      await api.readerSetShelfStatus(entry.doc.id, 'reading');
      entry.shelf_status = 'reading';
    }
  }

  function closeBook() {
    selectedBook = null;
    readerContent = '';
  }

  async function handleScroll(e: Event) {
    if (!selectedBook) return;
    const el = e.target as HTMLElement;
    const pct = el.scrollTop / (el.scrollHeight - el.clientHeight || 1);
    readerPosition = pct;
  }

  async function savePosition() {
    if (selectedBook) {
      await api.readerUpdatePosition(selectedBook.doc.id, readerPosition);
    }
  }

  async function finishBook() {
    if (!selectedBook) return;
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

    const ext = file.name.split('.').pop()?.toLowerCase();
    const fallbackTitle = file.name.replace(/\.[^.]+$/, '');

    try {
      let title = fallbackTitle;
      let content: string;
      let kind: string;
      if (ext === 'md' || ext === 'txt' || ext === 'fountain') {
        content = await file.text();
        if (content.includes('\0')) {
          showToast('That file looks binary, not text — import refused.', 'error');
          if (importInput) importInput.value = '';
          return;
        }
        kind = ext === 'fountain' ? 'fountain' : 'md';
      } else if (ext === 'epub' || ext === 'pdf' || ext === 'docx') {
        const data = new Uint8Array(await file.arrayBuffer());
        await importBookBytes(ext, file.name, data);
        if (importInput) importInput.value = '';
        return;
      } else {
        showToast(`.${ext ?? '?'} isn't importable — use .epub, .pdf, .docx, .md, .txt, or .fountain.`, 'warning');
        if (importInput) importInput.value = '';
        return;
      }
      const doc = await api.readerImportBook(title, content, kind);
      const entry: BookshelfEntry = { doc, shelf_status: 'to-read', rating: null };
      books.unshift(entry);
      showToast(`Imported "${title}"`, 'success');
    } catch (err) {
      console.error('Import failed:', err);
      showToast(`Import failed: ${err instanceof Error ? err.message : err}`, 'error');
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
    const entry: BookshelfEntry = { doc, shelf_status: 'to-read', rating: null };
    books.unshift(entry);
    showToast(`Imported "${book.title}"`, 'success');
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
      console.error('Import failed:', err);
      showToast(`Import failed: ${err instanceof Error ? err.message : err}`, 'error');
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
                <span class="book-kind">{entry.doc.kind.toUpperCase()}</span>
              </div>
              <div class="book-info">
                <div class="book-title">{entry.doc.title}</div>
                <div class="book-status">{entry.shelf_status}</div>
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
        {#if $settings.ttsEnabled}
          <ReadAloudButton
            getText={() => readerContent}
            getSelection={() => {
              const selection = window.getSelection();
              return selection && selection.rangeCount > 0 ? selection.toString() : '';
            }}
          />
        {/if}
      </div>
      <div class="reader-content" onscroll={handleScroll}>
        <div class="reader-prose">
          {@html readerContent}
        </div>
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
    overflow-y: auto;
    padding: var(--space-6);
  }

  .reader-prose {
    max-width: 700px;
    margin: 0 auto;
    font-family: var(--font-body);
    font-size: var(--font-size-lg);
    line-height: var(--line-height-relaxed);
    color: var(--text-primary);
    white-space: pre-wrap;
  }

  /* Transclusion styles: transclude.ts injects raw `.transclude*` HTML
     via {@html}, so the inner selectors are :global (invisible to the
     compiler's unused-selector check but live at runtime). */
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

  .pdf-preview-overlay {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-4);
    background: rgba(0, 0, 0, 0.55);
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
</style>
