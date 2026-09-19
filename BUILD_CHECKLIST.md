# BUILD_CHECKLIST.md — Writing App

## Phase 1: Core Engine ✅

- [x] Tauri 2 project scaffold with Svelte 5
- [x] SQLite database schema (docs, backlinks, snapshots, usage, tabs, conversations, bible_facts, craft_metrics, rag_chunks)
- [x] Doc CRUD commands (create, get, save, delete, move, search, list)
- [x] Backlink tracking commands
- [x] Usage event recording
- [x] Tab state persistence
- [x] CodeMirror 6 editor with dark theme
- [x] Tab management UI
- [x] Breadcrumb navigation
- [x] Status bar with real stats

## Phase 2: Workspaces ✅

- [x] Logs: daily notes, calendar strip, day list, quick capture
- [x] Just Write: typewriter mode, focus dimming, session timer
- [x] Node Map: canvas graph, d3-force layout, backlinks, unlinked mentions, overlays, node inspector
- [x] Novel Studio: beat board, story bible, compile
- [x] Script: Fountain parser, screenplay view
- [x] Reader: bookshelf, file import, position sync

## Phase 3: AI Integration ✅

- [x] AI provider backend (OpenAI-compatible HTTP)
- [x] Chat mode with conversation persistence
- [x] Composer mode with generation + insert
- [x] Ghost mode: settings toggle + editor integration (Tab to accept, Esc to dismiss, 1.5s debounce)
- [x] RAG pipeline: chunking (200 words/50 overlap), semantic search via sqlite-vec (TF-IDF embeddings, 256-dim), keyword fallback, context retrieval
- [x] Chat → Editor write-back (§A3): Insert at cursor / Replace selection / Append to doc / Copy — all four actions on chat responses + composer output
- [x] Keyboard shortcuts: Ctrl+Enter (insert last AI response), Ctrl+Shift+C (copy), Ctrl+Enter in composer (generate)

## Phase 4: Memory & Smart Features ✅

- [x] Activity score decay algorithm
- [x] Smart tab sorting (by activity score)
- [x] Craft metrics profiling
- [x] Writing streak tracking

## Phase 5: Polish ✅

- [x] Command palette (Ctrl+K)
- [x] Global search (LIKE-based ranked search + sqlite-vec semantic RAG; not FTS5 — corrected 2026-09-16)
- [x] Export (md/txt/html/fountain)
- [x] Settings pane (§A6) — all 9 categories
- [x] Status bar with real stats + streak
- [x] Version history + snapshot restore
- [x] Backup system (scheduled auto-backup on open per frequency + manual + cleanup)
- [x] Android responsive pass (≤768px + ≤480px media queries, hamburger menu, bottom-sheet AI)
- [x] Mobile header with workspace navigation

## Remaining

- [x] ~~Rust backend compilation~~ — **BUILDING SUCCESSFULLY** (cargo build passes, 86 warnings all dead-code/unused)
- [x] sqlite-vec vector embeddings for semantic RAG — **DONE** (sqlite-vec 0.1.9, zerocopy IntoBytes, TF-IDF text_to_embedding, rag_vec virtual table, semantic + keyword fallback search)
- [x] Chat → Editor write-back (§A3) — **DONE** (writeBack store, EditorPane listener, 4 actions, keyboard shortcuts)
- [x] AI Structurizer / Blueprint Mode (§A1) — **DONE** (`ai_structurize` command, Structurize mode tab, `{directive}` highlighting, workspace-aware system prompt, accept/insert/append/copy review actions)
- [x] Performance budget verification (§14) — **DONE** (Settings > About & Diagnostics: cold start time, memory usage, DB search latency, doc/edge/snapshot counts, "Run Diagnostics" button with live metrics)
- [x] Browser live preview (no Tauri shell) — **DONE** (`browserStore.ts` + `browserBackend.ts` localStorage backend, `api.ts` safeInvoke routing, preview banner, Tauri-only watcher guard; `npm run dev` serves a fully explorable app)
- [x] Unified icon system, no duplicates — **DONE** (`Icon.svelte`: 41 hand-authored stroke icons, zero Lucide, zero emoji icons in nav/actions; icon-first buttons with title + aria-label tooltips; shared `.icon-btn` class)
- [x] Inbox multi-select + bulk triage (§A7.4) — **DONE** (select-all, bulk move-to-workspace, bulk delete)
- [x] Conflict View Diff — **DONE** (was "coming soon" stub; now a real local-vs-snapshot line diff modal)
- [x] Feature self-test + e2e — **DONE** (Settings > About > "Run Feature Self-Test" exercises create/save/search/link/snapshot/restore/graph/log/delete through the live backend; `npm run test:e2e` serves dist/ and asserts 15 checks, all passing)
- [x] Mobile responsive pass — **DONE** (settings stack vertically with icon-only nav ≤768px, tables scroll, toolbars wrap, BottomBar icon nav, AI panel bottom-sheet)

- [x] In-app self-updates (Tauri updater) — **WIRED, NOT YET Runnable** (plugin init + `app_update_status` command + `capabilities/default.json` + `updates.ts` + Settings → About → App Updates UI with check/download-progress/install/relaunch + silent startup check with opt-out + `docs/UPDATES.md` release flow; one-time maintainer setup still required: keypair, pubkey, endpoint — UI reports "not configured" until then)
- [x] Manuscript export pipeline — **DONE where verifiable** (Rust `convert.rs`: md/txt/html built in via pulldown-cmark, docx/epub/pdf via pandoc sidecar-or-PATH with install guidance; `convert_run` / `compile_run(board order)` / `convert_status`; editor export menu lists live formats; Novel Compile dialog downloads in-format; browser mirror for md/txt/html; `docs/EXPORT.md`; self-test covers export round-trip; Rust side uncompiled per no-exe constraint)
- [x] Per-doc lock excludes AI + Patterns — **DONE where verifiable** (`locked` column + migration; filtered from search/RAG/workspace-context/all Home stats/smart-tabs in both backends; TabBar Lock/Unlock with PIN gate; session-only unlocks; App pane gate; AI gates in chat/composer/ghost; inbox preview redaction; rule: titles stay visible in structural views, content is invisible)
- [x] Craft skill nudge — **DONE** (repaired `craft_metrics` schema mismatch that made all recording fail; editors record filter-word ratio + write heartbeat ≤1/min — this also wakes up streaks/heatmaps/patterns, which had zero `write` events; SkillNudges surfaces a once-ever gentle warning on genuine creep)
- [x] Board arrangement = Compile order — **DONE** (frontmatter `order` sort in beat board + backend compile; scene drag-reorder within/across sequences and act reorder, persisted; fixed Novel Studio being unreachable — `projectId` was never assigned — with a project picker + auto-follow of the open doc; freeform Canvas board itself still unbuilt, this covers the ordering need)
- [x] Home pinned quick-launch — **DONE** (`doc_list_pinned`, Pinned section with lock badges)
- [x] Per-workspace last place — **DONE** (`lastPlace.ts`, restore on visit for write/novel/script/projects/reader; Logs stays on today per spec §8.1)
- [x] Streak sparkline — **DONE** (`today_rhythm` 24-bucket query, SVG sparkline with tooltip in StatusBar)
- [x] Canvas board (A11.1) — **DONE where verifiable** (freeform cards + labeled connections + doc links; pan/zoom/fit, drag persist, connect mode, per-card inspector, keyboard delete; sidebar/palette/mobile/Home wiring; Rust side uncompiled per no-exe constraint)
- [x] Audit fixes — **DONE** (Ghost autocomplete now passes workspace so private workspaces stay local-only; Reader import refuses epub/pdf/docx binaries with conversion guidance instead of storing `file.text()` garbage)
- [x] Unlinked mentions UI — **DONE** (Inspector Links tab lists bare mentions with one-click in-place `[[linking]]`; fixes doubling)
- [x] Logs quick-capture + touched-today — **DONE** (capture text was composed then discarded — data loss, now appended; derived touched-today footer with open actions)
- [x] Reminders + auto-backup — **DONE** (weekly triage banner for week-stale inbox, daily streak nudge, frequency-aware silent auto-backup on open in the desktop shell)
- [x] AI streaming — **DONE where verifiable** (`ai_generate_stream` SSE command + live token rendering in chat/composer with persisted full text; Rust uncompiled per no-exe constraint)
- [x] Saved Views + Calendar — **DONE** (named/filtered/sorted/grouped views persisted in settings; month grid by creation date composing with all filters, day drill-down)
- [x] Brand mark rollout — **DONE** (`ehis-final-v2.svg` as logo/favicon/Home icon: `public/logo.svg` + white `logo-light.svg` for the dark UI, regenerated Tauri `icons/*` (ico/icns/pngs), PWA manifest + touch icons, `index.html` metadata; wordmark, Home nav, boot screen, onboarding welcome)
- [x] Documentation set — **DONE** (README, ARCHITECTURE, DEVELOPMENT, TESTING, USER-GUIDE, SPEC-STATUS, TODOS, CHANGELOG; self-healing headers on all docs incl. retrofits)
- [x] Theme system repair + light mode — **DONE** (`app.css` was never imported — the entire var theme was dead — restored import, defined the missing surface/type/spacing vars, added a paper light palette behind the existing toggle with no-flash preload and theme-aware logos)
- [x] E-reader — **DONE** (real EPUB/DOCX/PDF text extraction into the doc body: jszip spine parse, raw-OOXML paragraphs, pdf.js page text; lazy chunk so the main bundle stays lean; position/search/export unaffected; fixtures + node parsing proofs)
- [x] Dictionary selector + place stamp — **DONE** (English table can switch to custom-words-only; opt-in Nominatim/Open-Meteo stamp on fresh daily notes, keyless, fails silent)
- [x] Model slots + voice models — **DONE** (chat/composer/structurize routed to main slot, ghost stays small; per-slot provider ping with latency + model presence; paste-to-swap STT id / TTS repo plumbed python↔Rust↔settings; `docs/MODELS.md` with Sept-2026 picks; no weights bundled by design — first-run downloads; Rust side uncompiled per no-exe constraint)
- [x] Model research write-up — **DONE** (LFM2.5-350M default kept + base-wins-finetunes verdict; Moonshine-streaming-only and Kokoro-only locked with evaluated-and-rejected logs; full constraint-audit table so the hunt isn't repeated; small slot stays paste-to-swap with instant effect, voice swaps on sidecar restart)
- [x] AI memory harness (vendored copy) — **DONE where verifiable** (memory.py + clarification.py vendored MIT with attribution; +hf_/AKIA patterns; `memory_server.py` stdlib server proven live: learn/recall/redact/persist; Rust manager + 8 commands; chat recall injection + fire-and-forget learning; opt-in scrub gate that fails closed; Privacy UI with count + wipe; e2e boots the real server; Rust uncompiled per no-exe constraint)
- [x] Hardcoded demo purge — **DONE** (removed browser seed vault incl. Elena/Harbor fiction; avg-session stat returns 0-unknown instead of invented 25; e2e cleans its esbuild scratch dir + stale copy deleted; Rust verified free of demo data)
- [x] Stale seed purge — **DONE** (one-time migration deletes vault docs matching exact old-seed fingerprints + their orphan snapshots; all other creation paths verified user-triggered except the spec'd daily note)
- [x] Hardcoded paths/dialogs/themes purge — **DONE** (AiPanel dev-machine sidecar path → settings field with guidance toast; template prompt()/alert() → palette-native entries + dedupe naming; FileBrowser prompt()/confirm() → inline rename + two-step delete strip; CodeMirror hardcoded dark theme → follows Settings theme live in both editors)
- [x] AI discoverability — **DONE** (the panel had no desktop opener at all: added editor + JustWrite sparkle toggles, Ctrl+J, palette command, help/onboarding rows, and an empty-state warning when the endpoint is unreachable; editor font/size/line-height now rebuild live like theme does; harness-dir placeholder de-faked)
- [x] Console-error + mobile hardening — **DONE** (wikilink hover hammered the backend per-pixel with no catch — now once per target + guarded; MarkdownViewer + template-create chains guarded; `npm run test:smoke` mounts the real bundle headless at 1280/390/390-dirty, walks all 12 workspaces, asserts zero console errors; NodeMap null-ctx already guarded)

## Verification evidence (2026-09-16, no executable builds per user constraint)

- `npx svelte-check`: **0 errors**, 31 warnings (all pre-existing a11y/css categories)
- `npm run build` (vite web bundle only): **passes**
- `npm run test:e2e`: **15/15 PASS**, exit 0
- Rust backend untouched this pass and **not compiled** (user prohibited exe builds); Tauri-shell behavior changes (watcher guard, preview banner) are additive and inert under Tauri
- 2026-09-16 updater pass: `svelte-check` **0 errors**, `vite build` **passes**, `test:e2e` **27/27 PASS**. Rust changes (`tauri-plugin-updater/process` deps, plugin init, `app_update_status`, `bundle.active: true`, `createUpdaterArtifacts: true`, new capability file) are **uncompiled by constraint** — the first `npm run tauri build` must confirm them and will refresh `Cargo.lock` for the two new deps. `docs/UPDATES.md` covers keygen → publish.
- 2026-09-16 batch pass (lock/craft/order/pinned/place/sparkline): `svelte-check` **0 errors** (warnings 31→27), `vite build` **passes**, `test:e2e` **40/40 PASS**, in-app self-test extended (lock exclusion, pinned, metrics, rhythm). Rust changes (`locked` column + 14 selects/11 mappings, `craft_metrics` rebuild, lock filters, pinned/rhythm queries, beat `order` sort, 3 new commands) are **uncompiled by constraint** — same first-build confirmation needed.
