/**
 * readerSections — pure helpers for the Reader's structured flow.
 *
 * The stored doc body is markdown (possibly with transclude-island HTML
 * mixed in by processTransclusions, fenced by `::transclude::` sentinels).
 * This module splits it into sections (headings + islands), strips
 * markdown for speech, chunks long sections for TTS, and computes
 * heading-anchored reading positions — all without DOM, so every
 * function is unit-testable headlessly.
 */

export interface ReaderSection {
  /** Stable slug for anchoring (prologues get "top"). */
  id: string;
  title: string;
  /** Raw markdown chunks in order: {type:"md"} or {type:"html"} islands. */
  parts: { type: "md" | "html"; text: string }[];
}

export interface ReaderAnchor {
  /** Section id, or null for pure-ratio fallback. */
  section: string | null;
  /** 0..1 offset within the section (or the whole doc for fallback). */
  ratio: number;
}

const SENTINEL_RE = /\n\n::transclude::.*?::\n\n/g;

function slugify(text: string, used: Set<string>): string {
  let base =
    text
      .toLowerCase()
      .replace(/[^a-z0-9\u00C0-\u024F\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .slice(0, 60) || "section";
  let id = base;
  let n = 2;
  while (used.has(id)) id = `${base}-${n++}`;
  used.add(id);
  return id;
}

/**
 * Split mixed markdown into sections on #{1,3} headings. Transclude
 * islands (sentinel-fenced HTML) attach to the preceding section whole —
 * headings inside islands never split. Text before the first heading is
 * the "top" prologue section.
 */
export function splitSections(mixed: string): ReaderSection[] {
  const used = new Set<string>();
  const sections: ReaderSection[] = [];
  let current: ReaderSection = { id: slugify("top", used), title: "Top", parts: [] };

  const pushMd = (text: string) => {
    if (!text) return;
    const last = current.parts[current.parts.length - 1];
    if (last && last.type === "md") last.text += text;
    else current.parts.push({ type: "md", text });
  };

  // Cut the mixed source on sentinels: processTransclusions wraps each
  // island as SENTINEL + html + SENTINEL, so split tokens alternate
  // md, island, md, island … starting and ending with md.
  const tokens = mixed.split(SENTINEL_RE);
  const spans: { type: "md" | "html"; text: string }[] = tokens.map((text, i) => ({
    type: i % 2 === 1 ? "html" : "md",
    text,
  }));

  // Now split md spans on headings; islands ride along untouched.
  for (const s of spans) {
    if (s.type === "html") {
      current.parts.push({ type: "html", text: s.text });
      continue;
    }
    const lines = s.text.split("\n");
    let buf: string[] = [];
    const flush = () => {
      if (buf.length > 0) {
        pushMd(buf.join("\n") + "\n");
        buf = [];
      }
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,3})\s+(.+?)\s*$/);
      if (h) {
        flush();
        sections.push(current);
        const title = h[2].replace(/\s+#+\s*$/, "");
        current = { id: slugify(title, used), title, parts: [] };
        buf.push(line);
      } else {
        buf.push(line);
      }
    }
    flush();
  }
  sections.push(current);
  // Drop a leading empty prologue (doc starts with a heading).
  if (
    sections.length > 1 &&
    sections[0].parts.every((p) => !p.text.trim())
  ) {
    sections.shift();
  }
  return sections;
}

/** Strip markdown syntax for speech (so TTS never reads "#" aloud). */
export function stripForTts(md: string): string {
  return md
    .split("\n")
    .map((line) => {
      let l = line
        .replace(/^#{1,6}\s+/, "")
        .replace(/^>\s?/, "")
        .replace(/^(\s*[-*]|\s*\d+\.)\s+/, "")
        .replace(/\*\*(.+?)\*\*/g, "$1")
        .replace(/__(.+?)__/g, "$1")
        .replace(/\*(.+?)\*/g, "$1")
        .replace(/`(.+?)`/g, "$1")
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
        .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
      return l.trim();
    })
    .filter(Boolean)
    .join("\n");
}

/** Plain readable text of a section (islands contribute their text). */
export function sectionText(section: ReaderSection): string {
  return stripForTts(
    section.parts
      .map((p) =>
        p.type === "md" ? p.text : p.text.replace(/<[^>]+>/g, " ")
      )
      .join("\n")
  );
}

/**
 * Split over-long text into paragraph-respecting chunks (TTS calls).
 * Single giant paragraphs fall back to a hard character cap.
 */
export function chunkText(text: string, maxChars = 6000): string[] {
  if (text.length <= maxChars) return [text];
  const paras = text.split(/\n{2,}|\n/);
  const chunks: string[] = [];
  let cur = "";
  for (const p of paras) {
    if ((cur + "\n" + p).trim().length <= maxChars) {
      cur = cur ? cur + "\n" + p : p;
    } else {
      if (cur.trim()) chunks.push(cur.trim());
      if (p.length <= maxChars) {
        cur = p;
      } else {
        for (let i = 0; i < p.length; i += maxChars) {
          chunks.push(p.slice(i, i + maxChars));
        }
        cur = "";
      }
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

/**
 * Anchor from a scroll snapshot: nearest section whose top is at/above
 * the viewport anchor line, plus the ratio within it. Pure math over
 * measured tops (no DOM reads) so reflow tests can drive it directly.
 */
export function anchorFor(
  sectionTops: { id: string; top: number; height: number }[],
  anchorY: number,
): ReaderAnchor {
  let current: { id: string; top: number; height: number } | null = null;
  for (const s of sectionTops) {
    if (s.top <= anchorY) current = s;
    else break;
  }
  if (!current || current.height <= 0) return { section: null, ratio: 0 };
  const ratio = Math.max(0, Math.min(1, (anchorY - current.top) / current.height));
  return { section: current.id, ratio };
}

/** Resolve an anchor back to a scrollTop (null = use global ratio). */
export function scrollTopFor(
  anchor: ReaderAnchor,
  sectionTops: { id: string; top: number; height: number }[],
  maxScroll: number,
): number | null {
  if (!anchor.section) return null;
  const s = sectionTops.find((x) => x.id === anchor.section);
  if (!s) return null;
  return Math.max(0, Math.min(maxScroll, s.top + anchor.ratio * s.height));
}
