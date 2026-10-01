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
check("reveal chains off geometry restore", app.includes("restoreMainWindow().finally"));
check(
  "reveal repeats on remaining boot exits",
  app.includes("void showMainWindow();") && (app.match(/void showMainWindow\(\);/g) ?? []).length >= 3
);
const widgetConfig = windows.find((w) => w.label === "widget");
check("widget route URL", widgetConfig?.url === "index.html?widget=1");
check("widget starts as a compact figure", widgetConfig?.width === 56 && widgetConfig?.height === 56 && widgetConfig?.minWidth === 48 && widgetConfig?.minHeight === 48);
check("widget native flags", widgetConfig?.decorations === false && widgetConfig?.transparent === true && widgetConfig?.alwaysOnTop === true && widgetConfig?.resizable === true && widgetConfig?.skipTaskbar === true && widgetConfig?.visible === false);
check("capability permits both labels", JSON.stringify(capability.windows) === JSON.stringify(["main", "widget"]));
for (const permission of ["core:window:allow-show", "core:window:allow-hide", "core:window:allow-set-focus", "core:window:allow-start-dragging"]) {
  check(`capability ${permission}`, capability.permissions.includes(permission));
}
check("widget command set is narrow", !capability.permissions.includes("updater:default") && !capability.permissions.includes("process:default") && widgetCapability.permissions.includes("widget") && !widgetCapability.permissions.includes("main") && !widgetCapability.permissions.includes("process:allow-exit") && !widgetPermissions.includes("allow-app-lock-verify"));
check("main keeps updater and process controls", mainCapability.windows.includes("main") && mainCapability.permissions.includes("main") && mainCapability.permissions.includes("updater:default") && mainCapability.permissions.includes("process:default"));
check("query route avoids static full app", main.includes('get("widget") === "1"') && main.includes('import("./WidgetApp.svelte")') && main.includes('import("./App.svelte")'));
check("minimal widget shell", widget.includes("LazyWorkspace") && !widget.includes("Sidebar") && !widget.includes("TabBar") && !widget.includes("InspectorPanel") && !widget.includes("CommandPalette") && !widget.includes("QuickCaptureInput"));
check("all canonical workspace surfaces are lazy", ["HomePane", "LogsWorkspace", "EditorPane", "InboxWorkspace", "NodeMapWorkspace", "CanvasWorkspace", "NovelWorkspace", "ScriptWorkspace", "ProjectsWorkspace", "ReaderWorkspace", "LibraryWorkspace"].every((name) => widget.includes(name)) && appStores.includes('export type WorkspaceId'));
check("lazy workspace supports component props", lazyWorkspace.includes("componentProps") && lazyWorkspace.includes("<C {...componentProps} />"));
check("files deep-links into library", widget.includes('initialTab: "files"') && libraryWorkspace.includes("initialTab"));
check("widget never inits forbidden systems", !widget.includes("setupFileWatcher") && !widget.includes("sidecarStart") && !widget.includes("api.rag") && !widget.includes("llmStart") && !widget.includes("sttStart") && !widget.includes("ttsStart"));
check("widget has collapsed/expanded geometry", widget.includes("setCollapsed") && widget.includes("placeWidget") && widget.includes("widgetDockEdge") && widget.includes("widgetDockOffset") && widget.includes("onMoved"));
check("locked widget expands for recovery", widget.includes("widgetLocked") && widget.includes("placeWidget(false"));
check("write uses the existing companion editor", widget.includes('companionMode: true') && editor.includes("!companionMode && $settings.ghostEnabled") && editor.includes("{#if !companionMode}") && editor.includes("if (companionMode) return false"));
check("main watcher stays call-once", (app.match(/api\.setupFileWatcher\(\)/g) ?? []).length === 1 && !settingsPane.includes("setupFileWatcher"));
check("settings own widget state", settings.includes("companionWidgetVisible") && settings.includes("widgetWorkspace") && settings.includes("widgetCollapsed") && settings.includes("widgetDockEdge") && settings.includes("widgetDockOffset") && settings.includes("widgetLaunchAtStartup"));
check("widget never hydrates secrets", settings.includes("function isWidgetRoute()") && settings.includes("api.appLockConfigured()") && !widget.includes("secretGet") && !widget.includes("secretSet") && !widgetPermissions.includes("allow-secret"));
check("locked docs excluded before widget state", widget.includes('api.docSearchFull("", workspace)') && !widget.includes(".filter((doc) => !doc.locked)"));
check("open-in-app validates unlocked allowed doc", bridge.includes("widgetDocGet") && bridge.includes("doc.locked") && bridge.includes("isWidgetWorkspace") && bridge.includes("workspaces") && bridge.includes("appLockConfigured"));
check("cross-window settings sync", settings.includes('window.addEventListener("storage"') && settings.includes('event.key !== "writing-app-settings"') && widget.includes("applyAppearance($settings.theme, $settings.themeMode, $settings.accentOverride)"));
check("settings toggle and dock controls wired", settingsPane.includes("setting-companion-widget") && settingsPane.includes("setting-widget-workspace") && settingsPane.includes("setting-widget-dock-edge") && settingsPane.includes("setting-widget-dock-offset") && settingsPane.includes("setting-widget-startup"));
check("widget emits doc and workspace handoffs", widget.includes('emitTo("main", "widget-open-doc"') && widget.includes('emitTo("main", "widget-open-workspace"'));
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
    singleInstance.indexOf("unminimize()") < singleInstance.indexOf("find_text_file") &&
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
for (const command of ["widget_doc_get", "doc_create", "widget_doc_save", "doc_search_full", "log_get_or_create", "usage_record", "widget_atomic_save", "bible_get_facts", "snapshot_list"]) {
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
