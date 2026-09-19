# CHANGELOG.md

> Newest first. One line per slice; detail lives in BUILD_CHECKLIST.md.

## 2026-09-18 (audit + pre-build hardening)
- Pre-build audit, no `tauri build` yet: inbox badge/pin, BottomBar +
  palette routing repairs, MarkdownViewer back/edit/save, Inspector
  outgoing links, orphan deletion (Transclude/SlashCommands/slash-plugin),
  editor `$effect` busy-loop fix (untrack + `$state.raw`), tab-save +
  palette-search debounce loop fixes, palette search-as-you-type.
- Attachments actually save now (`attachment_save`, shared helper, both
  editors) with preview data-URL fallback; Reveal wired to `fs_reveal`.
- Rust backlog cleared, `cargo check` green: packaging config
  (resources/icons, dropped impossible `externalBin`), missing
  `rag_get_context`, publish nav param + TOC format string, `stop_playback`
  impl placement, borrow fixes, retention-days threading, warning cleanup.
- Sidecars: tray quick-capture (desktop-gated), prod resource-dir paths,
  STT moved to in-process `transcribe_cpp` (upstream ships no CLI) with
  speech-to-text proof; TTS pybind introspection fix; memory server live
  proof (learn/recall/redact/persist). Models fetching via
  `fetch_sidecars.py` (STT GGUF done).
- Perf spot-checks (preview/jsdom): search ~300ms@2k/~350ms@5k docs
  end-to-end incl. debounce; desktop FTS5 budget still needs device run.
- Build readiness: updater keypair generated + pubkey set, bundle targets
  nsis-only (WiX absent), dead deps pruned (`tokio`, `thiserror`,
  `tauri-plugin-shell/sql`), two more debounce self-loops fixed
  (palette search, tab persistence — both proven by probes), STT/attachment
  paths verified live. No exe built (owner builds).
- 2026-09-19: first signed build — `Just Write ehis_0.2.0_x64-setup.exe`
  (317MB, STT+TTS+LLM models bundled) + `.sig`. Required fixes: fetcher
  resume/retries, correct llama.cpp asset (b11047; b4970 lacks `lfm2`),
  sibling-DLL copy, dropped retired `--no-mmap`/`--mlock` flags, updater
  key regenerated WITH password (empty-password hangs the signer).

## 2026-09-17

- Continued audit-gap wiring: AI panel chat history (list + resume + new
  chat); tab strip persists across restarts; smart-tab suggestions on Home
  + daily activity decay; FileBrowser new-folder + move-to; STT/TTS/memory
  toggles now actually gate their buttons and stop their sidecars;
  dead-code removal (orphaned sessionTimer store, deprecated audio paths,
  unused imports). `docMove` deliberately left: no doc-tree UI exists to
  host it. `docSearch`/`sidecarQuery`/`ragSearch` left as server primitives.
- Exposure slice (audit-found gaps): Inbox + Library (properties route)
  join the desktop sidebar nav (+ TabBar accents, Home labels, help list);
  Story Bible gains add-fact form + delete per fact (was read-only);
  Reader gains tap-to-rate stars in the reading toolbar (tap again clears).
- Full documentation set: README, ARCHITECTURE, DEVELOPMENT, TESTING,
  USER-GUIDE, SPEC-STATUS, TODOS, CHANGELOG; headers retrofitted.
- E-reader: real EPUB/DOCX/PDF text extraction (`bookparse.ts`, lazy
  chunk), binary fixtures + node parsing proofs, import refusal replaced.
- Theme repair: `app.css` was never loaded — restored, defined missing
  vars, shipped the paper light palette + theme-aware brand mark.
- Dictionary switch (English / custom-only), opt-in place+weather stamps.
- Brand mark rollout (`ehis-final-v2.svg`): logo, favicon, Home icon,
  boot/onboarding, Tauri + PWA icon sets.

## 2026-09-16

- Canvas board (A11.1): cards, links, doc-links, pan/zoom/fit, full wiring.
- Batch: lock semantics, craft-schema repair + skill nudge, beat order =
  compile order (+ Novel Studio rescue), pinned Home, last-place restore,
  streak sparkline.
- Audit fixes: Ghost privacy leak, binary-import corruption, FTS5 correction.
- Updater wiring, export pipeline (6 formats), audit batch (mentions,
  logs, reminders, streaming, saved views, calendar).

## 2026-09-14/15 (prior sessions, per BUILD_CHECKLIST)

- Core engine, 7 workspaces, AI panel + RAG, memory layer, command
  palette, settings (9 categories), snapshots, backups, responsive pass,
  sqlite-vec embeddings, structurizer, perf diagnostics, browser preview
  backend, unified icon system, inbox triage, conflict diff view.
