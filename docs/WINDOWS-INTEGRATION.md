PURPOSE: Windows file association, launch handoff, startup, and default-app integration
OWNS: Tauri Windows bundle config, CLI handoff, single-instance behavior, autostart lifecycle, and native verification status
READ-WHEN: changing Windows launch behavior, installer registration, autostart, or Default Apps settings
KEY-FILES: src-tauri/tauri.windows.conf.json, src-tauri/windows/hooks.nsh, src-tauri/src/windows.rs, src-tauri/src/lib.rs, src-tauri/src/commands.rs, src/lib/widgetAutostart.ts, src/lib/nativeLaunch.ts, src/lib/components/SettingsPane.svelte
INVARIANTS: Windows-only registration; .txt and .md are the shipped associations; no UserChoice writes; autostart is explicit opt-in; widget master-off removes autostart; one process handles warm launches
GOTCHAS: Tauri file associations are installer-driven; runtime edits to the extension preference do not rewrite Windows registry entries; native install/uninstall evidence is still pending
UPDATED: 2026-09-24

# Windows integration

## Installer ownership

`src-tauri/tauri.windows.conf.json` is the Windows-only Tauri overlay. It declares exactly `txt` and `md` in `bundle.fileAssociations` and attaches the NSIS uninstall hook. The base config has no association list, so other platforms do not receive these registrations.

`src-tauri/windows/hooks.nsh` removes the explicit `Just Write ehis` values from the per-user Windows Run key and StartupApproved key before uninstall cleanup. Tauri’s generated NSIS association entries remain installer-owned and are removed by the generated uninstaller.

## Launch handoff

`tauri-plugin-single-instance` is a Windows-target dependency and is registered before other plugins. A second invocation queues a supported `.txt`/`.md` path, shows/focuses the existing main window, emits `native-file-open`, and exits through the plugin. A cold first launch reads the same path from process arguments and stores it in `PendingLaunchFile`.

`open_external_file` validates the extension, reads the local UTF-8 text file, imports it as a Write document through the existing database/vault path, and returns the resulting document. The frontend consumes pending paths after the main window mounts and listens for warm handoff events.

## Autostart and Default Apps

Autostart is registered only under `cfg(target_os = "windows")`, with the explicit name `Just Write ehis` and `--widget-autostart`. The first widget enable prompts the user whether to start with Windows. The independent Start with Windows toggle is disabled while the widget master switch is off. Turning the master switch off disables the Windows startup entry when it is currently enabled.

The Default text editor button calls the Windows command `ms-settings:defaultapps`. The app never writes `UserChoice` or attempts to force default-app status.

## Verification status

Static checks completed without a Tauri build:

- `node tests/os-integration.mjs` passed.
- `npm run test:settings` passed.
- `cargo metadata --no-deps --format-version 1` passed and confirms both Windows-target dependencies.
- `rustfmt --check src-tauri/src/windows.rs` passed.
- `npm run check` is currently blocked by five unrelated concurrent `src/lib/storyMemory.ts` errors.

Native evidence intentionally not collected because build/installer execution was not approved:

- Explorer “Open with” registration after a real install.
- Cold-start versus warm-handoff timing.
- `ms-settings:defaultapps` opening the expected pane.
- Actual install → enable everything → uninstall registry/Startup cleanup.

Those four items remain unverified, not passed. A real installer loop requires explicit build approval.
