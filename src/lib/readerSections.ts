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

/** Split speech into sentence-sized items while joining soft line wraps. */
export function sentenceChunks(text: string, maxChars = 5000): string[] {
  const normalized = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join(" ");
  const sentences = normalized.match(/[^.!?。！？]+[.!?。！？]+["'”’)]*|[^.!?。！？]+$/g) ?? [];
  const out: string[] = [];
  for (const sentence of sentences) {
    let rest = sentence.trim();
    while (rest.length > maxChars) {
      let cut = rest.lastIndexOf(" ", maxChars);
      if (cut < Math.floor(maxChars * 0.6)) cut = maxChars;
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

// ── Render-ahead segmentation ─────────────────────────────────────
// Segments carry char offsets into the source snapshot plus a pause
// flag, so the backend can record a sample-accurate timeline and the
// highlight can map back to the document later.

export interface TtsSegment {
  /** Index within the final segment list — the render job's segId. */
  id: number;
  /** Speech text (markdown stripped, soft wraps joined). */
  text: string;
  /** Caller section this segment belongs to (-1 = plain/selection text). */
  sectionIdx: number;
  /** Inclusive start / exclusive end offsets into the source text. */
  charStart: number;
  charEnd: number;
  /** Silence class the renderer appends after this segment's audio. */
  pauseAfter: "sentence" | "paragraph" | "section";
}

/** Hard cap per segment (renderer wants ~sentence-sized units; long
 * sentences split at commas/semicolons, then spaces, then a hard cut). */
export const SEGMENT_MAX_CHARS = 200;

/** Speech text alongside the source index of every character — the
 * round-trip invariant: stripForTts(source.slice(charStart, charEnd))
 * contains the segment's spoken words. */
interface MappedText {
  text: string;
  map: number[];
}

/** Apply one of stripForTts's removal rules, keeping the source map:
 * replacement characters borrow source positions from the match. */
function mapReplace(
  m: MappedText,
  re: RegExp,
  repl: (match: RegExpExecArray) => string,
): MappedText {
  const flags = re.flags.includes("g") ? re.flags : re.flags + "g";
  const rx = new RegExp(re.source, flags);
  let out = "";
  const outMap: number[] = [];
  let last = 0;
  let match: RegExpExecArray | null;
  while ((match = rx.exec(m.text))) {
    if (match[0].length === 0) {
      rx.lastIndex++;
      continue;
    }
    out += m.text.slice(last, match.index);
    outMap.push(...m.map.slice(last, match.index));
    const replacement = repl(match);
    out += replacement;
    for (let j = 0; j < replacement.length; j++) {
      // Cycle match positions: replacement chars stay inside the match's
      // source span, which is all segment boundaries need.
      const src = match.index + (j < match[0].length ? j : match[0].length - 1);
      outMap.push(m.map[src]);
    }
    last = match.index + match[0].length;
    // Overlapping-empty protection is handled above; advance for zero-width.
    if (match.index === rx.lastIndex) rx.lastIndex++;
  }
  out += m.text.slice(last);
  outMap.push(...m.map.slice(last));
  return { text: out, map: outMap };
}

/** Same rule set, same order as stripForTts — so offsets and the
 * reader's spoken text can never diverge. Applied per line, exactly as
 * stripForTts does, so ^-anchored rules behave identically. */
function stripLine(m: MappedText): MappedText {
  const rules: [RegExp, (x: RegExpExecArray) => string][] = [
    [/^#{1,6}\s+/, () => ""],
    [/^>\s?/, () => ""],
    [/^(\s*[-*]|\s*\d+\.)\s+/, () => ""],
    [/\*\*(.+?)\*\*/g, (x) => x[1]],
    [/__(.+?)__/g, (x) => x[1]],
    [/\*(.+?)\*/g, (x) => x[1]],
    [/`(.+?)`/g, (x) => x[1]],
    [/!\[([^\]]*)\]\([^)]*\)/g, (x) => x[1]],
    [/\[([^\]]*)\]\([^)]*\)/g, (x) => x[1]],
  ];
  for (const [re, repl] of rules) m = mapReplace(m, re, repl);
  return m;
}

function stripMapped(m: MappedText): MappedText {
  // Split into lines (keeping maps), strip each exactly like stripForTts,
  // drop empties, join with a mapped "\n" — the spoken text then matches
  // stripForTts(source) character for character except for whitespace
  // runs.
  const lines: MappedText[] = [];
  let start = 0;
  const pushLine = (end: number) => {
    lines.push({ text: m.text.slice(start, end), map: m.map.slice(start, end) });
    start = end;
  };
  for (let i = 0; i <= m.text.length; i++) {
    if (i === m.text.length || m.text[i] === "\n") {
      pushLine(i);
      start = i + 1;
    }
  }
  const kept: MappedText[] = [];
  for (const line of lines) {
    const stripped = trimMapped(stripLine(line));
    if (stripped.text.trim()) kept.push(stripped);
  }
  const out: MappedText = { text: "", map: [] };
  kept.forEach((line, i) => {
    if (i > 0) {
      // The join character borrows the source index right after the line.
      const src = line.map[0] - 1;
      out.text += "\n";
      out.map.push(src >= 0 ? src : line.map[0]);
    }
    out.text += line.text;
    out.map.push(...line.map);
  });
  return out;
}

function mappedSlice(m: MappedText, start: number, end: number): MappedText {
  return { text: m.text.slice(start, end), map: m.map.slice(start, end) };
}

function trimMapped(m: MappedText): MappedText {
  let s = 0;
  let e = m.text.length;
  while (s < e && /\s/.test(m.text[s])) s++;
  while (e > s && /\s/.test(m.text[e - 1])) e--;
  return mappedSlice(m, s, e);
}

/** Soft-wrap reflow inside a sentence: \n → space, char-for-char, so
 * the map survives untouched. Applied AFTER sentence slicing so line
 * boundaries can't swallow sentence terminators. */
function joinSoftWraps(m: MappedText): MappedText {
  const text = m.text.replace(/\n/g, " ");
  return { text, map: m.map }; // 1:1 in length per \n → space
}

const SENTENCE_RE = /[^.!?。！？]+[.!?。！？]+["'”’)]*|[^.!?。！？]+$/g;

/** Split mapped text on sentence terminators, preserving the map. */
function sentenceSlices(m: MappedText): MappedText[] {
  const out: MappedText[] = [];
  SENTENCE_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SENTENCE_RE.exec(m.text))) {
    if (match[0].trim()) out.push(trimMapped(mappedSlice(m, match.index, match.index + match[0].length)));
    if (match.index === SENTENCE_RE.lastIndex) SENTENCE_RE.lastIndex++;
  }
  return out;
}

/** Hard cap: cut at the last comma/semicolon/dash before maxChars when
 * it's late enough, else the last space, else a hard cut. */
function capSegment(m: MappedText, maxChars: number): MappedText[] {
  if (m.text.length <= maxChars) return [m];
  const parts: MappedText[] = [];
  let rest = m;
  while (rest.text.length > maxChars) {
    const window = rest.text.slice(0, maxChars);
    let cut = -1;
    for (const punct of [",", ";", "—", "–", ":"]) {
      const at = window.lastIndexOf(punct);
      if (at >= Math.floor(maxChars * 0.6) && at > cut) cut = at + 1;
    }
    if (cut < 0) {
      const at = window.lastIndexOf(" ");
      cut = at >= Math.floor(maxChars * 0.6) ? at : maxChars;
    }
    const head = trimMapped(mappedSlice(rest, 0, cut));
    if (head.text) parts.push(head);
    rest = trimMapped(mappedSlice(rest, cut, rest.text.length));
  }
  if (rest.text) parts.push(rest);
  return parts;
}

/**
 * Split one source text into render segments with source offsets.
 * Paragraph breaks become "paragraph" pauses; everything else is a
 * sentence pause. Ids are assigned in list order (reassembled by
 * `segmentsForSections` when several sources are concatenated).
 */
export function splitSegments(
  source: string,
  opts: { sectionIdx?: number } = {},
): Omit<TtsSegment, "id">[] {
  const sectionIdx = opts.sectionIdx ?? -1;
  // Paragraph spans: runs separated by 2+ newlines, offsets into source.
  const spans: { start: number; end: number }[] = [];
  const sep = /\n{2,}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = sep.exec(source))) {
    spans.push({ start: last, end: m.index });
    last = m.index + m[0].length;
  }
  spans.push({ start: last, end: source.length });

  const out: Omit<TtsSegment, "id">[] = [];
  for (const span of spans) {
    const raw = source.slice(span.start, span.end);
    if (!raw.trim()) continue;
    const mapped: MappedText = {
      text: raw,
      map: raw.split("").map((_, i) => span.start + i),
    };
    const stripped = trimMapped(stripMapped(mapped));
    if (!stripped.text.trim()) continue;
    const sentences = sentenceSlices(stripped);
    for (let i = 0; i < sentences.length; i++) {
      const sentence = trimMapped(joinSoftWraps(sentences[i]));
      for (const piece of capSegment(sentence, SEGMENT_MAX_CHARS)) {
        if (!piece.text.trim()) continue;
        out.push({
          text: piece.text,
          sectionIdx,
          charStart: piece.map[0],
          charEnd: piece.map[piece.map.length - 1] + 1,
          pauseAfter: i === sentences.length - 1 ? "paragraph" : "sentence",
        });
      }
    }
  }
  return out;
}

/** Concatenate per-section segment lists; ids become global indexes and
 * the last segment of each section pauses like a section break. */
export function segmentsForSections(
  sections: { text: string }[],
): TtsSegment[] {
  const flat: TtsSegment[] = [];
  if (sections.length === 0) return flat;
  sections.forEach((section, sectionIdx) => {
    const segs = splitSegments(section.text, { sectionIdx });
    for (const s of segs) flat.push({ ...s, id: flat.length });
    const lastOfSection = flat[flat.length - 1];
    if (lastOfSection && lastOfSection.sectionIdx === sectionIdx) {
      lastOfSection.pauseAfter = "section";
    }
  });
  return flat;
}

/** Build segments from plain text (selection / docs without sections). */
export function segmentsForText(text: string): TtsSegment[] {
  return splitSegments(text).map((s, i) => ({ ...s, id: i }));
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
