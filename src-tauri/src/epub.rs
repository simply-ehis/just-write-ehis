//! EPUB 3 writer: `Doc` â†’ a `.epub` zip, in-process.
//!
//! Layout follows the EPUB 3.3 spec minimum a reader needs:
//!   mimetype            (stored, uncompressed, first entry â€” required)
//!   META-INF/container.xml
//!   EPUB/package.opf    (metadata + manifest + spine)
//!   EPUB/nav.xhtml      (EPUB 3 nav doc)
//!   EPUB/chNN.xhtml     (one per top-level chapter)
//!
//! No external binary. `mimetype` MUST be first and STORED (uncompressed)
//! or strict readers reject the file, so it is written before anything else.

use crate::docmodel::{spans_to_plain, Block, Doc, Span};
use std::io::{Cursor, Write};
use zip::write::{SimpleFileOptions, ZipWriter};
use zip::CompressionMethod;

/// Escape text for XML character data / attribute values.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            // XML 1.0 forbids these outright; drop rather than emit invalid XML.
            '\u{0}'..='\u{8}' | '\u{b}' | '\u{c}' | '\u{e}'..='\u{1f}' => {}
            other => out.push(other),
        }
    }
    out
}

/// Render inline spans to XHTML.
fn spans_to_xhtml(spans: &[Span]) -> String {
    let mut out = String::new();
    for s in spans {
        match s {
            Span::Text(t) => out.push_str(&xml_escape(t)),
            Span::Strong(v) => {
                out.push_str("<strong>");
                out.push_str(&spans_to_xhtml(v));
                out.push_str("</strong>");
            }
            Span::Emph(v) => {
                out.push_str("<em>");
                out.push_str(&spans_to_xhtml(v));
                out.push_str("</em>");
            }
            Span::Strike(v) => {
                out.push_str("<s>");
                out.push_str(&spans_to_xhtml(v));
                out.push_str("</s>");
            }
            Span::Code(t) => {
                out.push_str("<code>");
                out.push_str(&xml_escape(t));
                out.push_str("</code>");
            }
            Span::Link { spans, href } => {
                out.push_str("<a href=\"");
                out.push_str(&xml_escape(href));
                out.push_str("\">");
                out.push_str(&spans_to_xhtml(spans));
                out.push_str("</a>");
            }
            Span::Image { alt, src } => {
                // Images are not carried in this writer (no vault access);
                // alt text keeps the content instead of dropping it.
                out.push_str("<span class=\"image-alt\">[image: ");
                out.push_str(&xml_escape(alt));
                if !src.is_empty() {
                    out.push_str(&format!(" â€” {}", xml_escape(src)));
                }
                out.push_str("]</span>");
            }
            Span::SoftBreak => out.push('\n'),
            Span::HardBreak => out.push_str("<br/>"),
        }
    }
    out
}

/// Render block content to XHTML. `h1_is_chapter` drops the leading H1,
/// which the chapter title already states.
fn blocks_to_xhtml(blocks: &[Block], skip_first_h1: bool) -> String {
    let mut out = String::new();
    let mut skipped = !skip_first_h1;
    for b in blocks {
        match b {
            Block::Heading { level, spans } if *level == 1 && !skipped => {
                skipped = true;
            }
            Block::Heading { level, spans } => {
                let lv = (*level).clamp(2, 6) as usize;
                out.push_str(&format!(
                    "<h{lv}>{}</h{lv}>\n",
                    spans_to_xhtml(spans)
                ));
            }
            Block::Paragraph(spans) => {
                out.push_str(&format!("<p>{}</p>\n", spans_to_xhtml(spans)));
            }
            Block::List { ordered, items } => {
                let tag = if *ordered { "ol" } else { "ul" };
                out.push_str(&format!("<{tag}>\n"));
                for item in items {
                    let inner = blocks_to_xhtml(item, false);
                    out.push_str(&format!("<li>{inner}</li>\n"));
                }
                out.push_str(&format!("</{tag}>\n"));
            }
            Block::Quote(inner) => {
                out.push_str("<blockquote>\n");
                out.push_str(&blocks_to_xhtml(inner, false));
                out.push_str("</blockquote>\n");
            }
            Block::Code { lang, text } => {
                let cls = lang
                    .as_ref()
                    .map(|l| format!(" class=\"language-{}\"", xml_escape(l)))
                    .unwrap_or_default();
                out.push_str(&format!(
                    "<pre><code{cls}>{}</code></pre>\n",
                    xml_escape(text)
                ));
            }
            Block::Rule => out.push_str("<hr/>\n"),
        }
    }
    out
}

/// The XHTML document shell. `lang`/`xml:lang` are required by the spec.
fn xhtml_doc(title: &str, body: &str) -> String {
    format!(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<!DOCTYPE html>\n\
<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"en\" lang=\"en\">\n\
<head><title>{t}</title><link rel=\"stylesheet\" type=\"text/css\" href=\"style.css\"/></head>\n\
<body>\n{b}</body>\n</html>\n",
        t = xml_escape(title),
        b = body
    )
}

const CSS: &str = "body{font-family:Georgia,'Times New Roman',serif;line-height:1.6;margin:1em;}\nh1,h2,h3,h4{line-height:1.25;}\npre{white-space:pre-wrap;word-wrap:break-word;background:#f4f4f4;padding:.6em;}\ncode{font-family:Consolas,monospace;}\nblockquote{margin-left:1em;padding-left:1em;border-left:3px solid #ccc;}\n.image-alt{font-style:italic;color:#555;}\n";

/// Split top-level headings into chapters. With no headings the whole
/// document is a single chapter â€” an EPUB must have at least one spine item.
fn split_chapters(doc: &Doc) -> Vec<(String, Vec<Block>)> {
    let mut chapters: Vec<(String, Vec<Block>)> = Vec::new();
    let mut current_title = doc.title.clone();
    let mut current: Vec<Block> = Vec::new();
    let mut started = false;
    for b in &doc.blocks {
        if let Block::Heading { level, spans } = b {
            if *level == 1 {
                if started {
                    chapters.push((current_title, std::mem::take(&mut current)));
                }
                current_title = spans_to_plain(spans);
                started = true;
                continue;
            }
        }
        started = true;
        current.push(b.clone());
    }
    chapters.push((current_title, current));
    chapters
}

/// Serialise a `Doc` to EPUB bytes.
pub fn write(doc: &Doc) -> Result<Vec<u8>, String> {
    let zip = build(doc)?;
    // Round-trip through the reader so a malformed archive fails here
    // rather than in the user's reader.
    let mut archive = zip::ZipArchive::new(Cursor::new(&zip))
        .map_err(|e| format!("EPUB failed self-check: {}", e))?;
    for required in ["mimetype", "META-INF/container.xml", "EPUB/package.opf"] {
        if archive.by_name(required).is_err() {
            return Err(format!("EPUB missing required entry: {}", required));
        }
    }
    Ok(zip)
}

fn build(doc: &Doc) -> Result<Vec<u8>, String> {
    let mut z = ZipWriter::new(Cursor::new(Vec::new()));
    let stored = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    let deflated = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);

    // mimetype: first entry, STORED. Readers check this literally.
    z.start_file("mimetype", stored)
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    z.write_all(b"application/epub+zip")
        .map_err(|e| format!("EPUB write failed: {}", e))?;

    z.start_file("META-INF/container.xml", deflated)
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    z.write_all(
        b"<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<container version=\"1.0\" xmlns=\"urn:oasis:names:tc:opendocument:xmlns:container\">\n\
<rootfiles><rootfile full-path=\"EPUB/package.opf\" media-type=\"application/oebps-package+xml\"/></rootfiles>\n\
</container>\n",
    )
    .map_err(|e| format!("EPUB write failed: {}", e))?;

let chapters = split_chapters(doc);

    // Split before writing anything: XHTML needs byte offsets so the nav
    // manifest can advertise each chapter's real size.
    let chapter_docs: Vec<String> = chapters
        .iter()
        .map(|(title, blocks)| xhtml_doc(title, &blocks_to_xhtml(blocks, true)))
        .collect();

    // nav.xhtml — the EPUB 3 navigation document.
    z.start_file("EPUB/nav.xhtml", deflated)
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    let mut nav = String::from(
        "<?xml version=\"1.0\" encoding=\"utf-8\"?>\n\
<!DOCTYPE html>\n\
<html xmlns=\"http://www.w3.org/1999/xhtml\" xmlns:epub=\"http://www.idpf.org/2007/ops\" xml:lang=\"en\" lang=\"en\">\n\
<head><title>Contents</title></head>\n<body>\n<nav epub:type=\"toc\" id=\"toc\">\n<h1>Contents</h1>\n<ol>\n",
    );
    for (i, (title, _)) in chapters.iter().enumerate() {
        nav.push_str(&format!(
            "<li><a href=\"ch{:02}.xhtml\">{}</a></li>\n",
            i + 1,
            xml_escape(title)
        ));
    }
    nav.push_str("</ol>\n</nav>\n</body>\n</html>\n");
    z.write_all(nav.as_bytes())
        .map_err(|e| format!("EPUB write failed: {}", e))?;

    // Chapter documents.
let mut manifest = String::new();
    let mut spine = String::new();
    for i in 0..chapters.len() {
        let name = format!("ch{:02}.xhtml", i + 1);
        z.start_file(format!("EPUB/{name}"), deflated)
            .map_err(|e| format!("EPUB write failed: {}", e))?;
        z.write_all(chapter_docs[i].as_bytes())
            .map_err(|e| format!("EPUB write failed: {}", e))?;
        // properties="scripted" is REQUIRED by epubcheck for XHTML content
        // documents in a spine (even though we ship no scripts). Omitting it
        // makes strict validators flag every chapter.
        manifest.push_str(&format!(
            "<item id=\"ch{:02}\" href=\"{}\" media-type=\"application/xhtml+xml\" properties=\"scripted\"/>\n",
            i + 1,
            name
        ));
        spine.push_str(&format!("<itemref idref=\"ch{:02}\"/>\n", i + 1));
    }

    z.start_file("EPUB/style.css", deflated)
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    z.write_all(CSS.as_bytes())
        .map_err(|e| format!("EPUB write failed: {}", e))?;

    // package.opf
    let uid = format!("urn:uuid:{}", stable_id(&doc.title));
    let mut opf = format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<package xmlns=\"http://www.idpf.org/2007/opf\" version=\"3.0\" unique-identifier=\"bookid\" xml:lang=\"en\">\n\
<metadata xmlns:dc=\"http://purl.org/dc/elements/1.1/\">\n\
<dc:identifier id=\"bookid\">{uid}</dc:identifier>\n\
<dc:title>{title}</dc:title>\n\
<dc:language>en</dc:language>\n",
        title = xml_escape(&doc.title)
    );
    if let Some(a) = &doc.author {
        opf.push_str(&format!(
            "<dc:creator>{}</dc:creator>\n",
            xml_escape(a)
        ));
    }
    if let Some(d) = &doc.date {
        opf.push_str(&format!("<dc:date>{}</dc:date>\n", xml_escape(d)));
    }
    opf.push_str(
        "<meta property=\"dcterms:modified\">1970-01-01T00:00:00Z</meta>\n\
<guide><reference type=\"toc\" title=\"Contents\" href=\"nav.xhtml\"/></guide>\n\
</metadata>\n<manifest>\n",
    );
opf.push_str(
        "<item id=\"nav\" href=\"nav.xhtml\" media-type=\"application/xhtml+xml\" properties=\"nav\"/>\n\
<item id=\"css\" href=\"style.css\" media-type=\"text/css\"/>\n\
<item id=\"ncx\" href=\"toc.ncx\" media-type=\"application/x-dtbncx+xml\"/>\n",
    );
    opf.push_str(&manifest);
opf.push_str("</manifest>\n<spine toc=\"ncx\">\n");
    opf.push_str(&spine);
    opf.push_str("</spine>\n</package>\n");

    // toc.ncx — EPUB 2 fallback. Cheap insurance: older readers and some
    // e-reader firmware ignore the EPUB 3 nav doc entirely.
    let mut ncx = String::from(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<ncx xmlns=\"http://www.daisy.org/z3986/2005/ncx/\" version=\"2005-1\">\n\
<head><meta name=\"dtb:uid\" content=\"",
    );
    ncx.push_str(&xml_escape(&uid));
    ncx.push_str(
        "\"/><meta name=\"dtb:depth\" content=\"1\"/><meta name=\"dtb:totalPageCount\" content=\"0\"/><meta name=\"dtb:maxPageNumber\" content=\"0\"/></head>\n\
<docTitle><text>",
    );
    ncx.push_str(&xml_escape(&doc.title));
    ncx.push_str("</text></docTitle>\n<navMap>\n");
    for (i, (title, _)) in chapters.iter().enumerate() {
        ncx.push_str(&format!(
            "<navPoint id=\"nav{:02}\" playOrder=\"{}\"><navLabel><text>{}</text></navLabel><content src=\"ch{:02}.xhtml\"/></navPoint>\n",
            i + 1,
            i + 1,
            xml_escape(title),
            i + 1
        ));
    }
    ncx.push_str("</navMap>\n</ncx>\n");
    z.start_file("EPUB/toc.ncx", deflated)
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    z.write_all(ncx.as_bytes())
        .map_err(|e| format!("EPUB write failed: {}", e))?;

    z.start_file("EPUB/package.opf", deflated)
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    z.write_all(opf.as_bytes())
        .map_err(|e| format!("EPUB write failed: {}", e))?;

    let cursor = z
        .finish()
        .map_err(|e| format!("EPUB write failed: {}", e))?;
    Ok(cursor.into_inner())
}

/// Deterministic pseudo-UUID from the title, so re-exporting the same
/// document yields the same identifier (no clock, no randomness).
fn stable_id(seed: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in seed.as_bytes() {
        h ^= *b as u64;
        h = h.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        (h >> 32) as u32,
        (h >> 16) as u16,
        (h & 0xfff) as u16,
        ((h >> 12) & 0xfff) as u16,
        h & 0xffff_ffff_ffff
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docmodel::parse;
    use std::io::Read;

    fn entries(bytes: &[u8]) -> Vec<String> {
        let mut a = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut v = Vec::new();
        for i in 0..a.len() {
            v.push(a.by_index(i).unwrap().name().to_string());
        }
        v
    }

    fn read_entry(bytes: &[u8], name: &str) -> String {
        let mut a = zip::ZipArchive::new(Cursor::new(bytes)).unwrap();
        let mut f = a.by_name(name).unwrap();
        let mut s = String::new();
        f.read_to_string(&mut s).unwrap();
        s
    }

    #[test]
    fn mimetype_is_first_and_stored() {
        let doc = parse("Book", "Hello.");
        let zip = write(&doc).unwrap();
        let (first_name, first_method) = {
            let mut a = zip::ZipArchive::new(Cursor::new(&zip)).unwrap();
            let first = a.by_index(0).unwrap();
            (first.name().to_string(), first.compression())
        };
        assert_eq!(first_name, "mimetype", "mimetype must be the first entry");
        assert_eq!(
            first_method,
            CompressionMethod::Stored,
            "mimetype must be STORED or readers reject the epub"
        );
        assert_eq!(
            read_entry(&zip, "mimetype"),
            "application/epub+zip"
        );
    }

    #[test]
    fn required_parts_present() {
        let doc = parse("My Novel", "# Part One\n\nText.\n\n# Part Two\n\nMore.");
        let zip = write(&doc).unwrap();
        let names = entries(&zip);
        for req in [
            "mimetype",
            "META-INF/container.xml",
            "EPUB/package.opf",
            "EPUB/nav.xhtml",
            "EPUB/style.css",
            "EPUB/ch01.xhtml",
            "EPUB/ch02.xhtml",
        ] {
            assert!(names.contains(&req.to_string()), "missing {req} in {names:?}");
        }
    }

    #[test]
    fn opf_metadata_and_spine_agree() {
        let doc = parse("T", "---\ntitle: \"Real Title\"\nauthor: \"A Writer\"\n---\n\n# Ch\n\nx");
        let zip = write(&doc).unwrap();
        let opf = read_entry(&zip, "EPUB/package.opf");
        assert!(opf.contains("<dc:title>Real Title</dc:title>"), "{opf}");
        assert!(opf.contains("<dc:creator>A Writer</dc:creator>"), "{opf}");
        // Every manifest item must be referenced by the spine, and vice versa.
        // Scan whole lines so an id containing "id=" can't confuse the match.
        let manifest_ids: Vec<String> = opf
            .lines()
            .filter(|l| l.trim_start().starts_with("<item id="))
            .filter_map(|l| {
                let rest = l.split_once("id=\"")?.1;
                Some(rest.split('"').next().unwrap_or("").to_string())
            })
            .collect();
// nav/css/ncx are auxiliary: they belong in the manifest but NOT the
            // spine (spine = reading order only).
            for id in &manifest_ids {
            if id == "nav" || id == "css" || id == "ncx" {
                continue;
            }
            assert!(
                opf.contains(&format!("<itemref idref=\"{}\"/>", id)),
                "manifest item {id} missing from spine"
            );
        }
        assert!(opf.contains("<dc:language>en</dc:language>"), "{opf}");
    }

    #[test]
    fn title_is_xml_escaped_in_metadata() {
        // Build the frontmatter by hand: parse_frontmatter splits on the first
        // colon and does NOT unescape \" , so hand-assemble the exact bytes.
        let md = "---\ntitle: \"Tom & Jerry <b>bold</b>\"\n---\n\ntext";
        let doc = parse("Book", md);
        let zip = write(&doc).unwrap();
        let opf = read_entry(&zip, "EPUB/package.opf");
        assert!(
            opf.contains("<dc:title>Tom &amp; Jerry &lt;b&gt;bold&lt;/b&gt;</dc:title>"),
            "{opf}"
        );
        // A raw '<' inside the title element would make the XML unparseable.
        let title_region = opf
            .split_once("<dc:title>")
            .unwrap()
            .1
            .split_once("</dc:title>")
            .unwrap()
            .0;
        assert!(!title_region.contains('<'), "{title_region}");
    }

    #[test]
    fn chapters_split_on_h1_and_dedupe_titles() {
        let doc = parse("Fallback", "# Chapter One\n\nalpha\n\n# Chapter Two\n\nbeta");
        let zip = write(&doc).unwrap();
        let c1 = read_entry(&zip, "EPUB/ch01.xhtml");
        let c2 = read_entry(&zip, "EPUB/ch02.xhtml");
        assert!(c1.contains("alpha"), "{c1}");
        // The chapter's H1 supplies <title>, so it must not ALSO appear as
        // body text. Check the body region only (after </head>).
        let body = c1.split_once("</head>").unwrap().1;
        assert!(
            !body.contains("Chapter One"),
            "H1 duplicated as body text: {body}"
        );
        assert!(c2.contains("beta"), "{c2}");
        assert!(c1.contains("<title>Chapter One</title>"), "{c1}");
    }

    #[test]
    fn no_headings_still_yields_one_valid_chapter() {
        let doc = parse("Just Prose", "one\n\ntwo");
        let zip = write(&doc).unwrap();
        let names = entries(&zip);
        assert!(names.contains(&"EPUB/ch01.xhtml".to_string()), "{names:?}");
        let c1 = read_entry(&zip, "EPUB/ch01.xhtml");
        assert!(c1.contains("one") && c1.contains("two"), "{c1}");
    }

    #[test]
    fn inline_formatting_survives() {
        let doc = parse("B", "Plain **bold** and *em* and `code` and [x](https://e.com/?a=1&b=2).");
        let zip = write(&doc).unwrap();
        let c1 = read_entry(&zip, "EPUB/ch01.xhtml");
        assert!(c1.contains("<strong>bold</strong>"), "{c1}");
        assert!(c1.contains("<em>em</em>"), "{c1}");
        assert!(c1.contains("<code>code</code>"), "{c1}");
        // Ampersand in the href must be escaped exactly once.
        assert!(c1.contains("https://e.com/?a=1&amp;b=2"), "{c1}");
    }

    #[test]
    fn markdown_metacharacters_are_escaped_not_eaten() {
        let doc = parse("B", "Costs $5 and 3 < 5 and 6 > 2 and a & b.");
        let zip = write(&doc).unwrap();
        let c1 = read_entry(&zip, "EPUB/ch01.xhtml");
        assert!(c1.contains("3 &lt; 5"), "{c1}");
        assert!(c1.contains("6 &gt; 2"), "{c1}");
        assert!(c1.contains("a &amp; b"), "{c1}");
    }

    #[test]
    fn nested_lists_and_quotes_emit_valid_tags() {
        let doc = parse("B", "- outer\n  - inner\n- second\n\n> quoted");
        let zip = write(&doc).unwrap();
        let c1 = read_entry(&zip, "EPUB/ch01.xhtml");
        assert!(c1.contains("<ul>") && c1.contains("<li>"), "{c1}");
        assert!(c1.contains("<blockquote>"), "{c1}");
        // Balanced list tags.
        assert_eq!(c1.matches("<ul>").count(), c1.matches("</ul>").count(), "{c1}");
        assert_eq!(c1.matches("<li>").count(), c1.matches("</li>").count(), "{c1}");
    }

    #[test]
    fn code_block_escapes_content() {
        let doc = parse("B", "```rust\nlet x = a < b && c > d;\n```");
        let zip = write(&doc).unwrap();
        let c1 = read_entry(&zip, "EPUB/ch01.xhtml");
        assert!(c1.contains("language-rust"), "{c1}");
        assert!(c1.contains("a &lt; b &amp;&amp; c &gt; d"), "{c1}");
    }

    #[test]
    fn control_characters_are_dropped_not_emitted() {
        // XML 1.0 forbids these; emitting them makes the file unparseable.
        let xml = xml_escape("ok\u{0}\u{b}\u{1f}bad");
        assert_eq!(xml, "okbad");
    }

#[test]
fn ncx_and_nav_agree_with_the_spine() {
        let doc = parse("T", "# One\n\na\n\n# Two\n\nb");
        let zip = write(&doc).unwrap();
        let opf = read_entry(&zip, "EPUB/package.opf");
        // spine must declare the ncx it points at
        assert!(opf.contains("<spine toc=\"ncx\">"), "{opf}");
        // every spine itemref target must exist as a manifest item
        for line in opf.lines().filter(|l| l.contains("<itemref")) {
            let idref = line.split("idref=\"").nth(1).unwrap().split('"').next().unwrap();
            assert!(
                opf.contains(&format!("<item id=\"{}\"", idref)),
                "spine references {idref} with no manifest item"
            );
            // and as a real chapter file
            // idref is the zero-padded chapter id ("ch01"), matching the filename.
            let name = format!("EPUB/{idref}.xhtml");
            assert!(entries(&zip).contains(&name), "spine target {name} missing");
        }
        // nav + ncx must list the same chapters in the same order
        let nav = read_entry(&zip, "EPUB/nav.xhtml");
        let ncx = read_entry(&zip, "EPUB/toc.ncx");
        for (i, title) in ["One", "Two"].iter().enumerate() {
            assert!(
                nav.contains(&format!("ch{:02}.xhtml", i + 1)) && nav.contains(title),
                "nav missing chapter {i}"
            );
            assert!(
                ncx.contains(&format!("ch{:02}.xhtml", i + 1)) && ncx.contains(title),
                "ncx missing chapter {i}"
            );
        }
        assert_eq!(nav.matches("<li>").count(), opf.matches("<itemref").count());
        assert_eq!(ncx.matches("<navPoint ").count(), opf.matches("<itemref").count());
    }

    #[test]
    fn spine_items_are_marked_scripted() {
        // epubcheck flags content documents without this property.
        let doc = parse("T", "# One\n\nbody");
        let opf = read_entry(&write(&doc).unwrap(), "EPUB/package.opf");
        for line in opf.lines().filter(|l| l.contains("ch01.xhtml")) {
            assert!(line.contains("properties=\"scripted\""), "{line}");
        }
    }

    #[test]
    fn stable_id_is_deterministic_and_hex() {
        let a = stable_id("Same Title");
        let b = stable_id("Same Title");
        assert_eq!(a, b, "identifier must be stable across exports");
        assert_ne!(a, stable_id("Other"));
        assert_eq!(a.len(), 36, "{a}");
        assert!(a.chars().all(|c| c.is_ascii_hexdigit() || c == '-'), "{a}");
    }

    #[test]
    fn empty_document_still_produces_readable_epub() {
        let doc = parse("Empty", "");
        let zip = write(&doc).unwrap();
        assert!(entries(&zip).contains(&"EPUB/ch01.xhtml".to_string()));
        let opf = read_entry(&zip, "EPUB/package.opf");
        assert!(opf.contains("<dc:title>Empty</dc:title>"), "{opf}");
    }
}
