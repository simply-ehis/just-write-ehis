# Widget redesign notes (Oct 21, 2026)

> Archived record. This patch is **already applied** to the working tree — it no
> longer applies cleanly (`git apply --check` fails on every hunk; the new
> files `src/lib/widgets/registry.ts`, `src/lib/widgets/quickNote.ts` and
> `src/lib/components/widgets/*.svelte` already exist). Kept for provenance
> only; do not re-apply. Archived from the repo root on 2026-10-21.

Patch: `jwe-widget-redesign.patch` (18 files, applies cleanly to the zip you sent). Same files as a zip: `jwe-widget-redesign-files.zip`.

```
git apply --whitespace=nowarn jwe-widget-redesign.patch
npm run check
npm run build && npm run test:widgetdom
```

## What was wrong
The old widget was "make me a widget" answered with "a window that can open any tab". To make that work it needed the whole app behind it:
- `WidgetApp.svelte` hosted any of 12 tabs (519 lines of dock, bubble and resize logic)
- `EditorPane` carries a `companionMode` flag, used 20 times, to shrink a full editor
- `widget.toml` had been widened from 9 to 163 commands so every tab would work in the widget (AI, voice, memory, search, file system)

## What a widget is now
A frame around ONE mini single-job widget. Only registered kinds exist (`src/lib/widgets/registry.ts`):

| Kind | Job |
|---|---|
| Quick note | Type, Ctrl+Enter, appended to today's log in the exact Logs format. Unsent drafts survive hiding or quitting; a failed save keeps your text. |
| Reader | Read the book you're on, one section at a time: book picker, prev/next, text size. Keeps its own place and never writes the main Reader's position. |

- Normal rectangle, resizable, 280x180 minimum (set in `tauri.conf.json`, so the OS enforces it), opaque, no bubble, no edge docking. Remembers size and position, and only restores a position that is still on a connected screen.
- Permissions are now exactly four commands: `app_boot_ready`, `log_get_or_create`, `doc_save`, `reader_get_bookshelf`.
- Settings has one "Widget type" choice instead of workspace, dock edge and dock offset.
- Old settings keys stay in the schema (marked deprecated) so existing settings files don't break.

## Verified
`npm run check` shows the same 2 errors and 1 warning as your zip (below). New and updated tests all pass: `test:widgetkinds` (16), `test:widgetdom` (27, boots the built widget and drives both kinds over the real browser backend), widget-invariants, settings-validate. Smoke, onboarding, workspace-toggles, shell and markdown-preview suites pass. A before/after run of every test file shows no new failures. A unit test caught one real bug while I wrote this (a zero limit returned every note); it's fixed.

Tests I changed because they pinned the old design: `widget-invariants.mjs` (rewritten around the new model), `save-state.mjs` (the widget's failed-save message is now in Quick note).

## Needs your machine
Native behaviour can't be run here: drag, resize, restore position, tray show/hide, Open in app, real memory use. The window config changed (340x240 start, 280x180 minimum, `transparent: false`), so check that the first show appears bottom-right.

## Already broken in the zip you sent (not from this patch)
- `svelte-check`: `audio.ts` overrides type is missing `splitPattern` and `chunkSize` (2 errors).
- `tests/save-state.mjs`: "timers are nulled after the flush" fails.
- `npm run test:themes`: 3 failures (dark editor background and accent).
- `tests/sidecar-auth.mjs` and `tests/e2e-browser.mjs` need `src-tauri/sidecars/`, which isn't in the zip. — **resolved 2026-10-21**: the sidecar tree was hoisted to the repo root and has been moved back to `src-tauri/sidecars/`, `src-tauri/sidecars/models/`, `src-tauri/sidecars/bin/` and `src-tauri/binaries/`. `test:sidecarauth` passes again.

## Handoff H4: delete what the old widget left behind (Rust build needed)
> Remove `companionMode` from `EditorPane.svelte` (20 references) and the commands that existed only for it: `widget_doc_save`, `widget_atomic_save`, and their entries in `lib.rs`, `build.rs`, `permissions/main.toml`, `api.ts`. Keep `widget_doc_get` only if `widgetBridge.ts` still needs it for open-in-app validation, otherwise remove it too. Update `tests/widget-invariants.mjs` ("widget backend commands are narrow") and `tests/acl-parity.mjs`. Done when `cargo test`, `npm run check` and the existing suites pass.

## Where else the same mistake may be hiding
I only audited the widget. The pattern to look for is "feature = reuse the whole big thing behind a flag or a window". Confirmed so far: the `companionMode` flag above. Worth a look next: anything else that hides parts of a full workspace with flags or CSS instead of being its own small component.
