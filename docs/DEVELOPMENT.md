PURPOSE: set up, run, and extend the codebase without breaking it
OWNS: scripts, extension recipes, dependency policy
READ-WHEN: first setup, adding commands/workspaces/deps, touching config
KEY-FILES: package.json (scripts), src-tauri/tauri.conf.json, src-tauri/capabilities/default.json, tests/make-fixtures.py
INVARIANTS: npm scripts are the only entry points; new deps must be browser-safe or lazy-loaded; capabilities must grant every plugin command the UI calls
GOTCHAS: first `tauri build` refreshes Cargo.lock (new Rust deps pending); mammoth is banned (node-only requires break both bundlers — docx parses via jszip); never build executables in agent sessions
UPDATED: 2026-09-17

# Development

## Setup

```sh
npm install          # frontend deps
npm run dev          # http://localhost:5173, full app on localStorage backend
```

Rust toolchain only matters for the desktop shell (`npm run tauri …`).

## Scripts

| Script | What it proves / does |
|---|---|
| `npm run dev` | live preview, hot reload |
| `npm run build` | web bundle only (never an exe) |
| `npm run preview` | serve `dist/` |
| `npm run check` | `svelte-check` — must be **0 errors** |
| `npm run test:e2e` | `tests/e2e-browser.mjs` — must exit 0 |
| `npm run tauri …` | desktop shell (build/dev/signer) |

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
2. Entry in `src/lib/stores/app.ts` (`workspaces` + `workspaceStates`).
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
