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
synthesis instead of the desktop Moonshine STT / Phonon TTS sidecars.

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
| `sidecar.rs` | native-first process managers for memory, Moonshine STT, Phonon TTS, and llama.cpp LLM; Python scripts are the source/dev fallback |
| `tts_render.rs` | render-ahead TTS: one job → pages of PCM + sample-accurate segment timeline (bounded ~45 s producer, exact pause silence, raw i16le page fetch) |
| `models.rs` | shared structs (all `#[serde(default)]` for forward compat) |

Save path: the editor debounces changes, then sends one document save to
Rust. Rust commits the document row, writes the Markdown file, and returns
the saved document; a failed file write is reported as a save failure.
Snapshots are created only for meaningful changes. Entity, backlink, and
  RAG refreshes are queued on a separate SQLite connection when the derived
  index worker is available; otherwise they run synchronously as a best-effort
  fallback, with failures logged. The
SQLite connection is still mutex-protected, and most IPC commands are still
synchronous; responsiveness under a large real vault remains a runtime
measurement. File watcher + atomic saves keep external sync tools
(Syncthing etc.) safe.

## Frontend (`src/`)

- `stores/`: `app` (workspace/doc/tabs/panels), `settings` (persisted,
  localStorage), `lastPlace` (per-workspace
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
secrecy. The PIN / app-lock session gate and per-document lock were removed
2026-10-09 (see `CHANGELOG.md`). There is no session lock in the current app.

## Companion window

The desktop shell has exactly two windows in one process: `main` and the taskbar-skipped `widget` declared in `tauri.conf.json`. `?widget=1` dynamically mounts `WidgetApp.svelte`, not `App.svelte`. The widget is a resizable frame (280x180 minimum) around ONE mini single-job widget (Quick note or Reader, see `src/lib/widgets/registry.ts`); it never hosts a full workspace, and its ACL is a four-command allowlist. It has no application sidebar, tab bar, inspector, command palette, watcher, sidecar, or RAG initializer. Both labels are listed in `capabilities/default.json`. See `docs/WIDGET.md` for the design, lifecycle and verification.

## Auto Story Memory

Story Bible facts remain canonical and manually editable. `bible_mentions` is
project-scoped evidence keyed to a source scene; `bible_suggestions` holds
unmatched local-model candidates until the user confirms them. Automatic
extraction is queued only after a successful document save, runs through the
managed local llama.cpp `LlmManager` on loopback, and retries silently when
that model is unavailable. The editor lookup is a CodeMirror decoration/hover pass over
already-loaded fact keys; it never calls a model per hover. Browser preview
persists the same mention/suggestion records but reports local extraction as
skipped because the native model is unavailable there.

## Local model flow

Settings/runtime button → `stores/audio.ts` → Tauri command → `sidecar.rs`
→ packaged native runtime (or Python source fallback) → STT/TTS model
assets under `sidecars/models/` (bundled). The LLM runner
`llama-server.exe` **is** bundled (exe + runtime DLLs, no weights): local
completion needs a user-provided GGUF from
`Documents/Just Write ehis/models` — the chat model itself is never
bundled. STT health means the model loaded; TTS health means the
bundle and runtime are usable before its intentional lazy synthesis; LLM
health means llama.cpp is serving, and the Settings check then performs a
real completion. Windows `tauri.windows.conf.json` runs `build_sidecars.py` first.

## Read-aloud render pipeline

Read-aloud no longer synthesizes per sentence. The frontend segments the
snapshot once (`readerSections.splitSegments` — char offsets into the
source, 200-char cap, sentence/paragraph/section pause classes), then
starts ONE render job (`tts_render_start`). The Rust `TtsRenderer` loops
per-sentence synthesis against the Phonon sidecar, inserts pauses as
generated silence (exactly `ms × 24` samples at 24 kHz), records
`SegmentTiming` offsets in the same pass that writes the PCM, and emits
pages (~45–90 s, snapped to paragraph boundaries) as `tts://render-page`
events; the frontend pulls each page as raw i16le bytes
(`tts_render_page` — no base64). The producer is bounded: it renders
until ~45 s beyond the demanded playhead (`tts_render_demand`), flushing
whatever it holds before blocking so playback is never starved.

`src/lib/tts/player.ts` schedules pages gapless on one AudioContext
(`start = anchor + (pageStart − anchorSample) / rate`, late pages trimmed
exactly to the clock) and one ~10 Hz tick maps `ctx.currentTime` →
`playheadSample` → binary search over the timeline to drive
`onSentence`/`onSection`, the transport, and progress. If playback meets
the render frontier it HOLDS on the current sample (context suspend —
anchor math survives untouched) and resumes when the page lands; it never
stutters and never calls synthesis mid-sentence. `ReadAloudButton` is
thin UI over this; the browser preview keeps its speechSynthesis queue.

## Theming

All color/type/spacing flows through `:root` vars in `src/app.css`
(`--surface-*`, `--text-*`, `--space-*`, …). `[data-theme="light"]`
overrides the same vars with a paper palette. `App.svelte` applies it from
settings; `index.html` pre-applies it pre-paint (no flash). Brand mark
ships black + white variants and components pick by theme.
