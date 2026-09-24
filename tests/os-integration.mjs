import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path) => readFile(join(root, path), "utf8");
let failures = 0;
const check = (name, condition, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!condition) failures++;
};

const windowsConfig = JSON.parse(await read("src-tauri/tauri.windows.conf.json"));
const association = windowsConfig.bundle?.fileAssociations?.[0];
check("Windows association config exists", windowsConfig.bundle?.windows?.nsis?.installerHooks === "./windows/hooks.nsh");
check("association list is exactly txt and md", JSON.stringify(association?.ext) === JSON.stringify(["txt", "md"]));
const hooks = await read("src-tauri/windows/hooks.nsh");
check("uninstall removes Run entry", hooks.includes("CurrentVersion\\Run") && hooks.includes("Just Write ehis"));
check("uninstall removes StartupApproved entry", hooks.includes("StartupApproved\\Run"));
const cargo = await read("src-tauri/Cargo.toml");
check("single-instance is Windows-only", cargo.includes('[target."cfg(target_os = \\"windows\\")".dependencies]') && cargo.includes("tauri-plugin-single-instance"));
check("autostart is Windows-only", cargo.includes("tauri-plugin-autostart"));
const lib = await read("src-tauri/src/lib.rs");
const builderStart = lib.indexOf("tauri::Builder::default()");
const singleInstance = lib.indexOf("tauri_plugin_single_instance::init");
const processPlugin = lib.indexOf("tauri_plugin_process::init");
check("single instance registers first", singleInstance > builderStart && singleInstance < processPlugin);
check("single-instance forwards text file paths", lib.includes("native-file-open") && lib.includes("PendingLaunchFile"));
const commands = await read("src-tauri/src/commands.rs");
check("external file import is guarded", commands.includes('extension != "txt" && extension != "md"') && commands.includes("open_external_file"));
check("default app button does not write UserChoice", commands.includes("ms-settings:defaultapps") && !commands.includes("UserChoice"));
const settings = await read("src/lib/components/SettingsPane.svelte");
const autostart = await read("src/lib/widgetAutostart.ts");
const onboarding = await read("src/lib/components/OnboardingOverlay.svelte");
const settingsStore = await read("src/lib/stores/settings.ts");
check("settings expose all Windows controls", settings.includes("setting-companion-widget") && settings.includes("setting-widget-startup") && settings.includes("setting-default-app") && settings.includes("setting-associated-extensions"));
check("onboarding explains Windows integration", onboarding.includes("windowsStep") && onboarding.includes("Open your writing from Windows") && onboarding.includes("Open Windows Default Apps") && settingsStore.includes("ONBOARD_VERSION = 2"));
check("autostart prompt is explicit", autostart.includes("Also start Just Write ehis automatically with Windows? Choose Cancel to decline."));
if (failures) {
  console.error(`${failures} OS integration failure(s)`);
  process.exit(1);
}
console.log("os-integration: all checks passed");
