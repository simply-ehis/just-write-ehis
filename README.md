# Just Write ehis

A personal super app for **writing and everything around writing** — docs, fiction, scripts, knowledge, reading, and an AI that knows your work. Writing is the identity; everything else serves it.

> License: GNU Affero General Public License v3.0 or later — see [LICENSE](LICENSE). Made by simply-ehis: report bugs via Settings → Support or [GitHub Issues](https://github.com/simply-ehis/just-write-ehis/issues).

> Spec: the canonical `canonical-spec-v1.11.md` (Amendments 1–11 + deltas in `docs/SPEC-STATUS.md`). Deviations need a spec amendment, not a chat message.

## Recent Production Readiness Additions (v0.2.1)

- **AI Generation Controls** — Cancel button for in-flight generations, 3-second configurable cooldown between sends (`aiRateLimitCooldown` setting), request timeouts (90s chat / 120s stream / 180s structurize).
- **Error Handling Polish** — Friendly error messages (401→API key, 429→rate limited, 408→timeout, network→can't reach server), retry button after failed generation, toast notifications for AI failures.
- **Toast System** — Click-to-dismiss, explicit close button, max 3 visible (queues rest), error toasts persist until dismissed.
- **Local Runtime Integrity** — STT, TTS, AI memory, and the bundled LLM use real readiness checks and native-first release runtimes; Settings can run STT, TTS, and LLM test requests.
- **App PIN** — locking defaults off, requires confirmed setup, stores the desktop PIN through the OS keychain, gates the app session, and applies retry backoff.
- **XSS Fix** — HTML sanitization via `ammonia` crate for published output (replaced incomplete custom escape).
- **Ghost Autocomplete with Local LLM** — When `llmEnabled` is on, ghost suggestions use the local LFM 2.5-350M model via `ensureLlm()` lazy start.
- **Auto Story Memory** — Successful scene saves queue local-only mention extraction; unmatched names wait in the Story Bible suggestion queue, while appearance links and contradiction badges stay informational.
- **Settings** — `aiRateLimitCooldown` (ms, default 3000), `blankModeDefault` now initializes AI panel state and persists toggle.
- **Default STT Model** — the bundled `moonshine-base-Q8_0.gguf` is selected when `sttModel` is empty; the legacy `moonshine-base` value remains compatible.
- **Brutalist Theme** — Third theme option alongside Dark/Light: zero border-radius, thick borders, hard offset shadows, Archivo Black headers, Space Mono body.
- **Windows OS Integration** — NSIS registers `.txt` and `.md`, single-instance file handoff opens the requested file, autostart is explicit opt-in, and Default Apps opens Windows Settings without forcing a default editor.

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
npm run test:os    # Windows OS integration static checks
npm run test:e2e   # broad static, parsing, IPC-parity, and memory-runtime checks; exit 0 required
```

The desktop shell additionally needs Rust + `npm run tauri build`
(see `docs/UPDATES.md` for signing, `docs/DEVELOPMENT.md` for the full flow).

## Install (Windows)

The release artifact is `Just Write ehis_<version>_x64-setup.exe`. It bundles
the local model assets plus native STT, TTS, and AI-memory runtimes, so a
normal installation does not require Python or model downloads at runtime.
Exact size varies with the fetched llama.cpp runtime assets.

> **Windows Defender SmartScreen warning is normal and expected.** The app has
> no paid code-signing certificate, so Windows shows a blue
> "Windows protected your PC / Unknown publisher" dialog on first run. Click
> **More info → Run anyway**. Publish an updater artifact only after its `.sig`
> has been generated and verified against the pinned public key in
> `src-tauri/tauri.conf.json`; an unsigned artifact is not release-ready.

Uninstall anytime via **Settings → Apps → Just Write ehis → Uninstall**
(the installer registers a standard uninstaller — no leftover services).

## Windows integration

The Windows NSIS installer registers `.txt` and `.md` only. A file launch is handled by the existing process, and a second invocation hands the path to the running window through the single-instance plugin. The Settings UI includes the widget master switch, opt-in **Start with Windows**, the **Make Just Write ehis my default text editor** button, and the associated-extension list. Default-app status is never forced; the button opens `ms-settings:defaultapps`. The autostart registration is removed by the uninstall hook and is never enabled silently.

Native install, Explorer **Open with**, cold/warm timing, Default Apps navigation, and uninstall cleanup are documented separately in `docs/WINDOWS-INTEGRATION.md`; they require an approved Windows installer loop before being treated as verified.

## Layout

```
src/                 Svelte frontend (components, stores, api.ts, browserBackend.ts)
src-tauri/src/       Rust backend (commands, doc_store, convert, sidecar)
src-tauri/           tauri.conf.json, tauri.windows.conf.json, capabilities/, icons/, windows/
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
- `docs/AUTO_STORY_MEMORY.md` — local extraction, suggestions, contradictions, and verification report
- `docs/HARNESS.md` — vendored AI-memory code + privacy behavior
- `docs/WINDOWS-INTEGRATION.md` — Windows associations, launch handoff, autostart, and native verification status
- `TODOS.md` — remaining work · `CHANGELOG.md` — session history
- `BODY.md` / `IMPACT_MAP.md` / `BUILD_CHECKLIST.md` — anatomy, impact, gates
