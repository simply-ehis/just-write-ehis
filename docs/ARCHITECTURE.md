PURPOSE: how the app is layered and how data flows through it
OWNS: layer decisions, backend selection, cross-cutting rules
READ-WHEN: adding a command/workspace, touching storage, AI, theming, or icons
KEY-FILES: src/lib/api.ts (invoke router), src/lib/browserBackend.ts (preview), src/WidgetApp.svelte + src/lib/components/LazyWorkspace.svelte + src-tauri/tauri.conf.json (two-window shell), src-tauri/src/commands.rs + doc_store.rs, src/app.css (theme vars)
INVARIANTS: files-on-disk truth; every api.ts command has a browserBackend case; one process has main/widget only; setup_file_watcher runs once from main; widget never initializes DB/watcher/sidecars/RAG; no Lucide/emoji icons; all UI strings go through native title/aria-label tooltips on icon buttons
GOTCHAS: app.css must stay imported by main.ts (the whole theme died once when it wasn't); widget capabilities must include label `widget`; Files is a virtual workspace and deep-links to Library; $lib alias only, no relative climbs; native transparent docking remains build-gated
UPDATED: 2026-09-24

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
Anything needing native binaries (pandoc formats, voice sidecars, updater,
file watcher) fails in preview with a message saying so — never silently.

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
| `convert.rs` | md/txt/html built in (`pulldown-cmark`); docx/epub/pdf via pandoc |
| `sidecar.rs` | python sidecars (small-model harness, Moonshine STT, Kokoro TTS) |
| `models.rs` | shared structs (all `#[serde(default)]` for forward compat) |

Hot save path: keystroke → SQLite WAL (crash-safe) → 5s debounce flush to
the `.md` file on disk → snapshot only on meaningful diff. File watcher +
atomic saves keep external sync tools (Syncthing etc.) safe.

## Frontend (`src/`)

- `stores/`: `app` (workspace/doc/tabs/panels), `settings` (persisted,
  localStorage), `lock` (session-only unlocks), `lastPlace` (per-workspace
  restore), `writeBack` (AI→editor pipe), `saveState`, `notifications`.
- Components are one-workspace-per-file plus shared pieces (`Icon`,
  `CommandPalette`, `TabBar`, `InspectorPanel`, `LockScreen`, …).
- `Icon.svelte` is the **only** icon source: 40+ hand-authored stroke
  icons. Never Lucide, never emoji-as-icon (syntax glyphs like `☐`/`[[`
  inside menus are content, not icons, and stay).
- `updates.ts` wraps the Tauri updater plugin (browser-safe no-ops).
- `bookparse.ts` extracts book text (epub/docx/pdf), lazy-imported so the
  pdf.js engine never touches the main bundle.

## Lock semantics (the rule)

Locked docs: **content invisible, titles visible.** Excluded from search,
RAG, AI context (even the open doc), Home stats, smart tabs. Still listed
in workspaces/graph/properties so they stay manageable. Unlocks live only
in memory. At-rest secrecy is explicitly *not* this flag's job — that's the
future encrypted vault (see `TODOS.md`).

## Companion window

The desktop shell has exactly two windows in one process: `main` and the taskbar-skipped `widget` declared in `tauri.conf.json`. `?widget=1` dynamically mounts `WidgetApp.svelte`, not `App.svelte`; the widget starts as a transparent 56px figure, resizes into a docked panel, and lazy-loads exactly one selected canonical workspace. It has no application sidebar, tab bar, breadcrumb, inspector, command palette, watcher, sidecar, or RAG initializer. Write reuses `EditorPane` in companion mode; the other canonical workspace IDs use their existing lazy workspace components, with Files deep-linking to Library. Both labels are listed in `capabilities/default.json`. See `docs/WIDGET.md` for lifecycle, proof output, and pending native measurements.

## Theming

All color/type/spacing flows through `:root` vars in `src/app.css`
(`--surface-*`, `--text-*`, `--space-*`, …). `[data-theme="light"]`
overrides the same vars with a paper palette. `App.svelte` applies it from
settings; `index.html` pre-applies it pre-paint (no flash). Brand mark
ships black + white variants and components pick by theme.
