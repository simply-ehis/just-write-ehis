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
  ttsModelLoaded,
  ttsProbed,
  ttsStarting,
  TTS_FETCH_HINT,
} from '$lib/stores/audio';
import { chunkText } from '$lib/readerSections';

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
  // Gated only after a probe attempt: never disabled on cold boot.
  let gated = $derived($ttsProbed && !$ttsModelLoaded);

  async function handleToggle() {
    if (playing || loading) {
      stopPlayback();
    } else {
      await startPlayback();
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
    // Lazy-load sidecar on first tap
    const ready = await ensureTts();
    if (!ready) return;
    if ($ttsProbed && !$ttsModelLoaded) {
      $ttsError = TTS_FETCH_HINT;
      return;
    }

    // A live selection always wins (read exactly what is selected).
    const selected = getSelection();
    const selText = selected.trim();
    // Section flow (Reader): one call per section with highlight —
    // never the whole book in one giant call.
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
    void stopTtsPlayback();
    loading = false;
    playing = false;
    $ttsPlaying = false;
  }
</script>

<button
  class="tts-btn"
  class:playing
  class:loading
  disabled={gated}
  onclick={handleToggle}
  title={gated ? TTS_FETCH_HINT : playing || loading ? 'Stop reading aloud' : 'Read aloud (Kokoro TTS)'}
  aria-label={gated ? 'Voice model not loaded' : playing || loading ? 'Stop reading aloud' : 'Read text aloud'}
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
