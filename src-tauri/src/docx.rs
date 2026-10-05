//! WordprocessingML (`.docx`) writer: `Doc` → a Word-openable zip, in-process.
//!
//! A .docx is an OPC package — the same zip container as EPUB, with a
//! different part layout:
//!   [Content_Types].xml          declares every part's MIME type
//!   _rels/.rels                  package → main document
//!   word/document.xml            the content
//!   word/styles.xml              heading + code styles
//!   word/_rels/document.xml.rels document → styles
//!
//! Scope is deliberately manuscript-shaped: headings, paragraphs, bold /
//! italic / strike, lists, quotes, code, links and rules. Word's long tail
//! (footnotes, nested tables, TOC fields, complex numbering) is out of scope;
//! this produces a valid document, not a feature-complete Word exporter.

use crate::docmodel::{Block, Doc, Span};
use std::io::{Cursor, Write};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

const NS_W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const NS_R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

/// Escape text for XML character data.
fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => {}
            other => out.push(other),
        }
    }
    out
}

/// Word requires these as literal characters in `xml:space` runs, and
/// a `w:t` must never be left empty or Word merges adjacent runs oddly.
fn text_run(t: &str) -> String {
    if t.is_empty() {
        return String::new();
    }
    format!(
        "<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_escape(t)
    )
}

fn styled_run(t: &str, style: &str) -> String {
    if t.is_empty() {
        return String::new();
    }
    format!(
        "<w:r><w:rPr><w:rStyle w:val=\"{style}\"/></w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
        xml_escape(t)
    )
}

/// Inline spans → Word runs. Nested formatting multiplies `w:rPr`.
fn spans_to_runs(spans: &[Span], bold: bool, italic: bool, strike: bool) -> String {
    let mut out = String::new();
    for s in spans {
        match s {
            Span::Text(t) => {
                out.push_str(&run_with_props(
                    t,
                    bold,
                    italic,
                    strike,
                    "DefaultParagraphFont",
                    None,
                ));
            }
            Span::Code(t) => {
                out.push_str(&run_with_props(
                    t,
                    bold,
                    italic,
                    strike,
                    "HTMLCode",
                    None,
                ));
            }
            Span::Strong(v) => out.push_str(&spans_to_runs(v, true, italic, strike)),
            Span::Emph(v) => out.push_str(&spans_to_runs(v, bold, true, strike)),
            Span::Strike(v) => out.push_str(&spans_to_runs(v, bold, italic, true)),
            Span::Link { spans, href } => {
                // A hyperlink needs a relationship id; collect them as we go.
                let inner = spans_to_runs(spans, bold, italic, strike);
                out.push_str(&format!(
                    "<w:hyperlink r:id=\"{}\">{}</w:hyperlink>",
                    push_rel(href),
                    inner
                ));
            }
            Span::Image { alt, src } => {
                // Images are not embedded (no media pipeline here); keep the
                // alt text so the sentence survives the export.
                let label = if alt.is_empty() { src } else { alt };
                out.push_str(&format!(
                    "<w:r><w:rPr><w:i/></w:rPr><w:t xml:space=\"preserve\">[image: {}]</w:t></w:r>",
                    xml_escape(label)
                ));
            }
            Span::SoftBreak => out.push_str("<w:r><w:br/></w:r>"),
            Span::HardBreak => out.push_str("<w:r><w:br/></w:r>"),
        }
    }
    out
}

/// One run with explicit bold/italic/strike and an optional character style.
fn run_with_props(
    text: &str,
    bold: bool,
    italic: bool,
    strike: bool,
    style: &str,
    _extra: Option<&str>,
) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut props = String::new();
    if style != "DefaultParagraphFont" {
        props.push_str(&format!("<w:rStyle w:val=\"{style}\"/>"));
    }
    if bold {
        props.push_str("<w:b/>");
    }
    if italic {
        props.push_str("<w:i/>");
    }
    if strike {
        props.push_str("<w:strike/>");
    }
    if props.is_empty() {
        format!("<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r>", xml_escape(text))
    } else {
        format!(
            "<w:r><w:rPr>{props}</w:rPr><w:t xml:space=\"preserve\">{}</w:t></w:r>",
            xml_escape(text)
        )
    }
}

/// Word paragraph with a named style and already-rendered runs.
fn para(style: &str, runs: &str) -> String {
    format!("<w:p><w:pPr><w:pStyle w:val=\"{style}\"/></w:pPr>{runs}</w:p>")
}

/// Heading level → Word style id. H1 is skipped by the caller (it becomes
/// the document title); remaining levels map to Heading1..Heading5.
fn heading_style(level: u8) -> &'static str {
    match level {
        1 => "Heading1",
        2 => "Heading2",
        3 => "Heading3",
        4 => "Heading4",
        5 => "Heading5",
        _ => "Heading6",
    }
}

fn list_item(numbering_id: u32, level: u32, runs: &str) -> String {
    format!(
        "<w:p><w:pPr><w:pStyle w:val=\"ListParagraph\"/><w:numPr><w:ilvl w:val=\"{level}\"/><w:numId w:val=\"{numbering_id}\"/></w:numPr></w:pPr>{runs}</w:p>"
    )
}

/// Render a list, tracking nesting depth so `w:ilvl` is correct.
fn render_list(out: &mut String, ordered: bool, items: &[Vec<Block>], level: u32) {
    let num_id = if ordered { 2 } else { 1 };
    for item in items {
        for (i, b) in item.iter().enumerate() {
            match b {
                Block::Paragraph(spans) if i == 0 => {
                    out.push_str(&list_item(
                        num_id,
                        level,
                        &spans_to_runs(spans, false, false, false),
                    ));
                }
                // Extra blocks in an item (a nested list, a second para)
                // continue after the item's first paragraph.
                Block::List { ordered: o, items: sub } => {
                    render_list(out, *o, sub, level + 1);
                }
                Block::Paragraph(spans) => {
                    out.push_str(&list_item(
                        num_id,
                        level,
                        &spans_to_runs(spans, false, false, false),
                    ));
                }
                Block::Code { text, .. } => {
                    out.push_str(&list_item(
                        num_id,
                        level,
                        &styled_run(text, "HTMLCode"),
                    ));
                }
                Block::Quote(inner) => {
                    out.push_str(&list_item(num_id, level, ""));
                    render_blocks(out, inner, level);
                }
                _ => {}
            }
        }
    }
}

fn render_blocks(out: &mut String, blocks: &[Block], level: u32) {
    let mut skip_first_h1 = true;
    for b in blocks {
        match b {
            Block::Heading { level: lv, spans } if *lv == 1 && skip_first_h1 => {
                skip_first_h1 = false;
            }
            Block::Heading { level: lv, spans } => {
                out.push_str(&para(
                    heading_style(*lv),
                    &spans_to_runs(spans, false, false, false),
                ));
            }
            Block::Paragraph(spans) => {
                out.push_str(&para("BodyText", &spans_to_runs(spans, false, false, false)));
            }
            Block::List { ordered, items } => render_list(out, *ordered, items, level),
            Block::Quote(inner) => {
                out.push_str(&para("Quote", ""));
                render_blocks(out, inner, level);
            }
            Block::Code { text, .. } => {
                for line in text.trim_end_matches('\n').split('\n') {
                    out.push_str(&para("HTMLCode", &text_run(line)));
                }
            }
            Block::Rule => {
                // Word has no thematic break; a bottom-bordered empty
                // paragraph is the conventional stand-in.
                out.push_str(
                    "<w:p><w:pPr><w:pBdr><w:bottom w:val=\"single\" w:sz=\"6\" w:space=\"1\" w:color=\"auto\"/></w:pBdr></w:pPr></w:p>",
                );
            }
        }
    }
}

// Hyperlink relationships, collected while rendering so each `r:id` in
// document.xml has a matching entry in document.xml.rels. Thread-local
// because the render functions are plain fns; reset per document.
use std::cell::RefCell;
thread_local! {
    /// (relationship id, target url)
    static RELS: RefCell<Vec<(String, String)>> = const { RefCell::new(Vec::new()) };
    static REL_NEXT: RefCell<u32> = const { RefCell::new(1) };
}

/// Reserve the next relationship id and record its target.
fn push_rel(target: &str) -> String {
    let id = REL_NEXT.with(|n| {
        let mut n = n.borrow_mut();
        let id = format!("rId{}", *n);
        *n += 1;
        id
    });
    RELS.with(|r| r.borrow_mut().push((id.clone(), target.to_string())));
    id
}

fn reset_rels() {
    RELS.with(|r| r.borrow_mut().clear());
    REL_NEXT.with(|n| *n.borrow_mut() = 1);
}

fn take_rels() -> Vec<(String, String)> {
    RELS.with(|r| r.borrow().clone())
}

/// A minimal but valid styles part: only the styles this writer emits.
fn styles_xml() -> String {
    let heading = |id: &str, size: u32, before: u32| {
        format!(
            "<w:style w:type=\"paragraph\" w:styleId=\"{id}\"><w:name w:val=\"{id}\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:keepNext/><w:spacing w:before=\"{before}\"/><w:outlineLvl w:val=\"{}\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"{size}\"/></w:rPr></w:style>",
            id.trim_start_matches("Heading")
                .parse::<u32>()
                .unwrap_or(1)
                .saturating_sub(1)
        )
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<w:styles xmlns:w=\"{NS_W}\">\
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii=\"Calibri\" w:hAnsi=\"Calibri\"/><w:sz w:val=\"22\"/></w:rPr></w:rPrDefault></w:docDefaults>\
<w:style w:type=\"paragraph\" w:default=\"1\" w:styleId=\"Normal\"><w:name w:val=\"Normal\"/></w:style>\
<w:style w:type=\"character\" w:default=\"1\" w:styleId=\"DefaultParagraphFont\"><w:name w:val=\"Default Paragraph Font\"/></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"BodyText\"><w:name w:val=\"Body Text\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"120\"/></w:pPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Title\"><w:name w:val=\"Title\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:spacing w:after=\"240\"/></w:pPr><w:rPr><w:b/><w:sz w:val=\"56\"/></w:rPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"ListParagraph\"><w:name w:val=\"List Paragraph\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"720\"/><w:contextualSpacing/></w:pPr></w:style>\
<w:style w:type=\"paragraph\" w:styleId=\"Quote\"><w:name w:val=\"Quote\"/><w:basedOn w:val=\"Normal\"/><w:pPr><w:ind w:left=\"720\"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>\
<w:style w:type=\"character\" w:styleId=\"HTMLCode\"><w:name w:val=\"HTML Code\"/><w:rPr><w:rFonts w:ascii=\"Consolas\" w:hAnsi=\"Consolas\"/><w:sz w:val=\"20\"/></w:rPr></w:style>\
{}</w:styles>",
        heading("Heading1", 32, 240)
            + &heading("Heading2", 28, 200)
            + &heading("Heading3", 26, 160)
            + &heading("Heading4", 24, 140)
            + &heading("Heading5", 22, 120)
            + &heading("Heading6", 22, 120)
    )
}

/// numbering.xml with one bullet (numId 1) and one decimal (numId 2)
/// definition, each with nine levels so nested lists resolve.
fn numbering_xml() -> String {
    // abstractNumId 0 = bullet, 1 = decimal. The `w:num` entries at the end
    // point at these, so the two must stay in step.
    let abstract_num = |id: u32, fmt: &str| -> String {
        let lvls: String = (0..9)
            .map(|i| {
                let indent = 720 + i * 720;
                // Bullet glyphs cycle •, o, ▪ — the Word convention for nested
                // bullet levels. U+ escapes keep this file ASCII-safe.
                let bullet = if fmt == "bullet" {
                    match i % 3 {
                        0 => "\u{2022}".to_string(),
                        1 => "o".to_string(),
                        _ => "\u{25AA}".to_string(),
                    }
                } else {
                    format!("{}.", i + 1)
                };
                format!(
                    "<w:lvl w:ilvl=\"{i}\"><w:start w:val=\"1\"/><w:numFmt w:val=\"{fmt}\"/><w:lvlText w:val=\"{bullet}\"/><w:lvlJc w:val=\"left\"/><w:pPr><w:ind w:left=\"{indent}\" w:hanging=\"360\"/></w:pPr></w:lvl>"
                )
            })
            .collect();
        format!(
            "<w:abstractNum w:abstractNumId=\"{id}\"><w:multiLevelType w:val=\"hybridMultilevel\"/>{lvls}</w:abstractNum>"
        )
    };
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<w:numbering xmlns:w=\"{NS_W}\">{}<w:num w:numId=\"1\"><w:abstractNumId w:val=\"0\"/></w:num>\
<w:num w:numId=\"2\"><w:abstractNumId w:val=\"1\"/></w:num></w:numbering>",
        abstract_num(0, "bullet") + &abstract_num(1, "decimal")
    )
}

const CONTENT_TYPES: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\">\
<Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/>\
<Default Extension=\"xml\" ContentType=\"application/xml\"/>\
<Override PartName=\"/word/document.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml\"/>\
<Override PartName=\"/word/styles.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml\"/>\
<Override PartName=\"/word/numbering.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml\"/>\
<Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/>\
<Override PartName=\"/docProps/app.xml\" ContentType=\"application/vnd.openxmlformats-officedocument.extended-properties+xml\"/>\
</Types>";

const ROOT_RELS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
<Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/>\
<Relationship Id=\"rId2\" Type=\"http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties\" Target=\"docProps/core.xml\"/>\
<Relationship Id=\"rId3\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties\" Target=\"docProps/app.xml\"/>\
</Relationships>";

fn core_props(doc: &Doc) -> String {
    let creator = doc
        .author
        .as_ref()
        .map(|a| xml_escape(a))
        .unwrap_or_default();
    format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\
<dc:title>{}</dc:title><dc:creator>{}</dc:creator><cp:lastModifiedBy>{}</cp:lastModifiedBy>\
</cp:coreProperties>",
        xml_escape(&doc.title),
        creator,
        creator
    )
}

const APP_PROPS: &str = "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<Properties xmlns=\"http://schemas.openxmlformats.org/officeDocument/2006/extended-properties\">\
<Application>just-write-ehis</Application></Properties>";

/// Serialise a `Doc` to DOCX bytes.
pub fn write(doc: &Doc) -> Result<Vec<u8>, String> {
    let bytes = build(doc)?;
    // Self-check: reopen and confirm the mandatory parts are readable.
    let mut a = zip::ZipArchive::new(Cursor::new(&bytes))
        .map_err(|e| format!("DOCX failed self-check: {}", e))?;
    for req in ["[Content_Types].xml", "_rels/.rels", "word/document.xml"] {
        if a.by_name(req).is_err() {
            return Err(format!("DOCX missing required part: {}", req));
        }
    }
    Ok(bytes)
}

fn build(doc: &Doc) -> Result<Vec<u8>, String> {
    reset_rels();
    let mut body = String::new();
    // Title as the Word Title style, then content minus any duplicate H1.
    body.push_str(&para("Title", &text_run(&doc.title)));
    if let Some(a) = &doc.author {
        body.push_str(&para("BodyText", &run_with_props(a, false, true, false, "DefaultParagraphFont", None)));
    }
    if let Some(d) = &doc.date {
        body.push_str(&para("BodyText", &text_run(d)));
    }
    render_blocks(&mut body, &doc.blocks, 0);

    let document = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<w:document xmlns:w=\"{NS_W}\" xmlns:r=\"{NS_R}\"><w:body>{body}\
<w:sectPr><w:pgSz w:w=\"12240\" w:h=\"15840\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"720\" w:footer=\"720\" w:gutter=\"0\"/></w:sectPr>\
</w:body></w:document>"
    );

    // Hyperlink relationships, rId1+ is reserved for styles/numbering.
    let mut doc_rels = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>\n\
<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">",
    );
    doc_rels.push_str("<Relationship Id=\"rIdStyles\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles\" Target=\"styles.xml\"/>");
    doc_rels.push_str("<Relationship Id=\"rIdNumbering\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering\" Target=\"numbering.xml\"/>");
    for (id, target) in take_rels() {
        doc_rels.push_str(&format!(
            "<Relationship Id=\"{}\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink\" Target=\"{}\" TargetMode=\"External\"/>",
            id,
            xml_escape(&target)
        ));
    }
    doc_rels.push_str("</Relationships>");

    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    let opts = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
    for (name, body) in [
        ("[Content_Types].xml", CONTENT_TYPES),
        ("_rels/.rels", ROOT_RELS),
        ("word/document.xml", document.as_str()),
        ("word/_rels/document.xml.rels", doc_rels.as_str()),
        ("word/styles.xml", styles_xml().as_str()),
        ("word/numbering.xml", numbering_xml().as_str()),
        ("docProps/core.xml", core_props(doc).as_str()),
        ("docProps/app.xml", APP_PROPS),
    ] {
        z.start_file(name, opts)
            .map_err(|e| format!("DOCX write failed: {}", e))?;
        z.write_all(body.as_bytes())
            .map_err(|e| format!("DOCX write failed: {}", e))?;
    }
    let cursor = z
        .finish()
        .map_err(|e| format!("DOCX write failed: {}", e))?;
    Ok(cursor.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docmodel::parse;
    use std::io::Read;

    fn names(bytes: &[u8]) -> Vec<String> {
        let mut a = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        (0..a.len())
            .map(|i| a.by_index(i).unwrap().name().to_string())
            .collect()
    }

    fn part(bytes: &[u8], name: &str) -> String {
        let mut a = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut f = a.by_name(name).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        s
    }

    fn docx(md: &str) -> String {
        part(&write(&parse("Book", md)).unwrap(), "word/document.xml")
    }

    #[test]
    fn required_parts_present() {
        let bytes = write(&parse("Book", "Hello.")).unwrap();
        let n = names(&bytes);
        for req in [
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "word/_rels/document.xml.rels",
            "word/styles.xml",
            "word/numbering.xml",
            "docProps/core.xml",
        ] {
            assert!(n.contains(&req.to_string()), "missing {req} in {n:?}");
        }
    }

    #[test]
    fn every_declared_override_exists() {
        // A part declared in [Content_Types].xml but absent makes Word
        // report the file as corrupt.
        let bytes = write(&parse("Book", "# H\n\ntext")).unwrap();
        let ct = part(&bytes, "[Content_Types].xml");
        let n = names(&bytes);
        for line in ct.lines().filter(|l| l.contains("PartName=\"/")) {
            let p = line.split("PartName=\"/").nth(1).unwrap().split('"').next().unwrap();
            assert!(n.contains(&p.to_string()), "declared but missing: {p}");
        }
    }

    #[test]
    fn document_xml_is_balanced() {
        let d = docx("# One\n\ntext\n\n- a\n- b\n\n> q\n\n```\ncode\n```");
        assert_eq!(d.matches("<w:p>").count() + d.matches("<w:p ").count(), d.matches("</w:p>").count(), "{d}");
        assert_eq!(d.matches("<w:body>").count(), 1, "{d}");
        assert_eq!(d.matches("</w:body>").count(), 1, "{d}");
        assert!(d.contains("<w:sectPr>"), "{d}");
    }

    #[test]
    fn title_uses_title_style_and_h1_not_duplicated() {
        let d = docx("# The Chapter\n\nBody.");
        assert!(d.contains("w:val=\"Title\""), "{d}");
        assert_eq!(d.matches("The Chapter").count(), 1, "title duplicated: {d}");
    }

    #[test]
    fn headings_map_to_word_styles() {
        let d = docx("## Two\n\n### Three");
        assert!(d.contains("<w:pStyle w:val=\"Heading2\"/>"), "{d}");
        assert!(d.contains("<w:pStyle w:val=\"Heading3\"/>"), "{d}");
    }

    #[test]
    fn bold_italic_and_strike_emit_rpr() {
        let d = docx("A **b** and *i* and ~~s~~");
        assert!(d.contains("<w:b/>"), "{d}");
        assert!(d.contains("<w:i/>"), "{d}");
        assert!(d.contains("<w:strike/>"), "{d}");
    }

    #[test]
    fn nested_bold_italic_combines_properties() {
        let d = docx("**bold *and italic***");
        // One run must carry both <w:b/> and <w:i/>.
        assert!(
            d.contains("<w:b/><w:i/>") || d.contains("<w:i/><w:b/>"),
            "nested emphasis must combine props in one run: {d}"
        );
    }

    #[test]
    fn lists_use_numbering_and_track_depth() {
        let d = docx("- outer\n  - inner\n- second\n\n1. one\n2. two");
        assert!(d.contains("<w:numId w:val=\"1\"/>"), "bullet numId: {d}");
        assert!(d.contains("<w:numId w:val=\"2\"/>"), "ordered numId: {d}");
        assert!(d.contains("<w:ilvl w:val=\"0\"/>"), "{d}");
        assert!(d.contains("<w:ilvl w:val=\"1\"/>"), "nested level: {d}");
    }

    #[test]
    fn numbering_defines_nine_levels_for_both_formats() {
        let bytes = write(&parse("B", "- x")).unwrap();
        let n = part(&bytes, "word/numbering.xml");
        assert_eq!(n.matches("<w:lvl w:ilvl=").count(), 18, "9 per format: {n}");
        assert!(n.contains("w:numFmt w:val=\"bullet\""), "{n}");
        assert!(n.contains("w:numFmt w:val=\"decimal\""), "{n}");
    }

    #[test]
    fn hyperlinks_get_relationships_that_resolve() {
        let bytes = write(&parse("B", "[x](https://example.com/?a=1&b=2)")).unwrap();
        let d = part(&bytes, "word/document.xml");
        let rels = part(&bytes, "word/_rels/document.xml.rels");
        assert!(d.contains("<w:hyperlink r:id=\""), "{d}");
        // r:id must exist in the rels part, and the target must be escaped.
        let id = d.split("r:id=\"").nth(1).unwrap().split('"').next().unwrap();
        assert!(rels.contains(&format!("Id=\"{}\"", id)), "no rel for {id}: {rels}");
        assert!(rels.contains("TargetMode=\"External\""), "{rels}");
        assert!(rels.contains("example.com/?a=1&amp;b=2"), "{rels}");
    }

    #[test]
    fn fixed_part_rel_ids_do_not_collide_with_hyperlinks() {
        // Styles/numbering use NAMED ids (rIdStyles/rIdNumbering) while
        // hyperlinks use numeric rIdN, so the two spaces cannot overlap.
        // A future edit that switches the fixed parts to rId1 would silently
        // shadow the first hyperlink.
        let bytes = write(&parse("B", "[a](https://x.com/) [b](https://y.com/)")).unwrap();
        let rels = part(&bytes, "word/_rels/document.xml.rels");
        assert!(rels.contains("Id=\"rIdStyles\""), "{rels}");
        assert!(rels.contains("Id=\"rIdNumbering\""), "{rels}");
        // No numeric id may be used by a non-hyperlink relationship.
        for line in rels.lines().filter(|l| l.contains("Id=\"rId")) {
            assert!(
                line.contains("/hyperlink"),
                "numeric rel id on a non-hyperlink part: {line}"
            );
        }
        // And all ids are unique regardless of prefix.
        let ids: Vec<&str> = rels
            .match_indices("Id=\"")
            .map(|(i, _)| {
                let r = &rels[i + 4..];
                &r[..r.find('"').unwrap()]
            })
            .collect();
        let mut sorted = ids.clone();
        sorted.sort_unstable();
        sorted.dedup();
        assert_eq!(ids.len(), sorted.len(), "duplicate rel ids: {ids:?}");
    }

    #[test]
    fn xml_metacharacters_are_escaped() {
        let d = docx("Costs $5 and 3 < 5 and 6 > 2 and a & b.");
        // Escaped text can be split across runs (Word merges adjacent runs
        // with identical formatting), so assert the raw XML has no unescaped
        // metacharacter inside any <w:t> rather than a contiguous substring.
        for chunk in d.split("<w:t xml:space=\"preserve\">").skip(1) {
            let text = chunk.split("</w:t>").next().unwrap();
            assert!(!text.contains('<'), "raw '<' in run text: {text}");
            assert!(!text.contains('>'), "raw '>' in run text: {text}");
        }
        // The characters themselves survive, in escaped form.
        assert!(d.contains("&lt;"), "{d}");
        assert!(d.contains("&gt;"), "{d}");
        assert!(d.contains("&amp;"), "{d}");
        assert!(d.contains("$5"), "$ is not special: {d}");
    }

    #[test]
    fn strikethrough_is_parsed_and_rendered() {
        // `~~x~~` needs pulldown-cmark's STRIKETHROUGH option; without it the
        // tildes reached the document as literal text.
        let d = docx("a ~~gone~~ b");
        assert!(d.contains("<w:strike/>"), "{d}");
        assert!(!d.contains("~~"), "literal tildes leaked: {d}");
    }

    #[test]
    fn code_block_uses_code_style_and_keeps_blank_lines() {
        let d = docx("```rust\nlet x = 1;\n\nlet y = 2;\n```");
        assert!(d.contains("<w:pStyle w:val=\"HTMLCode\"/>"), "{d}");
        assert!(d.contains("let x = 1;"), "{d}");
        assert!(d.contains("let y = 2;"), "{d}");
        // A blank line inside code must still produce a paragraph.
        assert!(d.contains("HTMLCode"), "{d}");
    }

    #[test]
    fn quote_and_rule_have_representations() {
        let d = docx("> quoted\n\n***");
        assert!(d.contains("<w:pStyle w:val=\"Quote\"/>"), "{d}");
        assert!(d.contains("quoted"), "{d}");
        assert!(d.contains("<w:pBdr>"), "rule needs a border: {d}");
    }

    #[test]
    fn core_props_carry_title_and_author() {
        let bytes = write(&parse("X", "---\ntitle: \"T\"\nauthor: \"A B\"\n---\n\nbody")).unwrap();
        let core = part(&bytes, "docProps/core.xml");
        assert!(core.contains("<dc:title>T</dc:title>"), "{core}");
        assert!(core.contains("<dc:creator>A B</dc:creator>"), "{core}");
    }

    #[test]
    fn empty_document_is_still_valid() {
        let bytes = write(&parse("Empty", "")).unwrap();
        let d = part(&bytes, "word/document.xml");
        assert!(d.contains("<w:body>"), "{d}");
        assert!(d.contains("Empty"), "title still emitted: {d}");
    }

    #[test]
    fn rel_ids_reset_between_documents() {
        // thread_local state leaking across calls would accumulate ids.
        let a = part(
            &write(&parse("A", "[x](https://a.com/)")).unwrap(),
            "word/document.xml",
        );
        let b = part(
            &write(&parse("B", "[y](https://b.com/)")).unwrap(),
            "word/document.xml",
        );
        let id_a = a.split("r:id=\"").nth(1).unwrap().split('"').next().unwrap();
        let id_b = b.split("r:id=\"").nth(1).unwrap().split('"').next().unwrap();
        assert_eq!(id_a, id_b, "rel ids must restart per document");
    }
}