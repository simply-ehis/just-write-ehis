PURPOSE: what each verification layer proves and how to run it
OWNS: check/build/e2e/self-test contracts, fixture policy
READ-WHEN: before declaring anything done; after touching backend, parsers, or config
KEY-FILES: tests/e2e-browser.mjs, tests/ensure-poll.mjs, tests/settings-validate.mjs, tests/sidecar-resolve.py, SettingsPane.svelte (self-test)
INVARIANTS: check 0 errors; source regressions pass; release verification additionally requires a fresh build and e2e exit 0
GOTCHAS: e2e serves dist/ so rebuild first; source-only work must not run Tauri/PyInstaller; native packaging and Rust runtime require an explicitly authorized build
UPDATED: 2026-09-25

# Testing

Seven layers cover the contracts; release verification also requires an explicitly authorized native build.

## 1. `npm run check` — types

`svelte-check`: **0 errors and 0 warnings** required for the current source-only pass. Fix new diagnostics at the source rather than suppressing them.

## 2. `npm run build` — the bundle

`vite build` must pass. Watch it: new heavy deps must code-split
(`dist/assets` should keep a lean main chunk + lazy chunks + worker file).

## 3. `npm run test:e2e` — behavior without a shell

`tests/e2e-browser.mjs` (zero dependencies) currently asserts a broad set of static, parsing, IPC-parity, and memory-runtime checks:

- serves `dist/` over HTTP (page + bundle + logo/manifest/assets),
- bundle contains every workspace's UI markers,
- **api ⊆ browserBackend** (every invoked command has a preview case),
- every `<Icon name>` resolves; no Lucide imports,
- tauri.conf updater wiring, capability grants, Cargo/npm plugin deps,
- **real parsing**: esbuild-bundles `src/lib/bookparse.ts` and extracts
  text from committed binary fixtures (epub/docx/pdf),
- UI wiring markers per feature slice (lock, canvas, streaming, …).

Rebuild (`npm run build`) before running — it tests `dist/`.

## 4. Headless DOM smoke (`npm run test:smoke`) — render without a browser

`tests/smoke-dom.mjs` mounts the real built bundle in jsdom at desktop
(1280), mobile (390), and mobile-with-legacy-vault (`--dirty`) widths,
clicks every workspace nav item, and fails on any render crash or console
error/warning. The dirty run also proves the seed purge keeps real docs.
jsdom gaps (canvas 2d, layout geometry) are polyfilled in the harness and
documented there — never in app code.

## 5. Functional tabs (`npm run test:tabs`) — every tab does its job

`tests/tabs-functional.mjs` boots the built app once in jsdom and drives
all 12 tabs past mounting: Write empty-state → New Document → editor,
Home greeting, Logs today view, Inbox capture → item (via palette, since
inbox hides from the sidebar by default), Novel studio, Script create →
open, Map canvas mount, Reader shelf, Projects create, Library views,
Canvas board (via palette), Settings style select + light/dark mode +
custom accent (all three persist). Theme sweep covers all six style×mode
combos: token contract, WCAG contrast, editor parity, and clean mounts.
Zero console errors required (the jsdom canvas-`getContext` notice is
allowlisted — no canvas package in the harness, never in app code).

## 6. In-app self-test — behavior with a backend

Settings → About → **Run Feature Self-Test**: create/save/search/link/
snapshot/restore/graph/log/lock-exclusion/pinned/metrics/rhythm/export/
canvas through the **live** backend (works in preview and in the shell).
Extend it with every user-flow change (see `DEVELOPMENT.md` step 6).

## 7. Local model + PIN source regressions

Run these without producing an application or sidecar executable:

```bash
npm run test:ensure
npm run test:sidecar
npm run test:resolve
npm run test:settings
npm run test:assets
npm run test:e2e
npm run test:source
```

`test:source` is the CI-safe aggregate (settings, sidecar validation/readiness,
write-back queue, window state, and support units). `test:sidecar` rejects traversal and renderer-selected Python executables while accepting the supported PATH interpreter names. `test:settings` also exercises the shared browser PIN retry state and recovery path. `test:ensure` proves running processes are still
health-checked, readiness is not faked, and TTS lazy loading is represented
honestly. `test:resolve` executes the STT/TTS model-path guards against the
local asset tree. `test:assets` runs the release preflight without creating a
venv or executable. `test:settings` executes validation plus the PIN
create/confirm-enable/session unlock/remove state machine against the browser
secret backend. `test:e2e` checks the Settings self-tests and packaged-runtime
preference markers.

These tests do not replace an explicitly authorized desktop build. The final
`build_sidecars.py` → PyInstaller → Tauri resource chain and native GUI
behavior remain release-gate checks.

## What is NOT covered

- Build-gated UI probes (`test:onboard`, `test:wstoggles`, `test:reader`, theme mount phases, and mobile behavior) report `SKIP` when `dist/` is older than their source inputs. Run them only after an authorized frontend build; source-only mode must not treat a skip as UI evidence.
- Rust compilation (no `cargo` in agent sessions by project rule) — logic
  errors in new Rust surface only at the maintainer's first `tauri build`.
- Real model calls (AI/STT/TTS need servers/sidecars; errors are asserted,
  outputs are not).
- Pixel fidelity (renders are eyeballed during logo/asset work only).
