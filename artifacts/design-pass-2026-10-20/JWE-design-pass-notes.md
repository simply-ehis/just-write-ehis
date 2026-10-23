# Just Write Ehis: design pass notes (Oct 20, 2026)

> Archived record. This patch is **already applied** to the working tree — it no
> longer applies cleanly (`git apply --check` fails on every file) because the
> applied code has since moved on. Kept for provenance only; do not re-apply.
> The duplicate `src/`, `src-tauri/`, `tests/` copies of the changed files were
> dropped on 2026-10-21 — the live tree is the source of truth.

Patch: `jwe-design-pass.patch` (17 files). Same files as a zip: `jwe-design-pass-changed-files.zip`.

Apply from the repo root:

```
git apply --whitespace=nowarn jwe-design-pass.patch
npm ci
npm run check
```

I dry-run applied it to a fresh copy of your zip: it applies cleanly.

---

## 1. What I changed

### Widget (your "13px logo, can't enlarge, blank and unclosable")
These are causes I found by reading the code. I could not run the Windows app, so the first two are "very likely", not proven.

| Symptom | Cause in the code | Fix |
|---|---|---|
| Can't expand or enlarge it | The bubble started a native window drag on **mousedown**. On Windows that swallows the mouseup, so the click that expands it never fires. | Drag only starts after the pointer moves 4px. A plain click expands. |
| Tiny "13px" logo | The bubble showed the **wide wordmark** (960x400) squeezed into a 42px circle, which is about 17px tall. | Bubble now uses the square nib mark (`ehis-mark-*.svg`). |
| Resizing "doesn't budge" | Any dock/offset change re-forced the window to its default size. Dragging also fed back into itself (move -> save -> re-place -> move). | Size is only set when collapsing or expanding. Our own moves are ignored for 600ms. Placement calls run one at a time. |
| Blank and unclosable | Manually enlarging the window while still collapsed left a big transparent window with a 56px bubble in the corner, and the only control was the bubble. Expanded view also had two identical arrow buttons and **no hide button**. | Window snaps back to bubble size when collapsed. Expanded header now has Open in app, Collapse (minus), Hide (x). Esc collapses. Widget takes focus when opened. All colours have fallbacks. |
| First-use "allow tauri localhost" | A native `window.confirm()` ("Also start with Windows?"). WebView2 titles it with the origin, `tauri.localhost`, so it looks like a permission request. | Removed. Startup stays opt-in through the "Launch at startup" switch in Settings. |

Files: `src/WidgetApp.svelte`, `src/lib/widgetAutostart.ts`, `src/lib/components/SettingsPane.svelte`.

### Interface size slider (Settings > Appearance)
- 80% to 160%, applied when you let go of the slider, with a Reset button.
- Uses native webview zoom (the app is sized in px, so a font-size trick would do nothing, and CSS zoom breaks CodeMirror's cursor maths).
- Desktop only. Browser/PWA builds already have browser zoom.
- Files: `src/lib/uiScale.ts`, `settings.ts`, `settingsValidate.ts`, `App.svelte`, `SettingsPane.svelte`, `capabilities/main-window.json` (adds `core:webview:allow-set-webview-zoom`).

### Markdown reader (Files > open a .md)
- Opens as a rendered page by default: tables, task lists, code blocks, quotes, strikethrough.
- Preview / Source toggle. Edit still works on source.
- Links are inert (a normal link would navigate your whole app webview away). The URL shows on hover.
- Images show only from `data:` URIs, otherwise their alt text, because local/remote images can't load under your CSP.
- Output is sanitised (scripts, handlers, iframes, javascript: links stripped).
- Files: `src/lib/mdPreview.ts`, `MarkdownViewer.svelte`. New dependencies: `marked@18.1.0`, `dompurify@3.4.16`. Both are pinned exact, and both are at least 14 days old (the newest releases were 8 days old, so I stepped back).

### Installer
`tauri.conf.json`: NSIS `installMode` `both` -> `currentUser`. No "all users?" question, no admin prompt.

### Tests
- Added `tests/md-preview-unit.mjs` (`npm run test:mdpreview`).
- Added widget regression checks to `tests/widget-invariants.mjs` and uiScale checks to `tests/settings-validate.mjs`.
- **I changed one existing assertion:** `tests/os-integration.mjs` used to require the native confirm text. It now requires that no native confirm exists.

---

## 2. Verified vs not verified

Verified in the sandbox:
- `npm run check`: 0 errors, 0 warnings.
- `vite build` succeeds.
- Widget, OS-integration, settings, ACL parity, ghost, autocorrect, reader, entities unit suites pass.
- `test:smoke`, `test:onboard`, `test:wstoggles`, `test:shell` pass.

Not verifiable here, please check on your machine:
1. **Widget on real Windows:** click expands, drag moves, resize works when expanded, collapse shrinks it back, Hide works.
2. **`cargo tauri build` accepts `core:webview:allow-set-webview-zoom`.** If it complains about an unknown permission, delete that one line from `capabilities/main-window.json`. Everything else still works; only the slider stops zooming.
3. **Installer** installs per-user without a prompt.

Pre-existing, not caused by me (identical on your original zip): `npm run test:themes` has 3 failures: editor background and accent don't follow the theme in `default/dark` and `brutalist/dark`. That's a real design bug for the next pass.

Not in the zip, so not audited: `src-tauri/sidecars/` (STT, TTS, LLM server code).

Housekeeping: your updater private key and its password were inside the zip. They're gitignored, so git is fine, but don't share zips with them in, and rotate the key if that zip went anywhere else.

---

## 3. Handoff prompts (need a Rust build or a real run, so I haven't done them)

### H1. Phase 1: instant typing and saving (strong model; Rust + TS)

> Repo: Just Write Ehis (Svelte 5, Tauri 2, Rust). Goal: typing and saving never stall the UI.
>
> Evidence (verify first with timing logs, then change):
> - `JustWriteWorkspace.svelte` calls `doc.toString()` and a word count on every keystroke.
> - After 500ms it calls `docSave`. `doc_store.rs::save_doc` then does an UPDATE, reads the old content, snapshot check, RAG chunk refresh, file write, entity refresh, `extract_backlinks` (its own comment says O(docs x content) while holding the DB lock), and a re-read.
> - After 5s a second full write (`atomicSave`) of the same text.
> - Roughly 150 of ~175 commands in `commands.rs` are sync `fn`, so they run on the main thread. Everything shares one `Mutex<Connection>`.
>
> Do:
> 1. Add timing logs around the save path first and record before numbers.
> 2. Files on disk are the truth. On change: debounce ~600ms, then ONE async atomic write (temp file + rename). Also flush on blur, window close and Ctrl+S. Remove the second 5s flush.
> 3. Move snapshots, search index, entities, backlinks and RAG chunks to a background worker with its own SQLite connection, debounced a few seconds after the last save. Never on the typing path. Do not swallow its errors silently (`let _ =`); log them.
> 4. Make the heavy commands `async` / `spawn_blocking`.
> 5. Stop calling `doc.toString()` per keystroke; derive counts lazily from change sets or on idle.
> 6. Writing stats must count words TYPED per session, not `SUM(word_count)` of docs touched that day (importing a 100k-word novel currently counts as 100k written).
>
> Done when: `cargo test` and `npm run check` pass, existing JS suites pass, typing never blocks a frame, and "saved" appears in under 1s on a 100k-word doc. Report the before/after timings.

### H2. Widget: confirm on Windows and chase the remaining "allow" popup

> Context: a patch already fixes drag-vs-click, the bubble logo, resize snap-back, a missing hide button, and removed a native `confirm()` that WebView2 titled "tauri.localhost says".
>
> Do:
> 1. Build and run on Windows. Test: click bubble expands; drag moves; expanded window resizes and stays; collapse; Hide; Esc.
> 2. If an "allow ... localhost" popup still appears, it is the Windows Firewall. With the app running, run `netstat -ano | findstr LISTENING` and match the PID. Check Windows Defender Firewall inbound rules for `just-write-ehis.exe`, `llama-server.exe`, or the python sidecar. Report which process binds a TCP port. The docs say there should be zero TCP ports (AF_UNIX only), so this is a bug if found.
> 3. If the expanded widget is still blank: open devtools on the widget window and check whether the DOM exists. Then try, one at a time: `"shadow": false` on the widget window, and a one-pixel `set_size` nudge after expand (known WebView2 repaint issue for transparent borderless windows). Do not change `visible/decorations/transparent/resizable` without updating `tests/widget-invariants.mjs`.
> 4. Measure real RSS of the collapsed widget and report it.

### H3. Models folder and Settings purge (backend half)

> Goal: remove every path/quant/python/icon text input from Settings. One permanent models folder, auto-created in the app data dir.
>
> Do:
> 1. Rust: create the folder at startup; list `.gguf` files in it; a command to return them with size. Dropping a file in swaps the model. If several, the UI picks one (remember the choice).
> 2. Remove settings for STT model path, LLM model path, python command, quantization and icon set. Keep the settings loader tolerant of old stored keys (ignore, don't crash).
> 3. Stop bundling the 350M LLM. Base context 16k. Add a hardware-tier list of plain HF links (<=8GB RAM: 1.2B class; 12-16GB: Ling-3.0-tiny or LFM2.5-8B-A1B; 24GB+: LFM2.5-24B-A2B). Note LFM2.5-24B always reasons, so use it for co-author mode only, not autocorrect or formatting.
> 4. llama-server flags (confirm against `--help` on the bundled build): `-c 16384 -fa on -ctk q8_0 -ctv q8_0 -np 1 -t <physical cores> --jinja`; `--n-cpu-moe N` for MoE on small VRAM.
>
> Done when: `cargo test`, `npm run check` and all existing suites pass; Settings has no free-text path inputs.
