<script lang="ts">
  /**
   * QuickCaptureInput — the single capture box for Inbox + Logs.
   * Text input with Enter-to-save, sidecar mic when enabled, and an
   * opt-in Web Speech fallback (Inbox/PWA). The destination differs per
   * caller (Inbox creates a snippet, Logs appends a timestamp block), so
   * saving stays with the parent via onSubmit; everything else lives here.
   */
  import { onMount, onDestroy } from "svelte";
  import { settings } from "$lib/stores/settings";
  import { showToast } from "$lib/stores/notifications";
  import { voiceSupported, startDictation, type VoiceHandle } from "$lib/voice";
  import MicButton from "$lib/components/MicButton.svelte";
  import Icon from "$lib/components/Icon.svelte";

  let {
    value = $bindable(""),
    placeholder = "Quick capture... (Enter to save)",
    disabled = false,
    webFallback = false,
    inputRef = $bindable<HTMLInputElement | null>(null),
    onSubmit,
  }: {
    value?: string;
    placeholder?: string;
    disabled?: boolean;
    webFallback?: boolean;
    inputRef?: HTMLInputElement | null;
    onSubmit: () => void;
  } = $props();

  let webVoiceAvailable = $state(false);
  let voiceActive = $state(false);
  let voiceHandle: VoiceHandle | null = null;
  let voiceBase = "";

  function appendTranscribed(text: string) {
    value = (value ? value + " " : "") + text;
  }

  function toggleVoice() {
    if (voiceActive) {
      voiceHandle?.stop();
      voiceHandle = null;
      voiceActive = false;
      return;
    }
    try {
      voiceBase = value ? value + " " : "";
      value = voiceBase;
      voiceHandle = startDictation(
        (text, isFinal) => {
          if (isFinal) {
            voiceBase = voiceBase + text + " ";
            value = voiceBase;
          } else {
            value = voiceBase + text;
          }
        },
        (reason) => showToast(reason, "warning"),
      );
      voiceActive = true;
    } catch {
      showToast("Voice input isn't supported in this browser.", "warning");
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      onSubmit();
    }
  }

  onMount(() => {
    webVoiceAvailable = voiceSupported();
  });

  onDestroy(() => {
    voiceHandle?.stop();
    voiceHandle = null;
  });
</script>

<div class="quick-capture">
  {#if $settings.sttEnabled}
    <MicButton onTranscribe={appendTranscribed} />
  {:else if webFallback && webVoiceAvailable}
    <button
      class="voice-btn"
      class:active={voiceActive}
      onclick={toggleVoice}
      title={voiceActive ? "Stop dictation" : "Dictate (browser speech recognition)"}
      aria-label={voiceActive ? "Stop dictation" : "Dictate with voice"}
      aria-pressed={voiceActive}
    >
      <Icon name="mic" size={16} />
    </button>
  {/if}
  <input
    bind:this={inputRef}
    bind:value
    onkeydown={handleKeydown}
    {placeholder}
    aria-label="Quick capture text"
    {disabled}
  />
  <button class="capture-btn" onclick={onSubmit} disabled={disabled || !value.trim()} aria-label="Save capture">
    +
  </button>
</div>

<style>
  .quick-capture {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .quick-capture input {
    flex: 1;
    height: 36px;
    min-height: 36px;
    padding: 0 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: var(--font-size-sm);
  }

  .quick-capture input:focus {
    outline: none;
    border-color: var(--accent-primary);
  }

  .capture-btn {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: 18px;
    cursor: pointer;
  }

  .capture-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .capture-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .voice-btn {
    width: 36px;
    height: 36px;
    flex-shrink: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
  }

  .voice-btn.active {
    border-color: var(--accent-semantic-red);
    color: var(--accent-semantic-red);
  }

  @media (max-width: 480px) {
    .quick-capture input,
    .capture-btn,
    .voice-btn {
      min-height: 44px;
    }
    .capture-btn,
    .voice-btn {
      min-width: 44px;
    }
  }
</style>
