<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  /**
   * ReadAloudButton — thin UI over the render-ahead player.
   *
   * Desktop: one render job produces pages + a sample-accurate timeline;
   * this component maps the player's audio-clock callbacks onto the
   * original onSentence/onSection props so EditorPane / ReaderWorkspace /
   * JustWriteWorkspace keep working unchanged. Web: the browser
   * speechSynthesis sentence queue (no sidecar exists there).
   *
   * Click pauses/resumes (position held); Esc fully stops. A full stop
   * remembers the last section so the next start resumes from there (3.8).
   */
import {
  ensureTts,
  warmTts,
  getAudioContext,
  stopTtsPlayback,
  startTtsStream,
  streamTtsChunk,
  stopTtsStream,
  ttsPlaying,
  ttsError,
  ttsModelLoaded,
  ttsProbed,
  ttsStarting,
  TTS_FETCH_HINT,
  voiceShortcutLock,
} from '$lib/stores/audio';
import {
  readAloudPhase,
  readAloudProgress,
  readAloudTransport,
  readAloudUnderrun,
  resetReadAloud,
  cancelRender,
  startRender,
  subscribeRender,
  toRenderSegments,
} from '$lib/stores/readAloud';
import { segmentsForSections, segmentsForText, sentenceChunks, stripForTts, type TtsSegment } from '$lib/readerSections';
import { TtsTimelinePlayer } from '$lib/tts/player';
import { api, isBrowserPreview, type TtsRenderPageEvent } from '$lib/api';
import type { UnlistenFn } from '@tauri-apps/api/event';
import { speakBrowserText, stopBrowserSpeech, pauseBrowserSpeech, resumeBrowserSpeech, ttsSupported } from '$lib/voice';
import { settings } from '$lib/stores/settings';
import { get } from 'svelte/store';

/** Simple streaming PCM player: chunks are fed in order and played gapless
 *  via chained AudioBufferSourceNodes. */
class StreamPlayer {
  private ctx: AudioContext;
  private queue: Int16Array[] = [];
  private playing = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private onEnd: (() => void) | null = null;

  constructor(ctx: AudioContext, onEnd: (() => void) | null = null) {
    this.ctx = ctx;
    this.onEnd = onEnd;
  }

  /** Queue PCM for playback. Starts playback if not already running. */
  push(pcm: Int16Array): void {
    this.queue.push(pcm);
    if (!this.playing) {
      this.playing = true;
      void this.playNext();
    }
  }

  /** Stop playback and clear the queue. */
  stop(): void {
    this.queue = [];
    this.playing = false;
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch {}
      try { this.currentSource.disconnect(); } catch {}
      this.currentSource = null;
    }
    if (this.onEnd) {
      const cb = this.onEnd;
      this.onEnd = null;
      cb();
    }
  }

  private async playNext(): Promise<void> {
    if (this.queue.length === 0) {
      this.playing = false;
      if (this.onEnd) {
        const cb = this.onEnd;
        this.onEnd = null;
        cb();
      }
      return;
    }
    const pcm = this.queue.shift()!;
    const buffer = this.ctx.createBuffer(1, pcm.length, this.ctx.sampleRate);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    buffer.copyToChannel(f32, 0);
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    this.currentSource = source;
    source.onended = () => {
      this.sourcesDelete(source);
      void this.playNext();
    };
    source.start();
  }

  private sourcesDelete(source: AudioBufferSourceNode): void {
    this.currentSource = null;
  }
}

  let {
    getText = () => '',
    getSelection = () => '',
    getSections = undefined,
    onSection = undefined,
    onSentence = undefined,
  }: {
    getText?: () => string;
    getSelection?: () => string;
    /** Pre-split reader/editor sections; segments carry their indexes. */
    getSections?: () => { id: string; title: string; text: string }[];
    onSection?: (idx: number | null) => void;
    onSentence?: (idx: number | null, sentence: string | null) => void;
  } = $props();

  let playing = $state(false);
  let loading = $state(false);
  let paused = $state(false);
  // In-flight guard (3.3): ignore further clicks while the sidecar cold-starts.
  let starting = $state(false);
  // Section position memory (3.8): surviving a full stop, the next start
  // resumes from the last-read section instead of the top.
  let resumeSection = $state<number | null>(null);

  // ── Desktop render-ahead state ───────────────────────────────────
  let player: TtsTimelinePlayer | null = null;
  let currentRenderId: number | null = null;
  let unlisten: UnlistenFn | null = null;
  /** GLOBAL segment universe: ids stay stable across re-renders, so
   * segId always indexes this array (restarts render slices of it). */
  let allSegments: TtsSegment[] = [];
  let segIndex = $state(-1);
  let segTotal = $state(0);

  // ── Browser queue state (web preview path, unchanged semantics) ──
  let speechQueue = $state<{ section: number; text: string }[]>([]);
  let queueIndex = $state(-1);
  let activeSection = -1;
  let jumpRequested = false;
  let cancelled = false;
  // Web has no TTS sidecar: use the browser voice directly instead of
  // probing Phonon and failing first.
  const browserMode = isBrowserPreview();
  let usingBrowser = $state(false);
  // Gated only after a probe attempt: never disabled on cold boot. A gated
  // desktop button RETRIES the probe on click (same 3.2 treatment as the mic).
  let gated = $derived(browserMode ? false : $ttsProbed && !$ttsModelLoaded);
  let retryable = $derived(!browserMode && gated);

  // ── Desktop streaming state ───────────────────────────────────
  let streamId: number | null = null;
  let streamPlayer: StreamPlayer | null = null;
  let streamCancelled = false;
  let streamPlaying = false;
  // Warm-on-intent (slice 4B): ~120ms dwell on hover pre-warms Phonon
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

  let transportIndex = $derived(browserMode ? queueIndex : segIndex);
  let transportTotal = $derived(browserMode ? speechQueue.length : segTotal);
  let transportVisible = $derived(
    transportTotal > 0 && (loading || playing || paused),
  );
  let prevDisabled = $derived(transportIndex <= 0);
  let nextDisabled = $derived(transportIndex >= transportTotal - 1);

  async function handleToggle() {
    if (starting) return;
    // playing/paused first: the section flow keeps `loading` true for the
    // whole read, so a click must pause (not stop) once audio has begun.
    if (playing && !paused) {
      pausePlayback();
    } else if (paused) {
      resumePlayback();
    } else if (loading) {
      stopPlayback(); // still fetching the first page: only stop makes sense
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
        // Under render-ahead, speed is baked at render start — it applies
        // from the next render job (frontier WSOLA lands in phase 4).
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
    else {
      player?.pause();
      readAloudPhase.set("paused");
    }
  }

  function resumePlayback() {
    paused = false;
    if (usingBrowser) resumeBrowserSpeech();
    else player?.resume();
  }

  // ── Browser sentence queue (unchanged semantics) ─────────────────

  /** Speak one sentence in the browser; false when cancelled or failed. */
  async function playBrowserChunk(text: string): Promise<boolean> {
    if (cancelled) return false;
    const voice = get(settings);
    usingBrowser = true;
    playing = true;
    $ttsPlaying = true;
    try {
      await speakBrowserText(text, { langCode: voice.ttsLangCode, rate: voice.ttsSpeed });
    } catch (e) {
      if (!cancelled && !jumpRequested) $ttsError = e instanceof Error ? e.message : `TTS failed: ${e}`;
      return false;
    } finally {
      playing = false;
      $ttsPlaying = false;
      usingBrowser = false;
    }
    return !cancelled;
  }

  function makeQueue(text: string, sections?: { id: string; title: string; text: string }[] | null) {
    const source = sections?.length ? sections : [{ id: "selection", title: "Selection", text }];
    return source.flatMap((section, sectionIndex) =>
      sentenceChunks(stripForTts(section.text)).map((sentence) => ({
        section: sections?.length ? sectionIndex : -1,
        text: sentence,
      })),
    );
  }

  async function runQueue(items: { section: number; text: string }[]) {
    speechQueue = items;
    activeSection = -1;
    const resumeAt = resumeSection ?? 0;
    queueIndex = items.findIndex((item) => item.section < 0 || item.section >= resumeAt);
    if (queueIndex < 0) queueIndex = 0;
    while (!cancelled && queueIndex < speechQueue.length) {
      const currentIndex = queueIndex;
      const item = speechQueue[currentIndex];
      onSentence?.(item.section, item.text);
      if (item.section >= 0 && item.section !== activeSection) {
        activeSection = item.section;
        resumeSection = item.section;
        onSection?.(item.section);
      }
      jumpRequested = false;
      const ok = await playBrowserChunk(item.text);
      if (jumpRequested) continue;
      if (!ok || cancelled) break;
      if (queueIndex === currentIndex) queueIndex++;
    }
    if (!cancelled && queueIndex >= speechQueue.length) resumeSection = null;
    activeSection = -1;
    onSection?.(null);
    onSentence?.(null, null);
  }

  function moveSentence(delta: number) {
    if (browserMode) {
      if (!speechQueue.length || queueIndex < 0 || (!playing && !loading && !paused)) return;
      const target = Math.max(0, Math.min(speechQueue.length - 1, queueIndex + delta));
      if (target === queueIndex) return;
      queueIndex = target;
      jumpRequested = true;
      paused = false;
      const section = speechQueue[target].section;
      onSentence?.(section, speechQueue[target].text);
      if (section >= 0 && section !== activeSection) {
        activeSection = section;
        resumeSection = section;
        onSection?.(section);
      }
      stopBrowserSpeech();
      return;
    }
    // Desktop: instant seek on the timeline; restart only when the target
    // segment was never rendered (frontier) — pages themselves are never
    // evicted mid-read, so this is the only re-render path.
    if (!player || segTotal === 0 || segIndex < 0) return;
    const target = Math.max(0, Math.min(segTotal - 1, segIndex + delta));
    if (target === segIndex) return;
    paused = false;
    if (!player.seekToSegId(target)) void restartFromSegId(target);
  }

  // ── Desktop render-ahead flow ────────────────────────────────────

  function handleSegment(segId: number | null) {
    if (segId === null) {
      onSentence?.(null, null);
      onSection?.(null);
      return;
    }
    const seg = allSegments[segId];
    if (!seg) return;
    segIndex = segId;
    readAloudTransport.set({ index: segId, total: allSegments.length });
    readAloudProgress.set((segId + 1) / Math.max(1, allSegments.length));
    onSentence?.(seg.sectionIdx, seg.text);
    if (seg.sectionIdx >= 0 && seg.sectionIdx !== activeSection) {
      activeSection = seg.sectionIdx;
      resumeSection = seg.sectionIdx;
      onSection?.(seg.sectionIdx);
    }
  }

  function applyPhase(phase: 'waiting' | 'playing' | 'paused' | 'idle') {
    if (phase === 'waiting') {
      loading = true;
      readAloudPhase.set('waiting');
    } else if (phase === 'playing') {
      loading = false;
      playing = true;
      paused = false;
      readAloudPhase.set('playing');
    } else if (phase === 'paused') {
      readAloudPhase.set('paused');
    }
    // 'idle' is owned by cleanupRead/stop paths — never inferred here.
  }

  async function beginDesktopRead(renderList: TtsSegment[], universe: TtsSegment[]) {
    const s = get(settings);
    allSegments = universe;
    segTotal = universe.length;
    segIndex = -1;

    const renderId = await startRender(toRenderSegments(renderList), {
      voice: s.ttsVoice,
      speed: s.ttsSpeed,
      langCode: s.ttsLangCode,
    });
    if (cancelled) {
      void cancelRender(renderId);
      return;
    }
    currentRenderId = renderId;

    // Listeners before load: the worker needs ≥1 synthesis before its
    // first page event, so no event can outrun this registration.
    const attached = await subscribeRender(renderId, {
      onPage: (page: TtsRenderPageEvent, pcm: Int16Array) => {
        if (cancelled || !player) return;
        player.addPage(
          {
            pageIdx: page.pageIdx,
            startSample: page.startSample,
            endSample: page.endSample,
            timings: page.timings,
          },
          pcm,
        );
      },
      onDone: (totalSamples, completed) => {
        if (cancelled || !player) return;
        player.markRenderDone(totalSamples, completed);
      },
      onError: (message) => {
        if (cancelled) return;
        $ttsError = message;
        stopPlayback();
      },
    });
    if (cancelled) {
      attached();
      void cancelRender(renderId);
      return;
    }
    unlisten = attached;

    player = new TtsTimelinePlayer(getAudioContext(), {
      onSegment: (segId) => handleSegment(segId),
      onDemand: (seconds) => {
        if (currentRenderId != null) void api.ttsRenderDemand(currentRenderId, seconds).catch(() => {});
      },
      onEnd: () => {
        resumeSection = null; // natural end clears resume memory (3.8)
        finishRead();
      },
      onMissingPage: (sample) => {
        const at = player?.segIdAt(sample) ?? 0;
        void restartFromSegId(Math.max(0, at));
      },
      onUnderrun: (v) => {
        $readAloudUnderrun = v;
      },
      onPhase: (phase) => applyPhase(phase),
      // Phase 4: continuous pill % from the audio clock (segment-based
      // progress below keeps working until the render's total is known).
      onProgress: (r) => readAloudProgress.set(r),
    });
    player.load(renderId);
    $ttsPlaying = true;
    player.start(0);
  }

  /** Re-render starting at `segId` (frontier skip / evicted page). */
  async function restartFromSegId(segId: number) {
    const renderList = allSegments.slice(segId);
    if (!renderList.length || cancelled) return;
    unlisten?.();
    unlisten = null;
    void cancelRender(currentRenderId);
    currentRenderId = null;
    player?.destroy();
    player = null;
    loading = true;
    readAloudPhase.set('waiting');
    try {
      await beginDesktopRead(renderList, allSegments);
    } catch (e) {
      $ttsError = `Read-aloud failed: ${e instanceof Error ? e.message : e}`;
      cleanupRead();
    }
  }

  // ── Phase 4: live speed (WSOLA in the renderer) ────────────────────
  // Ctrl+Shift+↑/↓ nudges the speed SETTING (0.5–2.0 in 0.1 steps — the
  // slider's range). The settings subscription below pushes changes to
  // the running render job; the renderer's WSOLA applies them from the
  // frontier (≤ one page ahead) with no re-synthesis and no pitch shift.
  function onSpeedKey(e: KeyboardEvent) {
    if (!e.ctrlKey || !e.shiftKey) return;
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT")) return;
    const cur = Number(get(settings).ttsSpeed) || 1.0;
    const next = Math.min(2.0, Math.max(0.5, Math.round((cur + (e.key === "ArrowUp" ? 0.1 : -0.1)) * 10) / 10));
    if (next === cur) return;
    e.preventDefault();
    $settings.ttsSpeed = next;
  }

  onMount(() => window.addEventListener("keydown", onSpeedKey));
  onDestroy(() => window.removeEventListener("keydown", onSpeedKey));

  // One path for every speed change (slider + shortcut): push it to the
  // live job. Only $settings.ttsSpeed is reactive here — a re-run means
  // the speed itself changed; with no active render it is a no-op (the
  // next start reads the fresh settings value anyway).
  $effect(() => {
    const speed = Number($settings.ttsSpeed);
    if (browserMode || currentRenderId == null) return;
    void api.ttsRenderSetSpeed(currentRenderId, speed).catch(() => {});
  });

  /** Teardown for stop/error paths. Keeps section memory (3.8). */
  function cleanupRead() {
    unlisten?.();
    unlisten = null;
    void cancelRender(currentRenderId);
    currentRenderId = null;
    player?.destroy();
    player = null;
    loading = false;
    playing = false;
    paused = false;
    starting = false;
    $ttsPlaying = false;
    $readAloudUnderrun = false;
    resetReadAloud();
    allSegments = [];
    segIndex = -1;
    segTotal = 0;
    activeSection = -1;
  }

  /** Natural end: playhead reached the completed render's last sample. */
  function finishRead() {
    onSection?.(null);
    onSentence?.(null, null);
    cleanupRead();
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
      speechQueue = [];
      queueIndex = -1;
      loading = true;
      try {
        // Keep the reader's section boundaries for scroll-follow, then queue
        // the prose sentence by sentence.
        const sections = !selText && getSections ? getSections() : null;
        const text = selText || getText();
        if (!sections?.length && !text.trim()) return;
        await runQueue(makeQueue(text, sections));
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
    readAloudPhase.set('starting');
    try {
      const ready = await ensureTts();
      if (!ready) return;
    } finally {
      starting = false;
    }

    // Keep reader section boundaries for scroll-follow.
    const sections = !selText && getSections ? getSections() : null;
    const text = selText || getText();
    if (!sections?.length && !text.trim()) return;

    let segments = sections?.length ? segmentsForSections(sections) : segmentsForText(text);
    // Resume from the remembered section (3.8) — ids stay global.
    if (sections?.length && resumeSection != null) {
      const from = segments.findIndex((s) => s.sectionIdx >= resumeSection!);
      if (from > 0) segments = segments.slice(from);
    }
    if (!segments.length) return;

    cancelled = false;
    loading = true;
    readAloudPhase.set('waiting');
    try {
      const s = get(settings);
      const started = await startTtsStream(text, s.ttsVoice);
      if (!started) {
        $ttsError = TTS_FETCH_HINT;
        cleanupRead();
        return;
      }
      streamId = started.streamId;
      streamPlayer = new StreamPlayer(getAudioContext(), () => {
        streamPlaying = false;
        streamId = null;
        streamPlayer = null;
        if (!streamCancelled) {
          $ttsPlaying = false;
          readAloudPhase.set('idle');
          cleanupRead();
        }
      });
      loading = false;
      playing = true;
      paused = false;
      $ttsPlaying = true;
      readAloudPhase.set('playing');
      streamCancelled = false;
      streamPlaying = true;
      void streamPlayback(streamId);
    } catch (e) {
      if (!cancelled) {
        $ttsError = `Read-aloud failed: ${e instanceof Error ? e.message : e}`;
      }
      cleanupRead();
    }
  }

  async function streamPlayback(id: number) {
    while (streamPlaying && !streamCancelled && streamId === id) {
      const result = await streamTtsChunk(id);
      if (!result) break; // stream ended
      streamPlayer?.push(result.pcm);
    }
    if (!streamCancelled && streamId === id) {
      streamPlaying = false;
      streamId = null;
      streamPlayer = null;
      $ttsPlaying = false;
      readAloudPhase.set('idle');
      cleanupRead();
    }
  }

  function stopPlayback() {
    cancelled = true;
    streamCancelled = true;
    streamPlaying = false;
    onSection?.(null);
    onSentence?.(null, null);
    if (usingBrowser) stopBrowserSpeech();
    else void stopTtsPlayback().catch(() => {});
    if (streamId !== null) {
      void stopTtsStream(streamId);
      streamId = null;
    }
    streamPlayer?.stop();
    streamPlayer = null;
    loading = false;
    playing = false;
    paused = false;
    $ttsPlaying = false;
    cleanupRead();
  }

  onDestroy(() => {
    cancelled = true;
    streamCancelled = true;
    clearTimeout(warmTimer);
    if (usingBrowser) stopBrowserSpeech();
    if (streamId !== null) void stopTtsStream(streamId);
    streamPlayer?.stop();
    cleanupRead();
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
    : 'Read aloud (Phonon TTS)'}
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
    <!-- Spinner icon -->
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

{#if transportVisible}
  <div class="tts-transport" role="group" aria-label="Sentence navigation">
    <button class="transport-btn" onclick={() => moveSentence(-1)} disabled={prevDisabled} aria-label="Previous sentence" title="Previous sentence">‹</button>
    <span aria-live="polite">{transportIndex + 1} / {transportTotal}</span>
    <button class="transport-btn" onclick={() => moveSentence(1)} disabled={nextDisabled} aria-label="Next sentence" title="Next sentence">›</button>
    {#if $readAloudProgress > 0}
      <span class="tts-pct" aria-label="Read progress">{Math.round($readAloudProgress * 100)}%</span>
    {/if}
  </div>
{/if}

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
  .tts-transport {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 28px;
    padding: 0 5px;
    border: 1px solid var(--border, #333);
    border-radius: 999px;
    background: var(--surface, #1a1a1a);
    color: var(--text-muted);
    font-size: 10px;
    font-variant-numeric: tabular-nums;
  }
  .transport-btn {
    width: 20px;
    height: 22px;
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--text-primary, #eee);
    font-size: 18px;
    line-height: 1;
    cursor: pointer;
  }
  .transport-btn:disabled { opacity: 0.35; cursor: default; }
  .tts-pct {
    font-variant-numeric: tabular-nums;
    padding-left: 2px;
    border-left: 1px solid var(--border, #333);
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
    .tts-transport { height: 36px; }
    .transport-btn { height: 30px; width: 28px; }
  }
  .tts-error {
    font-size: 11px;
    color: var(--error);
    margin-top: 2px;
  }
</style>
