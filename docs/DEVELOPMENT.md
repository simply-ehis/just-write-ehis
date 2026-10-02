PURPOSE: set up, run, and extend the codebase without breaking it
OWNS: scripts, extension recipes, dependency policy
READ-WHEN: first setup, adding commands/workspaces/deps, touching config
KEY-FILES: package.json (scripts), src-tauri/tauri.conf.json, src-tauri/tauri.windows.conf.json, src-tauri/sidecars/build_sidecars.py, src-tauri/capabilities/default.json, tests/make-fixtures.py
INVARIANTS: npm scripts are the only entry points; new deps must be browser-safe or lazy-loaded; capabilities must grant every plugin command the UI calls; every Tauri command must be registered in lib.rs AND build.rs COMMANDS AND granted in permissions/*.toml
GOTCHAS: source-only work must not run PyInstaller/Tauri; a bare `cargo build --release` yields a ghost-window binary unless `--features custom-protocol` is passed (use `npm run tauri build`); release `tauri build` first packages native sidecars; never register a service worker in the desktop shell; mammoth is banned (node-only requires break both bundlers — docx parses via jszip)
UPDATED: 2026-10-01

# Development

## Setup

```sh
npm install          # frontend deps
npm run dev          # http://localhost:5173, full app on localStorage backend
```

Rust toolchain only matters for the desktop shell (`npm run tauri …`).

## Native model runtimes

Development can run `stt_server.py`, `tts_server.py`, and `memory_server.py`
with a Python environment containing `src-tauri/sidecars/requirements.txt`.
Asset fetches require pinned SHA-256 values; `JWE_ALLOW_UNPINNED_SIDECARS=1`
is reserved for local-only investigation and must not be used for release assets.
Release builds do not depend on that environment: `tauri.windows.conf.json`
runs `npm run build:sidecars` before Windows packaging, which creates native
STT/TTS/memory executables under `src-tauri/sidecars/bin/`; the Windows
resource overlay repeats the base model/script resources and adds that bin
bundle. The Rust manager prefers those
executables and passes `JWE_SIDECARS_DIR` so models remain external to the
runtime. Development fallback accepts only `python`, `python3`, or `py` from
PATH; arbitrary interpreter paths are rejected at the IPC boundary. `npm run
test:assets` checks the required model/runtime tree without performing a build.

## Scripts

| Script | What it proves / does |
|---|---|
| `npm run dev` | live preview, hot reload |
| `npm run build` | web bundle only (never an exe) |
| `npm run preview` | serve `dist/` |
| `npm run check` | `svelte-check` — must be **0 errors** |
| `npm run test:e2e` | `tests/e2e-browser.mjs` — must exit 0; serves the existing `dist/` |
| `npm run test:source` | CI-safe settings, sidecar validation/readiness, window, boot-gate, ghost-window, CSP, ACL-parity and support units |
| `npm run test:assets` | release asset preflight only; creates no venv or executable |
| `npm run build:sidecars` | isolated PyInstaller build of STT/TTS/memory runtimes; release pipeline invokes it |
| `npm run tauri …` | desktop shell; Windows `tauri build` runs the native sidecar packaging step first |

## Adding a Tauri command (all six, no exceptions)

1. Rust fn in `commands.rs` (+ logic in `doc_store.rs` / new module).
2. Register in `lib.rs` `invoke_handler!`.
3. Add the name to `COMMANDS` in `src-tauri/build.rs` — this is what generates the
   `allow-*` permission. Skip it and step 4 fails the build with
   `failed to resolve ACL`.
4. Add `"allow-<command-name-in-kebab-case>"` to the right
   `src-tauri/permissions/*.toml` set (`main.toml` and/or `widget.toml`). Skip this and
   the build still succeeds but every call fails **at runtime** with
   `Command <name> not allowed by ACL` — no compile error, no existing test failure.
5. Migration in `database.rs` first if storage changes (copy the pattern).
6. Method in `src/lib/api.ts` via `safeInvoke`.
7. `case` in `src/lib/browserBackend.ts` (+ `browserStore.ts` state if any).
8. Update the in-app self-test (`SettingsPane.svelte`) if it exercises a user flow.

`npm run test:aclparity` enforces steps 2–4 in both directions (a registered command with
no grant, a grant for a command that does not exist, and a manifest entry that is not
registered). Step 7 is statically enforced by e2e (`api commands covered by browser backend`).

## Desktop builds must go through the Tauri CLI

Use `npm run tauri build` (or `cargo build --release --features custom-protocol`). A bare
`cargo build --release` compiles, links, and produces an executable — but it sets
`cfg(dev)` unless `custom-protocol` is enabled, so the binary loads
`http://localhost:5173` instead of the embedded frontend. With no dev server running the
webview never loads, `#app` stays empty, and because the main window is configured
`visible: false` and only revealed by frontend code, you get a **ghost window**: a live
process with a correctly-sized window that never appears and cannot be surfaced.

Symptom triage for "the app starts but nothing shows":

| Check | Meaning |
|---|---|
| `IsWindowVisible` false on the `main` window, geometry correct | frontend never booted — see below |
| frontend booted (`#app` has children) but window still hidden | reveal path failed; `showMainWindow()` in `src/lib/windowState.ts` |
| binary loads `localhost:5173` | built without `custom-protocol` |
| entry module rejected as `text/html` | stale service-worker cache serving a document whose hashed chunk is gone |

Diagnose the live shell without a build step of your own: set
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`, attach to the
`http://tauri.localhost` target over CDP, and read the console plus
`document.getElementById('app').children.length`. From PowerShell, `EnumWindows` with
`IsWindowVisible` distinguishes a ghost window from a window that never existed.

## Adding a workspace

1. Component in `src/lib/components/<Name>Workspace.svelte`.
2. Entry in `src/lib/stores/app.ts` (`workspaces` + the shared workspace icon/group source).
3. Route branch in `src/App.svelte`; icon in `wsIcons` (`Sidebar.svelte`);
   accent in `app.css` + `TabBar.svelte`; palette entry; Home labels;
   mobile `BottomBar.svelte` more-menu. (See the Canvas commit for the full list.)
4. Decide: does it restore last place (`lastPlace.ts` allowlist)? render locked docs?

## Dependencies

- Prefer what exists; lazy-import anything heavy (`bookparse`/pdf.js pattern).
- Frontend additions must survive `vite build` **and** the node e2e bundle.
- Capabilities (`src-tauri/capabilities/default.json`) must allow every
  plugin IPC the UI invokes (`updater:default`, `process:default`, …).

## Test fixtures

`tests/make-fixtures.py` regenerates `tests/fixtures/{sample.epub,sample.docx,sample.pdf}`
(hand-built, public-domain sentence). Re-run after touching `bookparse.ts`
parsers, then `npm run test:e2e`.
