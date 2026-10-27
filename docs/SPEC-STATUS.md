PURPOSE: canonical-spec amendment → implementation status, with deviations on record
OWNS: the mapping between spec text and shipped behavior
READ-WHEN: spec work starts; scope arguments; "is X done?" questions
KEY-FILES: canonical-spec-v1.11.md (request scope), BUILD_CHECKLIST.md (legacy gates), TODOS.md (open work)
INVARIANTS: statuses here must match code; deviations need a dated note, never silent drift
GOTCHAS: "done" means wired in BOTH backends + UI + e2e/self-test; native packaging and Rust runtime remain unverified until an explicitly authorized Tauri build
UPDATED: 2026-09-25

# Spec status (canonical-spec v1.11)

## Base (§1–§14)

| Area | Status | Note |
|---|---|---|
| Identity, non-negotiables | ✅ | opaque docked UI, Phosphor-style icons, keyboard-first |
| Stack | ✅ w/ deviations | Fountain parser is TS not Rust (same function); search is LIKE + sqlite-vec, **not FTS5** |
| Core engine / storage layout | ✅ | files truth + SQLite index + WAL hot buffer |
| Logs / Write / Map / Novel / Script / Projects / Reader | ✅ | Novel Studio was dead (`projectId` never assigned) — fixed with picker; Reader gained faithful PDF page preview 2026-09-18 |
| AI panel 3 modes | ✅ | incl. SSE streaming (chat/composer) |
| AI Brain / providers / RAG | ✅ | RAG keyword+vector; chunk-on-save |
| Properties & views | ✅ | table/board/**calendar** + saved views |
| Memory + smart tabs | ✅ | write-heartbeat repaired streaks/heatmaps (were zero) |
| Skills & craft | ✅ | repaired `craft_metrics` schema; once-ever filter-word nudge; dedicated Skills page (power-feature checklist + craft trends + dismissed-hint restore), wired in sidebar/Home/BottomBar/palette |
| Palette / search / versions / backup / inbox / export | ✅ | backup now auto-on-open; export adds docx/epub/pdf |
| Out of scope (§11) | ✅ honored | no SRS/collaboration/sync service; plugin manager is labeled as a roadmap |

## Overhaul phase audit (2026-10-21)

This is a source audit, not a claim that every request in the original scope
notes has shipped. Phase 8 is deferred; the user requested a completion check first.

| Phase | Status | Evidence / remaining gap |
|---|---|---|
| 0 Safety | Partial | Per-user installer and Windows file types are configured. Signing-key relocation and measured before/after save timings are not evidenced in this checkout. |
| 1 Saving and speed | Partial | Editors debounce to one atomic save and derived indexes use a worker. Rust save still writes synchronously through the mutex-protected database path; large-document latency and frame stalls have not been measured. |
| 2 Settings and UI scale | Mostly implemented | UI scale is adjustable; model-path, quant, Python, and icon controls are absent. The app scans local GGUFs. Provider endpoint/model/key inputs remain because the paid account flow is deferred. |
| 3 Writing and reading | Mostly implemented | CodeMirror write areas, Markdown rendering, PDF preview, and Windows PDF/image/DOCX associations exist. Native open-with behavior and non-inline image/link rendering still need a real-app check. |
| 4 Voice | Source implemented | Sentence queue, previous/next, active-section follow, and editor microphone hooks exist. Native cold starts and TTS quality have not been measured. |
| 5 Local models and harness | Partial | Local GGUF scanning and runner flags exist. The hardware recommendation/download flow and direct tool-using co-author integration with the separate small-model harness are not evidenced as complete. |
| 6 Novel, Map, links, notifications, widget | Source mostly implemented | Workspace and ACL invariants pass. Current Windows widget interaction is unverified. OS notifications run through `tauri-plugin-notification` (conflict-found + long-AI-job-finished + hidden-app errors, 2026-10-22); the Web Notification API remains the browser-preview fallback. |
| 7 Templates and projects | Source implemented | Built-in writer templates, AI starter generation, and project reference documents are wired. |
| 8 Business layer | Deferred | Not started, as requested. Subscription terms, auth/sync backend, and payment provider are still open decisions. |

Other requests that remain open or intentionally outside these phases: Android native shell, Obsidian plugin compatibility, encrypted-at-rest vaults, and native verification of the installer/widget lifecycle. The plugin manager is explicitly labeled as a preview; it does not install plugins.

## Amendments

| # | Subject | Status |
|---|---|---|
| 1 | Structurizer `{...}` | ✅ + deterministic local fallback in preview |
| 2 | Blank chat + promote | ✅ |
| 3 | Chat write-back (4 actions) | ✅ (streaming insertion holds output first — acceptable form) |
| 4 | UI hierarchy / component tree | ✅ |
| 5 | Corrections + compile/vault-rename/privacy/undo/session-timer | ✅ (`compile_run` ships in 6 formats) |
| 6 | Settings (9 cats, 2 tiers) | ✅ + export/import + diagnostics + self-test |
| 7 | Name/responsive/arrangement/psych/fast-open/voice/models/PWA | ✅ incl. PWA companion 2026-09-18 (share-target/shortcut/notification intents → Inbox; Web Speech mic fallback; widget documented native-only) |
| 8 | IDE tabs/Patterns widget/Files/autocorrect/toolbar | ✅ (autocorrect 3 layers + dictionary switch) |
| 9 | Save tiers/state/chunking/help/banners/history/persona/templates | ✅ (TTS chunk params plumbed; STT silence-chunking in sidecar) |
| 10 | 5s flush / git-like snapshots / undo separation | ✅ |
| 11 | Canvas/outline/hover/pin/board-calendar/slash/goals/stamps | ✅ except Canvas→Compile link (beat board owns order by decision 2026-09-16); PIN and per-document locks were later removed |

## Deliberate deltas (with dates)

- 2026-10-09: **PIN and document locks removed** — the former session gate did not encrypt files and was removed. Current files remain plaintext; encrypted vault support is still open in `TODOS.md`.
- 2026-09-25: **Native local-model boundary clarified** — the shipped implementation uses four managed sidecar managers (STT, TTS, memory, LLM), prefers packaged native executables, and treats an empty STT model field as the bundled default rather than the legacy `moonshine-base` value.
- 2026-09-16: **Compile order = beat-board arrangement** (frontmatter `order`), not Canvas geometry — proposed Amendment 12 text in session log.
- 2026-09-18: **Reader imports and previews** — epub/pdf/docx text can be imported, and PDF pages can be previewed in Reader.
- 2026-10-20: **Markdown file preview** — opened Markdown files default to sanitized rendered preview with source/edit modes; tables, code, quotes, lists, and safe inline data images are supported. See `MarkdownViewer.svelte` and `mdPreview.ts`.
- 2026-09-17: **Theme system repaired** — stylesheet was never loaded; light palette added (spec named themes but none rendered).

## Deferred (see TODOS.md)

Encrypted Private Vault ·
Android home-screen widget (needs native shell) · FTS5 migration (optional).
