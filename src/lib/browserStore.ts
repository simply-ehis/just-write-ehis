/**
 * browserStore — in-browser document store backing the live web preview.
 *
 * The Tauri/Rust backend owns the real vault on desktop. In a plain browser
 * there is no Rust sidecar, so this module persists the same shape (docs,
 * snapshots, tabs, conversations, bible facts, usage days) to localStorage.
 * All methods are synchronous; the async boundary lives in browserBackend.
 */
import { extractEntities, entitySnippet, type ExtractedEntity } from "$lib/entities";

export interface BrowserDoc {
  id: string;
  workspace: string;
  kind: string;
  title: string;
  path: string;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
  content: string;
  word_count: number;
  reading_position: number | null;
  status: string;
  frontmatter_json: string | null;
  activity_score: number;
  embedding_ref: string | null;
  pinned?: boolean;
  goal_words?: number | null;
  deadline?: string | null;
  shelf_status?: string;
  rating?: number | null;
  locked?: boolean;
}

export interface BrowserMetric {
  doc_id: string;
  metric_type: string;
  value: number;
  created_at: string;
}

export interface BrowserCanvasNode {
  id: string;
  title: string;
  body: string;
  x: number;
  y: number;
  color: string;
  doc_id: string | null;
  updated_at: string;
}

export interface BrowserCanvasEdge {
  id: string;
  source_id: string;
  target_id: string;
  label: string;
}

export interface BrowserSnapshot {
  id: string;
  doc_id: string;
  label: string;
  content: string | null;
  word_count: number;
  created_at: string;
}

export interface BrowserConversation {
  id: string;
  doc_id: string | null;
  mode: string;
  created_at: string;
  updated_at: string;
}

export interface BrowserMessage {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  created_at: string;
}

export interface BrowserBibleFact {
  id: string;
  doc_id: string;
  kind: string;
  key: string;
  value: string;
}

export interface BrowserBibleMention {
  id: string;
  bible_doc_id: string;
  fact_key: string;
  kind: string;
  doc_id: string;
  doc_title: string;
  snippet: string;
  attribute_key: string | null;
  attribute_value: string | null;
  span_start: number | null;
  created_at: string;
}

export interface BrowserBibleSuggestion {
  id: string;
  bible_doc_id: string;
  source_doc_id: string;
  doc_title: string;
  kind: string;
  key: string;
  value: string;
  snippet: string;
  attribute_key: string | null;
  attribute_value: string | null;
  span_start: number | null;
  status: "pending" | "rejected";
  created_at: string;
}

const DOCS_KEY = "jwe-browser-docs-v1";
const SNAPS_KEY = "jwe-browser-snaps-v1";
const TABS_KEY = "jwe-browser-tabs-v1";
const CONV_KEY = "jwe-browser-conv-v1";
const MSG_KEY = "jwe-browser-msg-v1";
const BIBLE_KEY = "jwe-browser-bible-v1";
const BIBLE_MENTIONS_KEY = "jwe-browser-bible-mentions-v1";
const BIBLE_SUGGESTIONS_KEY = "jwe-browser-bible-suggestions-v1";
const DAYS_KEY = "jwe-browser-days-v1";
const BACKUP_KEY = "jwe-browser-backups-v1";
const METRICS_KEY = "jwe-browser-metrics-v1";
const RHYTHM_KEY = "jwe-browser-rhythm-v1";
const CANVAS_KEY = "jwe-browser-canvas-v1";
const OPENS_KEY = "jwe-browser-opens-v1";

export interface DocOpens {
  count: number;
  lastOpened: string;
  lastWrite: string | null;
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* corrupted storage reads as empty */
  }
  return fallback;
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota exceeded: keep running in memory */
  }
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

export function countWords(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

function snippetAround(content: string, index: number, matchLen: number): string {
  const start = Math.max(0, index - 60);
  const end = Math.min(content.length, index + matchLen + 60);
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

class BrowserStore {
  docs: BrowserDoc[] = [];
  snaps: BrowserSnapshot[] = [];
  tabs: Record<string, { tab_stack_json: string; active_id: string | null }> = {};
  conversations: BrowserConversation[] = [];
  messages: BrowserMessage[] = [];
  bible: BrowserBibleFact[] = [];
  bibleMentions: BrowserBibleMention[] = [];
  bibleSuggestions: BrowserBibleSuggestion[] = [];
  days: string[] = [];
  backups: [string, string, number][] = [];
  metrics: BrowserMetric[] = [];
  rhythm: Record<string, number[]> = {};
  canvas: { nodes: BrowserCanvasNode[]; edges: BrowserCanvasEdge[] } = { nodes: [], edges: [] };
  opens: Record<string, DocOpens> = {};
  /** Entity index (preview mirror of entity_occurrences): rebuilt on load
    * and refreshed on create/save; dropped with the doc on delete. */
  entityIndex = new Map<string, ExtractedEntity[]>();

  constructor() {
    this.docs = load<BrowserDoc[]>(DOCS_KEY, []);
    this.snaps = load<BrowserSnapshot[]>(SNAPS_KEY, []);
    this.tabs = load(TABS_KEY, {});
    this.conversations = load<BrowserConversation[]>(CONV_KEY, []);
    this.messages = load<BrowserMessage[]>(MSG_KEY, []);
    this.bible = load<BrowserBibleFact[]>(BIBLE_KEY, []);
    this.bibleMentions = load<BrowserBibleMention[]>(BIBLE_MENTIONS_KEY, []);
    this.bibleSuggestions = load<BrowserBibleSuggestion[]>(BIBLE_SUGGESTIONS_KEY, []).map((suggestion) => ({ ...suggestion, status: suggestion.status ?? "pending" }));
    this.bibleMentions = this.bibleMentions.filter((mention) => this.bibleSourceAllowed(mention.bible_doc_id) && this.bibleSourceAllowed(mention.doc_id));
    this.bibleSuggestions = this.bibleSuggestions.filter((suggestion) => this.bibleSourceAllowed(suggestion.bible_doc_id) && this.bibleSourceAllowed(suggestion.source_doc_id));
    this.persistBibleMemory();
    this.days = load<string[]>(DAYS_KEY, []);
    this.backups = load<[string, string, number][]>(BACKUP_KEY, []);
    this.metrics = load<BrowserMetric[]>(METRICS_KEY, []);
    this.rhythm = load<Record<string, number[]>>(RHYTHM_KEY, {});
    this.canvas = load<{ nodes: BrowserCanvasNode[]; edges: BrowserCanvasEdge[] }>(CANVAS_KEY, { nodes: [], edges: [] });
    this.opens = load<Record<string, DocOpens>>(OPENS_KEY, {});
    this.purgeSeedRemnants();
    this.rebuildEntityIndex();
  }

  private gazetteer(): { kind: string; key: string }[] {
    return this.bible.map((b) => ({ kind: b.kind, key: b.key }));
  }

  /** Refresh one doc's entity rows (mirror of refresh_entities). */
  refreshEntities(docId: string): void {
    const doc = this.docs.find((d) => d.id === docId);
    if (!doc) {
      this.entityIndex.delete(docId);
      return;
    }
    this.entityIndex.set(docId, extractEntities(doc.content || "", this.gazetteer()));
  }

  /** Full reindex (bible gazetteer changed, or backfill). Public for backend cases. */
  rebuildEntityIndex(): void {
    for (const doc of this.docs) {
      try {
        this.entityIndex.set(doc.id, extractEntities(doc.content || "", this.gazetteer()));
      } catch {
        this.entityIndex.delete(doc.id);
      }
    }
  }

  entitiesList(): { entity_norm: string; display: string; kind: string; doc_count: number; occ_count: number }[] {
    const agg = new Map<string, { display: string; kind: string; docs: Set<string>; occ: number }>();
    for (const [docId, rows] of this.entityIndex) {
      if (!this.docs.some((d) => d.id === docId)) continue;
      for (const r of rows) {
        let a = agg.get(r.norm);
        if (!a) {
          a = { display: r.display, kind: r.kind, docs: new Set(), occ: 0 };
          agg.set(r.norm, a);
        }
        a.docs.add(docId);
        a.occ++;
      }
    }
    return [...agg.entries()]
      .map(([norm, a]) => ({ entity_norm: norm, display: a.display, kind: a.kind, doc_count: a.docs.size, occ_count: a.occ }))
      .sort((x, y) => y.occ_count - x.occ_count)
      .slice(0, 500);
  }

  entityOccurrences(norm: string): { entity_norm: string; display: string; kind: string; doc_id: string; doc_title: string; span_start: number; span_end: number; snippet: string }[] {
    const out: { entity_norm: string; display: string; kind: string; doc_id: string; doc_title: string; span_start: number; span_end: number; snippet: string }[] = [];
    for (const [docId, rows] of this.entityIndex) {
      const doc = this.docs.find((d) => d.id === docId);
      if (!doc) continue;
      for (const r of rows) {
        if (r.norm === norm) {
          out.push({ entity_norm: r.norm, display: r.display, kind: r.kind, doc_id: docId, doc_title: doc.title, span_start: r.start, span_end: r.end, snippet: entitySnippet(doc.content || "", r.start, r.end) });
        }
      }
    }
    return out
      .sort((a, b) => (a.doc_title < b.doc_title ? -1 : 1) || a.span_start - b.span_start)
      .slice(0, 200);
  }

  private persistDocs(): void {
    save(DOCS_KEY, this.docs);
  }

  /**
   * One-time purge of the old built-in demo vault (removed 2026-09-17).
   * Matches only exact seed fingerprints — user content can never match.
   */
  private purgeSeedRemnants(): void {
    const fingerprints = [
      "Elena stared at the harbor",
      "Just Write ehis (browser preview)",
      "Captured in the browser preview.",
      "A quick capture waiting for triage.",
      "Home to [[Sample Chapter]]",
    ];
    const removed = new Set(
      this.docs
        .filter((d) => fingerprints.some((fp) => d.content.includes(fp)))
        .map((d) => d.id)
    );
    if (removed.size === 0) return;
    this.docs = this.docs.filter((d) => !removed.has(d.id));
    this.snaps = this.snaps.filter((s) => !removed.has(s.doc_id));
    this.persistDocs();
    save(SNAPS_KEY, this.snaps);
    try {
      localStorage.removeItem("jwe-browser-seeded-v1");
    } catch {
      /* ignore */
    }
  }

  private touchDay(): void {
    const day = nowIso().slice(0, 10);
    if (!this.days.includes(day)) {
      this.days.push(day);
      save(DAYS_KEY, this.days);
    }
  }

  get(id: string): BrowserDoc {
    const doc = this.docs.find((d) => d.id === id);
    if (!doc) throw new Error(`Doc not found: ${id}`);
    return doc;
  }

  create(workspace: string, kind: string, title: string, parentId?: string, content?: string, frontmatterJson?: string): BrowserDoc {
    const body = content ?? "";
    const doc: BrowserDoc = {
      id: uid("doc"),
      workspace,
      kind,
      title: title || "Untitled",
      path: `${workspace}/${(title || "untitled").toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`,
      parent_id: parentId ?? null,
      created_at: nowIso(),
      updated_at: nowIso(),
      content: body,
      word_count: countWords(body),
      reading_position: null,
      status: "draft",
      frontmatter_json: frontmatterJson ?? null,
      activity_score: 1,
      embedding_ref: null,
      locked: false,
    };
    this.docs.push(doc);
    this.touchDay();
    this.persistDocs();
    this.refreshEntities(doc.id);
    return { ...doc };
  }

  saveDoc(id: string, patch: Partial<BrowserDoc>): BrowserDoc {
    const doc = this.get(id);
    if (patch.parent_id !== undefined && patch.parent_id !== null) {
      if (patch.parent_id === id || !this.docs.some((candidate) => candidate.id === patch.parent_id) || this.isDescendantOf(patch.parent_id, id)) {
        throw new Error("Invalid document parent");
      }
    }
    const parentChanged = patch.parent_id !== undefined && patch.parent_id !== doc.parent_id;
    Object.assign(doc, patch, { updated_at: nowIso() });
    if (parentChanged) {
      this.bibleMentions = this.bibleMentions.filter((mention) => mention.doc_id !== id);
      this.bibleSuggestions = this.bibleSuggestions.filter((suggestion) => suggestion.source_doc_id !== id);
      this.persistBibleMemory();
    }
    if (patch.content !== undefined) {
      doc.word_count = countWords(patch.content);
      // Spec 8.2: content edits weigh 2x.
      doc.activity_score = (doc.activity_score ?? 0) + 2;
      this.refreshEntities(id);
    }
    this.touchDay();
    this.persistDocs();
    return { ...doc };
  }

  deleteDoc(id: string): void {
    this.docs = this.docs.filter((d) => d.id !== id);
    this.entityIndex.delete(id);
    this.persistDocs();
  }

  /**
   * Spec 8.2: weighted activity bumps + open/write tracking for the
   * "reopened but never finished" query. Never touches updated_at.
   */
  recordUsage(id: string, event: string): void {
    const now = nowIso();
    try {
      const doc = this.get(id);
      const weight: Record<string, number> = {
        edit: 2, write: 0, // writes already bumped via saveDoc
        ai_call: 1.5, open: 1, read: 0.5,
      };
      doc.activity_score = (doc.activity_score ?? 0) + (weight[event] ?? 1);
      this.persistDocs();
    } catch {
      /* usage for a deleted doc is a no-op */
    }
    const rec = this.opens[id] ?? { count: 0, lastOpened: now, lastWrite: null };
    if (event === "open") {
      rec.count += 1;
      rec.lastOpened = now;
    } else if (event === "write" || event === "edit") {
      rec.lastWrite = now;
    }
    this.opens[id] = rec;
    save(OPENS_KEY, this.opens);
    if (event === "write") this.recordRhythm();
  }

  delete(id: string): void {
    // Collect the doc + descendants (mirrors the desktop cascade).
    const ids = [id];
    for (let i = 0; i < ids.length; i++) {
      for (const d of this.docs) {
        if (d.parent_id === ids[i] && !ids.includes(d.id)) ids.push(d.id);
      }
    }
    const gone = new Set(ids);
    this.docs = this.docs.filter((d) => !gone.has(d.id));
    for (const id of gone) this.entityIndex.delete(id);
    this.snaps = this.snaps.filter((s) => !gone.has(s.doc_id));
    this.bible = this.bible.filter((b) => !gone.has(b.doc_id));
    this.bibleMentions = this.bibleMentions.filter((m) => !gone.has(m.doc_id) && !gone.has(m.bible_doc_id));
    this.bibleSuggestions = this.bibleSuggestions.filter((s) => !gone.has(s.source_doc_id) && !gone.has(s.bible_doc_id));
    this.conversations = this.conversations.filter((c) => !(c.doc_id && gone.has(c.doc_id)));
    this.messages = this.messages.filter((m) =>
      this.conversations.some((c) => c.id === m.conversation_id)
    );
    this.canvas.nodes = this.canvas.nodes.map((n) =>
      n.doc_id && gone.has(n.doc_id) ? { ...n, doc_id: null } : n
    );
    save(BIBLE_KEY, this.bible);
    this.persistBibleMemory();
    save(SNAPS_KEY, this.snaps);
    save(CONV_KEY, this.conversations);
    save(MSG_KEY, this.messages);
    save(CANVAS_KEY, this.canvas);
    this.persistDocs();
  }

  listByWorkspace(workspace: string): BrowserDoc[] {
    return this.docs
      .filter((d) => d.workspace === workspace)
      .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
      .map((d) => ({ ...d }));
  }

  /** Locked docs are invisible to search (content + titles). */
  search(query: string, workspace?: string): { doc: BrowserDoc; rank: number; snippet: string | null }[] {
    const q = query.trim().toLowerCase();
    const out: { doc: BrowserDoc; rank: number; snippet: string | null }[] = [];
    for (const doc of this.docs) {
      if (doc.locked) continue;
      if (workspace && doc.workspace !== workspace) continue;
      if (!q) {
        out.push({ doc: { ...doc }, rank: 0, snippet: null });
        continue;
      }
      const titleIdx = doc.title.toLowerCase().indexOf(q);
      const bodyIdx = doc.content.toLowerCase().indexOf(q);
      if (titleIdx === -1 && bodyIdx === -1) continue;
      const rank = titleIdx !== -1 ? 2 : 1;
      const snippet = bodyIdx !== -1 ? snippetAround(doc.content, bodyIdx, q.length) : null;
      out.push({ doc: { ...doc }, rank, snippet });
    }
    if (!q) return out.sort((a, b) => Date.parse(b.doc.updated_at) - Date.parse(a.doc.updated_at));
    return out.sort((a, b) => b.rank - a.rank);
  }

  /** Outgoing [[wikilinks]] + bare title refs from a doc's content. */
  outgoingLinks(doc: BrowserDoc): { targetId: string; context: string; kind: string }[] {
    const out: { targetId: string; context: string; kind: string }[] = [];
    const seen = new Set<string>();
    const re = /\[\[([^\]]+)\]\]/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(doc.content)) !== null) {
      const name = m[1].trim().toLowerCase();
      const target = this.docs.find((d) => d.id !== doc.id && (d.title.toLowerCase() === name || d.id === m![1].trim()));
      if (target && !seen.has(target.id)) {
        seen.add(target.id);
        out.push({ targetId: target.id, context: snippetAround(doc.content, m.index, m[0].length), kind: "wikilink" });
      }
    }
    return out;
  }

  backlinksFor(docId: string): { source_id: string; target_id: string; context_snippet: string; source_title: string }[] {
    const out: { source_id: string; target_id: string; context_snippet: string; source_title: string }[] = [];
    for (const doc of this.docs) {
      if (doc.id === docId) continue;
      for (const link of this.outgoingLinks(doc)) {
        if (link.targetId === docId) {
          out.push({ source_id: doc.id, target_id: docId, context_snippet: link.context, source_title: doc.title });
        }
      }
    }
    return out;
  }

  graph(): {
    nodes: { id: string; title: string; workspace: string; kind: string; word_count: number; activity_score: number; degree: number }[];
    edges: { source: string; target: string; kind: string; context_snippet: string | null }[];
    orphans: string[];
    hubs: [string, number][];
  } {
    const degree = new Map<string, number>();
    const edges: { source: string; target: string; kind: string; context_snippet: string | null }[] = [];
    for (const doc of this.docs) {
      for (const link of this.outgoingLinks(doc)) {
        edges.push({ source: doc.id, target: link.targetId, kind: "wikilink", context_snippet: link.context });
        degree.set(doc.id, (degree.get(doc.id) ?? 0) + 1);
        degree.set(link.targetId, (degree.get(link.targetId) ?? 0) + 1);
      }
    }
    const nodes = this.docs.map((d) => ({
      id: d.id,
      title: d.title,
      workspace: d.workspace,
      kind: d.kind,
      word_count: d.word_count,
      activity_score: d.activity_score,
      degree: degree.get(d.id) ?? 0,
    }));
    const orphans = nodes.filter((n) => n.degree === 0).map((n) => n.id);
    const hubs = [...degree.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
    return { nodes, edges, orphans, hubs };
  }

  unlinkedMentions(docId: string): { source_id: string; source_title: string; mentioned_title: string; context_snippet: string }[] {
    const doc = this.get(docId);
    const out: { source_id: string; source_title: string; mentioned_title: string; context_snippet: string }[] = [];
    const linked = new Set(this.outgoingLinks(doc).map((l) => l.targetId));
    for (const other of this.docs) {
      if (other.id === docId || linked.has(other.id)) continue;
      const idx = doc.content.toLowerCase().indexOf(other.title.toLowerCase());
      if (idx !== -1 && other.title.length > 2) {
        out.push({
          source_id: doc.id,
          source_title: doc.title,
          mentioned_title: other.title,
          context_snippet: snippetAround(doc.content, idx, other.title.length),
        });
      }
    }
    return out;
  }

  vaultRename(oldTitle: string, newTitle: string): number {
    const pattern = `[[${oldTitle}]]`;
    let count = 0;
    for (const doc of this.docs) {
      if (!doc.content.includes(pattern)) continue;
      const occurrences = doc.content.split(pattern).length - 1;
      doc.content = doc.content.split(pattern).join(`[[${newTitle}]]`);
      doc.word_count = countWords(doc.content);
      doc.updated_at = nowIso();
      count += occurrences;
    }
    const renamed = this.docs.find((d) => d.title === oldTitle);
    if (renamed) renamed.title = newTitle;
    this.persistDocs();
    return count;
  }

  snapshotCreate(docId: string): BrowserSnapshot {
    const doc = this.get(docId);
    const snap: BrowserSnapshot = {
      id: uid("snap"),
      doc_id: docId,
      label: `Snapshot ${new Date().toLocaleString()}`,
      content: doc.content,
      word_count: doc.word_count,
      created_at: nowIso(),
    };
    this.snaps.push(snap);
    // Hard ceiling: keep newest 500 per doc (spec A10.2)
    const mine = this.snaps.filter((s) => s.doc_id === docId);
    if (mine.length > 500) {
      const drop = new Set(mine.slice(0, mine.length - 500).map((s) => s.id));
      this.snaps = this.snaps.filter((s) => !drop.has(s.id));
    }
    save(SNAPS_KEY, this.snaps);
    return { ...snap };
  }

  snapshotList(docId: string): BrowserSnapshot[] {
    return this.snaps
      .filter((s) => s.doc_id === docId)
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      .map((s) => ({ ...s }));
  }

  setLocked(id: string, locked: boolean): void {
    this.saveDoc(id, { locked });
    if (!locked) return;
    const affected = new Set<string>();
    for (const doc of this.docs) {
      if (doc.id === id || this.isDescendantOf(doc.id, id)) affected.add(doc.id);
    }
    this.bibleMentions = this.bibleMentions.filter((mention) => !affected.has(mention.doc_id));
    this.bibleSuggestions = this.bibleSuggestions.filter((suggestion) => !affected.has(suggestion.source_doc_id));
    this.persistBibleMemory();
  }

  isDescendantOf(docId: string, ancestorId: string): boolean {
    let current = this.docs.find((doc) => doc.id === docId);
    const seen = new Set<string>();
    while (current?.parent_id && !seen.has(current.id)) {
      if (current.parent_id === ancestorId) return true;
      seen.add(current.id);
      current = this.docs.find((doc) => doc.id === current?.parent_id);
    }
    return false;
  }

  bibleSourceAllowed(id: string): boolean {
    let current = this.docs.find((doc) => doc.id === id);
    if (!current) return false;
    const seen = new Set<string>();
    while (current && !seen.has(current.id)) {
      if (current.locked) return false;
      seen.add(current.id);
      if (!current.parent_id) return true;
      current = this.docs.find((doc) => doc.id === current?.parent_id);
    }
    return false;
  }

  bibleScopeId(id: string): string {
    let current = this.get(id);
    const seen = new Set<string>();
    while (!seen.has(current.id)) {
      seen.add(current.id);
      if (!current.parent_id) return current.id;
      const parent = this.docs.find((doc) => doc.id === current.parent_id);
      if (!parent) throw new Error("Document parent is missing");
      if (parent.kind === "project") return parent.id;
      current = parent;
    }
    throw new Error("Document hierarchy contains a cycle");
  }

  private persistBibleMemory(): void {
    save(BIBLE_MENTIONS_KEY, this.bibleMentions);
    save(BIBLE_SUGGESTIONS_KEY, this.bibleSuggestions);
  }

  bibleGetMentions(scopeId: string): BrowserBibleMention[] {
    return this.bibleMentions
      .filter((mention) => mention.bible_doc_id === scopeId && this.bibleSourceAllowed(scopeId) && this.bibleSourceAllowed(mention.doc_id) && this.bibleScopeId(mention.doc_id) === scopeId)
      .map((mention) => ({ ...mention }));
  }

  bibleUpsertMention(
    scopeId: string,
    docId: string,
    factKey: string,
    kind: string,
    snippet: string,
    attributeKey: string | null,
    attributeValue: string | null,
  ): BrowserBibleMention {
    if (this.bibleScopeId(docId) !== scopeId) throw new Error("Mention source does not belong to this Story Bible");
    if (!this.bibleSourceAllowed(scopeId) || !this.bibleSourceAllowed(docId)) throw new Error("Locked documents cannot receive Story Memory evidence");
    const doc = this.get(docId);
    const existing = this.bibleMentions.find((mention) =>
      mention.bible_doc_id === scopeId && mention.fact_key === factKey && mention.kind === kind &&
      mention.doc_id === docId && mention.snippet === snippet && mention.attribute_key === attributeKey &&
      mention.attribute_value === attributeValue
    );
    if (existing) return { ...existing };
    const mention: BrowserBibleMention = {
      id: `mention-${uid("memory")}`,
      bible_doc_id: scopeId,
      fact_key: factKey,
      kind,
      doc_id: docId,
      doc_title: doc.title,
      snippet,
      attribute_key: attributeKey,
       attribute_value: attributeValue,
       span_start: doc.content.indexOf(snippet) >= 0 ? doc.content.indexOf(snippet) : null,
       created_at: nowIso(),
    };
    this.bibleMentions.push(mention);
    this.persistBibleMemory();
    return { ...mention };
  }

  bibleDeleteMentions(scopeId: string, docId?: string, factKey?: string): void {
    if (!this.bibleSourceAllowed(scopeId) || (docId && (!this.bibleSourceAllowed(docId) || this.bibleScopeId(docId) !== scopeId))) {
      throw new Error("Locked documents cannot modify Story Memory evidence");
    }
    this.bibleMentions = this.bibleMentions.filter((mention) =>
      mention.bible_doc_id !== scopeId ||
      (docId !== undefined && mention.doc_id !== docId) ||
      (factKey !== undefined && mention.fact_key !== factKey)
    );
    this.persistBibleMemory();
  }

  deleteBibleFact(factId: string): void {
    const fact = this.bible.find((item) => item.id === factId);
    if (fact && !this.bibleSourceAllowed(fact.doc_id)) throw new Error("Locked documents cannot modify Story Memory evidence");
    this.bible = this.bible.filter((item) => item.id !== factId);
    if (fact) {
      this.bibleMentions = this.bibleMentions.filter((mention) => mention.bible_doc_id !== fact.doc_id || mention.fact_key !== fact.key);
      this.bibleSuggestions = this.bibleSuggestions.filter((suggestion) => suggestion.bible_doc_id !== fact.doc_id || suggestion.key !== fact.key);
      save(BIBLE_KEY, this.bible);
      this.persistBibleMemory();
    }
    this.rebuildEntityIndex();
  }

  bibleGetSuggestions(scopeId: string): BrowserBibleSuggestion[] {
    return this.bibleSuggestions
      .filter((suggestion) => suggestion.status === "pending" && suggestion.bible_doc_id === scopeId && this.bibleSourceAllowed(scopeId) && this.bibleSourceAllowed(suggestion.source_doc_id) && this.bibleScopeId(suggestion.source_doc_id) === scopeId)
      .map((suggestion) => ({ ...suggestion }));
  }

  bibleRejectSuggestion(scopeId: string, suggestionId: string): void {
    const suggestion = this.bibleSuggestions.find((item) => item.bible_doc_id === scopeId && item.id === suggestionId && item.status === "pending");
    if (!suggestion) throw new Error("Suggestion not found");
    if (!this.bibleSourceAllowed(scopeId) || !this.bibleSourceAllowed(suggestion.source_doc_id) || this.bibleScopeId(suggestion.source_doc_id) !== scopeId) {
      throw new Error("Suggestion source is no longer available");
    }
    this.bibleSuggestions = this.bibleSuggestions.map((suggestion) =>
      suggestion.bible_doc_id === scopeId && suggestion.id === suggestionId ? { ...suggestion, status: "rejected" } : suggestion,
    );
    this.persistBibleMemory();
  }

  bibleConfirmSuggestion(scopeId: string, suggestionId: string): BrowserBibleFact {
    const suggestion = this.bibleSuggestions.find((item) => item.bible_doc_id === scopeId && item.id === suggestionId && item.status === "pending");
    if (!suggestion) throw new Error("Suggestion not found");
    if (!this.bibleSourceAllowed(scopeId) || !this.bibleSourceAllowed(suggestion.source_doc_id) || this.bibleScopeId(suggestion.source_doc_id) !== scopeId) {
      throw new Error("Suggestion source is no longer available");
    }
    if (!this.get(suggestion.source_doc_id).content.includes(suggestion.snippet)) {
      throw new Error("Suggestion source changed before confirmation");
    }
    const factKind = suggestion.kind === "character" ? "world_characters" : "world_settings";
    const existing = this.bible.find((fact) => fact.doc_id === scopeId && fact.key === suggestion.key);
    const fact = existing
      ? { ...existing, kind: existing.kind || factKind, value: suggestion.value }
      : { id: `fact-${uid("bible")}`, doc_id: scopeId, kind: factKind, key: suggestion.key, value: suggestion.value };
    if (existing) this.bible = this.bible.map((item) => item.id === existing.id ? fact : item);
    else this.bible.push(fact);
    this.bibleUpsertMention(scopeId, suggestion.source_doc_id, suggestion.key, suggestion.kind, suggestion.snippet, suggestion.attribute_key, suggestion.attribute_value);
    this.bibleRejectSuggestion(scopeId, suggestionId);
    save(BIBLE_KEY, this.bible);
    this.rebuildEntityIndex();
    return { ...fact };
  }

  listPinned(): BrowserDoc[] {
    return this.docs
      .filter((d) => d.pinned)
      .sort((a, b) => +new Date(b.updated_at) - +new Date(a.updated_at))
      .map((d) => ({ ...d }));
  }

  recordMetric(docId: string, metricType: string, value: number): void {
    this.metrics.push({ doc_id: docId, metric_type: metricType, value, created_at: nowIso() });
    const mine = this.metrics.filter((m) => m.doc_id === docId);
    if (mine.length > 500) {
      const drop = new Set(mine.slice(0, mine.length - 500));
      this.metrics = this.metrics.filter((m) => !drop.has(m));
    }
    save(METRICS_KEY, this.metrics);
  }

  getMetrics(docId: string): [string, number, string][] {
    return this.metrics
      .filter((m) => m.doc_id === docId)
      .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
      .map((m) => [m.metric_type, m.value, m.created_at] as [string, number, string]);
  }

  metricTrend(docId: string, metricType: string): [string, number][] {
    const byDay = new Map<string, { sum: number; n: number }>();
    for (const m of this.metrics) {
      if (m.doc_id !== docId || m.metric_type !== metricType) continue;
      const day = m.created_at.slice(0, 10);
      const agg = byDay.get(day) ?? { sum: 0, n: 0 };
      agg.sum += m.value;
      agg.n++;
      byDay.set(day, agg);
    }
    return [...byDay.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([day, agg]) => [day, Math.round((agg.sum / agg.n) * 100) / 100] as [string, number]);
  }

  recordRhythm(): void {
    const day = nowIso().slice(0, 10);
    const hour = new Date().getHours();
    if (!this.rhythm[day]) this.rhythm[day] = new Array(24).fill(0);
    this.rhythm[day][hour]++;
    save(RHYTHM_KEY, this.rhythm);
  }

  todayRhythm(): [number, number][] {
    const buckets = this.rhythm[nowIso().slice(0, 10)] ?? new Array(24).fill(0);
    return buckets.map((c, h) => [h, c] as [number, number]);
  }

  private persistCanvas(): void {
    save(CANVAS_KEY, this.canvas);
  }

  canvasList(): { nodes: BrowserCanvasNode[]; edges: BrowserCanvasEdge[] } {
    return {
      nodes: this.canvas.nodes.map((n) => ({ ...n })),
      edges: this.canvas.edges.map((e) => ({ ...e })),
    };
  }

  canvasUpsertNode(node: BrowserCanvasNode): BrowserCanvasNode {
    const id = node.id || uid("canvas");
    const saved: BrowserCanvasNode = { ...node, id, updated_at: nowIso() };
    const idx = this.canvas.nodes.findIndex((n) => n.id === id);
    if (idx >= 0) this.canvas.nodes[idx] = saved;
    else this.canvas.nodes.push(saved);
    this.persistCanvas();
    return { ...saved };
  }

  canvasDeleteNode(id: string): void {
    this.canvas.nodes = this.canvas.nodes.filter((n) => n.id !== id);
    this.canvas.edges = this.canvas.edges.filter((e) => e.source_id !== id && e.target_id !== id);
    this.persistCanvas();
  }

  canvasConnect(sourceId: string, targetId: string, label: string): BrowserCanvasEdge {
    if (sourceId === targetId) throw new Error("A card cannot connect to itself.");
    if (!this.canvas.nodes.some((n) => n.id === sourceId) || !this.canvas.nodes.some((n) => n.id === targetId)) {
      throw new Error("Both cards must exist.");
    }
    const edge: BrowserCanvasEdge = { id: uid("edge"), source_id: sourceId, target_id: targetId, label };
    this.canvas.edges.push(edge);
    this.persistCanvas();
    return { ...edge };
  }

  canvasDeleteEdge(id: string): void {
    this.canvas.edges = this.canvas.edges.filter((e) => e.id !== id);
    this.persistCanvas();
  }
}

export const browserStore = new BrowserStore();
