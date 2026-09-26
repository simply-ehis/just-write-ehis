<script lang="ts">
  import { onDestroy } from "svelte";
  /**
   * ReadAloudButton — Kokoro-82M TTS on desktop, browser voice on web.
   * Reads selected text (or entire doc) aloud.
   * Lazy-loads TTS sidecar on first tap (A7.6).
   */
import {
  ensureTts,
  synthesizeText,
  playWavBase64,
   stopTtsPlayback,
   stopWavPlayback,
   ttsPlaying,
  ttsError,
  ttsModelLoaded,
  ttsProbed,
  ttsStarting,
  TTS_FETCH_HINT,
} from '$lib/stores/audio';
import { chunkText, stripForTts } from '$lib/readerSections';
import { isBrowserPreview } from '$lib/api';
import { speakBrowserText, stopBrowserSpeech, ttsSupported } from '$lib/voice';
import { settings } from '$lib/stores/settings';
import { get } from 'svelte/store';

  let {
    getText = () => '',
    getSelection = () => '',
    getSections = undefined,
    onSection = undefined,
  }: {
    getText?: () => string;
    getSelection?: () => string;
    /** Section flow (Reader): pre-split {id,title,text} — played one at a
     * time with per-section highlight instead of one giant call. */
    getSections?: () => { id: string; title: string; text: string }[];
    onSection?: (idx: number | null) => void;
  } = $props();

  let playing = $state(false);
  let loading = $state(false);
  let cancelled = false;
  // Web has no TTS sidecar: use the browser voice directly instead of
  // probing Kokoro and failing first.
  const browserMode = isBrowserPreview();
  let usingBrowser = $state(false);
  // Gated only after a probe attempt: never disabled on cold boot.
  let gated = $derived(browserMode ? false : $ttsProbed && !$ttsModelLoaded);

  async function handleToggle() {
    if (playing || loading) {
      stopPlayback();
    } else {
      await startPlayback();
    }
  }

  /** Speak one browser chunk; false when cancelled or failed. */
  async function playBrowserChunk(text: string): Promise<boolean> {
    if (cancelled) return false;
    const voice = get(settings);
    usingBrowser = true;
    playing = true;
    $ttsPlaying = true;
    try {
      await speakBrowserText(text, { langCode: voice.ttsLangCode, rate: voice.ttsSpeed });
    } catch (e) {
      if (!cancelled) $ttsError = e instanceof Error ? e.message : `TTS failed: ${e}`;
      return false;
    } finally {
      playing = false;
      $ttsPlaying = false;
      usingBrowser = false;
    }
    return !cancelled;
  }

  /** Speak markdown-free chunks sequentially; false when cancelled. */
  async function playBrowserTexts(texts: string[]): Promise<void> {
    for (const text of texts) {
      if (cancelled) break;
      for (const chunk of chunkText(stripForTts(text))) {
        if (!(await playBrowserChunk(chunk))) break;
      }
    }
  }

  /** Synthesize + play one chunk; false when cancelled or failed. */
  async function playChunk(text: string): Promise<boolean> {
    if (cancelled) return false;
    const result = await synthesizeText(text);
    if (cancelled || !result) return false;
    playing = true;
    $ttsPlaying = true;
    try {
      await playWavBase64(result.audio);
    } finally {
      playing = false;
      $ttsPlaying = false;
    }
    return !cancelled;
  }

  async function startPlayback() {
    // A live selection always wins (read exactly what is selected).
    const selected = getSelection();
    const selText = selected.trim();

    if (browserMode) {
      if (!ttsSupported()) {
        $ttsError = "Read-aloud is not supported in this browser.";
        return;
      }
      cancelled = false;
      loading = true;
      $ttsError = null;
      try {
        // Section flow (Reader): one utterance per section with highlight —
        // never the whole book in one giant call.
        const sections = !selText && getSections ? getSections().filter((s) => s.text.trim()) : null;
        if (sections && sections.length > 0) {
          for (let i = 0; i < sections.length; i++) {
            if (cancelled) break;
            onSection?.(i);
            await playBrowserTexts([sections[i].text]);
          }
          onSection?.(null);
        } else {
          // Legacy single-shot path (editors without sections).
          const text = selText || getText();
          if (!text.trim()) return;
          loading = false;
          await playBrowserTexts([text]);
        }
      } catch (e) {
        if (!cancelled) $ttsError = e instanceof Error ? e.message : `TTS failed: ${e}`;
      } finally {
        loading = false;
        playing = false;
        $ttsPlaying = false;
        onSection?.(null);
      }
      return;
    }

    // Lazy-load sidecar on first tap
    const ready = await ensureTts();
    if (!ready) return;
    // Section flow (Reader): one call per section with highlight.
    const sections = !selText && getSections ? getSections().filter((s) => s.text.trim()) : null;

    cancelled = false;
    loading = true;
    $ttsError = null;

    try {
      if (sections && sections.length > 0) {
        for (let i = 0; i < sections.length; i++) {
          if (cancelled) break;
          onSection?.(i);
          for (const chunk of chunkText(sections[i].text)) {
            if (!(await playChunk(chunk))) break;
          }
        }
        onSection?.(null);
      } else {
        // Legacy single-shot path (editors without sections).
        const text = selText || getText();
        if (!text.trim()) return;
        loading = false;
        await playChunk(text);
      }
    } catch (e) {
      $ttsError = `TTS failed: ${e}`;
    } finally {
      loading = false;
      playing = false;
      $ttsPlaying = false;
      onSection?.(null);
    }
  }

  function stopPlayback() {
    cancelled = true;
    onSection?.(null);
    if (usingBrowser) stopBrowserSpeech();
    else void stopTtsPlayback();
    loading = false;
    playing = false;
     $ttsPlaying = false;
   }

   onDestroy(() => {
    cancelled = true;
    if (usingBrowser) stopBrowserSpeech();
    else stopWavPlayback();
    playing = false;
    loading = false;
    $ttsPlaying = false;
  });
</script>

<button
  class="tts-btn"
  class:playing
  class:loading
  disabled={gated}
  onclick={handleToggle}
  title={gated ? TTS_FETCH_HINT : playing || loading ? 'Stop reading aloud' : browserMode ? 'Read aloud (browser voice)' : 'Read aloud (Kokoro TTS)'}
  aria-label={gated ? 'Voice model not loaded' : playing || loading ? 'Stop reading aloud' : browserMode ? 'Read text aloud with the browser voice' : 'Read text aloud'}
>
  {#if playing}
    <!-- Stop icon (audio live; spinner shows while fetching instead) -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
    </svg>
  {:else if loading}
    <svg width="16" height="16" viewBox="0 0 16 16" class="spinner">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="20 12" />
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

{#if $ttsStarting && !playing && !loading}
  <div class="tts-progress">{$ttsStarting}</div>
{/if}
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
    background: var(--accent-semantic-blue);
    color: var(--text-on-accent);
    border-color: var(--accent-semantic-blue);
  }
  .tts-btn.loading {
    opacity: 0.6;
    cursor: wait;
  }
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .tts-progress {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  @media (max-width: 480px) {
    .tts-btn {
      width: 44px;
      height: 44px;
    }
  }
  .tts-error {
    font-size: 11px;
    color: var(--error);
    margin-top: 2px;
  }
</style>
