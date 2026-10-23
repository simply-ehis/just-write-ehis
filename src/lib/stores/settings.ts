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
  | "support"
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
  /** One-time migration marker (v1 = paper+gold palette, serif default). */
  settingsVersion: number;
  /** Visual style: default room, brutalist concrete, or glass frost. */
  theme: "default" | "brutalist" | "glass";
  /** Light or dark base under any style; "system" follows the OS. */
  themeMode: "dark" | "light" | "system";
  /** Lines above/below the cursor left undimmed when focus dimming is on. */
  focusContextLines: number;
  /** Opacity of dimmed regions (0.1 barely dim … 1 = no dimming). */
  focusDimStrength: number;
  /** Custom accent override (#rrggbb) — empty means the style's accent. */
  accentOverride: string;
  /** Sidebar footer (Auto-sort / New Doc / AI Panel / streak) collapsed. */
  sidebarFooterCollapsed: boolean;
  /** Tighter chrome (tabs, breadcrumb, nav) without changing layout. */
  compactMode: boolean;
  autoHideChrome: boolean;
  companionWidgetVisible: boolean;
  /** @deprecated Retired with the old "window that hosts any tab" widget; kept so older settings files still validate. */
  widgetWorkspace: string;
  /** @deprecated Retired (the widget no longer collapses to a bubble). */
  widgetCollapsed: boolean;
  /** @deprecated Retired (no edge docking). */
  widgetDockEdge: "left" | "right" | "top" | "bottom";
  /** @deprecated Retired (no edge docking). */
  widgetDockOffset: number;
  /** Which mini widget the companion window shows (see lib/widgets/registry.ts). */
  widgetKind: "quicknote" | "reader";
  /** Last window geometry as "x,y,w,h" in logical px; "" = first-run corner. */
  widgetGeometry: string;
  /** The Reader widget's own place (it never writes the main Reader's position). */
  widgetReaderDocId: string;
  widgetReaderSection: string;
  widgetReaderSize: number;
  widgetLaunchAtStartup: boolean;
  widgetAutostartPromptShown: boolean;

  fontSize: number;
  /** Whole-interface zoom, 0.8-1.6 (native webview zoom; desktop only). */
  uiScale: number;
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
  /** llama-server context preset (takes effect on next local model start). */
  smallModelContextLength: number;
  /** Route the AI panel's main slot (chat/composer/structurize) at the small model. */
  useSmallAsMain: boolean;
  mainModelEndpoint: string;
  mainModelName: string;
  /** Minimum milliseconds between AI sends (0 = no limit). */
  aiRateLimitCooldown: number;
  apiKey: string;
  blankModeDefault: boolean;
  logsLocalOnly: boolean;
  /** Scrub secrets from outgoing AI prompts via the memory sidecar. */
  scrubSecrets: boolean;
  /** Learn cross-session facts + inject recall into chat context. */
  aiMemoryEnabled: boolean;

  craftProfilingEnabled: boolean;

  vaultPath: string;
  backupFrequency: "daily" | "weekly" | "monthly" | "never";
  snapshotRetentionDays: number;

  androidCaptureMethod: "notification" | "widget" | "share-target";
  desktopNotificationsEnabled: boolean;
  weeklyTriageReminder: boolean;
  streakReminder: boolean;
  logsStampPlace: boolean;
  lastTriageShown: string | null;
  lastStreakShown: string | null;
  lastAutoBackup: string | null;

  keybindings: Record<string, string>;
  featuresUsed: string[];
  dismissedNudges: string[];
  skillNudgesEnabled: boolean;
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
  // behavior); null hiddenIds = default hides (canvas).
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

  // Audio: STT (Moonshine-base GGUF via transcribe.cpp) + TTS (Phonon q8 via Rust sidecar)
  sttEnabled: boolean;
  ttsEnabled: boolean;
  ttsVoice: string;
  ttsLangCode: string;
  ttsSpeed: number;

  // Local llama.cpp model used by ghost autocomplete
  llmEnabled: boolean;
  /** How long to keep STT/TTS/LLM loaded after last use.
   *  idle-5min = offload 5 min after last use (default);
   *  session  = offload 30 min after last use (long writing session);
   *  always   = never idle-offload (until user toggles the feature off). */
  modelRetention: "idle-5min" | "session" | "always";

  /** Show paragraph density heatmap in the status bar. */
  rhythmHeatmapInStatusBar: boolean;
}

const defaultSettings: AppSettings = {
  settingsVersion: 1,
  theme: "default",
  themeMode: "light",
  accentOverride: "",
  sidebarFooterCollapsed: false,

  fontSize: 15,
  uiScale: 1,
  lineHeight: 1.7,
  fontFamily: "Georgia",
  // Reader prose controls (per-Reader, persisted). Size 16 reproduces the
  // pre-controls look exactly; reset returns to base fontSize. Theme "app"
  // follows the app theme; light/sepia/dark are fixed reading papers.
  readerFont: "serif",
  readerSize: 16,
  readerMeasure: "comfortable",
  readerTheme: "app",
  typewriterDefault: true,
  focusDimmingDefault: true,
  /** Lines above/below the cursor left undimmed when focus dimming is on. */
  focusContextLines: 2,
  /** Opacity of dimmed regions (0.1 barely dim … 1 = no dimming). */
  focusDimStrength: 0.35,
  autocorrectEnabled: false,
  ghostEnabled: false,
  dictionaryLanguage: "en",
  formatToolbarOpen: false,

  smallModelEndpoint: "http://127.0.0.1:8093/v1",
  smallModelName: "",
  smallModelContextLength: 16384,
  useSmallAsMain: false,
  mainModelEndpoint: "https://api.openai.com/v1",
  mainModelName: "gpt-4o-mini",
  aiRateLimitCooldown: 3000,
  apiKey: "",
  blankModeDefault: false,
  logsLocalOnly: true,
  scrubSecrets: false,
  aiMemoryEnabled: true,

  // Off until the user opts in: no craft metrics are recorded, so Craft
  // charts and the filter-word nudge stay empty rather than half-fed.
  craftProfilingEnabled: false,

  vaultPath: "~/WritingVault",
  backupFrequency: "daily",
  snapshotRetentionDays: 30,

  androidCaptureMethod: "notification",
  desktopNotificationsEnabled: false,
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
  skillNudgesEnabled: true,
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
  widgetKind: "quicknote",
  widgetGeometry: "",
  widgetReaderDocId: "",
  widgetReaderSection: "",
  widgetReaderSize: 15,
  widgetLaunchAtStartup: false,
  widgetAutostartPromptShown: false,

  autoCheckUpdates: true,

  sttEnabled: true,
  ttsEnabled: true,
  ttsVoice: "default",
  ttsLangCode: "en",
  ttsSpeed: 1.0,
  llmEnabled: true,
  modelRetention: "idle-5min",
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
export const DEFAULT_HIDDEN_WORKSPACES: readonly string[] = ["canvas"];

/** Resolves once keychain hydration + legacy migration finished. */
let resolveSecretsReady!: () => void;
export const secretsReady = new Promise<void>((resolve) => {
  resolveSecretsReady = resolve;
});

let secretsMigrated = false;
let preserveLegacySecrets = false;
let lastSynced: Record<SecretKey, string> = { apiKey: "" };
let secretSyncTimer: ReturnType<typeof setTimeout> | null = null;
/** Deferred to avoid a settings ↔ api.ts circular-import TDZ at module init. */
let apiPromise: Promise<typeof import("$lib/api")> | null = null;
function apiLazy() {
  return (apiPromise ??= import("$lib/api"));
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = 5000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function isWidgetRoute(): boolean {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("widget") === "1";
}

function routeSecretKeys(): readonly SecretKey[] {
  // The widget window never touches the OS keychain (no secrets of its own).
  return isWidgetRoute() ? [] : SECRET_KEYS;
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
        if (typeof raw.vaultPath !== "string" || !raw.vaultPath) {
          raw.vaultPath = defaultSettings.vaultPath;
        }
        // Style×mode migration (2026-09): legacy single `theme` values map
        // onto the split fields before validation drops them as unknown.
        if (raw.theme === "dark" || raw.theme === "light" || raw.theme === "brutalist" || raw.theme === "glass") {
          if (raw.themeMode !== "dark" && raw.themeMode !== "light" && raw.themeMode !== "system") {
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
        if (!isWidgetRoute() && legacyApiKey) preserveLegacySecrets = true;
        return {
          ...defaultSettings,
          ...patch,
          ...(isWidgetRoute() ? {} : { apiKey: legacyApiKey }),
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
    if (isWidgetRoute()) {
      try {
        const existing = JSON.parse(localStorage.getItem("writing-app-settings") || "{}") as Record<string, unknown>;
        payload.apiKey = typeof existing.apiKey === "string" ? existing.apiKey : "";
      } catch {
        payload.apiKey = "";
      }
    } else if (!preserveLegacySecrets || secretsMigrated) {
      payload.apiKey = "";
    }
    localStorage.setItem("writing-app-settings", JSON.stringify(payload));
  } catch (e) {
    console.warn("Failed to save settings to localStorage; keeping the previous persisted copy:", e);
  }
  if (secretsMigrated) scheduleSecretSync(s);
}

function scheduleSecretSync(s: AppSettings) {
  if (secretSyncTimer) clearTimeout(secretSyncTimer);
  secretSyncTimer = setTimeout(() => {
    void (async () => {
      const { api } = await apiLazy();
      for (const k of routeSecretKeys()) {
        const v = s[k];
        if (v === lastSynced[k]) continue;
        try {
          await withTimeout(api.secretSet(k, v), `keychain sync for ${k}`);
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
function stripPersistedSecrets(): boolean {
  try {
    localStorage.setItem("writing-app-settings", JSON.stringify({
      ...get(settings),
      apiKey: "",
    }));
    return true;
  } catch (e) {
    console.warn("Failed to strip secrets from localStorage; keeping the previous persisted copy:", e);
    return false;
  }
}

async function initSecrets(): Promise<void> {
  let migrationFailed = false;
  try {
    if (isWidgetRoute()) {
      // The companion widget holds no secrets of its own; skip the
      // keychain entirely so a slow/keychain-less backend never blocks it.
      secretsMigrated = true;
      preserveLegacySecrets = false;
      return;
    }

    const { api } = await withTimeout(apiLazy(), "secret backend");

    const readSecret = async (key: SecretKey): Promise<void> => {
      const before = get(settings)[key];
      try {
        const value = await withTimeout(api.secretGet(key), `keychain read for ${key}`);
        if (value != null && value !== "") {
          lastSynced[key] = value;
          settings.update((state) => (state[key] === before ? { ...state, [key]: value } : state));
        }
      } catch (error) {
        console.warn(`keychain read failed for ${key}:`, error);
      }
    };

    const writeSecret = async (key: SecretKey): Promise<void> => {
      const value = get(settings)[key];
      if (value === lastSynced[key]) return;
      try {
        await withTimeout(api.secretSet(key, value), `keychain write for ${key}`);
        lastSynced[key] = value;
      } catch (error) {
        migrationFailed = true;
        console.warn(`keychain write failed for ${key}:`, error);
      }
    };

    // Reads are independent: run together so one slow keychain doesn't
    // serialize. Writes stay after reads (a write must see the migrated
    // value first) but are independent of each other.
    await Promise.all(SECRET_KEYS.map((key) => readSecret(key)));
    await Promise.all(SECRET_KEYS.map((key) => writeSecret(key)));
    stripPersistedSecrets();
    preserveLegacySecrets = false;
    secretsMigrated = true;
    if (migrationFailed) scheduleSecretSync(get(settings));
  } catch (error) {
    // Hydration failed (backend unreachable). Scrub legacy plaintext so a
    // later successful boot doesn't resurrect it, then continue unblocked —
    // with no lock feature, a missing keychain can no longer lock anyone out.
    preserveLegacySecrets = false;
    secretsMigrated = true;
    const stripped = stripPersistedSecrets();
    console.warn("Secret hydration failed; localStorage was scrubbed:", stripped, error);
  } finally {
    resolveSecretsReady();
  }
}

export const settings = writable<AppSettings>(loadSettings());
let lastSettings = get(settings);
let settingsSaveTimer: ReturnType<typeof setTimeout> | null = null;

settings.subscribe((value) => {
  lastSettings = value;
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    saveSettings(value);
    settingsSaveTimer = null;
  }, 300);
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

void initSecrets();

/** Global Settings nav: lets palette/sidebar deep-link into a category. */
export const settingsCategory = writable<SettingsCategory>("general");

/** Open Settings at a specific category (single call from anywhere). */
export function openSettingsAt(category: SettingsCategory) {
  settingsCategory.set(category);
}

/**
 * Check if a workspace is private (local-only AI, no API calls).
 * Logs workspace is private by default per spec §8E, and the
 * Settings → "Logs: Local Model Only" switch forces it regardless of
 * the per-workspace map (that switch was previously stored but never read).
 */
export function isWorkspacePrivate(workspaceId: string): boolean {
  const s = get(settings);
  if (workspaceId === "logs" && s.logsLocalOnly) return true;
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
  const current = get(settings);
  settings.set({
    ...(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)) as AppSettings),
    apiKey: current.apiKey,
  });
}
