/**
 * settings-validate — unit checks for src/lib/settingsValidate.ts, the
 * shared shape-checker behind settings boot-sanitize, import, reset and
 * numeric blur clamps (Settings → Export / Import).
 *
 * Run: node tests/settings-validate.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdir, rm } from "node:fs/promises";
import { get } from "svelte/store";

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const v = await import(pathToFileURL(join(root, "src/lib/settingsValidate.ts")).href);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

// Unknown keys are dropped, never absorbed.
let r = v.validateSettings({ theme: "brutalist", themeMode: "light", accentOverride: "#FF8800", sidebarFooterCollapsed: true, notARealKey: 1, fileWatcherEnabled: true });
check("valid passes", r.valid.theme === "brutalist" && r.valid.themeMode === "light" && r.valid.accentOverride === "#ff8800" && r.valid.sidebarFooterCollapsed === true);
check("unknown rejected", r.rejected.includes("notARealKey"));
check("removed key rejected", r.rejected.includes("fileWatcherEnabled"));
r = v.validateSettings({ companionWidgetVisible: true, widgetWorkspace: "logs", associatedFileExtensions: ["txt", "md"], widgetAutostartPromptShown: true });
check("widget settings pass", r.valid.companionWidgetVisible === true && r.valid.widgetWorkspace === "logs" && r.valid.associatedFileExtensions.length === 2 && r.valid.widgetAutostartPromptShown === true);
r = v.validateSettings({ companionWidgetVisible: "yes", widgetWorkspace: "unknown" });
check("bad widget settings rejected", r.rejected.includes("companionWidgetVisible") && r.rejected.includes("widgetWorkspace"));

// Secrets are rejected loudly, never merged.
r = v.validateSettings({ apiKey: "sk-live", appLockPin: "1234", fontSize: 18 });
check("apiKey secret", r.secrets.includes("apiKey") && !("apiKey" in r.valid));
check("appLockPin secret", r.secrets.includes("appLockPin") && !("appLockPin" in r.valid));
check("valid alongside secrets kept", r.valid.fontSize === 18);

// Wrong types + bad enums rejected.
r = v.validateSettings({ theme: 42, fontSize: "big", ghostEnabled: "yes" });
check("non-string enum rejected", r.rejected.includes("theme"));
check("non-number rejected", r.rejected.includes("fontSize"));
check("non-bool rejected", r.rejected.includes("ghostEnabled"));
r = v.validateSettings({ fontFamily: "Comic Sans", fontSize: "18", lineHeight: "2.0" });
check("unknown editor font rejected", r.rejected.includes("fontFamily"));
check("numeric setting strings normalized", r.valid.fontSize === 18 && r.valid.lineHeight === 2);
r = v.validateSettings({ theme: "neon", themeMode: "dim", accentOverride: "red", backupFrequency: "sometimes" });
check("bad enum rejected", r.rejected.includes("theme") && r.rejected.includes("backupFrequency"));
check("bad mode + accent rejected", r.rejected.includes("themeMode") && r.rejected.includes("accentOverride"));
r = v.validateSettings({ theme: "dark", accentOverride: "" });
check("legacy theme + empty accent rejected", r.rejected.includes("theme"));
check("empty accent passes", v.validateSettings({ accentOverride: "" }).valid.accentOverride === "");

// Out-of-range numbers clamped, reported, present in valid.
r = v.validateSettings({ fontSize: 99, streakGoal: -5, ttsSpeed: 9, snapshotRetentionDays: 3 });
check("high clamp", r.valid.fontSize === 32 && r.clamped.includes("fontSize"));
check("low clamp", r.valid.streakGoal === 0 && r.clamped.includes("streakGoal"));
check("float clamp", r.valid.ttsSpeed === 4 && r.clamped.includes("ttsSpeed"));
check("int clamp", r.valid.snapshotRetentionDays === 7 && r.clamped.includes("snapshotRetentionDays"));

// Non-integers and non-finite numbers rejected, not clamped.
r = v.validateSettings({ aiRateLimitCooldown: 1.5, fontSize: NaN });
check("float-for-int rejected", r.rejected.includes("aiRateLimitCooldown"));
check("NaN rejected", r.rejected.includes("fontSize"));

// Nullables, arrays, records.
r = v.validateSettings({
  hiddenIds: null,
  lastTriageShown: null,
  dismissedNudges: ["ghost"],
  keybindings: { "Ctrl+K": "Command palette" },
  workspacePrivacy: { logs: true },
  templates: [],
});
check("nullables pass", r.valid.hiddenIds === null && r.valid.lastTriageShown === null);
check("string array passes", Array.isArray(r.valid.dismissedNudges));
check("record passes", typeof r.valid.keybindings === "object");
r = v.validateSettings({ hiddenIds: "nope", featuresUsed: [1], keybindings: [] });
check("bad nullable rejected", r.rejected.includes("hiddenIds"));
check("bad string array rejected", r.rejected.includes("featuresUsed"));
check("array-for-record rejected", r.rejected.includes("keybindings"));

// Single-key blur clamp.
check("clamp high", v.clampNumber("fontSize", 99) === 32);
check("clamp in-range", v.clampNumber("fontSize", 18) === 18);
check("clamp int rounds", v.clampNumber("snapshotRetentionDays", 30.7) === 31);
check("clamp non-number null", v.clampNumber("fontSize", "x") === null);
check("clamp non-ranged null", v.clampNumber("theme", "dark") === null);
check("clamp unknown null", v.clampNumber("nope", 5) === null);

// Retired-provider migration (exact old defaults move forward, customs stay).
const FRESH = { mainModelEndpoint: "https://api.openai.com/v1", mainModelName: "gpt-4o-mini" };
let m = v.migrateRetiredProviders({ mainModelEndpoint: "http://localhost:11434/v1", mainModelName: "llama3.2" }, FRESH);
check("ollama defaults migrate", m.patch.mainModelEndpoint === FRESH.mainModelEndpoint && m.patch.mainModelName === FRESH.mainModelName && m.migrated.length === 2);
m = v.migrateRetiredProviders({ mainModelEndpoint: "http://localhost:11434/v1", mainModelName: "gpt-4o" }, FRESH);
check("endpoint migrates, custom model stays", m.patch.mainModelEndpoint === FRESH.mainModelEndpoint && m.patch.mainModelName === "gpt-4o" && m.migrated.length === 1);
m = v.migrateRetiredProviders({ mainModelEndpoint: "https://proxy.lan/v1", mainModelName: "qwen3:8b" }, FRESH);
check("custom endpoint stays, retired model migrates", m.patch.mainModelEndpoint === "https://proxy.lan/v1" && m.patch.mainModelName === FRESH.mainModelName && m.migrated.length === 1);
m = v.migrateRetiredProviders({ mainModelEndpoint: "https://proxy.lan/v1", mainModelName: "my-model" }, FRESH);
check("full custom untouched", m.migrated.length === 0 && m.patch.mainModelName === "my-model");

const esbuild = await import("esbuild");
const lockOutDir = join(root, "tests", ".tmp-lock-flow");
const lockOutFile = join(lockOutDir, "lock.mjs");
await mkdir(lockOutDir, { recursive: true });
await esbuild.build({
  stdin: {
    contents: `export * from ${JSON.stringify(join(root, "src/lib/stores/lock.ts"))}; export { settings, DEFAULT_SETTINGS, appLockPinStatus, resetSettings } from ${JSON.stringify(join(root, "src/lib/stores/settings.ts"))};`,
    resolveDir: root,
    sourcefile: "lock-flow.ts",
    loader: "ts",
  },
  bundle: true,
  platform: "node",
  format: "esm",
  alias: { $lib: join(root, "src/lib") },
  outfile: lockOutFile,
  logLevel: "silent",
});
const lock = await import(`${pathToFileURL(lockOutFile).href}?${Date.now()}`);
await new Promise((resolve) => setTimeout(resolve, 100));
check("locking defaults off", lock.DEFAULT_SETTINGS.lockEnabled === false);
let shortPinRejected = false;
try {
  await lock.configurePin("123", "123");
} catch {
  shortPinRejected = true;
}
check("short PIN rejected", shortPinRejected);
let mismatchedPinRejected = false;
try {
  await lock.configurePin("2468", "2469");
} catch {
  mismatchedPinRejected = true;
}
check("PIN confirmation is enforced by lock store", mismatchedPinRejected);
lock.appLockPinStatus.set("error");
let unavailablePinRejected = false;
try {
  await lock.configurePin("2468", "2468");
} catch {
  unavailablePinRejected = true;
}
check("unknown PIN storage fails closed", unavailablePinRejected);
lock.appLockPinStatus.set("ready");
await lock.configurePin("2468", "2468");
check("PIN setup enables locking", get(lock.settings).lockEnabled === true);
check("PIN setup is immediately usable", await lock.hasPin() && get(lock.settings).appLockPin === "2468");
lock.resetSettings();
check("settings reset preserves lock secrets", get(lock.settings).lockEnabled === true && get(lock.settings).appLockPin === "2468");
check("PIN setup unlocks current session", get(lock.appUnlocked) === true);
lock.lockAppNow();
check("lock-now closes the session gate", get(lock.appUnlocked) === false);
check("configured PIN verifies", await lock.verifyPin("2468") && get(lock.appUnlocked) === false);
for (let attempt = 0; attempt < 5; attempt += 1) await lock.verifyPin("0000");
check("wrong PIN attempts create backoff", lock.pinLockoutRemaining() > 0);
check("backend rejects correct PIN during backoff", !(await lock.verifyPin("2468")) && lock.pinLockoutRemaining() > 0);
lock.markAppUnlocked();
await lock.removePin();
check("PIN removal disables locking", !get(lock.settings).lockEnabled && get(lock.settings).appLockPin === "");
lock.appLockPinStatus.set("error");
await lock.resetPinConfiguration();
check("PIN recovery reopens configuration flow", get(lock.appLockPinStatus) === "ready" && !get(lock.settings).lockEnabled);
await rm(lockOutDir, { recursive: true, force: true });

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("settings-validate: all checks passed");
