<script lang="ts">
  import { onMount } from "svelte";
  import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
  import { settings, settingsCategory, DEFAULT_HIDDEN_WORKSPACES, SECRET_KEYS, resetSettings, type SettingsCategory } from "$lib/stores/settings";
  import { validateSettings, clampNumber } from "$lib/settingsValidate";
  import { workspaces } from "$lib/stores/app";
  import { api, isBrowserPreview, getSlowCalls, SLOW_CALL_MS, type ConvertStatus } from "$lib/api";
  import { formatSlowCalls } from "$lib/support";
  import { readSessionHealth } from "$lib/sessionHealth";
  import { showToast } from "$lib/stores/notifications";
  import { checkForUpdate, downloadAndInstall, friendlyUpdateError, getAppVersion, relaunchApp, type UpdateInfo } from "$lib/updates";
  import { APP_VERSION } from "$lib/version";
  import { type ProviderTestResult } from "$lib/providerTest";
  import BackupManager from "./BackupManager.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import LazyWorkspace from "./LazyWorkspace.svelte";
  import {
    ensureLlm,
    ensureLlmFor,
    ensureStt,
    ensureTts,
    isLocalLlmSentinel,
    llmError,
    llmStarting,
    playWavBase64,
    sttError,
    stopLlm,
    stopStt,
    stopTts,
    synthesizeText,
    ttsError,
  } from "$lib/stores/audio";
  import { stopHarness } from "$lib/memorySidecar";
  import { pinCaptureNotification } from "$lib/launch";
import { requestOsNotificationPermission } from "$lib/osNotifications";
  import { isWindowsRuntime, setWidgetAutostart } from "$lib/widgetAutostart";
  import { clampUiScale, UI_SCALE_MAX, UI_SCALE_MIN, UI_SCALE_STEP } from "$lib/uiScale";
  import { WIDGET_KINDS, widgetSpec } from "$lib/widgets/registry";
  import { domainError, warnOnce } from "$lib/errors";
  import { defaultAccentFor, ACCENT_PRESETS, resolveThemeMode } from "$lib/appearance";
  import { EDITOR_FONTS } from "$lib/editorTheme";

  const AI_PERSONA_PRESETS = [
    { label: "Default", value: "" },
    { label: "Direct editor", value: "Be a concise, candid writing editor. Focus on clarity, structure, and voice. Give specific suggestions and preserve the writer's intent." },
    { label: "Encouraging coach", value: "Be a warm, practical writing coach. Help the writer make steady progress with one manageable next step. Preserve their voice." },
    { label: "Idea partner", value: "Be a curious brainstorming partner. Ask focused questions, explore alternatives, and help develop ideas without taking over the writing." },
  ];
  const CONTEXT_PRESETS = [2048, 4096, 8192, 16384, 32768, 65536];
  const SNAPSHOT_RETENTION_PRESETS = [7, 30, 90, 180, 365];

  /** Phonon voice catalog — id → label, from gradium/phonon-voices. */
    // English voices (phonon-31m-en) — all 37 English voices from gradium/phonon-voices
  const PHONON_VOICES: { id: string; label: string }[] = [
    { id: "NbpkqMVS3CJeq2j8", label: "Zoey - female, EN-US" },
    { id: "NIWIOv5vTi5eRMj8", label: "Juniper - female, EN-US" },
    { id: "vjFyp2BcCyTlUmYb", label: "Everly - female, EN-US" },
    { id: "4SZHfMpw-p46Ywgs", label: "Harper - female, EN-US" },
    { id: "bXwrkHhURL1VFJdG", label: "Hadley - female, EN-US" },
    { id: "nGzMHMPAWGaJFHOo", label: "Delia - female, EN-US" },
    { id: "LMDIYE0Oa377Qh6Z", label: "Easton - male, EN-US" },
    { id: "40QrMVgAxFiUnP9f", label: "Micah - male, EN-US" },
    { id: "0zLApsZfVLLNaEGl", label: "Trevor - male, EN-US" },
    { id: "_6Aslh2DxfmnRLmP", label: "Russell - male, EN-US" },
    { id: "qIxlZ7Ei8KvWlyQH", label: "Preston - male, EN-US" },
    { id: "d9XCyhjo4JhkHF1d", label: "Miles - male, EN-US" },
    { id: "6PWnV0Nq4wu7RVBT", label: "Maeve - female, EN-GB" },
    { id: "GgfEkEJtxZR7gnpy", label: "Freya - female, EN-GB" },
    { id: "uem82D50GRv2Dwma", label: "Pippa - female, EN-GB" },
    { id: "y9bQqIDnyxwqK01t", label: "Elodie-Rose - female, EN-GB" },
    { id: "gDT1nz7Ie36ZhL-C", label: "Imogen - female, EN-GB" },
    { id: "m9MxpY6IUGXtWp76", label: "Lottie - female, EN-GB" },
    { id: "gfP44RlHwr2kEwk7", label: "Bryony - female, EN-GB" },
    { id: "X6NceqF285Gr04gb", label: "Alfie - male, EN-GB" },
    { id: "YyKcxPG7iIgS3jsK", label: "Hugh - male, EN-GB" },
    { id: "zUCxzrOrugTSis03", label: "Edwin - male, EN-GB" },
    { id: "JOW0vchyswkQUMDS", label: "Spencer - male, EN-GB" },
    { id: "dME3IWyZBvmh1n1q", label: "Toby - male, EN-GB" },
    { id: "Zn7g6NxLqXlJb7Qi", label: "Teddy - male, EN-GB" },
    { id: "xPDpsV3F592srkjA", label: "Captain Silas Blackwater - CHARACTERS" },
    { id: "nOykTmcH9ydsGGIc", label: "Morwenna of the Deep - CHARACTERS" },
    { id: "lX3LavMNdlIbgEHH", label: "Old Mortlake - CHARACTERS" },
    { id: "dGyGDKo2osj7h3s7", label: "Azgorath - CHARACTERS" },
    { id: "cXoIXJ2llS8S0WOW", label: "Fennick the Young Elf - CHARACTERS" },
    { id: "GXaSqMEmOg12OIYb", label: "The Thing Under the Stairs - CHARACTERS" },
    { id: "xO8xQo3BrB8FuI6J", label: "Vyrmathrax the Ancient - CHARACTERS" },
    { id: "cYtsRSxV5q9IMehn", label: "Grub the Ogre - CHARACTERS" },
    { id: "gSgG5Tor0GPEnqzC", label: "Master Aldric - CHARACTERS" },
    { id: "NIWoEurJHMJjyUTe", label: "The Snow Queen - CHARACTERS" },
    { id: "y2eiKxtQo2B67deU", label: "Sir Bramwell - CHARACTERS" },
    { id: "QXNr0SvkukLB4wPq", label: "Fairy Godmother - CHARACTERS" },
  ];

  function modelQuantTag(name: string): string {
    const match = name.match(/IQ\d+_[A-Z0-9]+|Q\d+(?:_K_[MSL]|_[01])/i);
    return match?.[0].toUpperCase() ?? "quant unknown";
  }

  function nearestPreset(value: number, choices: number[]): number {
    return choices.reduce((best, choice) => Math.abs(choice - value) < Math.abs(best - value) ? choice : best);
  }

  // Resolved base mode for logos/color math — "system" tracks the OS live.
  let baseMode = $derived(resolveThemeMode($settings.themeMode));

  // Export setup probe (Settings → About): surfaces Typst presence so
  // menus, errors, and docs agree (see docs/EXPORT.md). md/txt/html/docx/
  // epub are pure Rust and always available; only pdf needs the binary.
  let exportStatus = $state<ConvertStatus | null>(null);
  let exportProbing = $state(false);
  let resolvedVaultPath = $state("");

  async function probeExportSetup() {
    if (exportProbing) return;
    exportProbing = true;
    try {
      exportStatus = await api.convertStatus();
    } catch (e) {
      showToast(`Export probe failed: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      exportProbing = false;
    }
  }

  let localModelTesting = $state<"stt" | "tts" | "llm" | null>(null);
  let localModelStatus = $state("");
  let localModels = $state<{ name: string; path: string }[]>([]);
  let localModelsLoading = $state(false);

  async function refreshLocalModels() {
    if (isBrowserPreview() || localModelsLoading) return;
    localModelsLoading = true;
    try {
      await api.smallModelsDir();
      localModels = (await api.scanSmallModels()).sort((a, b) => a.name.localeCompare(b.name));
      if (isLocalLlmSentinel($settings.smallModelEndpoint) && $settings.smallModelName && !localModels.some((model) => model.name === $settings.smallModelName)) {
        settings.update((current) => ({ ...current, smallModelName: "" }));
      }
    } catch (error) {
      localModelStatus = `Couldn't read the models folder: ${error instanceof Error ? error.message : error}`;
    } finally {
      localModelsLoading = false;
    }
  }

  function smallProviderPreset(): "local" | "openai" | "custom" {
    if (!isBrowserPreview() && isLocalLlmSentinel($settings.smallModelEndpoint)) return "local";
    return $settings.smallModelEndpoint.trim().replace(/\/+$/, "") === "https://api.openai.com/v1" ? "openai" : "custom";
  }

  function chooseSmallProvider(value: string) {
    if (value === "local") {
      $settings = { ...$settings, smallModelEndpoint: "http://127.0.0.1:8093/v1", smallModelName: "" };
    } else if (value === "openai") {
      $settings = { ...$settings, smallModelEndpoint: "https://api.openai.com/v1", smallModelName: "gpt-4o-mini" };
    } else {
      $settings = {
        ...$settings,
        smallModelEndpoint: smallProviderPreset() === "custom" ? $settings.smallModelEndpoint : "",
        smallModelName: smallProviderPreset() === "custom" ? $settings.smallModelName : "",
      };
    }
  }

  function mainProviderPreset(): "openai" | "custom" {
    return $settings.mainModelEndpoint.trim().replace(/\/+$/, "") === "https://api.openai.com/v1" ? "openai" : "custom";
  }

  function chooseMainProvider(value: string) {
    if (value === "openai") {
      $settings = { ...$settings, mainModelEndpoint: "https://api.openai.com/v1", mainModelName: "gpt-4o-mini" };
    } else {
      const isCustom = mainProviderPreset() === "custom";
      $settings = {
        ...$settings,
        mainModelEndpoint: isCustom ? $settings.mainModelEndpoint : "",
        mainModelName: isCustom ? $settings.mainModelName : "",
      };
    }
  }

  async function testSttSetup() {
    if (localModelTesting) return;
    localModelTesting = "stt";
    localModelStatus = "";
    const wasRunning = await api.sttIsRunning().catch(() => false);
    try {
      localModelStatus = await ensureStt() ? "STT model loaded" : $sttError || "STT unavailable";
    } catch (error) {
      localModelStatus = error instanceof Error ? error.message : String(error);
    } finally {
      if (!wasRunning) await stopStt().catch((error) => {
        localModelStatus = localModelStatus || `STT cleanup failed: ${error instanceof Error ? error.message : error}`;
      });
      localModelTesting = null;
    }
  }

  async function testTtsSetup() {
    if (localModelTesting) return;
    localModelTesting = "tts";
    localModelStatus = "";
    const wasRunning = await api.ttsIsRunning().catch(() => false);
    try {
      if (!(await ensureTts())) {
        localModelStatus = $ttsError || "TTS unavailable";
        return;
      }
      const result = await synthesizeText("Your local voice is ready.");
      if (!result) {
        localModelStatus = $ttsError || "TTS generated no audio";
        return;
      }
      // Actually PLAY the waveform — a test that stays silent proves nothing.
      try {
        await playWavBase64(result.audio);
        localModelStatus = "You should have heard a test voice.";
      } catch (e) {
        localModelStatus = `TTS audio failed to play: ${e instanceof Error ? e.message : e}`;
      }
      // Success: leave Phonon warm — stopping it here unloaded the model
      // the user had just paid the cold-start cost for (and any hover-warm).
      return;
    } catch (error) {
      localModelStatus = error instanceof Error ? error.message : String(error);
    } finally {
      // Only clean up a FAILED start that this test itself spawned; a
      // successful test keeps the sidecar warm for real use.
      if (!wasRunning && localModelStatus !== "You should have heard a test voice.") {
        await stopTts().catch((error) => {
          localModelStatus = localModelStatus || `TTS cleanup failed: ${error instanceof Error ? error.message : error}`;
        });
      }
      localModelTesting = null;
    }
  }

  async function testLlmSetup() {
    if (localModelTesting) return;
    localModelTesting = "llm";
    localModelStatus = "";
    const wasRunning = await api.llmIsRunning().catch(() => false);
    try {
      if (!(await ensureLlm())) {
        localModelStatus = $llmError || "Local model unavailable";
        return;
      }
      const text = (await api.llmCompletion("Reply with exactly READY", 8, 0)).trim();
      localModelStatus = text.toUpperCase() === "READY"
        ? "Local model replied READY"
        : text
          ? `Local model returned unexpected text: ${text.slice(0, 80)}`
          : "Local model returned no text";
    } catch (error) {
      localModelStatus = error instanceof Error ? error.message : String(error);
    } finally {
      if (!wasRunning) await stopLlm().catch((error) => {
        localModelStatus = localModelStatus || `LLM cleanup failed: ${error instanceof Error ? error.message : error}`;
      });
      localModelTesting = null;
    }
  }

  /** Toggling a voice/memory feature off also stops its sidecar. */
  async function onSttToggle() {
    if (!$settings.sttEnabled) {
      try {
        await stopStt();
      } catch (e) {
        showToast(`STT sidecar didn't stop: ${e instanceof Error ? e.message : e}`, "warning");
      }
    }
  }

  async function onTtsToggle() {
    if (!$settings.ttsEnabled) {
      try {
        await stopTts();
      } catch (e) {
        showToast(`TTS sidecar didn't stop: ${e instanceof Error ? e.message : e}`, "warning");
      }
    }
  }

  async function onMemoryToggle() {
    if (!$settings.aiMemoryEnabled) {
      try {
        await stopHarness();
      } catch (e) {
        showToast(`Memory sidecar didn't stop: ${e instanceof Error ? e.message : e}`, "warning");
      }
    }
  }

  async function onLlmToggle() {
    if (!$settings.llmEnabled) {
      try {
        await stopLlm();
      } catch (e) {
        showToast(`LLM sidecar didn't stop: ${e instanceof Error ? e.message : e}`, "warning");
      }
    }
  }

  let activeCategory = $derived($settingsCategory);
  let aboutLogo = $derived(baseMode === "dark" ? "ehis-logo-light.svg" : "ehis-logo-dark.svg");

  /** Workspace tabs on/off (sidebar + top bar). Null = defaults. */
  function workspaceHidden(id: string): boolean {
    return ($settings.hiddenIds ?? DEFAULT_HIDDEN_WORKSPACES).includes(id);
  }
  function toggleWorkspaceVisible(id: string) {
    const cur = $settings.hiddenIds ?? [...DEFAULT_HIDDEN_WORKSPACES];
    $settings = {
      ...$settings,
      hiddenIds: cur.includes(id) ? cur.filter((h) => h !== id) : [...cur, id],
    };
  }
  let benchResults = $state<Record<string, number> | null>(null);
  let benchRunning = $state(false);
  let coldStartTime = $state(0);
  let selfTest = $state<{ name: string; pass: boolean; detail: string }[]>([]);
  let selfTestRunning = $state(false);
  let appVersion = $state(APP_VERSION);
  let updateConfigured = $state<boolean | null>(null);
  let updateEndpoint = $state<string | null>(null);
  let updateInfo = $state<UpdateInfo | null>(null);
  let updateChecked = $state(false);
  let updateChecking = $state(false);
  let updateError = $state("");
  let updateDownloading = $state(false);
  let updateProgress = $state(0);
  let updateProgressLabel = $state("");
  let testingSlot = $state<"small" | "main" | null>(null);
  let pinningNotif = $state(false);
  let notifStatus = $state("");
  let osNotifStatus = $state("");

  async function configureOsNotifications(enabled: boolean) {
    if (!enabled) {
      settings.update((current) => ({ ...current, desktopNotificationsEnabled: false }));
      osNotifStatus = "OS error notifications are off.";
      return;
    }

    const result = await requestOsNotificationPermission();
    if (result === "enabled") {
      settings.update((current) => ({ ...current, desktopNotificationsEnabled: true }));
      osNotifStatus = "Notifications will appear while the app is hidden.";
    } else if (result === "unsupported") {
      osNotifStatus = "This runtime does not provide OS notifications.";
    } else if (result === "denied") {
      osNotifStatus = "Notifications are blocked in system settings.";
    } else {
      osNotifStatus = "Could not request notification permission.";
    }
  }

  async function pinNotification() {
    pinningNotif = true;
    try {
      notifStatus = await pinCaptureNotification();
    } finally {
      pinningNotif = false;
    }
  }
  let slotResults = $state<{ small?: ProviderTestResult; main?: ProviderTestResult }>({});
  let memoryFactCount = $state<number | null>(null);

  const failedProbe = (error: string): ProviderTestResult => ({
    ok: false,
    latencyMs: 0,
    models: [],
    modelFound: false,
    error,
  });

  async function testSlot(slot: "small" | "main") {
    testingSlot = slot;
    try {
      const endpoint = slot === "small" ? $settings.smallModelEndpoint : $settings.mainModelEndpoint;
      const model = slot === "small" ? $settings.smallModelName : $settings.mainModelName;
      // The small slot's default address IS the bundled LLM's private socket,
      // so bring that sidecar up before probing it — otherwise the probe
      // reports a server nobody started. No-op for remote endpoints/preview.
      if (!(await ensureLlmFor(endpoint))) {
        slotResults = { ...slotResults, [slot]: failedProbe($llmError || "Bundled LLM unavailable — start it in Settings → AI & Providers.") };
        return;
      }
      // Desktop probes via Rust (key attached, no CSP block); preview fetches directly.
      slotResults = { ...slotResults, [slot]: await api.providerProbe(endpoint, model, $settings.apiKey || undefined) };
    } catch (error) {
      // A thrown probe must land in the result row, not vanish as an
      // unhandled rejection — `slotResultText` has no result to render yet.
      slotResults = { ...slotResults, [slot]: failedProbe(error instanceof Error ? error.message : String(error)) };
    } finally {
      testingSlot = null;
    }
  }

  function slotResultText(slot: string, r: ProviderTestResult): string {
    if (!r.ok) return `${slot} slot unreachable: ${r.error}`;
    const model = r.modelFound ? "model found" : "reachable, but model name not listed";
    return `${slot} slot OK — ${r.latencyMs}ms, ${model}.`;
  }

  /**
   * Clamp a numeric setting on blur through the shared schema (same rules
   * as import/load). Non-numeric or in-range values pass through untouched.
   */
  function clampSettingKey(key: string) {
    const v = ($settings as unknown as Record<string, unknown>)[key];
    const fixed = clampNumber(key, v);
    if (fixed !== null && fixed !== v) {
      settings.set({ ...$settings, [key]: fixed });
      showToast(`${key} clamped to ${fixed}`, "info");
    }
  }

  function exportSettingsFile() {
    const exportable: Record<string, unknown> = { ...$settings };
    for (const k of SECRET_KEYS) delete exportable[k];
    const data = JSON.stringify(exportable, null, 2);
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "just-write-ehis-settings.json";
    a.click();
    URL.revokeObjectURL(url);
    showToast("Settings exported (secrets never included)", "success");
  }

  /** Import a settings file through validateSettings — loud about rejects. */
  function importSettingsFile() {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const imported: unknown = JSON.parse(text);
        if (typeof imported !== "object" || imported === null || Array.isArray(imported)) {
          throw new Error("not a settings object");
        }
        const report = validateSettings(imported as Record<string, unknown>);
        if (Object.keys(report.valid).length > 0) {
          const next = { ...$settings, ...report.valid };
          settings.set(next);
        }
        // Loud report: secrets rejected, unknown/bad keys dropped, clamps.
        if (report.secrets.length > 0) {
          showToast(`Import blocked secrets: ${report.secrets.join(", ")} — kept current values`, "error");
        }
        if (report.rejected.length > 0) {
          showToast(`Import dropped ${report.rejected.length} unknown/invalid keys: ${report.rejected.slice(0, 5).join(", ")}${report.rejected.length > 5 ? "…" : ""}`, "warning");
        }
        if (report.clamped.length > 0) {
          showToast(`Import clamped out-of-range: ${report.clamped.join(", ")}`, "info");
        }
        const applied = Object.keys(report.valid).length;
        showToast(applied > 0 ? `Settings imported (${applied} applied)` : "Settings import: nothing valid to apply", applied > 0 ? "success" : "warning");
      } catch (err) {
        showToast("Failed to import settings", "error");
      }
    };
    input.click();
  }

  function resetAllSettings() {
    resetSettings();
    showToast("Settings reset to defaults", "success");
  }

  // Danger Zone: two-step arming — the first click only arms, the second runs.
  let dangerArmed = $state<string | null>(null);
  function confirmResetSettings() {
    dangerArmed = null;
    resetAllSettings();
  }
  function confirmClearBrowserData() {
    dangerArmed = null;
    try {
      localStorage.clear();
    } catch (e) {
      showToast(`Couldn't clear browser data: ${e instanceof Error ? e.message : e}`, "error");
      return;
    }
    window.location.reload();
  }

  // Drag shows the number; the zoom is applied on release, because zooming
  // while dragging moves the slider out from under the pointer.
  let uiScaleDraft = $state<number | null>(null);
  function commitUiScale(value: number) {
    uiScaleDraft = null;
    settings.update((current) => ({ ...current, uiScale: clampUiScale(value) }));
  }

  async function setCompanionWidgetVisible(visible: boolean) {
    const previous = $settings.companionWidgetVisible;
    if (!visible && $settings.widgetLaunchAtStartup) {
      const error = await setWidgetAutostart(false);
      if (error) {
        showToast(`Could not disable Windows startup: ${error}`, "error");
        return;
      }
    }
    settings.update((current) => ({ ...current, companionWidgetVisible: visible }));
    if (isBrowserPreview()) return;
    try {
      const widget = await WebviewWindow.getByLabel("widget");
      if (!widget) throw new Error("widget window is unavailable");
      if (visible) {
        await widget.show();
        await widget.emit("widget-show", {});
        await widget.setFocus();
      } else {
        await widget.emit("widget-hide", {});
        await widget.hide();
      }
    } catch (e) {
      if (visible) await setWidgetAutostart(false);
      settings.update((current) => ({ ...current, companionWidgetVisible: previous }));
      const widget = await WebviewWindow.getByLabel("widget").catch(() => null);
      if (widget) {
        // Rollback ops: the outer catch already toasted the failure —
        // these only log once for diagnosis.
        if (previous) {
          await widget.show().catch((e) => warnOnce("Widget rollback show", e));
          await widget.emit("widget-show", {}).catch((e) => warnOnce("Widget rollback emit", e));
          await widget.setFocus().catch((e) => warnOnce("Widget rollback focus", e));
        } else {
          await widget.emit("widget-hide", {}).catch((e) => warnOnce("Widget rollback emit", e));
          await widget.hide().catch((e) => warnOnce("Widget rollback hide", e));
        }
      }
      showToast(`Companion widget failed: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function setWidgetLaunchAtStartup(enabled: boolean) {
    const error = await setWidgetAutostart(enabled);
    if (error) showToast(`Startup setting failed: ${error}`, "error");
  }

  async function openDefaultApps() {
    try {
      await api.openDefaultApps();
    } catch (e) {
      showToast(`Couldn't open Windows Default Apps: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  const categories: { id: SettingsCategory; label: string; icon: string }[] = [
    { id: "general", label: "General", icon: "settings" },
    { id: "editor", label: "Editor & Writing", icon: "pencil" },
    { id: "ai", label: "AI & Providers", icon: "sparkle" },
    { id: "skills", label: "Tips", icon: "sparkle" },
    { id: "craft", label: "Craft", icon: "chart" },
    { id: "stats", label: "Stats", icon: "calendar" },
    { id: "privacy", label: "Privacy & Security", icon: "lock" },
    { id: "vaults", label: "Vaults & Backup", icon: "download" },
    { id: "capture", label: "Capture & Notifications", icon: "bell" },
    { id: "keybindings", label: "Keybindings", icon: "keyboard" },
    { id: "support", label: "Support", icon: "send" },
    { id: "about", label: "About & Diagnostics", icon: "info" },
  ];

  onMount(() => {
    const contextLength = nearestPreset($settings.smallModelContextLength, CONTEXT_PRESETS);
    const retentionDays = nearestPreset($settings.snapshotRetentionDays, SNAPSHOT_RETENTION_PRESETS);
    if (contextLength !== $settings.smallModelContextLength || retentionDays !== $settings.snapshotRetentionDays) {
      settings.update((current) => ({
        ...current,
        smallModelContextLength: contextLength,
        snapshotRetentionDays: retentionDays,
      }));
    }
    // Honest cold start: the real navigation→interactive time recorded at
    // boot (App.svelte reportBootMs). performance.now() here would only
    // measure "time since page load", which is always red and meaningless.
    try {
      const bootMs = Number(localStorage.getItem("jwe-boot-ms"));
      coldStartTime = Number.isFinite(bootMs) && bootMs > 0 ? Math.round(bootMs) : 0;
    } catch {
      coldStartTime = 0;
    }
    getAppVersion(APP_VERSION).then((v) => (appVersion = v));
    if (!isBrowserPreview()) {
      api.getVaultPath().then((path) => (resolvedVaultPath = path)).catch(() => {});
      void refreshLocalModels();
    }
    loadMemoryFactCount();
    api.appUpdateStatus()
      .then((s) => {
        updateConfigured = s.configured;
        updateEndpoint = s.endpoint;
      })
      .catch(() => {
        updateConfigured = false;
      });
  });

  async function handleCheckUpdate() {
    updateChecking = true;
    updateError = "";
    updateChecked = false;
    updateInfo = null;
    try {
      updateInfo = await checkForUpdate();
      updateChecked = true;
    } catch (e) {
      console.warn("Update check failed:", e);
      updateError = friendlyUpdateError(e);
    } finally {
      updateChecking = false;
    }
  }

  async function handleInstallUpdate() {
    updateDownloading = true;
    updateError = "";
    updateProgress = 0;
    updateProgressLabel = "Starting download…";
    try {
      await downloadAndInstall((p) => {
        if (p.phase === "finished") {
          updateProgress = 100;
          updateProgressLabel = "Download finished — installing…";
        } else if (p.total) {
          updateProgress = Math.min(99, Math.round((p.downloaded / p.total) * 100));
          updateProgressLabel = `${updateProgress}% downloaded`;
        } else {
          updateProgressLabel = `${(p.downloaded / 1048576).toFixed(1)} MB downloaded`;
        }
      });
      updateProgressLabel = "Installed. Restarting…";
      await relaunchApp();
    } catch (e) {
      updateError = String(e instanceof Error ? e.message : e);
      updateDownloading = false;
    }
  }

  async function runBenchmark() {
    benchRunning = true;
    try {
      const results = await api.perfBenchmark();
      benchResults = results;
      showToast("Diagnostics complete", "success");
    } catch (e) {
      domainError("Settings", "couldn't run benchmark", e);
      benchResults = null;
      showToast(`Diagnostics failed: ${e instanceof Error ? e.message : e}`, "error");
    } finally {
      benchRunning = false;
    }
  }

  function formatLatency(us: number): string {
    if (!Number.isFinite(us)) return "n/a";
    if (us < 1000) return `${us}us`;
    return `${(us / 1000).toFixed(1)}ms`;
  }

  function memUsageMB(): number {
    if (typeof performance !== "undefined" && (performance as any).memory) {
      return Math.round((performance as any).memory.usedJSHeapSize / 1048576);
    }
    return 0;
  }

  /** End-to-end self-test through the live api: create → save → search → link → snapshot → restore → delete. */
  async function runSelfTest() {
    selfTestRunning = true;
    selfTest = [];
    const check = async (name: string, fn: () => Promise<string>) => {
      try {
        selfTest = [...selfTest, { name, pass: true, detail: await fn() }];
      } catch (e) {
        selfTest = [...selfTest, { name, pass: false, detail: String(e) }];
      }
    };
    const stamp = Date.now().toString(36);
    let docId = "";
    let linkedId = "";
    await check("Create document", async () => {
      const doc = await api.docCreate("write", "doc", `Self-test ${stamp}`, undefined, "hello self-test world");
      docId = doc.id;
      return `created ${doc.id}`;
    });
    // Fail fast: every later step needs docId. Without it the list would
    // fill with cascading red that hides the one real failure.
    if (!docId) {
      selfTest = [...selfTest, { name: "Aborted", pass: false, detail: "Create failed (backend unreachable?) — remaining checks skipped." }];
      selfTestRunning = false;
      return;
    }
    await check("Save + reload round-trip", async () => {
      await api.docSave(docId, undefined, "hello self-test world, edited");
      const reloaded = await api.docGet(docId);
      if (!reloaded.content.includes("edited")) throw new Error("saved content did not round-trip");
      return `${reloaded.word_count} words`;
    });
    await check("Full-text search", async () => {
      const hits = await api.docSearchFull(`self-test ${stamp}`);
      if (!hits.some((h) => h.doc.id === docId)) throw new Error("created doc not found by search");
      return `${hits.length} hit(s)`;
    });
    await check("Wikilink backlink", async () => {
      const linked = await api.docCreate("write", "doc", `Self-test target ${stamp}`, undefined, "target body");
      linkedId = linked.id;
      await api.docSave(docId, undefined, `see [[Self-test target ${stamp}]] here`);
      const backs = await api.backlinksGet(linkedId);
      if (!backs.some((b) => b.source_id === docId)) throw new Error("backlink not extracted");
      return `${backs.length} backlink(s)`;
    });
    await check("Snapshot + restore", async () => {
      const snap = await api.snapshotCreate(docId);
      await api.docSave(docId, undefined, "changed after snapshot");
      const restored = await api.snapshotRestore(snap.id);
      if (!restored.content.includes("Self-test target")) throw new Error("restore did not bring back snapshot content");
      return "restored ok";
    });
    await check("Graph query", async () => {
      const g = await api.graphQuery();
      if (!g.nodes.some((n) => n.id === docId)) throw new Error("doc missing from graph");
      return `${g.nodes.length} nodes / ${g.edges.length} edges`;
    });
    await check("Log get-or-create", async () => {
      const log = await api.logGetOrCreate(new Date().toISOString().slice(0, 10));
      return log.title;
    });
    await check("Pinned list + metrics + rhythm", async () => {
      await api.docTogglePin(docId);
      const pinned = await api.docListPinned();
      if (!pinned.some((d) => d.id === docId)) throw new Error("pinned doc not listed");
      await api.docTogglePin(docId);
      await api.memoryRecordMetric(docId, "filter_words", 0.03);
      const trend = await api.craftMetricsTrend(docId, "filter_words");
      if (trend.length === 0) throw new Error("metric trend empty");
      const rhythm = await api.dashboardTodayRhythm();
      if (rhythm.length !== 24) throw new Error("rhythm is not 24 buckets");
      return "ok";
    });
    await check("Export md/txt/html", async () => {
      const md = await api.convertRun(docId, "md");
      const txt = await api.convertRun(docId, "txt");
      const html = await api.convertRun(docId, "html");
      if (!md.filename.endsWith(".md") || !txt.filename.endsWith(".txt") || !html.filename.endsWith(".html")) {
        throw new Error("wrong export filenames");
      }
      if (!html.mime.includes("html")) throw new Error("wrong html mime");
      return "3 formats ok";
    });
    await check("Canvas cards + links", async () => {
      const blank = { id: "", body: "x", x: 10, y: 10, color: "slate", doc_id: null, updated_at: "" };
      const n1 = await api.canvasUpsertNode({ ...blank, title: `Self-test card ${stamp}` });
      const n2 = await api.canvasUpsertNode({ ...blank, title: `Self-test card 2 ${stamp}`, x: 300 });
      const edge = await api.canvasConnect(n1.id, n2.id, "relates");
      const [ns, es] = await api.canvasList();
      if (!ns.some((n) => n.id === n1.id) || !es.some((e) => e.id === edge.id)) {
        throw new Error("canvas round-trip failed");
      }
      await api.canvasDeleteEdge(edge.id);
      await api.canvasDeleteNode(n1.id);
      await api.canvasDeleteNode(n2.id);
      return "ok";
    });
    await check("Cleanup", async () => {
      await api.docDelete(docId);
      await api.docDelete(linkedId);
      try {
        await api.docGet(docId);
        throw new Error("doc still exists after delete");
      } catch (e) {
        if (String(e).includes("still exists")) throw e;
      }
      return "deleted";
    });
    const passed = selfTest.filter((t) => t.pass).length;
    const total = selfTest.length;
    selfTest = [...selfTest, {
      name: `Result: ${passed}/${total} passed`,
      pass: passed === total,
      detail: passed === total ? "all green" : "see the first ✗ above — later failures may cascade from it",
    }];
    selfTestRunning = false;
  }

  async function clearHistory(type: string) {
    try {
      if (type === "memory") {
        await api.memoryForgetAll();
        memoryFactCount = 0;
        showToast("Cleared AI memory facts", "success");
        return;
      }
      let count = 0;
      switch (type) {
        case "conversations": count = await api.clearConversations(); break;
        case "messages": count = await api.clearMessages(); break;
        case "snapshots": count = await api.clearSnapshots(); break;
        case "usage": count = await api.clearUsageEvents(); break;
        case "tabs": count = await api.clearTabStates(); break;
      }
      showToast(`Cleared ${count} ${type}`, "success");
    } catch (e) {
      showToast(`Failed to clear ${type}`, "error");
    }
  }

  async function loadMemoryFactCount() {
    if (isBrowserPreview()) {
      memoryFactCount = 0;
      return;
    }
    try {
      const health = await api.memorySidecarHealth();
      memoryFactCount = health.facts;
    } catch {
      memoryFactCount = null;
    }
  }
</script>

<div class="settings-pane">
  <div class="settings-sidebar">
    <div class="settings-header">
      <h2>Settings</h2>
    </div>
    <nav class="settings-nav">
      {#each categories as cat}
        <button
          class="nav-item"
          class:active={activeCategory === cat.id}
          onclick={() => settingsCategory.set(cat.id)}
        >
          <span class="nav-icon"><Icon name={cat.icon} size={16} /></span>
          <span>{cat.label}</span>
        </button>
      {/each}
    </nav>
  </div>

  <div class="settings-content">
    {#if activeCategory === "general"}
      <div class="settings-section">
        <h3>General</h3>
        <div class="setting-row">
          <label for="setting-theme">Theme style</label>
          <select id="setting-theme" bind:value={$settings.theme}>
            <option value="default">Default room</option>
            <option value="brutalist">Brutalist</option>
            <option value="glass">Glass</option>
          </select>
        </div>
        <div class="setting-row">
          <span id="setting-theme-mode-label">Theme mode</span>
          <div class="segmented" role="radiogroup" aria-labelledby="setting-theme-mode-label">
            <button
              class:active={$settings.themeMode === "dark"}
              role="radio"
              aria-checked={$settings.themeMode === "dark"}
              onclick={() => ($settings = { ...$settings, themeMode: "dark" })}
            >Dark</button>
            <button
              class:active={$settings.themeMode === "light"}
              role="radio"
              aria-checked={$settings.themeMode === "light"}
              onclick={() => ($settings = { ...$settings, themeMode: "light" })}
            >Light</button>
            <button
              class:active={$settings.themeMode === "system"}
              role="radio"
              aria-checked={$settings.themeMode === "system"}
              onclick={() => ($settings = { ...$settings, themeMode: "system" })}
            >System</button>
          </div>
        </div>
        {#if !isBrowserPreview()}
          <div class="setting-row">
            <label for="setting-ui-scale">Interface size</label>
            <div class="ui-scale-control">
              <input
                id="setting-ui-scale"
                type="range"
                min={UI_SCALE_MIN}
                max={UI_SCALE_MAX}
                step={UI_SCALE_STEP}
                value={uiScaleDraft ?? $settings.uiScale}
                oninput={(e) => (uiScaleDraft = Number(e.currentTarget.value))}
                onchange={(e) => commitUiScale(Number(e.currentTarget.value))}
              />
              <span class="ui-scale-value">{Math.round((uiScaleDraft ?? $settings.uiScale) * 100)}%</span>
              <button class="ui-scale-reset" onclick={() => commitUiScale(1)} disabled={$settings.uiScale === 1 && uiScaleDraft === null}>Reset</button>
            </div>
          </div>
        {/if}
        <div class="setting-row accent-row-block">
          <span class="setting-label" id="setting-accent-label">Accent color</span>
          <div class="accent-pick" role="group" aria-labelledby="setting-accent-label">
            <div class="swatches">
              {#each ACCENT_PRESETS as preset}
                <button
                  class="swatch"
                  class:active={$settings.accentOverride === preset.hex}
                  style={`background: ${preset.hex}`}
                  title={preset.name}
                  aria-label={`Accent ${preset.name}`}
                  aria-pressed={$settings.accentOverride === preset.hex}
                  onclick={() => ($settings = { ...$settings, accentOverride: preset.hex })}
                ></button>
              {/each}
              <label
                class="swatch custom-swatch"
                class:active={$settings.accentOverride !== "" && !ACCENT_PRESETS.some((p) => p.hex === $settings.accentOverride)}
                title="Custom color"
              >
                <span aria-hidden="true">+</span>
                <input
                  id="setting-accent"
                  type="color"
                  value={$settings.accentOverride || defaultAccentFor($settings.theme, baseMode)}
                  oninput={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    if (/^#[0-9a-fA-F]{6}$/.test(v)) $settings = { ...$settings, accentOverride: v.toLowerCase() };
                  }}
                  aria-label="Custom accent color"
                />
              </label>
            </div>
            {#if $settings.accentOverride}
              <button class="link-btn" onclick={() => ($settings = { ...$settings, accentOverride: "" })}>Reset to theme accent</button>
            {:else}
              <span class="setting-desc">Theme default — pick a preset or any custom color.</span>
            {/if}
          </div>
        </div>
        {#if isBrowserPreview()}
          <p class="setting-desc">The companion widget, Windows startup, and file associations are desktop-app features — they don't exist in this web build.</p>
        {:else}
        <div class="setting-row">
          <label for="setting-companion-widget">Companion widget (show/hide)</label>
          <input
            id="setting-companion-widget"
            type="checkbox"
            checked={$settings.companionWidgetVisible}
            onchange={(event) => setCompanionWidgetVisible((event.currentTarget as HTMLInputElement).checked)}
          />
        </div>
        <div class="setting-row">
          <label for="setting-widget-kind">Widget type</label>
          <select id="setting-widget-kind" bind:value={$settings.widgetKind}>
            {#each WIDGET_KINDS as kind}
              <option value={kind.id}>{kind.label}</option>
            {/each}
          </select>
          <p class="setting-desc">{widgetSpec($settings.widgetKind).job} Drag it anywhere and resize it; it remembers its place.</p>
        </div>
        <div class="setting-row">
          <label for="setting-widget-startup">Start with Windows</label>
          <input id="setting-widget-startup" type="checkbox" disabled={!$settings.companionWidgetVisible || !isWindowsRuntime()} checked={$settings.widgetLaunchAtStartup} onchange={(event) => setWidgetLaunchAtStartup((event.currentTarget as HTMLInputElement).checked)} />
        </div>
        <div class="setting-row">
          <span class="setting-label">Default text editor</span>
          <button id="setting-default-app" class="secondary-btn" disabled={!isWindowsRuntime()} onclick={openDefaultApps}>Make Just Write ehis my default text editor</button>
        </div>
        {/if}
        <div class="setting-row">
          <label for="setting-compact-mode">Compact mode (tighter chrome)</label>
          <input id="setting-compact-mode" type="checkbox" bind:checked={$settings.compactMode} />
        </div>
        <div class="setting-row">
          <label for="setting-autohide-chrome">Auto-hide tabs while typing</label>
          <input id="setting-autohide-chrome" type="checkbox" bind:checked={$settings.autoHideChrome} />
        </div>
        <div class="setting-row">
          <label for="setting-rhythm-heatmap">Paragraph density in status bar</label>
          <input id="setting-rhythm-heatmap" type="checkbox" bind:checked={$settings.rhythmHeatmapInStatusBar} />
        </div>
        <div class="setting-row">
          <span class="setting-label">Setup flow</span>
          <button class="secondary-btn" onclick={() => window.dispatchEvent(new CustomEvent("replay-onboarding"))}>Replay onboarding</button>
        </div>
        <div class="setting-row column">
          <span class="setting-label">Workspace tabs</span>
          <span class="setting-hint">Uncheck to hide a workspace from the sidebar and top bar. Hidden workspaces stay one Ctrl+K away.</span>
          <div class="ws-toggles">
            {#each workspaces.filter((w) => w.id !== "files") as w}
              <label class="check-row">
                <input type="checkbox" checked={!workspaceHidden(w.id)} onchange={() => toggleWorkspaceVisible(w.id)} />
                <span>{w.label}</span>
              </label>
            {/each}
          </div>
        </div>
      </div>

    {:else if activeCategory === "editor"}
      <div class="settings-section">
        <h3>Editor & Writing</h3>
        <div class="setting-row">
          <label for="setting-font-size">Font Size</label>
          <div class="range-row">
            <input id="setting-font-size" type="range" bind:value={$settings.fontSize} min="10" max="32" step="1" />
            <span class="range-value">{$settings.fontSize}px</span>
          </div>
        </div>
        <div class="setting-row">
          <label for="setting-line-height">Line Height</label>
          <div class="range-row">
            <input id="setting-line-height" type="range" bind:value={$settings.lineHeight} min="1.0" max="3.0" step="0.1" />
            <span class="range-value">{$settings.lineHeight.toFixed(1)}×</span>
          </div>
        </div>
        <div class="setting-row">
          <label for="setting-font-family">Editor Font</label>
          <select id="setting-font-family" bind:value={$settings.fontFamily}>
            {#each EDITOR_FONTS as font}
              <option value={font}>{font === "monospace" ? "System Default" : font}</option>
            {/each}
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-typewriter-default">Typewriter Mode (default)</label>
          <input id="setting-typewriter-default" type="checkbox" bind:checked={$settings.typewriterDefault} />
        </div>
        <div class="setting-row">
          <label for="setting-focus-dimming-default">Focus Dimming (default)</label>
          <input id="setting-focus-dimming-default" type="checkbox" bind:checked={$settings.focusDimmingDefault} />
        </div>
        <div class="setting-row">
          <label for="setting-focus-context-lines">Focus context lines</label>
          <div class="range-row">
            <input id="setting-focus-context-lines" type="range" min="0" max="10" step="1" bind:value={$settings.focusContextLines} />
            <span class="range-value">{$settings.focusContextLines} lines</span>
          </div>
        </div>
        <div class="setting-row">
          <label for="setting-focus-dim-strength">Focus dim strength</label>
          <input id="setting-focus-dim-strength" type="range" min="0.1" max="1" step="0.05" bind:value={$settings.focusDimStrength} />
        </div>
        <div class="setting-row">
          <label for="setting-autocorrect-enabled">Autocorrect</label>
          <input id="setting-autocorrect-enabled" type="checkbox" bind:checked={$settings.autocorrectEnabled} />
        </div>
        <div class="setting-row">
          <label for="setting-dictionary-language">Autocorrect dictionary</label>
          <select id="setting-dictionary-language" bind:value={$settings.dictionaryLanguage}>
            <option value="en">English</option>
            <option value="off">Off — custom words only</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-ghost-enabled">Ghost (AI autocomplete)</label>
          <input id="setting-ghost-enabled" type="checkbox" bind:checked={$settings.ghostEnabled} />
        </div>
      </div>

    {:else if activeCategory === "ai"}
      <div class="settings-section">
        <h3>AI & Providers</h3>
         <p class="setting-desc">Small slot: Ghost autocomplete and light tasks. Main slot: chat, Composer, Structurize.</p>
         {#if localModelStatus}
           <p class="setting-desc" role="status">{localModelStatus}</p>
         {/if}
        {#if isBrowserPreview()}
          <p class="setting-desc">On the web both slots talk to HTTP endpoints you configure below — there is no bundled local model here. Ghost needs a reachable small slot to suggest anything.</p>
        {/if}
        <div class="setting-row">
          <label for="setting-small-provider">Small model provider</label>
          <select id="setting-small-provider" value={smallProviderPreset()} onchange={(e) => chooseSmallProvider((e.currentTarget as HTMLSelectElement).value)}>
            {#if !isBrowserPreview()}<option value="local">Local models folder</option>{/if}
            <option value="openai">OpenAI</option>
            <option value="custom">Custom OpenAI-compatible endpoint</option>
          </select>
        </div>
        {#if smallProviderPreset() === "custom"}
          <div class="setting-row">
            <label for="setting-small-model-endpoint">Endpoint</label>
            <input id="setting-small-model-endpoint" type="text" bind:value={$settings.smallModelEndpoint} placeholder="https://provider.example/v1" />
          </div>
        {/if}
        {#if !isBrowserPreview() && isLocalLlmSentinel($settings.smallModelEndpoint)}
          <div class="setting-row">
            <label for="setting-small-model-name">Local model</label>
            <div class="range-row">
              <select id="setting-small-model-name" bind:value={$settings.smallModelName}>
                <option value="">Auto-select first model</option>
                {#each localModels as model}
                  <option value={model.name}>{model.name} · LLM · {modelQuantTag(model.name)} · FA · KV Q8_0</option>
                {/each}
              </select>
              <button class="secondary-btn" onclick={refreshLocalModels} disabled={localModelsLoading}>
                {localModelsLoading ? "Scanning…" : "Refresh"}
              </button>
            </div>
          </div>
        {:else if smallProviderPreset() === "custom"}
          <div class="setting-row">
            <label for="setting-small-model-name">Small model name</label>
            <input id="setting-small-model-name" type="text" bind:value={$settings.smallModelName} placeholder="Model ID from provider" />
          </div>
        {/if}
        <p class="setting-desc">Light-task picks: the bundled local endpoint by default — or any OpenAI-compatible endpoint (OpenAI, Google, Anthropic via gateway, Custom). See docs/MODELS.md.</p>
        {#if !isBrowserPreview() && isLocalLlmSentinel($settings.smallModelEndpoint)}
          <div class="setting-row">
            <label for="setting-small-model-ctx">Small Model Context Length</label>
            <select id="setting-small-model-ctx" bind:value={$settings.smallModelContextLength}>
              <option value={2048}>2K</option>
              <option value={4096}>4K</option>
              <option value={8192}>8K</option>
              <option value={16384}>16K</option>
              <option value={32768}>32K</option>
              <option value={65536}>64K</option>
            </select>
          </div>
          <p class="setting-desc">The app loads GGUFs as-is; it does not change their quant. The picker shows the file quant plus runner flags: Flash Attention on, K/V cache Q8_0, one slot.</p>
        {/if}
        <div class="setting-row">
          <label for="setting-use-small-as-main">Use Small Model as Main</label>
          <input id="setting-use-small-as-main" type="checkbox" bind:checked={$settings.useSmallAsMain} />
        </div>
        {#if isBrowserPreview()}
          <p class="setting-desc">Route the AI panel's chat, Composer, and Structurize at the small slot's HTTP endpoint instead of the main slot.</p>
        {:else}
          <p class="setting-desc">Route the AI panel's chat, Composer, and Structurize at the small model instead of the main slot. Ghost routing is unchanged (local :8093 if enabled, else small slot).</p>
        {/if}
        <div class="setting-row">
          <label for="setting-main-provider">Main model provider</label>
          <select id="setting-main-provider" value={mainProviderPreset()} onchange={(e) => chooseMainProvider((e.currentTarget as HTMLSelectElement).value)}>
            <option value="openai">OpenAI</option>
            <option value="custom">Custom OpenAI-compatible endpoint</option>
          </select>
        </div>
        {#if mainProviderPreset() === "custom"}
          <div class="setting-row">
            <label for="setting-main-model-endpoint">Endpoint</label>
            <input id="setting-main-model-endpoint" type="text" bind:value={$settings.mainModelEndpoint} placeholder="https://provider.example/v1" />
          </div>
          <div class="setting-row">
            <label for="setting-main-model-name">Model name</label>
            <input id="setting-main-model-name" type="text" bind:value={$settings.mainModelName} placeholder="Provider model ID" />
          </div>
        {/if}
        <p class="setting-desc">OpenAI uses the default model. Custom endpoints need their URL and model ID. Add the key below, then Test.</p>
        <div class="setting-row">
          <span class="setting-label">Test Small Slot</span>
          <button class="clear-btn" onclick={() => testSlot("small")} disabled={testingSlot !== null}>
            {testingSlot === "small" ? "Pinging…" : "Test"}
          </button>
        </div>
        {#if slotResults.small}
          <p class={slotResults.small.ok ? "update-ok" : "update-error"}>{slotResultText("Small", slotResults.small)}</p>
        {/if}
        <div class="setting-row">
          <span class="setting-label">Test Main Slot</span>
          <button class="clear-btn" onclick={() => testSlot("main")} disabled={testingSlot !== null}>
            {testingSlot === "main" ? "Pinging…" : "Test"}
          </button>
        </div>
        {#if slotResults.main}
          <p class={slotResults.main.ok ? "update-ok" : "update-error"}>{slotResultText("Main", slotResults.main)}</p>
        {/if}
        <div class="setting-row">
          <label for="setting-api-key">API Key</label>
          <input id="setting-api-key" type="password" bind:value={$settings.apiKey} placeholder="sk-..." />
        </div>

        <div class="setting-row">
          <label for="setting-blank-mode-default">Blank Mode Default</label>
          <input id="setting-blank-mode-default" type="checkbox" bind:checked={$settings.blankModeDefault} />
        </div>
        <div class="setting-row">
          <label for="setting-logs-local-only">Logs: Local Model Only</label>
          <input id="setting-logs-local-only" type="checkbox" bind:checked={$settings.logsLocalOnly} />
        </div>
      </div>

      <div class="settings-section">
        <h3>AI writing style</h3>
        <p class="setting-desc">Choose how the assistant responds. The style applies across AI features.</p>
        <div class="setting-row">
          <label for="setting-ai-persona">Writing style</label>
          <select id="setting-ai-persona" bind:value={$settings.aiPersona}>
            {#each AI_PERSONA_PRESETS as preset}
              <option value={preset.value}>{preset.label}</option>
            {/each}
            {#if $settings.aiPersona && !AI_PERSONA_PRESETS.some((preset) => preset.value === $settings.aiPersona)}
              <option value={$settings.aiPersona}>Current custom style</option>
            {/if}
          </select>
        </div>
      </div>

      <div class="settings-section">
        <h3>Voice — STT & TTS</h3>
        <p class="setting-desc">Desktop uses Moonshine-base GGUF via transcribe.cpp for speech-to-text and Phonon q8 (Rust sidecar) for text-to-speech. The web build uses the browser's built-in dictation and read-aloud voices instead. Desktop models lazy-load on first use. Torch-free, fully offline.</p>

        <h4>Speech-to-Text (Moonshine-base GGUF)</h4>
        <div class="setting-row">
          <label for="setting-stt-enabled">STT Enabled</label>
          <input id="setting-stt-enabled" type="checkbox" bind:checked={$settings.sttEnabled} onchange={onSttToggle} />
        </div>
        {#if !isBrowserPreview()}
          <div class="setting-row">
            <span class="setting-label">Runtime check</span>
            <button id="test-stt-setup" class="secondary-btn" onclick={testSttSetup} disabled={localModelTesting !== null}>
              {localModelTesting === "stt" ? "Loading…" : "Test STT"}
            </button>
          </div>
          <p class="setting-desc">Uses the speech model installed in the app models folder.</p>
        {/if}

        <h4>Text-to-Speech (Phonon q8)</h4>
        <div class="setting-row">
          <label for="setting-tts-enabled">TTS Enabled</label>
          <input id="setting-tts-enabled" type="checkbox" bind:checked={$settings.ttsEnabled} onchange={onTtsToggle} />
        </div>
        {#if !isBrowserPreview()}
          <div class="setting-row">
            <span class="setting-label">Runtime check</span>
            <button id="test-tts-setup" class="secondary-btn" onclick={testTtsSetup} disabled={localModelTesting !== null}>
              {localModelTesting === "tts" ? "Generating…" : "Test TTS"}
            </button>
          </div>
          <p class="setting-desc">Uses the voice model installed in the app models folder.</p>
        {:else}
          <p class="setting-desc">Voice and language come from your browser here — speed below still applies.</p>
        {/if}
        {#if !isBrowserPreview()}
        <div class="setting-row">
          <label for="setting-tts-voice">Voice</label>
          <select id="setting-tts-voice" bind:value={$settings.ttsVoice}>
            {#each PHONON_VOICES as voice}
              <option value={voice.id}>{voice.label}</option>
            {/each}
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-tts-speed">Speed</label>
          <div class="range-row">
            <input
              id="setting-tts-speed"
              type="range"
              min="0.5"
              max="2.0"
              step="0.1"
              bind:value={$settings.ttsSpeed}
            />
            <span class="range-value">{Number($settings.ttsSpeed).toFixed(1)}x</span>
          </div>
          <p class="setting-desc">0.5x = slow, 1.0x = normal, 2.0x = fast</p>
        </div>
        {/if}

        <h4>Local model runner</h4>
        <div class="setting-row">
          <label for="setting-llm-enabled">LLM Enabled</label>
          <input id="setting-llm-enabled" type="checkbox" bind:checked={$settings.llmEnabled} onchange={onLlmToggle} />
        </div>
        {#if !isBrowserPreview()}
          <div class="setting-row">
            <span class="setting-label">Runtime check</span>
            <button id="test-llm-setup" class="secondary-btn" onclick={testLlmSetup} disabled={localModelTesting !== null || !!$llmStarting}>
              {localModelTesting === "llm" || $llmStarting ? "Testing…" : "Test local model"}
            </button>
          </div>
          <p class="setting-desc">Add a GGUF model to the app models folder, then select it in the Small Model setting above.</p>
        {:else}
          <p class="setting-desc">No bundled model on the web — point the small/main slots at reachable HTTP endpoints instead.</p>
        {/if}

        <div class="setting-row">
          <label for="setting-model-retention">Model retention</label>
          <select id="setting-model-retention" bind:value={$settings.modelRetention}>
            <option value="idle-5min">Idle 5 min</option>
            <option value="session">Session (30 min idle)</option>
            <option value="always">Always (never idle-offload)</option>
          </select>
          <p class="setting-desc">How long STT/TTS/LLM stay loaded after last use. Idle-offload frees RAM; offloaded models reload on next use.</p>
        </div>

      </div>

      <div class="settings-section">
        <h3>Templates</h3>
        <p class="setting-desc">Reusable document templates. Create from the command palette or below.</p>
        {#if $settings.templates.length > 0}
          <div class="templates-list">
            {#each $settings.templates as tmpl, i}
              <div class="template-item">
                <span class="template-name">{tmpl.name}</span>
                <span class="template-ws">{tmpl.workspace}</span>
                <button class="clear-btn" onclick={() => {
                  $settings = { ...$settings, templates: $settings.templates.filter((_, j) => j !== i) };
                }}>Remove</button>
              </div>
            {/each}
          </div>
        {:else}
          <p class="setting-desc">No templates yet. Use "Save as Template" from the command palette.</p>
        {/if}
      </div>

    {:else if activeCategory === "privacy"}
      <div class="settings-section">
        <h3>Privacy & Security</h3>
        <div class="setting-row">
          <label for="setting-craft-profiling-enabled">Craft analytics recording</label>
          <input id="setting-craft-profiling-enabled" type="checkbox" bind:checked={$settings.craftProfilingEnabled} />
        </div>
        <p class="setting-desc">Off by default. When on, saves record dialogue/sentence/filter-word snapshots (max once a minute per doc) that power Craft charts and the filter-word tip.</p>
      </div>
      {#if isBrowserPreview()}
      <div class="settings-section">
        <h3>AI Memory (vendored harness)</h3>
        <p class="setting-desc">Cross-session facts and secret scrubbing run in the desktop app's local sidecar — not available in this web build.</p>
      </div>
      {:else}
      <div class="settings-section">
        <h3>AI Memory (vendored harness)</h3>
        <p class="setting-desc">Cross-session facts + secret scrubbing, via a local sidecar. No cloud, ever.</p>
        <div class="setting-row">
          <label for="setting-ai-memory-enabled">Remember facts across chats</label>
          <input id="setting-ai-memory-enabled" type="checkbox" bind:checked={$settings.aiMemoryEnabled} onchange={onMemoryToggle} />
        </div>
        <div class="setting-row">
          <label for="setting-scrub-secrets">Scrub secrets before AI calls</label>
          <input id="setting-scrub-secrets" type="checkbox" bind:checked={$settings.scrubSecrets} />
        </div>
        <div class="setting-row">
          <span class="setting-label">Stored facts</span>
          <span class="value">{memoryFactCount === null ? "…" : memoryFactCount}</span>
        </div>
      </div>
      {/if}
      <div class="settings-section">
        <h3>Clear History</h3>
        <div class="setting-row">
          <label for="clear-conversations">AI Conversations</label>
          <button id="clear-conversations" class="clear-btn" onclick={() => clearHistory("conversations")}>Clear</button>
        </div>
        <div class="setting-row">
          <label for="clear-messages">Chat Messages</label>
          <button id="clear-messages" class="clear-btn" onclick={() => clearHistory("messages")}>Clear</button>
        </div>
        <div class="setting-row">
          <label for="clear-snapshots">Version Snapshots</label>
          <button id="clear-snapshots" class="clear-btn" onclick={() => clearHistory("snapshots")}>Clear</button>
        </div>
        <div class="setting-row">
          <label for="clear-usage">Usage Analytics</label>
          <button id="clear-usage" class="clear-btn" onclick={() => clearHistory("usage")}>Clear</button>
        </div>
        <div class="setting-row">
          <label for="clear-tabs">Tab States</label>
          <button id="clear-tabs" class="clear-btn" onclick={() => clearHistory("tabs")}>Clear</button>
        </div>
        <div class="setting-row">
          <label for="clear-memory">AI Memory Facts</label>
          <button id="clear-memory" class="clear-btn" onclick={() => clearHistory("memory")}>Clear</button>
        </div>
      </div>
      <div class="settings-section">
        <h3>Per-Workspace AI Privacy</h3>
        {#if isBrowserPreview()}
          <p class="setting-desc">When enabled, workspace content is never sent anywhere — AI stays off for it here (there is no local model on the web).</p>
        {:else}
          <p class="setting-desc">When enabled, workspace content is never sent to external API providers — local model only.</p>
        {/if}
        {#each ["logs", "write", "novel", "script", "projects", "reader", "map", "inbox"] as ws}
          <div class="setting-row">
            <label for="setting-ws-privacy-{ws}">{ws === "inbox" ? "Capture" : ws.charAt(0).toUpperCase() + ws.slice(1)}</label>
            <input
              id="setting-ws-privacy-{ws}"
              type="checkbox"
              checked={$settings.workspacePrivacy[ws] === true}
              onchange={() => {
                $settings.workspacePrivacy = {
                  ...$settings.workspacePrivacy,
                  [ws]: !$settings.workspacePrivacy[ws]
                };
              }}
            />
          </div>
        {/each}
      </div>

    {:else if activeCategory === "vaults"}
      <div class="settings-section">
        <h3>Vaults & Backup</h3>
        <div class="setting-row">
          <span class="setting-label">Current Vault</span>
          <span class="value">{isBrowserPreview() ? "Browser localStorage (this browser only)" : resolvedVaultPath || $settings.vaultPath}</span>
        </div>
        <div class="setting-row">
          <label for="setting-backup-frequency">Backup Frequency</label>
          <select id="setting-backup-frequency" bind:value={$settings.backupFrequency}>
            <option value="daily">Daily</option>
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="never">Never</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-snapshot-retention-days">Snapshot Retention (days)</label>
          <select id="setting-snapshot-retention-days" bind:value={$settings.snapshotRetentionDays}>
            <option value={7}>1 week</option>
            <option value={30}>1 month</option>
            <option value={90}>3 months</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
          </select>
        </div>
        <BackupManager />
      </div>

    {:else if activeCategory === "capture"}
      <div class="settings-section">
        <h3>Capture & Notifications</h3>
        <p class="setting-desc">Press Ctrl+Shift+F anywhere for the Quick Capture overlay, or use the Capture button in the status bar / mobile bottom bar. Quick Capture targets the Capture workspace by default but can send to any workspace.</p>
        <div class="setting-row">
          <label for="setting-desktop-notifications">Show desktop notifications while app is hidden</label>
          <input
            id="setting-desktop-notifications"
            type="checkbox"
            checked={$settings.desktopNotificationsEnabled}
            onchange={(event) => configureOsNotifications(event.currentTarget.checked)}
          />
        </div>
        <p class="setting-desc">Errors, external file conflicts, and long AI jobs notify through the operating system notification area when the app is hidden. Error text may include document details.</p>
        {#if osNotifStatus}<p class="setting-desc" aria-live="polite">{osNotifStatus}</p>{/if}
        <div class="setting-row">
          <label for="setting-android-capture-method">Android Capture Method</label>
          <select id="setting-android-capture-method" bind:value={$settings.androidCaptureMethod}>
            <option value="notification">Notification</option>
            <option value="widget">Widget</option>
            <option value="share-target">Share Target</option>
          </select>
        </div>
        {#if $settings.androidCaptureMethod === "notification"}
          <div class="setting-row">
            <span class="setting-label">Pin capture notification</span>
            <button class="secondary-btn" onclick={pinNotification} disabled={pinningNotif}>
              {pinningNotif ? "Pinning…" : "Pin now"}
            </button>
          </div>
          {#if notifStatus}
            <p class="setting-desc">{notifStatus}</p>
          {/if}
          <p class="setting-desc">Tapping it opens the Capture box. Needs the installed PWA (or the Android app); a home-screen widget needs the native shell and isn't available in the browser.</p>
        {:else if $settings.androidCaptureMethod === "share-target"}
          <p class="setting-desc">Share Target is live: with the PWA installed, Android's share sheet sends text and links straight into the Capture box — shared text saves automatically.</p>
        {:else}
          <p class="setting-desc">Widgets need the native Android shell (Tauri mobile) — not available in the browser preview. Use Notification or Share Target for now.</p>
        {/if}
        <div class="setting-row">
          <label for="setting-weekly-triage-reminder">Weekly Triage Reminder</label>
          <input id="setting-weekly-triage-reminder" type="checkbox" bind:checked={$settings.weeklyTriageReminder} />
        </div>
        <p class="setting-desc">Once a week, a banner surfaces captures older than 7 days with a one-click Open Capture action.</p>
        <div class="setting-row">
          <label for="setting-streak-reminder">Streak Reminder</label>
          <input id="setting-streak-reminder" type="checkbox" bind:checked={$settings.streakReminder} />
        </div>
        <p class="setting-desc">Once a day, a gentle nudge if your writing streak has nothing logged yet today.</p>
        <div class="setting-row">
          <label for="setting-logs-stamp-place">Stamp location & weather on new daily notes</label>
          <input id="setting-logs-stamp-place" type="checkbox" bind:checked={$settings.logsStampPlace} />
        </div>
        <p class="setting-desc">Opt-in: sends your coordinates to Nominatim (place name) and Open-Meteo (weather) when stamping a new daily note. Off by default.</p>
      </div>

    {:else if activeCategory === "skills"}
      <div class="settings-section">
        <h3>Skill Nudges</h3>
        <div class="setting-row">
          <label for="setting-skill-nudges-enabled">Show Skill Nudges</label>
          <input id="setting-skill-nudges-enabled" type="checkbox" bind:checked={$settings.skillNudgesEnabled} />
        </div>
        <p class="setting-desc">Occasional tips about unused features (e.g., Node Map, Composer). Disable to stop the strip entirely.</p>
      </div>
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./SkillsPage.svelte")} label="Tips" />
      </div>

    {:else if activeCategory === "craft"}
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./CraftPage.svelte")} label="Craft" />
      </div>

    {:else if activeCategory === "stats"}
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./WritingAnalytics.svelte")} label="Analytics" />
        <LazyWorkspace loader={() => import("./UsageMemory.svelte")} label="Usage memory" />
      </div>

    {:else if activeCategory === "keybindings"}
      <div class="settings-section">
        <h3>Keybindings</h3>
        <div class="keybindings-list">
          {#each Object.entries($settings.keybindings) as [action, binding]}
            <div class="keybinding-row">
              <span class="action">{action}</span>
              <span class="binding">{binding}</span>
            </div>
          {/each}
        </div>
      </div>

    {:else if activeCategory === "support"}
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./SupportPane.svelte")} label="Support" />
      </div>

    {:else if activeCategory === "about"}
      {@const health = readSessionHealth()}
      {@const slow = getSlowCalls()}
      <div class="settings-section">
        <img class="about-logo" src={aboutLogo} alt="Just Write ehis — pen wrote 'this' with E-tick" />
        <h3>About & Diagnostics</h3>
        <div class="setting-row">
          <span class="setting-label">Version</span>
          <span class="value">{appVersion}</span>
        </div>
        <div class="setting-row">
          <span class="setting-label">Vault Path</span>
          <span class="value">{resolvedVaultPath || $settings.vaultPath}</span>
        </div>

        <h3>Session Health</h3>
        <div class="setting-row">
          <span class="setting-label">Last Boot</span>
          <span class="value">{health.bootMs != null ? `${health.bootMs}ms` : "…"}</span>
        </div>
        <div class="setting-row">
          <span class="setting-label">Previous Session</span>
          <span class="value">{health.prevExit === "clean" ? "exited cleanly" : health.prevExit === "unclean" ? "ended unexpectedly ⚠" : "unknown (first run?)"}</span>
        </div>
        {#if health.stuckStep}
          <div class="setting-row">
            <span class="setting-label">Stuck Boot Step</span>
            <span class="value">{health.stuckStep}</span>
          </div>
        {/if}
        <div class="setting-row">
          <span class="setting-label">Slow Calls (&gt;{SLOW_CALL_MS / 1000}s)</span>
          <span class="value">{slow.length === 0 ? "none" : formatSlowCalls(slow)}</span>
        </div>

        <h3>Export setup</h3>
        <div class="setting-row">
          <span class="setting-label">Word / eBook export</span>
          <span class="value">built in ✓</span>
        </div>
        <div class="setting-row">
          <span class="setting-label">PDF export (Typst {exportStatus?.typstVersion || "0.15.1"})</span>
          <span class="value">{exportStatus == null ? "…" : exportStatus.typst ? "bundled ✓" : "missing"}</span>
          <button class="clear-btn" onclick={probeExportSetup} disabled={exportProbing}>
            {exportProbing ? "Probing…" : "Probe"}
          </button>
        </div>
        {#if exportStatus != null && !exportStatus.typst}
          <p class="setting-desc">PDF export needs the bundled Typst binary. Run <code>npm run fetch:typst</code> (or <code>python src-tauri/sidecars/fetch_sidecars.py --typst</code>) and press Probe. Word and eBook export need no binary.</p>
        {/if}

        <h3>Performance Budget (§14)</h3>
        <div class="perf-grid">
          <div class="perf-item">
            <span class="perf-label">Cold Start</span>
            <span class="perf-value" class:pass={coldStartTime < 1000} class:warn={coldStartTime >= 1000}>
              {coldStartTime > 0 ? `${coldStartTime}ms` : '...'}
            </span>
            <span class="perf-budget">budget: &lt;1000ms</span>
          </div>
          <div class="perf-item">
            <span class="perf-label">Idle Memory</span>
            <span class="perf-value">
              {memUsageMB() > 0 ? `${memUsageMB()}MB` : 'N/A (Chromium only)'}
            </span>
            <span class="perf-budget">budget: &lt;300MB</span>
          </div>
        </div>

        {#if benchResults}
          <div class="perf-grid">
            <div class="perf-item">
              <span class="perf-label">Documents</span>
              <span class="perf-value">{benchResults.doc_count}</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">Graph Edges</span>
              <span class="perf-value">{benchResults.edge_count}</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">Snapshots</span>
              <span class="perf-value">{benchResults.snapshot_count}</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">RAG Chunks</span>
              <span class="perf-value">{benchResults.rag_chunk_count}</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">Total Words</span>
              <span class="perf-value">{benchResults.total_words?.toLocaleString() ?? '0'}</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">Search Latency</span>
              <span class="perf-value" class:pass={benchResults.search_latency_us < 50000}>
                {formatLatency(benchResults.search_latency_us)}
              </span>
              <span class="perf-budget">budget: &lt;50ms over 50k docs</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">Graph Query</span>
              <span class="perf-value" class:pass={benchResults.graph_latency_us < 2000000}>
                {formatLatency(benchResults.graph_latency_us)}
              </span>
              <span class="perf-budget">budget: &lt;2s (5k nodes)</span>
            </div>
            <div class="perf-item">
              <span class="perf-label">Snapshot Read</span>
              <span class="perf-value">
                {formatLatency(benchResults.snapshot_latency_us)}
              </span>
            </div>
            {#if benchResults.memory_mb > 0}
            <div class="perf-item">
              <span class="perf-label">RSS Memory</span>
              <span class="perf-value" class:pass={benchResults.memory_mb < 300}>
                {benchResults.memory_mb}MB
              </span>
              <span class="perf-budget">budget: &lt;300MB (1k docs)</span>
            </div>
            {/if}
          </div>
        {/if}

        <button class="benchmark-btn" onclick={runBenchmark} disabled={benchRunning}>
          {benchRunning ? "Running..." : "Run Diagnostics"}
        </button>
        <button class="benchmark-btn" onclick={runSelfTest} disabled={selfTestRunning} title="Create, search, link, snapshot, restore and delete a throwaway doc through the live backend">
          {selfTestRunning ? "Testing..." : "Run Feature Self-Test"}
        </button>
        {#if selfTest.length > 0}
          <ul class="selftest-list">
            {#each selfTest as t}
              <li class:pass={t.pass} class:fail={!t.pass}>
                <span class="selftest-mark">{t.pass ? "✓" : "✗"}</span>
                <span class="selftest-name">{t.name}</span>
                <span class="selftest-detail">{t.detail}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      <div class="settings-section">
        <h3>App Updates</h3>
        {#if isBrowserPreview()}
          <p class="setting-desc">This browser preview updates when the site is rebuilt — there is nothing to install here. Use the desktop app for self-updates.</p>
        {:else if updateConfigured === false}
          <p class="setting-desc">Automatic updates are not configured for this install yet (no update endpoint or signing key). See <code>docs/UPDATES.md</code> for the one-time release setup.</p>
        {:else}
          {#if updateEndpoint}
            <div class="setting-row">
              <span class="setting-label">Update feed</span>
              <span class="value feed-url">{updateEndpoint}</span>
            </div>
          {/if}
          <div class="setting-row">
            <label for="setting-auto-check-updates">Check for updates on startup</label>
            <input id="setting-auto-check-updates" type="checkbox" bind:checked={$settings.autoCheckUpdates} />
          </div>
          <button class="benchmark-btn" onclick={handleCheckUpdate} disabled={updateChecking || updateDownloading}>
            {updateChecking ? "Checking…" : "Check for Updates"}
          </button>
          {#if updateError}
            <p class="update-error">{updateError}</p>
          {/if}
          {#if updateChecked && !updateInfo && !updateError}
            <p class="update-ok">You are on the latest version ({appVersion}).</p>
          {/if}
          {#if updateInfo}
            <div class="update-found">
              <div class="update-version">Version {updateInfo.version} available</div>
              {#if updateInfo.date}<div class="update-meta">Released {updateInfo.date}</div>{/if}
              {#if updateInfo.notes}<p class="update-notes">{updateInfo.notes}</p>{/if}
              {#if updateDownloading}
                <div class="update-progress"><div class="update-progress-fill" style="width: {updateProgress}%"></div></div>
                <p class="update-meta">{updateProgressLabel}</p>
              {:else}
                <button class="benchmark-btn" onclick={handleInstallUpdate}>
                  Download & Install
                </button>
                <p class="setting-desc">On Windows the app restarts itself to finish installing.</p>
              {/if}
            </div>
          {/if}
        {/if}
      </div>

      <div class="settings-section">
        <h3>Export / Import Settings</h3>
        <p class="setting-desc">Export your settings bundle (theme, keybindings, AI persona, templates) or import from a file. Secrets live in the OS keychain and are never exported; imports that smuggle them are rejected loudly.</p>
        <div class="export-import-row">
          <button class="primary-btn" onclick={exportSettingsFile}>Export Settings</button>
          <button class="secondary-btn" onclick={importSettingsFile}>Import Settings</button>
          <button class="secondary-btn" onclick={resetAllSettings}>Reset to defaults</button>
        </div>
      </div>

      <div class="settings-section danger-zone">
        <h3>Danger Zone</h3>
        <p class="setting-desc">Destructive actions. Each one asks twice — nothing here runs on a single click.</p>
        <div class="setting-row">
          <span class="setting-label">Reset all settings</span>
          {#if dangerArmed === "settings"}
            <button class="danger-btn" onclick={confirmResetSettings}>Click again to confirm reset</button>
          {:else}
            <button class="secondary-btn" onclick={() => (dangerArmed = "settings")}>Reset…</button>
          {/if}
        </div>
        {#if isBrowserPreview()}
          <div class="setting-row">
            <span class="setting-label">Erase this browser's data</span>
            {#if dangerArmed === "browser-data"}
              <button class="danger-btn" onclick={confirmClearBrowserData}>Click again to erase everything</button>
            {:else}
              <button class="secondary-btn" onclick={() => (dangerArmed = "browser-data")}>Erase…</button>
            {/if}
          </div>
          <p class="setting-desc">Clears every document, setting, and template stored in this browser, then reloads fresh.</p>
        {:else}
          <p class="setting-desc">Desktop vault data lives in your vault folder and app data — uninstalling the app removes the rest. There is no remote copy to delete.</p>
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .settings-pane {
    display: flex;
    height: 100%;
    overflow: hidden;
  }

  .settings-sidebar {
    width: 220px;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .settings-header {
    padding: 16px;
    border-bottom: 1px solid var(--border);
  }

  .settings-header h2 {
    font-size: 16px;
    font-weight: 600;
  }

  .settings-nav {
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .nav-item {
    height: 36px;
    padding: 0 12px;
    border-radius: var(--radius-md);
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: 13px;
    color: var(--text-secondary);
    text-align: left;
  }

  .nav-item:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }

  .nav-item.active {
    background: var(--bg-active);
    color: var(--accent);
  }

  .nav-icon {
    font-size: 14px;
    width: 20px;
    text-align: center;
  }

  .settings-content {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 24px;
  }

  .settings-embed {
    min-height: 0;
    display: flex;
    flex-direction: column;
  }

  .settings-section h3 {
    font-size: 16px;
    font-weight: 600;
    margin-bottom: 20px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }

  .about-logo {
    display: block;
    width: 168px;
    max-width: 60%;
    height: auto;
    margin: 4px 0 16px;
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 0;
    border-bottom: 1px solid var(--border);
  }

  .setting-row.column {
    flex-direction: column;
    align-items: stretch;
    gap: 4px;
  }

  /* Theme mode segmented control + accent picker row. */
  .segmented {
    display: inline-flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .segmented button {
    padding: 6px 16px;
    font-size: 12px;
    color: var(--text-secondary);
    background: transparent;
  }
  .segmented button + button {
    border-left: 1px solid var(--border);
  }
  .segmented button.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
  }
  .setting-row.accent-row-block {
    align-items: flex-start;
  }
  .accent-pick {
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 8px;
  }
  .swatches {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    justify-content: flex-end;
    max-width: 260px;
  }
  .swatch {
    width: 30px;
    height: 30px;
    border-radius: 50%;
    border: 2px solid transparent;
    outline: 1px solid var(--border);
    outline-offset: 2px;
    cursor: pointer;
    padding: 0;
  }
  .swatch:hover {
    transform: scale(1.1);
  }
  .swatch.active {
    outline: 2px solid var(--text-primary);
  }
  .custom-swatch {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background: var(--surface-raised);
    color: var(--text-secondary);
    font-size: 18px;
    overflow: hidden;
  }
  .custom-swatch input[type="color"] {
    position: absolute;
    inset: -8px;
    width: auto;
    height: auto;
    opacity: 0;
    cursor: pointer;
  }
  .link-btn {
    background: none;
    border: none;
    padding: 0;
    color: var(--accent-primary);
    font-size: 12px;
    cursor: pointer;
    text-decoration: underline;
  }
  .danger-zone {
    border: 1px solid var(--accent-semantic-red);
    border-radius: var(--radius-md);
    padding: 16px;
  }
  .danger-zone h3 {
    color: var(--accent-semantic-red);
  }
  .danger-btn {
    padding: 6px 16px;
    border: 1px solid var(--accent-semantic-red);
    border-radius: var(--radius-sm);
    background: var(--accent-semantic-red);
    color: #fff;
    font-size: 12px;
    cursor: pointer;
  }

  .setting-hint {
    font-size: 12px;
    color: var(--text-muted);
  }

  .ws-toggles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: 4px 12px;
    margin-top: 4px;
  }

  .ws-toggles .check-row {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
    color: var(--text-secondary);
    min-height: 32px;
    cursor: pointer;
  }

  .setting-row label,
  .setting-label {
    font-size: 13px;
    color: var(--text-primary);
  }

  .setting-row .value {
    font-size: 13px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .setting-row input[type="text"],
  .setting-row input[type="password"],
  .setting-row select {
    width: 240px;
  }

  .setting-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }

  .keybindings-list {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .keybinding-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 12px;
    border-radius: var(--radius-sm);
    background: var(--bg-surface);
    border: 1px solid var(--border);
  }

  .keybinding-row .action {
    font-size: 13px;
    color: var(--text-primary);
  }

  .keybinding-row .binding {
    font-family: var(--font-mono);
    font-size: 12px;
    color: var(--text-muted);
    padding: 2px 8px;
    background: var(--bg-primary);
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
  }

  .perf-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px;
    margin-bottom: 16px;
  }

  .perf-item {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 12px;
    border-radius: var(--radius-md);
    background: var(--bg-surface);
    border: 1px solid var(--border);
  }

  .perf-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .perf-value {
    font-size: 18px;
    font-weight: 600;
    font-family: var(--font-mono);
    color: var(--text-primary);
  }

  .perf-value.pass {
    color: var(--accent-semantic-green);
  }

  .perf-value.warn {
    color: var(--warning);
  }

  .perf-budget {
    font-size: 10px;
    color: var(--text-muted);
    font-style: italic;
  }

  .benchmark-btn {
    margin-top: 12px;
    padding: 10px 20px;
    background: var(--accent);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 13px;
    cursor: pointer;
    width: 100%;
  }

  .benchmark-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .selftest-list {
    list-style: none;
    margin: 12px 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: 12px;
  }

  .selftest-list li {
    display: flex;
    align-items: baseline;
    gap: 8px;
    padding: 6px 10px;
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
  }

  .selftest-list li.pass .selftest-mark { color: var(--success); }
  .selftest-list li.fail .selftest-mark { color: var(--error); }
  .selftest-name { font-weight: 600; }
  .selftest-detail {
    margin-left: auto;
    color: var(--text-muted);
    font-family: var(--font-mono);
    font-size: 11px;
  }

  .feed-url {
    font-family: var(--font-mono);
    font-size: 11px;
    word-break: break-all;
    text-align: right;
  }

  .update-error {
    color: var(--error);
    font-size: 12px;
    margin-top: 8px;
  }

  .update-ok {
    color: var(--success);
    font-size: 12px;
    margin-top: 8px;
  }

  .update-found {
    margin-top: 10px;
    padding: 10px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-overlay);
  }

  .update-version {
    font-weight: 600;
    font-size: 13px;
  }

  .update-meta {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }

  .update-notes {
    font-size: 12px;
    color: var(--text-secondary);
    margin-top: 6px;
    white-space: pre-wrap;
  }

  .update-progress {
    height: 6px;
    border-radius: 3px;
    background: var(--surface-pressed);
    margin-top: 8px;
    overflow: hidden;
  }

  .update-progress-fill {
    height: 100%;
    background: var(--accent);
    transition: width 0.2s;
  }

  .clear-btn {
    padding: 4px 12px;
    background: transparent;
    color: var(--error);
    border: 1px solid var(--error);
    border-radius: var(--radius-md);
    font-size: 11px;
    cursor: pointer;
  }

  .clear-btn:hover {
    background: var(--error);
    color: var(--text-primary);
  }

  .setting-desc {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin: var(--space-1) 0 var(--space-2);
  }

  .templates-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    margin-top: var(--space-2);
  }

  .template-item {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
  }

  .template-name {
    font-size: var(--font-size-sm);
    color: var(--text-primary);
    flex: 1;
  }

  .template-ws {
    font-size: 10px;
    padding: 2px 6px;
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    color: var(--text-muted);
  }

  .export-import-row {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .primary-btn {
    padding: 8px 16px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .secondary-btn {
    padding: 8px 16px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .secondary-btn:hover {
    background: var(--surface-overlay);
  }

  .range-row {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .range-row input[type="range"] {
    flex: 1;
    accent-color: var(--accent-primary);
    height: 4px;
  }
  .range-value {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    min-width: 40px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
  .settings-section h4 {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-secondary);
    margin: var(--space-4) 0 var(--space-2);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .settings-section h4:first-of-type {
    margin-top: var(--space-2);
  }
  .ui-scale-control { display: flex; align-items: center; gap: 10px; min-width: 0; }
  .ui-scale-control input[type="range"] { flex: 1; min-width: 120px; accent-color: var(--accent-primary); }
  .ui-scale-value { min-width: 3.2em; color: var(--text-secondary); font-variant-numeric: tabular-nums; text-align: right; }
  .ui-scale-reset { padding: 4px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--surface-overlay); color: var(--text-primary); cursor: pointer; }
  .ui-scale-reset:disabled { opacity: 0.45; cursor: default; }
</style>
