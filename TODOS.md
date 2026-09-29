# TODOS.md — remaining work, newest first

> Source of truth for what's left. Move items to CHANGELOG.md when done.
> Do not add speculative features — only gaps found by audit or spec deltas.

## Must (blocks "production ready" honesty)

- [x] **Move secrets to OS keychain** — done: `secret_set`/`secret_get`
  keychain commands + boot migration that strips `apiKey`/`appLockPin`
  from localStorage (`stripPersistedSecrets`, `settings.ts`) + PIN
  create/confirm/unlock/remove state machine (`lock.ts`) + settings
  self-test coverage. localStorage holds them only transiently during
  legacy migration. (Closes audit 2026-09-22 CRITICAL #3.)
- [ ] **Updater one-time setup** — keypair, pubkey, endpoint
  (`docs/UPDATES.md`); UI reports "not configured" until then.
  Update 2026-09-19: keypair generated (password in
  `~/.tauri/just-write-ehis.pw.txt`) + pubkey pasted into
  `tauri.conf.json` + `.sig` artifacts produced by the build. Endpoint
  is the real releases URL
  (`simply-ehis/just-write-ehis/.../latest.json`). Still yours:
  publish artifacts + `latest.json` per release, and consider rotating
  the keypair — the previous private key was briefly committed to git
  history (removed in `ea3ba20`; old signatures stay valid, so rotation
  is a release-day decision, not an emergency).
- [x] **First `tauri build` on a maintainer machine** — done 2026-09-19:
  `Just Write ehis_0.2.0_x64-setup.exe` (317MB, all models bundled) +
  `.sig`, NSIS-only, signed with `~/.tauri/just-write-ehis.key`.
- [x] **Audit fixes 2026-09-22** — CSP shipped, MemoryManager crash
  detection fixed, DOMParser for reader TTS, startup errors are
  contextual (no panics), empty catches log, CI added
  (`.github/workflows/ci.yml`), svelte-check 0/0.

## Next slices (spec/audit-backed)

- [ ] **Encrypted Private Vault** (Amend. 5) — format, key storage,
  migration; at-rest secrecy the per-doc lock explicitly doesn't provide.
- [ ] **Runtime vault switching** — needs a per-vault index decision first:
  `writing.db` is per-install while vaults are per-folder, so a naive
  `set_vault_path` would mix two vaults' indexes. Either per-vault DB
  files or a `vault_id` column + reindex flow, then a sidebar switcher.
  Spec-amendment territory, not a drive-by.
- [ ] **App-launch PIN gate** — reuses `appLockPin` + `verifyPin`; skipped
  2026-09-16 by instruction, not by difficulty.
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
