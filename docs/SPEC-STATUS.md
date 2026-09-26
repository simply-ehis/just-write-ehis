PURPOSE: canonical-spec amendment → implementation status, with deviations on record
OWNS: the mapping between spec text and shipped behavior
READ-WHEN: spec work starts; scope arguments; "is X done?" questions
KEY-FILES: canonical-spec-v1.11.md (source of truth, outside repo), BUILD_CHECKLIST.md (gates)
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
| Out of scope (§11) | ✅ honored | no SRS/collab/plugins/sync-service |

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
| 11 | Canvas/outline/hover/lock/pin/board-calendar/slash/goals/stamps | ✅ except Canvas→Compile link (beat board owns order by decision 2026-09-16); app PIN now defaults off, requires confirmed setup, and gates launch/session |

## Deliberate deltas (with dates)

- 2026-09-16: **Lock semantics extended** — locked = excluded from search/RAG/AI/Home/smart-tabs; titles stay in structural views; session unlocks. Stricter + clearer than A11.4's gate-only sketch.
- 2026-09-25: **App PIN made real** — locking defaults off, setup requires create+confirm and keychain success, launch/session gate is enforced, repeated failures use a shared backend retry state, and recovery resumes startup. This remains a plaintext-file session gate, not vault encryption.
- 2026-09-25: **Native local-model boundary clarified** — the shipped implementation uses four managed sidecar managers (STT, TTS, memory, LLM), prefers packaged native executables, and treats an empty STT model field as the bundled default rather than the legacy `moonshine-base` value.
- 2026-09-16: **Compile order = beat-board arrangement** (frontmatter `order`), not Canvas geometry — proposed Amendment 12 text in session log.
- 2026-09-17: **Reader is text-only** — epub/pdf/docx extract to doc bodies; no page rendering (spec §2 libs deferred; import refusal replaced by real parsing).
- 2026-09-17: **Theme system repaired** — stylesheet was never loaded; light palette added (spec named themes but none rendered).

## Deferred (see TODOS.md)

Encrypted Private Vault ·
Android home-screen widget (needs native shell) · FTS5 migration (optional).
