PURPOSE: how the app is layered and how data flows through it
OWNS: layer decisions, backend selection, cross-cutting rules
READ-WHEN: adding a command/workspace, touching storage, AI, theming, or icons
KEY-FILES: src/lib/api.ts (invoke router), src/lib/browserBackend.ts (preview), src/WidgetApp.svelte + src/lib/components/LazyWorkspace.svelte + src-tauri/tauri.conf.json (two-window shell), src-tauri/tauri.windows.conf.json (Windows packaging), src-tauri/src/sidecar.rs + sidecars/build_sidecars.py (local runtimes), src-tauri/src/commands.rs + doc_store.rs, src/app.css (theme vars)
INVARIANTS: files-on-disk truth; every api.ts command has a browserBackend case; one process has main/widget only; setup_file_watcher runs once from main; widget never initializes DB/watcher/sidecars/RAG; Windows OS registration is Windows-only and opt-in; no Lucide/emoji icons; all UI strings go through native title/aria-label tooltips on icon buttons
GOTCHAS: app.css must stay imported by main.ts (the whole theme died once when it wasn't); widget capabilities must include label `widget`; Files is a virtual workspace and deep-links to Library; Windows associations are installer-owned; native model/sidecar packaging is release-gated; $lib alias only, no relative climbs
UPDATED: 2026-10-09

# Architecture

## Two backends, one frontend

```
Svelte components → stores → api.ts ─┬─ Tauri shell? ── invoke → Rust → SQLite + vault files
                                     └─ browser? ────── browserBackend.ts → localStorage
```

`api.ts` routes every call through `safeInvoke`, which picks the Rust
backend under Tauri and the localStorage mirror in a plain browser. The
mirror implements the **same command surface** (CRUD, search, graph,
snapshots, RAG-keyword, dashboards, canvas, export md/txt/html, …).
Anything needing native binaries (the Typst CLI, updater, file watcher)
fails in preview with a message saying so — never silently. Voice is the
exception: preview uses the browser's built-in speech recognition and
synthesis instead of the desktop Moonshine/Kokoro sidecars.

Rule: **a new Tauri command is not done** until `api.ts` + `browserBackend.ts`
+ `lib.rs` handler registration all exist. `tests/e2e-browser.mjs` asserts
this statically (api ⊆ backend cases).

## Rust backend (`src-tauri/src/`)

| File | Role |
|---|---|
| `lib.rs` | plugin init, state setup, `invoke_handler` registry |
| `commands.rs` | thin IPC wrappers (incl. SSE `ai_generate_stream` via Channel) |
| `doc_store.rs` | all SQL: docs, backlinks, snapshots, RAG chunks, metrics, dashboards |
| `database.rs` | schema + ordered migrations (new columns go here, same pattern) |
| `convert.rs` | format dispatch + shared export preprocess (`docmodel.rs` parses markdown once) |
| `docmodel.rs` | markdown → neutral `Doc`/`Block`/`Span` model, parsed once and shared by all writers |
| `docx.rs` | WordprocessingML writer (`zip` + XML, hand-rolled — the `docx` crate pulls a broken transitive dep) |
| `epub.rs` | EPUB 3 writer (`zip` + `quick-xml`; mimetype STORED first, nav + NCX) |
| `pdf.rs` | Typst source generation + escaping; invokes the bundled Typst CLI per export |
| `sidecar.rs` | native-first process managers for memory, Moonshine STT, Kokoro TTS, and llama.cpp LLM; Python scripts are the source/dev fallback |
| `models.rs` | shared structs (all `#[serde(default)]` for forward compat) |

Hot save path: keystroke → SQLite WAL (crash-safe) → 5s debounce flush to
the `.md` file on disk → snapshot only on meaningful diff. File watcher +
atomic saves keep external sync tools (Syncthing etc.) safe.

## Frontend (`src/`)

- `stores/`: `app` (workspace/doc/tabs/panels), `settings` (persisted,
  localStorage), `lock` (session-only unlocks), `lastPlace` (per-workspace
  restore), `writeBack` (AI→editor pipe), `saveState`, `notifications`.
- Components are one-workspace-per-file plus shared pieces (`Icon`,
  `CommandPalette`, `TabBar`, `InspectorPanel`, …).
- `Icon.svelte` is the **only** icon source: 53 hand-authored stroke
  icons. Never Lucide, never emoji-as-icon (syntax glyphs like `☐`/`[[`
  inside menus are content, not icons, and stay).
- `updates.ts` wraps the Tauri updater plugin (browser-safe no-ops).
- `bookparse.ts` extracts book text (epub/docx/pdf), lazy-imported so the
  pdf.js engine never touches the main bundle.

## Capture flow (workspace id `inbox`, label "Capture")

One capture box per surface, one handoff store pair (`stores/capture.ts`:
`capturePrefill` text + `captureFocus` bump) that only InboxWorkspace
consumes. Entry points: the `Ctrl+Shift+F` QuickCaptureOverlay (any
target workspace; default `inbox`), the palette's Quick Capture action
(focuses the box — never creates an Untitled doc), the status-bar /
mobile Capture button (same overlay), and PWA launch intents
(`launch.ts`: share-target / `?capture=inbox` notification taps /
app shortcuts) which queue text via `sendToCapture`). Share-target text
auto-saves when the capture box was empty (a half-typed draft only gets
the shared text appended). Saves toast "Saved to Capture"; Logs' own box
toasts "Saved to Logs". Triage (move) = recreate the snippet in the
target workspace, then delete the `inbox` original — the id never
migrates. The sidebar hides only Canvas by default
(`DEFAULT_HIDDEN_WORKSPACES`); Capture is a first-class nav entry in the
"Capture" group alongside Logs.

## Privacy & secrets

Secrets (API keys) live in the OS keychain, not localStorage; a boot
migration strips any legacy `apiKey` from localStorage
(`stripPersistedSecrets`, `settings.ts`). Files on disk stay plaintext —
the future encrypted vault (see `TODOS.md`) is what would provide at-rest
secrecy. The earlier PIN / app-lock session gate and per-document lock were
removed 2026-10-09 (see `CHANGELOG.md`).

## Companion window

The desktop shell has exactly two windows in one process: `main` and the taskbar-skipped `widget` declared in `tauri.conf.json`. `?widget=1` dynamically mounts `WidgetApp.svelte`, not `App.svelte`; the widget starts as a transparent 56px figure, resizes into a docked panel, and lazy-loads exactly one selected canonical workspace. It has no application sidebar, tab bar, breadcrumb, inspector, command palette, watcher, sidecar, or RAG initializer. Write reuses `EditorPane` in companion mode; the other canonical workspace IDs use their existing lazy workspace components, with Files deep-linking to Library. Both labels are listed in `capabilities/default.json`. See `docs/WIDGET.md` for lifecycle, proof output, and pending native measurements.

## Auto Story Memory

Story Bible facts remain canonical and manually editable. `bible_mentions` is
project-scoped evidence keyed to a source scene; `bible_suggestions` holds
unmatched local-model candidates until the user confirms them. Automatic
extraction is queued only after a successful document save, runs through the
managed local llama.cpp `LlmManager` on loopback, and retries silently when
that model is unavailable. Source and project lock chains are checked before
any text is sent. The editor lookup is a CodeMirror decoration/hover pass over
already-loaded fact keys; it never calls a model per hover. Browser preview
persists the same mention/suggestion records but reports local extraction as
skipped because the native model is unavailable there.

## Local model flow

Settings/runtime button → `stores/audio.ts` → Tauri command → `sidecar.rs`
→ packaged native runtime (or Python source fallback) → model assets under
`sidecars/models/`. STT health means the model loaded; TTS health means the
bundle and runtime are usable before its intentional lazy synthesis; LLM
health means llama.cpp is serving, and the Settings check then performs a
real completion. Windows `tauri.windows.conf.json` runs `build_sidecars.py` first.

## Theming

All color/type/spacing flows through `:root` vars in `src/app.css`
(`--surface-*`, `--text-*`, `--space-*`, …). `[data-theme="light"]`
overrides the same vars with a paper palette. `App.svelte` applies it from
settings; `index.html` pre-applies it pre-paint (no flash). Brand mark
ships black + white variants and components pick by theme.
