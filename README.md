# Just Write ehis

A personal super app for **writing and everything around writing** — docs, fiction, scripts, knowledge, reading, and an AI that knows your work. Writing is the identity; everything else serves it.

> Spec: the canonical `canonical-spec-v1.11.md` (Amendments 1–11 + deltas in `docs/SPEC-STATUS.md`). Deviations need a spec amendment, not a chat message.

## Stack

| Layer | Choice |
|---|---|
| Shell | Tauri 2 (Rust), desktop + Android from one codebase |
| UI | Svelte 5, CodeMirror 6, custom SVG icons (no Lucide, no emoji icons) |
| Browser preview | Same UI over a localStorage backend — no Tauri needed |
| Store | Files on disk are truth; SQLite index; hot buffer in SQLite WAL |
| AI | Pluggable OpenAI-compatible endpoints (local or API) + SSE streaming |
| Conversion | Built-in md/txt/html; docx/epub/pdf via pandoc |

## Quickstart

```sh
npm install
npm run dev        # browser preview at http://localhost:5173 (fully usable)
npm run build      # web bundle only — never an executable
npm run preview    # serve the built bundle
npm run check      # svelte-check (0 errors required)
npm run test:e2e   # 50+ end-to-end checks, exit 0 required
```

The desktop shell additionally needs Rust + `npm run tauri build`
(see `docs/UPDATES.md` for signing, `docs/DEVELOPMENT.md` for the full flow).

## Layout

```
src/                 Svelte frontend (components, stores, api.ts, browserBackend.ts)
src-tauri/src/       Rust backend (commands, doc_store, convert, sidecar)
src-tauri/           tauri.conf.json, capabilities/, icons/
public/              brand mark, PWA manifest, generated icons
tests/               e2e-browser.mjs, make-fixtures.py, fixtures/
docs/                the docs you are reading (start at docs/ARCHITECTURE.md)
```

## Docs index

- `docs/ARCHITECTURE.md` — layers, dual backends, data flows
- `docs/DEVELOPMENT.md` — setup, scripts, how to add commands/workspaces
- `docs/TESTING.md` — what each check proves and how to run it
- `docs/USER-GUIDE.md` — workspaces, AI, privacy, updates, export
- `docs/SPEC-STATUS.md` — spec amendment → implementation status
- `docs/UPDATES.md` — release + self-update setup
- `docs/EXPORT.md` — conversion tiers + pandoc sidecar
- `docs/MODELS.md` — model picks per job + swap guide
- `docs/HARNESS.md` — vendored AI-memory code + privacy behavior
- `TODOS.md` — remaining work · `CHANGELOG.md` — session history
- `BODY.md` / `IMPACT_MAP.md` / `BUILD_CHECKLIST.md` — anatomy, impact, gates
