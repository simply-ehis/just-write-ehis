/**
 * Quick-note helpers — pure functions behind the Quick note widget.
 *
 * The note format is deliberately identical to what the Logs tab's quick
 * capture writes ("## HH:MM" heading, blank line, text), so notes from the
 * widget and from the app are indistinguishable in the daily log.
 */

/** Local calendar day as YYYY-MM-DD (the key logGetOrCreate expects). */
export function dayKey(d: Date = new Date()): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** 24-hour HH:MM, zero-padded, in local time. */
export function clock(d: Date = new Date()): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** The block appended to the day's log. Empty/whitespace input yields "". */
export function noteBlock(timestamp: string, text: string): string {
  const body = text.trim();
  if (!body) return "";
  return `\n\n## ${timestamp}\n\n${body}\n`;
}

/** Append a note to a log body; returns the body unchanged for empty input. */
export function appendNote(existing: string | null | undefined, timestamp: string, text: string): string {
  const block = noteBlock(timestamp, text);
  return block ? `${existing ?? ""}${block}` : (existing ?? "");
}

/** The last `limit` timestamped notes in a log body, newest last. */
export function recentNotes(content: string | null | undefined, limit = 3): { time: string; text: string }[] {
  const notes: { time: string; text: string }[] = [];
  const re = /^## (\d{2}:\d{2})\s*\n+([\s\S]*?)(?=^## \d{2}:\d{2}\s*$|(?![\s\S]))/gm;
  for (const match of (content ?? "").matchAll(re)) {
    const text = match[2].trim();
    if (text) notes.push({ time: match[1], text });
  }
  // slice(-0) would return everything, so a zero limit is handled explicitly.
  return limit > 0 ? notes.slice(-limit) : [];
}
