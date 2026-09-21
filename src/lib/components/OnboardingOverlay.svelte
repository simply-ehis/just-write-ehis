<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import Icon from "$lib/components/Icon.svelte";

  let { onComplete }: { onComplete: () => void } = $props();

  let step = $state(0);
  let vaultPath = $state($settings.vaultPath);
  let aiEndpoint = $state($settings.smallModelEndpoint);
  let aiModel = $state($settings.smallModelName);
  let aiApiKey = $state($settings.apiKey);

  function next() {
    if (step < 3) step++;
  }

  function prev() {
    if (step > 0) step--;
  }

  function finish() {
    $settings = {
      ...$settings,
      vaultPath,
      smallModelEndpoint: aiEndpoint,
      smallModelName: aiModel,
      mainModelEndpoint: aiEndpoint,
      mainModelName: aiModel,
      apiKey: aiApiKey,
    };
    onComplete();
  }

  function skip() {
    onComplete();
  }
</script>

<div class="onboarding-overlay">
  <div class="onboarding-card">
    {#if step === 0}
      <div class="step">
        <img class="welcome-logo" src="boot-logo.png" alt="Just Write ehis logo" />
        <h1>Welcome to Just Write ehis</h1>
        <p class="step-desc">A personal writing super app. Let's get you set up.</p>
        <div class="step-actions">
          <button class="primary-btn" onclick={next}>Get Started</button>
          <button class="skip-btn" onclick={skip}>Skip Setup</button>
        </div>
      </div>

    {:else if step === 1}
      <div class="step">
        <div class="step-icon"><Icon name="folder" size={28} /></div>
        <h2>Choose Your Vault</h2>
        <p class="step-desc">Your writing vault is where all your documents live. You can change this later in Settings.</p>
        <div class="input-group">
          <label for="onboard-vault-path">Vault Path</label>
          <input id="onboard-vault-path" type="text" bind:value={vaultPath} placeholder="~/WritingVault" />
        </div>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={next}>Continue</button>
        </div>
      </div>

    {:else if step === 2}
      <div class="step">
        <div class="step-icon"><Icon name="sparkle" size={28} /></div>
        <h2>AI Provider (Optional)</h2>
        <p class="step-desc">Connect a local or remote AI model. You can skip this and set it up later.</p>
        <div class="input-group">
          <label for="onboard-endpoint">Endpoint</label>
          <input id="onboard-endpoint" type="text" bind:value={aiEndpoint} placeholder="http://localhost:11434/v1" />
        </div>
        <div class="input-group">
          <label for="onboard-model">Model Name</label>
          <input id="onboard-model" type="text" bind:value={aiModel} placeholder="llama3.2" />
        </div>
        <div class="input-group">
          <label for="onboard-apikey">API Key (if needed)</label>
          <input id="onboard-apikey" type="password" bind:value={aiApiKey} placeholder="sk-..." />
        </div>
        <div class="step-actions">
          <button class="secondary-btn" onclick={prev}>Back</button>
          <button class="primary-btn" onclick={next}>Continue</button>
          <button class="skip-btn" onclick={next}>Skip</button>
        </div>
      </div>

    {:else}
      <div class="step">
        <div class="step-icon"><Icon name="check" size={28} /></div>
        <h2>You're All Set</h2>
        <p class="step-desc">Start writing. Use <kbd>Ctrl+K</kbd> to open the command palette anytime.</p>
        <div class="tips">
          <div class="tip"><kbd>Ctrl+K</kbd> Command palette</div>
          <div class="tip"><kbd>Ctrl+J</kbd> AI panel</div>
          <div class="tip"><kbd>F11</kbd> Zen mode</div>
          <div class="tip"><kbd>Ctrl+S</kbd> Save document</div>
          <div class="tip"><kbd>Ctrl+T</kbd> Insert timestamp</div>
        </div>
        <div class="step-actions">
          <button class="primary-btn" onclick={finish}>Start Writing</button>
        </div>
      </div>
    {/if}

    <div class="step-dots">
      {#each [0, 1, 2, 3] as i}
        <span class="dot" class:active={step === i}></span>
      {/each}
    </div>
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
    z-index: 500;
  }

  .onboarding-card {
    width: 480px;
    max-width: 90vw;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.4);
    overflow: hidden;
  }

  .step {
    padding: 40px;
    text-align: center;
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

  .input-group label {
    display: block;
    font-size: 12px;
    font-weight: 500;
    color: var(--text-secondary);
    margin-bottom: 4px;
  }

  .input-group input {
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

  .input-group input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .step-actions {
    display: flex;
    gap: 8px;
    justify-content: center;
    margin-top: 24px;
  }

  .primary-btn {
    padding: 10px 24px;
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

  .tip kbd {
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
