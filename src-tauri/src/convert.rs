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
pub fn find_pandoc(resource_dir: Option<PathBuf>) -> Option<PathBuf> {
    if let Some(dir) = resource_dir {
        #[cfg(windows)]
        let candidate = dir.join("binaries").join("pandoc.exe");
        #[cfg(not(windows))]
        let candidate = dir.join("binaries").join("pandoc");
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    match Command::new("pandoc").arg("--version").output() {
        Ok(o) if o.status.success() => Some(PathBuf::from("pandoc")),
        _ => None,
    }
}

fn pandoc_convert(pandoc: &PathBuf, markdown: &str, out_fmt: &str) -> Result<Vec<u8>, String> {
    let dir = tempfile::tempdir().map_err(|e| format!("Temp dir failed: {}", e))?;
    let input_path = dir.path().join("input.md");
    let output_path = dir.path().join(format!("output.{}", out_fmt));
    std::fs::write(&input_path, markdown).map_err(|e| format!("Temp write failed: {}", e))?;
    let output = Command::new(pandoc)
        .arg("-f")
        .arg("markdown")
        .arg("-t")
        .arg(out_fmt)
        .arg("-o")
        .arg(&output_path)
        .arg(&input_path)
        .output()
        .map_err(|e| format!("Failed to run pandoc: {}. See docs/EXPORT.md.", e))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pandoc failed ({}). {}", out_fmt, stderr.trim()));
    }
    std::fs::read(&output_path).map_err(|e| format!("Failed to read pandoc output: {}", e))
}

/// Convert one markdown source into the requested format.
pub fn convert_markdown(
    title: &str,
    markdown: &str,
    out_fmt: &str,
    pandoc: Option<PathBuf>,
) -> Result<ConvertOutput, String> {
    let slug = slugify(title);
    let (bytes, ext) = match out_fmt {
        "md" => (markdown.as_bytes().to_vec(), "md"),
        "txt" => (markdown_to_text(markdown).into_bytes(), "txt"),
        "html" => (markdown_to_html_doc(title, markdown).into_bytes(), "html"),
        "docx" | "epub" | "pdf" => {
            let bin = pandoc.ok_or_else(|| {
                format!(
                    "The .{} format needs pandoc, which was not found. See docs/EXPORT.md.",
                    out_fmt
                )
            })?;
            (pandoc_convert(&bin, markdown, out_fmt)?, out_fmt)
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
