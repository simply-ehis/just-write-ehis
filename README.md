# Just Write ehis

A personal super app for **writing and everything around writing** — docs, fiction, scripts, knowledge, reading, and an AI that knows your work. Writing is the identity; everything else serves it.

> Spec: the canonical `canonical-spec-v1.11.md` (Amendments 1–11 + deltas in `docs/SPEC-STATUS.md`). Deviations need a spec amendment, not a chat message.

## Recent Production Readiness Additions (v0.2.1)

- **AI Generation Controls** — Cancel button for in-flight generations, 3-second configurable cooldown between sends (`aiRateLimitCooldown` setting), request timeouts (90s chat / 120s stream / 180s structurize).
- **Error Handling Polish** — Friendly error messages (401→API key, 429→rate limited, 408→timeout, network→can't reach server), retry button after failed generation, toast notifications for AI failures.
- **Toast System** — Click-to-dismiss, explicit close button, max 3 visible (queues rest), error toasts persist until dismissed.
- **Sidecar Lifecycle** — `is_running()` now detects crashed processes (non-zero exit codes), proper crash logging for STT/TTS/LLM sidecars.
- **XSS Fix** — HTML sanitization via `ammonia` crate for published output (replaced incomplete custom escape).
- **Ghost Autocomplete with Local LLM** — When `llmEnabled` is on, ghost suggestions use the local LFM 2.5-350M model via `ensureLlm()` lazy start.
- **Settings** — `aiRateLimitCooldown` (ms, default 3000), `blankModeDefault` now initializes AI panel state and persists toggle.
- **Default STT Model** — Moonshine-base (GGUF) now the default (`sttModel: "moonshine-base"`).
- **Brutalist Theme** — Third theme option alongside Dark/Light: zero border-radius, thick borders, hard offset shadows, Archivo Black headers, Space Mono body.

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

## Install (Windows)

The release artifact is `Just Write ehis_<version>_x64-setup.exe` (~416MB —
it bundles everything offline: Moonshine STT, Kokoro int8 TTS voices, and the
local LLM, so no downloads happen at runtime).

> **Windows Defender SmartScreen warning is normal and expected.** The app has
> no paid code-signing certificate, so Windows shows a blue
> "Windows protected your PC / Unknown publisher" dialog on first run. Click
> **More info → Run anyway**. The installer is built from this repo and every
> release artifact carries an updater signature (`.sig`) verifiable against
> the pinned public key in `src-tauri/tauri.conf.json`.

Uninstall anytime via **Settings → Apps → Just Write ehis → Uninstall**
(the installer registers a standard uninstaller — no leftover services).

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
