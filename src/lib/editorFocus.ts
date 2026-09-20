import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";

const focusMark = Decoration.mark({ class: "cm-focus-dimmed" });

/**
 * Dims everything outside the cursor neighborhood. Shared by Write and
 * the docked editor so focus dimming behaves identically everywhere.
 * (Requires a `.cm-focus-dimmed` rule in the editor theme.)
 */
export function focusDimmingPlugin(isEnabled: () => boolean) {
  return ViewPlugin.fromClass(
    class {
      decorations: RangeSet<Decoration>;
      constructor(view: EditorView) {
        this.decorations = this.computeDecorations(view);
      }
      update(update: ViewUpdate) {
        if (update.docChanged || update.selectionSet) {
          this.decorations = this.computeDecorations(update.view);
        }
      }
      computeDecorations(view: EditorView): RangeSet<Decoration> {
        if (!isEnabled()) return RangeSet.empty;
        const selection = view.state.selection.main;
        const doc = view.state.doc;
        const builder: { from: number; to: number; value: Decoration }[] = [];
        const contextLines = 2;
        const focusStart = Math.max(0, selection.from - contextLines * 100);
        const focusEnd = Math.min(doc.length, selection.to + contextLines * 100);
        if (focusStart > 0) {
          builder.push({ from: 0, to: focusStart, value: focusMark });
        }
        if (focusEnd < doc.length) {
          builder.push({ from: focusEnd, to: doc.length, value: focusMark });
        }
        return RangeSet.of(builder);
      }
    },
    { decorations: (v) => v.decorations }
  );
}

export interface FocusPrefs {
  typewriter: boolean;
  focus: boolean;
}

/** Per-doc focus prefs: global defaults apply until toggled per doc. */
export function loadFocusPrefs(
  docId: string,
  defaults: FocusPrefs
): FocusPrefs {
  try {
    const raw = localStorage.getItem(`jwe-focus-${docId}`);
    if (raw) {
      const p = JSON.parse(raw);
      return {
        typewriter: p.typewriter ?? defaults.typewriter,
        focus: p.focus ?? defaults.focus,
      };
    }
  } catch {}
  return { ...defaults };
}

export function saveFocusPrefs(docId: string, prefs: FocusPrefs): void {
  try {
    localStorage.setItem(
      `jwe-focus-${docId}`,
      JSON.stringify({ typewriter: prefs.typewriter, focus: prefs.focus })
    );
  } catch {}
}

/** Keep the cursor vertically centered while typewriter mode is on. */
export function centerCursorIn(
  view: EditorView | null,
  container: HTMLElement | undefined
): void {
  if (!view || !container) return;
  const pos = view.state.selection.main.head;
  const coords = view.coordsAtPos(pos);
  if (coords) {
    const containerRect = container.getBoundingClientRect();
    const targetY = containerRect.height / 2;
    const currentY = coords.top - containerRect.top;
    const scrollDiff = currentY - targetY;
    container.scrollBy({ top: scrollDiff, behavior: "smooth" });
  }
}
