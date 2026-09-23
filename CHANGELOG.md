# Changelog

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
