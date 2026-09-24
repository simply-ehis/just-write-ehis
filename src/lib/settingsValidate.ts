/**
 * settingsValidate — pure shape-checking for AppSettings patches.
 *
 * Zero imports (no svelte/store): settings.ts uses it at boot (sanitize
 * loaded JSON) and SettingsPane uses it on import/reset/blur. Unit-tested
 * directly by tests/settings-validate.mjs — no build needed.
 *
 * Every key this version knows is in SCHEMA. Anything else (unknown keys,
 * secrets, wrong types) is REJECTED, never silently absorbed; out-of-range
 * numbers are CLAMPED and reported. Callers must surface rejected/secrets/
 * clamped loudly — a settings file must never smuggle credentials.
 */

/** Keys that live in the OS keychain, never in a settings file. */
export const SECRET_KEYS = ["apiKey", "appLockPin"] as const;

type Kind =
  | "bool"
  | "str"
  | "strnull"
  | "enum"
  | "num"
  | "int"
  | "strarr"
  | "strarrnull"
  | "obj"
  | "arr";

interface Rule {
  kind: Kind;
  values?: readonly string[];
  min?: number;
  max?: number;
}

const BOOL: Rule = { kind: "bool" };
const STR: Rule = { kind: "str" };
const STRNULL: Rule = { kind: "strnull" };
const STRARR: Rule = { kind: "strarr" };
const OBJ: Rule = { kind: "obj" };
const ARR: Rule = { kind: "arr" };
const ENUM = (...values: string[]): Rule => ({ kind: "enum", values });
const NUM = (min: number, max: number): Rule => ({ kind: "num", min, max });
const INT = (min: number, max: number): Rule => ({ kind: "int", min, max });

/** Every importable/sanitizable setting this version knows. */
const SCHEMA: Record<string, Rule> = {
  theme: ENUM("dark", "light", "brutalist", "glass"),
  iconSet: ENUM("phosphor", "tabler"),
  streakGoal: INT(0, 100000),
  compactMode: BOOL,
  autoHideChrome: BOOL,
  companionWidgetVisible: BOOL,
  widgetWorkspace: ENUM("home", "logs", "write", "inbox", "map", "canvas", "novel", "script", "projects", "reader", "files", "properties"),
  widgetCollapsed: BOOL,
  widgetDockEdge: ENUM("left", "right", "top", "bottom"),
  widgetDockOffset: INT(0, 100000),
  widgetLaunchAtStartup: BOOL,

  fontSize: NUM(10, 32),
  lineHeight: NUM(1, 3),
  fontFamily: STR,
  readerFont: ENUM("serif", "sans", "mono"),
  readerSize: NUM(10, 32),
  readerMeasure: ENUM("narrow", "comfortable", "wide"),
  readerTheme: ENUM("app", "light", "sepia", "dark"),
  typewriterDefault: BOOL,
  focusDimmingDefault: BOOL,
  autocorrectEnabled: BOOL,
  ghostEnabled: BOOL,
  dictionaryLanguage: ENUM("en", "off"),
  formatToolbarOpen: BOOL,

  smallModelEndpoint: STR,
  smallModelName: STR,
  smallModelContextLength: INT(1024, 131072),
  useSmallAsMain: BOOL,
  mainModelEndpoint: STR,
  mainModelName: STR,
  aiRateLimitCooldown: INT(0, 60000),
  sidecarHarnessDir: STR,
  blankModeDefault: BOOL,
  logsLocalOnly: BOOL,
  scrubSecrets: BOOL,
  aiMemoryEnabled: BOOL,

  lockEnabled: BOOL,
  craftProfilingEnabled: BOOL,

  vaultPath: STR,
  backupFrequency: ENUM("daily", "weekly", "monthly", "never"),
  snapshotRetentionDays: INT(7, 365),

  androidCaptureMethod: ENUM("notification", "widget", "share-target"),
  weeklyTriageReminder: BOOL,
  streakReminder: BOOL,
  logsStampPlace: BOOL,
  lastTriageShown: STRNULL,
  lastStreakShown: STRNULL,
  lastAutoBackup: STRNULL,

  keybindings: OBJ,
  featuresUsed: STRARR,
  dismissedNudges: STRARR,
  aiPersona: STR,
  templates: ARR,

  hasOnboarded: BOOL,
  onboardedVersion: INT(0, 99),
  onboardSkipped: BOOL,
  topBarIds: STRARR,
  hiddenIds: { kind: "strarrnull" },
  defaultWorkspace: STR,
  workspacePrivacy: OBJ,
  savedViews: ARR,

  autoCheckUpdates: BOOL,

  sttEnabled: BOOL,
  sttModel: STR,
  ttsModel: STR,
  ttsEnabled: BOOL,
  ttsVoice: STR,
  ttsLangCode: STR,
  ttsSpeed: NUM(0.25, 4),
  ttsChunkSize: INT(20, 2000),
  ttsSplitPattern: STR,
  pythonPath: STR,
  llmEnabled: BOOL,
  llmModel: STR,
  rhythmHeatmapInStatusBar: BOOL,
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export interface ValidationReport {
  /** Patch entries that passed, ready to merge into settings. */
  valid: Record<string, unknown>;
  /** Dropped: unknown keys + wrong types + bad enum values. */
  rejected: string[];
  /** Out-of-range numbers, fixed to the nearest bound (in valid). */
  clamped: string[];
  /** Secrets a file tried to smuggle — rejected, always reported. */
  secrets: string[];
}

export function validateSettings(
  patch: Record<string, unknown>,
  secrets: readonly string[] = SECRET_KEYS,
): ValidationReport {
  const valid: Record<string, unknown> = {};
  const rejected: string[] = [];
  const clamped: string[] = [];
  const secretsHit: string[] = [];
  for (const [k, v] of Object.entries(patch)) {
    if (secrets.includes(k)) {
      secretsHit.push(k);
      continue;
    }
    const rule = SCHEMA[k];
    if (!rule) {
      rejected.push(k);
      continue;
    }
    switch (rule.kind) {
      case "bool":
        if (typeof v === "boolean") valid[k] = v;
        else rejected.push(k);
        break;
      case "str":
        if (typeof v === "string") valid[k] = v;
        else rejected.push(k);
        break;
      case "strnull":
        if (typeof v === "string" || v === null) valid[k] = v;
        else rejected.push(k);
        break;
      case "enum":
        if (typeof v === "string" && rule.values!.includes(v)) valid[k] = v;
        else rejected.push(k);
        break;
      case "num":
      case "int": {
        if (typeof v !== "number" || !Number.isFinite(v) || (rule.kind === "int" && !Number.isInteger(v))) {
          rejected.push(k);
          break;
        }
        const lo = rule.min!;
        const hi = rule.max!;
        if (v < lo || v > hi) {
          valid[k] = Math.min(hi, Math.max(lo, v));
          clamped.push(k);
        } else {
          valid[k] = v;
        }
        break;
      }
      case "strarr":
        if (Array.isArray(v) && v.every((e) => typeof e === "string")) valid[k] = v;
        else rejected.push(k);
        break;
      case "strarrnull":
        if (v === null || (Array.isArray(v) && v.every((e) => typeof e === "string"))) valid[k] = v;
        else rejected.push(k);
        break;
      case "obj":
        if (isRecord(v)) valid[k] = v;
        else rejected.push(k);
        break;
      case "arr":
        if (Array.isArray(v)) valid[k] = v;
        else rejected.push(k);
        break;
    }
  }
  return { valid, rejected, clamped, secrets: secretsHit };
}

/**
 * Single-key numeric clamp for input blur handlers. Returns the clamped
 * value, or null when the key isn't a ranged number (caller keeps input).
 */
export function clampNumber(key: string, value: unknown): number | null {
  const rule = SCHEMA[key];
  if (!rule || (rule.kind !== "num" && rule.kind !== "int")) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const fixed = Math.min(rule.max!, Math.max(rule.min!, value));
  return rule.kind === "int" ? Math.round(fixed) : fixed;
}

/** Retired main-slot defaults (Ollama era). Exact matches migrate forward. */
const RETIRED_MAIN_ENDPOINT = "http://localhost:11434/v1";
const RETIRED_MAIN_MODELS: readonly string[] = ["llama3.2", "qwen3:0.6b", "qwen3:8b"];

export interface MigrationReport {
  patch: Record<string, unknown>;
  migrated: string[];
}

/**
 * Move stored settings off retired provider defaults (exact matches only —
 * anything the user deliberately customized to other values is untouched).
 * Returns the patched record plus the migrated key names for reporting.
 */
export function migrateRetiredProviders(
  patch: Record<string, unknown>,
  defaults: { mainModelEndpoint: string; mainModelName: string },
): MigrationReport {
  const next = { ...patch };
  const migrated: string[] = [];
  if (next.mainModelEndpoint === RETIRED_MAIN_ENDPOINT) {
    next.mainModelEndpoint = defaults.mainModelEndpoint;
    migrated.push("mainModelEndpoint");
  }
  if (typeof next.mainModelName === "string" && RETIRED_MAIN_MODELS.includes(next.mainModelName)) {
    next.mainModelName = defaults.mainModelName;
    migrated.push("mainModelName");
  }
  return { patch: next, migrated };
}
