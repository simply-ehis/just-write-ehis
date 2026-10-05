PURPOSE: how export formats resolve, Typst setup, manuscript flow
OWNS: conversion tiers, Typst sidecar recipe, compile.run semantics
READ-WHEN: export fails, adding a format, bundling the Typst sidecar
KEY-FILES: src-tauri/src/convert.rs, docmodel.rs, docx.rs, epub.rs, pdf.rs, commands.rs (convert_run/compile_run/convert_status), src/lib/download.ts
INVARIANTS: menus list exactly what convert_status reports; binary book formats import via parsers, never raw
GOTCHAS: only PDF needs the Typst binary; docx/epub are pure Rust; browser preview does md/txt/html only
UPDATED: 2026-10-05

# EXPORT.md — Document conversion & manuscript compile

> PURPOSE: how export formats resolve, Typst setup, manuscript flow.
> READ WHEN: export fails, adding a format, bundling the Typst sidecar.
> KEY FILES: `src-tauri/src/convert.rs`, `docmodel.rs`, `docx.rs`, `epub.rs`, `pdf.rs`, `commands.rs` (`convert_run`, `compile_run`, `convert_status`), `src/lib/download.ts`, editor export menu, Novel Compile dialog.

## Format tiers

| Tier | Formats | Engine | Works offline | Browser preview |
|---|---|---|---|---|
| Built in | md, txt, html | Rust (`pulldown-cmark` + stripper) | yes | yes |
| Built in (Rust writer) | docx, epub | Rust (`docx.rs` / `epub.rs`) | yes | no (clear error) |
| Bundled binary | pdf | Typst CLI 0.15.1 | yes, once fetched | no (clear error) |

All six formats are always listed in export menus and the Compile
dialog. Only PDF is binary-gated; it renders disabled with the reason
inline ("Needs the Typst binary — see Settings → About → Export setup")
instead of vanishing or throwing at click. `convert_status` reports
`typst` (binary found) and `typst_version` (pinned) so setup UI can say which.

## Why five of six formats are pure Rust

Pandoc was previously bundled for all three book formats: **222.8 MB
extracted**. It is gone. `docx` and `epub` are now written in-process by
`docx.rs` and `epub.rs` — both are ZIP containers of XML parts, sharing the
`zip` crate — so they cost ~5 MB and need no binary at all.

The Typst **Rust crate** was evaluated for PDF and rejected: it compiles in a
WASM runtime (`wasmi`) and two SVG rasterisers (`usvg`/`resvg`) that a prose
exporter never calls — 13 GB of build for ~25 MB, with no feature flags to
disable any of it. The prebuilt CLI is the same compiler at 50 MB with zero
build cost.

## Why Pandoc could not do PDF anyway

Pandoc is a *converter*, not a typesetting engine: for PDF it shells out to
LaTeX, Typst, or WeasyPrint. Bundling Pandoc without one of those produced
222.8 MB and still no PDF. Typst is that engine, so PDF works from the bundle
alone.

## Typst resolution (desktop)

1. `<resource_dir>/binaries/typst[.exe]` (bundled sidecar — see below;
   this is the shipped configuration).
2. `typst` on `PATH` — a dev fallback that keeps `cargo test` and local runs
   working before the fetch step. Prefer the bundled copy: it is the pinned
   version.
3. Otherwise PDF fails with install guidance; md/txt/html/docx/epub still work.

The template pins `Libertinus Serif` explicitly, so output does not vary with
the fonts installed on the host. Verified: exported PDFs carry subset-embedded
`LibertinusSerif-Regular`/`-Bold`/`-Italic` and `DejaVuSansMono`.

## Bundling Typst as a sidecar (release — the shipped configuration)

1. Fetch the pinned binary:
   ```
   python src-tauri/sidecars/fetch_sidecars.py --typst
   # or: npm run fetch:typst
   ```
   This downloads `typst-x86_64-pc-windows-msvc.zip` for v0.15.1, verifies
   its SHA-256 against a pinned digest, extracts `typst.exe` into
   `src-tauri/binaries/`, then runs `--version` and asserts it matches
   `TYPST_VERSION`. The binary is git-ignored — fetch it before release
   builds; a build without it fails on the missing `externalBin`.
2. Registered in `tauri.conf.json`:
   `"bundle": { "externalBin": ["binaries/typst"] }`
3. `pdf::find_typst` accepts either spelling (`typst.exe` or
   `typst-<triple>.exe`); `convert_status.typst` tells setup UI.

Typst is **version-pinned** (0.15.1) in both `fetch_sidecars.py` and
`pdf.rs::TYPST_VERSION`. Typst markup semantics are not frozen across
releases, so a floating "latest" would silently change exported PDFs. When
bumping, update both and re-run the PDF tests.

Measured 2026-10-05: **21.4 MB download, 50.1 MB extracted** — down from
Pandoc's 222.8 MB, a 172 MB saving, and PDF now actually works.

Licence: Apache-2.0 (see `THIRD_PARTY_NOTICES.md`, shipped as a bundle
resource). The CLI embeds Libertinus Serif and New Computer Modern Math
(SIL OFL 1.1) and DejaVu Sans Mono (DejaVu Fonts Licence).

Typst is **not** in the sidecar server list. STT/TTS/LLM are long-running
HTTP servers on loopback ports with per-launch tokens; Typst is a one-shot
CLI invoked per export. Different lifecycle, different auth — no token, no
port, no health check.

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
4. `.attachments/` refs stay as written in the markdown the writers receive.
   The Rust writers render an image as its **alt text** rather than embedding
   the bytes (no media pipeline in `docx.rs`/`epub.rs`/`pdf.rs`), so content
   is never lost. `stage_attachments` remains for the batch-export zip
   bundler, which still copies the files alongside the converted output.
   Built-in HTML keeps `<img>` plus a vault-relative note; the browser
   preview has no vault access and leaves refs as-is.

## Publish scope

`publish_static_site` (Rust only — the TS twin was deleted) emits ONE
`index.html`: pulldown-cmark bodies sanitized with ammonia, locked docs
excluded, images inlined as data URIs (2 MB/file cap, skipped files
counted in the result), user `customCss`/`customJs` included with
`</style`/`</script` breakouts neutralized. Per-page output is
explicitly out of scope: single-file site only.
