<script lang="ts">
  /**
   * ReadAloudButton — Kokoro-82M TTS.
   * Reads selected text (or entire doc) aloud.
   * Lazy-loads TTS sidecar on first tap (A7.6).
   */
import {
  ensureTts,
  synthesizeText,
  playWavBase64,
  stopTtsPlayback,
  ttsPlaying,
  ttsError,
} from '$lib/stores/audio';

  let {
    getText = () => '',
    getSelection = () => '',
  }: {
    getText?: () => string;
    getSelection?: () => string;
  } = $props();

  let playing = $state(false);
  let currentAudio: HTMLAudioElement | null = null;

  async function handleToggle() {
    if (playing) {
      stopPlayback();
    } else {
      await startPlayback();
    }
  }

  async function startPlayback() {
    // Lazy-load sidecar on first tap
    const ready = await ensureTts();
    if (!ready) return;

    // Get text: selection first, fallback to full doc
    const selected = getSelection();
    const text = selected.trim() || getText();
    if (!text.trim()) return;

    playing = true;
    $ttsPlaying = true;
    $ttsError = null;

    try {
      const result = await synthesizeText(text);
      if (!result) {
        playing = false;
        $ttsPlaying = false;
        return;
      }

      // Play the base64 WAV
      await playWavBase64(result.audio);
    } catch (e) {
      $ttsError = `TTS failed: ${e}`;
    } finally {
      playing = false;
      $ttsPlaying = false;
    }
  }

  function stopPlayback() {
    playWavBase64('').catch(() => {});
    stopTtsPlayback();
    playing = false;
    $ttsPlaying = false;
  }
</script>

<button
  class="tts-btn"
  class:playing
  onclick={handleToggle}
  title={playing ? 'Stop reading aloud' : 'Read aloud (Kokoro TTS)'}
  aria-label={playing ? 'Stop reading aloud' : 'Read text aloud'}
>
  {#if playing}
    <!-- Stop icon -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
    </svg>
  {:else}
    <!-- Speaker icon -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M3 6h2.5L9 3v10L5.5 10H3a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      <path d="M11 5.5a3.5 3.5 0 0 1 0 5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <path d="M12.5 4a6 6 0 0 1 0 8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  {/if}
</button>

{#if $ttsError}
  <div class="tts-error">{$ttsError}</div>
{/if}

<style>
  .tts-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    background: var(--surface, #1a1a1a);
    color: var(--text, #ccc);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s, color 0.15s;
  }
  .tts-btn:hover {
    background: var(--surface-hover, #2a2a2a);
  }
  .tts-btn.playing {
    background: #2563eb;
    color: white;
    border-color: #2563eb;
  }
  .tts-error {
    font-size: 11px;
    color: #dc2626;
    margin-top: 2px;
  }
</style>
