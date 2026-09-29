<script lang="ts">
  import { settings, ONBOARD_VERSION, DEFAULT_HIDDEN_WORKSPACES } from "$lib/stores/settings";
  import { workspaces } from "$lib/stores/app";
  import { api, isBrowserPreview } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";
  import { domainError } from "$lib/errors";
  import { isWindowsRuntime } from "$lib/widgetAutostart";
  import Icon from "$lib/components/Icon.svelte";

  let { onComplete }: { onComplete: () => void } = $props();

  type UseCase = "novelist" | "notes" | "script" | "mixed";
  const USE_CASES: { id: UseCase; label: string; desc: string }[] = [
    { id: "novelist", label: "Novelist", desc: "Long-form fiction, chapters, story bible" },
    { id: "notes", label: "Notes & Journal", desc: "Daily logs, captures, personal library" },
    { id: "script", label: "Screenwriter", desc: "Fountain screenplays and projects" },
    { id: "mixed", label: "A bit of everything", desc: "Keep the default setup" },
  ];
  // Workspace ids per preset (approved). [] = keep current default behavior.
  const PRESET_TOPS: Record<UseCase, string[]> = {
    novelist: ["write", "novel", "map", "reader"],
    notes: ["write", "inbox", "properties", "canvas"],
    script: ["write", "script", "projects"],
    mixed: [],
  };
  const DEFAULT_HIDDEN = [...DEFAULT_HIDDEN_WORKSPACES];

  let step = $state(0);
  let useCase = $state<UseCase>("novelist");
  let topBarIds = $state<string[]>([...PRESET_TOPS.novelist]);
  let topBarDirty = $state(false);
  let hiddenIds = $state<string[]>([...DEFAULT_HIDDEN]);
  let theme = $state($settings.theme);
  let themeMode = $state($settings.themeMode);
  let defaultWorkspace = $state("home");
  let sttOn = $state($settings.sttEnabled);
  let ttsOn = $state($settings.ttsEnabled);
  let llmOn = $state($settings.llmEnabled);
  let vaultPath = $state($settings.vaultPath);
  let seedSample = $state(true);
  const windowsStep = isWindowsRuntime();
  const stepIndexes = windowsStep ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4];
  let smallEndpoint = $state($settings.smallModelEndpoint);
  let smallModel = $state($settings.smallModelName);
  let mainEndpoint = $state($settings.mainModelEndpoint);
  let mainModel = $state($settings.mainModelName);
  let aiApiKey = $state($settings.apiKey);
  // Snapshot for change detection: the store value above may predate the
  // OS-keychain hydration, so only write back when the user edited the field.
  const initialApiKey = $settings.apiKey;
  let logoSrc = $derived($settings.themeMode === "dark" ? "ehis-logo-light.svg" : "ehis-logo-dark.svg");

  function pickUseCase(id: UseCase) {
    useCase = id;
    if (!topBarDirty) topBarIds = [...PRESET_TOPS[id]];
  }

  function toggleTop(id: string) {
    if (topBarIds.includes(id)) {
      topBarIds = topBarIds.filter((t) => t !== id);
    } else {
      if (topBarIds.length >= 4) {
        showToast("Top bar holds up to 4 — unpin one first", "warning");
        return;
      }
      topBarIds = [...topBarIds, id];
    }
    topBarDirty = true;
  }

  function toggleHidden(id: string) {
    hiddenIds = hiddenIds.includes(id)
      ? hiddenIds.filter((h) => h !== id)
      : [...hiddenIds, id];
  }

  function next() {
    if (step < stepIndexes.length - 1) step++;
  }

  function prev() {
    if (step > 0) step--;
  }

  // Web tour tells the browser truth: ghost needs a connected model
  // endpoint here, and docs persist to this browser's localStorage.
  const TOUR_DOC = isBrowserPreview()
    ? `# Welcome to Just Write ehis

This is your Write tab — distraction-free, autosaved, yours. Here on the
web, your docs persist to this browser's localStorage.

**Three things to try right now:**
1. **Just type.** Your words save automatically as you go.
2. **Press Ctrl+K.** The command palette reaches every workspace, even hidden ones.
3. **Press Ctrl+J.** The AI panel chats, composes, and structurizes — connect a model endpoint in Settings → AI & Providers first.

Your top bar and sidebar were set up from your onboarding picks — change them
anytime in Settings → General → Replay onboarding.

Delete this doc whenever you're ready. Happy writing.
`
    : `# Welcome to Just Write ehis

This is your Write tab — distraction-free, autosaved, yours.

**Three things to try right now:**
1. **Just type.** Ghost autocomplete (local, private) offers continuations — Tab accepts.
2. **Press Ctrl+K.** The command palette reaches every workspace, even hidden ones.
3. **Press Ctrl+J.** The AI panel chats, composes, and structurizes with RAG over your vault.

Your top bar and sidebar were set up from your onboarding picks — change them
anytime in Settings → General → Replay onboarding.

Delete this doc whenever you're ready. Happy writing.
`;

  async function seedStarter() {
    try {
      await api.docCreate("write", "md", "Welcome to Just Write ehis", undefined, TOUR_DOC);
      const sample = { name: "Daily log", content: "# {{date}}\n\n## Today\n\n- \n\n## Notes\n\n", workspace: "write" };
      if (!$settings.templates.some((t) => t.name === sample.name)) {
        $settings = { ...$settings, templates: [...$settings.templates, sample] };
      }
    } catch (e) {
      domainError("Setup", "couldn't create welcome document (vault may be unwritable)", e);
    }
  }

  async function openDefaultApps() {
    try {
      await api.openDefaultApps();
    } catch (e) {
      showToast(`Couldn't open Windows Default Apps: ${e instanceof Error ? e.message : e}`, "error");
    }
  }

  async function finish() {
    $settings = {
      ...$settings,
      hasOnboarded: true,
      onboardedVersion: ONBOARD_VERSION,
      onboardSkipped: false,
      topBarIds: [...topBarIds],
      hiddenIds: [...hiddenIds],
      theme,
      themeMode,
      defaultWorkspace,
      sttEnabled: sttOn,
      ttsEnabled: ttsOn,
      llmEnabled: llmOn,
      vaultPath,
      smallModelEndpoint: smallEndpoint,
      smallModelName: smallModel,
      mainModelEndpoint: mainEndpoint,
      mainModelName: mainModel,
      apiKey: aiApiKey !== initialApiKey ? aiApiKey : $settings.apiKey,
    };
    if (seedSample) await seedStarter();
    showToast("Setup saved — change anytime in Settings", "success");
    onComplete();
  }

  function skip() {
    $settings = {
      ...$settings,
      hasOnboarded: true,
      onboardedVersion: ONBOARD_VERSION,
      onboardSkipped: true,
    };
    onComplete();
  }
</script>

<div class="onboarding-overlay">
  <div class="onboarding-card" role="dialog" aria-label="Setup">
    {#if step === 0}
      <div class="step">
        <img class="welcome-logo" src={logoSrc} alt="Just Write ehis — pen wrote 'this' with E-tick" />
        <h1>Welcome to Just Write ehis</h1>
        <p class="step-desc">A personal writing super app. Let's set it up your way — under a minute. Use <kbd>Ctrl+K</kbd> anytime to jump anywhere.</p>
        <div class="step-actions">
          <button class="primary-btn" onclick={next}>Get Started</button>
          <button class="skip-btn" onclick={skip}>Skip Setup</button>
        </div>
      </div>

    {:else if step === 1}
      <div class="step">
        <div class="step-icon"><Icon name="pencil" size={28} /></div>
        <h2>What do you mainly do?</h2>
        <p class="step-desc">This presets your top bar. You can change every pin on the next step.</p>
        <div class="pick-list" role="radiogroup" aria-label="Primary use">
          {#each USE_CASES as u}
            <button
              class="pick-card"
              class:selected={useCase === u.id}
              role="radio"
              aria-checked={useCase === u.id}
              onclick={() => pickUseCase(u.id)}
            >
              <span class="pick-label">{u.label}</span>
              <span class="pick-desc">{u.desc}</span>
            </button>
          {/each}
        </div>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={next}>Continue</button>
        </div>
      </div>

    {:else if step === 2}
      <div class="step">
        <div class="step-icon"><Icon name="pin" size={28} /></div>
        <h2>Pick your top bar</h2>
        <p class="step-desc">Pin up to 4 workspaces ({topBarIds.length}/4). Everything else lives in the grouped sidebar; hidden ones stay one Ctrl+K away.</p>
        <div class="check-grid">
          {#each workspaces.filter((w) => w.id !== "files") as w}
            <label class="check-row">
              <input type="checkbox" checked={topBarIds.includes(w.id)} onchange={() => toggleTop(w.id)} />
              <span>{w.label}</span>
              {#if topBarDirty && topBarIds.includes(w.id)}<span class="mini-tag">top</span>{/if}
            </label>
          {/each}
        </div>
        <h3 class="sub-head">Hidden from sidebar</h3>
        <div class="check-grid">
          {#each workspaces as w}
            <label class="check-row">
              <input type="checkbox" checked={hiddenIds.includes(w.id)} onchange={() => toggleHidden(w.id)} />
              <span>{w.label}</span>
            </label>
          {/each}
        </div>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={next}>Continue</button>
        </div>
      </div>

    {:else if step === 3}
      <div class="step">
        <div class="step-icon"><Icon name="sparkle" size={28} /></div>
        <h2>Make it yours</h2>
        {#if isBrowserPreview()}
          <p class="step-desc">Theme, landing tab, and voice. Here on the web, dictation and read-aloud use your browser's built-in voices — no downloads, no extra RAM.</p>
        {:else}
          <p class="step-desc">Theme, landing tab, and voice. Local voice models run on-device (heavier RAM); browser voice is used on phones.</p>
        {/if}
        <div class="input-group">
          <span class="group-label" id="onboard-theme-label">Theme style</span>
          <div class="radio-row" role="radiogroup" aria-labelledby="onboard-theme-label">
            {#each [["default", "Default"], ["brutalist", "Brutalist"], ["glass", "Glass"]] as [v, label]}
              <label class="radio-pill">
                <input type="radio" name="onboard-theme" value={v} bind:group={theme} />
                <span>{label}</span>
              </label>
            {/each}
          </div>
          <span class="group-label" id="onboard-mode-label">Light or dark</span>
          <div class="radio-row" role="radiogroup" aria-labelledby="onboard-mode-label">
            {#each [["dark", "Dark"], ["light", "Light"]] as [v, label]}
              <label class="radio-pill">
                <input type="radio" name="onboard-mode" value={v} bind:group={themeMode} />
                <span>{label}</span>
              </label>
            {/each}
          </div>
        </div>
        <div class="input-group">
          <label for="onboard-landing">Land on</label>
          <select id="onboard-landing" bind:value={defaultWorkspace}>
            <option value="home">Home</option>
            <option value="write">Write</option>
            <option value="logs">Logs</option>
            <option value="novel">Novel</option>
          </select>
        </div>
        <div class="check-grid">
          <label class="check-row">
            <input type="checkbox" bind:checked={sttOn} />
            <span>Voice dictation (mic)</span>
          </label>
          <label class="check-row">
            <input type="checkbox" bind:checked={ttsOn} />
            <span>Read aloud</span>
          </label>
          <label class="check-row">
            <input type="checkbox" bind:checked={llmOn} />
            {#if isBrowserPreview()}
              <span>Ghost autocomplete (needs a model endpoint)</span>
            {:else}
              <span>Local ghost autocomplete</span>
            {/if}
          </label>
        </div>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={next}>Continue</button>
        </div>
      </div>

    {:else if step === 4 && windowsStep}
      <div class="step">
        <div class="step-icon"><Icon name="folder" size={28} /></div>
        <h2>Open your writing from Windows</h2>
        <p class="step-desc">The Windows installer registers .txt and .md with Just Write ehis. Open with routes files into your vault; a second launch hands off to the running window instead of starting another copy.</p>
        <div class="integration-list">
          <div class="integration-item"><strong>File associations</strong><span>Use Explorer’s Open with menu after installation.</span></div>
          <div class="integration-item"><strong>Default Apps</strong><span>Windows decides which editor is default; Just Write ehis never forces the choice.</span></div>
          <div class="integration-item"><strong>Startup</strong><span>Enable the companion widget first, then choose whether it should start with Windows.</span></div>
        </div>
        <button class="secondary-btn" onclick={openDefaultApps}>Open Windows Default Apps</button>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={next}>Continue</button>
        </div>
      </div>

    {:else}
      <div class="step">
        <div class="step-icon"><Icon name="folder" size={28} /></div>
        <h2>Vault & AI (optional)</h2>
        <p class="step-desc">Where your writing lives, plus models. Small serves ghost + light tasks; main serves chat, Composer, Structurize. Skip freely — set up later in Settings.</p>
        {#if isBrowserPreview()}
          <p class="step-desc">On the web your vault lives in this browser's localStorage, and AI slots talk to HTTP model endpoints you configure below. There are no bundled local models here — those ship with the desktop app.</p>
        {:else}
          <div class="input-group">
            <label for="onboard-vault-path">Vault Path</label>
            <input id="onboard-vault-path" type="text" value={vaultPath} readonly />
            <p class="setting-desc">The desktop vault is managed automatically at ~/WritingVault. Custom vault migration is not available yet.</p>
          </div>
        {/if}
        <label class="check-row seed-row">
          <input type="checkbox" bind:checked={seedSample} />
          <span>Seed a guided-tour doc + starter template</span>
        </label>
        {#if !isBrowserPreview()}
          <div class="input-group">
            <label for="onboard-small-endpoint">Small model endpoint</label>
            <input id="onboard-small-endpoint" type="text" bind:value={smallEndpoint} placeholder="http://127.0.0.1:8093/v1" />
          </div>
          <div class="input-group">
            <label for="onboard-small-model">Small model name</label>
            <input id="onboard-small-model" type="text" bind:value={smallModel} placeholder="lfm2.5-350m" />
          </div>
        {/if}
        <div class="input-group">
          <label for="onboard-endpoint">Main model endpoint</label>
          <input id="onboard-endpoint" type="text" bind:value={mainEndpoint} placeholder="https://api.openai.com/v1" />
        </div>
        <div class="input-group">
          <label for="onboard-model">Main model name</label>
          <input id="onboard-model" type="text" bind:value={mainModel} placeholder="gpt-4o-mini" />
        </div>
        <div class="input-group">
          <label for="onboard-apikey">API Key (if needed)</label>
          <input id="onboard-apikey" type="password" bind:value={aiApiKey} placeholder="sk-..." />
        </div>
        <div class="tips">
          <div class="tip"><kbd>Ctrl+K</kbd> Command palette</div>
          <div class="tip"><kbd>Ctrl+J</kbd> AI panel</div>
          <div class="tip"><kbd>F11</kbd> Zen mode</div>
        </div>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={finish}>Start Writing</button>
          <button class="skip-btn" onclick={skip}>Skip</button>
        </div>
      </div>
    {/if}

    <div class="step-dots" aria-label="Setup progress">
      {#each stepIndexes as i}
        <span class="dot" class:active={step === i}></span>
      {/each}
    </div>
    <p class="step-count">Step {step + 1} of {stepIndexes.length}</p>
  </div>
</div>

<style>
  .onboarding-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 600;
  }

  .onboarding-card {
    width: 480px;
    max-width: 90vw;
    max-height: 90dvh;
    overflow-y: auto;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    overflow-x: hidden;
  }

  .step {
    padding: 40px;
    text-align: center;
  }

  @media (max-width: 480px) {
    .step {
      padding: 24px;
    }
  }

  .step-icon {
    font-size: 48px;
    margin-bottom: 16px;
  }

  .welcome-logo {
    height: 72px;
    width: auto;
    margin-bottom: 16px;
  }

  .step h1, .step h2 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
    margin: 0 0 8px;
    color: var(--text-primary);
  }

  .sub-head {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-secondary);
    text-align: left;
    margin: 20px 0 8px;
  }

  .step-desc {
    font-size: var(--font-size-sm);
    color: var(--text-muted);
    margin: 0 0 24px;
    line-height: var(--line-height-relaxed);
  }

  .input-group {
    text-align: left;
    margin-bottom: 16px;
  }

  .input-group label, .group-label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .input-group input, .input-group select {
    width: 100%;
    height: 40px;
    padding: 0 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
    font-family: var(--font-mono);
  }

  .input-group input:focus, .input-group select:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .pick-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 8px;
  }

  .pick-card {
    display: flex;
    flex-direction: column;
    gap: 2px;
    align-items: flex-start;
    text-align: left;
    padding: 12px 14px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-base);
    cursor: pointer;
  }

  .pick-card.selected {
    border-color: var(--accent-primary);
    background: var(--surface-overlay);
  }

  .pick-label {
    font-size: var(--font-size-sm);
    font-weight: 600;
    color: var(--text-primary);
  }

  .pick-desc {
    font-size: 12px;
    color: var(--text-muted);
  }

  .check-grid {
    display: flex;
    flex-direction: column;
    gap: 6px;
    text-align: left;
  }

  .integration-list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0 0 18px;
    text-align: left;
  }

  .integration-item {
    display: flex;
    flex-direction: column;
    gap: 3px;
    padding: 10px 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
  }

  .integration-item strong {
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .integration-item span {
    color: var(--text-muted);
    font-size: 12px;
  }

  .check-row {
    display: flex;
    align-items: center;
    gap: 10px;
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    min-height: 40px;
  }

  .check-row input[type="checkbox"] {
    width: 18px;
    height: 18px;
    accent-color: var(--accent-primary);
    flex-shrink: 0;
  }

  .seed-row {
    margin-bottom: 16px;
  }

  .mini-tag {
    margin-left: auto;
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent-primary);
  }

  .radio-row {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }

  .radio-pill {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 8px 14px;
    min-height: 44px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    cursor: pointer;
  }

  .radio-pill:has(input:checked) {
    border-color: var(--accent-primary);
    color: var(--text-primary);
  }

  .radio-pill input {
    accent-color: var(--accent-primary);
  }

  .step-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    justify-content: center;
    margin-top: 24px;
  }

  .primary-btn {
    padding: 10px 24px;
    min-height: 44px;
    border: none;
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: var(--font-size-sm);
    font-weight: 600;
    cursor: pointer;
  }

  .primary-btn:hover {
    opacity: 0.9;
  }

  .secondary-btn {
    padding: 10px 24px;
    min-height: 44px;
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

  .skip-btn {
    padding: 10px 24px;
    min-height: 44px;
    border: none;
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .skip-btn:hover {
    color: var(--text-secondary);
  }

  .tips {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 16px 0;
    text-align: left;
  }

  .tip {
    font-size: var(--font-size-sm);
    color: var(--text-secondary);
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .tip kbd, .step-desc kbd {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 60px;
    padding: 2px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: 4px;
    background: var(--surface-base);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }

  .step-dots {
    display: flex;
    justify-content: center;
    gap: 8px;
    padding: 0 0 8px;
  }

  .step-count {
    text-align: center;
    font-size: 11px;
    color: var(--text-muted);
    margin: 0;
    padding: 0 0 20px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--border-subtle);
  }

  .dot.active {
    background: var(--accent-primary);
  }
</style>
