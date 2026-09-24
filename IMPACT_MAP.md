# IMPACT_MAP.md — Writing App

## Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                    Frontend (Svelte 5)                │
│  Sidebar → TabBar → ContentPane → EditorPane         │
│                      ↕                                │
│                   AiPanel (right dock)                │
└──────────────────────┬──────────────────────────────┘
                       │ invoke()
┌──────────────────────┴──────────────────────────────┐
│                  Tauri IPC Bridge                     │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────┴──────────────────────────────┐
│                Backend (Rust / Tauri 2)               │
│  commands.rs → doc_store.rs → database.rs            │
│                                  ↕                   │
│              SQLite (WAL) + sqlite-vec extension      │
│              (rag_vec virtual table, TF-IDF 256-dim) │
└─────────────────────────────────────────────────────┘
```

## System Impact Table

| Change | Files Affected | Risk Level |
|---|---|---|
| New Tauri command | `commands.rs`, `api.ts`, consuming component | Low |
| New DB table | `database.rs`, `models.rs`, `doc_store.rs` | Medium |
| New workspace | `stores/app.ts`, new component, `Sidebar.svelte` | Medium |
| Editor changes | `EditorPane.svelte` | Low |
| AI panel changes | `AiPanel.svelte` | Low |
| Schema migration | `database.rs` | High |
| Rust dependency | `Cargo.toml`, `src-tauri/` | Medium |
| sqlite-vec extension | `Cargo.toml`, `lib.rs` (auto_extension), `database.rs` (virtual table), `doc_store.rs` (TF-IDF + semantic search) | Medium |
| AI structurize | `models.rs` (StructurizeRequest/Response), `commands.rs` (ai_structurize), `lib.rs` (registration), `api.ts` (method), `AiPanel.svelte` (Structurize tab + directive highlighting + review) | Medium |
| Performance diagnostics | `doc_store.rs` (perf_benchmark), `commands.rs` (perf_benchmark), `lib.rs` (registration), `api.ts` (method), `SettingsPane.svelte` (About panel with §14 budget metrics) | Low |
| Browser preview backend | `browserStore.ts` (localStorage docs/snaps/tabs/conv/bible), `browserBackend.ts` (all Tauri commands), `api.ts` (safeInvoke + isBrowserPreview), `App.svelte` (preview banner, Tauri-only watcher guard) | Medium |
| Unified icon system | `Icon.svelte` (41 hand-authored stroke icons), Sidebar/BottomBar/TabBar/AiPanel/EditorPane/NodeMap/Inbox/Properties/FileBrowser/Home/Status/Settings/Palette/Empty/Onboarding/Projects/VersionHistory/JustWrite | Low |
| Inbox multi-select triage | `InboxWorkspace.svelte` (select-all, bulk move/delete bar) | Low |
| Conflict diff view | `ConflictBanner.svelte` (local vs latest-snapshot line diff modal) | Low |
| Feature self-test + e2e | `SettingsPane.svelte` (Run Feature Self-Test), `tests/e2e-browser.mjs`, `package.json` (check, test:e2e scripts) | Low |
| In-app updates (Tauri updater) | `Cargo.toml` (+updater/+process), `lib.rs` (plugin init + command), `tauri.conf.json` (updater cfg, artifacts, bundle on), `capabilities/default.json` (core/updater/process), `updates.ts`, `SettingsPane.svelte` (About → App Updates), `App.svelte` (startup check), `settings.ts` (autoCheckUpdates), `docs/UPDATES.md` | Medium |
| Manuscript export pipeline | `convert.rs` (md/txt/html built in, docx/epub/pdf via pandoc), `commands.rs` (convert_run/compile_run/convert_status), `Cargo.toml` (+pulldown-cmark/+base64), `browserBackend.ts` (TS mirror), `api.ts`, `download.ts`, `EditorPane.svelte` (format menu from live status), `NovelWorkspace.svelte` (compile format + download), `docs/EXPORT.md` | Medium |
| Per-doc lock + AI/stats exclusion | `database.rs` (locked col migration), `models.rs` (Doc.locked), `doc_store.rs` (14 selects + 11 mappings, set_locked, filters in search/RAG/context/dashboards/smart-tabs), `commands.rs` + `lib.rs` (doc_set_locked), `lock.ts`, `LockScreen.svelte`, `App.svelte` (pane gate), `TabBar.svelte` (menu + badge), `AiPanel`/`EditorPane` (AI gates), `InboxWorkspace` (preview redaction), browser mirror | High |
| Craft metrics repair + skill nudge | `database.rs` (craft_metrics schema rebuild), `models.rs` (CraftMetric fix), `EditorPane`/`JustWriteWorkspace` (filter-word + write-heartbeat recording), `browserBackend` (metric store), `SkillNudges.svelte` (once-ever creep warning) | Medium |
| Beat order = compile order | `doc_store.rs` (frontmatter `order` sort in beat board), `NovelWorkspace.svelte` (project picker — projectId was never assigned, Studio was dead — + scene/act drag-reorder persisted via frontmatter) | Medium |
| Home pinned + last place + sparkline | `doc_store.rs`/`commands.rs` (doc_list_pinned, today_rhythm), `HomePane.svelte` (Pinned section), `lastPlace.ts` + `App.svelte` (per-workspace restore), `StatusBar.svelte` (SVG sparkline), browser mirror | Low |
| Canvas board (A11.1) | `database.rs` (canvas tables), `models.rs` (CanvasNode/Edge), `doc_store.rs` (list/upsert/delete/connect), `commands.rs` + `lib.rs` (5 commands), `CanvasWorkspace.svelte` (SVG+HTML board), `app.ts`/`Sidebar`/`BottomBar`/`CommandPalette`/`HomePane`/`TabBar`/`app.css` (canvas wiring), `Icon.svelte` (board icon), browser mirror | Medium |
| Audit batch (no lock changes) | `InspectorPanel.svelte` (unlinked mentions + in-place linking), `LogsWorkspace.svelte` (capture-loss fix + touched-today), `App.svelte` + `settings.ts` (triage/streak reminders + scheduled auto-backup), `commands.rs` (SSE `ai_generate_stream`), `api.ts` + `AiPanel.svelte` (live tokens), `settings.ts` + `PropertiesView.svelte` (SavedView type, saved views, calendar), browser mirrors | Medium |
| Brand mark rollout | `public/logo.svg` + `logo-light.svg` + `manifest.webmanifest` + PNGs, regenerated `src-tauri/icons/*`, `index.html` (favicon/manifest/theme-color), `Sidebar.svelte` (wordmark + Home nav), `App.svelte` (boot logo), `OnboardingOverlay.svelte` (welcome logo) | Low |
| Theme repair + light mode | `main.ts` (stylesheet import restored), `app.css` (missing 20+ vars defined + light palette), `App.svelte` + `index.html` (data-theme), logo variant switching | Medium |
| E-reader | `bookparse.ts` (epub/jszip, docx/OOXML, pdf/pdf.js lazy chunk), `ReaderWorkspace.svelte` (parse-on-import), `tests/fixtures/*` + `make-fixtures.py`, `package.json` (+jszip/+pdfjs-dist) | Medium |
| Dictionary + place stamp | `autocorrect.ts` (language gate), `settings.ts` + `SettingsPane.svelte` (selector), `stamp.ts` + `LogsWorkspace.svelte` (opt-in Nominatim/Open-Meteo stamp) | Low |
| Model slots + voice models | `AiPanel.svelte` (chat/composer/structurize → main slot), `providerTest.ts` + Settings test buttons, `settings.ts` + audio store (sttModel/ttsModel), `sidecar.rs` + `commands.rs` + `api.ts` (model argv), both `.py` sidecars (argv overrides), `docs/MODELS.md` picks | Medium |
| AI memory harness (vendored) | `sidecars/harness/*` (MIT, attributed) + `memory_server.py`, `sidecar.rs` MemoryManager, `commands.rs` + `lib.rs` (8 commands), `api.ts`, `harness.ts`, `AiPanel.svelte` (recall/scrub/learn), `SettingsPane.svelte` (Privacy UI + wipe), `docs/HARNESS.md` | Medium |
| Companion widget | `tauri.conf.json` (transparent 56px figure, runtime resize/dock), `capabilities/*.json` (window + autostart ACL), `Cargo.toml`/`Cargo.lock` + npm autostart plugin, `main.ts` (static App import, lazy WidgetApp), `WidgetApp.svelte`, `LazyWorkspace.svelte`, all canonical workspace components, `LibraryWorkspace.svelte` (Files deep-link), `widgetBridge.ts`, `App.svelte`, `SettingsPane.svelte`, `settings.ts` + `settingsValidate.ts`, `lib.rs`, `docs/WIDGET.md` | High |

## Dependency Graph

```
App.svelte
  ├── Sidebar.svelte → stores/app.ts, api.ts
  ├── TabBar.svelte → stores/app.ts, api.ts
  ├── BreadcrumbBar.svelte → stores/app.ts
  ├── EditorPane.svelte → stores/app.ts, api.ts, stores/writeBack.ts, codemirror/*
  ├── AiPanel.svelte → stores/app.ts, stores/writeBack.ts
  ├── StatusBar.svelte → stores/app.ts
  └── EmptyState.svelte → stores/app.ts, api.ts
```
`main.ts?widget=1` → `WidgetApp.svelte` (dynamic import) → `LazyWorkspace.svelte` (selected canonical workspace),
`EmptyState.svelte`, normal workspace/settings stores, save state, and main/widget events.
`main.ts` mounts `App.svelte` statically — a dynamic import there emits
root-absolute chunk URLs that the jsdom probes cannot resolve.


---

*Updated by `body-build` and `body-audit`. Keep current on structural changes.*
