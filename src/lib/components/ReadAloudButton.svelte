<script lang="ts">
  import { onDestroy } from "svelte";
  /**
   * ReadAloudButton — Kokoro-82M TTS on desktop, browser voice on web.
   * Reads selected text (or entire doc) aloud.
   * Lazy-loads TTS sidecar on first tap (A7.6).
   * Click pauses/resumes (position held); Esc fully stops. A full stop
   * remembers the last section so the next start resumes from there (3.8).
   */
import {
  ensureTts,
  warmTts,
  synthesizeText,
  playWavBase64,
   stopTtsPlayback,
   stopWavPlayback,
   pauseWavPlayback,
   resumeWavPlayback,
  ttsPlaying,
  ttsError,
  ttsModelLoaded,
  ttsProbed,
  ttsStarting,
  TTS_FETCH_HINT,
  voiceShortcutLock,
} from '$lib/stores/audio';
import { chunkText, stripForTts } from '$lib/readerSections';
import { isBrowserPreview } from '$lib/api';
import { speakBrowserText, stopBrowserSpeech, pauseBrowserSpeech, resumeBrowserSpeech, ttsSupported } from '$lib/voice';
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
  let paused = $state(false);
  // In-flight guard (3.3): ignore further clicks while the sidecar cold-starts.
  let starting = $state(false);
  // Section position memory (3.8): surviving a full stop, the next start
  // resumes from the last-read section instead of the top.
  let resumeSection = $state<number | null>(null);
  let cancelled = false;
  // Web has no TTS sidecar: use the browser voice directly instead of
  // probing Kokoro and failing first.
  const browserMode = isBrowserPreview();
  let usingBrowser = $state(false);
  // Gated only after a probe attempt: never disabled on cold boot. A gated
  // desktop button RETRIES the probe on click (same 3.2 treatment as the mic).
  let gated = $derived(browserMode ? false : $ttsProbed && !$ttsModelLoaded);
  let retryable = $derived(!browserMode && gated);
  // Warm-on-intent (slice 4B): ~120ms dwell on hover pre-warms Kokoro
  // (incl. silent first synthesis). Cancelled on pointerleave.
  let warmTimer: ReturnType<typeof setTimeout> | undefined;
  function onIntentEnter() {
    if (browserMode || playing || loading || starting) return;
    clearTimeout(warmTimer);
    warmTimer = setTimeout(() => { void warmTts(); }, 120);
  }
  function onIntentLeave() {
    clearTimeout(warmTimer);
  }

  async function handleToggle() {
    if (starting) return;
    // playing/paused first: the section flow keeps `loading` true for the
    // whole read, so a click must pause (not stop) once audio has begun.
    if (playing && !paused) {
      pausePlayback();
    } else if (paused) {
      resumePlayback();
    } else if (loading) {
      stopPlayback(); // still fetching the first chunk: only stop makes sense
    } else {
      await startPlayback();
    }
  }

  /** Esc while reading: full stop (keeps section memory).
   * Ctrl+Shift+A: global read-aloud toggle; Ctrl+Shift+Up/Down: speed ±. */
  function onKeydown(e: KeyboardEvent) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.shiftKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      const cur = get(settings).ttsSpeed;
      const next = Math.min(4, Math.max(0.25, Math.round((cur + (e.key === "ArrowUp" ? 0.1 : -0.1)) * 10) / 10));
      if (next !== cur) {
        e.preventDefault();
        settings.update((s) => ({ ...s, ttsSpeed: next }));
      }
      return;
    }
    if (mod && e.shiftKey && (e.key === "a" || e.key === "A")) {
      if (gated && browserMode) return;
      if (Date.now() - voiceShortcutLock.tts < 100) return;
      voiceShortcutLock.tts = Date.now();
      e.preventDefault();
      void handleToggle();
      return;
    }
    if (e.key !== "Escape") return;
    if (playing || loading || paused) {
      e.preventDefault();
      stopPlayback();
    }
  }

  function pausePlayback() {
    paused = true;
    if (usingBrowser) pauseBrowserSpeech();
    else pauseWavPlayback();
  }

  function resumePlayback() {
    paused = false;
    if (usingBrowser) resumeBrowserSpeech();
    else resumeWavPlayback();
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
    if (starting || playing || loading) return;
    // A live selection always wins (read exactly what is selected).
    const selected = getSelection();
    const selText = selected.trim();
    paused = false;
    $ttsError = null;

    if (browserMode) {
      if (!ttsSupported()) {
        $ttsError = "Read-aloud is not supported in this browser.";
        return;
      }
      cancelled = false;
      loading = true;
      try {
        // Section flow (Reader): one utterance per section with highlight —
        // never the whole book in one giant call.
        const sections = !selText && getSections ? getSections().filter((s) => s.text.trim()) : null;
        if (sections && sections.length > 0) {
          const startAt = selText ? 0 : Math.min(resumeSection ?? 0, sections.length - 1);
          for (let i = startAt; i < sections.length; i++) {
            if (cancelled) break;
            resumeSection = i;
            onSection?.(i);
            await playBrowserTexts([sections[i].text]);
          }
          if (!cancelled) resumeSection = null;
          onSection?.(null);
        } else {
          // Legacy single-shot path (editors without sections).
          const text = selText || getText();
          if (!text.trim()) return;
          loading = false;
          await playBrowserTexts([text]);
        }
      } catch (e) {
        if (!cancelled) $ttsError = e instanceof Error ? e.message : `Read-aloud failed: ${e}`;
      } finally {
        loading = false;
        playing = false;
        paused = false;
        $ttsPlaying = false;
        onSection?.(null);
      }
      return;
    }

    // Lazy-load sidecar on first tap (also the gated-retry path).
    starting = true;
    try {
      const ready = await ensureTts();
      if (!ready) return;
    } finally {
      starting = false;
    }
    // Section flow (Reader): one call per section with highlight.
    const sections = !selText && getSections ? getSections().filter((s) => s.text.trim()) : null;

    cancelled = false;
    loading = true;
    $ttsError = null;

    try {
      if (sections && sections.length > 0) {
        const startAt = selText ? 0 : Math.min(resumeSection ?? 0, sections.length - 1);
        for (let i = startAt; i < sections.length; i++) {
          if (cancelled) break;
          resumeSection = i;
          onSection?.(i);
          for (const chunk of chunkText(sections[i].text)) {
            if (!(await playChunk(chunk))) break;
          }
        }
        if (!cancelled) resumeSection = null;
        onSection?.(null);
      } else {
        // Legacy single-shot path (editors without sections).
        const text = selText || getText();
        if (!text.trim()) return;
        loading = false;
        await playChunk(text);
      }
    } catch (e) {
      $ttsError = `Read-aloud failed: ${e instanceof Error ? e.message : e}`;
    } finally {
      loading = false;
      playing = false;
      paused = false;
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
    paused = false;
     $ttsPlaying = false;
   }

   onDestroy(() => {
    cancelled = true;
    if (usingBrowser) stopBrowserSpeech();
    else stopWavPlayback();
    playing = false;
    loading = false;
    paused = false;
    $ttsPlaying = false;
    clearTimeout(warmTimer);
  });
</script>

<svelte:window onkeydown={onKeydown} />

<button
  class="tts-btn"
  class:playing
  class:loading
  class:paused
  disabled={gated && !retryable}
  onclick={handleToggle}
  onpointerenter={onIntentEnter}
  onpointerleave={onIntentLeave}
  title={gated
    ? `${TTS_FETCH_HINT} Click to retry.`
    : starting ? 'Starting read-aloud…'
    : loading ? 'Loading… (click to stop)'
    : paused ? 'Resume reading (Esc stops)'
    : playing ? 'Pause reading (Esc stops)'
    : browserMode ? 'Read aloud (browser voice)'
    : 'Read aloud (Kokoro TTS)'}
  aria-label={gated
    ? 'Retry voice model'
    : starting ? 'Starting read-aloud'
    : paused ? 'Resume reading aloud'
    : playing || loading ? 'Pause reading aloud' : browserMode ? 'Read text aloud with the browser voice' : 'Read text aloud'}
>
  {#if paused}
    <!-- Play icon (resume) -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M5 3l8 5-8 5V3z" fill="currentColor" />
    </svg>
  {:else if playing}
    <!-- Pause icon (click pauses; Esc stops) -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <rect x="4" y="3" width="3" height="10" rx="1" fill="currentColor" />
      <rect x="9" y="3" width="3" height="10" rx="1" fill="currentColor" />
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
  <div class="tts-error" role="alert">{$ttsError}</div>
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
  .tts-btn.playing,
  .tts-btn.paused {
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
