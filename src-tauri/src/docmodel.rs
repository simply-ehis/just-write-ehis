//! Markdown → a neutral document model, shared by the epub / docx / pdf
//! writers.
//!
//! Each writer renders the same `Doc`, so markdown parsing lives here once
//! instead of three times. Built on `pulldown-cmark`, which the built-in
//! HTML path already uses — so inline rules stay identical across formats.
//!
//! The module is `pub(crate)` and unused until the writers land, so its
//! dead-code warnings are silenced here rather than sprinkled across the
//! tree; every item becomes reachable the moment epub/docx/pdf are wired in.

#![allow(dead_code)]

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

/// A whole document plus the metadata the writers need.
#[derive(Debug, Clone, PartialEq)]
pub struct Doc {
    pub title: String,
    pub author: Option<String>,
    pub date: Option<String>,
    pub blocks: Vec<Block>,
}

/// Block-level content. List items and quotes hold nested blocks so a
/// chapter-shaped manuscript survives the round trip.
#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    Heading { level: u8, spans: Vec<Span> },
    Paragraph(Vec<Span>),
    List { ordered: bool, items: Vec<Vec<Block>> },
    Quote(Vec<Block>),
    Code { lang: Option<String>, text: String },
    Rule,
}

/// Inline content. `Image` is inline because that is how markdown writes it.
#[derive(Debug, Clone, PartialEq)]
pub enum Span {
    Text(String),
    Strong(Vec<Span>),
    Emph(Vec<Span>),
    Strike(Vec<Span>),
    Code(String),
    Link { spans: Vec<Span>, href: String },
    Image { alt: String, src: String },
    SoftBreak,
    HardBreak,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum SpanKind {
    Strong,
    Emph,
    Strike,
    Link,
}

struct ListCtx {
    ordered: bool,
    items: Vec<Vec<Block>>,
}

/// What a `stack` frame is collecting. One stack instead of two parallel
/// ones (blocks + lists), which could desync and drop content.
enum Container {
    Blocks(Vec<Block>),
    List(ListCtx),
}

/// Strip a leading `---` YAML block, returning it as (title, author, date)
/// plus the body with the block removed. No block = no metadata.
fn split_frontmatter(md: &str) -> (DocMeta, String) {
    let mut meta = DocMeta::default();
    let rest = md.strip_prefix("---\n").unwrap_or(md);
    // Only treat it as frontmatter if a closing fence exists.
    let end = rest.find("\n---").filter(|p| {
        rest[p + 4..]
            .chars()
            .next()
            .map(|c| c == '\n')
            .unwrap_or(true)
    });
    let end = match end {
        Some(e) => e,
        None => return (meta, md.to_string()),
    };
    let block = &rest[..end];
    let mut body = rest[end + 4..].trim_start_matches('\n').to_string();
    for line in block.lines() {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let v = v.trim().trim_matches('"').trim_matches('\'').to_string();
        match k.trim() {
            "title" => meta.title = Some(v),
            "author" => meta.author = Some(v),
            "date" => meta.date = Some(v),
            _ => {}
        }
    }
    if body.is_empty() {
        body = String::new();
    }
    (meta, body)
}

#[derive(Default)]
struct DocMeta {
    title: Option<String>,
    author: Option<String>,
    date: Option<String>,
}

/// Parse markdown into a `Doc`. `fallback_title` is used when the source has
/// neither frontmatter nor a leading heading.
/// Parser options. Strikethrough is on because `Span::Strike` exists and
/// every writer renders it; without the flag `~~text~~` reached the output
/// as literal tildes.
fn options() -> Options {
    Options::ENABLE_STRIKETHROUGH
}

pub fn parse(title: &str, md: &str) -> Doc {
    let (meta, body) = split_frontmatter(md);
    let mut builder = Builder::new();
    let parser = Parser::new_ext(&body, options());
    for ev in parser {
        builder.event(ev);
    }
    let mut blocks = builder.finish();

    // A leading H1 is the de-facto title; drop it so writers do not print
    // the chapter name twice.
    let heading_title = match blocks.first() {
        Some(Block::Heading { level: 1, spans }) => Some(spans_to_plain(spans)),
        _ => None,
    };
    if heading_title.is_some() {
        blocks.remove(0);
    }

    Doc {
        title: meta
            .title
            .or(heading_title)
            .filter(|t| !t.trim().is_empty())
            .unwrap_or_else(|| title.to_string()),
        author: meta.author,
        date: meta.date,
        blocks,
    }
}

/// Flatten spans to plain text (title extraction, tests).
pub fn spans_to_plain(spans: &[Span]) -> String {
    let mut out = String::new();
    for s in spans {
        match s {
            Span::Text(t) => out.push_str(t),
            Span::Code(t) => out.push_str(t),
            Span::SoftBreak | Span::HardBreak => out.push(' '),
            Span::Image { alt, .. } => out.push_str(alt),
            Span::Strong(v) | Span::Emph(v) | Span::Strike(v) => out.push_str(&spans_to_plain(v)),
            Span::Link { spans, .. } => out.push_str(&spans_to_plain(spans)),
        }
    }
    out
}

struct Builder {
    /// Block containers. Index 0 is the document root; deeper entries are
    /// open blockquotes or lists.
    stack: Vec<Container>,
    /// Inline spans collected for the paragraph currently being read.
    inline: Vec<Span>,
    /// Open inline containers (strong/emph/strike/link) with their children.
    spans_stack: Vec<(SpanKind, Vec<Span>)>,
    /// Image alt text accumulates between Start/End(Image).
    img_alt: String,
    img_src: String,
    in_image: bool,
    /// Code block text accumulating between Start/End(CodeBlock).
    code: Option<(Option<String>, String)>,
    /// Heading depth for the open Heading tag.
    pending_heading: Option<u8>,
    /// Destination for the innermost open Link tag.
    pending_href: Option<String>,
}

impl Builder {
    fn new() -> Self {
        Builder {
            stack: vec![Container::Blocks(Vec::new())],
            inline: Vec::new(),
            spans_stack: Vec::new(),
            img_alt: String::new(),
            img_src: String::new(),
            in_image: false,
            code: None,
            pending_heading: None,
            pending_href: None,
        }
    }

    /// Append a block to the innermost container, descending into the
    /// current list item when the innermost frame is a list.
    fn push_block(&mut self, b: Block) {
        match self.stack.last_mut() {
            Some(Container::List(list)) => match list.items.last_mut() {
                Some(item) => item.push(b),
                None => {
                    // List with no open item (malformed input): make one so
                    // content is never silently dropped.
                    list.items.push(vec![b]);
                }
            },
            Some(Container::Blocks(v)) => v.push(b),
            None => {}
        }
    }

    fn push_span(&mut self, s: Span) {
        match self.spans_stack.last_mut() {
            Some((_, children)) => children.push(s),
            None => self.inline.push(s),
        }
    }

    fn take_inline(&mut self) -> Vec<Span> {
        let mut spans = std::mem::take(&mut self.inline);
        // Unclosed inline containers still yield their text rather than
        // silently dropping the rest of the paragraph.
        while let Some((kind, children)) = self.spans_stack.pop() {
            let wrapped = match kind {
                SpanKind::Strong => Span::Strong(children),
                SpanKind::Emph => Span::Emph(children),
                SpanKind::Strike => Span::Strike(children),
                SpanKind::Link => Span::Link {
                    spans: children,
                    href: String::new(),
                },
            };
            match self.spans_stack.last_mut() {
                Some((_, parent)) => parent.push(wrapped),
                None => spans.push(wrapped),
            }
        }
        spans
    }

    fn flush_inline_block(&mut self, wrap: fn(Vec<Span>) -> Block) {
        let spans = self.take_inline();
        if spans.iter().any(|s| !matches!(s, Span::SoftBreak)) {
            self.push_block(wrap(spans));
        }
    }

    fn event(&mut self, ev: Event<'_>) {
        match ev {
            Event::Start(tag) => self.start(tag),
            Event::End(tag) => self.end(tag),
            Event::Text(t) => {
                if self.in_image {
                    self.img_alt.push_str(&t);
                } else if let Some((_, buf)) = self.code.as_mut() {
                    // Inside a fenced/indented code block the body arrives as
                    // plain Text events, not Code events.
                    buf.push_str(&t);
                } else {
                    self.push_span(Span::Text(t.to_string()));
                }
            }
            Event::Code(t) => self.push_span(Span::Code(t.to_string())),
            Event::Html(t) | Event::InlineHtml(t) => {
                // Raw HTML has no portable representation in epub/docx/pdf.
                // Keep the text so content is never lost.
                self.push_span(Span::Text(t.to_string()));
            }
            Event::SoftBreak => self.push_span(Span::SoftBreak),
            Event::HardBreak => self.push_span(Span::HardBreak),
            Event::Rule => {
                // Close any paragraph the rule was interrupting, or the
                // preceding text merges into the wrong block.
                self.flush_pending_inline();
                self.push_block(Block::Rule)
            }
            Event::TaskListMarker(done) => {
                self.push_span(Span::Text(if done { "[x] ".into() } else { "[ ] ".into() }))
            }
            Event::FootnoteReference(name) => {
                self.push_span(Span::Text(format!("[{}]", name)))
            }
            Event::InlineMath(t) | Event::DisplayMath(t) => {
                self.push_span(Span::Text(t.to_string()))
            }
        }
    }

    fn start(&mut self, tag: Tag<'_>) {
        match tag {
            // A list item's body arrives WITHOUT a Paragraph wrapper (tight list):
            // `Start(Item) Text(..) End(Item)`. Open one on item start so
            // flush_pending_inline has a block to close at item end.
            Tag::Item => {
                self.flush_pending_inline();
                if let Some(Container::List(list)) = self.stack.last_mut() {
                    list.items.push(Vec::new());
                }
            }
            Tag::Heading { level, .. } => {
                self.flush_pending_inline();
                self.pending_heading = Some(match level {
                    HeadingLevel::H1 => 1,
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    HeadingLevel::H5 => 5,
                    HeadingLevel::H6 => 6,
                });
            }
            Tag::BlockQuote(_) => {
                self.flush_pending_inline();
                self.stack.push(Container::Blocks(Vec::new()));
            }
            Tag::CodeBlock(kind) => {
                self.flush_pending_inline();
                let lang = match kind {
                    CodeBlockKind::Fenced(info) if !info.is_empty() => {
                        Some(info.to_string())
                    }
                    _ => None,
                };
                self.code = Some((lang, String::new()));
            }
            Tag::List(start) => {
                self.flush_pending_inline();
                self.stack.push(Container::List(ListCtx {
                    ordered: start.is_some(),
                    items: Vec::new(),
                }));
            }
            Tag::Emphasis => self.spans_stack.push((SpanKind::Emph, Vec::new())),
            Tag::Strong => self.spans_stack.push((SpanKind::Strong, Vec::new())),
            Tag::Strikethrough => self.spans_stack.push((SpanKind::Strike, Vec::new())),
            Tag::Link { dest_url, .. } => {
                self.spans_stack.push((SpanKind::Link, Vec::new()));
                self.pending_href = Some(dest_url.to_string());
            }
            Tag::Image { dest_url, .. } => {
                self.img_alt.clear();
                self.img_src = dest_url.to_string();
                self.in_image = true;
            }
            // Tables, definition lists, footnotes, html blocks: keep the
            // inner text so nothing disappears.
            _ => self.flush_pending_inline(),
        }
    }

    fn end(&mut self, tag: TagEnd) {
        match tag {
            TagEnd::Paragraph => self.flush_pending_inline(),
            TagEnd::Heading(_) => {
                let level = self.pending_heading.take().unwrap_or(1);
                let spans = self.take_inline();
                if !spans.is_empty() {
                    self.push_block(Block::Heading { level, spans });
                }
            }
            TagEnd::BlockQuote(_) => {
                self.flush_pending_inline();
                if let Some(Container::Blocks(inner)) = self.stack.pop() {
                    self.push_block(Block::Quote(inner));
                }
            }
            TagEnd::CodeBlock => {
                if let Some((lang, text)) = self.code.take() {
                    self.push_block(Block::Code { lang, text });
                }
            }
            TagEnd::List(_) => {
                self.flush_pending_inline();
                if let Some(Container::List(list)) = self.stack.pop() {
                    if !list.items.is_empty() {
                        self.push_block(Block::List {
                            ordered: list.ordered,
                            items: list.items,
                        });
                    }
                }
            }
            TagEnd::Item => self.flush_pending_inline(),
            TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                let (kind, children) = match self.spans_stack.pop() {
                    Some(v) => v,
                    None => return,
                };
                let wrapped = match kind {
                    SpanKind::Strong => Span::Strong(children),
                    SpanKind::Emph => Span::Emph(children),
                    SpanKind::Strike => Span::Strike(children),
                    SpanKind::Link => {
                        let href = self.pending_href.take().unwrap_or_default();
                        Span::Link { spans: children, href }
                    }
                };
                self.push_span(wrapped);
            }
            TagEnd::Image => {
                self.in_image = false;
                let alt = std::mem::take(&mut self.img_alt);
                let src = std::mem::take(&mut self.img_src);
                self.push_span(Span::Image { alt, src });
            }
            _ => {}
        }
    }

    /// Close any paragraph that was left open before a block-level tag.
    fn flush_pending_inline(&mut self) {
        if !self.inline.is_empty() {
            let spans = std::mem::take(&mut self.inline);
            if spans.iter().any(|s| !matches!(s, Span::SoftBreak)) {
                self.push_block(Block::Paragraph(spans));
            }
        }
    }

    fn finish(mut self) -> Vec<Block> {
        self.flush_pending_inline();
        while !self.spans_stack.is_empty() {
            self.take_inline();
        }
        while self.stack.len() > 1 {
            match self.stack.pop() {
                Some(Container::Blocks(inner)) => self.push_block(Block::Quote(inner)),
                Some(Container::List(list)) => {
                    if !list.items.is_empty() {
                        self.push_block(Block::List {
                            ordered: list.ordered,
                            items: list.items,
                        })
                    }
                }
                None => {}
            }
        }
        match self.stack.pop() {
            Some(Container::Blocks(v)) => v,
            _ => Vec::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn p(text: &str) -> Doc {
        parse("Fallback", text)
    }

    /// Documents why the parser looks the way it does. Run with
    /// `cargo test --lib dump_events -- --ignored --nocapture`.
    #[test]
    #[ignore]
    fn dump_events() {
        for src in [
            "Intro.\n\n***\n\nAfter.",
            "- one\n  - nested\n- two",
            "A **bold and *nested* word** end.",
        ] {
            println!("=== SOURCE {src:?}");
            for ev in Parser::new_ext(src, options()) {
                println!("   {ev:?}");
            }
        }
    }

    #[test]
    fn frontmatter_becomes_metadata_and_is_stripped() {
        let d = p("---\ntitle: \"My Novel\"\nauthor: \"Me\"\ndate: \"2026\"\n---\n\nBody.");
        assert_eq!(d.title, "My Novel");
        assert_eq!(d.author.as_deref(), Some("Me"));
        assert_eq!(d.date.as_deref(), Some("2026"));
        assert_eq!(d.blocks.len(), 1);
        assert_eq!(d.blocks[0], Block::Paragraph(vec![Span::Text("Body.".into())]));
    }

    #[test]
    fn leading_h1_becomes_title_and_is_not_duplicated() {
        let d = p("# Chapter One\n\nText.");
        assert_eq!(d.title, "Chapter One");
        assert_eq!(d.blocks.len(), 1, "H1 consumed as title: {:?}", d.blocks);
    }

    #[test]
    fn horizontal_rule_is_not_frontmatter() {
        // A rule between paragraphs is a Rule block, not a metadata fence.
        // (A fence must be the FIRST thing in the source; pulldown-cmark
        // also treats `---` right after a paragraph line as a setext H2.)
        let d = p("Intro.\n\n***\n\nAfter.");
        assert_eq!(d.title, "Fallback", "a mid-document rule is not metadata");
        assert!(
            d.blocks.iter().any(|b| matches!(b, Block::Rule)),
            "expected a Rule block, got {:?}",
            d.blocks
        );
    }

    #[test]
    fn markdown_emphasis_is_not_literal_text() {
        // Guards a wrong assumption: `*stars*` really is emphasis, so the
        // model drops the markers. Typst/HTML metacharacter escaping is the
        // writers' job, verified in their own tests.
        let d = p("Costs $5 and *stars* and _under_.");
        let plain = spans_to_plain(match &d.blocks[0] {
            Block::Paragraph(s) => s,
            other => panic!("expected paragraph, got {:?}", other),
        });
        assert_eq!(plain, "Costs $5 and stars and under.");
        // A backslash-escaped marker survives as literal text.
        let esc = p("literal \\*stars\\* here");
        let plain = spans_to_plain(match &esc.blocks[0] {
            Block::Paragraph(s) => s,
            other => panic!("expected paragraph, got {:?}", other),
        });
        assert!(plain.contains("*stars*"), "got {:?}", plain);
    }

    #[test]
    fn emphasis_nests() {
        let d = p("A **bold and *nested* word** end.");
        let Block::Paragraph(spans) = &d.blocks[0] else {
            panic!("expected paragraph, got {:?}", d.blocks[0])
        };
        let Span::Strong(inner) = &spans[1] else {
            panic!("expected strong, got {:?}", spans[1])
        };
        // ["bold and ", Emph("nested"), " word"]
        assert_eq!(inner.len(), 3, "{:?}", inner);
        assert!(matches!(inner[1], Span::Emph(_)), "{:?}", inner[1]);
    }

    #[test]
    fn links_keep_href_and_text() {
        let d = p("See [the docs](https://example.com/x?a=1&b=2).");
        let Block::Paragraph(spans) = &d.blocks[0] else {
            panic!("expected paragraph")
        };
        let Span::Link { spans, href } = &spans[1] else {
            panic!("expected link, got {:?}", spans[1])
        };
        assert_eq!(href, "https://example.com/x?a=1&b=2");
        assert_eq!(spans_to_plain(spans), "the docs");
    }

    #[test]
    fn ordered_and_bullet_lists() {
        let d = p("- one\n- two\n\n1. first\n2. second");
        let lists: Vec<_> = d
            .blocks
            .iter()
            .filter_map(|b| match b {
                Block::List { ordered, items } => Some((*ordered, items.clone())),
                _ => None,
            })
            .collect();
        assert_eq!(lists.len(), 2);
        assert!(!lists[0].0);
        assert!(lists[1].0);
        assert_eq!(lists[0].1.len(), 2);
        assert_eq!(spans_to_plain(match &lists[0].1[0][0] {
            Block::Paragraph(s) => s,
            other => panic!("expected paragraph in item, got {:?}", other),
        }), "one");
    }

    #[test]
    fn nested_list_items_hold_sub_lists() {
        let d = p("- outer\n  - inner\n- outer2");
        let Block::List { items, .. } = &d.blocks[0] else {
            panic!("expected list")
        };
        assert_eq!(items.len(), 2);
        assert!(
            items[0].iter().any(|b| matches!(b, Block::List { .. })),
            "outer item should contain the nested list: {:?}",
            items[0]
        );
    }

    #[test]
    fn blockquote_collects_blocks() {
        let d = p("> quoted line\n>\n> second para");
        let Block::Quote(inner) = &d.blocks[0] else {
            panic!("expected quote, got {:?}", d.blocks[0])
        };
        assert_eq!(inner.len(), 2, "{:?}", inner);
    }

    #[test]
    fn fenced_code_keeps_lang_and_body() {
        let d = p("```rust\nlet x = 1;\n```");
        assert_eq!(
            d.blocks[0],
            Block::Code {
                lang: Some("rust".into()),
                text: "let x = 1;\n".into()
            }
        );
    }

    #[test]
    fn images_become_inline_spans_with_alt_and_src() {
        let d = p("![a cat](img/cat.png)");
        let Block::Paragraph(spans) = &d.blocks[0] else {
            panic!("expected paragraph")
        };
        assert_eq!(
            spans[0],
            Span::Image {
                alt: "a cat".into(),
                src: "img/cat.png".into()
            }
        );
    }

    #[test]
    fn dollar_and_hash_text_reaches_the_model() {
        // `$`, `#`, `@`, `<`, `>` are literal in markdown and MUST survive
        // parsing intact - the writers escape them for their own syntax.
        let d = p("Costs $5, item #7, mail@example.com, 3 < 5 and 6 > 2.");
        let plain = spans_to_plain(match &d.blocks[0] {
            Block::Paragraph(s) => s,
            other => panic!("expected paragraph, got {:?}", other),
        });
        assert_eq!(
            plain,
            "Costs $5, item #7, mail@example.com, 3 < 5 and 6 > 2."
        );
    }

    #[test]
    fn empty_input_is_still_a_valid_doc() {
        let d = p("");
        assert_eq!(d.title, "Fallback");
        assert!(d.blocks.is_empty());
    }
}