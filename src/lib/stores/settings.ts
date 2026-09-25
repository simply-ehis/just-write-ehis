import { writable, get } from "svelte/store";
import { SECRET_KEYS, validateSettings, migrateRetiredProviders } from "$lib/settingsValidate";

/** Re-exported so panes strip secrets with the same single list. */
export { SECRET_KEYS };

export type SettingsCategory =
  | "general"
  | "editor"
  | "ai"
  | "privacy"
  | "vaults"
  | "capture"
  | "keybindings"
  | "skills"
  | "craft"
  | "stats"
  | "about";

export interface SavedView {
  name: string;
  viewMode: "table" | "board" | "calendar";
  filterWorkspace: string;
  filterStatus: string;
  searchQuery: string;
  sortField: string;
  sortDir: "asc" | "desc";
  boardGroupBy: "workspace" | "status";
}

export interface AppSettings {
  /** Visual style: default room, brutalist concrete, or glass frost. */
  theme: "default" | "brutalist" | "glass";
  /** Light or dark base under any style. */
  themeMode: "dark" | "light";
  /** Custom accent override (#rrggbb) — empty means the style's accent. */
  accentOverride: string;
  iconSet: "phosphor" | "tabler";
  /** Sidebar footer (Auto-sort / New Doc / AI Panel / streak) collapsed. */
  sidebarFooterCollapsed: boolean;
  streakGoal: number;
  /** Tighter chrome (tabs, breadcrumb, nav) without changing layout. */
  compactMode: boolean;
  autoHideChrome: boolean;
  companionWidgetVisible: boolean;
  widgetWorkspace: string;
  widgetCollapsed: boolean;
  widgetDockEdge: "left" | "right" | "top" | "bottom";
  widgetDockOffset: number;
  widgetLaunchAtStartup: boolean;
  widgetAutostartPromptShown: boolean;
  associatedFileExtensions: string[];

  fontSize: number;
  lineHeight: number;
  fontFamily: string;
  readerFont: "serif" | "sans" | "mono";
  readerSize: number;
  readerMeasure: "narrow" | "comfortable" | "wide";
  readerTheme: "app" | "light" | "sepia" | "dark";
  typewriterDefault: boolean;
  focusDimmingDefault: boolean;
  autocorrectEnabled: boolean;
  ghostEnabled: boolean;
  /** "en" = English typo table; "off" = custom words only (for other languages). */
  dictionaryLanguage: "en" | "off";
  /** Formatting toolbar open (Aa toggle) — shared by every editor. */
  formatToolbarOpen: boolean;

  smallModelEndpoint: string;
  smallModelName: string;
  /** llama-server --ctx-size for the bundled small model (takes effect on next sidecar start). */
  smallModelContextLength: number;
  /** Route the AI panel's main slot (chat/composer/structurize) at the small model. */
  useSmallAsMain: boolean;
  mainModelEndpoint: string;
  mainModelName: string;
  /** Minimum milliseconds between AI sends (0 = no limit). */
  aiRateLimitCooldown: number;
  apiKey: string;
  /** Working dir of the small-model harness server (sidecar toggle needs it). */
  sidecarHarnessDir: string;
  blankModeDefault: boolean;
  logsLocalOnly: boolean;
  /** Scrub secrets from outgoing AI prompts via the memory sidecar. */
  scrubSecrets: boolean;
  /** Learn cross-session facts + inject recall into chat context. */
  aiMemoryEnabled: boolean;

  appLockPin: string;
  /** Master switch for per-doc PIN locking. Off = no LockScreen,
   * no lock menus, no AI exclusion; locked flags stay stored. */
  lockEnabled: boolean;
  craftProfilingEnabled: boolean;

  vaultPath: string;
  backupFrequency: "daily" | "weekly" | "monthly" | "never";
  snapshotRetentionDays: number;

  androidCaptureMethod: "notification" | "widget" | "share-target";
  weeklyTriageReminder: boolean;
  streakReminder: boolean;
  logsStampPlace: boolean;
  lastTriageShown: string | null;
  lastStreakShown: string | null;
  lastAutoBackup: string | null;

  keybindings: Record<string, string>;
  featuresUsed: string[];
  dismissedNudges: string[];
  aiPersona: string;
  templates: { name: string; content: string; workspace: string }[];

  // First-run onboarding (Area 5): explicit versioned flag replaces the
  // old featuresUsed.length===0 proxy. Veterans (featuresUsed non-empty,
  // flag absent) are migrated to hasOnboarded=true silently at boot.
  hasOnboarded: boolean;
  onboardedVersion: number;
  onboardSkipped: boolean;
  // Top-bar pins (desktop sidebar header + mobile BottomBar main row) and
  // sidebar hides chosen during onboarding. [] = not customized (current
  // behavior); null hiddenIds = default hides (inbox/canvas/files).
  topBarIds: string[];
  hiddenIds: string[] | null;
  // Landing workspace on fresh boot with nothing to restore.
  defaultWorkspace: string;

  // Per-workspace AI privacy: workspaceId → true = local only, no API calls
  workspacePrivacy: Record<string, boolean>;

  // Saved Properties views: name + filter + sort + group + mode.
  savedViews: SavedView[];

  // App updates (Tauri shell only; browser preview is rebuilt, not updated)
  autoCheckUpdates: boolean;

  // Audio: STT (Moonshine-base GGUF via transcribe.cpp) + TTS (Kokoro v1.0 via sherpa-onnx)
  sttEnabled: boolean;
  /** Paste-to-swap STT model: local .gguf path or models/ filename; empty = bundled default. */
  sttModel: string;
  /** Paste-to-swap TTS bundle dir (model.onnx + voices.bin + tokens.txt); empty = vendored default. */
  ttsModel: string;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsLangCode: string;
  ttsSpeed: number;
  ttsChunkSize: number;
  ttsSplitPattern: string;
  pythonPath: string;

  // LLM: llama.cpp server (LFM 2.5-350M) for ghost autocomplete
  llmEnabled: boolean;
  /** Paste-to-swap LLM model: local .gguf path or models/ filename; empty = bundled default. */
  llmModel: string;

  /** Show paragraph density heatmap in the status bar. */
  rhythmHeatmapInStatusBar: boolean;
}

const defaultSettings: AppSettings = {
  theme: "default",
  themeMode: "dark",
  accentOverride: "",
  iconSet: "phosphor",
  sidebarFooterCollapsed: false,
  streakGoal: 500,

  fontSize: 15,
  lineHeight: 1.7,
  fontFamily: "JetBrains Mono",
  // Reader prose controls (per-Reader, persisted). Size 16 reproduces the
  // pre-controls look exactly; reset returns to base fontSize. Theme "app"
  // follows the app theme; light/sepia/dark are fixed reading papers.
  readerFont: "serif",
  readerSize: 16,
  readerMeasure: "comfortable",
  readerTheme: "app",
  typewriterDefault: true,
  focusDimmingDefault: true,
  autocorrectEnabled: false,
  ghostEnabled: false,
  dictionaryLanguage: "en",
  formatToolbarOpen: false,

  smallModelEndpoint: "http://127.0.0.1:8093/v1",
  smallModelName: "lfm2.5-350m",
  smallModelContextLength: 8192,
  useSmallAsMain: false,
  mainModelEndpoint: "https://api.openai.com/v1",
  mainModelName: "gpt-4o-mini",
  aiRateLimitCooldown: 3000,
  apiKey: "",
  sidecarHarnessDir: "",
  blankModeDefault: false,
  logsLocalOnly: true,
  scrubSecrets: false,
  aiMemoryEnabled: true,

  appLockPin: "",
  lockEnabled: true,
  // Off until the user opts in: no craft metrics are recorded, so Craft
  // charts and the filter-word nudge stay empty rather than half-fed.
  craftProfilingEnabled: false,

  vaultPath: "~/WritingVault",
  backupFrequency: "daily",
  snapshotRetentionDays: 30,

  androidCaptureMethod: "notification",
  weeklyTriageReminder: true,
  streakReminder: true,
  logsStampPlace: false,
  lastTriageShown: null,
  lastStreakShown: null,
  lastAutoBackup: null,

  keybindings: {
    "Ctrl+T": "Insert timestamp",
    "Ctrl+K": "Command palette",
    "Ctrl+J": "Toggle AI panel",
    "Ctrl+Enter": "Insert at cursor (AI)",
    "Ctrl+Shift+C": "Copy AI response",
    "Ctrl+S": "Save document",
    "Ctrl+N": "New document",
    "Ctrl+W": "Close tab",
    "Ctrl+Tab": "Next tab",
    "Ctrl+Shift+Tab": "Previous tab",
    "M": "Open Node Map",
    "Esc": "Close panel / modal",
  },
  featuresUsed: [],
  dismissedNudges: [],
  aiPersona: "",
  templates: [],
  hasOnboarded: false,
  onboardedVersion: 0,
  onboardSkipped: false,
  topBarIds: [],
  hiddenIds: null,
  defaultWorkspace: "home",
  workspacePrivacy: { logs: true },
  savedViews: [],

  compactMode: false,
  autoHideChrome: true,
  companionWidgetVisible: false,
  widgetWorkspace: "write",
  widgetCollapsed: true,
  widgetDockEdge: "right",
  widgetDockOffset: 96,
  widgetLaunchAtStartup: false,
  widgetAutostartPromptShown: false,
  associatedFileExtensions: ["txt", "md"],

  autoCheckUpdates: true,

  sttEnabled: true,
  sttModel: "moonshine-base",
  ttsModel: "",
  ttsEnabled: true,
  ttsVoice: "af_heart",
  ttsLangCode: "a",
  ttsSpeed: 1.0,
  ttsChunkSize: 150,
  ttsSplitPattern: "\\n+",
  pythonPath: "python",
  llmEnabled: true,
  llmModel: "",
  rhythmHeatmapInStatusBar: false,
};

/** Defaults (exported for Reset-to-defaults; resetSettings deep-copies). */
export const DEFAULT_SETTINGS: AppSettings = defaultSettings;

type SecretKey = (typeof SECRET_KEYS)[number];

/**
 * Keys a settings file may overwrite. Everything else (secrets,
 * unknown/future keys) is dropped on import — a settings file must
 * never smuggle credentials or keys this version doesn't know.
 */
export const IMPORTABLE_SETTINGS_KEYS: ReadonlySet<string> = new Set(
  Object.keys(defaultSettings).filter(
    (k) => !(SECRET_KEYS as readonly string[]).includes(k)
  )
);

/** Current onboarding flow version. Bump when the steps change enough to re-prompt. */
export const ONBOARD_VERSION = 2;
/** Sidebar default hides (null hiddenIds): power-user surfaces reachable via palette. */
export const DEFAULT_HIDDEN_WORKSPACES: readonly string[] = ["inbox", "canvas"];
/** Resolves once keychain hydration + legacy migration finished. */
let resolveSecretsReady!: () => void;
export const secretsReady = new Promise<void>((resolve) => {
  resolveSecretsReady = resolve;
});

let secretsMigrated = false;
let preserveLegacySecrets = false;
let lastSynced: Record<SecretKey, string> = { apiKey: "", appLockPin: "" };
let secretSyncTimer: ReturnType<typeof setTimeout> | null = null;
/** Deferred to avoid a settings ↔ api.ts circular-import TDZ at module init. */
let apiPromise: Promise<typeof import("$lib/api")> | null = null;
function apiLazy() {
  return (apiPromise ??= import("$lib/api"));
}

function isWidgetRoute(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("widget") === "1";
}

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem("writing-app-settings");
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      // Sanitize: unknown/retired keys, wrong types, and smuggled secrets
      // are dropped; out-of-range numbers are clamped. A corrupt store
      // can never poison boot. Retired Ollama-era main-slot defaults
      // migrate forward (exact matches only); deliberate custom values stay.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const raw = parsed as Record<string, unknown>;
        // Style×mode migration (2026-09): legacy single `theme` values map
        // onto the split fields before validation drops them as unknown.
        if (raw.theme === "dark" || raw.theme === "light" || raw.theme === "brutalist" || raw.theme === "glass") {
          if (raw.themeMode !== "dark" && raw.themeMode !== "light") {
            raw.themeMode = raw.theme === "light" ? "light" : "dark";
          }
          raw.theme = raw.theme === "brutalist" ? "brutalist" : raw.theme === "glass" ? "glass" : "default";
        }
        const { valid } = validateSettings(raw);
        const { patch, migrated } = migrateRetiredProviders(valid, defaultSettings);
        if (migrated.length > 0) {
          console.warn(`Settings migrated off retired providers: ${migrated.join(", ")}`);
        }
        const legacyApiKey = typeof raw.apiKey === "string" ? raw.apiKey : "";
        const legacyPin = typeof raw.appLockPin === "string" ? raw.appLockPin : "";
        if (!isWidgetRoute() && (legacyApiKey || legacyPin)) preserveLegacySecrets = true;
        return {
          ...defaultSettings,
          ...patch,
          ...(isWidgetRoute() ? {} : { apiKey: legacyApiKey, appLockPin: legacyPin }),
        };
      }
    }
  } catch (e) {
    console.warn("Failed to load settings from localStorage:", e);
  }
  return { ...defaultSettings };
}

function saveSettings(s: AppSettings) {
  try {
    const payload = { ...s };
    if (!preserveLegacySecrets || secretsMigrated) {
      payload.apiKey = "";
      payload.appLockPin = "";
    }
    localStorage.setItem("writing-app-settings", JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to save settings to localStorage:", e);
  }
  if (secretsMigrated) scheduleSecretSync(s);
}

function scheduleSecretSync(s: AppSettings) {
  if (secretSyncTimer) clearTimeout(secretSyncTimer);
  secretSyncTimer = setTimeout(() => {
    void (async () => {
      const { api } = await apiLazy();
      for (const k of SECRET_KEYS) {
        const v = s[k];
        if (v === lastSynced[k]) continue;
        try {
          await api.secretSet(k, v);
          lastSynced[k] = v;
        } catch (e) {
          console.warn(`Failed to sync ${k} to OS keychain:`, e);
        }
      }
    })();
  }, 300);
}

/**
 * Pull secrets from the OS keychain, migrate any legacy localStorage
 * values into it, then strip them from localStorage for good.
 */
async function initSecrets(): Promise<void> {
  try {
    const { api } = await apiLazy();
    for (const k of SECRET_KEYS) {
      try {
        const v = await api.secretGet(k);
        // Emptiness is checked INSIDE the updater: s was snapshotted
        // before the await, and the user may have typed since.
        if (v != null && v !== "") {
          lastSynced[k] = v;
          settings.update((st) => (st[k] === "" ? { ...st, [k]: v } : st));
        }
      } catch (e) {
        console.warn(`keychain read failed for ${k}:`, e);
      }
    }
    let allOk = true;
    for (const k of SECRET_KEYS) {
      const v = get(settings)[k];
      if (v !== lastSynced[k]) {
        try {
          await api.secretSet(k, v);
          lastSynced[k] = v;
        } catch (e) {
          console.warn(`keychain write failed for ${k}:`, e);
          allOk = false;
        }
      }
    }
    if (allOk) {
      secretsMigrated = true;
      preserveLegacySecrets = false;
      try {
        localStorage.setItem("writing-app-settings", JSON.stringify({
          ...get(settings),
          apiKey: "",
          appLockPin: "",
        }));
      } catch (e) {
        console.warn("Failed to strip secrets from localStorage:", e);
      }
    }
  } catch (e) {
    console.warn("Secret hydration failed — secrets stay in localStorage until next launch:", e);
  } finally {
    resolveSecretsReady();
  }
}

export const settings = writable<AppSettings>(loadSettings());
let lastSettings = get(settings);

settings.subscribe((value) => {
  lastSettings = value;
  saveSettings(value);
});

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== "writing-app-settings" || !event.newValue) return;
    try {
      const parsed: unknown = JSON.parse(event.newValue);
      if (!parsed || typeof parsed !== "object") return;
      const { valid } = validateSettings(parsed as Record<string, unknown>);
      const changed: Record<string, unknown> = {};
      const previous = lastSettings as unknown as Record<string, unknown>;
      for (const [key, value] of Object.entries(valid)) {
        if (JSON.stringify(value) !== JSON.stringify(previous[key])) changed[key] = value;
      }
      if (Object.keys(changed).length > 0) settings.update((current) => ({ ...current, ...changed }));
    } catch (e) {
      console.warn("Failed to sync settings from another window:", e);
    }
  });
}

if (isWidgetRoute()) resolveSecretsReady();
else void initSecrets();

/** Global Settings nav: lets palette/sidebar deep-link into a category. */
export const settingsCategory = writable<SettingsCategory>("general");

/** Open Settings at a specific category (single call from anywhere). */
export function openSettingsAt(category: SettingsCategory) {
  settingsCategory.set(category);
}

/**
 * Check if a workspace is private (local-only AI, no API calls).
 * Logs workspace is private by default per spec §8E.
 */
export function isWorkspacePrivate(workspaceId: string): boolean {
  const s = loadSettings();
  return s.workspacePrivacy[workspaceId] === true;
}

/** Toggle privacy for a specific workspace. */
export function toggleWorkspacePrivacy(workspaceId: string) {
  settings.update((s) => {
    s.workspacePrivacy = { ...s.workspacePrivacy, [workspaceId]: !s.workspacePrivacy[workspaceId] };
    return s;
  });
}

/**
 * Reset every setting to defaults (deep copy — nested keybindings/
 * templates must not alias DEFAULT_SETTINGS). Secrets stay in the OS
 * keychain.
 */
export function resetSettings(): void {
  settings.set(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings);
}
