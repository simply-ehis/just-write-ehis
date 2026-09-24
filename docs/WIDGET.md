PURPOSE: companion-window architecture, invariants, and verification status
OWNS: widget window lifecycle, query route, settings/tray wiring, proof evidence
READ-WHEN: changing widget routing, window capabilities, tray behavior, or cross-window settings
KEY-FILES: src/WidgetApp.svelte, src/lib/widgetBridge.ts, src-tauri/tauri.conf.json, src-tauri/capabilities/default.json
INVARIANTS: one Tauri process; main/widget only; setup_file_watcher runs once from main; no widget DB/watcher/sidecar/RAG initializer
GOTCHAS: hidden does not mean destroyed; storage events synchronize non-secret settings; native timing/RSS remain unmeasured while builds are skipped
UPDATED: 2026-09-23

# Companion widget

## Window creation choice

The widget is the second declarative entry in `tauri.conf.json`, not a runtime `WebviewWindowBuilder`. One config entry guarantees one native `widget` label at startup, avoids duplicate creation races, and keeps Settings, tray, and recovery looking up the same label. The entry starts hidden and loads `index.html?widget=1` in the existing process.

The route dynamically imports either `App.svelte` or `WidgetApp.svelte`; the widget never mounts the full app shell. It reuses `EditorPane` in companion mode and `QuickCaptureInput` with voice disabled. Companion mode suppresses editor chrome and Ghost so the widget cannot start a voice or LLM sidecar.

## Lifecycle

Settings → General persists `companionWidgetVisible` and `widgetWorkspace`. The native toggle shows/focuses or hides the configured label. The widget titlebar's close action persists hidden state and calls `hide()`. The tray has one Show / Hide Widget item and mirrors the setting through `widget-tray-visibility`.

Main close is intercepted and converted to hide. The widget receives `main-window-hidden` and offers Reopen main or Quit. `widget-open-doc` is emitted only to `main`; main fetches the existing unlocked Write/Logs/Inbox doc, updates normal stores, then shows/unminimizes/focuses its window. The widget hides after handoff so two editors do not race full-document saves; the tray can show it again.

## Capability boundary

`capabilities/default.json` includes both `main` and `widget` for core IPC and explicit window operations. `main-window.json` receives the full application command set plus updater/process controls; `widget-window.json` receives only the existing document/log/save command set plus `process:allow-exit` for the explicit Quit action. The widget never hydrates OS-keychain secrets, and its document list uses the existing locked-filtering `doc_search_full` command before storing any document state. No widget-specific Tauri command exists.

## Constraint proof

`npm run test:widget-proof` produced these results on 2026-09-23:

- Two SQLite writers against one WAL database: second write returned `database is locked`.
- Second bind on fixed sidecar port 8093: `EADDRINUSE`.
- `setup_file_watcher` creates one new watcher per call, has no idempotence guard, and leaks it for process lifetime.
- Two filesystem watchers both observed the same change, demonstrating the duplicate-notification mechanism.
- Capability labels are `main,widget`; an unlisted `rogue` label has no capability.
- Actual two-`tauri dev` observation, unlisted-label invoke rejection, and native watcher event counts were not run because the build was explicitly skipped.

## Verification status

Passed without building:

- `npm run check`: 0 errors, 0 warnings.
- `npm run test:settings`: all checks passed.
- `npm run test:widget`: all static lifecycle/capability/no-command checks passed.
- `npm run test:widget-proof`: output recorded above.
- `src-tauri/target` remained absent.

Pending native matrix: `tauri build --debug`, cold widget open under 500 ms, RSS delta under 50 MB, show/hide/focus/open-in-app/edit-save-conflict for Write/Logs/Inbox, all four themes, 360×520 and 280×400, main-hidden recovery, widget webview-crash recovery, and live theme propagation between windows.
