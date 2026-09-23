<script lang="ts">
  import { onMount } from "svelte";
  import { settings, settingsCategory, DEFAULT_HIDDEN_WORKSPACES, SECRET_KEYS, resetSettings, type SettingsCategory } from "$lib/stores/settings";
  import { validateSettings, clampNumber } from "$lib/settingsValidate";
  import { workspaces } from "$lib/stores/app";
  import { api, isBrowserPreview } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";
  import { checkForUpdate, downloadAndInstall, getAppVersion, relaunchApp, type UpdateInfo } from "$lib/updates";
  import { testProvider, type ProviderTestResult } from "$lib/providerTest";
  import BackupManager from "./BackupManager.svelte";
  import Icon from "$lib/components/Icon.svelte";
  import LazyWorkspace from "./LazyWorkspace.svelte";
  import { stopStt, stopTts, stopLlm } from "$lib/stores/audio";
  import { validateLlmModel, validatePythonPath, validateSttModel, validateTtsModel } from "$lib/sidecarValidate";
  import { stopHarness } from "$lib/memorySidecar";
  import { pinCaptureNotification } from "$lib/launch";

  // Export setup probe (Settings → About): surfaces pandoc presence +
  // bundled-vs-PATH so menus, errors, and docs agree (see docs/EXPORT.md).
  let exportStatus = $state<{ pandoc: boolean; bundled: boolean; formats: string[] } | null>(null);
  let exportProbing = $state(false);

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

  // Sidecar input validation: shape-checked on blur with inline errors
  // (existence/shape at start still fails closed server-side — see
  // sidecar.rs ManagedSidecar + the python _resolve_model guards).
  let pythonError = $state<string | null>(null);
  let sttModelError = $state<string | null>(null);
  let ttsModelError = $state<string | null>(null);
  let llmModelError = $state<string | null>(null);
  let pythonProbeToken = 0;

  async function probePythonPath() {
    pythonError = validatePythonPath($settings.pythonPath);
    if (pythonError || isBrowserPreview()) return;
    const token = ++pythonProbeToken;
    try {
      const version = await api.sidecarPythonProbe($settings.pythonPath.trim() || "python");
      if (token === pythonProbeToken) pythonError = null;
      showToast(`Python OK: ${version}`, "success");
    } catch (e) {
      if (token === pythonProbeToken) {
        pythonError = e instanceof Error ? e.message : String(e);
      }
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
  let aboutLogo = $derived($settings.theme === "dark" || $settings.theme === "glass" ? "ehis-logo-light.svg" : "ehis-logo-dark.svg");

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
  let appVersion = $state("0.2.1");
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

  async function testSlot(slot: "small" | "main") {
    testingSlot = slot;
    try {
      const endpoint = slot === "small" ? $settings.smallModelEndpoint : $settings.mainModelEndpoint;
      const model = slot === "small" ? $settings.smallModelName : $settings.mainModelName;
      slotResults = { ...slotResults, [slot]: await testProvider(endpoint, model) };
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
          settings.set({ ...$settings, ...report.valid });
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

  /** Reset to defaults, then (re)start the file watcher to match. */
  async function resetAllSettings() {
    resetSettings();
    if (!isBrowserPreview()) {
      try {
        await api.setupFileWatcher();
      } catch (e) {
        console.warn("File watcher restart after reset failed:", e);
      }
    }
    showToast("Settings reset to defaults", "success");
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
    { id: "about", label: "About & Diagnostics", icon: "info" },
  ];

  onMount(() => {
    coldStartTime = performance.now();
    getAppVersion("0.2.1").then((v) => (appVersion = v));
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
      updateError = String(e instanceof Error ? e.message : e);
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
    } catch (e) {
      console.error("Benchmark failed:", e);
      benchResults = null;
    } finally {
      benchRunning = false;
    }
  }

  function formatLatency(us: number): string {
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
    await check("Lock excludes from search + AI", async () => {
      await api.docSetLocked(docId, true);
      const hits = await api.docSearchFull(`self-test ${stamp}`);
      if (hits.some((h) => h.doc.id === docId)) throw new Error("locked doc visible in search");
      const ctx = await api.getWorkspaceContext(docId, "write");
      if (ctx.trim()) throw new Error("locked doc leaked into AI context");
      await api.docSetLocked(docId, false);
      return "excluded ok";
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
          <label for="setting-theme">Theme</label>
          <select id="setting-theme" bind:value={$settings.theme}>
            <option value="dark">Dark</option>
            <option value="light">Light</option>
            <option value="brutalist">Brutalist</option>
            <option value="glass">Glass</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-icon-set">Icon Set</label>
          <select id="setting-icon-set" bind:value={$settings.iconSet}>
            <option value="phosphor">Phosphor</option>
            <option value="tabler">Tabler</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-streak-goal">Daily Streak Goal (words)</label>
          <input id="setting-streak-goal" type="number" bind:value={$settings.streakGoal} min="0" max="10000" onblur={() => clampSettingKey("streakGoal")} />
        </div>
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
          <input id="setting-font-size" type="number" bind:value={$settings.fontSize} min="10" max="32" onblur={() => clampSettingKey("fontSize")} />
        </div>
        <div class="setting-row">
          <label for="setting-line-height">Line Height</label>
          <input id="setting-line-height" type="number" bind:value={$settings.lineHeight} min="1.0" max="3.0" step="0.1" onblur={() => clampSettingKey("lineHeight")} />
        </div>
        <div class="setting-row">
          <label for="setting-font-family">Editor Font</label>
          <select id="setting-font-family" bind:value={$settings.fontFamily}>
            <option value="JetBrains Mono">JetBrains Mono</option>
            <option value="Fira Code">Fira Code</option>
            <option value="Source Code Pro">Source Code Pro</option>
            <option value="IBM Plex Mono">IBM Plex Mono</option>
            <option value="Cascadia Code">Cascadia Code</option>
            <option value="Consolas">Consolas</option>
            <option value="monospace">System Default</option>
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
        <div class="setting-row">
          <label for="setting-small-model-endpoint">Small Model Endpoint</label>
          <input id="setting-small-model-endpoint" type="text" bind:value={$settings.smallModelEndpoint} placeholder="http://127.0.0.1:8093/v1" />
        </div>
        <div class="setting-row">
          <label for="setting-small-model-name">Small Model Name</label>
          <input id="setting-small-model-name" type="text" bind:value={$settings.smallModelName} placeholder="lfm2.5-350m" />
        </div>
        <p class="setting-desc">Light-task picks: the bundled local endpoint by default — or any OpenAI-compatible endpoint (OpenAI, Google, Anthropic via gateway, Custom). See docs/MODELS.md.</p>
        <div class="setting-row">
          <label for="setting-small-model-ctx">Small Model Context Length</label>
          <input id="setting-small-model-ctx" type="number" min="1024" max="131072" step="1024" bind:value={$settings.smallModelContextLength} onblur={() => clampSettingKey("smallModelContextLength")} />
        </div>
        <p class="setting-desc">llama-server <code>--ctx-size</code> for the bundled model (default 8192). Takes effect on the next sidecar start — restart the small model to apply.</p>
        <div class="setting-row">
          <label for="setting-use-small-as-main">Use Small Model as Main</label>
          <input id="setting-use-small-as-main" type="checkbox" bind:checked={$settings.useSmallAsMain} />
        </div>
        <p class="setting-desc">Route the AI panel's chat, Composer, and Structurize at the small model instead of the main slot. Ghost routing is unchanged (local :8093 if enabled, else small slot).</p>
        <div class="setting-row">
          <label for="setting-main-model-endpoint">Main Model Endpoint</label>
          <input id="setting-main-model-endpoint" type="text" bind:value={$settings.mainModelEndpoint} placeholder="https://api.openai.com/v1" />
        </div>
        <div class="setting-row">
          <label for="setting-main-model-name">Main Model Name</label>
          <input id="setting-main-model-name" type="text" bind:value={$settings.mainModelName} placeholder="gpt-4o-mini" />
        </div>
        <p class="setting-desc">Main-slot picks: <code>OpenAI</code> · <code>Google (Gemini)</code> · <code>Anthropic (via gateway)</code> · <code>Custom</code> OpenAI-compatible endpoint. Paste endpoint + model, add the key below, then Test. See docs/MODELS.md.</p>
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
          <label for="setting-harness-dir">Sidecar Harness Directory</label>
          <input id="setting-harness-dir" type="text" bind:value={$settings.sidecarHarnessDir} placeholder="Directory containing the harness repo" />
        </div>
        <p class="setting-desc">Used by the AI panel's Small Model toggle. Needs a harness checkout exposing a <code>server</code> module — leave empty and the toggle explains instead of failing silently.</p>
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
        <h3>AI Persona (soul.md)</h3>
        <p class="setting-desc">Define your AI's personality, style, and values. This is injected into every AI call.</p>
        <textarea
          class="persona-textarea"
          bind:value={$settings.aiPersona}
          placeholder="You are a terse, direct writing partner. You favor brevity over politeness. You challenge weak prose. You never apologize for having opinions..."
          rows="8"
        ></textarea>
      </div>

      <div class="settings-section">
        <h3>Voice — STT & TTS</h3>
        <p class="setting-desc">Moonshine-base GGUF via transcribe.cpp for speech-to-text, Kokoro v1.0 (sherpa-onnx) for text-to-speech. Models lazy-load on first use. Torch-free, fully offline.</p>

        <h4>Speech-to-Text (Moonshine-base GGUF)</h4>
        <div class="setting-row">
          <label for="setting-stt-enabled">STT Enabled</label>
          <input id="setting-stt-enabled" type="checkbox" bind:checked={$settings.sttEnabled} onchange={onSttToggle} />
        </div>
        <div class="setting-row">
          <label for="setting-stt-model">STT Model</label>
          <input id="setting-stt-model" type="text" bind:value={$settings.sttModel} placeholder="bundled moonshine-base-Q8_0.gguf" onblur={() => (sttModelError = validateSttModel($settings.sttModel))} />
        </div>
        {#if sttModelError}
          <p class="update-error">{sttModelError}</p>
        {/if}
        <p class="setting-desc">Paste to swap: a local <code>.gguf</code> path or a <code>models/</code> filename. Empty = bundled default. Takes effect on next sidecar start.</p>

        <h4>Text-to-Speech (Kokoro-82M)</h4>
        <div class="setting-row">
          <label for="setting-tts-enabled">TTS Enabled</label>
          <input id="setting-tts-enabled" type="checkbox" bind:checked={$settings.ttsEnabled} onchange={onTtsToggle} />
        </div>
        <div class="setting-row">
          <label for="setting-tts-model">TTS Weights Repo</label>
          <input id="setting-tts-model" type="text" bind:value={$settings.ttsModel} placeholder="vendored kokoro-multi-lang-v1_0" onblur={() => (ttsModelError = validateTtsModel($settings.ttsModel))} />
        </div>
        {#if ttsModelError}
          <p class="update-error">{ttsModelError}</p>
        {/if}
        <p class="setting-desc">Paste to swap: a local Kokoro bundle directory (model.onnx + voices.bin + tokens.txt + espeak-ng-data). Empty = vendored default. Takes effect on next sidecar start.</p>
        <div class="setting-row">
          <label for="setting-tts-lang-code">Language</label>
          <select id="setting-tts-lang-code" bind:value={$settings.ttsLangCode} onchange={(e) => {
            // Auto-select first voice of new language
            const lang = (e.target as HTMLSelectElement).value;
            const defaultVoices: Record<string, string> = {
              a: 'af_heart', b: 'bf_emma', j: 'jf_alpha', z: 'zf_xiaobei',
              e: 'ef_dora', f: 'ff_siwis', h: 'hf_alpha', i: 'if_sara',
              p: 'pf_dora',
            };
            $settings = { ...$settings, ttsLangCode: lang, ttsVoice: defaultVoices[lang] || 'af_heart' };
          }}>
            <option value="a">American English</option>
            <option value="b">British English</option>
            <option value="j">Japanese</option>
            <option value="z">Mandarin Chinese</option>
            <option value="e">Spanish</option>
            <option value="f">French</option>
            <option value="h">Hindi</option>
            <option value="i">Italian</option>
            <option value="p">Portuguese</option>
          </select>
        </div>
        <div class="setting-row">
          <label for="setting-tts-voice">Voice</label>
          <select id="setting-tts-voice" bind:value={$settings.ttsVoice}>
            {#if $settings.ttsLangCode === 'a'}
              <option value="af_heart">Heart — female, warm (default)</option>
              <option value="af_bella">Bella — female, confident</option>
              <option value="af_nicole">Nicole — female, soft</option>
              <option value="af_sarah">Sarah — female, clear</option>
              <option value="af_sky">Sky — female, bright</option>
              <option value="am_adam">Adam — male, deep</option>
              <option value="am_michael">Michael — male, neutral</option>
            {:else if $settings.ttsLangCode === 'b'}
              <option value="bf_emma">Emma — female, refined</option>
              <option value="bm_george">George — male, formal</option>
              <option value="bm_lewis">Lewis — male, casual</option>
            {:else if $settings.ttsLangCode === 'j'}
              <option value="jf_alpha">Alpha — female</option>
              <option value="jm_kumo">Kumo — male</option>
            {:else if $settings.ttsLangCode === 'z'}
              <option value="zf_xiaobei">Xiaobei — female</option>
              <option value="zf_xiaoni">Xiaoni — female</option>
              <option value="zm_yunjian">Yunjian — male</option>
            {:else if $settings.ttsLangCode === 'e'}
              <option value="ef_dora">Dora — female</option>
              <option value="em_alex">Alex — male</option>
            {:else if $settings.ttsLangCode === 'f'}
              <option value="ff_siwis">Siwis — female</option>
            {:else if $settings.ttsLangCode === 'h'}
              <option value="hf_alpha">Alpha — female</option>
              <option value="hm_omega">Omega — male</option>
            {:else if $settings.ttsLangCode === 'i'}
              <option value="if_sara">Sara — female</option>
              <option value="im_nicola">Nicola — male</option>
            {:else if $settings.ttsLangCode === 'p'}
              <option value="pf_dora">Dora — female</option>
              <option value="pm_alex">Alex — male</option>
            {/if}
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
            <span class="range-value">{$settings.ttsSpeed.toFixed(1)}x</span>
          </div>
          <p class="setting-desc">0.5x = slow, 1.0x = normal, 2.0x = fast</p>
        </div>
        <div class="setting-row">
          <label for="setting-tts-chunk-size">Chunk Size (tokens)</label>
          <div class="range-row">
            <input
              id="setting-tts-chunk-size"
              type="range"
              min="50"
              max="500"
              step="10"
              bind:value={$settings.ttsChunkSize}
            />
            <span class="range-value">{$settings.ttsChunkSize}</span>
          </div>
          <p class="setting-desc">Max tokens per audio chunk. Lower = more sentence breaks, higher = smoother flow.</p>
        </div>
        <div class="setting-row">
          <label for="setting-tts-split-pattern">Split Pattern (regex)</label>
          <input id="setting-tts-split-pattern" type="text" bind:value={$settings.ttsSplitPattern} placeholder="\\n+" />
          <p class="setting-desc">Regex for splitting text before chunking. Default: double newline.</p>
        </div>

        <h4>Local LLM (LFM 2.5-350M via llama.cpp)</h4>
        <div class="setting-row">
          <label for="setting-llm-enabled">LLM Enabled</label>
          <input id="setting-llm-enabled" type="checkbox" bind:checked={$settings.llmEnabled} onchange={onLlmToggle} />
        </div>
        <div class="setting-row">
          <label for="setting-llm-model">LLM Model</label>
          <input id="setting-llm-model" type="text" bind:value={$settings.llmModel} placeholder="bundled lfm2.5-350m-q4_k_m.gguf" onblur={() => (llmModelError = validateLlmModel($settings.llmModel))} />
        </div>
        {#if llmModelError}
          <p class="update-error">{llmModelError}</p>
        {/if}
        <p class="setting-desc">Paste to swap: a local <code>.gguf</code> path or a <code>models/</code> filename. Empty = bundled default. Takes effect on next sidecar start.</p>

        <h4>System</h4>
        <div class="setting-row">
          <label for="setting-python-path">Python Path</label>
          <input id="setting-python-path" type="text" bind:value={$settings.pythonPath} placeholder="python" onblur={probePythonPath} />
        </div>
        {#if pythonError}
          <p class="update-error">{pythonError}</p>
        {/if}
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
          <label for="setting-lock-enabled">Document Locking</label>
          <input id="setting-lock-enabled" type="checkbox" bind:checked={$settings.lockEnabled} />
        </div>
        <p class="setting-desc">Master switch. Off = no PIN gates, no lock menus, locked docs stop being excluded from AI/search. Locked flags stay stored and apply again if re-enabled.</p>
        {#if $settings.lockEnabled}
          <div class="setting-row">
            <label for="setting-app-lock-pin">App Lock PIN</label>
            <input id="setting-app-lock-pin" type="password" bind:value={$settings.appLockPin} placeholder="Set PIN..." />
          </div>
          <div class="setting-row">
            <label for="remove-app-lock-pin">Remove PIN</label>
            <button
              id="remove-app-lock-pin"
              class="clear-btn"
              disabled={!$settings.appLockPin}
              onclick={() => { $settings = { ...$settings, appLockPin: "" }; }}
            >Remove</button>
          </div>
          <p class="setting-desc">Type a new PIN to change it — it saves automatically and syncs to the OS keychain. Removing the PIN unlocks nothing by itself; clear per-doc locks from each doc.</p>
        {/if}
        <div class="setting-row">
          <label for="setting-craft-profiling-enabled">Craft analytics recording</label>
          <input id="setting-craft-profiling-enabled" type="checkbox" bind:checked={$settings.craftProfilingEnabled} />
        </div>
        <p class="setting-desc">Off by default. When on, saves record dialogue/sentence/filter-word snapshots (max once a minute per doc) that power Craft charts and the filter-word tip.</p>
      </div>
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
        <p class="setting-desc">When enabled, workspace content is never sent to external API providers — local model only.</p>
        {#each ["logs", "write", "novel", "script", "projects", "reader", "map", "inbox"] as ws}
          <div class="setting-row">
            <label for="setting-ws-privacy-{ws}">{ws.charAt(0).toUpperCase() + ws.slice(1)}</label>
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
          <span class="value">{$settings.vaultPath}</span>
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
          <input id="setting-snapshot-retention-days" type="number" bind:value={$settings.snapshotRetentionDays} min="7" max="365" onblur={() => clampSettingKey("snapshotRetentionDays")} />
        </div>
        <BackupManager />
      </div>

    {:else if activeCategory === "capture"}
      <div class="settings-section">
        <h3>Capture & Notifications</h3>
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
          <p class="setting-desc">Tapping it opens the Inbox capture box. Needs the installed PWA (or the Android app); a home-screen widget needs the native shell and isn't available in the browser.</p>
        {:else if $settings.androidCaptureMethod === "share-target"}
          <p class="setting-desc">Share Target is live: with the PWA installed, Android's share sheet sends text and links straight into the Inbox capture box.</p>
        {:else}
          <p class="setting-desc">Widgets need the native Android shell (Tauri mobile) — not available in the browser preview. Use Notification or Share Target for now.</p>
        {/if}
        <div class="setting-row">
          <label for="setting-weekly-triage-reminder">Weekly Triage Reminder</label>
          <input id="setting-weekly-triage-reminder" type="checkbox" bind:checked={$settings.weeklyTriageReminder} />
        </div>
        <div class="setting-row">
          <label for="setting-streak-reminder">Streak Reminder</label>
          <input id="setting-streak-reminder" type="checkbox" bind:checked={$settings.streakReminder} />
        </div>
        <div class="setting-row">
          <label for="setting-logs-stamp-place">Stamp location & weather on new daily notes</label>
          <input id="setting-logs-stamp-place" type="checkbox" bind:checked={$settings.logsStampPlace} />
        </div>
      </div>

    {:else if activeCategory === "skills"}
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./SkillsPage.svelte")} label="Tips" />
      </div>

    {:else if activeCategory === "craft"}
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./CraftPage.svelte")} label="Craft" />
      </div>

    {:else if activeCategory === "stats"}
      <div class="settings-embed">
        <LazyWorkspace loader={() => import("./UsageMemory.svelte")} label="Usage" />
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

    {:else if activeCategory === "about"}
      <div class="settings-section">
        <img class="about-logo" src={aboutLogo} alt="Just Write ehis — pen wrote 'this' with E-tick" />
        <h3>About & Diagnostics</h3>
        <div class="setting-row">
          <span class="setting-label">Version</span>
          <span class="value">{appVersion}</span>
        </div>
        <div class="setting-row">
          <span class="setting-label">Vault Path</span>
          <span class="value">{$settings.vaultPath}</span>
        </div>

        <h3>Export setup</h3>
        <div class="setting-row">
          <span class="setting-label">Pandoc (.docx/.epub/.pdf)</span>
          <span class="value">{exportStatus == null ? "…" : exportStatus.pandoc ? (exportStatus.bundled ? "bundled ✓" : "found on PATH ✓") : "missing"}</span>
          <button class="clear-btn" onclick={probeExportSetup} disabled={exportProbing}>
            {exportProbing ? "Probing…" : "Probe"}
          </button>
        </div>
        {#if exportStatus != null && !exportStatus.pandoc}
          <p class="setting-desc">Word/eBook/PDF export needs pandoc: install it (`winget install pandoc` / `brew install pandoc`) and press Probe. PDF additionally needs a PDF engine (LaTeX, Typst, or WeasyPrint) — pandoc reports the missing piece verbatim on failure.</p>
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
  .setting-row input[type="number"],
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

  .persona-textarea {
    width: 100%;
    min-height: 120px;
    padding: var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    line-height: var(--line-height-relaxed);
    resize: vertical;
    margin-top: var(--space-2);
  }

  .persona-textarea:focus {
    outline: none;
    border-color: var(--accent-primary);
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
</style>
