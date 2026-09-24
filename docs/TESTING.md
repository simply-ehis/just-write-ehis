PURPOSE: what each verification layer proves and how to run it
OWNS: check/build/e2e/self-test contracts, fixture policy
READ-WHEN: before declaring anything done; after touching backend, parsers, or config
KEY-FILES: tests/e2e-browser.mjs, tests/make-fixtures.py + fixtures/, SettingsPane.svelte (self-test)
INVARIANTS: check 0 errors; build passes; e2e exit 0 — all three, every change
GOTCHAS: e2e serves dist/ so rebuild first; binary fixtures are committed, regenerate via script never by hand; Rust has no harness — logic bugs there surface only via self-test in the shell or first tauri build
UPDATED: 2026-09-17

# Testing

Three layers, all required. No layer substitutes for another.

## 1. `npm run check` — types

`svelte-check`: **0 errors** required. Warnings are pre-existing a11y/css
categories; do not add new ones (fix roles/labels at the source).

## 2. `npm run build` — the bundle

`vite build` must pass. Watch it: new heavy deps must code-split
(`dist/assets` should keep a lean main chunk + lazy chunks + worker file).

## 3. `npm run test:e2e` — behavior without a shell

`tests/e2e-browser.mjs` (zero dependencies) currently asserts ~190 checks:

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
Canvas board (via palette), Settings theme switch + persist. Zero console
errors required (the jsdom canvas-`getContext` notice is allowlisted —
no canvas package in the harness, never in app code).

## 6. In-app self-test — behavior with a backend

Settings → About → **Run Feature Self-Test**: create/save/search/link/
snapshot/restore/graph/log/lock-exclusion/pinned/metrics/rhythm/export/
canvas through the **live** backend (works in preview and in the shell).
Extend it with every user-flow change (see `DEVELOPMENT.md` step 6).

## What is NOT covered

- Rust compilation (no `cargo` in agent sessions by project rule) — logic
  errors in new Rust surface only at the maintainer's first `tauri build`.
- Real model calls (AI/STT/TTS need servers/sidecars; errors are asserted,
  outputs are not).
- Pixel fidelity (renders are eyeballed during logo/asset work only).
