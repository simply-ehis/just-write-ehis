/**
 * entities — deterministic local name/place extraction (no AI).
 *
 * PREVIEW MIRROR of doc_store.rs refresh_entities: same two passes —
 * (1) Story-Bible gazetteer (whole-phrase, case-insensitive; kind mapped
 * from the fact kind), then (2) capitalized 2–4 word runs for names the
 * Bible doesn't know yet, skipping a stoplist and gazetteer-claimed
 * spans, capped at 500 rows per doc. Keep the two in sync.
 */

export interface ExtractedEntity {
  norm: string;
  display: string;
  kind: string;
  start: number;
  end: number;
}

const STOPLIST = new Set([
  "the", "a", "an", "and", "but", "or", "if", "then", "when", "while", "because",
  "chapter", "part", "scene", "act", "prologue", "epilogue", "interlude", "appendix",
  "book", "volume", "monday", "tuesday", "wednesday", "thursday", "friday",
  "saturday", "sunday", "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
]);

export function mapEntityKind(kind: string): string {
  const k = kind.toLowerCase();
  if (k.includes("character")) return "person";
  if (k.includes("setting") || k.includes("location") || k.includes("place")) return "place";
  return "term";
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function extractEntities(
  content: string,
  gazetteer: { kind: string; key: string }[]
): ExtractedEntity[] {
  const rows: ExtractedEntity[] = [];
  const used: [number, number][] = [];
  const overlaps = (s: number, e: number) => used.some(([a, b]) => s < b && a < e);

  // Pass 1 — gazetteer.
  for (const fact of gazetteer) {
    const key = (fact.key || "").trim();
    if (key.length < 2) continue;
    const kind = mapEntityKind(fact.kind || "");
    let re: RegExp;
    try {
      re = new RegExp(`(?:^|\\W)(${escRe(key)})(?=\\W|$)`, "gi");
    } catch {
      continue;
    }
    let m: RegExpExecArray | null;
    re.lastIndex = 0;
    while ((m = re.exec(content)) !== null) {
      const surface = m[1];
      const start = m.index + m[0].indexOf(surface);
      const end = start + surface.length;
      if (overlaps(start, end)) continue;
      used.push([start, end]);
      rows.push({ norm: key.toLowerCase(), display: surface, kind, start, end });
      if (rows.length >= 500) break;
      // Avoid zero-width stalls on overlapping candidates.
      if (re.lastIndex === m.index) re.lastIndex++;
    }
    if (rows.length >= 500) break;
  }

  // Pass 2 — capitalized runs (ASCII; other scripts come via the gazetteer).
  if (rows.length < 500) {
    const seen = new Set(rows.map((r) => r.norm));
    const re = /\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const text = m[1];
      const first = (text.split(/\s+/)[0] || "").toLowerCase();
      if (STOPLIST.has(first)) continue;
      const start = m.index;
      const end = start + text.length;
      if (overlaps(start, end)) continue;
      used.push([start, end]);
      const norm = text.toLowerCase();
      if (!seen.has(norm)) {
        seen.add(norm);
        rows.push({ norm, display: text, kind: "name", start, end });
      }
      if (rows.length >= 500) break;
    }
  }
  return rows;
}

/** Context slice around a span for occurrence lists (display only). */
export function entitySnippet(content: string, start: number, end: number, radius = 60): string {
  const s = Math.max(0, start - radius);
  const e = Math.min(content.length, end + radius);
  const prefix = s > 0 ? "…" : "";
  const suffix = e < content.length ? "…" : "";
  return `${prefix}${content.slice(s, e).replace(/\s+/g, " ").trim()}${suffix}`;
}
