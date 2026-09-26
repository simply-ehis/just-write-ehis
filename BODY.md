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

Brand assets: `public/logo.svg` and `public/logo-light.svg` feed generated PNG/ICO/ICNS assets used by Sidebar, Home, boot, onboarding, favicon, manifest, and the Tauri bundle.
| EditorPane | `src/lib/components/EditorPane.svelte` | CodeMirror 6 editor with dark theme |
| LogsWorkspace | `src/lib/components/LogsWorkspace.svelte` | Calendar strip, day list, quick capture, daily notes |
| JustWriteWorkspace | `src/lib/components/JustWriteWorkspace.svelte` | Typewriter mode, focus dimming, session timer |
| NodeMapWorkspace | `src/lib/components/NodeMapWorkspace.svelte` | Canvas graph: d3-force layout, node inspector, overlays, filters |
| AiPanel | `src/lib/components/AiPanel.svelte` | Right dock: Chat/Composer/Ghost modes |
| SettingsPane | `src/lib/components/SettingsPane.svelte` | 12-category settings: general, editor, AI, tips, craft, stats, privacy, vaults, capture, keybindings, support, about |
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
| Update status cmd | muscle | engine | `src-tauri/src/commands.rs` | api.ts → SettingsPane (`app_update_status`) | ✅ wired (not compiled — see BUILD_CHECKLIST) |
| Convert engine | bone | engine | `src-tauri/src/convert.rs` | commands convert/compile/status | ✅ wired (not compiled — see BUILD_CHECKLIST) |
| Download helper | tendon | frontend | `src/lib/download.ts` | EditorPane + NovelWorkspace | ✅ wired |
| Book parser | bone | frontend | `src/lib/bookparse.ts` | ReaderWorkspace (lazy import) | ✅ wired |
| Provider test | tendon | frontend | `src/lib/providerTest.ts` | SettingsPane AI slot buttons | ✅ wired |
| Harness memory | muscle | engine+ui | `src/lib/memorySidecar.ts` | memory_server.py + sidecar.rs MemoryManager + AiPanel gates + Privacy UI | ✅ wired (not compiled — see BUILD_CHECKLIST) |
| Story Memory schema | bone | engine | `src-tauri/src/database.rs` | `bible_mentions` + `bible_suggestions` migration in models.rs | ✅ wired |
| Story Memory extraction | muscle | engine | `src/lib/storyMemory.ts` | commands.rs `LlmManager` local-only extraction + debounced save queue | ✅ wired |
| Story Memory lookup | muscle | frontend | `src/lib/storyMemoryEditor.ts` | EditorPane + JustWriteWorkspace CodeMirror decorations and hover card | ✅ wired |
| Story Memory review UI | skin | ui | `src/lib/components/NovelWorkspace.svelte` | StoryMemoryHoverCard: appearances, suggestions, contradictions, scene jumps | ✅ wired |
| Place stamp | tendon | frontend | `src/lib/stamp.ts` | LogsWorkspace (opt-in daily stamp) | ✅ wired |
| Lock store + app gate | tendon | frontend | `src/lib/stores/lock.ts` | SettingsPane keychain setup → App session gate → TabBar/LockScreen/AiPanel/EditorPane | ✅ wired (source-tested; native gate build pending) |
| Native sidecar packager | tendon | build | `src-tauri/sidecars/build_sidecars.py` | `package.json` → `tauri.windows.conf.json` → `sidecar.rs` native-first launchers | ✅ wired (not built by user instruction) |
| Window state | muscle | frontend | `src/lib/windowState.ts` | App startup → main-window geometry | ✅ wired (source-tested) |
| Last-place store | tendon | frontend | `src/lib/stores/lastPlace.ts` | App workspace-restore effect | ✅ wired |
| LockScreen | skin | ui | `src/lib/components/LockScreen.svelte` | App content-pane overlay | ✅ wired |
| CanvasWorkspace | skin | ui | `src/lib/components/CanvasWorkspace.svelte` | App.svelte (canvas route) | ✅ wired |
| App stores | bone | frontend | `src/lib/stores/app.ts` | all components | ✅ wired |
| Settings store | bone | frontend | `src/lib/stores/settings.ts` | SettingsPane | ✅ wired |
| WriteBack store | tendon | frontend | `src/lib/stores/writeBack.ts` | AiPanel → EditorPane | ✅ wired |
| Sidebar | skin | ui | `src/lib/components/Sidebar.svelte` | App.svelte | ✅ wired |
| TabBar | skin | ui | `src/lib/components/TabBar.svelte` | App.svelte | ✅ wired |
| BreadcrumbBar | skin | ui | `src/lib/components/BreadcrumbBar.svelte` | App.svelte | ✅ wired |
| StatusBar | skin | ui | `src/lib/components/StatusBar.svelte` | App.svelte | ✅ wired |
| EditorPane | skin | ui | `src/lib/components/EditorPane.svelte` | App.svelte + WidgetApp companion mode | ✅ wired |
| WidgetApp | skin | ui | `src/WidgetApp.svelte` | `main.ts?widget=1`, settings, capabilities, tray | ✅ wired |
| Widget bridge | tendon | frontend | `src/lib/widgetBridge.ts` | App.svelte ↔ widget events | ✅ wired |
| LogsWorkspace | skin | ui | `src/lib/components/LogsWorkspace.svelte` | App.svelte | ✅ wired |
| JustWriteWorkspace | skin | ui | `src/lib/components/JustWriteWorkspace.svelte` | App.svelte | ✅ wired |
| NodeMapWorkspace | skin | ui | `src/lib/components/NodeMapWorkspace.svelte` | App.svelte | ✅ wired |
| AiPanel | skin | ui | `src/lib/components/AiPanel.svelte` | App.svelte | ✅ wired |
| SupportPane | skin | ui | `src/lib/components/SupportPane.svelte` | SettingsPane support category | ✅ wired |
| SettingsPane | skin | ui | `src/lib/components/SettingsPane.svelte` | App.svelte | ✅ wired |
| EmptyState | skin | ui | `src/lib/components/EmptyState.svelte` | App.svelte | ✅ wired |
| LazyWorkspace | skin | ui | `src/lib/components/LazyWorkspace.svelte` | App.svelte (map/canvas/novel/script/projects/reader/properties) + SettingsPane (skills/craft/stats) | ✅ wired |
| QuickCaptureOverlay | skin | ui | `src/lib/components/QuickCaptureOverlay.svelte` | App.svelte + StatusBar (Ctrl+Shift+F) | ✅ wired |
| DockSplit | skin | ui | `src/lib/components/DockSplit.svelte` | Novel/Inbox/Projects/Canvas (vertical) + Reader notes (horizontal) — persisted drag dividers | ✅ wired |
| Split target store | tendon | frontend | `src/lib/stores/split.ts` | JustWriteWorkspace → AiPanel (Main/Split write-back) | ✅ wired |
| Settings sections | skin | ui | `src/lib/components/SettingsPane.svelte` | embeds SkillsPage/CraftPage/UsageMemory via settings.ts settingsCategory + CommandPalette/Home deep-links | ✅ wired (moved out of sidebar 2026-09-19) |

---

*Generated by `body-init`. Update via `body-build` (new features) and `body-audit` (wiring checks).*
