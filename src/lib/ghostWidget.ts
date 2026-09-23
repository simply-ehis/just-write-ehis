/**
 * ghostWidget — inline ghost-autocomplete rendering (shared).
 *
 * The suggestion text lives in `ghostField` (set/cleared via
 * `setGhostEffect`); `ghostInlinePlugin` draws it as a greyed inline
 * widget at the live selection head, Copilot-style, so it tracks the
 * cursor instead of floating in a detached popup. Gating (enabled flag,
 * lock, workspace privacy) and Tab/Esc handling stay with the caller —
 * this module only renders.
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { StateEffect, StateField } from "@codemirror/state";

export const GHOST_INLINE_CLASS = "cm-ghost-inline";

/** Suggestion text, or null when no ghost is showing. */
export const setGhostEffect = StateEffect.define<string | null>();

export class GhostWidget extends WidgetType {
  readonly text: string;
  constructor(text: string) {
    super();
    this.text = text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = GHOST_INLINE_CLASS;
    span.textContent = this.text;
    span.title = "Ghost suggestion — Tab to accept, Esc to dismiss";
    return span;
  }
  eq(other: WidgetType): boolean {
    return other instanceof GhostWidget && other.text === this.text;
  }
}

export const ghostField = StateField.define<string | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setGhostEffect)) return e.value;
    }
    return value;
  },
});

export function computeGhostDecorations(view: EditorView): DecorationSet {
  let text: string | null = null;
  try {
    text = view.state.field(ghostField, false) as string | null;
  } catch {
    text = null;
  }
  if (!text) return Decoration.none;
  const widget = Decoration.widget({ widget: new GhostWidget(text), side: 1 });
  return Decoration.set([widget.range(view.state.selection.main.head)]);
}

export function ghostInlinePlugin() {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = computeGhostDecorations(view);
      }
      update(update: ViewUpdate) {
        this.decorations = computeGhostDecorations(update.view);
      }
    },
    { decorations: (v) => v.decorations }
  );
}
