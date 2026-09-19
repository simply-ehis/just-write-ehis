PURPOSE: how export formats resolve, pandoc setup, manuscript flow
OWNS: conversion tiers, pandoc sidecar recipe, compile.run semantics
READ-WHEN: export fails, adding a format, bundling the pandoc sidecar
KEY-FILES: src-tauri/src/convert.rs, commands.rs (convert_run/compile_run/convert_status), src/lib/download.ts
INVARIANTS: menus list exactly what convert_status reports; binary book formats import via parsers, never raw
GOTCHAS: PDF needs a pandoc PDF engine; browser preview does md/txt/html only
UPDATED: 2026-09-17

# EXPORT.md — Document conversion & manuscript compile

> PURPOSE: how export formats resolve, pandoc setup, manuscript flow.
> READ WHEN: export fails, adding a format, bundling the pandoc sidecar.
> KEY FILES: `src-tauri/src/convert.rs`, `commands.rs` (`convert_run`, `compile_run`, `convert_status`), `src/lib/download.ts`, editor export menu, Novel Compile dialog.

## Format tiers

| Tier | Formats | Engine | Works offline | Browser preview |
|---|---|---|---|---|
| Built in | md, txt, html | Rust (`pulldown-cmark` + stripper) | yes | yes |
| Pandoc | docx, epub, pdf | `pandoc` binary | yes, once installed | no (clear error) |

The export menu and Compile dialog list exactly what `convert_status`
reports, so unavailable formats never appear as dead buttons.

## Pandoc resolution (desktop)

1. `<resource_dir>/binaries/pandoc[.exe]` (bundled sidecar — see below).
2. `pandoc` on `PATH` (e.g. `winget install pandoc`, `brew install pandoc`).
3. Otherwise the command fails with install guidance, not a silent stub.

PDF additionally needs a pandoc PDF engine (LaTeX/Typst/WeasyPrint);
pandoc's stderr is surfaced verbatim so the missing piece is obvious.

## Bundling pandoc as a sidecar (release)

1. Download the pandoc binary for each target into
   `src-tauri/binaries/pandoc-<target-triple>[.exe]`
   (e.g. `pandoc-x86_64-pc-windows-msvc.exe`).
2. Register it in `tauri.conf.json`:
   `"bundle": { "externalBin": ["binaries/pandoc"] }`
3. `find_pandoc` picks it up from the resource dir automatically.

## Manuscript compile

Novel Studio → Compile previews the joined markdown (`novelCompile`),
then Download exports it in board order (acts → sequences → scenes) via
`compile_run(doc_ids, format, title)` — the spec's `compile.run`.
