/**
 * ttsFollow — read-aloud position feedback for CodeMirror editors (3.9).
 *
 * Ports the Reader's per-section highlight + scroll-follow to the editing
 * surfaces: while ReadAloudButton reads a section, its heading line is
 * marked and scrolled into view. Pure view-layer — no doc changes, so the
 * save pipeline never sees a dispatch.
 */
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";
import { splitSections, sectionText } from "$lib/readerSections";

/** Set the current read-aloud heading range (null = nothing playing). */
export const setTtsSection = StateEffect.define<{ from: number; to: number } | null>();

const sectionMark = Decoration.line({ class: "cm-tts-current" });

const ttsSectionField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setTtsSection)) {
        return e.value
          ? Decoration.set([sectionMark.range(e.value.from, e.value.to)])
          : Decoration.none;
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

export const ttsFollow = [ttsSectionField];

/** A TTS section plus the source range of its heading line. */
export interface PositionedSection {
  id: string;
  title: string;
  text: string;
  /** Char offsets of the heading line start/end in the markdown source
   * (prologue starts at 0; its range is the first line's). */
  from: number;
  to: number;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Split `content` into TTS sections carrying source offsets. Walks the
 * headings in document order alongside splitSections' output, so
 * duplicate titles still pair with the right occurrence.
 */
export function positionedSections(content: string): PositionedSection[] {
  const sections = splitSections(content);
  const out: PositionedSection[] = [];
  let cursor = 0;
  for (const s of sections) {
    const text = sectionText(s);
    // The prologue ("Top") has no heading — it starts at the cursor.
    if (s.id === "top" && s.title === "Top") {
      out.push({ id: s.id, title: s.title, text, ...lineRange(cursor, content) });
      continue;
    }
    const re = new RegExp(`^#{1,3}\\s+${escapeRe(s.title)}\\s*$`, "m");
    const m = re.exec(content.slice(cursor));
    const from = m ? cursor + m.index : cursor;
    out.push({ id: s.id, title: s.title, text, ...lineRange(from, content) });
    if (m) cursor = from;
  }
  return out;
}

/** Start/end offsets of the single line containing `pos`. */
function lineRange(pos: number, content: string): { from: number; to: number } {
  const nl = content.indexOf("\n", pos);
  return { from: pos, to: nl === -1 ? content.length : nl };
}

/**
 * Highlight + scroll the section being read. Call from ReadAloudButton's
 * onSection; idx null clears the highlight.
 */
export function followTtsSection(
  view: EditorView,
  sections: PositionedSection[],
  idx: number | null,
): void {
  if (idx == null || idx < 0 || idx >= sections.length) {
    view.dispatch({ effects: setTtsSection.of(null) });
    return;
  }
  const { from, to } = sections[idx];
  view.dispatch({
    effects: [setTtsSection.of({ from, to }), EditorView.scrollIntoView(from, { y: "center" })],
  });
}
