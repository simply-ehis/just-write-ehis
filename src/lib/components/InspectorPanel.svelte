<script lang="ts">
  import { onMount } from "svelte";
  import { api, type Backlink, type Doc, type UnlinkedMention } from "$lib/api";
  import { currentDoc, openTabs, inspectorOpen } from "$lib/stores/app";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "$lib/components/Icon.svelte";

  let backlinks = $state<Backlink[]>([]);
  let outgoingBacklinks = $state<Backlink[]>([]);
  let unlinked = $state<UnlinkedMention[]>([]);
  let headings = $state<{ level: number; text: string; line: number }[]>([]);
  let properties = $state<Record<string, unknown>>({});
  let activeTab = $state<'outline' | 'properties' | 'backlinks'>('outline');

  function extractHeadings(content: string): { level: number; text: string; line: number }[] {
    const lines = content.split('\n');
    const result: { level: number; text: string; line: number }[] = [];
    for (let i = 0; i < lines.length; i++) {
      const match = lines[i].match(/^(#{1,6})\s+(.+)/);
      if (match) {
        result.push({ level: match[1].length, text: match[2].trim(), line: i });
      }
    }
    return result;
  }

  function parseProperties(fmJson: string | null): Record<string, unknown> {
    if (!fmJson) return {};
    try {
      return JSON.parse(fmJson);
    } catch {
      return {};
    }
  }

  /** Outgoing [[wikilinks]] in reading order, deduped, case-preserved. */
  function parseOutgoing(content: string): Backlink[] {
    const seen = new Set<string>();
    const out: Backlink[] = [];
    const re = /\[\[([^\[\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const title = m[1].trim();
      if (!title || title.startsWith("!")) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const line = content.slice(0, m.index).split("\n").pop() ?? "";
      out.push({
        source_id: $currentDoc?.id ?? "",
        target_id: title,
        context_snippet: line.trim().slice(0, 140) || `[[${title}]]`,
        source_title: $currentDoc?.title ?? "",
      });
    }
    return out;
  }

  /** Jump to an outgoing link target by title (resolves via full search). */
  async function openOutgoing(title: string) {
    try {
      const results = await api.docSearchFull(title);
      const match =
        results.find((r) => r.doc.title.toLowerCase() === title.toLowerCase()) ?? results[0];
      if (!match) {
        showToast(`No doc titled "${title}" yet`, "warning");
        return;
      }
      await openBacklink(match.doc.id);
    } catch (e) {
      showToast(`Couldn't open link: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function loadInspector(doc: Doc) {
    // Extract headings from content
    headings = extractHeadings(doc.content || '');

    // Outgoing links: [[wikilinks]] authored in this doc (frontend parse —
    // the backend backlinks table only stores the incoming direction).
    outgoingBacklinks = parseOutgoing(doc.content || '');

    // Parse frontmatter
    properties = parseProperties(doc.frontmatter_json);

    // Load backlinks
    try {
      const incoming = await api.backlinksGet(doc.id);
      backlinks = incoming;
    } catch {
      backlinks = [];
    }

    // Unlinked mentions: titles this doc names without linking to.
    try {
      unlinked = await api.unlinkedMentions(doc.id);
    } catch {
      unlinked = [];
    }
  }

  async function openHeading(line: number) {
    if (!$currentDoc) return;
    // Dispatch event for EditorPane to scroll to line
    window.dispatchEvent(new CustomEvent("editor-scroll-to-line", { detail: { line } }));
    await api.usageRecord($currentDoc.id, "open").catch(() => {});
  }

  async function openBacklink(sourceId: string) {
    try {
      const doc = await api.docGet(sourceId);
      $currentDoc = doc;
      if (!$openTabs.find(t => t.id === doc.id)) {
        $openTabs = [doc, ...$openTabs];
      }
      await api.usageRecord(doc.id, "open");
    } catch (e) {
      console.error("Failed to open backlink:", e);
    }
  }

  function getHeadingIndent(level: number): string {
    return `${(level - 1) * 12}px`;
  }

  /** Turn the first bare mention into a real [[wikilink]] in place. */
  async function linkMention(m: UnlinkedMention) {
    if (!$currentDoc) return;
    const idx = $currentDoc.content.toLowerCase().indexOf(m.mentioned_title.toLowerCase());
    if (idx < 0) {
      showToast("Mention no longer found in the text", "warning");
      return;
    }
    const before = $currentDoc.content.slice(0, idx);
    const match = $currentDoc.content.slice(idx, idx + m.mentioned_title.length);
    const after = $currentDoc.content.slice(idx + m.mentioned_title.length);
    // Don't double-link what's already bracketed.
    if (before.endsWith("[[") && after.startsWith("]]")) {
      showToast("Already linked", "info");
      return;
    }
    try {
      const updated = await api.docSave($currentDoc.id, undefined, `${before}[[${match}]]${after}`);
      $currentDoc = updated;
      unlinked = unlinked.filter((u) => u.mentioned_title !== m.mentioned_title);
      backlinks = await api.backlinksGet(updated.id).catch(() => backlinks);
      showToast(`Linked [[${m.mentioned_title}]]`, "success");
    } catch (e) {
      showToast(`Couldn't link: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  $effect(() => {
    const doc = $currentDoc;
    if (doc) {
      loadInspector(doc);
    } else {
      headings = [];
      properties = {};
      backlinks = [];
      unlinked = [];
    }
  });
</script>

<div class="inspector-panel">
  <div class="inspector-tabs">
    <button class:active={activeTab === 'outline'} onclick={() => activeTab = 'outline'}>Outline</button>
    <button class:active={activeTab === 'properties'} onclick={() => activeTab = 'properties'}>Props</button>
    <button class:active={activeTab === 'backlinks'} onclick={() => activeTab = 'backlinks'}>Links</button>
    <button class="icon-btn insp-close" onclick={() => ($inspectorOpen = false)} title="Hide inspector (Ctrl+I)" aria-label="Hide inspector">
      <Icon name="x" size={13} />
    </button>
  </div>

  <div class="inspector-content">
    {#if !$currentDoc}
      <div class="empty-inspector">Select a document</div>
    {:else if activeTab === 'outline'}
      {#if headings.length === 0}
        <div class="empty-inspector">No headings found</div>
      {:else}
        <div class="outline-list">
          {#each headings as heading}
            <button
              class="outline-item"
              style="padding-left: {getHeadingIndent(heading.level)}"
              onclick={() => openHeading(heading.line)}
            >
              <span class="heading-mark">H{heading.level}</span>
              <span class="heading-text">{heading.text}</span>
            </button>
          {/each}
        </div>
      {/if}

    {:else if activeTab === 'properties'}
      {#if Object.keys(properties).length === 0}
        <div class="empty-inspector">No properties set</div>
      {:else}
        <div class="props-list">
          {#each Object.entries(properties) as [key, value]}
            <div class="prop-item">
              <span class="prop-key">{key}</span>
              <span class="prop-value">{typeof value === 'string' ? value : JSON.stringify(value)}</span>
            </div>
          {/each}
        </div>
      {/if}
      <div class="prop-meta">
        <div class="meta-row">
          <span class="meta-label">Status</span>
          <span class="meta-value">{$currentDoc.status || 'none'}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Words</span>
          <span class="meta-value">{$currentDoc.word_count.toLocaleString()}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Created</span>
          <span class="meta-value">{new Date($currentDoc.created_at).toLocaleDateString()}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Modified</span>
          <span class="meta-value">{new Date($currentDoc.updated_at).toLocaleDateString()}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Workspace</span>
          <span class="meta-value">{$currentDoc.workspace}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Activity</span>
          <span class="meta-value">{$currentDoc.activity_score.toFixed(1)}</span>
        </div>
      </div>

      <div class="goal-section">
        <div class="goal-header">Goal & Deadline</div>
        <div class="goal-fields">
          <label class="goal-label">
            <span>Target words</span>
            <input
              type="number"
              class="goal-input"
              value={$currentDoc.goal_words ?? ''}
              placeholder="e.g. 50000"
              min="0"
              onblur={async (e) => {
                const val = e.currentTarget.value ? parseInt(e.currentTarget.value) : undefined;
                if ($currentDoc) {
                  await api.docSetGoal($currentDoc.id, val, $currentDoc.deadline ?? undefined);
                  $currentDoc = { ...$currentDoc, goal_words: val };
                }
              }}
            />
          </label>
          <label class="goal-label">
            <span>Deadline</span>
            <input
              type="date"
              class="goal-input"
              value={$currentDoc.deadline?.slice(0, 10) ?? ''}
              onblur={async (e) => {
                const val = e.currentTarget.value || undefined;
                if ($currentDoc) {
                  await api.docSetGoal($currentDoc.id, $currentDoc.goal_words ?? undefined, val);
                  $currentDoc = { ...$currentDoc, deadline: val };
                }
              }}
            />
          </label>
        </div>
        {#if $currentDoc.goal_words}
          {@const pct = Math.min(100, Math.round(($currentDoc.word_count / $currentDoc.goal_words) * 100))}
          <div class="goal-progress">
            <div class="progress-bar">
              <div class="progress-fill" style="width: {pct}%"></div>
            </div>
            <span class="progress-text">{$currentDoc.word_count.toLocaleString()} / {$currentDoc.goal_words.toLocaleString()} words ({pct}%)</span>
          </div>
        {/if}
      </div>

    {:else if activeTab === 'backlinks'}
      {#if outgoingBacklinks.length > 0}
        <div class="unlinked-header">Links in this doc ({outgoingBacklinks.length})</div>
        <div class="backlinks-list">
          {#each outgoingBacklinks as out}
            <button class="backlink-item" onclick={() => openOutgoing(out.target_id)} title="Open {out.target_id}">
              <span class="backlink-title">→ {out.target_id}</span>
              <span class="backlink-context">{out.context_snippet}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if backlinks.length === 0 && outgoingBacklinks.length === 0}
        <div class="empty-inspector">No links yet — write [[a link]] to start the graph.</div>
      {:else if backlinks.length > 0}
        <div class="unlinked-header">Linked from elsewhere</div>
        <div class="backlinks-list">
          {#each backlinks as bl}
            <button class="backlink-item" onclick={() => openBacklink(bl.source_id)} title="Open {bl.source_title || bl.source_id}">
              {#if bl.source_title}<span class="backlink-title">{bl.source_title}</span>{/if}
              <span class="backlink-context">{bl.context_snippet}</span>
            </button>
          {/each}
        </div>
      {/if}
      {#if unlinked.length > 0}
        <div class="unlinked-header">Mentioned but not linked</div>
        <div class="backlinks-list">
          {#each unlinked as m}
            <div class="unlinked-item">
              <button class="backlink-item" onclick={() => openBacklink(m.source_id)}>
                <span class="backlink-context">{m.context_snippet}</span>
              </button>
              <button
                class="link-btn"
                onclick={() => linkMention(m)}
                title="Turn the first mention of {m.mentioned_title} into a [[link]]"
              >
                Link [[{m.mentioned_title}]]
              </button>
            </div>
          {/each}
        </div>
      {/if}
    {/if}
  </div>
</div>

<style>
  .inspector-panel {
    display: flex;
    flex-direction: column;
    height: 100%;
    width: 240px;
    border-left: 1px solid var(--border-subtle);
    background: var(--surface-base);
    flex-shrink: 0;
  }

  .inspector-tabs {
    display: flex;
    border-bottom: 1px solid var(--border-subtle);
  }

  .inspector-tabs button {
    flex: 1;
    padding: var(--space-2);
    border: none;
    background: transparent;
    color: var(--text-muted);
    font-size: 11px;
    font-weight: 500;
    cursor: pointer;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .inspector-tabs button:hover {
    color: var(--text-secondary);
    background: var(--surface-overlay);
  }

  .inspector-tabs button.active {
    color: var(--accent-primary);
    border-bottom: 2px solid var(--accent-primary);
  }

  .insp-close {
    flex: 0 0 auto;
    width: 28px;
  }

  .inspector-content {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
  }

  .empty-inspector {
    padding: var(--space-4);
    text-align: center;
    color: var(--text-muted);
    font-size: 12px;
    font-style: italic;
  }

  /* Outline */
  .outline-list {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }

  .outline-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 12px;
    text-align: left;
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .outline-item:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .heading-mark {
    font-size: 9px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
    width: 20px;
  }

  .heading-text {
    overflow: hidden;
    text-overflow: ellipsis;
  }

  /* Properties */
  .props-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-bottom: var(--space-3);
  }

  .prop-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
  }

  .prop-key {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    font-weight: 500;
  }

  .prop-value {
    font-size: 12px;
    color: var(--text-primary);
    word-break: break-word;
  }

  .prop-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    border-top: 1px solid var(--border-subtle);
    padding-top: var(--space-3);
  }

  .meta-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-1) 0;
  }

  .meta-label {
    font-size: 11px;
    color: var(--text-muted);
  }

  .meta-value {
    font-size: 11px;
    color: var(--text-secondary);
    font-family: var(--font-mono);
  }

  /* Backlinks */
  .backlinks-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .backlink-item {
    padding: var(--space-2);
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    border: none;
    text-align: left;
    cursor: pointer;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: var(--line-height-relaxed);
  }

  .backlink-item:hover {
    background: var(--surface-raised);
    color: var(--text-primary);
  }

  .backlink-context {
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    line-clamp: 3;
    overflow: hidden;
  }

  .backlink-title {
    display: block;
    font-weight: 600;
    font-size: 12px;
    color: var(--text-primary);
    margin-bottom: 2px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .unlinked-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin: var(--space-3) 0 var(--space-1);
  }

  .unlinked-item {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .unlinked-item .backlink-item {
    width: 100%;
  }

  .link-btn {
    align-self: flex-start;
    font-size: 11px;
    padding: 3px 10px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--accent-primary);
    color: var(--accent-primary);
  }

  .link-btn:hover {
    background: var(--surface-overlay);
  }

  .goal-section {
    border-top: 1px solid var(--border-subtle);
    padding-top: var(--space-3);
    margin-top: var(--space-3);
  }

  .goal-header {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: var(--space-2);
  }

  .goal-fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .goal-label {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .goal-label span {
    font-size: 11px;
    color: var(--text-muted);
  }

  .goal-input {
    height: 28px;
    padding: 0 var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: 12px;
  }

  .goal-input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .goal-progress {
    margin-top: var(--space-2);
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .progress-bar {
    height: 6px;
    background: var(--surface-overlay);
    border-radius: 3px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: var(--accent-primary);
    border-radius: 3px;
    transition: width 0.3s ease;
  }

  .progress-text {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }
</style>
