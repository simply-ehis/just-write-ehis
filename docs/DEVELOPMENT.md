PURPOSE: set up, run, and extend the codebase without breaking it
OWNS: scripts, extension recipes, dependency policy
READ-WHEN: first setup, adding commands/workspaces/deps, touching config
KEY-FILES: package.json (scripts), src-tauri/tauri.conf.json, src-tauri/tauri.windows.conf.json, src-tauri/sidecars/build_sidecars.py, src-tauri/capabilities/default.json, tests/make-fixtures.py
INVARIANTS: npm scripts are the only entry points; new deps must be browser-safe or lazy-loaded; capabilities must grant every plugin command the UI calls
GOTCHAS: source-only work must not run PyInstaller/Tauri; release `tauri build` first packages native sidecars; mammoth is banned (node-only requires break both bundlers — docx parses via jszip)
UPDATED: 2026-09-25

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
| `npm run test:source` | CI-safe settings, sidecar validation/readiness, window, and support units |
| `npm run test:assets` | release asset preflight only; creates no venv or executable |
| `npm run build:sidecars` | isolated PyInstaller build of STT/TTS/memory runtimes; release pipeline invokes it |
| `npm run tauri …` | desktop shell; Windows `tauri build` runs the native sidecar packaging step first |

## Adding a Tauri command (all five, no exceptions)

1. Rust fn in `commands.rs` (+ logic in `doc_store.rs` / new module).
2. Register in `lib.rs` `invoke_handler!`.
3. Migration in `database.rs` first if storage changes (copy the pattern).
4. Method in `src/lib/api.ts` via `safeInvoke`.
5. `case` in `src/lib/browserBackend.ts` (+ `browserStore.ts` state if any).
6. Update the in-app self-test (`SettingsPane.svelte`) if it exercises a user flow.

Step 5 is statically enforced by e2e (`api commands covered by browser backend`).

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
