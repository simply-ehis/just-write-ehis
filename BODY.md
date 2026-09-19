# BODY.md — Writing App Anatomy Map

## Brain

| Part | File | Role |
|---|---|---|
| Core orchestrator | `src-tauri/src/lib.rs` | Tauri app bootstrap, manages database lifecycle and command registration |
| Command registry | `src-tauri/src/commands.rs` | All Tauri IPC commands exposed to the frontend |

## Nerves

| Nerve | File | Symbol | What registers here |
|---|---|---|---|
| Tauri commands | `src-tauri/src/commands.rs` | `generate_handler![]` | All doc/backlink/tab/log commands |
| Frontend API | `src/lib/api.ts` | `api` object | All invoke wrappers for Tauri commands |

## Blood

| Organ | File | What it provides |
|---|---|---|
| App stores | `src/lib/stores/app.ts` | Global reactive state: currentWorkspace, currentDoc, openTabs, panel toggles, showSettings |
| Settings store | `src/lib/stores/settings.ts` | Persistent app settings with localStorage fallback |

## Skin

| Component | File | Visual surface |
|---|---|---|
| Sidebar | `src/lib/components/Sidebar.svelte` | Left nav: workspace list, new doc, settings toggle |
| TabBar | `src/lib/components/TabBar.svelte` | Tab strip: open docs per workspace |
| BreadcrumbBar | `src/lib/components/BreadcrumbBar.svelte` | Doc path breadcrumb |
| StatusBar | `src/lib/components/StatusBar.svelte` | Bottom strip: word count, save state, workspace |
| EditorPane | `src/lib/components/EditorPane.svelte` | CodeMirror 6 editor with dark theme |
| LogsWorkspace | `src/lib/components/LogsWorkspace.svelte` | Calendar strip, day list, quick capture, daily notes |
| JustWriteWorkspace | `src/lib/components/JustWriteWorkspace.svelte` | Typewriter mode, focus dimming, session timer |
| NodeMapWorkspace | `src/lib/components/NodeMapWorkspace.svelte` | Canvas graph: d3-force layout, node inspector, overlays, filters |
| AiPanel | `src/lib/components/AiPanel.svelte` | Right dock: Chat/Composer/Ghost modes |
| SettingsPane | `src/lib/components/SettingsPane.svelte` | 9-category settings: general, editor, AI, privacy, vaults, sync, capture, keybindings, about |
| EmptyState | `src/lib/components/EmptyState.svelte` | Per-workspace empty state with hints |

## Organs

| Organ | Path | Description |
|---|---|---|
| Core Engine | `src-tauri/src/` | Rust backend: database, models, commands, doc_store, convert |
| Frontend Shell | `src/lib/` | Svelte 5 UI: components, stores, API layer |
| Editor | `src/lib/components/EditorPane.svelte` | CodeMirror 6 integration with dark theme |
| Logs | `src/lib/components/LogsWorkspace.svelte` | Daily notes with calendar and quick capture |
| Just Write | `src/lib/components/JustWriteWorkspace.svelte` | Distraction-free writing with typewriter mode |
| Settings | `src/lib/components/SettingsPane.svelte` | App configuration (§A6) |
| sqlite-vec | `src-tauri/src/doc_store.rs` | TF-IDF vectorizer (256-dim) + rag_vec virtual table for semantic RAG |

## Bones & Muscles

| Name | Type | Kind | File | Nerve (wires-to) | Status |
|---|---|---|---|---|---|
| Database | bone | engine | `src-tauri/src/database.rs` | lib.rs (setup) | ✅ wired |
| DocStore | muscle | engine | `src-tauri/src/doc_store.rs` | commands.rs | ✅ wired |
| Commands | muscle | engine | `src-tauri/src/commands.rs` | lib.rs (handler) | ✅ wired |
| API wrapper | bone | frontend | `src/lib/api.ts` | all components | ✅ wired |
| BrowserStore | bone | frontend | `src/lib/browserStore.ts` | browserBackend (preview persistence) | ✅ wired |
| BrowserBackend | muscle | frontend | `src/lib/browserBackend.ts` | api.ts safeInvoke fallback | ✅ wired |
| Icon | skin | ui | `src/lib/components/Icon.svelte` | all components (single icon source) | ✅ wired |
| Updates | muscle | frontend | `src/lib/updates.ts` | SettingsPane About + App startup check | ✅ wired |
| Update status cmd | muscle | engine | `commands.rs::app_update_status` | api.ts → SettingsPane | ✅ wired (not compiled — see BUILD_CHECKLIST) |
| Convert engine | bone | engine | `src-tauri/src/convert.rs` | commands convert/compile/status | ✅ wired (not compiled — see BUILD_CHECKLIST) |
| Download helper | tendon | frontend | `src/lib/download.ts` | EditorPane + NovelWorkspace | ✅ wired |
| Book parser | bone | frontend | `src/lib/bookparse.ts` | ReaderWorkspace (lazy import) | ✅ wired |
| Provider test | tendon | frontend | `src/lib/providerTest.ts` | SettingsPane AI slot buttons | ✅ wired |
| Harness memory | muscle | engine+ui | `sidecars/harness/*` + `memory_server.py`, `sidecar.rs` MemoryManager, `harness.ts`, AiPanel gates, Privacy UI | ✅ wired (not compiled — see BUILD_CHECKLIST) |
| Place stamp | tendon | frontend | `src/lib/stamp.ts` | LogsWorkspace (opt-in daily stamp) | ✅ wired |
| Lock store | tendon | frontend | `src/lib/stores/lock.ts` | TabBar, App gate, AiPanel, EditorPane | ✅ wired |
| Last-place store | tendon | frontend | `src/lib/stores/lastPlace.ts` | App workspace-restore effect | ✅ wired |
| LockScreen | skin | ui | `src/lib/components/LockScreen.svelte` | App content-pane overlay | ✅ wired |
| CanvasWorkspace | skin | ui | `src/lib/components/CanvasWorkspace.svelte` | App.svelte (canvas route) | ✅ wired |
| Brand mark | asset | ui | `public/logo.svg` (black) + `public/logo-light.svg` (white) + generated PNG/ICO/ICNS | Sidebar, Home nav, boot, onboarding, favicon, manifest, Tauri bundle | ✅ wired |
| App stores | bone | frontend | `src/lib/stores/app.ts` | all components | ✅ wired |
| Settings store | bone | frontend | `src/lib/stores/settings.ts` | SettingsPane | ✅ wired |
| WriteBack store | tendon | frontend | `src/lib/stores/writeBack.ts` | AiPanel → EditorPane | ✅ wired |
| Sidebar | skin | ui | `src/lib/components/Sidebar.svelte` | App.svelte | ✅ wired |
| TabBar | skin | ui | `src/lib/components/TabBar.svelte` | App.svelte | ✅ wired |
| BreadcrumbBar | skin | ui | `src/lib/components/BreadcrumbBar.svelte` | App.svelte | ✅ wired |
| StatusBar | skin | ui | `src/lib/components/StatusBar.svelte` | App.svelte | ✅ wired |
| EditorPane | skin | ui | `src/lib/components/EditorPane.svelte` | App.svelte | ✅ wired |
| LogsWorkspace | skin | ui | `src/lib/components/LogsWorkspace.svelte` | App.svelte | ✅ wired |
| JustWriteWorkspace | skin | ui | `src/lib/components/JustWriteWorkspace.svelte` | App.svelte | ✅ wired |
| NodeMapWorkspace | skin | ui | `src/lib/components/NodeMapWorkspace.svelte` | App.svelte | ✅ wired |
| AiPanel | skin | ui | `src/lib/components/AiPanel.svelte` | App.svelte | ✅ wired |
| SettingsPane | skin | ui | `src/lib/components/SettingsPane.svelte` | App.svelte | ✅ wired |
| EmptyState | skin | ui | `src/lib/components/EmptyState.svelte` | App.svelte | ✅ wired |

---

*Generated by `body-init`. Update via `body-build` (new features) and `body-audit` (wiring checks).*
