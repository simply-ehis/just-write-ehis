//! Document conversion: manuscript/doc → md, txt, html (built in) or
//! docx, epub, pdf (via pandoc when available).
//!
//! Built-in formats always work, including offline. Pandoc formats resolve
//! `pandoc` from a bundled sidecar first, then `PATH`, and fail with install
//! guidance (see docs/EXPORT.md) when neither exists.

use serde::Serialize;
use std::path::PathBuf;
use std::process::Command;

#[derive(Serialize)]
pub struct ConvertOutput {
    pub filename: String,
    pub mime: String,
    pub base64: String,
}

#[derive(Serialize)]
pub struct ConvertStatus {
    pub pandoc: bool,
    /// True when pandoc resolved from the bundled sidecar (vs PATH).
    /// Lets menus/setup say "bundled" instead of a generic present/absent.
    pub bundled: bool,
    pub formats: Vec<String>,
}

const PANDOC_FORMATS: [&str; 3] = ["docx", "epub", "pdf"];

pub fn builtin_formats() -> Vec<String> {
    vec!["md".into(), "txt".into(), "html".into()]
}

pub fn all_formats(pandoc: bool) -> Vec<String> {
    let mut fmts = builtin_formats();
    if pandoc {
        fmts.extend(PANDOC_FORMATS.iter().map(|s| s.to_string()));
    }
    fmts
}

/// True when a pandoc path is the bundled sidecar (`…/binaries/pandoc`)
/// vs a bare `pandoc` resolved from PATH.
pub fn is_bundled(pandoc: &Option<PathBuf>) -> bool {
    match pandoc {
        Some(p) => p
            .parent()
            .and_then(|d| d.file_name())
            .map(|n| n == "binaries")
            .unwrap_or(false),
        None => false,
    }
}

pub fn slugify(title: &str) -> String {
    let slug: String = title
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect::<String>()
        .split('-')
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if slug.is_empty() {
        "untitled".into()
    } else {
        slug
    }
}

fn mime_for(fmt: &str) -> &'static str {
    match fmt {
        "md" => "text/markdown",
        "txt" => "text/plain",
        "html" => "text/html",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "epub" => "application/epub+zip",
        "pdf" => "application/pdf",
        _ => "application/octet-stream",
    }
}

/// Best-effort markdown → plain text: strip the most common syntax,
/// keep the words and line breaks.
pub fn markdown_to_text(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    for line in md.lines() {
        let mut l = line.trim_start_matches(['#', '>', ' ', '\t']);
        if let Some(rest) = l.strip_prefix("- [ ]") {
            l = rest.trim_start();
        } else if let Some(rest) = l.strip_prefix("- [x]") {
            l = rest.trim_start();
        } else if let Some(rest) = l.strip_prefix("- ") {
            l = rest;
        } else if l.len() > 2 && l.as_bytes()[0].is_ascii_digit() && l[1..].starts_with(". ") {
            l = l[1..].trim_start_matches(". ").trim_start();
        }
        // Inline spans: **b**, *i*, `code`, [text](url), ![alt](src)
        let mut s = l.to_string();
        for marker in ["**", "__"] {
            s = s.replace(marker, "");
        }
        s = strip_inline(&s, '*');
        s = strip_inline(&s, '`');
        s = strip_links(&s);
        if s.trim() == "---" || s.trim() == "***" {
            continue;
        }
        out.push_str(&s);
        out.push('\n');
    }
    out
}

fn strip_inline(s: &str, marker: char) -> String {
    let parts: Vec<&str> = s.split(marker).collect();
    if parts.len() <= 1 {
        return s.to_string();
    }
    parts.concat()
}

fn strip_links(s: &str) -> String {
    // [text](url) → text ; ![alt](src) → alt (char-based: safe for UTF-8)
    let chars: Vec<char> = s.chars().collect();
    let mut out = String::with_capacity(s.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '!' && i + 1 < chars.len() && chars[i + 1] == '[' {
            i += 1;
        }
        if chars[i] == '[' {
            if let Some(close) = chars[i..].iter().position(|&c| c == ']') {
                let after = i + close + 1;
                let text: String = chars[i + 1..i + close].iter().collect();
                // Skip a trailing (url) target if present.
                if after < chars.len() && chars[after] == '(' {
                    if let Some(end) = chars[after..].iter().position(|&c| c == ')') {
                        out.push_str(&text);
                        i = after + end + 1;
                        continue;
                    }
                }
                out.push_str(&text);
                i = after;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

pub fn markdown_to_html_doc(title: &str, md: &str) -> String {
    use pulldown_cmark::{html, Parser};
    let parser = Parser::new(md);
    let mut body_raw = String::new();
    html::push_html(&mut body_raw, parser);
    // pulldown-cmark passes raw inline HTML through: sanitize the body.
    let body = ammonia::clean(&body_raw);
    format!(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>{}</title>\n<style>body{{font-family:Georgia,serif;max-width:700px;margin:40px auto;padding:20px;line-height:1.8;color:#333}}\nh1,h2,h3{{margin-top:2em}}pre{{background:#f5f5f5;padding:12px;overflow-x:auto}}</style>\n</head><body>{}</body></html>",
        html_escape(title),
        body
    )
}

fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// Locate pandoc: bundled sidecar beside the resources first, then PATH.
/// The bundled file carries its target triple per the Tauri externalBin
/// recipe (`binaries/pandoc-x86_64-pc-windows-msvc.exe`), so scan for the
/// `pandoc*` prefix — not just the bare `pandoc.exe` name.
pub fn find_pandoc(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        let bindir = dir.join("binaries");
        #[cfg(windows)]
        let exact = bindir.join("pandoc.exe");
        #[cfg(not(windows))]
        let exact = bindir.join("pandoc");
        if exact.is_file() {
            return Some(exact);
        }
        if let Ok(entries) = std::fs::read_dir(&bindir) {
            let mut hits: Vec<PathBuf> = entries
                .filter_map(|e| e.ok().map(|x| x.path()))
                .filter(|p| {
                    p.is_file()
                        && p.file_name()
                            .and_then(|n| n.to_str())
                            .map(|n| {
                                #[cfg(windows)]
                                {
                                    n.starts_with("pandoc-") && n.ends_with(".exe")
                                }
                                #[cfg(not(windows))]
                                {
                                    n.starts_with("pandoc-") && !n.contains('.')
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
    match Command::new("pandoc").arg("--version").output() {
        Ok(o) if o.status.success() => Some(PathBuf::from("pandoc")),
        _ => None,
    }
}

fn pandoc_convert(
    pandoc: &PathBuf,
    workdir: &std::path::Path,
    out_fmt: &str,
) -> Result<Vec<u8>, String> {
    // workdir holds input.md + staged attachments; it doubles as
    // --resource-path so image refs resolve inside the sandbox.
    let output_path = workdir.join(format!("output.{}", out_fmt));
    let output = Command::new(pandoc)
        .arg("-f")
        .arg("markdown")
        .arg("-t")
        .arg(out_fmt)
        .arg("--resource-path")
        .arg(workdir)
        .arg("-o")
        .arg(&output_path)
        .arg(workdir.join("input.md"))
        .output()
        .map_err(|e| format!("Failed to run pandoc: {}. See docs/EXPORT.md.", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pandoc failed ({}). {}", out_fmt, stderr.trim()));
    }
    std::fs::read(&output_path).map_err(|e| format!("Failed to read pandoc output: {}", e))
}

/// Whole-manuscript RAM bound for compile_run: refuse past this many
/// source characters with a clear error (suggest zip-of-chapters) rather
/// than OOMing on a giant vault. ~5M chars ≈ 800k words.
pub const COMPILE_CHAR_CAP: usize = 5_000_000;

/// Frontmatter fields honored on export (title/author/date first).
#[derive(Default)]
pub struct ExportFrontmatter {
    pub title: Option<String>,
    pub author: Option<String>,
    pub date: Option<String>,
    pub extra: Vec<(String, String)>,
}

/// Parse a frontmatter_json blob into export fields. Unknown/complex
/// values ride along as plain strings; garbage JSON means no block.
pub fn parse_frontmatter(json: Option<&str>) -> ExportFrontmatter {
    let mut fm = ExportFrontmatter::default();
    let raw = match json {
        Some(s) if !s.trim().is_empty() => s,
        _ => return fm,
    };
    let v: serde_json::Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return fm,
    };
    let obj = match v.as_object() {
        Some(o) => o,
        None => return fm,
    };
    let str_val = |k: &str| obj.get(k).and_then(|v| v.as_str()).map(String::from);
    fm.title = str_val("title");
    fm.author = str_val("author");
    fm.date = str_val("date").or_else(|| str_val("deadline"));
    for (k, v) in obj {
        if k == "title" || k == "author" || k == "date" || k == "deadline" {
            continue;
        }
        let s = match v {
            serde_json::Value::String(s) => s.clone(),
            serde_json::Value::Number(n) => n.to_string(),
            serde_json::Value::Bool(b) => b.to_string(),
            _ => continue,
        };
        // Keep the YAML block one-line-safe.
        if !s.contains('\n') {
            fm.extra.push((k.clone(), s));
        }
    }
    fm
}

/// Prepend a YAML block (+ pandoc --metadata title/author/date when
/// present). Empty frontmatter = byte-identical passthrough.
pub fn inject_frontmatter(md: &str, fm: &ExportFrontmatter) -> String {
    let mut lines: Vec<String> = Vec::new();
    if let Some(t) = &fm.title {
        lines.push(format!("title: \"{}\"", t.replace('"', "'")));
    }
    if let Some(a) = &fm.author {
        lines.push(format!("author: \"{}\"", a.replace('"', "'")));
    }
    if let Some(d) = &fm.date {
        lines.push(format!("date: \"{}\"", d.replace('"', "'")));
    }
    for (k, v) in &fm.extra {
        lines.push(format!("{}: \"{}\"", k, v.replace('"', "'")));
    }
    if lines.is_empty() {
        return md.to_string();
    }
    format!("---\n{}\n---\n\n{}", lines.join("\n"), md)
}

/// Resolve `[[wikilinks]]` to display text (`[[a|b]]` → `b`, `[[a]]` →
/// `a`). Documented choice: exports are standalone files, so links become
/// plain display text rather than dead vault paths.
pub fn resolve_wikilinks(md: &str) -> String {
    let mut out = String::with_capacity(md.len());
    let chars: Vec<char> = md.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '!' && i + 2 < chars.len() && chars[i + 1] == '[' && chars[i + 2] == '[' {
            // An embed — inline_embeds handles it; leave the marker.
            out.push(chars[i]);
            i += 1;
            continue;
        }
        if chars[i] == '[' && i + 1 < chars.len() && chars[i + 1] == '[' {
            if let Some(end) = chars[i..].iter().position(|&c| c == ']') {
                let j = i + end;
                if j + 1 < chars.len() && chars[j + 1] == ']' {
                    let inner: String = chars[i + 2..i + end].iter().collect();
                    let display = inner.split('|').last().unwrap_or(&inner);
                    // Skip image-style `![..](..)` — the leading `!` check
                    // above already guarded embeds, plain images stay raw.
                    out.push_str(display);
                    i = j + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Inline `![[embeds]]` as rendered markdown via `load` (title → body).
/// Missing/locked targets become a one-line note — never silent, never
/// a leak. Depth-1 only (embedded bodies are inlined raw, unexpanded).
pub fn inline_embeds(md: &str, load: &dyn Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(md.len());
    let chars: Vec<char> = md.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '!' && i + 2 < chars.len() && chars[i + 1] == '[' && chars[i + 2] == '[' {
            let mut j = i + 3;
            while j + 1 < chars.len() && !(chars[j] == ']' && chars[j + 1] == ']') {
                j += 1;
            }
            if j + 1 < chars.len() {
                let target: String = chars[i + 3..j].iter().collect();
                let target = target.trim();
                match load(target) {
                    Some(body) => {
                        out.push('\n');
                        out.push_str(&body);
                        out.push('\n');
                    }
                    None => {
                        out.push_str(&format!("\n> [embed missing: {}]\n", target.replace(['[', ']'], "")));
                    }
                }
                i = j + 2;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Demote headings one level (H1→H2 … H5→H6, H6 stays) so compiled
/// chapters sit under the per-doc H1 title without collisions.
pub fn demote_headings(md: &str) -> String {
    md.lines()
        .map(|line| {
            let hashes = line.chars().take_while(|&c| c == '#').count();
            if hashes >= 1 && hashes <= 6 && line[hashes..].starts_with([' ', '\t']) {
                let level = hashes.min(5) + 1;
                format!("{} {}", "#".repeat(level), line[hashes..].trim_start())
            } else {
                line.to_string()
            }
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Join compiled docs: `# Title` header + demoted body each.
/// Titles can never collide with content because content H1s are gone.
pub fn join_manuscript(docs: &[(&str, &str)]) -> String {
    docs.iter()
        .map(|(title, content)| format!("# {}\n\n{}", title, demote_headings(content)))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n")
}

/// Find `.attachments/` refs in markdown (`](.attachments/x)` and
/// `](<.attachments/x>)`). Returns the ref strings as written.
pub fn attachment_refs(md: &str) -> Vec<String> {
    let mut refs = Vec::new();
    let mut search = md;
    while let Some(pos) = search.find(".attachments/") {
        let rest = &search[pos..];
        let end = rest
            .find(|c: char| c.is_whitespace() || c == ')' || c == '"' || c == '\'')
            .unwrap_or(rest.len());
        let r = &rest[..end];
        // `..` can never be a legit attachment ref — skip, don't resolve.
        // `end` is always ≥ ".attachments/".len(), so this always advances.
        if !r.contains("..") && !refs.iter().any(|x: &String| x == r) {
            refs.push(r.to_string());
        }
        search = &rest[end..];
    }
    refs
}

/// Full export prep shared by convert_run + compile_run: embeds inlined,
/// wikilinks resolved to display text, frontmatter injected. `lookup`
/// maps an embed/wikilink title to raw markdown (None = missing/locked).
pub fn prepare_export(
    title: &str,
    content: &str,
    frontmatter_json: Option<&str>,
    lookup: &dyn Fn(&str) -> Option<String>,
) -> String {
    let with_embeds = inline_embeds(content, lookup);
    let resolved = resolve_wikilinks(&with_embeds);
    let fm = parse_frontmatter(frontmatter_json);
    let mut fm = fm;
    if fm.title.is_none() {
        fm.title = Some(title.to_string());
    }
    inject_frontmatter(&resolved, &fm)
}

/// Copy `.attachments/` refs from the vault into `tempdir` and rewrite
/// refs to bare basenames. Returns the rewritten markdown. Refs with
/// `..` were already filtered by attachment_refs; double-check here and
/// skip missing files loudly (warn string in place, never silent drop).
pub fn stage_attachments(
    md: &str,
    vault: &std::path::Path,
    tempdir: &std::path::Path,
) -> (String, Vec<String>) {
    let mut out = md.to_string();
    let mut staged = Vec::new();
    for r in attachment_refs(md) {
        if r.contains("..") {
            continue;
        }
        let src = vault.join(&r);
        let name = match src.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        match std::fs::read(&src) {
            Ok(bytes) => {
                if std::fs::write(tempdir.join(&name), &bytes).is_ok() {
                    out = out.replace(&r, &name);
                    staged.push(name);
                }
            }
            Err(e) => {
                out = out.replace(
                    &r,
                    &format!("{} (attachment missing: {})", r, e),
                );
            }
        }
    }
    (out, staged)
}

/// Convert one markdown source into the requested format.
/// `vault` enables attachment staging for pandoc formats (images resolve
/// via --resource-path); built-in HTML keeps <img> tags with a
/// vault-relative note appended (see stage note below).
pub fn convert_markdown(
    title: &str,
    markdown: &str,
    out_fmt: &str,
    pandoc: Option<PathBuf>,
    vault: Option<&std::path::Path>,
) -> Result<ConvertOutput, String> {
    let slug = slugify(title);
    let (bytes, ext) = match out_fmt {
        "md" => (markdown.as_bytes().to_vec(), "md"),
        "txt" => (markdown_to_text(markdown).into_bytes(), "txt"),
        "html" => {
            let mut body_md = markdown.to_string();
            if !attachment_refs(markdown).is_empty() {
                body_md.push_str("\n\n*Images reference vault-relative `.attachments/` paths.*");
            }
            (markdown_to_html_doc(title, &body_md).into_bytes(), "html")
        }
        "docx" | "epub" | "pdf" => {
            let bin = pandoc.ok_or_else(|| {
                format!(
                    "The .{} format needs pandoc, which was not found. See docs/EXPORT.md.",
                    out_fmt
                )
            })?;
            let dir = tempfile::tempdir().map_err(|e| format!("Temp dir failed: {}", e))?;
            let (staged, _) = match vault {
                Some(v) => stage_attachments(markdown, v, dir.path()),
                None => (markdown.to_string(), Vec::new()),
            };
            std::fs::write(dir.path().join("input.md"), &staged)
                .map_err(|e| format!("Temp write failed: {}", e))?;
            (pandoc_convert(&bin, dir.path(), out_fmt)?, out_fmt)
        }
        other => return Err(format!("Unsupported export format: {}", other)),
    };
    Ok(ConvertOutput {
        filename: format!("{}.{}", slug, ext),
        mime: mime_for(out_fmt).into(),
        base64: base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            &bytes,
        ),
    })
}

#[cfg(test)]
mod convert_tests {
    use super::*;

    #[test]
    fn join_demotes_content_headings() {
        let out = join_manuscript(&[("Ch 1", "# Old Title\n\nBody"), ("Ch 2", "### Deep\n\nMore")]);
        assert!(out.contains("# Ch 1"));
        // Content H1 demoted so it can never collide with the doc title.
        assert!(!out.contains("# Old Title\n") || out.contains("## Old Title"));
        assert!(out.contains("## Old Title"));
        assert!(out.contains("#### Deep"));
        // HR separators between docs.
        assert!(out.contains("---"));
    }

    #[test]
    fn slugify_filenames() {
        assert_eq!(slugify("Hello, World!"), "hello-world");
        assert_eq!(slugify("   "), "untitled");
        assert_eq!(slugify("Novel 1: Beginnings"), "novel-1-beginnings");
    }

    #[test]
    fn frontmatter_injection() {
        let fm = parse_frontmatter(Some(r#"{"title":"T","author":"A","tags":["x"]}"#));
        assert_eq!(fm.title.as_deref(), Some("T"));
        let md = inject_frontmatter("Body.", &fm);
        assert!(md.starts_with("---\n"));
        assert!(md.contains("title: \"T\""));
        assert!(md.contains("author: \"A\""));
        // Array values are skipped (one-line-safe block).
        assert!(!md.contains("tags"));
        assert!(md.ends_with("Body."));
        // Garbage JSON = passthrough.
        let plain = inject_frontmatter("Body.", &parse_frontmatter(Some("{nope")));
        assert_eq!(plain, "Body.");
    }

    #[test]
    fn wikilinks_resolve_to_display_text() {
        assert_eq!(resolve_wikilinks("See [[Chapter One]] now."), "See Chapter One now.");
        assert_eq!(resolve_wikilinks("See [[ch1|first]] now."), "See first now.");
        // Images and embeds are not wikilinks.
        assert_eq!(resolve_wikilinks("![a](b.png)"), "![a](b.png)");
    }

    #[test]
    fn embeds_inline_or_note() {
        let md = "Before ![[ch1]] after.";
        let out = inline_embeds(md, &|t| if t == "ch1" { Some("TEXT".into()) } else { None });
        assert!(out.contains("TEXT"));
        assert!(!out.contains("![["));
        let missing = inline_embeds(md, &|_| None);
        assert!(missing.contains("[embed missing: ch1]"));
    }

    #[test]
    fn attachment_refs_found_and_traversal_skipped() {
        let md = "![a](.attachments/x.png) and [b](.attachments/y.pdf) and ![c](../evil.png)";
        let refs = attachment_refs(md);
        assert_eq!(refs, vec![".attachments/x.png".to_string(), ".attachments/y.pdf".to_string()]);
    }

    #[test]
    fn bundled_pandoc_detected() {
        // `src-tauri/binaries/pandoc*.exe` (release fetch, git-ignored).
        let here = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let found = find_pandoc(Some(here.clone()));
        if let Some(p) = &found {
            assert!(is_bundled(&found), "expected bundled, got {:?}", p);
        }
        assert!(!is_bundled(&None));
        assert!(!is_bundled(&Some(PathBuf::from("pandoc"))));
    }

    #[test]
    fn prepare_export_order() {
        // Embeds inline first, then wikilinks resolve (even inside embeds),
        // frontmatter last (prepended).
        let md = "See [[ch1]] and ![[note]].";
        let out = prepare_export("Doc", md, Some(r#"{"author":"Me"}"#), &|t| {
            if t == "note" {
                Some("note about [[ch1]]".into())
            } else {
                None
            }
        });
        assert!(out.starts_with("---\n"));
        assert!(out.contains("author: \"Me\""));
        assert!(out.contains("See ch1 and"));
        assert!(out.contains("note about ch1"));
        assert!(!out.contains("[["));
        assert!(!out.contains("![["));
    }
}
