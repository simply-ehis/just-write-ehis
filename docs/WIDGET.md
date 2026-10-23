PURPOSE: companion-widget design: what a widget is, which kinds exist, window and permission model
OWNS: widget kinds registry, the window frame, size/position memory, the widget permission set
READ-WHEN: adding a widget kind, changing widget size limits, touching widget permissions or the widget window config
KEY-FILES: src/WidgetApp.svelte, src/lib/widgets/registry.ts, src/lib/widgets/quickNote.ts, src/lib/components/widgets/, src-tauri/permissions/widget.toml, src-tauri/tauri.conf.json
INVARIANTS: a widget is a mini single-job version of a tab, never a window that hosts a tab; only registered kinds exist; the widget ACL is an exact allowlist of what the mini widgets call; the Reader widget never writes the main Reader's state
GOTCHAS: hidden does not mean destroyed; storage events synchronize non-secret settings; the window floor (minWidth/minHeight) lives in tauri.conf.json and must match WIDGET_MIN in registry.ts
UPDATED: 2026-10-21

# Companion widget

## What a widget is

A widget is a small, purpose-built mini version of a tab that does exactly ONE job. It is not a second window that opens a whole tab. If a job needs the calendar, the editor, the bookshelf, or any other part of the full tab, that job belongs in the app, and the widget's "open in app" button jumps there.

| Kind | Job | Opens in app |
|---|---|---|
| Quick note | Type a thought, Ctrl+Enter, it is appended to today's log in the same format the Logs tab writes | Logs |
| Reader | Read the book you are on, one section at a time (book picker, prev/next, text size) | Reader |

Only kinds listed in `src/lib/widgets/registry.ts` exist. Adding one means writing its mini component under `src/lib/components/widgets/` and adding it to the registry, the `widgetKind` setting enum, and `WIDGET_ALLOWED_COMMANDS` in `tests/widget-invariants.mjs`.

## Window model

`WidgetApp.svelte` is only a frame: a drag bar with open-in-app and hide, around the selected mini widget. It is a normal rectangle (no collapsed bubble, no edge docking). The OS enforces the minimum size from `tauri.conf.json` (280x180); the registry caps the maximum (720x1000) and gives each kind a first-run size. The widget remembers its last position and size (`widgetGeometry`, "x,y,w,h" in logical px) and only restores a position that is still reachable on a connected screen; otherwise it appears in the bottom-right corner. Its own placement is ignored by the move/resize listeners for 500 ms so it never saves its own echo.

Drafts: the Quick note box keeps an unsent draft in local storage, so hiding or quitting never loses typed text; a failed save keeps the text.

## Permissions

`permissions/widget.toml` is an exact allowlist: `app_boot_ready`, `log_get_or_create`, `doc_save`, `reader_get_bookshelf`. Nothing else: no AI, voice, memory, search, file-system, credential or vault commands. `tests/widget-invariants.mjs` asserts the set exactly, in both directions: a missing command fails at runtime, an extra one widens the surface for no feature.

## Handoff to the main app

The widget emits `widget-open-workspace` to `main` (`logs` or `reader`). Main validates the workspace id, shows and focuses itself, and the widget hides on `main-window-shown`. Failures come back as `widget-open-failed` and show in the widget bar.

## Verification

`npm run test:widgetkinds` (registry and note helpers), `npm run test:widgetdom` (boots the built widget in jsdom and drives both mini widgets against the real browser backend), `node tests/widget-invariants.mjs` (window config, ACL, structure). Native behaviour (drag, resize, restore position, tray show/hide, real memory use) must be checked on a Windows build.
