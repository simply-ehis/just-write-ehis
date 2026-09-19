PURPOSE: vendored AI-memory code, server contract, privacy behavior
OWNS: src-tauri/sidecars/harness/*, memory_server.py, Rust MemoryManager, scrub/recall flow
READ-WHEN: touching AI prompts, privacy, sidecars, or the vendored files
KEY-FILES: harness/memory.py + clarification.py (vendored, MIT, see ATTRIBUTION.md), memory_server.py (ours), sidecar.rs MemoryManager, src/lib/harness.ts, AiPanel preparePrompt
INVARIANTS: scrubbing fails closed (missing sidecar blocks the call); stored facts are redacted at write; browser has no memory — its commands throw, never pass through
GOTCHAS: voice swaps need sidecar restart; memory data lives in <app-data>/ai-memory (NOT the vault, NOT synced); vendored files stay pristine except marked APP ADDITION blocks
UPDATED: 2026-09-17

# HARNESS.md — AI memory (vendored, adapted)

## What it is

`src-tauri/sidecars/harness/{memory,clarification}.py` are vendored from
**small-model-harness v0.4.1** (MIT, sinply-ehis) — see `harness/ATTRIBUTION.md`.
Only the memory half was taken: the tool-repair/intent/prompting modules
target a tool-calling agent loop this app doesn't have (plain completions,
no `tools` arrays).

App adaptations (all marked inline):
- `_SECRET_PATTERNS` gains `hf_` + `AKIA` credential patterns.
- `memory_server.py` (ours, stdlib only): HTTP wrapper + JSON persistence
  across restarts. `GET /health /recall /facts`, `POST /learn /redact
  /forget /clear`. Port 8092, data dir from argv (Rust passes app-data).
- Secrets are redacted **before storage** (`remember()` scrubs first).

## Flow in the app

- **Recall** (opt-out via AI Memory toggle): chat injects top facts into the
  system prompt; exchanges are learned fire-and-forget afterwards.
- **Scrub** (opt-in): every outgoing prompt (chat/composer/structurize) is
  redacted via the sidecar. Missing sidecar **blocks the call** — never
  passes secrets through silently.
- **Privacy panel**: toggles, live fact count, one-click wipe (also clears
  via Clear History → AI Memory Facts).

## Verify

`npm run test:e2e` boots the real server and asserts learn/recall/redact
(`memorySidecarLive`). `python -m py_compile` covers syntax without running.
