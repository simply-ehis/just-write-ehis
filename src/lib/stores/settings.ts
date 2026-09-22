import { writable, get } from "svelte/store";

export type SettingsCategory =
  | "general"
  | "editor"
  | "ai"
  | "privacy"
  | "vaults"
  | "sync"
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
  theme: "dark" | "light" | "brutalist" | "glass";
  iconSet: "phosphor" | "tabler";
  streakGoal: number;
  /** Tighter chrome (tabs, breadcrumb, nav) without changing layout. */
  compactMode: boolean;
  /** Hide tab bar + breadcrumb while actively typing, restore on idle. */
  autoHideChrome: boolean;

  fontSize: number;
  lineHeight: number;
  fontFamily: string;
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
  craftProfilingEnabled: boolean;

  vaultPath: string;
  backupFrequency: "daily" | "weekly" | "monthly" | "never";
  snapshotRetentionDays: number;

  fileWatcherEnabled: boolean;
  conflictBehavior: "keep-remote" | "keep-local" | "ask";

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
  theme: "dark",
  iconSet: "phosphor",
  streakGoal: 500,

  fontSize: 15,
  lineHeight: 1.7,
  fontFamily: "JetBrains Mono",
  typewriterDefault: true,
  focusDimmingDefault: true,
  autocorrectEnabled: false,
  ghostEnabled: false,
  dictionaryLanguage: "en",
  formatToolbarOpen: false,

  smallModelEndpoint: "http://127.0.0.1:8093/v1",
  smallModelName: "lfm2.5-350m",
  mainModelEndpoint: "http://localhost:11434/v1",
  mainModelName: "llama3.2",
  aiRateLimitCooldown: 3000,
  apiKey: "",
  sidecarHarnessDir: "",
  blankModeDefault: false,
  logsLocalOnly: true,
  scrubSecrets: false,
  aiMemoryEnabled: true,

  appLockPin: "",
  craftProfilingEnabled: true,

  vaultPath: "~/WritingVault",
  backupFrequency: "daily",
  snapshotRetentionDays: 30,

  fileWatcherEnabled: true,
  conflictBehavior: "ask",

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
  workspacePrivacy: { logs: true },
  savedViews: [],

  compactMode: false,
  autoHideChrome: true,

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

const SECRET_KEYS = ["apiKey", "appLockPin"] as const;
type SecretKey = (typeof SECRET_KEYS)[number];

/** Resolves once keychain hydration + legacy migration finished. */
let resolveSecretsReady!: () => void;
export const secretsReady = new Promise<void>((resolve) => {
  resolveSecretsReady = resolve;
});

let secretsMigrated = false;
let lastSynced: Record<SecretKey, string> = { apiKey: "", appLockPin: "" };
let secretSyncTimer: ReturnType<typeof setTimeout> | null = null;
/** Deferred to avoid a settings ↔ api.ts circular-import TDZ at module init. */
let apiPromise: Promise<typeof import("$lib/api")> | null = null;
function apiLazy() {
  return (apiPromise ??= import("$lib/api"));
}

function loadSettings(): AppSettings {
  try {
    const stored = localStorage.getItem("writing-app-settings");
    if (stored) {
      return { ...defaultSettings, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.warn("Failed to load settings from localStorage:", e);
  }
  return { ...defaultSettings };
}

function saveSettings(s: AppSettings) {
  try {
    const payload = { ...s };
    if (secretsMigrated) {
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
    const s = get(settings);
    for (const k of SECRET_KEYS) {
      try {
        const v = await api.secretGet(k);
        if (v != null && v !== "" && s[k] === "") {
          lastSynced[k] = v;
          settings.update((st) => ({ ...st, [k]: v }));
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

settings.subscribe((value) => {
  saveSettings(value);
});

void initSecrets();

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
