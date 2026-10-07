//! PDF writer: `Doc` → typeset PDF via the Typst CLI, in a subprocess.
//!
//! Typst is a real typesetting engine (the LaTeX successor), so the output
//! has proper page breaks, running headers and page numbers — things a
//! browser print path cannot do. It also replaces Pandoc's PDF path, which
//! never worked without a separate LaTeX install alongside it.
//!
//! # Why a subprocess
//!
//! The `typst` Rust crate would compile in a full WASM runtime (`wasmi`)
//! and two SVG rasterisers (`usvg`/`resvg`) that a prose exporter never
//! calls — 13 GB of build for ~25 MB. The prebuilt CLI is 21.4 MB and does
//! the same job. It is bundled via Tauri `externalBin` (see
//! `tauri.conf.json`) and fetched, not committed (`fetch_sidecars.py`).
//!
//! # Escaping
//!
//! Typst's markup treats `* _ $ # @ < > \ ~` and `-` sequences as syntax.
//! Every character that reaches the generated source goes through
//! `escape_text`, so prose containing markup characters survives verbatim.
//! `typst_metacharacters_survive_compilation` locks that down against a real
//! compile, not just a string comparison.

use crate::docmodel::{Block, Doc, Span};
use std::path::{Path, PathBuf};
use std::process::Command;

/// Pinned Typst version. The bundled CLI must match this: Typst markup
/// semantics are not frozen across releases, and a floating "latest" would
/// silently change output. Kept in sync with `fetch_sidecars.py`.
pub const TYPST_VERSION: &str = "0.15.1";

/// Font the template pins explicitly. The CLI also reads system fonts, so
/// naming one keeps output identical on every machine.
const FONT: &str = "Libertinus Serif";

/// Escape text for Typst markup.
///
/// `#` and `$` enter code/math mode, `*`/`_` are emphasis, `@` is a
/// reference, `<`/`>` are labels, `~` is a non-breaking space, and
/// repeated `-` forms en/em dashes — so a lone `-` is escaped as well.
fn escape_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '\\' | '*' | '_' | '$' | '#' | '@' | '<' | '>' | '~' => {
                out.push('\\');
                out.push(c);
            }
            '-' => out.push_str("\\-"),
            other => out.push(other),
        }
    }
    out
}

/// Escape for a Typst string literal inside a code expression.
fn escape_typst_string(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            other => out.push(other),
        }
    }
    out
}

fn spans_to_typst(spans: &[Span]) -> String {
    let mut out = String::new();
    for s in spans {
        match s {
            Span::Text(t) => out.push_str(&escape_text(t)),
            Span::Code(t) => {
                out.push_str(&format!("#raw(\"{}\")", escape_typst_string(t)))
            }
            Span::Strong(v) => out.push_str(&format!("*{}*", spans_to_typst(v))),
            Span::Emph(v) => out.push_str(&format!("_{}_", spans_to_typst(v))),
            Span::Strike(v) => out.push_str(&format!("#strike[{}]", spans_to_typst(v))),
            Span::Link { spans, href } => out.push_str(&format!(
                "#link(\"{}\")[{}]",
                escape_typst_string(href),
                spans_to_typst(spans)
            )),
            Span::Image { alt, src } => {
                // A bare path that does not resolve aborts the compile, so
                // emit the alt text instead of a broken image reference.
                let label = if alt.is_empty() { src } else { alt };
                out.push_str(&format!("#emph[{}]", escape_text(label)));
            }
            Span::SoftBreak => out.push(' '),
            // In markup a trailing backslash is a hard line break.
            Span::HardBreak => out.push_str(" \\\n"),
        }
    }
    out
}

/// Convert a parsed document's blocks into Typst body markup.
fn blocks_to_typst(blocks: &[Block], out: &mut String, skip_first_h1: bool) {
    let mut skipped = !skip_first_h1;
    for b in blocks {
        match b {
            Block::Heading { level, spans } if *level == 1 && !skipped => skipped = true,
            Block::Heading { level, spans } => {
                // H1 is the title; body headings start at `=` so the
                // template's outline levels stay correct.
                let eq = level.saturating_sub(1).max(1);
                out.push_str(&format!(
                    "{} {}\n\n",
                    "=".repeat(eq as usize),
                    spans_to_typst(spans)
                ));
            }
            Block::Paragraph(spans) => {
                out.push_str(&spans_to_typst(spans));
                out.push_str("\n\n");
            }
            Block::List { ordered, items } => {
                for (i, item) in items.iter().enumerate() {
                    let marker = if *ordered {
                        format!("{}. ", i + 1)
                    } else {
                        "- ".to_string()
                    };
                    out.push_str(&marker);
                    // First block inline; any nested blocks indented under it.
                    let mut first = true;
                    for b in item {
                        match b {
                            Block::Paragraph(spans) => {
                                if !first {
                                    out.push_str("  ");
                                }
                                out.push_str(&spans_to_typst(spans));
                                out.push('\n');
                                first = false;
                            }
                            other => {
                                let mut nested = String::new();
                                blocks_to_typst(
                                    std::slice::from_ref(other),
                                    &mut nested,
                                    false,
                                );
                                for line in nested.lines() {
                                    if line.trim().is_empty() {
                                        continue;
                                    }
                                    out.push_str("  ");
                                    out.push_str(line.trim_start());
                                    out.push('\n');
                                }
                                first = false;
                            }
                        }
                    }
                    out.push('\n');
                }
            }
            Block::Quote(inner) => {
                out.push_str("#block(inset: 12pt)[\n");
                blocks_to_typst(inner, out, false);
                out.push_str("]\n\n");
            }
            Block::Code { text, .. } => {
                out.push_str(&format!(
                    "#raw(\"{}\", block: true)\n\n",
                    escape_typst_string(text)
                ));
            }
            Block::Rule => out.push_str("#line(length: 100%, stroke: 0.5pt)\n\n"),
        }
    }
}

/// Body markup only (no template). Exposed for tests.
pub fn to_typst(doc: &Doc) -> String {
    let mut out = String::new();
    blocks_to_typst(&doc.blocks, &mut out, true);
    out
}

/// The book template: title page, running header, page numbers.
///
/// `#set page(header: ...)` prints the current heading and page number —
/// the running header CSS cannot produce.
fn template(doc: &Doc, body: &str) -> String {
    let mut out = String::from("// Generated by just-write-ehis.\n");
    out.push_str("#set document(title: \"");
    out.push_str(&escape_typst_string(&doc.title));
    out.push('"');
    if let Some(a) = &doc.author {
        out.push_str(", author: \"");
        out.push_str(&escape_typst_string(a));
        out.push('"');
    }
    out.push_str(")\n#set page(\n  paper: \"a4\",\n  margin: (x: 2.5cm, y: 2.5cm),\n");
    out.push_str("  header: context {\n    if counter(page).get().first() > 1 [\n");
    out.push_str("      set text(size: 9pt, fill: luma(120))\n      grid(\n");
    out.push_str(
        "        columns: (1fr, auto),\n        align: (left + horizon, right + horizon),\n",
    );
    out.push_str(
        "        text(counter(heading).display()),\n        [#counter(page).display(\"1\")],\n      )\n    ]\n  },\n",
    );
    out.push_str(
        "  footer: context {\n    if counter(page).get().first() > 1 [\n      align(center, text(size: 9pt, fill: luma(120))[#counter(page).display(\"1\")])\n    ]\n  },\n)\n",
    );
    out.push_str(&format!(
        "#set text(font: \"{}\", size: 11pt, lang: \"en\")\n",
        FONT
    ));
    out.push_str("#set par(justify: true, leading: 0.65em)\n");
    out.push_str("#set heading(numbering: none)\n\n");
    out.push_str("#align(center)[\n  #text(size: 28pt, weight: \"bold\")[");
    out.push_str(&escape_text(&doc.title));
    out.push_str("]\n");
    if let Some(a) = &doc.author {
        out.push_str("  #v(1em)\n  #text(size: 14pt)[");
        out.push_str(&escape_text(a));
        out.push_str("]\n");
    }
    if let Some(d) = &doc.date {
        out.push_str("  #v(0.5em)\n  #text(size: 11pt, fill: luma(120))[");
        out.push_str(&escape_text(d));
        out.push_str("]\n");
    }
    out.push_str("]\n#pagebreak()\n\n");
    out.push_str(body);
    out
}

/// Locate the bundled Typst binary.
///
/// Tauri renames `externalBin` entries with the target triple, so the file
/// may be `typst.exe` or `typst-<triple>.exe`. A `typst` already on `PATH`
/// is a last resort — the bundled copy is preferred so output matches the
/// pinned version.
pub fn find_typst(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = &resource_dir {
        let bin = dir.join("binaries");
        let exact = bin.join(if cfg!(windows) { "typst.exe" } else { "typst" });
        if exact.is_file() {
            return Some(exact);
        }
        if let Ok(entries) = std::fs::read_dir(&bin) {
            let mut hits: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|x| x.path()))
                .filter(|p| {
                    p.is_file()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| {
                                if cfg!(windows) {
                                    n.starts_with("typst") && n.ends_with(".exe")
                                } else {
                                    n.starts_with("typst") && !n.contains('.')
                                }
                            })
                            .unwrap_or(false)
                })
                .collect();
            hits.sort();
            if let Some(first) = hits.into_iter().next() {
                return Some(first);
            }
        }
    }
    // Dev fallback: a typst on PATH. Warn-worthy in production, but it
    // keeps `cargo test` and local runs working before the fetch step.
    if Command::new("typst").arg("--version").output().is_ok() {
        return Some(PathBuf::from("typst"));
    }
    None
}

/// True when a usable Typst binary exists (bundled or on `PATH`).
pub fn typst_available(resource_dir: Option<PathBuf>) -> bool {
    find_typst(resource_dir).is_some()
}

/// Run Typst over `source` and return the PDF bytes.
///
/// Errors carry the CLI's own stderr, so a bad document reports the same
/// message an author would see from the command line.
/// Hard limit on a single typst compile. convert_run/compile_run are sync
    /// commands, so this runs on the UI thread — an unbounded wait here freezes
    /// the whole app with no way out.
    const TYPST_TIMEOUT_SECS: u64 = 120;

    /// Run typst over `source` and return the PDF bytes.
    ///
    /// Spawns the child and polls with a hard timeout, so a hung compile is
    /// killed and reported instead of blocking the UI thread forever.
    fn compile_with(bin: &Path, source: &str) -> Result<Vec<u8>, String> {
        use std::time::Instant;
        let dir = tempfile::tempdir().map_err(|e| format!("Temp dir failed: {}", e))?;
        let input = dir.path().join("input.typ");
        let output = dir.path().join("output.pdf");
        std::fs::write(&input, source).map_err(|e| format!("Temp write failed: {}", e))?;

        let mut child = Command::new(bin)
            .arg("compile")
            // Root is the temp dir so no document-relative path can reach the
            // vault or the wider filesystem.
            .arg("--root")
            .arg(dir.path())
            .arg(&input)
            .arg(&output)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run typst: {}", e))?;

        let start = Instant::now();
        let timeout = std::time::Duration::from_secs(TYPST_TIMEOUT_SECS);
        loop {
            match child.try_wait() {
                Ok(Some(status)) => {
                    if !status.success() {
                        let stderr = child
                            .stderr
                            .take()
                            .map(|mut s| {
                                let mut buf = String::new();
                                use std::io::Read;
                                let _ = s.read_to_string(&mut buf);
                                buf
                            })
                            .unwrap_or_default();
                        let msg = stderr.trim();
                        return Err(if msg.is_empty() {
                            format!("typst failed (exit {:?}).", status.code())
                        } else {
                            format!("typst failed: {}", msg)
                        });
                    }
                    return std::fs::read(&output)
                        .map_err(|e| format!("Failed to read typst output: {}", e));
                }
                Ok(None) => {
                    if start.elapsed() > timeout {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(format!(
                            "typst compile timed out after {}s — the document may be too large or the binary is hung",
                            TYPST_TIMEOUT_SECS
                        ));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(100));
                }
                Err(e) => return Err(format!("Failed to wait on typst: {}", e)),
            }
        }
    }

/// Compile a `Doc` to PDF bytes.
///
/// Returns a human-readable error rather than panicking: a document that
/// fails to typeset must surface as a failed export, not a crashed app.
pub fn write(doc: &Doc, bin: &Path) -> Result<Vec<u8>, String> {
    compile_with(bin, &template(doc, &to_typst(doc)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docmodel::parse;

    /// A real PDF starts with the %PDF- header and ends with the %%EOF marker.
/// The trailer sits at the END of the file, so it must be searched from the
/// back, not in a fixed window from the front.
fn is_pdf(b: &[u8]) -> bool {
    if !b.starts_with(b"%PDF-") {
        return false;
    }
    let tail = &b[b.len().saturating_sub(1024)..];
    tail.windows(5).any(|w| w == b"%%EOF")
}

    /// The pinned binary, or None when the fetch step has not run. Tests
    /// that need a real compile skip rather than fail so the suite still
    /// runs on a fresh clone.
    fn typst_bin() -> Option<PathBuf> {
        find_typst(Some(PathBuf::from(env!("CARGO_MANIFEST_DIR"))))
    }

    macro_rules! require_typst {
        () => {
            match typst_bin() {
                Some(b) => b,
                None => {
                    eprintln!("skipping: typst binary not fetched");
                    return;
                }
            }
        };
    }

    #[test]
    fn produces_a_real_pdf() {
        let bin = require_typst!();
        let bytes = write(&parse("Book", "# One\n\nHello world."), &bin).unwrap();
        assert!(
            is_pdf(&bytes),
            "not a PDF: {:?}",
            &bytes[..8.min(bytes.len())]
        );
        assert!(bytes.len() > 500, "suspiciously small PDF: {} bytes", bytes.len());
    }

    #[test]
    fn multi_page_document_compiles() {
        let bin = require_typst!();
        let long = (0..200)
            .map(|i| format!("Paragraph number {i} with enough words to fill a line of text."))
            .collect::<Vec<_>>()
            .join("\n\n");
        let bytes = write(&parse("Long", &long), &bin).unwrap();
        assert!(is_pdf(&bytes));
        assert!(bytes.len() > 2000, "expected a multi-page PDF");
    }

    #[test]
    fn typst_metacharacters_survive_compilation() {
        // The highest-risk part of this writer: prose that looks like Typst
        // markup must not silently lose characters or abort the compile.
        let bin = require_typst!();
        let tricky =
            "Costs $5 and 3 < 5 and 6 > 2, a @ref, #hash, *stars*, _under_, ~tilde~ and a-b.";
        let bytes = write(&parse("Meta", tricky), &bin).unwrap();
        assert!(is_pdf(&bytes));
    }

    #[test]
    fn escaping_is_total_for_every_markup_character() {
        assert_eq!(escape_text("#"), "\\#");
        assert_eq!(escape_text("$"), "\\$");
        assert_eq!(escape_text("*"), "\\*");
        assert_eq!(escape_text("_"), "\\_");
        assert_eq!(escape_text("@"), "\\@");
        assert_eq!(escape_text("<"), "\\<");
        assert_eq!(escape_text(">"), "\\>");
        assert_eq!(escape_text("~"), "\\~");
        assert_eq!(escape_text("\\"), "\\\\");
        // A dash would otherwise combine into an en/em dash.
        assert_eq!(escape_text("a-b"), "a\\-b");
        // Ordinary prose is untouched.
        assert_eq!(escape_text("plain text 123"), "plain text 123");
    }

    #[test]
    fn backslash_escaped_literals_round_trip() {
        let bin = require_typst!();
        // A literal `\*stars\*` in the source must survive as text.
        let bytes = write(&parse("Esc", "literal \\*stars\\* here"), &bin).unwrap();
        assert!(is_pdf(&bytes));
    }

    #[test]
    fn empty_document_still_compiles() {
        let bin = require_typst!();
        let bytes = write(&parse("Empty", ""), &bin).unwrap();
        assert!(is_pdf(&bytes));
    }

    #[test]
    fn compile_error_is_reported_not_panicked() {
        let bin = require_typst!();
        // Deliberately invalid Typst must produce Err, not panic.
        let bad = compile_with(&bin, "#raw(\"unterminated\n\n= broken heading");
        assert!(bad.is_err(), "invalid source must not compile");
        let msg = bad.unwrap_err();
        assert!(msg.contains("typst failed"), "{msg}");
    }

    #[test]
    fn template_carries_title_author_and_date() {
        let doc = parse("X", "---\ntitle: \"T\"\nauthor: \"A\"\ndate: \"2026\"\n---\n\nbody");
        let src = template(&doc, "");
        assert!(src.contains("title: \"T\""), "{src}");
        assert!(src.contains("author: \"A\""), "{src}");
        // Running header + page numbers are the reason Typst is used here.
        assert!(src.contains("header: context"), "no running header");
        assert!(src.contains("counter(page).display"), "no page numbers");
    }

    #[test]
    fn template_pins_the_font() {
        // Without an explicit font the CLI would use whatever the host has
        // installed, making output machine-dependent.
        let doc = parse("X", "body");
        let src = template(&doc, "");
        assert!(src.contains(&format!("font: \"{}\"", FONT)), "{src}");
    }

    #[test]
    fn title_with_quotes_does_not_break_the_source() {
        let doc = parse("X", "---\ntitle: \"He said \\\"hi\\\" loudly\"\n---\n\nbody");
        let src = template(&doc, "");
        assert!(src.contains("\\\""), "quote not escaped: {src}");
    }

    #[test]
    fn body_markup_uses_typst_constructs() {
        let doc = parse(
            "B",
            "## Section\n\n**bold** and *em*\n\n- item\n\n> quote\n\n```\ncode\n```",
        );
        let src = to_typst(&doc);
        assert!(src.contains("= Section"), "{src}");
        assert!(src.contains("*bold*"), "{src}");
        assert!(src.contains("_em_"), "{src}");
        assert!(src.contains("- item"), "{src}");
        assert!(src.contains("#block("), "quote: {src}");
        assert!(src.contains("#raw("), "code: {src}");
    }

    #[test]
    fn nested_list_items_indent_under_their_marker() {
        let doc = parse("B", "- outer\n  - inner\n- second");
        let src = to_typst(&doc);
        assert!(src.contains("- outer"), "{src}");
        assert!(src.contains("  - inner"), "nested item not indented: {src}");
    }

    #[test]
    fn links_use_typst_link() {
        let doc = parse("B", "[text](https://example.com/a?b=1&c=2)");
        let src = to_typst(&doc);
        assert!(src.contains("#link("), "{src}");
    }

    #[test]
    fn pinned_version_is_a_real_release() {
        // Guards against a typo shipping an unsatisfiable fetch URL.
        assert_eq!(TYPST_VERSION, "0.15.1");
        assert!(!TYPST_VERSION.contains(' '));
    }
}