# Changelog

## Unreleased (Area 6: voice sidecar lifecycle)

### Changed
- **One managed child owner**: `ManagedSidecar{port}` in sidecar.rs serves all 5 managers — dead handles reaped + respawned (never early-Ok on a corpse), stop() is kill()+wait() (no zombies), Drop kills best-effort so children die with the app, stale port holders reclaimed (orphan sidecar killed + restarted, foreign holders fail closed with a typed error)
- **No indefinite hangs**: every sidecar reqwest client carries a timeout (30s default, 180s transcribe/synthesize/LLM); empty LLM/memory content is a real error, not `""`
- **Startup without races**: one `ensureSidecar()` + `pollUntilHealthy()` (500ms/15s, "Starting Moonshine… Ns" progress) replaces the fixed 500ms/1s sleeps in STT/TTS/LLM/memory; LLM cold load awaits readiness so ghost can't cloud-fallback on first run; Mic/TTS buttons gate on model_loaded only after a probe (never disabled cold) with the fetch hint wired
- **Validation**: `sidecarValidate.ts` (traversal rejected, shape-checked) on Settings blur with inline errors; new `sidecar_python_probe` command (`python --version`, preview degrades readable); STT/TTS servers fail closed on `..` escapes and missing explicit picks (no silent bundled fallback); empty-path guards on stt/tts start
- **TTS stop actually stops**: live source handle with stop()+disconnect() + mid-decode generation guard (decode caveat documented); ReadAloudButton gains a real loading state; MicButton offers one-tap browser dictation on sidecar failure (explicit tap = consent, never auto-switch — panel holds no position either way)
- **Mobile/voice**: 44px mic/TTS targets under 480px; Web Speech errors surface one-line reasons (not-allowed/no-speech/network)

### Tests
- `cargo test managed_`: invalid spawn, foreign-port fail-closed, dead-handle respawn, stop-reaps (4 passed)
- `tests/sidecar-validate.mjs` (18), `tests/ensure-poll.mjs` (9: flaky-health boot, cap, short-circuit, failure), `tests/sidecar-resolve.py` (16 against the real server code)

## Unreleased (Area 5: AI core dedupe + hardening)

### Changed
- **Slot duplication deleted**: one `resolveSlot()` in commands.rs (was ×3 endpoint/model pairs), one `post_chat_completions()` for ai_generate/structurize, one `guardRate()` + shared `friendlyEndpointError()` via `src/lib/aiRequest.ts` (was ×3 copies each in AiPanel), providerTest.ts confirmed as the single `/models` probe (Settings + panel mount)
- **Silent failures fixed**: ai_generate/structurize check HTTP status like the stream path (401/403 key, 429 rate, 408 timeout) with one 429/503 retry + backoff, never `""` on empty choices; ghost failures record to a `ghostStatus` store (surfaced in the panel's Ghost tab) instead of warn→null; RAG/memory shortfalls show a one-line notice in the context chip; structurize remote-fallback warns with reason; `sidecar_start("")` is a typed error at the Rust boundary
- **Ghost disambiguated**: GhostPanel→DocForkPanel, GhostBadge→ForkBadge (fork UI, not autocomplete); Ghost tab is live (enable toggle, small-slot probe with latency, last-suggestion status, routing note); routing enforced — ghost reads local :8093 if enabled else small slot, callers pass workspace only
- **harness.ts→memorySidecar.ts** (port 8092, not legacy 8080) with a deprecated re-export shim; llm sidecar takes `--ctx-size` from settings
- **Panel UX**: privacy lock badge on private workspaces; Replace always confirms (Insert-instead one click away); write-back bar keyboard/touch reachable (was hover-only) and hidden on Error/Locked messages; writeBack is a FIFO queue (rapid clicks no longer drop events); Thinking… shows elapsed/total per path timeouts; mobile header wraps ≤480px, sheet 88vh, action bars visible on touch
- **Small model as first-class**: `smallModelContextLength` (llama-server ctx, applies on restart) + `useSmallAsMain` route chat/Composer/Structurize at lfm2.5-350m, with Settings controls

### Tests
- `cargo test ai_slot`: resolveSlot defaults/blanks/explicit + status map (4 passed)
- `tests/ai-request-unit.mjs` (19), `tests/writeback-queue.mjs` (8), `tests/ai-error-probe.mjs` (dead-endpoint reject friendly + structurize local fallback)
- e2e anchors updated to the new contracts (slot routing, fork rename, confirm, badge, countdown, ctx setting, Rust hardening)

## Unreleased (Area 4: brutalist + glass as real themes)

### Changed
- **Brutalist is its own palette now** (was byte-identical to dark): hazard theme — near-black concrete `#100F0D`, safety-amber `#FFB000` accent, 0 radius + hard ink shadows via tokens (not overrides), amber selection/focus, per-theme CodeMirror hazard editor
- **Glass glows**: luminous mint accent `#A9E8C6`, `rgba(143,199,169,0.3)` selection, `--accent-glow` on active nav/tabs/primary buttons, frosted blur extended to palette/modals/dialogs, swollen radius scale via tokens, translucent mint CodeMirror editor
- **Token gaps closed**: `--surface-elevated`, `--accent-on`, `--accent-semantic-yellow` defined in all 4 themes + system fallback; fallback gains `--ws-inbox/files/properties`; `--danger` aliased to `--error`; light `--ink-muted` darkened to `#5F5C50` for 4.5:1 small-text contrast
- **Literal-color bypasses tokenized**: on-accent whites → `var(--text-on-accent)` (TabBar, Logs, NodeMap, Projects, VaultRename, VersionHistory, FileBrowser), AiPanel cancel → semantic-red, SettingsPane perf → semantic-green/`--warning`, charts/craft/skills/usage hues → semantic tokens (SVG-safe `var()`), NodeMap rings follow theme accent/warning, EditorPane snippet expansion deferred past the update cycle (same crash class as autocorrect — expansion was silently dead)
- **Kept fixed deliberately** (verified, not overlooked): ConflictBanner amber (fixed bg carries contrast in every theme — tokenizing would break it), recording-red/TTS-blue whites (4.5+/5.2:1 on fixed brand bgs), PDF page white (document fidelity), canvas card hues + NodeMap dots (user/data identity colors), streak heat cells (GitHub-style convention)
- Decision: keep all 4 themes (signed off); no in-repo "3 themes" text exists (external spec holds that)

### Tests
- `tests/theme-sweep.mjs` extended (50 checks): per-theme token contract, brutalist/glass distinctness, WCAG contrast text-on-bg + on-accent-on-accent ≥ 4.5:1 (all pass with margin), editor-palette parity with app.css, mounts under all 4 themes

## Unreleased (Area 3: app-shell navigation)

### Changed
- **One grouping source**: `src/lib/workspaceGroups.ts` (Create/Capture/Organize/Explore) now drives both the desktop sidebar headers and the mobile More menu — they can't drift apart again. Sidebar keeps its drag-reorder, recency auto-sort, pinned Home, and inbox/canvas/files hide-list; only the group definition moved
- **Mobile More menu grouped**: flat 15-icon grid replaced by Create/Capture/Organize/Explore/Tools sections; Craft/Stats/Skills duplicate entries removed (single Settings — all three were Settings tabs); mobile nav visits now feed recency like desktop
- **Home promoted to top** (signed off: Home only): persistent Home button at the start of the BreadcrumbBar; sidebar keeps its pinned Home
- **Mobile bottom stack fixed**: StatusBar no longer renders on phones (was a second strip above BottomBar); a quiet save-state dot in the BottomBar preserves the persist signal. Docs/words/streak/stats remain one tap away on Home
- Removed stale `"craft"` from `lockCoveredWorkspaces` (redirects to Settings on the same tick, never a live workspace)
- Desktop TabBar + BreadcrumbBar stay separate (signed off); typing-focus auto-collapse already handles the crowded-while-writing case

### Tests
- `tests/shell-nav.mjs` (`npm run test:shell`, 18 checks): desktop + mobile dual boot — unified sections, no duplicates, palette still surfaces Inbox/Canvas/Files, mobile reachability, no StatusBar on phones, promoted-Home navigation
- `tests/theme-sweep.mjs` (`npm run test:themes`, 12 checks): shell mounts error-free under all 4 themes (dark, light, brutalist, glass)

## Unreleased (Area 2: lazy shell + Novel Studio surface)

### Bug Fixes
- **Lazy workspaces could go blank forever in silence**: `LazyWorkspace` swallowed load errors (empty `.catch`) and a never-settling chunk stayed on "Loading…" permanently. Loads now go through `src/lib/lazyLoad.ts` (`loadWithTimeout`, 9s): rejections and hangs reach a retryable failed state showing the reason, log `[LazyWorkspace] failed to load <label>: …`, and offer a Retry button that re-invokes the loader. All 14 lazy call sites labeled; `main.ts` logs `vite:preloadError` app-wide. Code-splitting itself untouched
- **Novel Studio had no reachable writing surface**: new projects landed on an empty beat board (editor needs a selected scene). `createProject` now bootstraps Act 1 → Sequence 1 → Scene 1 (scenes only render inside a sequence) and opens it immediately; empty projects show an unmissable "Start writing" affordance doing the same
- **Novel import dropped you on the board**: `handleImportFile` now selects the first imported scene so you land in the editor on chapter 1

### Tests
- `tests/lazy-load-probe.mjs` (`npm run test:lazy`): documents the jsdom stylesheet-link mechanism per workspace (informational by design)
- `tests/lazy-load-failure.mjs` (`npm run test:lazyfail`): rejection/hang/success contract of the loader (9 checks)
- `tests/novel-surface.mjs` (`npm run test:novel`): proves the failure path through the real component (failed state + Retry + labeled log); board happy-path phases run wherever chunks actually resolve and are joined by new e2e static anchors

## Unreleased (Just Write core editor)

### Bug Fixes
- **Autosave snap-back**: the doc-open effect rebuilt the editor on every `$currentDoc` assignment, including the autosave metadata refresh ~500ms after each pause — typed text visibly reverted to stale store content. The editor now rebuilds only on a new doc id (`openDocId` guard); regression-covered by `tests/write-probe.mjs` (instance-survival + live-content checks)
- **Undo history wipe on settings changes**: theme/font/autocorrect/dictionary edits (and typewriter/focus toggles) destroyed and recreated the `EditorView`, resetting CodeMirror `history()`. All four now live in `Compartment`s reconfigured in place via `reconfigureAppearance()`
- **Autocorrect never fired**: the shared plugin dispatched synchronously inside `ViewPlugin.update`, which CodeMirror forbids — every Layer 1/2 fix crashed (`Calls to EditorView.update are not allowed while an update is in progress`) and was dropped. Fixes are now scheduled via `queueMicrotask` and re-validated against the live doc before applying
- **Ghost autocomplete rendered as a bottom-center popup** instead of at the cursor. Now an inline `Decoration.widget` at the selection head (`src/lib/ghostWidget.ts`, `cm-ghost-inline`); Tab/Esc, debounce, and lock/privacy gating unchanged; stale cross-doc suggestions dismissed on doc switch
- **Rust save path swallowed disk errors**: `save_doc` ignored `write_to_disk` failures (`let _`), so SQLite and files-on-disk could silently diverge. Disk errors now propagate to the caller like `atomic_save` already did
- **File watcher never fired**: the `notify` watcher was dropped at the end of `setup_file_watcher`; now intentionally leaked for app lifetime (`std::mem::forget`)
- Removed stale "never wired" comment above the (actually wired) `searchKeymap`; Ctrl+F panel opening is now probe-tested

### Tests
- `tests/write-probe.mjs` (`npm run test:write`): real `EditorView.dispatch` typing — existing-doc render/type/persist, tab switching without cross-contamination, split-pane independence, live autocorrect, Ctrl+F panel (25 checks)
- `tests/ghost-widget.mjs` (`npm run test:ghost`): inline widget render/follow/replace/clear (11 checks)
- `tests/autocorrect-unit.mjs` (`npm run test:autocorrect`): rule-table spot checks + custom-dict veto (16 checks)

## 0.2.1 (2026-09-20)

### New Features
- **Home dashboard Goals section**: Docs with word-count targets now appear on the home page with progress bars, deadlines, and overdue indicators
- **Canvas inline editing**: Double-click any card on the canvas board to edit title and body in place — Escape cancels, Enter/blur commits
- **DockSplit drag-resize dividers**: Reusable vertical + horizontal dividers for Novel, Inbox, Projects, Canvas, and Reader workspaces, with per-workspace persisted splits
- **Side-by-side split editors**: Toggle split pane in Write workspace; both panes autosave independently; AI write-back targets main or split pane
- **Find/replace (Ctrl+F)**: `@codemirror/search` integration in EditorPane, JustWriteWorkspace, and split pane
- **Shared editorFocus module**: Typewriter mode and focus dimming extracted to `src/lib/editorFocus.ts` for reuse across all editors

### Editor-First UI
- Collapsible sidebar (Ctrl+B) and inspector toggle (Ctrl+I)
- AI panel minimize/restore with Ctrl+J
- BreadcrumbBar doubles as a command bar with workspace toggle buttons
- Per-workspace Focus Editor toggles (Docs, Inbox, Projects)
- Auto-hide chrome during typing: tab bar and breadcrumb collapse after 2.5s idle, restore on mouse-to-top or Escape
- Compact mode for tighter chrome
- No floating icons or glass effects — all solid backgrounds

### Settings Overhaul
- Skills, Craft, and Stats moved into Settings as embeddable categories
- Settings deep-link store (`settingsCategory`) with `openSettingsAt()` navigation
- Old workspace IDs redirect to Settings automatically

### Performance
- SettingsPane and AiPanel lazy-loaded (code-split)
- `modulePreload.polyfill: false` for smaller initial bundle
- Heavy routes wrapped in `LazyWorkspace.svelte`
- Persisted UI chrome prefs (`jwe-ui-panels` localStorage)

### Backend
- `dashboard_goals` Rust command + SQL query for docs with word-count targets
- Browser preview mock for `dashboard_goals` in browserBackend

### Bug Fixes
- Removed floating palette circle and sidebar expand button (no more floating triggers)
- All overlays use solid `var(--bg-primary)` backgrounds
- StatusBar docked Search + Capture buttons

### Maintenance
- Removed stale `api.ts.bak` backup file
- E2e test coverage for inline canvas editing and goal progress wiring
- All 143 API commands verified paired between Rust backend and TS frontend
- Zero encoding/mojibake issues in source files
- 0 npm/Cargo dependency issues

---

## 0.2.0 (2026-09-18)

Initial signed release.

### Core
- Tauri v2 + Svelte 5 + CodeMirror 6 writing app
- 12 writing workspaces: Write, Docs, Inbox, Projects, Novel, Script, Canvas, NodeMap, Reader, Logs, Settings (with embedded Skills/Craft/Stats)
- Full-text search, backlinks, version history with snapshots
- AI panel with chat, Composer, Structurize, Ghost autocomplete
- Voice: STT (Moonshine GGUF) and TTS (Kokoro) via sidecar processes
- Local LLM integration (LFM 2.5-350M via llama.cpp)
- AI memory sidecar with cross-session facts and secret scrubbing

### Import/Export
- EPUB, PDF, DOCX, Markdown, Fountain import
- Export to Markdown, TXT, HTML, DOCX, EPUB, PDF
- Novel compile to multiple formats
- Script export to Fountain and HTML

### Canvas & Node Map
- Freeform canvas board with draggable cards, edges, and doc linking
- Node Map for document relationship visualization
- Beat board for novel structure

### Editor Features
- Typewriter mode, focus dimming, autocorrect
- Goal tracking with word-count targets and deadlines
- Daily notes with location/weather stamps
- Templates for reusable document structures
- Lock/unlock documents for privacy
- Pinned documents for quick access

### Build
- NSIS installer for Windows
- Auto-updater with signed releases
- Browser preview backend for development
