PURPOSE: Windows file association, launch handoff, startup, and default-app integration
OWNS: Tauri Windows bundle config, CLI handoff, single-instance behavior, autostart lifecycle, and native verification status
READ-WHEN: changing Windows launch behavior, installer registration, autostart, or Default Apps settings
KEY-FILES: src-tauri/tauri.windows.conf.json, src-tauri/windows/hooks.nsh, src-tauri/src/windows.rs, src-tauri/src/lib.rs, src-tauri/src/commands.rs, src/lib/widgetAutostart.ts, src/lib/nativeLaunch.ts, src/lib/components/SettingsPane.svelte
INVARIANTS: Windows-only registration; text/source, PDF, image, and DOCX extensions are shipped associations; no UserChoice writes; autostart is explicit opt-in; widget master-off removes autostart; one process handles warm launches
GOTCHAS: Tauri file associations are installer-driven; runtime edits to the extension preference do not rewrite Windows registry entries; native install/uninstall evidence is still pending
UPDATED: 2026-09-24

# Windows integration

## Installer ownership

`src-tauri/tauri.windows.conf.json` is the Windows-only Tauri overlay. It declares text/source, PDF, image, and DOCX extensions in `bundle.fileAssociations` and attaches the NSIS uninstall hook. The base config has no association list, so other platforms do not receive these registrations.

`src-tauri/windows/hooks.nsh` removes the explicit `Just Write ehis` values from the per-user Windows Run key and StartupApproved key before uninstall cleanup. Tauri’s generated NSIS association entries remain installer-owned and are removed by the generated uninstaller.

## Launch handoff

`tauri-plugin-single-instance` is a Windows-target dependency and is registered before other plugins. A second invocation queues a supported text/source, PDF, image, or DOCX path, shows/focuses the existing main window, emits `native-file-open`, and exits through the plugin. A cold first launch reads the same path from process arguments and stores it in `PendingLaunchFile`.

`open_external_file` validates the extension and routes text through the Write import path; supported PDFs, images, and DOCX files open in the reader/preview flow. The frontend consumes pending paths after the main window mounts and listens for warm handoff events.

## Autostart and Default Apps

Autostart is registered only under `cfg(target_os = "windows")`, with the explicit name `Just Write ehis` and `--widget-autostart`. It is opt-in through the Start with Windows setting. The toggle is disabled while the widget master switch is off. Turning the master switch off disables the Windows startup entry when it is currently enabled.

The Default text editor button calls the Windows command `ms-settings:defaultapps`. The app never writes `UserChoice` or attempts to force default-app status.

## Verification status

Source checks on 2026-10-21:

- `npm run test:os`: passed.
- Widget and ACL suites also pass the single-instance resurface and command-grant contracts.
- The installer configuration and `src-tauri/src/windows.rs` include the supported associations.

Native evidence intentionally not collected because build/installer execution was not approved:

- Explorer “Open with” registration after a real install.
- Cold-start versus warm-handoff timing.
- `ms-settings:defaultapps` opening the expected pane.
- Actual install → enable everything → uninstall registry/Startup cleanup.

Those four items remain unverified, not passed. A real installer loop requires explicit build approval.
