import { writable, get } from "svelte/store";
import { EditorView } from "@codemirror/view";
import { domainError } from "$lib/errors";

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

  // Tiny FIFO queue (not last-wins): rapid Insert/Replace/Append clicks
  // used to overwrite the single slot and silently drop all but the last
  // event. The head is what subscribers see; clear() advances to the next
  // queued event instead of nulling. Consumers are unchanged — they still
  // read one event and clear it (guarded by docId as before).
  const queue: WriteBackEvent[] = [];

  function pump() {
    set(queue.length > 0 ? queue[0] : null);
  }

  function push(action: WriteBackAction, content: string, docId?: string | null) {
    queue.push({
      id: `wb-${++_id}`,
      action,
      content,
      docId: docId ?? null,
      timestamp: Date.now(),
    });
    pump();
  }

  return {
    subscribe,

    /** Insert text at the editor's current cursor position */
    insert(content: string, docId?: string | null) {
      push("insert", content, docId);
    },

    /** Replace the editor's current selection */
    replace(content: string, docId?: string | null) {
      push("replace", content, docId);
    },

    /** Append text to the end of the document */
    append(content: string, docId?: string | null) {
      push("append", content, docId);
    },

    /** Copy text to clipboard (handled by AiPanel directly, but available here for consistency) */
    copy(content: string) {
      // A failed copy that looks successful pastes stale text — say so.
      navigator.clipboard.writeText(content).catch((e) => domainError("AI", "couldn't copy to clipboard", e));
    },

    /** Clear the processed head event, advancing to the next queued one */
    clear() {
      queue.shift();
      pump();
    },

    /** Queued depth (introspection for tests/diagnostics). */
    depth() {
      return queue.length;
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
