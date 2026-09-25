/**
 * settings-validate — unit checks for src/lib/settingsValidate.ts, the
 * shared shape-checker behind settings boot-sanitize, import, reset and
 * numeric blur clamps (Settings → Export / Import).
 *
 * Run: node tests/settings-validate.mjs (no build needed)
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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

if (failures > 0) {
  console.error(`${failures} failure(s)`);
  process.exit(1);
}
console.log("settings-validate: all checks passed");
