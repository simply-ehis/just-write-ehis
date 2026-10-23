# Delivery report — 2026-10-21 (verify-and-finish pass)

Session scope: verification of everything delivered so far, fixing every failing
gate/test correctly (code side where the code was wrong, test side where a pin
went stale), and an honest DONE/PARTIAL/BLOCKED accounting. No new features.

## 1. Gates — all green as of this report

| Gate | Result |
| --- | --- |
| `npm ci` | clean |
| `npm run check` (svelte-check) | **0 errors, 0 warnings** |
| `npm run build` | green (production build, ~23 s) |
| `cargo check` (Windows, src-tauri) | green, **zero warnings** |
| `cargo test` (Windows) | **139 passed / 0 failed / 1 ignored** |
| Direct `tests/*.mjs` sweep | **46 pass / 0 fail** |
| npm variant suites | all exit 0: `test:smoke` (×3 widths), `test:widgetdom` (×2), `test:shell` (×2), `test:onboard` (×2), `test:wstoggles` (×2), `test:resolve`, `test:assets` |
| `tests/e2e-browser.mjs` | **exit 0** (all ~170 checks incl. the coverage counter "170 sites") |
| `tests/memory-files.py` (stdio sidecar e2e) | **MEMORY-FILES ALL PASS** |

## 2. Failures found in the baseline sweep, and how each was fixed

Baseline at session start: 47 pass / 4 fail across suites; `e2e-browser` carried
6 failing checks. Every failure was root-caused before editing.

| # | Failure | Verdict | Fix |
| --- | --- | --- | --- |
| 1 | svelte-check: 2 errors + 1 warning in `src/lib/stores/audio.ts`, `SettingsPane.svelte` | dead code | No caller passes `splitPattern`/`chunkSize`; deleted the override lookups and the unused `input[type=number]` selector. |
| 2 | `cargo check`: dead-code warning `procutil::log_dir` | dead code | Deleted the unused getter (`src-tauri/src/procutil.rs`). |
| 3 | `save-state.mjs` — "timers are nulled after the flush" | **stale test pin** | The 5-second second-write `flushTimeout` was deliberately removed (single-atomic-write design; flushing once on destroy/pagehide is the whole contract). Test now pins `saveTimeout` only. |
| 4 | `theme-sweep.mjs` — dark + brutalist-dark "editor bg/accent tracks theme" (#1A1917 / #C9A96E) | **real bug** | `src/lib/editorTheme.ts` still carried pre-unification hex values; the real tokens in `app.css` are `#0D0C0B`/`#D4B470` (brutalist accent `#FFB000`). Aligned every value in the dark + brutalist-dark palettes. |
| 5 | `write-probe.mjs` — "major setting controls render" | **stale test pin** | The settings declutter intentionally removed `streakGoal` and `iconSet` (`compactMode` kept and alive). Rewrote the block to pin the post-declutter design incl. compact-mode application + persistence. |
| 6 | e2e — "api commands covered by browser backend … small_models_dir, scan_small_models" | **real gap** | Both commands exist in Rust (`commands.rs:3360/3378`) and `api.ts`, but the browser preview backend had no cases — Settings → local models would throw in the browser. Added cases in `browserBackend.ts` mirroring the `sidecars_dir` style (path mirror + empty scan list). |
| 7 | e2e — "saves re-chunk retrieval" | **real regression (most important)** | `doc_store.rs` refactoring made RAG re-chunking on save conditional on the >20-word auto-snapshot; HEAD re-chunked **every** content save. Small edits left Ask-your-docs serving pre-edit text. Restored unconditional refresh: `update_derived_indexes(&req.id, &doc.content, true, &changed_titles)` on every content save; test pin updated to the new wiring. |
| 8 | e2e — "orphaned dashboard commands deleted" + "dashboard single-truth store" | **stale test pins** | The dashboard migrated as one coherent change across all four layers (`commands.rs` → `api.ts` → `stores/dashboard.ts` → `UsageMemory.svelte`): activity-heatmap + writing-activity + library-stats replace streak-heatmap + writing-velocity + productivity-score. Verified the Rust commands exist and the UI consumes the new fields; updated both pins to the migrated contract (including negative pins on the retired trio). |
| 9 | e2e — "read-aloud section mode" + "memory clears stored facts" | **stale test pins** | Read-aloud queue now splits via `sentenceChunks` (readerSections.ts:171), not `chunkText`; memory `clear`'s documented contract is `files_removed` (memory_server.py docstring), not `facts`. Updated both pins. |

## 3. Feature status (evidence-backed)

### Verified done
- **T1 save path** — single atomic write (`atomic_save` returns the updated `Doc`), promise-driven save indicator, flush-on-destroy/pagehide. Pinned by `save-state.mjs` (both data-loss regressions) — green.
- **T2 small-model harness** — `small_models_dir`/`scan_small_models` Rust commands + api + browser backend (browser side completed this session), `smallModelContextLength`/`useAsMain` settings, registry entries. Pinned by e2e settings checks — green.
- **T3 speech-to-text** — Moonshine STT commands (`stt_start/stop/is_running/health`, `commands.rs:3172+`), sidecar, browser fallback; coverage pinned by widget/tabs/os suites — green.
- **T4 write-first declutter** — settings declutter, unified dark surfaces, theme alignment (fixed in #4 above); tests updated to the post-declutter design.
- **T5 backlinks** — full wiring: `update_derived_indexes` → `extract_backlinks` + title refresh, `refresh_backlink_titles`, delete-purges-vectors. Pinned by e2e — green. (Notifications and Map: see PARTIAL.)
- **T7/T8** — companionMode leftovers removed and templates store live; pinned by widget/templates/tabs suites — green.
- **Read-aloud section mode** — `getSections`/`onSection`/`sentenceChunks` queue with next-sentence prefetch live in `ReadAloudButton.svelte`; reader/reader-sections/audio-stop suites — green.

### Partially done
- **T5 notifications** — Tauri notification plugin **not present** (no `notification` in `Cargo.toml` / `lib.rs`). Backlink half is done; notify half is pending.
- **T5 Map** — `NodeMapWorkspace.svelte` still ships (`App.svelte:774`) with no dedicated test and no recorded fix. "Fix-or-cut" decision was never made.

### NOT done (despite plan wording)
- **Kokoro → Phonon swap, `ptts`, Settings > Voice table, migration** — zero `phonon`/`ptts` anywhere in `src-tauri/src` or `src/lib`. Kokoro v1.0 (sherpa-onnx, `src-tauri/sidecars/tts_server.py`) is the live, working TTS engine end to end (`tts_start/stop/is_running/synthesize`).
- **Render-ahead audio pipeline** (`artifacts/tts-read-aloud-2026-10-21/TTS-READ-ALOUD-plan.md`, phases 1–4) — not started. `audio.ts` has no `TtsRenderer`, no page timeline, no audio-clock driving; the live design is still one `tts_synthesize` IPC per sentence plus prefetch of the next.
- **WSOLA speed control + mini pill** — not present (`ReadAloudButton.svelte` is the only read-aloud UI).

## 4. BLOCKED — owner input needed

1. **Phonon swap decision.** The TTS plan assumes Kokoro → Phonon 31M English via `ptts`, but no Phonon code/bundle exists in the tree and the swap would delete the one working offline TTS path. *Needed:* explicit keep-Kokoro vs swap decision; if swap, a fetchable Phonon bundle (same pattern as `fetch_sidecars.py --tts`). *Recommendation:* implement the render-ahead pipeline first against the existing `tts_synthesize` contract — it is engine-agnostic — and only then swap engines behind it if still wanted.
2. **Map workspace fix-or-cut.** *Needed:* product decision — fix `NodeMapWorkspace` (with acceptance criteria + a test) or remove the workspace. *Recommendation:* cut it; it is untested surface that every future sweep must special-case.
3. **Notifications scope.** *Needed:* the short list of events that should raise an OS notification (e.g. background conflict found, long AI job finished). *Recommendation:* those two only; then add the `tauri-plugin-notification` and wire them.

## 5. Not verified (no harness / out of session scope)

- Physical audio output quality (WSOLA or otherwise) — no audio hardware harness.
- End-to-end `tauri build` installer + signature (needs maintainer machine and the signing key at repo root/`~/.tauri`).
- Android target.
- Updater `latest.json` publish (owner action per TODOS.md).

## 6. Files changed in this session

Source: `src-tauri/src/doc_store.rs` (re-chunk regression), `src-tauri/src/procutil.rs` (dead code), `src/lib/browserBackend.ts` (2 parity cases), `src/lib/editorTheme.ts` (dark tokens), `src/lib/stores/audio.ts` + `src/lib/components/SettingsPane.svelte` (dead code).
Tests: `tests/e2e-browser.mjs` (5 pins), `tests/save-state.mjs` (1 pin), `tests/write-probe.mjs` (declutter block).
