# TODOS.md — remaining work, newest first

> Source of truth for what's left. Move items to CHANGELOG.md when done.
> Do not add speculative features — only gaps found by audit or spec deltas.

## Must (blocks "production ready" honesty)

- [x] **Move secrets to OS keychain** — done: `secret_set`/`secret_get`
  keychain commands + boot migration that strips `apiKey`/`appLockPin`
  from localStorage (`stripPersistedSecrets`, `settings.ts`). localStorage
  holds them only transiently during legacy migration. PIN subsystem
  (app-lock + per-doc lock) fully removed 2026-10-09 — the create/confirm/
  unlock state machine and `verifyPin` no longer exist. (Closes audit
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
  titles suffice; NodeMap rAF loop never idles. Fix only against a
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
