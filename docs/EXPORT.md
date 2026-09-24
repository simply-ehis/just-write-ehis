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

All six formats are always listed in export menus and the Compile
dialog; pandoc-gated ones render disabled with the reason inline
("Needs pandoc — see Settings → About → Export setup") instead of
vanishing or throwing at click. `convert_status` also reports
`bundled` (sidecar vs PATH) so setup UI can say which.

## Pandoc resolution (desktop)

1. `<resource_dir>/binaries/pandoc[.exe]` (bundled sidecar — see below;
   this is the shipped configuration).
2. `pandoc` on `PATH` (e.g. `winget install pandoc`, `brew install pandoc`).
3. Otherwise the command fails with install guidance, not a silent stub.

PDF additionally needs a pandoc PDF engine (LaTeX/Typst/WeasyPrint);
pandoc's stderr is surfaced verbatim so the missing piece is obvious.

## Bundling pandoc as a sidecar (release — the shipped configuration)

1. Download the pandoc binary for each target into
   `src-tauri/binaries/pandoc-<target-triple>[.exe]`
   (e.g. `pandoc-x86_64-pc-windows-msvc.exe`).
   The binary is git-ignored (233 MB for pandoc 3.11 Windows) — fetch it
   before release builds; a build without it fails on the missing
   `externalBin` rather than shipping a broken exporter.
2. Registered in `tauri.conf.json`:
   `"bundle": { "externalBin": ["binaries/pandoc"] }`
3. `find_pandoc` picks it up from the resource dir automatically;
   `convert_status.bundled` tells setup UI it came from the bundle.

Measured 2026-09-23: pandoc 3.11 windows-x86_64.zip is 41.8 MB
download, **233.6 MB extracted** — budget ~90–120 MB of installer size
after NSIS compression, not the old 30–50 MB figure. Revisit the bundle
decision if that delta is unacceptable (PATH-only remains supported).

## Manuscript compile

Novel Studio → Compile previews the joined markdown (`novelCompile`),
then Download exports it in board order (acts → sequences → scenes) via
`compile_run(doc_ids, format, title)` — the spec's `compile.run`
(order stays caller-owned: the backend never reorders).

Join rule: each doc gets an `# Title` header with its content headings
demoted one level (H1→H2 … H5→H6), so titles can never collide with
content; docs are separated by `---` rules. Section bodies carry no YAML
of their own (mid-document blocks would render as visible rules) — one
manuscript-level header holds the title plus merged per-doc authors.

Cost bound: the joined manuscript is capped at 5M source characters
(`COMPILE_CHAR_CAP`, ~800k words). Past it, `compile_run` refuses with
a clear error suggesting a zip-of-chapters export instead of OOMing.

## Export preprocessing (shared by convert_run + compile_run)

1. `![[embeds]]` inlined as raw markdown (missing/locked targets become
   a `[embed missing: …]` note — never silent, never a leak).
2. `[[wikilinks]]` resolved to display text (`[[a|b]]` → `b`); exports
   are standalone files, so links become text, not dead vault paths.
3. Frontmatter injected as a YAML block (title/author/date first).
4. `.attachments/` refs copied into the pandoc tempdir with
   `--resource-path` (built-in HTML keeps `<img>` plus a vault-relative
   note; the browser preview has no vault access and leaves refs as-is).

## Publish scope

`publish_static_site` (Rust only — the TS twin was deleted) emits ONE
`index.html`: pulldown-cmark bodies sanitized with ammonia, locked docs
excluded, images inlined as data URIs (2 MB/file cap, skipped files
counted in the result), user `customCss`/`customJs` included with
`</style`/`</script` breakouts neutralized. Per-page output is
explicitly out of scope: single-file site only.
