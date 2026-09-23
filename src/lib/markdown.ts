/**
 * markdown — tiny client-side markdown→HTML fragment renderer.
 *
 * Shared by transclusion embeds (transclude.ts) and the browser export
 * fallback (browserBackend.ts convertMarkdown), so the two never drift
 * apart again. Scope is deliberately small: headings, bold/italic/code,
 * unordered + ordered lists, blockquotes, paragraphs. Full fidelity
 * (tables, footnotes, images) belongs to the Rust pulldown-cmark path
 * (convert.rs) and pandoc — this is the offline/preview fallback.
 */

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function inline(md: string): string {
  return esc(md)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/__(.+?)__/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/`(.+?)`/g, "<code>$1</code>");
}

/**
 * Render markdown to an HTML fragment (no <html> wrapper).
 *
 * IMAGE RULE (deliberately narrow): only the exact `(dropped-image)`
 * target — emitted by bookparse for images stripped at import — renders
 * as a captioned placeholder. Real `![alt](url)` stays literal text,
 * exactly as before, so transclusions and the export fallback (the other
 * two consumers of this module) see zero behavior change.
 */
const DROPPED_IMAGE_RE = /^!\[([^\]]*)\]\(dropped-image\)\s*$/;

export function markdownToHtmlFragment(md: string): string {
  const lines = md.split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length === 0) return;
    out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) {
      out.push(`</${list}>`);
      list = null;
    }
  };

  for (const raw of lines) {
    const line = raw;
    const dropped = line.match(DROPPED_IMAGE_RE);
    if (dropped) {
      flushPara();
      flushList();
      const alt = esc(dropped[1].trim() || "image");
      out.push(
        `<figure class="img-missing"><div class="img-missing-box" aria-hidden="true"></div><figcaption>${alt} — image not imported</figcaption></figure>`
      );
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.+)/);
    const ulm = line.match(/^\s*[-*]\s+(.+)/);
    const olm = line.match(/^\s*\d+\.\s+(.+)/);
    const qm = line.match(/^\s*>\s?(.*)/);
    if (h) {
      flushPara();
      flushList();
      out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`);
    } else if (ulm) {
      flushPara();
      if (list !== "ul") {
        flushList();
        out.push("<ul>");
        list = "ul";
      }
      out.push(`<li>${inline(ulm[1])}</li>`);
    } else if (olm) {
      flushPara();
      if (list !== "ol") {
        flushList();
        out.push("<ol>");
        list = "ol";
      }
      out.push(`<li>${inline(olm[1])}</li>`);
    } else if (qm) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(qm[1])}</blockquote>`);
    } else if (line.trim() === "" || line.trim() === "---" || line.trim() === "***") {
      flushPara();
      flushList();
    } else {
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out.join("\n");
}
