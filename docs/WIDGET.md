PURPOSE: companion-window architecture, invariants, and verification status
OWNS: widget window lifecycle, dock geometry, workspace selection, settings/tray wiring, proof evidence
READ-WHEN: changing widget routing, window capabilities, docking behavior, tray behavior, or cross-window settings
KEY-FILES: src/WidgetApp.svelte, src/lib/widgetBridge.ts, src/lib/components/LazyWorkspace.svelte, src-tauri/tauri.conf.json, src-tauri/capabilities/default.json
INVARIANTS: one Tauri process; main/widget only; setup_file_watcher runs once from main; no widget DB/watcher/sidecar/RAG initializer
GOTCHAS: hidden does not mean destroyed; storage events synchronize non-secret settings; files deep-links to Library; native timing/RSS remain unmeasured
UPDATED: 2026-09-24

# Companion widget

## Window and interaction model

The widget is the second declarative entry in `tauri.conf.json`, not a runtime `WebviewWindowBuilder`. One config entry guarantees one native `widget` label at startup, avoids duplicate creation races, and keeps Settings, tray, and recovery looking up the same label. It starts as a transparent 56px always-on-top figure and is resized to a 520×720 panel when expanded.

The expanded panel has no application sidebar, tab strip, or breadcrumb chrome. It renders exactly one selected workspace using the same lazy-loading component and workspace data contracts as the main app. The canonical workspace list includes Home, Logs, Write, Inbox, Map, Canvas, Novel, Script, Projects, Reader, Files, and Library. Write uses the existing `EditorPane` in companion mode so the lightweight dock does not start editor AI/voice features; Files deep-links to Library’s Files view. The selected workspace remains persisted in Settings.

The collapsed figure is draggable and expands on click or keyboard activation. The expanded titlebar can be dragged, collapses on click-away, and exposes an explicit collapse control. Dock edge, dock offset, collapsed state, visibility, and OS-startup preference are persisted through the existing settings store.

## Lifecycle and startup

Settings → General controls widget visibility, the selected canonical workspace, dock edge, dock offset, and “Launch at OS startup.” The startup control uses Tauri’s autostart plugin. The native tray keeps the Show / Hide Widget item and the main-window access item. The widget can remain available while the main window is hidden; the tray and widget controls can bring the main window back when needed.

Main close is intercepted and converted to hide. `widget-open-doc` and `widget-open-workspace` are emitted only to `main`; main validates the canonical workspace or existing unlocked document, updates normal stores, then shows/unminimizes/focuses its window. The widget hides after handoff so two editors do not race full-document saves; the tray can show it again.

## Capability boundary

`capabilities/default.json` includes both `main` and `widget` for core IPC and explicit window operations. `main-window.json` receives the full application command set plus updater/process controls and the autostart permission; `widget-window.json` receives only the existing document/log/save command set. The widget never hydrates OS-keychain secrets, and its document list uses the existing locked-filtering `doc_search_full` command before storing any document state. No widget-specific Tauri command exists.

## Verification status

Passed without a native build:

- `npm run check`: 0 errors, 0 warnings.
- `npm run test:settings`: all checks passed.
- `npm run test:widget`: all static lifecycle/capability/no-command checks passed.
- `npm run test:widget-proof`: source and OS proxy checks passed.
- `src-tauri/target` remains absent.

Skipped by request: demo recording/GIF, lock-specific widget testing, and native `tauri build --debug` / live two-window timing matrix. Native transparent-window behavior, OS autostart registration, dock persistence, and RSS/cold-open measurements remain pending a future build-approved verification pass.
