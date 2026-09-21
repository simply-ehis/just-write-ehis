# CANONICAL SPEC — Just Write ehis
*(originally drafted as "Personal Writing Super App" — named in Amendment 7)*

**Version:** 1.0 LOCKED
**Date:** 2026-09-13
**Status:** Canonical. Deviations require an explicit amendment to this document, not a chat message.

---

## 0. Identity

A personal super app for **writing and everything around writing** — docs, fiction, scripts, knowledge, reading, and an AI that knows your work.

It is NOT a note-taking app with ambitions, NOT a learning app, NOT a second brain for its own sake. Writing is the identity. Everything else serves the writing.

---

## 1. Non-Negotiables (Constitution)

1. **No MVP. No stubs.** Every shipped feature is complete: full UI, full logic, full edge-case handling. A feature that cannot be built to this standard this cycle is not built this cycle — it is not shipped half-done.
2. **One core engine, many views.** Six-plus workspaces are presentation layers over ONE document store. Never duplicate storage logic per workspace.
3. **Files on disk are the source of truth.** Plain `.md` + frontmatter, human-readable folder layout. SQLite is an index, never the only copy. No lock-in, ever.
4. **Local-first.** Everything works offline. AI providers are pluggable: local (llama.cpp/ollama) and API (OpenAI/Anthropic-compatible). User owns the keys.
5. **No floating UI. No transparent/glass effects. No Lucide icons.** (Phosphor or Tabler icons.) Every element is docked, opaque, bordered, grounded.
6. **The UI must be perfect or people can't use it.** Clear grouping, clear hierarchy, one primary action per context, keyboard-first, zero dead clicks, zero mystery meat.
7. **Fast and light is a feature.** See performance budget §14.

---

## 2. Stack (Locked)

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust backend), desktop + Android from one codebase |
| UI | Svelte 5 + shadcn-svelte (Phosphor/Tabler icon swap) |
| Same codebase also runs as | PWA (browser shell for instant dogfooding) |
| Editor | CodeMirror 6, one dark + one light opaque theme |
| DB | SQLite via `tauri-plugin-sql` + sqlx |
| Hot state | redb/sled (drafts, undo, tab stacks) |
| Graph | Custom canvas/SVG renderer + d3-force layout (no heavy graph lib) |
| Reader | epub.js (epub), pdf.js (pdf), mammoth.js (docx), native (md/txt) |
| Conversion | pandoc as Tauri sidecar binary (+ typst/weasyprint for PDF) |
| AI | Rust `LlmProvider` trait: Local (OpenAI-compatible, llama.cpp/ollama) + Api impls |
| Embeddings | fastembed (local) or API; store in sqlite-vec or LanceDB |

---

## 3. Architecture — The Core Engine

### 3.1 Storage layout (on disk)

```
<vault>/
  logs/            YYYY/MM/YYYY-MM-DD.md
  write/           sessions & free docs
  map/             (no folder — map is a view, docs live in their homes)
  novels/<name>/   chapters/ characters/ world/ notes/ snippets/ bible.md
  scripts/<name>/  *.fountain + notes/
  projects/<name>/ any structure
  reader/          imported books + exports
  inbox/           quick-captured snippets, untriaged
```

### 3.2 Data model

```sql
docs(id, workspace, kind, title, path, parent_id,
     created_at, updated_at, word_count, reading_position,
     status, frontmatter_json, activity_score, embedding_ref)

backlinks(source_id, target_id, context_snippet)   -- sentence around the link
links_implicit(source_id, target_id, match_type)   -- unlinked mentions

cards(id, source_doc, question, answer, ease, interval_due, reps)   -- continuity only
bible_facts(id, project, fact, source_doc, source_pos)              -- Story Bible
snapshots(id, doc_id, ts, content_hash)                             -- version history
usage_events(doc_id, event, ts)   -- open | edit | ai_call | read | convert
tab_state(workspace, tab_stack_json, active_id, cursor, scroll)
conversations(doc_id, role, content, ts)                            -- AI panel memory
craft_metrics(doc_id, metrics_json, ts)                             -- skills profiling
```

**Invariant:** anything with an `id` in `docs` is a file. Anything in a table is derived, rebuildable from files.

### 3.3 Rust command surface (Tauri commands, the only API)

`doc.create / doc.get / doc.save / doc.delete / doc.move / doc.search`
`backlinks.get / backlinks.all / graph.query`
`ai.complete(stream) / ai.ask / ai.styleop / ai.autocorrect / ai.summarize`
`ai.bible.update / ai.bible.check`
`convert.run(in, out_fmt) / import.file`
`tabs.get / tabs.set / tabs.score`
`review.due / review.answer`
`palette.actions`

---

## 4. Workspaces (Tabs) — Full Feature Specs

Global tab bar, per workspace. Sidebar navigation is fixed and ordered:

```
Logs · Write · Map · Novel · Script · Projects · Reader
```

### 4.1 Logs
- Auto-titled daily note per date; created silently on open.
- Timestamped blocks: `Ctrl+T` inserts time; quick-capture input pinned at top.
- Calendar strip for day jumping; day list with word counts.
- Auto-linking: docs you touched today are listed at the bottom of the daily note (derived, not stored).

### 4.2 Just Write
- Blank page. Typewriter mode (caret centered, page scrolls). Focus dimming on the current paragraph.
- Sessions are docs (`workspace: write`); "Continue last session" is the default landing.

### 4.3 Node Map
- Canvas graph: custom renderer, viewport culling, 5k nodes @ 60fps (§14).
- **Backlinks are automatic:** `[[wikilink]]` and bare `doc-id` refs extracted on save → `backlinks` with surrounding-sentence context. Drag node A onto node B to link; click to open.
- Unlinked mentions computed on save ("this doc mentions Elena but isn't linked to her sheet").
- Graph overlays: orphans (never linked), hubs, clusters — toggleable filters, not decoration.

### 4.4 Novel Studio
- Project workspace: fixed sections `Chapters / Characters / World / Notes / Snippets`.
- Per-chapter: word target, status (idea/draft/revision/final), scene-goal field in frontmatter.
- **Story Bible (`bible.md` + `bible_facts`):** AI maintains it on every chapter save (summaries, character facts, timelines). Ghost-suggestion engine runs contradiction checks against it ("Ch.9 says Elena has a brother; her sheet says only child"). Story Bible digest is auto-injected into every AI call in this workspace.

### 4.5 Script
- Scripts stored as **Fountain** plain text.
- Custom Fountain parser (Rust) → semantic navigator (scene/character/transition outline), character dialogue-frequency stats, export to PDF/HTML via sidecar.

### 4.6 Projects
- Generic multi-doc containers with dashboard: progress bar from child doc statuses, word-count trend, open AI suggestions for this project.

### 4.7 Reader
- Formats: md, txt, epub, pdf, docx. Position syncs to `reading_position`.
- Bookshelf view: to-read / reading / finished / rated.
- Books are docs → they enter the graph, get backlinks, can be quoted into any workspace.

### 4.8 Inbox (not a sidebar tab — a global capture system)
- System-tray quick-capture (works app-closed). Lands in `inbox/`. Weekly triage flow: turn each snippet into a doc in its proper home or delete.

---

## 5. AI Panel (docked right, hotkey toggle, context-aware per workspace)

Three modes in one panel, conversation memory per doc (`conversations`):

1. **Chat** — answers cite sources inline (`[→ Ch.4, Scene 2]`); click opens the doc at position. Refusal to answer without sources is the default behavior, not an option.
2. **Composer** — style ops with diff preview, accept/reject per hunk: humanize, tighten, expand, outline, dialogue pass, custom.
3. **Ghost** — passive intelligence strip: autocomplete inline in editor; notices ("this scene contradicts the bible", "metaphor reused from Ch.2").

**Context assembly (per workspace, locked):**
- Common: current doc, selection, recent conversation.
- Novel: + Story Bible digest + chapter summary + previous scene.
- Logs: + last 7 daily notes.
- Reader: + current book metadata + position.
- Map/Projects: + linked docs one hop out.

---

## 6. AI Brain

- `LlmProvider` trait (Rust): `Local` (llama.cpp/ollama, OpenAI-compatible) and `Api` impls. Swap without touching features.
- Small fast model for autocomplete; larger model for chat/ops. Configurable.
- Autocorrect = diff-based suggestions, never silent mutation.
- RAG: chunk on save → embed → `sqlite-vec`. "Ask" searches library + current workspace.
- All AI calls logged in `usage_events` (feeds smart tabs + skills).

---

## 7. Properties & Views (Notion layer)

- YAML frontmatter on any doc: tags, status, rating, custom fields.
- Per-tag views: table and board, over any query result. One code path; filters/sorts per view, persisted.

---

## 8. Memory Layer & Smart Tabs (Sorting Logic — Locked)

### 8.1 Per-workspace landing behavior (deterministic, from `tab_state`)
| Workspace | Opens to |
|---|---|
| Logs | today's note |
| Write | last session |
| Novel | chapter last edited |
| Reader | last book at position |
| Map | last viewport |
| Script/Projects | last active doc |

### 8.2 Tab sorting (locked algorithm)
- `activity_score` decays ~daily, bumps on open/edit/ai_call/read (weighted, from `usage_events`).
- Tabs sort by score **except**: the active tab and the two adjacent tabs are positionally pinned until the user leaves the tab bar's context. Shuffling happens only when the user is not looking at it.

### 8.3 Usage memory (user-facing)
- Queryable: "docs I reopen but never finish", streak heatmap (words/day goal), writing-time patterns.
- Feeds the Skills page and optional AI awareness ("here's your open evening draft").

---

## 9. Skills & Craft Tracking

- **Craft page:** AI passively profiles prose per doc over time — dialogue ratio, sentence-length trend, filter-word frequency, repeated constructions. Trend lines, not scores. The proof-of-improvement hook.
- **App skills:** unused-power-feature detection ("you've never used the Node Map — press M") shown sparingly, dismissible forever.

---

## 10. Global Systems

- **Command palette** `Ctrl+K`: fuzzy over docs, actions, AI ops, workspace jumps. Primary navigation for power users.
- **Global search:** SQLite FTS5 over content + frontmatter.
- **Version history:** snapshot per save; timeline slider in editor; restore any point.
- **Backup:** one-folder zip export; automatic timestamped backup on app open.
- **Export:** any doc → md / txt / docx / epub / html / pdf (pandoc + typst sidecars).
- **Onboarding:** none. First open = today's log, cursor blinking.

---

## 11. Explicitly Out of Scope (Locked)

- **General learning / flashcards / spaced repetition / Review tab:** CUT. The continuity need is fully covered by the Story Bible. Revisit only as a dedicated quarantined tab, post-1.0, if real usage demands it.
- Theme marketplace, plugins, sync service, collaboration, mobile-only features, floating/transparent UI, Lucide icons.

---

## 12. UI Standards (Perfect-or-nothing)

- **Layout:** fixed sidebar (nav) / tab bar / single content pane / status strip. Docked panels only (AI panel right). Nothing floats, nothing overlays content unexpectedly.
- **Grouping:** controls grouped by frequency — primary action always in the same position per workspace; secondary actions in a consistent overflow.
- **Hierarchy:** one accent color; borders + spacing do the grouping work, not shadows or translucency.
- **Sorting logic (UI):** lists default to recency; user sorts are sticky per view; pinned items beat sorted items.
- **Keyboard-first:** every action has a binding; every binding shown in palette.
- **States:** every button/loading/empty/error state designed, none default-browser.

---

## 13. Build Order (each step ships complete, no stubs)

1. Core engine: doc store, SQLite index, CodeMirror editor, tab system + persistence.
2. Logs + Just Write.
3. Node Map + backlinks + unlinked mentions.
4. Reader + conversion sidecars.
5. Novel Studio + Story Bible.
6. Script (Fountain parser + navigator).
7. AI panel + providers + autocomplete + RAG + style ops + Ghost.
8. Memory layer + smart tabs (on real telemetry) + Skills/Craft.
9. Properties/table-board views, palette, search, versions, backup, inbox.
10. Android responsive pass + performance budget verification + final UI polish.

---

## 14. Performance Budget (Locked)

- Cold start < 1s.
- Graph: 5,000 nodes / 20,000 edges at 60fps.
- Editor: zero dropped keystrokes; AI autocomplete ghost < 300ms to first token (local small model).
- App idle memory < 300MB desktop.
- Search: < 50ms over 50k docs.

---

*Amendments: append a dated `## Amendment N` section below; never edit locked sections in place.*

---

## Amendment 1 — AI Structurizer (Blueprint Mode) · 2026-09-14

Write a raw plan or dump of text, annotate it with natural-language directives in braces `{like this}`, and the AI transforms it into the target structure/format on command.

### Directive syntax
- `{...}` = inline directive to the AI. Never rendered in final output; consumed during structurize.
- Directives may appear mid-sentence, on their own line, or wrapping a block.
- Nested intent allowed: `{make this a table with columns for ...}`, `{draw a timeline}`, `{split into chapters, one per act}`, `{expand each bullet to 2 paragraphs}`.

### Pipeline (small model, §A1.3)
1. **Extract** — parse all `{...}` blocks into an instruction tree mapped to content ranges.
2. **Structure** — reorder, group, nest, and split the content per instructions.
3. **Render** — emit the final format: headings, lists, tables, task boards (via Properties §7), frontmatter.
4. **Diagrams** — diagram directives (`{draw ...}`, `{chart ...}`, `{graph ...}`) emit Mermaid source, rendered inline in the editor/reader pane. Supported per target: flowchart, timeline, gantt, relationship graph, bar/line chart (via mermaid or chart renderer).
5. **Review** — full diff preview, accept/reject per hunk (same control as Composer §5). Structurize never applies silently.

### Target formats per workspace
| Workspace | Structurize outputs |
|---|---|
| Novel | chapter outline, beat sheet, character sheets, scene cards, bible facts |
| Script | Fountain structure, scene list, dialogue pass |
| Projects | task breakdown w/ statuses, board columns, milestone timeline |
| Logs/Write | cleaned prose, headings, re-tagged entries |
| Any doc | tables, outlines, properties/frontmatter, diagrams |

### A1.3 Small-model brain (locked)
A separately configurable lightweight model owns ALL light tasks:
autocorrect, autocomplete, brace extraction (pass 1), structurize passes 1–2,
title/tag suggestions, Ghost notices filtering.
Heavy chat/composer/bible work uses the main model. Failover: if small model absent, main model covers (with a perf warning, not a stub).

---

## Amendment 2 — Blank Chat (Brainstorm Mode) · 2026-09-14

AI panel gains a **context toggle**: `Blank ⇄ Contextual`.
- **Blank**: zero injection — no doc, no workspace, no memory. Pure model. For brainstorming, venting ideas, or deliberately turning context off.
- Blank conversations are stored but create no backlinks and never enter the graph.
- One-click **"Promote to doc"** turns a blank conversation into a real doc in the current workspace (becomes graph-visible only then).
- Default is Contextual; the toggle state persists per workspace.

---

## Amendment 3 — Chat → Editor Write-back · 2026-09-14

Every AI response in the panel carries write-back actions (keyboard-first):
- **Insert at cursor** (`Ctrl+Enter`)
- **Replace selection**
- **Append to doc**
- **Copy** (`Ctrl+Shift+C`)
Streaming insertion is supported: hold the action during generation to pipe output directly into the editor. Works in every workspace; in Reader, write-back targets the current margin note.

---

## Amendment 4 — UI Hierarchy & Component Placement (locked) · 2026-09-14

### A4.1 Component tree
```
AppShell (100vh, grid, nothing scrolls but content)
├─ Sidebar        fixed 220px, left
│  ├─ Wordmark
│  ├─ Workspace nav (7 tabs, fixed order §4) + Inbox badge
│  ├─ Vault switcher
│  └─ Streak + backup indicator
├─ TabBar         fixed, under top edge of content column
│  ├─ Tabs (active cluster pinned per §8.2)
│  ├─ "+" (new doc)
│  └─ Overflow: all tabs, activity-sorted
├─ ContentPane    the ONLY primary scroll region
│  ├─ BreadcrumbBar (doc path + parent_id chain, always visible)
│  ├─ EditorPane  (CM6 + ghost text + inline mermaid blocks)
│  ├─ GraphPane   (canvas, breadcrumb shows filter state)
│  ├─ ReaderPane  (pagination, margin notes)
│  └─ DashboardPane (projects: progress, trends, open suggestions)
├─ Inspector      optional right dock (left of AI panel): outline,
│                 properties, backlinks — per-workspace defaults
├─ AIPanel        fixed right dock, collapsible: mode tabs
│                 (Chat/Composer/Ghost strip) + Blank toggle + context chips
├─ StatusStrip    fixed 24px bottom: word count · save state ·
│                 model state (small/main) · cursor · position
└─ Overlays       the ONLY floating elements permitted, transient:
                  command palette, dialogs, diff-review modal, toasts
```

### A4.2 Placement rules
- Sidebar, TabBar, StatusStrip never move, never hide.
- Panels (AI, Inspector) dock and resize; they never overlap content — content shrinks.
- One primary action visible per context; everything else lives in the overflow or palette.
- Breadcrumb is the single source of "where am I" — no duplicate location indicators.
- Z-order discipline: content 0, docks 1, overlays 2. Nothing at z1 may imitate z2.

### A4.3 Doc hierarchy
- Physical: folder conventions per §3.1.
- Logical: `parent_id` chain shown in BreadcrumbBar; Properties views (§7) are the query-based hierarchy and may cross folders.
- Outline (headings) lives in Inspector; doc structure (sections) lives in Breadcrumb — never conflate the two.

---

## Amendment 5 — Corrections & Missing Pieces · 2026-09-14

### Corrections (bugs & contradictions in the current spec)

1. **Dead spaced-repetition code paths.** `cards(id, source_doc, question, answer, ease, interval_due, reps)` (§3.2) and the `review.due` / `review.answer` commands (§3.3) are full SRS scheduling fields — but §11 explicitly cuts spaced repetition and the Review tab from v1.0, calling it out for a "post-1.0, quarantined tab" only. Ship v1.0 without `cards`/`review.*` entirely; bring them back in whatever amendment actually builds that tab. `bible_facts` already covers Story Bible contradiction-checking on its own — it doesn't need `cards`.
2. **`conversations.doc_id` breaks in Blank mode.** Amendment 2 says Blank conversations "are stored but create no backlinks and never enter the graph," and only get a `doc_id` once "Promoted to doc." But §3.2 defines `conversations(doc_id, role, content, ts)` with `doc_id` implied required. Make `doc_id` nullable (or give Blank sessions their own `session_id`) so a conversation can exist before promotion.
3. **No system tray on Android.** §4.8's Inbox quick-capture assumes a system tray, which Android doesn't have. Needs an Android-native equivalent: persistent notification with a text-input action, a home-screen widget, or registering as a share-target so you can capture from any app.
4. **Two devices, no sync, no safety net.** The stack is desktop + Android from one codebase (§2), and §11 correctly cuts a built-in sync *service* — but nothing in the spec makes the app safe to pair with an external sync tool (Syncthing, Dropbox, etc.), which is presumably how you'd actually move a vault between the two. Add: a filesystem watcher that detects external file changes and reloads/re-indexes automatically, and atomic writes (write to temp file, then rename) so a sync tool writing mid-save can't corrupt a doc. This isn't a sync service — it's what makes "files are the source of truth" actually safe once more than one process touches them.
5. **`redb`/`sled` next to SQLite is one storage engine too many.** For a single-user, personal-scale app, SQLite in WAL mode is fast enough for tab stacks, drafts, and undo — you don't need a second embedded database for "hot state." Cut it unless you actually profile a bottleneck that SQLite can't clear.
6. **Pick one vector store.** §2 lists "`sqlite-vec` or LanceDB" — that's a decision, not a spec. Go with `sqlite-vec`: it keeps embeddings in the same file as everything else, which matches your own no-lock-in principle (§1.3) better than a second store format would.
7. **`parent_id` has no assignment rule.** §3.2 has `parent_id` for logical hierarchy, and §A4.3 says it's separate from the folder path — but nothing says how or when it gets set. Lock it down: `parent_id` is set only by an explicit user action (drag onto a node in Map, or a "Set parent" command), defaults to `null`, and is never auto-inferred from folder location. Otherwise this quietly turns into two competing, drifting hierarchies.
8. **`snapshots` needs a retention rule.** "Snapshot per save" (§10) with no pruning policy means years of daily writing turns into an ever-growing pile of near-duplicate rows. Add: dedupe consecutive identical `content_hash`es, and thin snapshots older than ~30 days down to one-per-day (keep everything recent at full resolution).
9. **"Refusal to answer without sources" is scoped too broadly.** As written (§5), Chat *always* refuses to answer without citing a source — but that breaks general craft questions in Contextual mode ("how do I write a better chapter opening?") that have nothing to do with your docs. Scope the rule to claims *about your own work* (facts, characters, plot points) — general writing-advice questions don't need a citation.
10. **Ghost autocomplete fights typewriter mode.** §4.2's Just Write is built for uninterrupted flow (typewriter scroll, focus dimming) but §5's Ghost strip runs inline autocomplete everywhere by default. Suppress Ghost text while actively typing in a Just Write session (resume on pause), or give Just Write its own "no AI" toggle.

### Additions (features worth locking in)

1. **Compile / manuscript export.** Right now §10 export is one-doc-at-a-time. A novel or script app without a way to combine an ordered set of docs (say, every chapter with `status: final`, or an arbitrary Properties query) into a single exported manuscript is missing its most-used feature. Add a `compile.run(query|ordered_ids, out_fmt)` command alongside `convert.run`.
2. **Vault-wide find & replace, rename-aware.** You already track `backlinks` and `links_implicit` — extend that into a real "rename this character everywhere" flow: renaming a doc's title updates its wikilinks across the vault (or at minimum surfaces every place that needs a manual look).
3. **Per-workspace AI privacy scope.** Logs is your journal — the most sensitive thing in the vault — and right now it gets the same AI treatment as everything else (§5: "+ last 7 daily notes" injected into context). Add a per-workspace toggle: "never send this workspace's content to an API provider, local model only." Same goes for the passive Craft/Skills profiling in §9 — that reads across *everything* you've ever written, so it should be locked to the small/local model list in §A1.3, not sent to an API by default.
4. **A second, encrypted "Private Vault."** §A4.1 already has a Vault switcher in the sidebar — use it. Keep the main vault plaintext and human-readable (matches your §1.3 philosophy), but let someone spin up a second vault that's encrypted at rest, for anything they don't want sitting in plain `.md` on a phone that could get lost or stolen. Pair with a basic app-level PIN/biometric lock, which is worth having regardless of encryption, since this thing is going on Android.
5. **Undo as one step, not many.** Every AI write-back (Amendment 3) or Composer accept should land in the editor's undo stack as a single atomic step — not one undo per streamed character. Small thing, but you'll notice immediately if it's missing.
6. *(smaller, optional)* A lightweight session timer in Just Write — start a session, see elapsed time / words-this-session, no pressure mechanics, just visible feedback while you're in flow.

---

## Amendment 6 — Settings Tab · 2026-09-14

You're right — nothing in v1.0 has a home for changing any of it. Every default (§4–§9) was specified with no place to actually go and change it.

### A6.1 Where it lives
- **Not a workspace tab.** The 7-tab bar (§4) is strictly for doc-backed workspaces — one core engine, many views (§1.2). Settings isn't documents, it's app + vault state, so it doesn't get a tab, a tab-bar entry, or a breadcrumb; putting it in the workspace row would break the "views over one doc store" model.
- Fixed gear icon at the bottom of the Sidebar, next to the Vault switcher and streak/backup indicator (extends §A4.1's sidebar list — doesn't edit it in place). Clicking it swaps the ContentPane to a SettingsPane, same docked rules as everything else (§12): no modal, no overlay, nothing floats.
- SettingsPane layout: category list on the left, content on the right. Same two-pane pattern used everywhere else — nothing new to learn.

### A6.2 Two tiers of config (new)
This split matters because vaults are meant to be portable and human-readable (§1.3), and some settings are secrets that should never end up sitting inside a synced folder.

- **App-level** — per install, lives outside the vault in the OS app-data dir (secrets like API keys go in the OS keychain, not a plaintext file): local-model endpoint & model paths, API keys, app-lock PIN/biometric, window state, icon set (Phosphor/Tabler), theme, keybinding remaps, notification prefs.
- **Vault-level** — `<vault>/.settings.json`, plain and human-readable like everything else in §3.1, travels with the vault when you copy or sync it: per-workspace AI privacy toggles, streak goal, snapshot retention window (Amendment 5, correction 8), craft/skills profiling on/off, this vault's backup frequency/location, file-watcher/sync-safety on/off (Amendment 5, correction 4).

New commands: `settings.get(scope, key)` / `settings.set(scope, key, value)` / `settings.provider.test` (pings a configured `LlmProvider` and reports latency + model name, so you know it actually works before you rely on it mid-sentence).

### A6.3 Categories
1. **General** — icon set, theme, default landing overrides, streak goal.
2. **Editor & Writing** — font/size/line-height, typewriter/focus-dimming defaults, autocorrect + Ghost on/off (including the typewriter-mode suppression from Amendment 5, correction 10).
3. **AI & Providers** — Local vs API per model slot (small/main), endpoint + key entry, per-workspace privacy toggles (Amendment 5, addition 3), Blank-mode default.
4. **Privacy & Security** — app lock, Private Vault passphrase (Amendment 5, addition 4), craft/skills profiling on/off.
5. **Vaults & Backup** — vault list (create/open/rename/remove), current path, backup frequency/location, manual backup/restore, snapshot retention threshold (Amendment 5, correction 8).
6. **Sync & Files** — file-watcher status on/off, conflict behavior, recent external-change reload log (Amendment 5, correction 4).
7. **Capture & Notifications** — Android capture method: notification / widget / share-target (Amendment 5, correction 3), weekly inbox-triage reminder, streak reminder.
8. **Keybindings** — full remappable table, reset to defaults; the editable counterpart to §12's "every binding shown in palette."
9. **About & Diagnostics** — version, model connection status, live snapshot against the §14 performance budget (cold start, memory, search latency), open data folder, view logs.

### A6.4 One rule
Every toggle needs a sane default that already works. Settings is where you go to *change* something, never where you're forced to go to make the app functional in the first place — first open is still "today's log, cursor blinking" (§10).

---

## Amendment 7 — Name, Responsive Shell, Arrangement, Voice & Light-Task Models · 2026-09-14

### A7.1 Name
The app is **Just Write ehis** (read as "Just Write This" — "ehis" is the stylized spelling, on purpose). Updates the doc title above; §0 Identity's prose is left untouched per the locked-section rule — this amendment is the naming record.

### A7.2 One core, two shells
Desktop and mobile don't need identical layouts — they need to share the same brain. Both shells call the same Rust command surface (§3.3) against the same doc store (§1.2); only the chrome around it changes.

- **Desktop shell** (existing, §12): Sidebar (persistent, left) + TabBar (top, multiple open docs) + ContentPane (center) + SecondaryPanel (right, docked — AI chat / graph / properties).
- **Mobile shell** (new): BottomBar (Capture+, Home, Search, Workspaces, More) + NavStack (push/pop single view — tabs don't fit a phone, so this replaces them) + ContentPane (full width) + BottomSheet (anchored to the bottom edge, slides up — the mobile equivalent of the SecondaryPanel, still "docked," never floats free).
- `tab_state` (§3.2) should be scoped **per device**, not per vault. A phone restoring a 6-tab desktop layout makes no sense — session/window state stays local, only the actual documents sync via files.

### A7.3 Special per-workspace components on mobile
- **Map's graph canvas** — defaults to a list/tree view on mobile (same data, no force-graph); the canvas is available as an opt-in "zoom out" mode with pinch/pan, not the default, since a dense force-graph is hard to hit precisely with a finger.
- **Story Bible / AI chat / Properties panels** — become the BottomSheet (A7.2) instead of a persistent side column: swipe up for partial height, swipe again for full.
- **Manuscript-format views** (Novel/Script fixed-width layouts) — reflow to a single readable column for editing on a phone; the real industry-format margins only get applied at export/Compile time (Amendment 5, addition 1), not while you're actually typing on a small screen.
- **Command palette** — same overlay concept (§12), just sized for touch: full-screen on mobile instead of a small centered box on desktop.
- **Reader** — already single-column, needs nothing extra.

### A7.4 Arrangement: sorting, grouping, manual order
No default sort was ever specified anywhere lists appear (Logs, Projects, Story Bible entries, search results, Inbox). Locking it down:

- **Default sort:** last-modified, descending, everywhere. Per-view override: alphabetical, created date, or manual.
- **Manual order** is required, not optional, for anything Compile (Amendment 5, addition 1) touches — chapters need an explicit drag-to-reorder sequence independent of when they were last edited or created, since manuscript order and writing order are rarely the same thing.
- **Grouping:** by any Property (status, tag, folder), collapsible groups.
- **Saved Views:** name + filter + sort + group, pinned to a workspace — the natural extension of the Properties query system (§7) into something reusable instead of rebuilding the same filter every time.
- **Multi-select + bulk actions** — select several docs at once for tag/move/delete. Matters most in the Inbox's weekly triage flow (§4.8), where processing captures one at a time is exactly the friction that flow was supposed to remove.

### A7.5 Psychological features (small, no-guilt)
§9's streak + backup indicator and words/day heatmap are a good base. Adding, deliberately light-touch:

- **Personal bests** — longest streak, most words in a session — shown quietly to you, never framed as competition.
- **Streak grace days** — a limited number of "skip without breaking the streak" days. Pure guilt-based streaks (miss one day, lose everything) are a known way to make people quit rather than come back; a small grace buffer keeps the streak honest without making a bad day feel like a failure.
- **Session-end recap, not session-start popup** — "812 words in 24 minutes" shown once when you close a Just Write session. Nothing celebratory ever blocks the cursor on open — the whole point of open is zero friction to start typing (§10).

### A7.6 Fast open: "tap and dump"
Cold start (§14) should be dominated by exactly one thing: loading the last-active doc's text. Everything else is lazy:
- Deferred until first visit to that workspace/feature: Map's graph init, AI provider connection/model warm-up, craft-metrics computation (§9), backlinks computation.
- **Local STT/TTS models are not loaded at boot.** They load on first tap of the mic/read-aloud button. Optional: a background warm-up during the first few idle seconds after open, so they're likely ready by the time you'd reach for them — but never at the cost of delaying the cursor.

### A7.7 Voice — STT & TTS picks
Speech-to-text:
- **Moonshine** (Useful Sensors) over plain whisper.cpp tiny.en as the default: Tiny (~190MB) beats Whisper's tiny.en/base.en on both word-error-rate and speed on the OpenASR leaderboard, and — unlike Whisper, which always processes in fixed 30-second chunks — Moonshine's compute scales with actual clip length, so a short voice-dump note transcribes faster instead of waiting out a full chunk.
- For live dictation specifically (talking while it transcribes, not recording-then-transcribing): **Moonshine Voice** (released Feb 2026) is built for streaming — it computes while you're still talking. Its largest variant is only 245M params and beats Whisper Large v3 (1.5B params) on word-error-rate.
- whisper.cpp tiny.en remains a fine fallback — most mature tooling, works everywhere — but Moonshine is the better fit for short captures specifically, which is most of what this app's voice input actually is.

Text-to-speech:
- A genuinely intelligible sub-1MB neural TTS isn't really achievable with current model architectures — worth knowing before chasing that number. The lightest *good* option: **Kokoro-82M**, quantized to ONNX q4, lands around **86MB** with no noticeable quality loss versus the full 326MB version — runs happily alongside a small LLM in memory, roughly a minute of audio per 1,000 characters of text.
- If even 86MB feels heavy: Piper TTS is a known lighter, snappier, slightly more robotic-sounding alternative — worth a side-by-side test since the harness is already in place.

### A7.8 Light-task model shortlist (≤0.5B params, Q4-quantizable, GGUF/llama.cpp-compatible)
This locks down what §A1.3's "light tasks" list was always missing — an actual model:

- **LFM2.5-350M (Liquid AI, refreshed March 2026)** — top pick. 350M params, runs under 1GB of memory, day-one llama.cpp/GGUF support, and specifically strong at tool-use, data extraction, and structured output — which is exactly what autocomplete, tagging, and craft-metrics extraction (§9) need. ~313 tok/s on a plain AMD CPU with no GPU involved.
- **Falcon-H1-Tiny family (TII)** — a set of ultra-small specialists (as small as 90–100M params) instead of one generalist: a Coder-90M, a dedicated Tool-Calling variant, a Multilingual-100M. Worth having on the bench to swap in per-task if the single generalist underperforms on something narrow.
- Also in range: Gemma 3 270M (Google) as another sub-cap generalist option.
- Since the harness is already built: pull LFM2.5-350M GGUF Q4 as the default light-task model, keep a Falcon-H1-Tiny specialist or two on standby to A/B against it for whichever specific task turns out to be the weak point.

### A7.9 Where PWA actually fits
Tauri already covers Mac, Windows, Linux, and Android from one codebase (§2) — that's already cross-platform; a PWA doesn't add device coverage you don't already have.

What it *does* add: zero-install capture from any browser — dumping a thought from a borrowed machine or a work computer without installing anything. That's a real, good use case, but only as a capture-only companion, not the main app, for two concrete reasons:
1. The vault needs to be real files on disk a sync tool can watch and write to (Amendment 5, correction 4). A PWA's storage (IndexedDB/OPFS) doesn't give you that — and on Safari specifically, that storage can get silently evicted under disk pressure, which is a real risk for writing you don't want to lose.
2. Moonshine/Kokoro-style local models (A7.7) run natively inside Tauri; inside a PWA they'd run over WASM instead — slower and heavier for the same output.

Proposed shape: the full Tauri app stays the source of truth on both desktop and Android. A thin **PWA "Quick Capture"** companion — a text box and a mic button, nothing else — writes straight into Inbox, to be picked up next time the real app opens or syncs. Best of both: real cross-platform coverage where it matters, zero-install capture where that's genuinely useful.

---

## Amendment 8 — IDE Tabs, Patterns Widget, File/Markdown Browsing, Non-AI Autocorrect, Settings & Toolbar Cleanup · 2026-09-14

### A8.1 Desktop tabs, IDE-style
The TabBar (§12) gets the behavior set you'd expect from any real code editor:
- **Closable** — × on each tab, plus middle-click to close.
- **Draggable reorder** within the strip.
- **Split** — drag a tab down/sideways to split ContentPane into two side-by-side panes, each with its own tab strip. Direct answer to the earlier "Character Bible next to Chapter 5" want.
- **Overflow** — once tabs exceed available width, the strip scrolls horizontally and a chevron at the end opens a dropdown listing every open tab (click to jump). Same pattern as Chrome/VS Code, nothing novel to design.
- **Pinned tabs** stay leftmost, immune to overflow scrolling.
- **Reopen closed tab** — keybinding restores the last 10 closed tabs, short-lived stack, cleared on app quit.
- Right-click: Close / Close Others / Close to the Right / Pin / Reveal in File Browser (A8.3).

### A8.2 Home "Patterns" widget — deterministic, no ML, no regex
This needs to be honest about what "lightweight" can actually mean: not text-content analysis (that needs NLP/heuristics to do well, which is overkill for a homepage widget) — **behavioral** pattern detection over timestamps you're already collecting. Plain aggregate queries, nothing guessed.

New table: `activity_log(id, kind, workspace, ts)` — one row per doc-open / workspace-switch / session-start event. Tiny, append-only.

Four cards, computed once per app open and cached (never recomputed on keystroke — respects A7.6's fast-open budget):
1. **Peak writing window** — bucket `snapshots.ts` by hour-of-day over the trailing 30 days, surface the top 1–2 buckets. *"You write most between 9–11pm."* One `GROUP BY strftime('%H', ts)`.
2. **Most active workspace** — `COUNT(*)` from `activity_log` grouped by workspace, trailing 7 days vs. the 7 days before that, shown as a simple delta. *"Novel Studio — up from last week."*
3. **Momentum** — this week's total word count (already tracked, §8.3) against the trailing 4-week average, expressed as a plain percentage: `(this_week - avg) / avg`. No statistics library needed.
4. **Average session length** — mean duration of Just Write sessions (A7.5's session timer) over the trailing 30 days.

That's the whole feature. If a fifth card ever needs actual text/content analysis to produce, it doesn't belong on Home — cut it rather than reach for regex-based guessing.

### A8.3 File Browser + Path Editor (new component)
The Map (§8) shows your *docs* as a graph. Nothing shows the *literal* folder structure — attachments, imported files, anything that isn't a doc. New sidebar entry: **Files**.
- Standard tree view of the vault's real folders, backed directly by the filesystem (not the `docs` table).
- **Path editor**: a breadcrumb bar at the top — each segment independently clickable to jump there, and clicking the bar itself (or a small edit icon) turns it into one editable text field you can type or paste a full path into. Same pattern as Finder/VS Code; nothing to invent.
- Right-click / long-press: Rename, Move, Reveal in OS file manager, Delete (→ Trash), Open With (routes by extension into the Markdown viewer or PDF viewer, A8.4).

### A8.4 Markdown viewer/editor + PDF (later) as side comps
- **Markdown, priority now.** Any `.md` opened from Files that *isn't* part of a structured workspace (an imported note, someone else's README, a reference doc you dropped in) opens in a lightweight raw-text view — reuses the same CodeMirror 6 instance already in the stack, no new dependency. Behaves like Notepad: open, edit raw text, save, none of the AI/workspace chrome. Opens as a side comp (SecondaryPanel on desktop, BottomSheet on mobile — A7.2), not a full workspace tab.
- **PDF, later, exactly as you scoped it.** View-only via a PDF.js-style renderer when it's built (well-understood, standard approach) — editing/annotation stays a real Phase 2 item, explicitly not started now. Flagging it here so it doesn't quietly disappear from the plan, not pretending it's built.

### A8.5 External agents/connections — recommendation: don't build the platform
Direct answer: skip a general "connect to external agents/MCP servers" framework for v1. Reasoning, not just a gut call:
- §0 is explicit that this is *not* "a second brain for its own sake" — a general external-tool framework is exactly that kind of scope creep, and it's a meaningfully bigger trust surface (something outside the app gets access to your journal) for an app whose whole premise is local-first and private.
- The `LlmProvider` abstraction (§2) already covers "bring your own AI backend" — that's the integration point that actually matters here.
- If a real, specific need shows up later (e.g. pushing a finished manuscript to one particular publishing platform), that's a narrow, named, opt-in integration added by its own amendment — not a general agent-connector platform designed up front for uses that don't exist yet.

### A8.6 Settings — control patterns
Extends Amendment 6's categories with the actual interaction spec:
- Two control types, used consistently everywhere in Settings: **toggle** (on/off) and **dropdown selector** (pick one of N). No sliders, no radio groups, no exceptions — one visual language to scan.
- **Haptics** (mobile only) — a single light tick on toggle flip, nothing on dropdown selection (reserve haptic feedback for the action that actually changes state).
- **Per-workspace accent color** — each of the 7 workspaces gets a fixed accent, used for the active-tab underline, the sidebar's active icon, and a thin top-border in ContentPane, so you always know which workspace you're in at a glance: Logs — amber · Write — graphite · Map — teal · Novel — indigo · Script — rose · Projects — slate · Reader — forest. Lives under Settings → General, next to icon set/theme.

### A8.7 Formatting toolbar — regrouped
Currently undefined in the spec, so locking it down as clusters instead of a flat row of buttons:
- **Text** — Bold, Italic, Underline, Strikethrough, Inline code. Always the leftmost cluster.
- **Structure** — H1–H6 collapse into a *single* dropdown (not six buttons), plus Blockquote and Horizontal rule.
- **Lists** — Bullet, Numbered, Checklist, grouped together.
- **Insert** — Link, Image, Table, Footnote, behind one "+" dropdown.
- The whole toolbar collapses to one icon that expands on tap — remembers last open/closed state, matters most for the Just Write / zen writing case (A8.9).
- The selection-triggered floating toolbar (appears near a text selection) is a **transient overlay** under §12's existing rule, same bucket as the command palette and diff-review modal — not a new exception to "nothing floats."

### A8.8 Autocorrect without AI — three deterministic layers
"Autocorrect" here means classic, instant, no-model text correction — three layers, each with a clear, finished rule, nothing hand-wavy:
1. **Substitution table** — a curated list of common typos and transpositions ("teh"→"the", "adn"→"and", "recieve"→"receive") applied at word-boundary. Auto-applies silently, exactly like standard OS-level autocorrect, and is reverted by a single undo.
2. **Character normalization** — runs on the same word-boundary trigger: straight quotes → curly, `--`/`---` → en/em dash, `...` → ellipsis, double space → single, sentence-initial lowercase "i" → "I". This covers the "mixed characters" case directly — deterministic string rules, not guessing.
3. **Edit-distance-1 dictionary correction** — for a typed word not found in a bundled offline word-frequency list, compute Damerau-Levenshtein distance-1 candidates (catches one substituted, transposed, missing, or extra character — the actual "miss characters" case). If exactly one distance-1 candidate exists and its frequency clearly beats the typed string, it's offered as an **underline suggestion**, not auto-applied — fiction means constant invented names, and silently "fixing" a character's name is the one failure mode worth avoiding here.
   - **Custom dictionary** — every name/place already defined in the Story Bible (`bible_facts`) is pulled in as a known word automatically, so your own invented vocabulary never gets flagged in the first place.
   - Cut, deliberately: automatic keyboard-layout-mismatch detection (typing in the wrong layout entirely). Real edge case, needs enough heuristic guessing to be genuinely unreliable — overkill for what this needs to do, so it's out rather than shipped as a half-working guess.

### A8.9 Smaller additions the same pass surfaced
- **Zen mode** — one keystroke hides Sidebar, TabBar, StatusStrip, and mobile's BottomBar entirely, leaving only text; same key (or Esc) restores. Distinct from focus-dimming (§2.2), which dims but keeps chrome present — this removes it.
- **Attachments convention** — dropping or pasting a non-text file (image, PDF) into a doc copies it into `<vault>/.attachments/` and inserts a relative-path reference, so the vault stays self-contained and portable, and so Files (A8.3) has somewhere consistent to show them.
- **Dictionary language** — Settings → Editor & Writing gets a language selector for which offline word list A8.8 loads; English is the only bundled default for now, more are a data file away.

---

## Amendment 9 — Save Logic, State System, Chunking, Help, Notifications, Memory, AI Persona & Skills, Templates · 2026-09-14

### A9.0 Correction to Amendment 8, §A8.4
Misread that one — the Markdown viewer isn't a new standalone side comp, it's an **extension of Reader (§8)**, which already is the reading space. Reader now covers: book reading (existing) plus reading/editing plain `.md` and `.txt` files browsed via Files (A8.3), in the same lightweight raw-text mode described in A8.4. No other text formats for now — PDF stays exactly where A8.4 already put it, a separate, later phase.

### A9.1 Save logic
Two tiers, so "save" and "don't lose anything" aren't the same mechanism:
- **Hot buffer** — every keystroke lands in the SQLite hot-state layer (WAL mode, Amendment 5 correction 5) almost immediately. This is the crash-safe layer; SQLite's WAL journaling means a crash mid-sentence doesn't lose the sentence.
- **File flush** — after ~1.5s of typing inactivity, or on tab switch / doc close / app background / app quit, current content writes out to the actual `.md` file on disk — the real source of truth (§1.3). Cmd/Ctrl+S forces an immediate flush on demand; functionally redundant given the debounce, but expected muscle memory.
- **Save ≠ snapshot.** File flush is constant and silent. A snapshot (the version-history row from Amendment 5, correction 8) is coarser: one on first edit after opening a doc, one every ~10 minutes of continued active editing, and always one on doc close. The retention/pruning policy applies to snapshots, not to every debounced flush.
- **Conflict handling** — if the file-watcher (Amendment 5, correction 4) sees an external change land while a local edit hasn't flushed yet, the flush pauses and a banner (A9.5) offers Keep Mine / Keep Theirs / View Diff. Never silently picks a side.
- StatusStrip shows one of: Saved / Saving… / Unsaved / Error — states defined once in A9.2, not invented per-component.

### A9.2 State system — color, waiting, error, selection
One set of states, defined once, reused everywhere rather than improvised per component: **Default, Hover, Active/Selected, Disabled, Waiting, Error, Success, Warning.**
- **Waiting** — never a blocking spinner or modal. A thin indeterminate line under TabBar for background work (indexing, backup), a pulsing cursor/typing-dots for the AI actively generating, skeleton rows for a doc list still loading.
- **Error** — muted, not alarm-red; matches the calm/docked aesthetic rather than fighting it. *Transient* errors (a failed search, retryable) show as a toast. *Persistent* errors (AI provider unreachable, an unresolved sync conflict) show as a docked banner (A9.5) that stays until it's actually resolved — a toast can be missed, and these can't afford to be.
- **Selection** — a neutral, semi-transparent highlight, deliberately *not* the per-workspace accent color from Amendment 8. Keeps "this text/row is selected" from ever being confused with "this is the workspace I'm in."

### A9.3 Chunking — STT and TTS
- **STT** — chunk on detected silence (~600ms gap via voice-activity detection), not a fixed timer. Each completed utterance goes to Moonshine as soon as it ends, so a longer voice-dump transcribes near-live instead of waiting for the whole recording to finish. Moonshine Voice's own streaming mode (Amendment 7) handles this internally when that path's in use.
- **TTS** — Kokoro's documented limit is ~500 tokens per call, with 100–200 token chunks recommended. Reader's read-aloud splits text at the sentence boundary nearest the ~150-token mark — never mid-sentence — synthesizes sequentially, and starts playing chunk 1 while chunk 2 is still generating, so playback doesn't wait on the whole doc rendering first.

### A9.4 In-app help
The `?` shortcut-cheat-sheet overlay (flagged earlier) grows into the one Help surface: shortcuts + a short blurb per feature + a "what's new" note after updates. Reachable from Settings → About (Amendment 6, category 9) and from `?` anywhere. Plus one dismissible, first-visit-only tip per workspace the first time you open it — never recurring, never nagging.

### A9.5 Banners & notifications
- **Toast** — transient, auto-dismissing, one-off confirmations ("Backup complete").
- **Banner** — persistent, docked (top of ContentPane or in StatusStrip, never centered or floating), stays until resolved or dismissed — for anything needing a decision or ongoing awareness (sync conflict, AI provider down).
- A small bell/history icon surfaces anything you dismissed, so a missed banner is never actually gone.

### A9.6 Clear history, AI memory, snapshot visibility
- Settings → Privacy & Security gets explicit **Clear** actions: search history, command-palette recents, per-workspace AI chat history, and AI memory (A9.7).
- Per-doc **History** panel — timeline of snapshots, preview diff, one-click restore, and an explicit "clear snapshot history for this doc" action, so version history is something you can actually see and manage, not just a policy running invisibly in the background.

### A9.7 AI Persona & Skills — soul.md, skills, per-tab feel
Fair catch — if the app has AI skills and a personality, that deserves the same structure Claude itself uses, just authored by you instead of Anthropic:
- `<vault>/.ai/soul.md` — plain, human-editable markdown defining the AI's core voice and character. Folded into every context assembly (§5) as a standing frame underneath whatever workspace-specific context gets added on top.
- `<vault>/.ai/skills/<name>/SKILL.md` — modular capability packages, same shape as Claude's own skills: a trigger condition plus instructions. Each one toggled individually.
- **Per-tab feel** — optional short overlay files (`.ai/personas/<workspace>.md`) that layer on top of `soul.md` rather than replace it, so the core character stays consistent but tone can shift a little per workspace — warmer in Logs, more editorial in Novel Studio — if you choose to write one.
- New Settings category: **AI Persona & Skills** — inline `soul.md` editor, a skill toggle list, and the per-workspace overlay editor.

### A9.8 Templates
- `<vault>/.templates/*.md` — plain markdown, editable directly like everything else in the vault.
- "New → From Template" on doc creation; cursor lands on the first empty/placeholder section.
- Any existing doc can be saved "As Template."
- Per-workspace default template — e.g. Novel Studio's "New Chapter" can auto-apply one without asking, override-able per use.

### A9.9 Two more gaps worth naming
- **Settings export/import** — app-level settings (Amendment 6) live outside the vault by design, so a second machine starts with none of it. Add an explicit export/import bundle (theme, keybindings, persona, skill toggles) so a new install isn't a cold start.
- **First-run onboarding** — never actually specified anywhere. §10's "cursor blinking" is the *return*-visit story; the very first launch still needs: pick or create a vault location, optional "import an existing folder," and a quick AI provider setup — before you ever get to that blinking cursor.

---

## Amendment 10 — Save & Snapshot Correction · 2026-09-14

Fair pushback on both counts — fixing them.

### A10.1 Autosave interval: 5s, not 1.5s
File flush now debounces on **5 seconds** of typing inactivity (still also flushes immediately on tab switch / doc close / app background, same as before). This costs you nothing on crash safety: a keystroke is already safe the instant it lands in the SQLite hot buffer (Amendment 5, correction 5) — those WAL commits are near-instant. The debounce only governs how often the plain `.md` file on disk gets rewritten, so a longer debounce just means fewer disk writes — which is exactly what you want: less I/O, easier on battery and flash wear, especially on the Android side.

### A10.2 Snapshot — actually git-like now
The "every ~10 minutes" rule in Amendment 9, A9.1 was a timer, not a git-like trigger, and that's a fair catch — git commits fire on meaningful accumulated change, not a clock. Replacing it:
- A file flush becomes a snapshot only when it represents a **meaningful diff** from the last snapshot — a real threshold (e.g. more than ~20 words changed), not "N minutes passed."
- Always snapshot on doc close — same as before, the natural session boundary, same idea as committing at the end of a work session.
- Amendment 5, correction 8 still stands on top of this unchanged: dedupe identical `content_hash`, thin anything older than ~30 days down to one-per-day.
- **New hard ceiling**, for the "cleaning" instinct specifically: cap at ~500 snapshots per doc. Past that, thinning gets more aggressive (weekly instead of daily) instead of growing forever — so "explode" genuinely can't happen even in a pathological case, like a doc left open and edited nonstop for a year.

### A10.3 Snapshot vs. undo — two different layers, worth keeping precise
- **Undo (Ctrl/Cmd+Z)** — live, in-memory, character/action-level, cleared the moment you close the doc. This is what actually handles "undo my last keystroke" or "undo that AI insert" (Amendment 5, addition 5). It never touches the database — nothing here was ever contributing to anything growing.
- **Snapshots (A10.2)** — the persistent, cross-session layer: "what did this chapter look like yesterday," recoverable weeks later. This is the git-like layer, and it's the only one of the two that writes to disk long-term.
They're kept deliberately separate so a fast typing burst's huge undo history never becomes permanent storage, and permanent storage never has to hold every single keystroke.

### A10.4 One less thing to build
The SQLite WAL file (the hot buffer itself) checkpoints and truncates back down on its own default schedule — that's SQLite's own behavior, not custom cleanup logic this app needs to write.

---

## Amendment 11 — Borrowed Features: Canvas, Outline, Board/Calendar Views & More · 2026-09-14

### A11.1 Canvas / corkboard (Obsidian, Scrivener)
A freeform visual board — manually place and connect cards, rather than Map's auto-laid-out force-graph. Genuinely different job from Map: Map shows structure that already exists (links), Canvas is for arranging things that *don't* have a structure yet — a character web, a plot board, a messy pre-outline. New workspace-agnostic tool, opens as its own tab.

### A11.2 Outline / TOC panel (Obsidian)
Per-doc panel listing every heading in the current doc, click to jump. Matters most for long chapters and long journal entries.

### A11.3 Hover preview (Obsidian)
Hovering a wikilink shows a small preview of the target doc without navigating away — glance at a Story Bible character entry mid-sentence without losing your place in the chapter.

### A11.4 Per-doc lock (Apple Notes)
Amendment 5 added a whole second encrypted vault for sensitive material — this is the lighter option: lock one specific doc behind the same OS biometric/PIN check (Amendment 6), no need to move it into a separate vault for just one entry.

### A11.5 Pinned docs (most note apps)
Pin any doc to the top of its list/sidebar section.

### A11.6 Board & Calendar as Saved View types (Notion)
Amendment 7's Saved Views (§A7.4) currently only vary sort/filter/group — extending it with two actual view types on the same underlying data: a **Kanban board** (grouped by a status Property, drag cards between columns — fits chapter status: Draft/Revision/Final directly) and a **Calendar** (Logs by date, or scenes by in-story date if Novel Studio's timeline view ever gets built).

### A11.7 Slash commands (Notion)
`/` at the start of a line opens a quick-insert menu — the keyboard-first equivalent of the Insert dropdown from Amendment 8's toolbar regroup (§A8.7). Same commands, faster for touch typists.

### A11.8 Goal + deadline per chapter/project (Ulysses)
Extends the word-count goal system (§8.3, Amendment 7 §A7.5) with an optional target and date — "50k words by Nov 30" — shown as plain progress, no pressure mechanics, same no-guilt rule as the rest of §A7.5.

### A11.9 Optional location/weather stamp (Day One)
Off by default. If enabled in Settings, a Logs entry can auto-stamp where you were and the weather when you wrote it. The one feature here that touches device location, so it stays opt-in, never default-on.

### A11.10 Deliberately skipped
- **Notion-style relation properties / inline comments** — relations mostly duplicate what wikilinks + Properties already do here; comments are a collaboration feature for an app with exactly one user. Skipping both rather than building unused surface area.
- **Roam/Logseq block-level transclusion** — a genuinely different architecture (block-based, not file-based) from everything else in this spec (§1.2, §3.1 are file/doc-based throughout). Adopting it properly means redesigning the core data model, not adding a feature — overkill for what this app needs.

---

**Version after amendments: 1.11**

---

## Amendment 12 — Production Readiness: AI Controls, Error Handling, Sidecar Lifecycle, XSS Fix · 2026-09-21

### A12.1 AI Generation Controls
The AI panel now ships with full generation control:

- **Cancel button** — appears next to the "Thinking..." indicator during any streaming generation (Chat, Composer, Structurize). Uses `AbortController` to stop token processing client-side; partial response is saved.
- **Rate limiting (cooldown)** — minimum interval between sends, configurable via `aiRateLimitCooldown` setting (default 3000ms, 0 = disabled). Shows a warning toast when user tries to send during cooldown.
- **Request timeouts** (Rust side):
  - Non-streaming chat: 90s
  - Streaming chat: 120s
  - Composer/Structurize: 180s
  Timeouts return clear errors: "Request timed out — the model may be overloaded" instead of hanging indefinitely.

### A12.2 Error Handling Polish
- **Friendly error mapping** applied at both Rust (streaming endpoint) and Svelte (all three generation paths):
  - 401/403 → "API key rejected — check your provider settings"
  - 429 → "Rate limited — wait a moment"
  - 408/timeout → "Request timed out — the model may be overloaded"
  - Network/ECONNREFUSED → "Can't reach AI server — is it running?"
- **Retry button** — appears inline after any error message in chat ("Error: ..."); re-sends the last user message with same context.
- **Toast for AI failures** — every generation error now also fires `showToast("AI generation failed: {friendly}", "error")` so the user sees it even if the chat panel is closed.

### A12.3 Toast System
- **Click-to-dismiss** — clicking anywhere on a toast dismisses it.
- **Explicit close button** — × icon visible on hover (touch-friendly area).
- **Max 3 visible** — oldest toasts are dropped when limit exceeded; no queue indicator yet (future improvement).
- **Error toasts persist** — error-level toasts do not auto-dismiss until user clicks them.

### A12.4 Sidecar Lifecycle — Crash Detection
All four sidecar managers (`SidecarManager`, `SttManager`, `TtsManager`, `LlmManager`) now implement proper crash detection in `is_running()`:
- `try_wait()` is used; if the process exited with a non-zero status, `is_running()` returns `false` and logs the exit code.
- Previously, a crashed sidecar would incorrectly report `is_running() == true` because `Option<Child>` was still `Some`.
- This enables the UI to accurately reflect sidecar health and is a prerequisite for the planned periodic health watchdog (30s poll with exponential backoff restart).

### A12.5 XSS Fix — HTML Sanitization
- Replaced the custom `html_escape()` function (which was a no-op for `&`, `<`, `>`) with the `ammonia` crate (v3.3), a proper HTML sanitizer.
- Applies to `publish_static_site` command output — doc titles, descriptions, TOC links, and body content are now safely escaped for all HTML contexts (element content, attributes, URLs).
- Removes the XSS vector where a doc title like `<script>alert(1)</script>` would execute in the published site.

### A12.6 Ghost Autocomplete with Local LLM
- When `llmEnabled: true` in settings, ghost inline autocomplete now uses the local LFM 2.5-350M model (llama.cpp server) instead of the external API.
- `ensureLlm()` is called lazily on first ghost request: starts the sidecar if not running, waits for health check, then uses `api.llmCompletion()`.
- Falls back to external API (`smallModelEndpoint`) if local LLM fails to start or isn't configured.
- This provides fully offline, zero-latency autocomplete for users who run the local model.

### A12.7 Settings Additions
- `aiRateLimitCooldown: number` (default 3000) — minimum ms between AI sends; 0 disables.
- `blankModeDefault: boolean` — now initializes the AI panel's Blank/Contextual toggle on mount and persists when toggled (previously the setting existed but was never read or written).

### A12.8 Default STT Model
- `sttModel` default changed from `""` to `"moonshine-base"` — the Moonshine-base GGUF (Q8_0) is now the bundled and default model, matching Amendment 7's recommendation. Legacy `moonshine/tiny` and other ONNX-era IDs are ignored with a warning; the bundled base GGUF is used.

### A12.9 Brutalist Theme
- Third theme option alongside Dark and Light: `theme: "dark" | "light" | "brutalist"`.
- Structural tokens only (same color palette as Dark theme):
  - Zero border-radius everywhere (`--brutalist-radius: 0`)
  - Thick borders (`--brutalist-border: 2px solid var(--border-subtle)`)
  - Hard offset shadows (`--brutalist-shadow: 4px 4px 0 var(--border-subtle)`)
  - Hover translate: `translate(-2px, -2px)` with expanded shadow
  - Typography: Archivo Black (headers) + Space Mono (body/mono), loaded via Google Fonts
  - All caps for nav tabs, buttons, breadcrumb labels
  - Button/tab/input states use border/translate instead of background shifts
- Enabled via Settings → General → Theme; persisted like other themes.

---

**Version after amendments: 1.12**
