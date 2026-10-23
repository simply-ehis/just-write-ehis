PURPOSE: verify Auto Story Memory privacy, extraction routing, review flow, and verification status
OWNS: the local-only extraction contract and evidence for the Auto Story Memory feature
READ-WHEN: changing Story Bible memory extraction, privacy gating, contradiction review, or editor lookup
KEY-FILES: src-tauri/src/commands.rs; src-tauri/src/doc_store.rs; src/lib/storyMemory.ts; src/lib/storyMemoryEditor.ts; src/lib/components/NovelWorkspace.svelte
INVARIANTS: extraction uses the bundled LlmManager over its private local socket; unmatched names remain suggestions until confirmed; re-extraction replaces only one source scene
GOTCHAS: browser preview intentionally returns skipped for local-model extraction; the 350M model can return short or malformed JSON, so the parser repairs snippets against the saved sentence, preserves valid memory on malformed output, and has a local names-only recovery pass
UPDATED: 2026-09-24

# Auto Story Memory Report

## Privacy and model routing

The automatic save path calls `bible_extract_mentions` only after `doc_save` succeeds. The Rust handler calls `LlmManager::chat_completion`, which reaches the bundled local LLM over its private AF_UNIX socket (`SockClient`) — the managed server binds no TCP port at all. The endpoints `http://127.0.0.1:8093/v1` and `http://localhost:8093/v1` remain only as sentinel `smallModelEndpoint` values and are redirected server-side to that socket client. This path does not call `ai_structurize`, `ai_generate`, `smallModelEndpoint`, `mainModelEndpoint`, or any configured cloud provider. If the model is unavailable, loading, or both local parsing passes fail, the handler returns `skipped`; the frontend retries from a debounced queue without turning the save into a failure.

Extraction uses the selected project and saved scene content. The former document-lock privacy gate was removed with the lock feature; use workspace privacy settings to keep AI requests local-only.

## Behavior covered

- Canonical `bible_facts` remain the source of truth and manual upsert/delete remains available.
- `bible_mentions` stores fact key, kind, source document, exact supporting sentence, optional trait key/value, and timestamp.
- Exact then bounded fuzzy matching appends evidence to an existing fact.
- Unmatched candidates enter `bible_suggestions`; confirm creates the canonical fact and one mention, reject stores a tombstone so re-extraction does not recreate it.
- Re-extraction passes the expected saved content, ignores stale async results, computes a scene-local delta, and clears evidence when a scene becomes empty while preserving other scenes.
- Contradictions are informational and link each value back to its scene and quote.
- Editor lookup uses already-loaded fact keys and CodeMirror string matching; it performs no per-hover model call.

## Verification evidence

- `cargo test --manifest-path src-tauri/Cargo.toml`: 31 passed.
- `npm run check`: 0 errors and 0 warnings.
- `npm run build`: passed; only existing Vite chunk/dynamic-import warnings.
- `npm run test:e2e`: all checks passed, including 162 API command sites covered by browser-backend cases.
- Local LFM probe: bundled `llama-server.exe` returned a response over `127.0.0.1:18093`; no external endpoint was used.
- Regression test: `memory_requires_confirmation_and_recomputes_only_the_changed_scene` proves unmatched names do not create facts, scene evidence is retained across another scene's recompute, and locked sources fail the gate.

## Recording status

`artifacts/auto-story-memory-preview.webm` and `artifacts/auto-story-memory-preview.png` show the real Story Bible UI flow: writing a scene, confirming a suggested entity, opening the second scene, and displaying the contradiction badge with linked scene values. This supplemental browser-preview recording seeds localStorage because browser preview intentionally reports native local-model extraction as skipped; it does not claim to prove Tauri model inference. Native desktop recording remains a manual verification step.
