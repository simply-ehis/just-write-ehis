PURPOSE: what the app does and how to use it, for humans
OWNS: feature tour, shortcuts, privacy model in plain language
READ-WHEN: onboarding copy changes; answering "where is X / how do I Y"
KEY-FILES: HelpOverlay (? shortcut sheet), SettingsPane (every toggle lives here)
INVARIANTS: every setting stated here must exist in Settings; no documented feature may be a stub
GOTCHAS: browser preview stores in localStorage; desktop stores files+SQLite — same UI, different persistence
UPDATED: 2026-09-18

# User guide

## Workspaces

**Home** — greeting, pinned quick-launch, recent docs, streak heatmap,
patterns. **Logs** — daily note (auto-created), calendar strip, quick
capture, touched-today footer. **Write** — blank page, typewriter mode,
session timer + end-of-session recap. **Map** — auto-laid-out link graph.
**Canvas** — freeform corkboard: double-click to drop cards, drag to move,
link mode to connect, cards link to docs. **Novel** — beat board
(drag scenes/acts to order — **that order is what Compile exports**),
Story Bible, compile to md/txt/html/docx/epub/pdf. **Script** — Fountain
writing with screenplay view. **Projects** — dashboard + board.
**Reader** — import epub/pdf/docx/md/txt (text is extracted), shelf,
ratings, position sync. **Preview PDF** (Reader header) renders faithful
PDF pages (zoom + page nav) before you import; import still extracts text.
**Files** — raw vault browser. **Inbox** — capture first, triage weekly
(multi-select + bulk move/delete). Type in the box (Enter saves) or dictate:
mic uses the STT sidecar when enabled, otherwise the browser's speech
recognition (works in the mobile PWA).

`Ctrl+K` jumps anywhere: docs, workspaces, actions.

## AI panel (right dock)

**Chat** (contextual or Blank — zero-context brainstorming), **Composer**
(generate → insert/replace/append with live streaming), **Structurize**
(`{directives}` in braces become structure), **Ghost** (Tab-to-accept
autocomplete; auto-suppressed for private workspaces).

## Privacy model (read this once)

- **Per-workspace local-only** (Settings → Privacy): Logs is local-only by
  default. Blocked calls refuse loudly, including Ghost.
- **Per-doc lock** (right-click a tab → Lock; needs a PIN from Settings):
  locked content is excluded from search, AI, stats, and smart tabs, and
  the pane PIN-gates. Titles stay visible in lists so docs stay manageable.
  Unlocks last for the session only. Files on disk stay plaintext —
  lock is a gate, not encryption.
- **AI memory** (Settings → Privacy): opt-in cross-session facts recalled
  into chats; opt-in secret scrubbing that blocks the call (never silently
  passes) when the sidecar is missing. Wipe anytime via Clear History.
- **Clear history** (Settings → Privacy): wipe chats, snapshots, usage.

## Updates, export, backup

- **Updates** (desktop): Settings → About → Check, or automatic on launch.
  Needs one-time maintainer setup (`docs/UPDATES.md`); otherwise the panel
  says so instead of failing.
- **Export**: any doc or compiled manuscript → md/txt/html always;
  docx/epub/pdf need pandoc (`docs/EXPORT.md`).
- **Backup**: automatic on open per your frequency + manual + snapshot
  pruning (Settings → Vaults).

## Capture outside the app (PWA / Android)

Install the PWA (browser menu → Install) and three doors open into Inbox:

- **App shortcuts** (long-press the icon): Quick Capture, New Document,
  Daily Note.
- **Share Target**: Android's share sheet sends text/links straight into
  the capture box (needs the `share-target` capture method or any method —
  the boot URL is always honored).
- **Notification** (Settings → Capture → Android Capture Method →
  Notification → Pin now): a sticky notification whose tap opens the
  capture box. Needs notification permission + the installed PWA.
- **Widget** needs the native Android shell — not available in the browser;
  use Notification or Share Target instead.

## Craft nudge

If filter-word frequency genuinely creeps up across sessions, the app says
so once, gently, per document — then never again. Stats live under the
chart toggle in the editor toolbar.

## Shortcuts

`Ctrl+K` palette · `Ctrl+S` flush save · `Ctrl+T` timestamp · `F11` zen ·
`?` full shortcut sheet · `Ctrl+Enter` insert last AI response.
