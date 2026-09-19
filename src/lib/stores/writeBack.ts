import { writable, get } from "svelte/store";
import { EditorView } from "@codemirror/view";

export type WriteBackAction = "insert" | "replace" | "append" | "copy";

export interface WriteBackEvent {
  id: string;
  action: WriteBackAction;
  content: string;
  /** Doc the text belongs to — consumers ignore events for other docs. */
  docId: string | null;
  timestamp: number;
}

let _id = 0;

function createWriteBackStore() {
  const { subscribe, set } = writable<WriteBackEvent | null>(null);

  return {
    subscribe,

    /** Insert text at the editor's current cursor position */
    insert(content: string, docId?: string | null) {
      set({
        id: `wb-${++_id}`,
        action: "insert",
        content,
        docId: docId ?? null,
        timestamp: Date.now(),
      });
    },

    /** Replace the editor's current selection */
    replace(content: string, docId?: string | null) {
      set({
        id: `wb-${++_id}`,
        action: "replace",
        content,
        docId: docId ?? null,
        timestamp: Date.now(),
      });
    },

    /** Append text to the end of the document */
    append(content: string, docId?: string | null) {
      set({
        id: `wb-${++_id}`,
        action: "append",
        content,
        docId: docId ?? null,
        timestamp: Date.now(),
      });
    },

    /** Copy text to clipboard (handled by AiPanel directly, but available here for consistency) */
    copy(content: string) {
      navigator.clipboard.writeText(content).catch(() => {});
    },

    /** Clear the current event after an editor has processed it */
    clear() {
      set(null);
    },
  };
}

export const writeBack = createWriteBackStore();

/**
 * Apply one write-back event to a live editor view. Shared by every
 * editing surface so Insert/Replace/Append behave identically everywhere.
 */
export function applyWriteBackEvent(view: EditorView, event: WriteBackEvent): void {
  switch (event.action) {
    case "insert": {
      const pos = view.state.selection.main.head;
      view.dispatch({
        changes: { from: pos, insert: event.content },
        effects: EditorView.scrollIntoView(pos + event.content.length),
      });
      break;
    }
    case "replace": {
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: event.content },
        effects: EditorView.scrollIntoView(from + event.content.length),
      });
      break;
    }
    case "append": {
      const len = view.state.doc.length;
      view.dispatch({
        changes: { from: len, insert: "\n\n" + event.content },
        effects: EditorView.scrollIntoView(len + event.content.length),
      });
      break;
    }
    case "copy": {
      writeBack.copy(event.content);
      break;
    }
  }
  view.focus();
}
