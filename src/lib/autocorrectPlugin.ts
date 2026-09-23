/**
 * autocorrectPlugin — the three deterministic autocorrect layers (A8.8)
 * shared by every editing surface, so behavior never drifts per editor.
 *
 * Layer 1 (substitution table): exact-typo match → auto-applied silently,
 *   reverted by a single undo. Runs on the just-typed word.
 * Layer 2 (character normalization): curly quotes, en/em dashes, ellipsis,
 *   double spaces, sentence-case "i" → auto-applied to the current line
 *   start..cursor on word boundaries. Deterministic string rules only.
 * Layer 3 (edit-distance-1): NEVER auto-applied (fiction is full of
 *   invented names) — shown as an underline decoration with the suggestion
 *   in the tooltip. Retype to keep your word; accept by typing it exactly.
 *
 * Custom dictionary: Story Bible facts (names/places) veto everything —
 * your own invented vocabulary is never flagged or "fixed".
 *
 * Effect-safety: the plugin only ever dispatches idempotent replacements
 * (a replaced word no longer matches, so update() terminates) and never
 * reads or writes Svelte state — callers pass plain callbacks.
 */
import {
  Decoration,
  EditorView,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import {
  getAutocorrectSuggestions,
  isKnownTypo,
  normalizeCharacters,
} from "./autocorrect";
import type { Doc } from "./api";

export interface AutocorrectHooks {
  enabled: () => boolean;
  useEnglishTable: () => boolean;
  getCustomWords: () => Set<string>;
}

const suggestMark = Decoration.mark({
  class: "cm-autocorrect-suggest",
  attributes: { title: "Autocorrect suggestion — keep typing to keep your word" },
});

function tokenizeFacts(text: string, into: Set<string>): void {
  for (const w of text.toLowerCase().split(/[^a-z\u00C0-\u024F']+/)) {
    if (w.length >= 2) into.add(w);
  }
}

/**
 * Collect bible-fact vocabulary for a doc: the doc itself plus ancestors
 * up the parent_id chain (chapter → project), so novel/scene docs inherit
 * their Story Bible names automatically.
 */
export async function loadBibleWords(
  doc: Doc | null,
  ports: {
    docGet: (id: string) => Promise<Doc>;
    bibleGetFacts: (docId: string) => Promise<{ key: string; value: string }[]>;
  }
): Promise<Set<string>> {
  const words = new Set<string>();
  if (!doc) return words;
  const ids: string[] = [];
  let cur: Doc | null = doc;
  let hops = 0;
  while (cur && hops++ < 6 && !ids.includes(cur.id)) {
    ids.push(cur.id);
    cur = cur.parent_id
      ? await ports.docGet(cur.parent_id).catch(() => null)
      : null;
  }
  for (const id of ids) {
    try {
      const facts = await ports.bibleGetFacts(id);
      for (const f of facts) {
        tokenizeFacts(`${f.key} ${f.value}`, words);
      }
    } catch {
      /* a missing bible is fine — fewer known words, same behavior */
    }
  }
  return words;
}

export function createAutocorrectPlugin(hooks: AutocorrectHooks) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private pendingFix = false;

      /**
       * Apply idempotent replacements one microtask AFTER the current
       * update cycle. view.dispatch() is illegal synchronously inside
       * ViewPlugin.update (CodeMirror throws "Calls to EditorView.update
       * are not allowed while an update is in progress" and the fix is
       * silently dropped) — deferring keeps Layer 1/2 corrections working.
       * Each fix is re-validated against the live doc so a deferred fix
       * can never clobber text the user typed in between.
       */
      private scheduleFixes(
        view: EditorView,
        fixes: { from: number; to: number; insert: string; expect: string }[]
      ) {
        if (this.pendingFix) return;
        this.pendingFix = true;
        queueMicrotask(() => {
          this.pendingFix = false;
          const valid: { from: number; to: number; insert: string }[] = [];
          for (const f of fixes) {
            try {
              if (f.to <= view.state.doc.length && view.state.sliceDoc(f.from, f.to) === f.expect) {
                valid.push({ from: f.from, to: f.to, insert: f.insert });
              }
            } catch {
              /* doc reshaped mid-flight: skip this fix */
            }
          }
          if (valid.length === 0) return;
          try {
            view.dispatch({ changes: valid, sequential: true });
          } catch {
            /* view destroyed mid-flight: drop the fix */
          }
        });
      }

      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (!hooks.enabled()) {
          this.decorations = Decoration.none;
          return;
        }
        const view = update.view;
        const state = view.state;
        const useEnglish = hooks.useEnglishTable();
        const custom = hooks.getCustomWords();
        const fixes: { from: number; to: number; insert: string; expect: string }[] = [];
        const suggests: { from: number; to: number }[] = [];

        update.changes.iterChangedRanges((_fromA, toA, _fromB, _toB) => {
          let lineText = "";
          let lineFrom = 0;
          try {
            const line = state.doc.lineAt(toA);
            lineText = line.text;
            lineFrom = line.from;
          } catch {
            return;
          }
          const cursorInLine = Math.max(0, Math.min(toA - lineFrom, lineText.length));
          const before = lineText.slice(0, cursorInLine);

          // Layer 2: normalize line start..cursor (idempotent — a second
          // pass finds nothing to change, so dispatch terminates).
          const normalized = normalizeCharacters(before);
          if (normalized !== before) {
            fixes.push({ from: lineFrom, to: lineFrom + before.length, insert: normalized, expect: before });
            return;
          }

          // Word-boundary layers on the just-typed word.
          const wordMatch = before.match(/([\p{L}']+)$/u);
          if (!wordMatch) return;
          const word = wordMatch[1];
          const lower = word.toLowerCase();
          if (custom.has(lower)) return; // your invented words are sacred
          const start = lineFrom + (before.length - word.length);

          // Layer 1: known-typo table → auto-apply.
          if (useEnglish && isKnownTypo(lower)) {
            const fixed = getAutocorrectSuggestions(lower, custom, true);
            if (fixed && fixed !== word) {
              fixes.push({ from: start, to: start + word.length, insert: fixed, expect: word });
              return;
            }
          }

          // Layer 3: single distance-1 candidate → underline only.
          const suggestion = getAutocorrectSuggestions(lower, custom, useEnglish);
          if (suggestion && suggestion.toLowerCase() !== lower) {
            suggests.push({ from: start, to: start + word.length });
          }
        });

        if (fixes.length > 0) {
          this.scheduleFixes(view, fixes);
          this.decorations = Decoration.none;
          return;
        }
        const last = suggests[suggests.length - 1];
        this.decorations = last
          ? Decoration.set([suggestMark.range(last.from, last.to)])
          : Decoration.none;
      }
    },
    { decorations: (v) => v.decorations }
  );
}
