# TODOS.md — remaining work, newest first

> Source of truth for what's left. Move items to CHANGELOG.md when done.
> Do not add speculative features — only gaps found by audit or spec deltas.

## In flight (2026-10-21)

- [ ] **Phonon TTS migration (external, in-flight — NOT agent work)**
  — uncommitted edits appeared 2026-10-23 ~09:52–10:01: `sidecar.rs`
  resolves `phonon-server.exe` (replacing `tts-server.exe`) and
  `tts_start`'s Rust param is now `_python_path`. Two consequences:
  `tests/e2e-browser.mjs` fails 2 pins (bundled-runtime preference +
  invoke-arg spelling), and `_python_path` is a runtime arg-mismatch
  (`pythonPath`/`python_path` invoke keys match nothing → `tts_start`
  will error when read-aloud starts). This reverses the recorded
  "Phonon — SKIPPED" decision, so it needs the owner's confirmation
  before anyone builds on it.

- [x] **Verify-and-finish pass** — complete 2026-10-21. All gates green:
  svelte-check 0/0, build green, cargo check warning-free, cargo test
  139/0 (1 ignored), 46/46 direct `tests/*.mjs`, all variant suites,
  e2e-browser exit 0, memory-files ALL PASS. Fixed 2 real bugs (dark
  editor tokens in `editorTheme.ts`; save-path RAG re-chunk regression
  in `doc_store.rs`), 2 parity/coverage gaps (browser-backend
  `small_models_dir`/`scan_small_models` cases), and 7 stale test pins.
  Full accounting: `DELIVERY-REPORT-2026-10-21.md`.
- [ ] **Read-aloud v2** — plan at
  `artifacts/tts-read-aloud-2026-10-21/TTS-READ-ALOUD-plan.md`:
  1. **Phonon swap — SKIPPED (owner decision 2026-10-22)**: Kokoro
     (sherpa-onnx, `tts_server.py`) stays the live TTS engine. No
     `ptts`/Phonon integration work is planned unless reopened.
  2. **Render-ahead audio pipeline** — **phases 1–2 DONE (2026-10-21)**:
     segmentation with source offsets
     (`readerSections.splitSegments`), Rust `TtsRenderer`
     (`tts_render.rs`: exact pause silence, sample-accurate timings,
     paragraph-snapped pages, 45 s bounded producer, raw i16le
     `tts_render_page` fetch) wired through commands/lib/permissions/
     build.rs, timeline player (`src/lib/tts/player.ts`: gapless page
     scheduling, one audio clock, seek/prev-next, underrun hold,
     demand), stores (`readAloud.ts`), ReadAloudButton over the player.
     Verified: cargo 146/0 (7 new tts_render tests), svelte-check 0/0,
     build green, `tests/tts-timeline.mjs` (34 checks) green, full sweep
     47/47 + all variants. Remaining: **phase 4** — WSOLA speed and
     pill progress % DONE (2026-10-23, see CHANGELOG); still open:
     follow-scroll listen pass, delete leftovers (incl. the dead
     `tts_stream_*` commands — `cargo check` warns they are never
     registered in `generate_handler`).
  3. **Listen-test harness — DONE (2026-10-22)**: desktop QA page for the
     manual Windows listen pass (gaps / mid-page skips / speed changes).
     Command palette → "TTS listen harness (dev)" (or boot with
     `?listen-harness=1`). Drives the real `ensureTts → startRender →
     subscribeRender → TtsTimelinePlayer` path against a generated
     3-section test text; live gap table measures every boundary
     (220/480/600ms expected vs actual, page joins marked ⇄, chain
     contiguity), ±5 s/segment skips exercise mid-page seek + the
     frontier re-render path, 0.75–1.5× re-render at the current seg.
     Gates: svelte-check 0/0, build green,
     `tests/listen-harness.mjs` 42/42 (`npm run test:listenharness`),
     e2e + affected suites green.
- [x] **T5 leftovers — resolved 2026-10-22 (owner decisions)**:
  1. **Notifications — DONE**: `tauri-plugin-notification` added
     (Cargo + capability `notification:default` + npm pkg);
     `osNotifications.ts` gained the desktop path (the Windows WebView
     has no Web Notification API — the old path was a silent no-op) plus
     the owner's two events: **conflict-found** (wired in App.svelte's
     `file-changed` listener, banner covers the visible case) and
     **long-AI-job-finished** (AiPanel's `generating` effect, ≥30 s,
     failures/cancels suppressed via `genFailed` — errors already notify
     through the toast path). All gated on `desktopNotificationsEnabled`
     + app-hidden.
  2. **Map workspace — FIXED (cut reversed, 2026-10-22)**: the owner
     changed the decision mid-cut — "fix NodeMapWorkspace properly with
     acceptance criteria and a test instead of cutting it". The staged
     cut is fully reverted (route, sidebar, palette, pins, Help, tokens,
     widget enum; schema stays v5 — migration v6 never shipped). Fixed
     against AC1–AC9 in `tests/map-surface.mjs` (`npm run test:map`):
     draw no longer self-schedules frames (idle + post-destroy leak),
     hit-test and fit share draw's visibility rule via
     `src/lib/nodeMapGraph.ts` (filtered-out docs are no longer
     clickable), canvas tracks container resizes (ResizeObserver), the
     500 ms fit timer is cleared on reload/destroy, and f/F/Enter are     inert while typing in the tag-filter input.

## Must (blocks "production ready" honesty)

- [x] **Move secrets to OS keychain** — done: `secret_set`/`secret_get`
  keychain commands + boot migration that strips `apiKey` from localStorage
  (`stripPersistedSecrets`, `settings.ts`). The former PIN subsystem
  (app-lock + per-doc lock) was removed 2026-10-09 because it did not encrypt
  files; PIN values are not part of the current settings migration. (Closes audit
  2026-09-22 CRITICAL #3.)
- [ ] **Updater one-time setup** — keypair, pubkey, endpoint
  (`docs/UPDATES.md`); UI reports "not configured" until then.
  Update 2026-09-19: keypair generated (password in
  `~/.tauri/just-write-ehis.pw.txt`) + pubkey pasted into
  `tauri.conf.json` + `.sig` artifacts produced by the build. Endpoint
  is the real releases URL
  (`simply-ehis/just-write-ehis/.../latest.json`). Still yours:
  publish artifacts + `latest.json` per release.
  Update 2026-09-29: keypair rotated again (fresh password) — live pubkey
  in `tauri.conf.json` + tracked `just-write-ehis.key.pub`; private key +
  password at repo root (gitignored). Superseded keys archived outside the
  repo (`~/.tauri/*-superseded-*`); no release ever shipped under the
  pre-2026-09-26 key, and nothing shipped under the 2026-09-26 key either,
  so nothing in the wild trusts the old keys.
- [x] **First `tauri build` on a maintainer machine** — done 2026-09-19:
  `Just Write ehis_0.2.0_x64-setup.exe` (317MB, all models bundled) +
  `.sig`, NSIS-only, signed with `~/.tauri/just-write-ehis.key`.
- [x] **Audit fixes 2026-09-22** — CSP shipped, MemoryManager crash
  detection fixed, DOMParser for reader TTS, startup errors are
  contextual (no panics), empty catches log, CI added
  (`.github/workflows/ci.yml`), svelte-check 0/0.

## Next slices (spec/audit-backed)

- [x] **Sidecar lifecycle redesign — Slice 4** (user-approved 2026-10-09,
  "fast and smooth"): zero TCP ports (STT/TTS/Memory over stdio JSON
  frames to the same exes/scripts; LLM on AF_UNIX `.sock` + Rust
  HTTP-over-sock client), single-flight `ensure` (fail never stops a slow
  model), warm-on-intent (hover mic/read-aloud, Ghost-on), idle offload
  (default 5 min; setting `modelRetention`: idle-5min/session/always),
  browser speech fallback. ALL SUB-SLICES COMPLETE (2026-10-09):
  final sweep svelte-check 0/0, `npm run build` green, all 7 jsdom
  suites pass, `cargo check` clean, `cargo test --lib` 135 passed /
  1 ignored. Progress:
  - [x] **G — spawn fix + CREATE_NO_WINDOW** (2026-10-09): one Rust
    resolver `sidecars_dir` (resource dir → beside exe → source
    checkout, content-checked + trust-checked) replaces the frontend
    guessing `<resourceDir>/sidecars`, which failed closed for EVERY
    dev-side sidecar start; hidden consoles on all helper spawns
    (`procutil::hide_console`). Tests: `sidecars_dir_*` (3) in
    `ai_slot_tests`.
  - [x] **Transport swap — zero TCP ports** (2026-10-09): STT/TTS/memory
    speak newline-delimited JSON over stdin/stdout pipes (`IpcSidecar`
    in `ipc.rs`: request frame `{"id","method","params"}` → response
    `{"id","ok",result|error}`; per-request oneshot channels; dead child
    drains pending with errors). LLM binds an AF_UNIX `.sock`
    (`--host <path>.sock`) instead of a TCP port; hand-rolled HTTP/1.1
    over that socket (`SockClient`, non-streaming, ws2_32 FFI on
    Windows). Port machinery deleted: reclaim/port_owner/kill_port_owner/
    netstat/tasklist, `stt_port`/`tts_port`/`llm_port` commands, and the
    frontend port wrappers. Sentinel endpoints
    (`http://127.0.0.1:8093/v1`, `http://localhost:8093/v1`) redirect
    server-side to the sock client in `ai_generate`/`ai_generate_stream`/
    `ai_structurize`/`provider_probe` (invoke signatures unchanged).
    Python servers rewritten for the new argv contract: stt `[model?]`,
    tts `[model_dir?]`, memory `[data_dir]` (env token contract kept:
    `JWE_SIDECAR_TOKEN`/`JWE_MEMORY_TOKEN`). Verified: `cargo check`
    clean, `cargo test --lib` 135 passed (2 new ipc tests), svelte-check
    0/0, all three prebuilt exes rebuilt (`build_sidecars.py`) and
    smoke-tested over real pipes — memory learn/recall/unknown-method
    round-trip, TTS health, STT health (script+venv: `model_loaded:
    true`; onefile exe: pre-existing PyInstaller native-lib gap, not a
    transport regression — frame round-trip works, engine import fails).
    No TCP listeners on 8090–8093 during smoke. Next: B/D/F.
  - [x] **E — single-flight ensure, fail never stops** (2026-10-09):
    concurrent `ensureSidecar` calls for the same kind share one
    in-flight promise (`inflightEnsures` map in `audio.ts`); `fail()`
    no longer calls `spec.stop()` — a model that outran the 15s health
    poll keeps loading and the next ensure reuses the live process via
    `isRunning()` + a fresh poll. Dead `stop` field removed from
    `SidecarSpec` (UI toggles still call `stopStt`/`stopTts`/`stopLlm`
    directly). `memorySidecar.ts` updated to match. svelte-check 0/0.
  - [x] **B — warm-on-intent** (2026-10-09): 120ms dwell on hover
    pre-warms STT (`warmStt`) and TTS (`warmTts`, which also does a
    silent first synthesis of `"."` so Kokoro's ONNX model is loaded
    before the first real read-aloud); both in `audio.ts`, wired via
    `onpointerenter`/`onpointerleave` in `MicButton.svelte` and
    `ReadAloudButton.svelte` (timers cancelled in `onDestroy`; no-op
    in browser-preview mode). Ghost-on → LLM: `$effect` in
    `JustWriteWorkspace.svelte` watches `$settings.ghostEnabled` +
    `$settings.llmEnabled` and fires `warmLlm()` (single-flight inside
    `ensureLlm` prevents a double start if `ghost.ts:62` already kicked
    one off). No boot pre-warm. svelte-check 0/0.
  - [x] **D — idle offload** (2026-10-09): `modelRetention` setting
    (`idle-5min` default / `session` 30-min / `always` never) in
    settingsValidate SCHEMA + `AppSettings`. `audio.ts` tracks
    `lastUsedAt` per sidecar (marked on ensure-success and on
    `transcribeAudio`/`synthesizeText`); a 30s `setInterval` watcher
    offloads STT/TTS/LLM past the idle threshold (skips STT while
    recording/transcribing, TTS while playing). `always` no-ops the
    check. SettingsPane select under Local LLM. svelte-check 0/0,
    build green, all 7 jsdom suites pass.
  - [x] **F — browser voice badge** (2026-10-09): browser speech fallback
    already existed in `MicButton.svelte` (Web Speech dictation) and
    `ReadAloudButton.svelte` (speechSynthesis); added the missing
    "Browser voice" chip to `StatusBar.svelte` when `isBrowserPreview()`
    (mic icon + warning-colored border; tooltip explains local models are
    absent in web preview). svelte-check 0/0, build green, all suites pass.
  - [x] **docs/verify** (2026-10-09): `docs/MODELS.md` updated — desktop
    packaging section now describes stdio JSON frames (STT/TTS/memory) and
    the AF_UNIX LLM socket instead of fixed TCP ports; bundled-endpoint
    entry notes the `is_local_llm_sentinel` legacy-URL compatibility.
    Final sweep: svelte-check 0/0, `npm run build` green, all 7 jsdom
    suites pass, `cargo check` clean.
- [x] **Remove line-number gutter from the writing space** (2026-10-10) —
  user directive: the writing space is not a coding space. `EditorPane.svelte`
  and `MarkdownViewer.svelte` no longer call `lineNumbers()` (imports
  dropped; EditorPane's dead `basicSetup` import removed with them).
  `JustWriteWorkspace.svelte` still uses `basicSetup` (it bundles keymaps/
  history/search), so its shared theme now sets `.cm-gutters { display: none }`
  — one rule covers main + split. Dead CSS cleaned: EditorPane's `.cm-gutters`
  /`.cm-activeLineGutter` theme rules and the reading-mode/focus-mode gutter
  hide selectors, MarkdownViewer's `.cm-gutters` border rule. Word count stays
  in the status bar. Verified: svelte-check 0/0, build green, all 7 jsdom
  suites pass.
- [ ] **Encrypted Private Vault** (Amend. 5) — format, key storage,
  migration; at-rest secrecy the per-doc lock explicitly doesn't provide.
- [ ] **Runtime vault switching** — needs a per-vault index decision first:
  `writing.db` is per-install while vaults are per-folder, so a naive
  `set_vault_path` would mix two vaults' indexes. Either per-vault DB
  files or a `vault_id` column + reindex flow, then a sidebar switcher.
  Spec-amendment territory, not a drive-by.
- [ ] **Performance backlog (audit-flagged, unmeasured — profile first)**
  — `rag_search` N+1 per-chunk fetches + double search in `rag_get_context`
  (`doc_store.rs`); `bible_get_mentions`/`suggestions` N+1 parent-chain
  walks per row; dashboard `date()`-wrapped aggregations defeating
  indexes; `ghost_list` JSON-LIKE full scan; `delete_doc` O(N²) +
  per-id deletes without transaction; `backup_create` VACUUM under the
  connection mutex; `list_docs_by_workspace` ships full bodies where
  titles suffice; NodeMap rAF loop never idles (fixed 2026-10-22 —
  effect-driven draw, see CHANGELOG). Fix the rest only against a
  measured budget (§14 diagnostics in Settings → About).
- [x] **PWA Quick Capture companion** (A7.9) — done 2026-09-18: boot-URL
  intents (share target, shortcuts, notification taps) route into the Inbox
  box; Web Speech dictation fallback when the STT sidecar is off.
- [x] **Android capture methods (web side)** — done 2026-09-18: share-target
  + pinnable notification wired to Settings → Capture. Home-screen widget
  still needs the native Tauri-Android shell (blocked like the tauri build).
- [x] **PDF page rendering** — done 2026-09-18: PdfViewer (pdf.js canvas,
  page nav, zoom) behind Reader's "Preview PDF"; import stays text
  extraction. (EXPORT.md's pandoc-PDF-engine note is about *export*,
  unchanged.)
- [x] **Warning cleanup** — done 2026-09-18: svelte-check 0 errors,
  0 warnings (overlay target-checks, :global for injected/CM DOM, EditorPane
  mode classes moved to pane root so reading mode actually hides toolbars).

## Optional (works fine as-is)

- [ ] FTS5 migration (LIKE + sqlite-vec cover personal scale).
- [ ] Streaming insertion hold-action (Amend. 3 strict reading).
- [ ] Smart-tab positional pinning nuance (§8.2 strict reading).
- [ ] Dictionary tables beyond English-off (needs verified sources).
- [ ] Canvas geometry → compile order link (decided against; beat board owns it).
