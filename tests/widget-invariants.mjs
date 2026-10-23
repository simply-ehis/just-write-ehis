import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(root, path), "utf8");
let failures = 0;

function check(name, condition, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
}

const config = JSON.parse(await read("src-tauri/tauri.conf.json"));
const capability = JSON.parse(await read("src-tauri/capabilities/default.json"));
const mainCapability = JSON.parse(await read("src-tauri/capabilities/main-window.json"));
const widgetCapability = JSON.parse(await read("src-tauri/capabilities/widget-window.json"));
const app = await read("src/App.svelte");
const appStores = await read("src/lib/stores/app.ts");
const bridge = await read("src/lib/widgetBridge.ts");
const main = await read("src/main.ts");
const widget = await read("src/WidgetApp.svelte");
const editor = await read("src/lib/components/EditorPane.svelte");
const settings = await read("src/lib/stores/settings.ts");
const settingsPane = await read("src/lib/components/SettingsPane.svelte");
const widgetAutostart = await read("src/lib/widgetAutostart.ts");
const lazyWorkspace = await read("src/lib/components/LazyWorkspace.svelte");
const libraryWorkspace = await read("src/lib/components/LibraryWorkspace.svelte");
const rust = await read("src-tauri/src/lib.rs");
const build = await read("src-tauri/build.rs");
const mainPermissions = await read("src-tauri/permissions/main.toml");
const widgetPermissions = await read("src-tauri/permissions/widget.toml");

const windows = config.app?.windows ?? [];
check("two configured windows", windows.length === 2, windows.map((w) => w.label).join(", "));
const mainConfig = windows.find((w) => w.label === "main");
// Hidden-start: see showMainWindow docs.
check("main window starts hidden", mainConfig?.visible === false);
// Spec viewport parity: the fresh-launch default must equal the static
// tauri.conf.json size, or first paint jumps between two sizes.
check(
  "default geometry matches static window size",
  mainConfig?.width === 1240 && mainConfig?.height === 740
);
const mainGrants = new Set(
  [capability, mainCapability].flatMap((c) => (c.windows ?? []).includes("main") ? (c.permissions ?? []) : [])
);
check("main window may show itself", mainGrants.has("core:window:allow-show"));
// Wiring, not a count: reveal must chain off the restore and repeat on the
// post-ready + failsafe exits, so no boot path traps an invisible window.
// The reveal is fail-open (no IPC gate); autostart hides again on its flag.
check("reveal chains off geometry restore", app.includes("restoreMainWindow().finally(revealMainWindow)"));
check(
  "reveal repeats on remaining boot exits",
  (app.match(/revealMainWindow\(\);/g) ?? []).length >= 2
);
// × quits for real: no hide-to-tray interception on the main window (the
// dead "main-window-hidden" signal goes with it), and a destroyed main
// window exits the process instead of lingering windowless.
check("main close is not intercepted to tray", !bridge.includes("main-window-hidden") && !bridge.includes("onCloseRequested"));
check(
  "destroyed main window quits the app",
  rust.includes('window.label() == "main"') && rust.includes("WindowEvent::Destroyed") && rust.includes("app_handle().exit(0)")
);
// Autostart warm boot: show unconditionally, hide again on a confirmed flag
// (fail-open: a hung backend delays the hide, never traps the window).
check(
  "autostart boot stays hidden until user open",
  app.includes("api.autostartLaunch()") &&
    app.includes("hideMainWindow") &&
    app.includes("3000")
);
const widgetConfig = windows.find((w) => w.label === "widget");
check("widget route URL", widgetConfig?.url === "index.html?widget=1");
check("widget never intrudes over other apps", widgetConfig?.alwaysOnTop !== true);
check("capability permits both labels", JSON.stringify(capability.windows) === JSON.stringify(["main", "widget"]));
for (const permission of ["core:window:allow-show", "core:window:allow-hide", "core:window:allow-set-focus", "core:window:allow-start-dragging"]) {
  check(`capability ${permission}`, capability.permissions.includes(permission));
}
check("widget command set is narrow", !capability.permissions.includes("updater:default") && !capability.permissions.includes("process:default") && widgetCapability.permissions.includes("widget") && !widgetCapability.permissions.includes("main") && !widgetCapability.permissions.includes("process:allow-exit") && !widgetPermissions.includes("allow-app-lock-verify"));
check("main keeps updater and process controls", mainCapability.windows.includes("main") && mainCapability.permissions.includes("main") && mainCapability.permissions.includes("updater:default") && mainCapability.permissions.includes("process:default"));
// The widget is a frame around ONE mini widget, not a window that hosts a tab,
// so its ACL is an exact allowlist of what those mini widgets call. A command
// missing here fails at runtime (denied by the window ACL); an extra command
// re-opens surface the widget has no feature for. Both directions are defects.
const WIDGET_EXCLUDED_COMMANDS = [
  "secret_get", "secret_set",
  "backup_create", "backup_list", "backup_restore", "backup_delete", "backup_prune",
  "vault_rename_preview", "vault_rename_execute",
  "autostart_launch", "provider_probe", "sidecar_python_probe",
];
const allowEntries = (toml) => [...toml.matchAll(/"allow-([a-z0-9_-]+)"/g)].map((m) => m[1].replaceAll("-", "_"));
const mainGranted = allowEntries(mainPermissions);
const widgetGranted = allowEntries(widgetPermissions);
const expectedWidget = mainGranted.filter((c) => !WIDGET_EXCLUDED_COMMANDS.includes(c)).sort();
const actualWidget = [...widgetGranted].sort();
check("widget still withholds credentials and vault admin", WIDGET_EXCLUDED_COMMANDS.every((c) => !widgetGranted.includes(c)));
check("every withheld command is a real registered command", WIDGET_EXCLUDED_COMMANDS.every((c) => mainGranted.includes(c)));
check("query route avoids static full app", main.includes('get("widget") === "1"') && main.includes('import("./WidgetApp.svelte")') && main.includes('import("./App.svelte")'));
check("lazy workspace supports component props", lazyWorkspace.includes("componentProps") && lazyWorkspace.includes("<C {...componentProps} />"));
check("widget never inits forbidden systems", !widget.includes("setupFileWatcher") && !widget.includes("sidecarStart") && !widget.includes("api.rag") && !widget.includes("llmStart") && !widget.includes("sttStart") && !widget.includes("ttsStart"));
  check("widget has no locked-state recovery path", !widget.includes("widgetLocked"));
  check("main watcher stays call-once", (app.match(/api\.setupFileWatcher\(\)/g) ?? []).length === 1 && !settingsPane.includes("setupFileWatcher"));
  check("widget never hydrates secrets", settings.includes("function isWidgetRoute()") && !settings.includes("api.appLockConfigured()") && !widget.includes("secretGet") && !widget.includes("secretSet") && !widgetPermissions.includes("allow-secret"));
  check("open-in-app validates workspace, not lock", bridge.includes("widgetDocGet") && !bridge.includes("doc.locked") && bridge.includes("isWidgetWorkspace") && bridge.includes("workspaces") && !bridge.includes("appLockConfigured"));
// --- The widget is a frame around ONE mini widget, never a window that hosts a tab ---
const WIDGET_ALLOWED_COMMANDS = ["app_boot_ready", "doc_save", "log_get_or_create", "reader_get_bookshelf"];
const registry = await read("src/lib/widgets/registry.ts");
const quickNoteWidget = await read("src/lib/components/widgets/QuickNoteWidget.svelte");
const readerWidget = await read("src/lib/components/widgets/ReaderWidget.svelte");
check("widget is a real rectangle with a hard minimum size", widgetConfig?.minWidth === 280 && widgetConfig?.minHeight === 180 && widgetConfig?.width >= 280 && widgetConfig?.height >= 180, `${widgetConfig?.width}x${widgetConfig?.height} min ${widgetConfig?.minWidth}x${widgetConfig?.minHeight}`);
check("registry floor matches the window config floor", registry.includes("WIDGET_MIN = { w: 280, h: 180 }"));
check("widget native flags", widgetConfig?.decorations === false && widgetConfig?.transparent === false && widgetConfig?.alwaysOnTop === false && widgetConfig?.resizable === true && widgetConfig?.skipTaskbar === true && widgetConfig?.visible === false);
check("widget command set is exactly what the mini widgets call", JSON.stringify([...widgetGranted].sort()) === JSON.stringify([...WIDGET_ALLOWED_COMMANDS].sort()), `${widgetGranted.length} granted`);
check("every widget command is a real main command", WIDGET_ALLOWED_COMMANDS.every((c) => mainGranted.includes(c)));
check("widget grants no AI, voice, memory, search or file-system commands", widgetGranted.every((c) => !/^(ai_|llm_|stt_|tts_|memory_|rag_|fs_|doc_search|search_|graph_|backup_|vault_|secret_)/.test(c)));
check("widget hosts no workspace", !widget.includes("LazyWorkspace") && !widget.includes("workspaceLoader") && !widget.includes("companionMode") && !/Workspace\.svelte/.test(widget));
check("widget renders only registered mini widgets", widget.includes("QuickNoteWidget") && widget.includes("ReaderWidget") && registry.includes("WIDGET_KINDS") && registry.includes('"quicknote"') && registry.includes('"reader"'));
check("widget remembers size and position", widget.includes("widgetGeometry") && widget.includes("onMoved") && widget.includes("onResized") && widget.includes("scheduleGeometrySave"));
check("widget only restores a position the user can reach", widget.includes("reachable("));
check("own placement is not mistaken for a user move", widget.includes("PLACE_ECHO_MS") && widget.includes("placingUntil"));
check("placement is serialised", widget.includes("placeQueue"));
check("widget bar has open-in-app and hide", widget.includes("onclick={openInApp}") && widget.includes('aria-label="Hide widget"'));
check("widget settings keys exist", ["companionWidgetVisible", "widgetKind", "widgetGeometry", "widgetReaderDocId", "widgetReaderSection", "widgetReaderSize", "widgetLaunchAtStartup"].every((k) => settings.includes(k)));
check("settings pick the widget type", settingsPane.includes("setting-companion-widget") && settingsPane.includes("setting-widget-kind") && settingsPane.includes("setting-widget-startup") && !settingsPane.includes("setting-widget-dock"));
check("widget hands off to the main app by workspace", widget.includes('emitTo("main", "widget-open-workspace"'));
check("quick note writes the Logs format and keeps unsent drafts", quickNoteWidget.includes("appendNote") && quickNoteWidget.includes("DRAFT_KEY") && quickNoteWidget.includes("logGetOrCreate"));
check("quick note re-reads today's log right before appending", quickNoteWidget.indexOf("logGetOrCreate") !== -1 && quickNoteWidget.indexOf("logGetOrCreate") < quickNoteWidget.indexOf("docSave"));
check("quick note keeps the text when a save fails", quickNoteWidget.indexOf("text = \"\"") > quickNoteWidget.indexOf("docSave"));
check("reader widget never writes the main reader's state", !readerWidget.includes("readerUpdatePosition") && !readerWidget.includes("readerSetShelfStatus") && !readerWidget.includes("docSave"));
check("cross-window settings sync", settings.includes('window.addEventListener("storage"') && settings.includes('event.key !== "writing-app-settings"') && widget.includes("applyAppearance($settings.theme, $settings.themeMode, $settings.accentOverride)"));
check("widget waits for handoff acknowledgement", widget.includes('listen("main-window-shown"') && widget.includes('listen<string>("widget-open-failed"'));
check("main opens and focuses routed doc or workspace", bridge.includes('listen<string>("widget-open-doc"') && bridge.includes('listen<string>("widget-open-workspace"') && bridge.includes("setFocus()"));
check("tray show/hide entry", rust.includes('MenuItemBuilder::with_id("widget"') && rust.includes('get_webview_window("widget")'));
// Relaunch resurface: closing hides to the tray, so a second launch with no
// file arg must still show the main window (a bare early return = "exe
// does nothing" on double-click). The reveal must precede file handling.
const singleInstance = rust.slice(rust.indexOf("single_instance::init"));
check(
  "relaunch resurfaces hidden main window",
  singleInstance.indexOf("unminimize()") !== -1 &&
    singleInstance.indexOf("unminimize()") < singleInstance.indexOf("find_supported_file") &&
    singleInstance.includes("main.show()") &&
    singleInstance.includes("main.set_focus()")
);
check("autostart plugin is wired", rust.includes("tauri_plugin_autostart::Builder") && mainCapability.permissions.includes("autostart:default") && widgetAutostart.includes("enableAutostart") && widgetAutostart.includes("disableAutostart"));
check("widget backend commands are narrow", rust.includes("commands::widget_doc_get") && rust.includes("commands::widget_doc_save") && rust.includes("commands::widget_atomic_save") && !rust.includes("commands::widget_start") && !rust.includes("pub fn widget_start"));
const handlerBlock = rust.match(/generate_handler!\[(.*?)\]/s)?.[1] ?? "";
const handlerCommands = [...handlerBlock.matchAll(/commands::([a-z0-9_]+)/g)].map((match) => match[1]);
const manifestCommands = [...build.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]).filter((name) => handlerCommands.includes(name));
check("app ACL manifest covers every handler", handlerCommands.length > 0 && manifestCommands.length === handlerCommands.length && handlerCommands.every((command) => manifestCommands.includes(command)), `${manifestCommands.length}/${handlerCommands.length}`);
check("main command permissions cover handler set", handlerCommands.every((command) => mainPermissions.includes(`allow-${command.replaceAll("_", "-")}`)));
for (const command of WIDGET_ALLOWED_COMMANDS) {
  check(`widget command allowed: ${command}`, widgetPermissions.includes(`allow-${command.replaceAll("_", "-")}`));
}
check("main command set includes widget subset", mainPermissions.includes('identifier = "main"') && widgetPermissions.includes('identifier = "widget"'));
// ACL structure: Tauri only reads `permissions = [...]` on [[set]] blocks.
// A [[permission]] block with a `permissions =` key is silently ignored,
// which empties the umbrella set and denies every command.
function permissionBlocksWithList(toml) {
  const blocks = toml.split(/^\s*\[\[/m).slice(1);
  return blocks.filter((b) => /^\s*permission\s*\]\]/.test(b) && /^permissions\s*=/m.test(b));
}
function setIdentifiers(toml) {
  const ids = [];
  for (const b of toml.split(/^\s*\[\[/m).slice(1)) {
    if (!/^\s*set\s*\]\]/.test(b)) continue;
    const m = b.match(/^identifier\s*=\s*"([^"]+)"/m);
    if (m) ids.push(m[1]);
  }
  return ids;
}
check("main ACL is a [[set]] (not an ignored [[permission]] list)", setIdentifiers(mainPermissions).includes("main") && permissionBlocksWithList(mainPermissions).length === 0);
check("widget ACL is a [[set]] (not an ignored [[permission]] list)", setIdentifiers(widgetPermissions).includes("widget") && permissionBlocksWithList(widgetPermissions).length === 0);
check("widget can dock/resize", widgetCapability.permissions.includes("core:window:allow-set-size") && widgetCapability.permissions.includes("core:window:allow-set-position"));

if (failures) {
  console.error(`${failures} widget invariant failure(s)`);
  process.exit(1);
}
console.log("widget-invariants: all checks passed");
