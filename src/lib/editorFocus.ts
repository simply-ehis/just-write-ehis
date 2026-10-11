import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { RangeSet } from "@codemirror/state";

const focusMark = Decoration.mark({ class: "cm-focus-dimmed" });

export interface FocusDimOptions {
  isEnabled: () => boolean;
  getContextLines: () => number;
}

/**
 * Dims everything outside the cursor neighborhood. Shared by Write and
 * the docked editor so focus dimming behaves identically everywhere.
 * (Requires a `.cm-focus-dimmed` rule in the editor theme.)
 */
export function focusDimmingPlugin(options: FocusDimOptions) {
  const { isEnabled, getContextLines } = options;
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
        const contextLines = getContextLines();
        const selStartLine = doc.lineAt(selection.from).number;
        const selEndLine = doc.lineAt(selection.to).number;
        const focusStartLine = Math.max(1, selStartLine - contextLines);
        const focusEndLine = Math.min(doc.lines, selEndLine + contextLines);
        const focusStart = doc.line(focusStartLine).from;
        const focusEnd = doc.line(focusEndLine).to;
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
  } catch (e) {
    console.warn(`Failed to load focus prefs for ${docId}:`, e);
  }
  return { ...defaults };
}

export function saveFocusPrefs(docId: string, prefs: FocusPrefs): void {
  try {
    localStorage.setItem(
      `jwe-focus-${docId}`,
      JSON.stringify({ typewriter: prefs.typewriter, focus: prefs.focus })
    );
  } catch (e) {
    console.warn(`Failed to save focus prefs for ${docId}:`, e);
  }
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
    // Dead-zone: don't scroll while the cursor is within the middle band
    // (~±20% of the container). Otherwise every keystroke fights the user.
    const deadZone = containerRect.height * 0.2;
    if (Math.abs(scrollDiff) <= deadZone) return;
    // Instant jump: smooth scrolling queues on every keystroke and reduced-
    // motion users get the same behavior for free.
    container.scrollBy({ top: scrollDiff, behavior: "auto" });
  }
}
