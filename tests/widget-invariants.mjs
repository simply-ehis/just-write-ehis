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
const bridge = await read("src/lib/widgetBridge.ts");
const main = await read("src/main.ts");
const widget = await read("src/WidgetApp.svelte");
const settings = await read("src/lib/stores/settings.ts");
const editor = await read("src/lib/components/EditorPane.svelte");
const settingsPane = await read("src/lib/components/SettingsPane.svelte");
const rust = await read("src-tauri/src/lib.rs");
const build = await read("src-tauri/build.rs");
const mainPermissions = await read("src-tauri/permissions/main.toml");
const widgetPermissions = await read("src-tauri/permissions/widget.toml");

const windows = config.app?.windows ?? [];
check("two configured windows", windows.length === 2, windows.map((w) => w.label).join(", "));
const widgetConfig = windows.find((w) => w.label === "widget");
check("widget route URL", widgetConfig?.url === "index.html?widget=1");
check("widget dimensions", widgetConfig?.width === 360 && widgetConfig?.height === 520 && widgetConfig?.minWidth === 280 && widgetConfig?.minHeight === 400);
check("widget native flags", widgetConfig?.decorations === false && widgetConfig?.alwaysOnTop === true && widgetConfig?.resizable === true && widgetConfig?.skipTaskbar === true && widgetConfig?.visible === false);
check("capability permits both labels", JSON.stringify(capability.windows) === JSON.stringify(["main", "widget"]));
for (const permission of ["core:window:allow-show", "core:window:allow-hide", "core:window:allow-set-focus", "core:window:allow-start-dragging"]) {
  check(`capability ${permission}`, capability.permissions.includes(permission));
}
check("widget command set is narrow", !capability.permissions.includes("updater:default") && !capability.permissions.includes("process:default") && widgetCapability.permissions.includes("widget") && widgetCapability.permissions.includes("process:allow-exit") && !widgetCapability.permissions.includes("main"));
check("main keeps updater and process controls", mainCapability.windows.includes("main") && mainCapability.permissions.includes("main") && mainCapability.permissions.includes("updater:default") && mainCapability.permissions.includes("process:default"));
check("query route avoids static full app", main.includes('get("widget") === "1"') && main.includes('import("./WidgetApp.svelte")') && main.includes('import("./App.svelte")'));
check("minimal widget shell", widget.includes("EditorPane") && widget.includes("QuickCaptureInput") && !widget.includes("Sidebar") && !widget.includes("TabBar") && !widget.includes("InspectorPanel") && !widget.includes("CommandPalette") && !widget.includes("LazyWorkspace"));
check("widget never inits forbidden systems", !widget.includes("setupFileWatcher") && !widget.includes("sidecarStart") && !widget.includes("api.rag") && !widget.includes("llmStart") && !widget.includes("sttStart") && !widget.includes("ttsStart"));
check("editor companion mode blocks ghost, chrome, and AI shortcuts", widget.includes("companionMode") && editor.includes("!companionMode && $settings.ghostEnabled") && editor.includes("{#if !companionMode}") && editor.includes('command.label !== "Structurize"') && editor.includes("if (companionMode) return false"));
check("hidden widget defers editor chunk", widget.includes("widgetVisible") && widget.includes('await import("$lib/components/EditorPane.svelte")'));
check("main watcher stays call-once", (app.match(/api\.setupFileWatcher\(\)/g) ?? []).length === 1 && !settingsPane.includes("setupFileWatcher"));
check("settings own widget state", settings.includes("companionWidgetVisible") && settings.includes("widgetWorkspace") && settings.includes('widgetWorkspace: "write"'));
check("widget never hydrates secrets", settings.includes("function isWidgetRoute()") && settings.includes("if (isWidgetRoute()) resolveSecretsReady()") && settings.includes('apiKey: ""'));
check("locked docs excluded before widget state", widget.includes('api.docSearchFull("", workspace)') && !widget.includes(".filter((doc) => !doc.locked)"));
check("open-in-app validates unlocked allowed doc", bridge.includes("doc.locked") && bridge.includes("WIDGET_WORKSPACES"));
check("cross-window settings sync", settings.includes('window.addEventListener("storage"') && settings.includes('event.key !== "writing-app-settings"') && widget.includes("document.documentElement.dataset.theme = $settings.theme"));
check("settings toggle wired", settingsPane.includes("setting-companion-widget") && settingsPane.includes("setting-widget-workspace") && settingsPane.includes("Companion widget"));
check("widget emits open-in-app", widget.includes('emitTo("main", "widget-open-doc"'));
check("main opens and focuses routed doc", bridge.includes('listen<string>("widget-open-doc"') && bridge.includes("setFocus()"));
check("tray show/hide entry", rust.includes('MenuItemBuilder::with_id("widget"') && rust.includes('get_webview_window("widget")'));
check("no widget backend command", !rust.includes("commands::widget_") && !rust.includes("pub fn widget_"));
const handlerBlock = rust.match(/generate_handler!\[(.*?)\]/s)?.[1] ?? "";
const handlerCommands = [...handlerBlock.matchAll(/commands::([a-z0-9_]+)/g)].map((match) => match[1]);
const manifestCommands = [...build.matchAll(/"([a-z0-9_]+)"/g)].map((match) => match[1]).filter((name) => handlerCommands.includes(name));
check("app ACL manifest covers every handler", handlerCommands.length > 0 && manifestCommands.length === handlerCommands.length && handlerCommands.every((command) => manifestCommands.includes(command)), `${manifestCommands.length}/${handlerCommands.length}`);
check("main command permissions cover handler set", handlerCommands.every((command) => mainPermissions.includes(`allow-${command.replaceAll("_", "-")}`)));
for (const command of ["doc_get", "doc_create", "doc_save", "doc_search_full", "log_get_or_create", "usage_record", "atomic_save", "bible_get_facts", "snapshot_list"]) {
  check(`widget command allowed: ${command}`, widgetPermissions.includes(`allow-${command.replaceAll("_", "-")}`));
}
check("main command set includes widget subset", mainPermissions.includes("[main]") && widgetPermissions.includes("[widget]"));

if (failures) {
  console.error(`${failures} widget invariant failure(s)`);
  process.exit(1);
}
console.log("widget-invariants: all checks passed");
