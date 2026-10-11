/**
 * shortcuts.ts — single source of truth for the keyboard-shortcut cheat sheets.
 *
 * SHORTCUT_GROUPS feeds KeyboardShortcuts.svelte; SHORTCUT_FLAT feeds
 * HelpOverlay.svelte. Both derive from the same data so the two sheets can
 * never drift apart again.
 *
 * Contract: every row here MUST have a real handler somewhere in src/. The
 * audit that produced this list is captured in docs/PLANS/2026-10-09-ux-polish.md
 * (Phase 4, item 4.5). When you add a binding, add the row here in the same
 * change — this module is the contract, not the documentation.
 *
 * Notes on a few rows, so nobody "fixes" them back into lies:
 *  - Ctrl+B / Ctrl+I are App-level sidebar/outline toggles. App.svelte's
 *    window keydown listener calls preventDefault() before CodeMirror's
 *    defaultKeymap can reach its own Mod-b/Mod-i bold/italic bindings, so
 *    bold/italic are unreachable by keyboard. Listed here as they really
 *    behave, not as the editor library would like them to.
 *  - Ctrl+F is the real CodeMirror searchKeymap binding (EditorPane +
 *    JustWrite both spread searchKeymap). JustWrite has no
 *    defaultKeymap, so it has no Ctrl+Z/Ctrl+Shift+Z either.
 */

import { isBrowserPreview } from "$lib/api";

export interface ShortcutItem {
  keys: string;
  desc: string;
}

export interface ShortcutGroup {
  category: string;
  items: ShortcutItem[];
}

/** The save shortcut's wording differs between the web preview and desktop. */
function saveDesc(): string {
  return isBrowserPreview() ? "Force save to browser storage" : "Force save to disk";
}

/** Grouped view — feeds KeyboardShortcuts.svelte. */
export const SHORTCUT_GROUPS: ShortcutGroup[] = [
  {
    category: "General",
    items: [
      { keys: "Ctrl+K", desc: "Command palette — fuzzy search docs, actions, AI ops" },
      { keys: "Ctrl+B", desc: "Toggle sidebar" },
      { keys: "Ctrl+J", desc: "Toggle AI panel" },
      { keys: "Ctrl+I", desc: "Toggle outline & links" },
      { keys: "F11", desc: "Zen mode — editor only" },
      { keys: "?", desc: "Toggle the help overlay" },
      { keys: "Esc", desc: "Close panel / modal / reading mode / zen mode" },
    ],
  },
  {
    category: "Navigation",
    items: [
      { keys: "Ctrl+Tab", desc: "Next tab" },
      { keys: "Ctrl+Shift+Tab", desc: "Previous tab" },
      { keys: "Ctrl+T", desc: "New tab (Ctrl+T in an editor inserts a timestamp)" },
      { keys: "Ctrl+W", desc: "Close tab" },
    ],
  },
  {
    category: "Editor",
    items: [
      { keys: "Ctrl+F", desc: "Find & replace in the open editor" },
      { keys: "Ctrl+Shift+F", desc: "Quick capture to Capture from anywhere" },
      { keys: "Ctrl+S", desc: saveDesc() },
      { keys: "Ctrl+Shift+S", desc: "Structurize the selection with AI" },
      { keys: "Ctrl+Z", desc: "Undo (Write tab only — the docked editor has no undo keymap)" },
      { keys: "Ctrl+Shift+Z", desc: "Redo (Write tab only)" },
      { keys: "Ctrl+= / Ctrl+-", desc: "Zoom in / out" },
      { keys: "Ctrl+0", desc: "Reset zoom" },
    ],
  },
  {
    category: "Voice",
    items: [
      { keys: "Ctrl+Shift+M", desc: "Start/stop dictation" },
      { keys: "Ctrl+Shift+A", desc: "Read aloud — play/pause (Esc stops)" },
      { keys: "Ctrl+Shift+↑ / ↓", desc: "Read-aloud speed faster / slower" },
    ],
  },
];

/** Flat view — feeds HelpOverlay.svelte. Same data, no grouping. */
export const SHORTCUT_FLAT: ShortcutItem[] = SHORTCUT_GROUPS.flatMap((g) => g.items);
