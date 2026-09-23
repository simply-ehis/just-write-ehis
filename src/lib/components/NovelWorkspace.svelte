<script lang="ts">
  import { onMount } from 'svelte';
  import { api, type Doc, type BeatBoard, type BeatNode, type BibleFact, type EntitySummary, type EntityHit } from '$lib/api';
  import { currentDoc, currentWorkspace, openTabs } from '$lib/stores/app';
  import { downloadConvertOutput } from '$lib/download';
  import { showToast } from '$lib/stores/notifications';
  import EditorPane from './EditorPane.svelte';
  import DocDetail from './DocDetail.svelte';
  import DeleteButton from './DeleteButton.svelte';
  import DockSplit from './DockSplit.svelte';
  import DocForkPanel from './DocForkPanel.svelte';

  import ForkBadge from './ForkBadge.svelte';
  import { readImportFile, contentHash } from '$lib/importFile';
  let splitMode = $state<'chapters' | 'scenes'>('chapters');
  let castEntities = $state<EntitySummary[]>([]);
  let castLoading = $state(false);
  let castSelected = $state<string | null>(null);
  let castHits = $state<EntityHit[]>([]);
  let castBackfilling = $state(false);

  /** Cover ref from the current project's frontmatter (EPUB import art). */
  let projectCover = $derived.by(() => {
    const current = projects.find((p) => p.id === projectId);
    try {
      return (JSON.parse(current?.frontmatter_json ?? "{}") as { cover?: string }).cover ?? null;
    } catch {
      return null;
    }
  });

  /** Load the entity index (auto-built on every save; backfill covers older docs). */
  async function loadCast() {
    castLoading = true;
    try {
      castEntities = await api.entitiesList();
    } catch (e) {
      console.warn("Cast load failed:", e instanceof Error ? e.message : e);
      castEntities = [];
    } finally {
      castLoading = false;
    }
  }

  async function selectEntity(norm: string) {
    if (castSelected === norm) {
      castSelected = null;
      castHits = [];
      return;
    }
    castSelected = norm;
    try {
      castHits = await api.entityOccurrences(norm);
    } catch (e) {
      console.warn("Occurrences load failed:", e instanceof Error ? e.message : e);
      castHits = [];
    }
  }

  async function backfillCast() {
    castBackfilling = true;
    try {
      const n = await api.entitiesBackfill();
      showToast(`Indexed ${n} document${n === 1 ? "" : "s"}`, "success");
      await loadCast();
      if (castSelected) castHits = await api.entityOccurrences(castSelected);
    } catch (e) {
      showToast(`Backfill failed: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      castBackfilling = false;
    }
  }

  /** Open an occurrence: the doc, or its beat in the editor when it's a scene. */
  async function openEntityHit(hit: EntityHit) {
    try {
      const doc = await api.docGet(hit.doc_id);
      $currentDoc = doc;
      if (!$openTabs.find((t) => t.id === doc.id)) {
        $openTabs = [doc, ...$openTabs];
      }
      const scene = board.scenes.find((s) => s.doc.id === hit.doc_id);
      if (scene) {
        viewMode = 'board';
        selectBeat(scene);
      }
      await api.usageRecord(doc.id, "open").catch(() => {});
    } catch (e) {
      showToast(`Couldn't open: ${e instanceof Error ? e.message : e}`, "error");
    }
  }
  let projectId = $state<string | null>(null);
  let projects = $state<Doc[]>([]);
  let board = $state<BeatBoard>({ acts: [], sequences: [], scenes: [] });
  let bibleFacts = $state<BibleFact[]>([]);
  let bibleNewKey = $state<Record<string, string>>({});
  let bibleNewVal = $state<Record<string, string>>({});
  let selectedBeat = $state<BeatNode | null>(null);
  let viewMode = $state<'board' | 'bible' | 'cast'>('board');
  let compiledOutput = $state('');
  let compileFormat = $state('md');
  let compileFormats = $state<string[]>(['md', 'txt', 'html']);
  let compiling = $state(false);
  let loading = $state(false);
  let boardCollapsed = $state(false);
  let importing = $state(false);
  let importProgress = $state("");
  let importCancelled = $state(false);
  // Duplicate-import acknowledge: first Import click only warns, the
  // second (same bytes) proceeds. Native dialogs are banned app-wide
  // (headless + mobile have no dialog chrome), hence the two-tap flow.
  let dupeAckHash = $state<string | null>(null);
  let startingWriting = $state(false);
  let importInput = $state<HTMLInputElement | null>(null);
  let ghostCounts = $state<Record<string, number>>({});
  let activeGhostId = $state<string | null>(null);
  let activeGhostParentId = $state<string | null>(null);

  /**
   * Split imported prose into chapters (or scenes): markdown headings
   * first, chapter/part markers second, screenplay scene headers
   * (INT./EXT.) and *** rules in scenes mode, one chapter as fallback.
   * Marker lines stay in the body so nothing is lost.
   */
  function splitChapters(text: string, mode: 'chapters' | 'scenes' = 'chapters'): { title: string; body: string }[] {
    const lines = text.split("\n");
    const cuts: { index: number; title: string }[] = [];
    const depth = mode === "scenes" ? 6 : 3;
    lines.forEach((line, i) => {
      const m = line.match(new RegExp(`^#{1,${depth}}\\s+(.+?)\\s*$`));
      if (m && m[1]) cuts.push({ index: i, title: m[1].trim() });
    });
    if (cuts.length === 0) {
      lines.forEach((line, i) => {
        const t = line.trim();
        if (t.length > 0 && t.length <= 70 && /^(chapter|part|prologue|epilogue|interlude|appendix|book)\b/i.test(t)) {
          cuts.push({ index: i, title: t });
        }
      });
    }
    if (cuts.length === 0 && mode === "scenes") {
      lines.forEach((line, i) => {
        const t = line.trim();
        // Fountain/screenplay scene headers survive prose import as plain
        // lines — split on them so .fountain lands as scenes, not mush.
        if (t.length > 0 && t.length <= 70 && /^(INT\.|EXT\.|EST\.|INT\.\/EXT\.)/i.test(t)) {
          cuts.push({ index: i, title: t });
        } else if (/^(\*\*\*|---|\.\.\.)\s*$/.test(t)) {
          cuts.push({ index: i, title: "Scene" });
        }
      });
    }
    // "chapter 1" vs "CHAPTER 1" vs "Chapter One" → one numbering voice.
    const cleanTitle = (t: string) => {
      const m = t.replace(/\s+/g, " ").trim().replace(/^chapter\s+(.+)$/i, (_m, n: string) => `Chapter ${n}`);
      return m.slice(0, 80) || "Untitled";
    };
    if (cuts.length === 0) return [{ title: "Chapter 1", body: text.trim() }];
    const kept = cuts.slice(0, 200);
    const chapters: { title: string; body: string }[] = [];
    const preamble = lines.slice(0, kept[0].index).join("\n").trim();
    if (preamble) chapters.push({ title: "Opening", body: preamble });
    if (kept.length === 1 && !preamble) {
      return [{ title: cleanTitle(kept[0].title), body: text.trim() }];
    }
    kept.forEach((cut, n) => {
      const end = n + 1 < kept.length ? kept[n + 1].index : lines.length;
      const body = lines.slice(cut.index, end).join("\n").trim();
      if (body) chapters.push({ title: cleanTitle(cut.title), body });
    });
    return chapters.length > 0 ? chapters : [{ title: "Chapter 1", body: text.trim() }];
  }

  /** Import a novel file as a project: one act, one scene per chapter. */
  async function handleImportFile(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file || importing) return;
    importing = true;
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".epub") || lower.endsWith(".pdf") || lower.endsWith(".docx")) {
        showToast(`Extracting text from ${file.name}…`, "info");
      }
      const { title, text, author, cover, encodingNote } = await readImportFile(file);
      if (encodingNote) showToast(encodingNote, "warning");
      // Duplicate guard: same bytes imported before → confirm, don't clone.
      const hash = contentHash(text);
      const dupe = projects.find((p) => {
        try {
          return (JSON.parse(p.frontmatter_json ?? "{}") as { importHash?: string }).importHash === hash;
        } catch {
          return false;
        }
      });
      if (dupe) {
        if (dupeAckHash !== hash) {
          dupeAckHash = hash;
          showToast(`"${title}" looks already imported as "${dupe.title}" — click Import again to duplicate it`, "warning");
          return;
        }
        dupeAckHash = null;
      }
      const chapters = splitChapters(text, splitMode);
      const unit = splitMode === "scenes" ? "scene" : "chapter";
      const fm: Record<string, unknown> = { importHash: hash };
      if (author) fm.author = author;
      const project = await api.docCreate("novel", "project", title, undefined, "", JSON.stringify(fm));
      // EPUB cover art → vault attachment, referenced from the project.
      if (cover?.b64) {
        try {
          const ext = cover.mime.includes("png") ? "png" : "jpg";
          const ref = await api.attachmentSave(`cover.${ext}`, cover.b64);
          await api.docSave(project.id, undefined, undefined, undefined, JSON.stringify({ ...fm, cover: ref }));
        } catch (e) {
          console.warn("Cover attach failed (import continues):", e instanceof Error ? e.message : e);
        }
      }
      projects = [...projects, project];
      projectId = project.id;
      $currentDoc = project;
      await api.docCreate("novel", "act", "Part One", project.id, "", JSON.stringify({ status: "draft", act: 1, order: 1024 }));
      // Chapters go in small parallel batches (6-way): a 200-chapter
      // novel was 200 serialized round trips with no feedback. Progress
      // counts up; Cancel stops after the in-flight batch and keeps
      // what's already created (no half-project rollback games).
      let order = 2048;
      let created = 0;
      importCancelled = false;
      const BATCH = 6;
      for (let i = 0; i < chapters.length && !importCancelled; i += BATCH) {
        const slice = chapters.slice(i, i + BATCH);
        await Promise.all(
          slice.map((ch) => {
            const o = order;
            order += 1024;
            return api
              .docCreate("novel", "scene", ch.title, project.id, ch.body, JSON.stringify({ status: "draft", act: 1, order: o }))
              .then(() => {
                created++;
                importProgress = `Importing ${unit} ${created}/${chapters.length}…`;
              });
          })
        );
      }
      if (importCancelled) {
        await loadProject();
        showToast(`Import stopped — kept ${created} of ${chapters.length} ${unit}s`, "warning");
        const firstKept = board.scenes[0];
        if (firstKept) selectBeat(firstKept);
        return;
      }
      importProgress = "";
      await loadProject();
      const byline = author ? ` by ${author}` : "";
      showToast(`Imported "${title}"${byline} — ${chapters.length} ${unit}${chapters.length === 1 ? "" : "s"}`, "success");
      // Land in the editor on the first imported chapter, not back on
      // the beat board — otherwise a good import still feels broken.
      const firstScene = board.scenes[0];
      if (firstScene) selectBeat(firstScene);
    } catch (err) {
      showToast(`Import failed: ${err instanceof Error ? err.message : err}`, "error");
    } finally {
      importing = false;
      importProgress = "";
      importCancelled = false;
    }
  }

  async function loadProjects() {
    try {
      const docs = await api.docListByWorkspace('novel');
      projects = docs.filter((d) => d.kind === 'project');
    } catch {
      projects = [];
    }
  }

  async function createProject() {
    const title = `Novel ${projects.length + 1}`;
    try {
      const doc = await api.docCreate('novel', 'project', title);
      projects = [...projects, doc];
      projectId = doc.id;
      $currentDoc = doc;
      // A brand-new project has zero scenes — take the user straight to
      // a writable editor instead of an empty board with nothing to click.
      await startWriting();
    } catch (e) {
      showToast(`Couldn't create project: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  /**
   * First-scene bootstrap: create Act 1 → Sequence 1 → Scene 1 (a scene
   * only renders on the board inside a sequence) and open the scene in
   * the editor immediately. Used for new projects and for the empty-board
   * "Start writing" affordance below.
   */
  async function startWriting() {
    if (!projectId || startingWriting) return;
    startingWriting = true;
    try {
      await api.docCreate('novel', 'act', 'Act 1', projectId, '', JSON.stringify({ status: 'draft', act: 1, order: 1024 }));
      await api.docCreate('novel', 'sequence', 'Sequence 1', projectId, '', JSON.stringify({ status: 'draft', act: 1, sequence: 1, order: 1536 }));
      await api.docCreate('novel', 'scene', 'Scene 1', projectId, '', JSON.stringify({ status: 'idea', act: 1, sequence: 1, order: 2048 }));
      await loadProject();
      const first = board.scenes[0] ?? board.sequences[0] ?? board.acts[0] ?? null;
      if (first) selectBeat(first);
    } catch (e) {
      showToast(`Couldn't start writing: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      startingWriting = false;
    }
  }

  // Follow the open doc: a novel chapter selects its project, a project selects itself.
  $effect(() => {
    const doc = $currentDoc;
    if (doc?.workspace === 'novel') {
      const pid = doc.kind === 'project' ? doc.id : (doc.parent_id ?? null);
      if (pid && pid !== projectId) projectId = pid;
    }
  });

  $effect(() => {
    if (projectId) loadProject();
  });

  onMount(() => {
    loadProjects();
    if (projectId) loadProject();
  });

  let projectDoc = $derived(projectId ? board.acts[0]?.doc ?? board.scenes[0]?.doc : null);

  async function loadProject() {
    if (!projectId) return;
    loading = true;
    try {
      board = await api.novelGetBeatBoard(projectId);
      if (board.acts.length > 0) {
        bibleFacts = await api.bibleGetFacts(projectId);
      }
      loadGhostCounts();
    } catch (e) {
      console.error('Failed to load novel project:', e);
    } finally {
      loading = false;
    }
  }

  function selectBeat(beat: BeatNode) {
    selectedBeat = beat;
    $currentDoc = beat.doc;
    if (!$openTabs.find((t) => t.id === beat.doc.id)) $openTabs = [beat.doc, ...$openTabs];
  }

  async function forkScene(beat: BeatNode) {
    try {
      const ghost = await api.ghostFork(beat.doc.id, "Fork");
      ghostCounts[beat.doc.id] = (ghostCounts[beat.doc.id] ?? 0) + 1;
      showToast(`Forked "${beat.doc.title}"`, "success");
    } catch (e) {
      showToast(`Fork failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function loadGhostCounts() {
    if (!board) return;
    const all = [...board.acts, ...board.sequences, ...board.scenes];
    const counts: Record<string, number> = {};
    for (const beat of all) {
      try {
        const group = await api.ghostList(beat.doc.id);
        if (group.ghosts.length > 0) counts[beat.doc.id] = group.ghosts.length;
      } catch (e) {
        console.warn(`Failed to load ghost count for ${beat.doc.id}:`, e);
      }
    }
    ghostCounts = counts;
  }

  async function addBeat(kind: 'act' | 'sequence' | 'scene', parentAct?: number | null, parentSeq?: number | null) {
    if (!projectId) return;
    const title = `New ${kind.charAt(0).toUpperCase() + kind.slice(1)}`;
    const fm: Record<string, unknown> = { status: 'idea' };
    if (parentAct != null) fm.act = parentAct;
    if (parentSeq != null) fm.sequence = parentSeq;

    try {
      const doc = await api.docCreate('novel', kind, title, projectId, '', JSON.stringify(fm));
      const beat: BeatNode = {
        doc, act: parentAct ?? null, sequence: parentSeq ?? null,
        status: 'idea', summary: null, pov: null, location: null,
        timeframe: null, characters: [],
      };
      if (kind === 'act') board.acts.push(beat);
      else if (kind === 'sequence') board.sequences.push(beat);
      else board.scenes.push(beat);
    } catch (e) {
      console.error('Failed to add beat:', e);
    }
  }

  async function compileManuscript() {
    if (!projectId) return;
    try {
      compiledOutput = await api.novelCompile(projectId);
      try {
        const status = await api.convertStatus();
        compileFormats = status.formats;
      } catch {
        compileFormats = ['md', 'txt', 'html'];
      }
    } catch (e) {
      console.error('Compile failed:', e);
    }
  }

  /** Manuscript doc ids in board order: acts, then sequences, then scenes. */
  function manuscriptDocIds(): string[] {
    const ids: string[] = [];
    for (const beat of [...board.acts, ...board.sequences, ...board.scenes]) {
      if (!ids.includes(beat.doc.id)) ids.push(beat.doc.id);
    }
    return ids;
  }

  async function downloadManuscript() {
    if (!projectId) return;
    compiling = true;
    try {
      const title = board.acts[0]?.doc.title ?? board.scenes[0]?.doc.title ?? 'manuscript';
      const out = await api.compileRun(manuscriptDocIds(), compileFormat, title);
      downloadConvertOutput(out);
      showToast(`Compiled ${out.filename}`, 'success');
    } catch (e) {
      showToast(`Compile failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      compiling = false;
    }
  }

  async function handleBibleUpsert(kind: string, key: string, value: string) {
    if (!projectId) return;
    const fact = await api.bibleUpsertFact(projectId, kind, key, value);
    const idx = bibleFacts.findIndex(f => f.kind === kind && f.key === key);
    if (idx >= 0) bibleFacts[idx] = fact;
    else bibleFacts.push(fact);
  }

  async function handleBibleAdd(kind: string) {
    const key = (bibleNewKey[kind] ?? '').trim();
    const value = (bibleNewVal[kind] ?? '').trim();
    if (!projectId || !key) return;
    try {
      await handleBibleUpsert(kind, key, value);
      bibleNewKey[kind] = '';
      bibleNewVal[kind] = '';
    } catch (e) {
      showToast(`Couldn't save fact: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  async function handleBibleDelete(factId: string) {
    try {
      await api.bibleDeleteFact(factId);
      bibleFacts = bibleFacts.filter(f => f.id !== factId);
    } catch (e) {
      showToast(`Couldn't delete fact: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  function beatOrderOf(doc: Doc): number {
    try {
      const fm = JSON.parse(doc.frontmatter_json ?? '{}');
      return typeof fm.order === 'number' ? fm.order : 0;
    } catch {
      return 0;
    }
  }

  function frontmatterWith(doc: Doc, patch: Record<string, unknown>): string {
    let fm: Record<string, unknown> = {};
    try {
      fm = JSON.parse(doc.frontmatter_json ?? '{}');
    } catch {}
    return JSON.stringify({ ...fm, ...patch });
  }

  function orderedScenes(actN: number | null, seqN: number | null): BeatNode[] {
    return board.scenes
      .filter((s) => s.act === actN && s.sequence === seqN)
      .sort((a, b) => beatOrderOf(a.doc) - beatOrderOf(b.doc));
  }

  /** Save only beats whose order/act/sequence actually changed, then reload. */
  async function persistSceneOrder(lists: { beats: BeatNode[]; act: number | null; sequence: number | null }[]) {
    try {
      for (const list of lists) {
        let idx = 0;
        for (const b of list.beats) {
          idx++;
          const want = { order: idx * 1024, act: list.act, sequence: list.sequence };
          let fm: Record<string, unknown> = {};
          try {
            fm = JSON.parse(b.doc.frontmatter_json ?? '{}');
          } catch {}
          if (fm.order === want.order && (fm.act ?? null) === (want.act ?? null) && (fm.sequence ?? null) === (want.sequence ?? null)) {
            continue;
          }
          await api.docSave(b.doc.id, undefined, undefined, undefined, frontmatterWith(b.doc, want));
        }
      }
      await loadProject();
      showToast('Board order updated — Compile follows this order', 'success');
    } catch (e) {
      showToast(`Reorder failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  let dragSceneId = $state<string | null>(null);
  let dragActId = $state<string | null>(null);

  function dropSceneOnto(target: BeatNode) {
    if (!dragSceneId || dragSceneId === target.doc.id) return;
    const dragged = board.scenes.find((s) => s.doc.id === dragSceneId);
    if (!dragged) return;
    const fromKey = `${dragged.act}::${dragged.sequence}`;
    const toKey = `${target.act}::${target.sequence}`;
    const toList = orderedScenes(target.act, target.sequence).filter((s) => s.doc.id !== dragSceneId);
    const at = toList.findIndex((s) => s.doc.id === target.doc.id);
    toList.splice(at < 0 ? toList.length : at, 0, dragged);
    const lists = [{ beats: toList, act: target.act, sequence: target.sequence }];
    if (fromKey !== toKey) {
      lists.push({ beats: orderedScenes(dragged.act, dragged.sequence).filter((s) => s.doc.id !== dragSceneId), act: dragged.act, sequence: dragged.sequence });
    }
    dragSceneId = null;
    persistSceneOrder(lists);
  }

  function dropSceneIntoGroup(actN: number | null, seqN: number | null) {
    if (!dragSceneId) return;
    const dragged = board.scenes.find((s) => s.doc.id === dragSceneId);
    if (!dragged) return;
    const fromKey = `${dragged.act}::${dragged.sequence}`;
    const toKey = `${actN}::${seqN}`;
    if (fromKey === toKey) {
      // Dropped on its own group background: move to end.
      const list = orderedScenes(actN, seqN).filter((s) => s.doc.id !== dragSceneId);
      list.push(dragged);
      dragSceneId = null;
      persistSceneOrder([{ beats: list, act: actN, sequence: seqN }]);
      return;
    }
    const toList = [...orderedScenes(actN, seqN), dragged];
    const fromList = orderedScenes(dragged.act, dragged.sequence).filter((s) => s.doc.id !== dragSceneId);
    dragSceneId = null;
    persistSceneOrder([
      { beats: toList, act: actN, sequence: seqN },
      { beats: fromList, act: dragged.act, sequence: dragged.sequence },
    ]);
  }

  async function dropActOnto(target: BeatNode) {
    if (!dragActId || dragActId === target.doc.id) {
      dragActId = null;
      return;
    }
    const ids = board.acts.map((a) => a.doc.id);
    const from = ids.indexOf(dragActId);
    const to = ids.indexOf(target.doc.id);
    dragActId = null;
    if (from < 0 || to < 0) return;
    const [moved] = ids.splice(from, 1);
    ids.splice(to, 0, moved);
    try {
      let idx = 0;
      for (const id of ids) {
        idx++;
        const beat = board.acts.find((a) => a.doc.id === id);
        if (!beat) continue;
        if (beatOrderOf(beat.doc) !== idx * 1024) {
          await api.docSave(id, undefined, undefined, undefined, frontmatterWith(beat.doc, { order: idx * 1024 }));
        }
      }
      await loadProject();
      showToast('Board order updated — Compile follows this order', 'success');
    } catch (e) {
      showToast(`Reorder failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  function getScenesForAct(act: number): BeatNode[] {
    return board.scenes.filter(s => s.act === act);
  }

  function getSequencesForAct(act: number): BeatNode[] {
    return board.sequences.filter(s => s.act === act);
  }

  function getScenesForSequence(act: number, seq: number): BeatNode[] {
    return board.scenes.filter(s => s.act === act && s.sequence === seq);
  }

  function statusColor(status: string): string {
    switch (status) {
      case 'draft': return 'var(--accent-primary)';
      case 'revised': return 'var(--accent-semantic-green)';
      case 'final': return 'var(--accent-semantic-purple)';
      case 'cut': return 'var(--accent-semantic-red)';
      default: return 'var(--text-muted)';
    }
  }
</script>

<div class="novel-workspace">
  <div class="novel-header">
    <h1>Novel Studio</h1>
    <div class="project-picker">
      {#if projectCover}
        <img class="project-cover" src={projectCover} alt="Project cover art" />
      {/if}
      <select
        bind:value={projectId}
        title="Novel project"
        aria-label="Novel project"
        onchange={() => { selectedBeat = null; }}
      >
        <option value={null}>Select a project…</option>
        {#each projects as p}
          <option value={p.id}>{p.title}</option>
        {/each}
      </select>
      <button class="new-project-btn" onclick={createProject} title="New novel project" aria-label="New novel project">+ New</button>
    </div>
    <div class="view-toggle">
      <button class:active={viewMode === 'board'} onclick={() => viewMode = 'board'}>Beat Board</button>
      <button class:active={viewMode === 'bible'} onclick={() => viewMode = 'bible'}>Story Bible</button>
      <button class:active={viewMode === 'cast'} onclick={() => { viewMode = 'cast'; loadCast(); }}>Cast & Places</button>
      <button onclick={() => (boardCollapsed = !boardCollapsed)} title={boardCollapsed ? "Show board" : "Focus editor — hide board"} aria-pressed={boardCollapsed}>{boardCollapsed ? "Show board" : "Focus editor"}</button>
      <button class="import-btn" onclick={() => importInput?.click()} title="Import novel (.epub .pdf .docx .md .txt .fountain)" aria-label="Import novel" disabled={importing}>Import</button>
      {#if importing}
        <span class="import-progress" aria-live="polite">{importProgress || "Importing…"}</span>
        <button class="import-cancel" onclick={() => (importCancelled = true)} aria-label="Cancel import">Cancel</button>
      {/if}
      <select class="split-select" bind:value={splitMode} title="Split imports by chapter headings or by scenes" aria-label="Import split mode">
        <option value="chapters">Chapters</option>
        <option value="scenes">Scenes</option>
      </select>
      <input
        bind:this={importInput}
        type="file"
        accept=".epub,.pdf,.docx,.md,.txt,.fountain"
        onchange={handleImportFile}
        hidden
      />
      <button class="compile-btn" onclick={compileManuscript} disabled={!projectId}>Compile</button>
    </div>
  </div>

  {#if !projectId}
    <div class="project-select">
      {#if projects.length === 0}
        <p>No novel projects yet. Create one to start your beat board.</p>
        <button class="create-btn" onclick={createProject}>New Project</button>
      {:else}
        <p>Select a project above to open its beat board.</p>
        <div class="project-list">
          {#each projects as p}
            <div class="project-row">
              <button class="project-item" onclick={() => { projectId = p.id; }}>
                <span class="project-title">{p.title}</span>
                <span class="project-meta">{p.word_count} words</span>
              </button>
              <DeleteButton
                doc={p}
                label="Delete novel project and its chapters"
                onDeleted={(id) => {
                  projects = projects.filter((x) => x.id !== id);
                  if (projectId === id) {
                    projectId = null;
                    selectedBeat = null;
                  }
                }}
              />
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {:else if loading}
    <div class="project-select">Loading...</div>
  {:else}
    <div class="novel-main">
      <DockSplit
        storageKey="jwe-split-novel"
        topLabel="Beat board height"
        hasBottom={!!selectedBeat}
        topCompact={boardCollapsed && !!selectedBeat}
      >
        {#snippet top()}
      {#if boardCollapsed && selectedBeat}
        <div class="board-collapsed-note">
          <span>Board hidden — editor has full height.</span>
          <button class="new-project-btn" onclick={() => (boardCollapsed = false)}>Show board</button>
        </div>
      {/if}
      {#if viewMode === 'board' && !boardCollapsed}
      {#if !loading && board.acts.length === 0 && board.sequences.length === 0 && board.scenes.length === 0}
        <div class="empty-board" role="status">
          <p>This project has no scenes yet — nothing to write in.</p>
          <button class="create-btn" onclick={startWriting} disabled={startingWriting} aria-label="Start writing">
            {startingWriting ? "Starting…" : "Start writing"}
          </button>
        </div>
      {/if}
      <div class="beat-board">
      {#each board.acts as act}
        <div
          class="act-column"
          role="group"
          aria-label="{act.doc.title} drop zone"
          ondragover={(e) => { if (dragSceneId) e.preventDefault(); }}
          ondrop={() => dropSceneIntoGroup(act.act, null)}
        >
          <div
            class="act-header"
            role="button"
            tabindex="0"
            onclick={() => selectBeat(act)}
            onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") selectBeat(act); }}
            draggable="true"
            title="Drag to reorder acts — Compile follows this order"
            ondragstart={() => { dragActId = act.doc.id; }}
            ondragover={(e) => { if (dragActId) e.preventDefault(); }}
            ondrop={() => dropActOnto(act)}
            ondragend={() => { dragActId = null; dragSceneId = null; }}
          >
            <span class="status-dot" style="background: {statusColor(act.status)}"></span>
            {act.doc.title}
            <span class="word-count">{act.doc.word_count}w</span>
          </div>

          {#each getSequencesForAct(act.act ?? 0) as seq}
            <div
              class="sequence-block"
              role="group"
              aria-label="{seq.doc.title} drop zone"
              ondragover={(e) => { if (dragSceneId) e.preventDefault(); }}
              ondrop={() => dropSceneIntoGroup(act.act, seq.sequence)}
            >
              <div
                class="sequence-header"
                role="button"
                tabindex="0"
                onclick={() => selectBeat(seq)}
                onkeydown={(e) => { if (e.key === "Enter" || e.key === " ") selectBeat(seq); }}
              >
                <span class="status-dot" style="background: {statusColor(seq.status)}"></span>
                {seq.doc.title}
              </div>

              {#each getScenesForSequence(act.act ?? 0, seq.sequence ?? 0) as scene}
                <div class="scene-card-wrapper">
                  <button
                    class="scene-card"
                    onclick={() => selectBeat(scene)}
                    draggable="true"
                    title="Drag to reorder scenes — Compile follows this order"
                    ondragstart={() => { dragSceneId = scene.doc.id; }}
                    ondragover={(e) => { if (dragSceneId) e.preventDefault(); }}
                    ondrop={() => dropSceneOnto(scene)}
                    ondragend={() => { dragSceneId = null; }}
                  >
                    <div class="scene-title">{scene.doc.title}</div>
                    {#if scene.summary}
                      <div class="scene-summary">{scene.summary}</div>
                    {/if}
                    <div class="scene-meta">
                      {#if scene.pov}<span class="meta-tag">{scene.pov}</span>{/if}
                      {#if scene.location}<span class="meta-tag">{scene.location}</span>{/if}
                      <span class="word-count">{scene.doc.word_count}w</span>
                    </div>
                  </button>
                  <div class="scene-card-actions">
                    {#if ghostCounts[scene.doc.id]}
                      <ForkBadge count={ghostCounts[scene.doc.id]} />
                    {/if}
                    <button class="fork-btn" onclick={() => forkScene(scene)} title="Fork this scene" aria-label="Fork scene">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3v12"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 01-9 9"/></svg>
                    </button>
                  </div>
                </div>
              {/each}

              <button class="add-beat-btn" onclick={() => addBeat('scene', act.act, seq.sequence)}>+ Scene</button>
            </div>
          {/each}

          <button class="add-beat-btn" onclick={() => addBeat('sequence', act.act)}>+ Sequence</button>
        </div>
      {/each}

      <div class="add-act">
        <button class="add-beat-btn act-add" onclick={() => addBeat('act')}>+ Act</button>
      </div>
    </div>
      {/if}
      {#if viewMode === 'bible'}
    <div class="bible-view">
      <h2>Story Bible</h2>
      {#each ['world_rules', 'world_timeline', 'world_characters', 'world_settings'] as kind}
        <div class="bible-section">
          <h3>{kind.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())}</h3>
          {#each bibleFacts.filter(f => f.kind === kind) as fact}
            <div class="bible-fact">
              <span class="fact-text"><strong>{fact.key}</strong>: {fact.value}</span>
              <button
                class="fact-delete"
                onclick={() => handleBibleDelete(fact.id)}
                title="Delete this fact"
                aria-label="Delete fact {fact.key}"
              >×</button>
            </div>
          {/each}
          <div class="bible-add">
            <input
              class="bible-input"
              placeholder="Key (e.g. Elena — motive)"
              bind:value={bibleNewKey[kind]}
              aria-label="New fact key for {kind}"
            />
            <input
              class="bible-input"
              placeholder="Value"
              bind:value={bibleNewVal[kind]}
              aria-label="New fact value for {kind}"
              onkeydown={(e) => { if (e.key === 'Enter') handleBibleAdd(kind); }}
            />
            <button
              class="bible-add-btn"
              onclick={() => handleBibleAdd(kind)}
              disabled={!bibleNewKey[kind]?.trim()}
              title="Add fact"
            >Add</button>
          </div>
        </div>
      {/each}
    </div>
      {/if}
      {#if viewMode === 'cast'}
    <div class="cast-view">
      <h2>Cast & Places</h2>
      <p class="cast-sub">Auto-extracted on every save — Story Bible names first, then capitalized names. Click an entity for every appearance.</p>
      <div class="cast-actions">
        <button class="bible-add-btn" onclick={loadCast} disabled={castLoading}>{castLoading ? "Loading…" : "Refresh"}</button>
        <button class="bible-add-btn" onclick={backfillCast} disabled={castBackfilling} title="Index every existing document (older docs predate auto-indexing)">
          {castBackfilling ? "Indexing…" : "Index all docs"}
        </button>
      </div>
      {#if castLoading}
        <p class="cast-empty">Reading the index…</p>
      {:else if castEntities.length === 0}
        <p class="cast-empty">No names yet — write or import something with characters in it, then Refresh.</p>
      {:else}
        <div class="cast-list">
          {#each castEntities as ent}
            <button
              class="cast-item"
              class:selected={castSelected === ent.entity_norm}
              onclick={() => selectEntity(ent.entity_norm)}
              aria-expanded={castSelected === ent.entity_norm}
            >
              <span class="cast-kind cast-kind-{ent.kind}">{ent.kind}</span>
              <span class="cast-name">{ent.display}</span>
              <span class="cast-counts">{ent.doc_count} doc{ent.doc_count === 1 ? "" : "s"} · {ent.occ_count} mention{ent.occ_count === 1 ? "" : "s"}</span>
            </button>
            {#if castSelected === ent.entity_norm}
              <div class="cast-hits">
                {#if castHits.length === 0}
                  <p class="cast-empty">No appearances found.</p>
                {:else}
                  {#each castHits as hit}
                    <button class="cast-hit" onclick={() => openEntityHit(hit)}>
                      <span class="cast-hit-doc">{hit.doc_title}</span>
                      <span class="cast-hit-snippet">{hit.snippet}</span>
                    </button>
                  {/each}
                {/if}
              </div>
            {/if}
          {/each}
        </div>
      {/if}
    </div>
      {/if}
        {/snippet}
        {#snippet bottom()}
      {#if selectedBeat}
        <div class="beat-dock">
          {#if activeGhostId && activeGhostParentId}
            <DocForkPanel
              forkId={activeGhostId}
              originalId={activeGhostParentId}
              onClose={() => { activeGhostId = null; activeGhostParentId = null; }}
              onMerged={() => { loadProject(); loadGhostCounts(); }}
            />
          {:else}
            <DocDetail
              backLabel="Beat board"
              onBack={() => { selectedBeat = null; }}
              onDeleted={() => {
                selectedBeat = null;
                loadProject();
                loadProjects();
              }}
            />
          {/if}
        </div>
      {/if}
        {/snippet}
      </DockSplit>
    </div>
  {/if}

  {#if compiledOutput}
    <div class="compiled-overlay">
      <div class="compiled-content">
        <div class="compiled-header">
          <h2>Compiled Manuscript</h2>
          <div class="compiled-actions">
            <select bind:value={compileFormat} title="Manuscript format" aria-label="Manuscript format">
              {#each compileFormats as fmt}
                <option value={fmt}>.{fmt}</option>
              {/each}
            </select>
            <button class="download-btn" onclick={downloadManuscript} disabled={compiling} title="Download the compiled manuscript in the selected format">
              {compiling ? 'Working…' : 'Download'}
            </button>
            <button onclick={() => compiledOutput = ''}>Close</button>
          </div>
        </div>
        <pre class="compiled-text">{compiledOutput}</pre>
      </div>
    </div>
  {/if}
</div>

<style>
  .novel-workspace {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .novel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .novel-header h1 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
  }

  .project-picker {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .project-cover {
    height: 40px;
    width: auto;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border-subtle);
    object-fit: cover;
  }

  .view-toggle {
    display: flex;
    gap: var(--space-1);
  }

  .view-toggle button {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .view-toggle button.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .import-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .import-btn:hover:not(:disabled) {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .import-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .split-select {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .import-progress {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    align-self: center;
    white-space: nowrap;
  }

  .import-cancel {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--accent-semantic-red);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--accent-semantic-red);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .project-select {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    color: var(--text-muted);
  }

  .novel-main {
    flex: 1;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
  }

  /* Empty project: unmissable single action into a writable editor. */
  .empty-board {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    padding: 28px 16px;
    margin: 12px;
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-muted);
    text-align: center;
  }

  /* Docked editor: fills the DockSplit bottom slot. */
  .beat-dock {
    flex: 1 1 auto;
    min-height: 0;
    overflow: hidden;
    display: flex;
    flex-direction: column;
    background: var(--surface-base);
  }

  .project-row {
    display: flex;
    align-items: stretch;
    gap: var(--space-1);
  }

  .project-row .project-item {
    flex: 1;
  }

  .project-row > :global(.delete-btn) {
    align-self: center;
  }

  .project-picker {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .project-picker select {
    height: 30px;
    max-width: 220px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .new-project-btn,
  .create-btn {
    height: 30px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    white-space: nowrap;
  }

  .new-project-btn:hover,
  .create-btn:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .project-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 280px;
  }

  .project-item {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    cursor: pointer;
  }

  .project-item:hover {
    border-color: var(--accent-primary);
  }

  .project-meta {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
  }

  .beat-board {
    display: flex;
    gap: var(--space-4);
    padding: var(--space-4);
    overflow-x: auto;
    overflow-y: auto;
    flex: 1 1 auto;
    min-height: 0;
  }

  .act-column {
    min-width: 300px;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .act-header {
    font-family: var(--font-heading);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    padding: var(--space-2);
    display: flex;
    align-items: center;
    gap: var(--space-2);
    cursor: pointer;
  }

  .sequence-block {
    border-left: 2px solid var(--border-subtle);
    padding-left: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .sequence-header {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .scene-card {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    text-align: left;
    cursor: pointer;
    color: var(--text-primary);
    flex: 1;
    min-width: 0;
  }

  .scene-card-wrapper {
    display: flex;
    align-items: stretch;
    gap: var(--space-1);
  }

  .scene-card-actions {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
  }

  .scene-card-wrapper:hover .scene-card-actions {
    opacity: 1;
  }

  .fork-btn {
    background: none;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 2px 4px;
    cursor: pointer;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: color 0.15s, border-color 0.15s;
  }

  .fork-btn:hover {
    color: var(--accent);
    border-color: var(--accent);
  }

  .scene-title {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-1);
  }

  .scene-summary {
    font-size: var(--font-size-xs);
    color: var(--text-secondary);
    margin-bottom: var(--space-2);
  }

  .scene-meta {
    display: flex;
    gap: var(--space-1);
    flex-wrap: wrap;
    align-items: center;
  }

  .meta-tag {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius-full);
    background: var(--surface-overlay);
    color: var(--text-muted);
  }

  .word-count {
    font-size: 10px;
    color: var(--text-muted);
    margin-left: auto;
  }

  .status-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .add-beat-btn {
    padding: var(--space-1) var(--space-2);
    border: 1px dashed var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    cursor: pointer;
    text-align: left;
  }

  .add-act {
    min-width: 200px;
    display: flex;
    align-items: flex-start;
    padding-top: var(--space-6);
  }

  .act-add {
    font-size: var(--font-size-sm);
    padding: var(--space-2) var(--space-4);
  }

  .bible-view {
    padding: var(--space-4);
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .cast-view {
    padding: var(--space-4);
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .cast-view h2 {
    font-family: var(--font-heading);
    margin-bottom: var(--space-1);
  }

  .cast-sub {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0 0 var(--space-3);
  }

  .cast-actions {
    display: flex;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .cast-empty {
    color: var(--text-muted);
    font-size: var(--font-size-sm);
  }

  .cast-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .cast-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }

  .cast-item.selected {
    border-color: var(--accent-primary);
  }

  .cast-kind {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 2px 8px;
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    color: var(--text-secondary);
    flex-shrink: 0;
  }

  .cast-kind-person {
    color: var(--accent-semantic-green);
  }

  .cast-kind-place {
    color: var(--accent-semantic-blue);
  }

  .cast-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cast-counts {
    margin-left: auto;
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
    flex-shrink: 0;
  }

  .cast-hits {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin: 0 0 var(--space-2) var(--space-4);
  }

  .cast-hit {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 2px;
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    border: none;
    cursor: pointer;
    text-align: left;
  }

  .cast-hit:hover {
    background: var(--surface-raised);
  }

  .cast-hit-doc {
    font-size: 12px;
    font-weight: 600;
    color: var(--accent-primary);
  }

  .cast-hit-snippet {
    font-size: 12px;
    color: var(--text-secondary);
    line-height: var(--line-height-relaxed);
  }

  .bible-view h2 {
    font-family: var(--font-heading);
    margin-bottom: var(--space-4);
  }

  .bible-section {
    margin-bottom: var(--space-4);
  }

  .bible-section h3 {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    margin-bottom: var(--space-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .bible-fact {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: var(--space-2);
    border-left: 2px solid var(--border-subtle);
    font-size: var(--font-size-sm);
    margin-bottom: var(--space-1);
  }

  .bible-fact .fact-text {
    flex: 1;
    min-width: 0;
  }

  .fact-delete {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    color: var(--text-muted);
    font-size: 14px;
    line-height: 1;
  }

  .fact-delete:hover {
    background: var(--surface-hover);
    color: var(--accent-semantic-red);
  }

  .bible-add {
    display: flex;
    gap: var(--space-2);
    margin: var(--space-2) 0 var(--space-3) 0;
  }

  .bible-add .bible-input {
    flex: 1;
    min-width: 0;
    font-size: var(--font-size-sm);
  }

  .bible-add-btn {
    flex-shrink: 0;
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .bible-add-btn:hover:not(:disabled) {
    background: var(--surface-hover);
    color: var(--text-primary);
  }

  .bible-add-btn:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }

  .compiled-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
  }

  .compiled-content {
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    width: 90vw;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .compiled-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .compiled-header h2 {
    font-family: var(--font-heading);
  }

  .compiled-header button {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .compiled-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .compiled-actions select {
    height: 30px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .compiled-header .download-btn {
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }

  .compiled-header .download-btn:disabled {
    opacity: 0.5;
    cursor: wait;
  }

  .compiled-text {
    padding: var(--space-4);
    overflow-y: auto;
    font-family: var(--font-body);
    font-size: var(--font-size-base);
    line-height: var(--line-height-relaxed);
    white-space: pre-wrap;
    max-height: 60vh;
  }
</style>
