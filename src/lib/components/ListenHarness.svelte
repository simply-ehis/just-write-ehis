/**
 * ListenHarness — desktop manual listen-test page for the render-ahead
 * TTS pipeline (gaps / mid-page skips / speed changes).
 *
 * It drives the SAME primitives as ReadAloudButton (ensureTts →
 * startRender → subscribeRender → TtsTimelinePlayer → ttsRenderDemand),
 * but against a generated 3-section test text (~45 numbered sentences →
 * several 45 s pages) and with QA controls instead of a pill:
 *
 *  - Gaps: every boundary silence (sentence 220 / paragraph 480 /
 *    section 600 ms) is measured from the received SegmentTiming chain
 *    and compared to the expected value; page joins are flagged so the
 *    cross-boundary gaps are individually verifiable (both by ear and
 *    by number: a clean join adds exactly 0 samples).
 *  - Mid-page skips: ±5 s seeks land inside received pages; seeks past
 *    the frontier take the real re-render path (onMissingPage).
 *  - Speed: 0.75/1.0/1.25/1.5 re-render the job from the current
 *    segment through the renderer's `speed` param (phase-4 WSOLA is the
 *    live-rate future — this exercises today's contract).
 *
 * Desktop-only (needs the Kokoro sidecar); in browser preview it mounts
 * with transport disabled so the layout/pins still exist. Opened from
 * the command palette ("TTS listen harness (dev)") or `?listen-harness=1`.
 */
<script lang="ts">
  import { onDestroy, onMount } from "svelte";
  import { get } from "svelte/store";
  import {
    ensureTts,
    getAudioContext,
    ttsPlaying,
  } from "$lib/stores/audio";
  import {
    PAUSE_MS,
    cancelRender,
    resetReadAloud,
    startRender,
    subscribeRender,
    toRenderSegments,
  } from "$lib/stores/readAloud";
  import { segmentsForSections, type TtsSegment } from "$lib/readerSections";
  import { TtsTimelinePlayer, RENDER_SAMPLE_RATE, type PageMeta, type SegmentTiming } from "$lib/tts/player";
  import { auditGaps, type GapRow } from "$lib/tts/boundaryAudit";
  import { api, isBrowserPreview, type TtsRenderPageEvent } from "$lib/api";
  import { settings } from "$lib/stores/settings";
  import { listenHarnessOpen } from "$lib/stores/devHarness";
  import type { UnlistenFn } from "@tauri-apps/api/event";
  import Icon from "$lib/components/Icon.svelte";

  type Phase = "idle" | "starting" | "waiting" | "playing" | "paused";
  type Preflight = "idle" | "checking" | "ready" | "error";

  const browserMode = isBrowserPreview();
  const SPEEDS = [0.75, 1.0, 1.25, 1.5];

  let preflight = $state<Preflight>("idle");
  let preflightMsg = $state("");
  let phase = $state<Phase>("idle");
  let renderId = $state<number | null>(null);
  let segIndex = $state(-1);
  let speed = $state(1.0);
  let playheadS = $state(0);
  let receivedS = $state(0);
  let underruns = $state(0);
  let missingPages = $state(0);
  let restarts = $state(0);
  let gapRows = $state<GapRow[]>([]);
  let gapContiguous = $state(true);
  let errorLine = $state("");
  let log = $state<{ t: string; msg: string }[]>([]);
  let warnActiveRead = $state(false);

  // Engine state: `segments` is UI-visible (status/derived text) so it
  // is $state; `player` stays a plain ref — $state would proxy the live
  // class — with `engineOn` mirroring its presence for the template.
  let segments = $state<TtsSegment[]>([]);
  let player: TtsTimelinePlayer | null = null;
  let engineOn = $state(false);
  let unlisten: UnlistenFn | null = null;
  let pageMetas: PageMeta[] = [];
  let ticker: ReturnType<typeof setInterval> | null = null;

  let currentText = $derived(segIndex >= 0 ? (segments[segIndex]?.text ?? "") : "");
  let gapOk = $derived(gapRows.filter((r) => r.ok).length);
  let gapBad = $derived(gapRows.length - gapOk);
  let busy = $derived(phase === "starting" || phase === "waiting" || phase === "playing");
  let transportDisabled = $derived(browserMode || preflight === "checking");

  /** ~45 numbered sentences across 3 sections/paragraphs — long enough
   * to cross several 45 s page joins while every boundary is audible. */
  const FILLER =
    "The harbor light stayed on until the ferry cleared the point, and the radio kept counting minutes in a calm, unhurried voice.";
  function buildHarnessSections(): { text: string }[] {
    const out: { text: string }[] = [];
    for (let s = 1; s <= 3; s++) {
      const paras: string[] = [];
      for (let p = 1; p <= 3; p++) {
        const sents: string[] = [];
        for (let n = 1; n <= 5; n++) {
          sents.push(`Section ${s}, paragraph ${p}, sentence ${n}. ${FILLER}`);
        }
        paras.push(sents.join(" "));
      }
      out.push({ text: paras.join("\n\n") });
    }
    return out;
  }

  function stamp(): string {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
  }
  function note(msg: string): void {
    log = [{ t: stamp(), msg }, ...log].slice(0, 25);
  }

  function recomputeGaps(): void {
    const all: SegmentTiming[] = pageMetas.flatMap((p) => p.timings);
    const audit = auditGaps({
      timings: all,
      classOf: (id) => segments[id]?.pauseAfter ?? "sentence",
      pauseMs: PAUSE_MS,
      sampleRate: RENDER_SAMPLE_RATE,
      pageRanges: pageMetas.map((p) => ({ startSample: p.startSample, endSample: p.endSample })),
    });
    gapRows = audit.rows;
    gapContiguous = audit.contiguous;
  }

  // ── Desktop render-ahead flow (mirrors ReadAloudButton) ────────────

  async function beginRender(fromSeg: number, rate: number): Promise<void> {
    const renderList = segments.slice(fromSeg);
    if (!renderList.length) return;
    const s = get(settings);
    const id = await startRender(toRenderSegments(renderList), {
      voice: s.ttsVoice,
      speed: rate,
      langCode: s.ttsLangCode,
    });
    renderId = id;
    note(`render #${id} from seg ${fromSeg} @ ${rate}×`);

    const attached = await subscribeRender(id, {
      onPage: (page: TtsRenderPageEvent, pcm: Int16Array) => {
        player?.addPage(
          { pageIdx: page.pageIdx, startSample: page.startSample, endSample: page.endSample, timings: page.timings },
          pcm,
        );
        pageMetas = [...pageMetas, { pageIdx: page.pageIdx, startSample: page.startSample, endSample: page.endSample, timings: page.timings }];
        recomputeGaps();
      },
      onDone: (totalSamples, completed) => {
        note(`render done (completed=${completed}, ${Math.round(totalSamples / RENDER_SAMPLE_RATE)}s)`);
        player?.markRenderDone(totalSamples, completed);
      },
      onError: (message) => {
        errorLine = message;
        note(`render error: ${message}`);
        stopAll();
      },
    });
    unlisten = attached;

    player = new TtsTimelinePlayer(getAudioContext(), {
      onSegment: (segId) => {
        segIndex = segId ?? -1;
      },
      onDemand: (seconds) => {
        if (renderId != null) void api.ttsRenderDemand(renderId, seconds).catch(() => {});
      },
      onEnd: () => {
        note("reached end of render");
        stopAll();
      },
      onMissingPage: (sample) => {
        missingPages++;
        const at = player?.segIdAt(sample) ?? 0;
        note(`missing page @ sample ${sample} → re-render from seg ${Math.max(0, at)}`);
        void restartFrom(Math.max(0, at));
      },
      onUnderrun: (v) => {
        if (v) underruns++;
        note(v ? "underrun hold (catching up)" : "underrun resumed");
      },
      onPhase: (p) => {
        phase = p === "idle" ? "idle" : (p as Phase);
      },
    });
    player.load(id);
    player.start(0);
    engineOn = true;
  }

  /** Re-render starting at `segId` (speed change / frontier skip). */
  async function restartFrom(fromSeg: number): Promise<void> {
    unlisten?.();
    unlisten = null;
    void cancelRender(renderId);
    renderId = null;
    player?.destroy();
    player = null;
    engineOn = false;
    restarts++;
    phase = "waiting";
    try {
      await beginRender(fromSeg, speed);
    } catch (e) {
      errorLine = `Render failed: ${e instanceof Error ? e.message : e}`;
      stopAll();
    }
  }

  /** Full teardown: transport + render job + stores. */
  function stopAll(): void {
    unlisten?.();
    unlisten = null;
    void cancelRender(renderId);
    renderId = null;
    player?.destroy();
    player = null;
    engineOn = false;
    phase = "idle";
    segIndex = -1;
    pageMetas = [];
    recomputeGaps();
    resetReadAloud();
  }

  async function start(): Promise<void> {
    if (phase !== "idle" || transportDisabled) return;
    errorLine = "";
    warnActiveRead = get(ttsPlaying) === true;
    if (preflight !== "ready") {
      preflight = "checking";
      let ready = false;
      try {
        ready = await ensureTts();
      } catch (e) {
        preflightMsg = e instanceof Error ? e.message : String(e);
      }
      preflight = ready ? "ready" : "error";
      if (!ready) {
        if (!preflightMsg) preflightMsg = "Kokoro did not come up — check Settings → Voice.";
        return;
      }
    }
    segments = segmentsForSections(buildHarnessSections());
    segIndex = -1;
    pageMetas = [];
    underruns = 0;
    missingPages = 0;
    restarts = 0;
    recomputeGaps();
    phase = "starting";
    note(`start: ${segments.length} segments, speed ${speed}×`);
    try {
      await beginRender(0, speed);
    } catch (e) {
      errorLine = `Render failed: ${e instanceof Error ? e.message : e}`;
      phase = "idle";
    }
  }

  function togglePause(): void {
    if (!player) return;
    if (phase === "playing" || phase === "waiting") {
      player.pause();
      note("paused");
    } else if (phase === "paused") {
      player.resume();
      note("resumed");
    }
  }

  function moveSeg(delta: number): void {
    if (!player || segments.length === 0) return;
    const base = segIndex < 0 ? 0 : segIndex;
    const target = Math.max(0, Math.min(segments.length - 1, base + delta));
    if (target === segIndex) return;
    note(`segment jump → ${target} (${target > segIndex ? "next" : "prev"})`);
    if (!player.seekToSegId(target)) {
      note(`seg ${target} not rendered yet → re-render there`);
      void restartFrom(target);
    }
  }

  /** Mid-page skip: land `seconds` from the playhead, inside received
   * audio when possible; past the frontier the player's onMissingPage
   * takes the real re-render path. */
  function seekBy(seconds: number): void {
    if (!player) return;
    const frontier = player.receivedEndSamples();
    if (frontier <= 0) return;
    const target = Math.max(0, Math.min(frontier - 1, player.playheadNow() + Math.round(seconds * RENDER_SAMPLE_RATE)));
    note(`mid-page seek ${seconds > 0 ? "+" : ""}${seconds}s → sample ${target}`);
    player.seek(target);
  }

  /** Seek to the start of the next segment that ENDS with `klass` pause
   * — so the boundary silence itself plays and can be judged by ear. */
  function seekToNextPause(klass: "paragraph" | "section"): void {
    if (!player) return;
    const next = segments.findIndex((sg, i) => i > segIndex && sg.pauseAfter === klass);
    if (next < 0) {
      note(`no further ${klass} pause in the test text`);
      return;
    }
    note(`probe → ${klass} pause at seg ${next}`);
    if (!player.seekToSegId(next)) void restartFrom(next);
  }

  async function setSpeed(v: number): Promise<void> {
    if (v === speed) return;
    speed = v;
    if (player && phase !== "idle") {
      note(`speed ${v}× → re-render from seg ${Math.max(0, segIndex)}`);
      await restartFrom(Math.max(0, segIndex));
    }
  }

  function close(): void {
    stopAll();
    listenHarnessOpen.set(false);
  }

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    }
  }

  onMount(() => {
    ticker = setInterval(() => {
      if (!player) return;
      playheadS = player.playheadNow() / RENDER_SAMPLE_RATE;
      receivedS = player.receivedEndSamples() / RENDER_SAMPLE_RATE;
    }, 150);
  });

  onDestroy(() => {
    if (ticker) clearInterval(ticker);
    unlisten?.();
    void cancelRender(renderId);
    player?.destroy();
    resetReadAloud();
  });
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions: QA overlay — Esc closes, all controls are real buttons. -->
<div class="listen-harness" role="dialog" aria-label="TTS listen harness" onkeydown={handleKeydown} tabindex="-1">
  <header class="lh-header">
    <span class="lh-title"><Icon name="speaker" size={16} /> TTS listen harness <em>(dev)</em></span>
    <span class="lh-sub">manual pass: gaps · mid-page skips · speed</span>
    <button class="icon-btn lh-close" onclick={close} title="Close (Esc)" aria-label="Close listen harness"><Icon name="x" size={14} /></button>
  </header>

  {#if browserMode}
    <div class="lh-banner">Desktop-only: the Kokoro sidecar is unavailable in the browser preview — transport is disabled. Run <code>npm run tauri dev</code> and reopen the harness from the command palette.</div>
  {/if}
  {#if warnActiveRead}
    <div class="lh-banner">A read-aloud pill is currently playing — both would share the audio device. Stop it first for a clean listen.</div>
  {/if}
  {#if errorLine}
    <div class="lh-banner lh-error">{errorLine}</div>
  {/if}

  <section class="lh-row">
    <button class="lh-btn primary" onclick={start} disabled={transportDisabled || phase !== "idle"}>Start</button>
    <button class="lh-btn" onclick={togglePause} disabled={phase !== "playing" && phase !== "waiting" && phase !== "paused"}>
      {phase === "paused" ? "Resume" : "Pause"}
    </button>
    <button class="lh-btn" onclick={stopAll} disabled={phase === "idle"}>Stop</button>
    <span class="lh-sep"></span>
    <button class="lh-btn" onclick={() => moveSeg(-1)} disabled={!engineOn}>◀ sentence</button>
    <button class="lh-btn" onclick={() => moveSeg(1)} disabled={!engineOn}>sentence ▶</button>
    <span class="lh-sep"></span>
    <button class="lh-btn" onclick={() => seekBy(-5)} disabled={!engineOn}>−5s (mid-page)</button>
    <button class="lh-btn" onclick={() => seekBy(5)} disabled={!engineOn}>+5s (mid-page)</button>
    <span class="lh-sep"></span>
    <button class="lh-btn" onclick={() => seekToNextPause("paragraph")} disabled={!engineOn}>▶ next paragraph pause</button>
    <button class="lh-btn" onclick={() => seekToNextPause("section")} disabled={!engineOn}>▶ next section pause</button>
  </section>

  <section class="lh-row">
    <span class="lh-label">speed (re-renders from current segment)</span>
    {#each SPEEDS as v}
      <button class="lh-btn speed" class:active={speed === v} onclick={() => setSpeed(v)} disabled={browserMode}>{v}×</button>
    {/each}
    <span class="lh-sep"></span>
    <span class="lh-label">pauses: sentence {PAUSE_MS.sentence}ms · paragraph {PAUSE_MS.paragraph}ms · section {PAUSE_MS.section}ms</span>
  </section>

  <section class="lh-status">
    <span>phase <b>{phase}</b></span>
    <span>seg <b>{segIndex >= 0 ? segIndex + 1 : "–"}/{segments.length || "–"}</b></span>
    <span>playhead <b>{playheadS.toFixed(1)}s</b></span>
    <span>received <b>{receivedS.toFixed(1)}s</b></span>
    <span>render <b>#{renderId ?? "–"}</b></span>
    <span>underruns <b>{underruns}</b></span>
    <span>missing-page <b>{missingPages}</b></span>
    <span>re-renders <b>{restarts}</b></span>
    <span>preflight <b>{preflight}</b>{#if preflightMsg}<i> — {preflightMsg}</i>{/if}</span>
  </section>

  {#if currentText}
    <section class="lh-sentence">{currentText}</section>
  {/if}

  <section class="lh-gaps">
    <div class="lh-gaps-head">
      <b>Measured boundary gaps</b>
      <span>{gapRows.length} boundaries · {gapOk} ok · {gapBad} off</span>
      <span>page chain contiguous: <b class:bad={!gapContiguous}>{gapContiguous ? "yes" : "NO"}</b></span>
      <span class="lh-hint">cross-page joins marked ⇄ — extra samples there are audible as a gap or click</span>
    </div>
    {#if gapRows.length === 0}
      <div class="lh-gaps-empty">No audio received yet — press Start and let the first pages land.</div>
    {:else}
      <div class="lh-gaps-scroll">
        <table>
          <thead><tr><th>#</th><th>seg</th><th>class</th><th>expected</th><th>actual</th><th>Δ</th><th></th></tr></thead>
          <tbody>
            {#each gapRows as row, i}
              <tr class:bad={!row.ok} class:join={row.crossPage}>
                <td>{i + 1}</td>
                <td>{row.segId}</td>
                <td>{row.klass}</td>
                <td>{row.expectedMs}ms</td>
                <td>{row.actualMs}ms</td>
                <td>{row.deltaMs > 0 ? "+" : ""}{row.deltaMs}ms</td>
                <td>{row.crossPage ? "⇄" : ""}{row.ok ? "" : " ✗"}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section class="lh-checklist">
    <b>Listen for:</b>
    <ol>
      <li><b>Gaps</b> — each sentence/paragraph/section boundary is clean silence of the stated length; no clipping, no double-length pauses, no click.</li>
      <li><b>Page joins (⇄ rows)</b> — audio flows straight through the boundary: no dropout, no repeated words, no extra silence beyond the row's expected pause.</li>
      <li><b>Mid-page skips</b> — ±5s and sentence jumps resume exactly at the target sentence; nothing repeats or gets swallowed at the join.</li>
      <li><b>Speed changes</b> — switching speed re-renders from the current sentence and continues there; voice stays consistent; gaps keep their ms values.</li>
    </ol>
  </section>

  <section class="lh-log">
    <b>Event log</b>
    <div class="lh-log-scroll">
      {#each log as entry}
        <div><span class="t">{entry.t}</span> {entry.msg}</div>
      {:else}
        <div class="lh-gaps-empty">No events yet.</div>
      {/each}
    </div>
  </section>
</div>

<style>
  .listen-harness {
    position: fixed;
    inset: 24px;
    z-index: 600;
    margin: auto;
    max-width: 880px;
    max-height: calc(100vh - 48px);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px 18px;
    background: var(--bg-secondary);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35);
    font-size: 13px;
    color: var(--text-primary);
  }

  .lh-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
  }
  .lh-title {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    font-weight: 700;
    font-size: 14px;
  }
  .lh-title em {
    font-style: normal;
    font-size: 11px;
    color: var(--text-muted);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 0 5px;
  }
  .lh-sub {
    color: var(--text-muted);
    font-size: 12px;
  }
  .lh-close {
    margin-left: auto;
  }

  .lh-banner {
    padding: 8px 10px;
    border-radius: var(--radius-sm);
    background: var(--bg-hover);
    color: var(--text-secondary);
    font-size: 12px;
  }
  .lh-banner code {
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .lh-banner.lh-error {
    color: var(--danger, #c0503f);
  }

  .lh-row {
    display: flex;
    align-items: center;
    gap: 6px;
    flex-wrap: wrap;
  }
  .lh-sep {
    width: 1px;
    height: 18px;
    background: var(--border);
    margin: 0 4px;
  }
  .lh-label {
    color: var(--text-muted);
    font-size: 11px;
  }

  .lh-btn {
    padding: 5px 10px;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }
  .lh-btn:hover:not(:disabled) {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
  .lh-btn.primary {
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .lh-btn.speed.active {
    outline: 1px solid var(--accent);
    color: var(--text-primary);
  }
  .lh-btn:disabled {
    opacity: 0.45;
    cursor: default;
  }

  .lh-status {
    display: flex;
    gap: 14px;
    flex-wrap: wrap;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
  }
  .lh-status b {
    color: var(--text-primary);
  }

  .lh-sentence {
    padding: 8px 10px;
    background: var(--bg-primary);
    border-left: 3px solid var(--accent);
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-secondary);
  }

  .lh-gaps-head {
    display: flex;
    gap: 12px;
    align-items: baseline;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--text-secondary);
  }
  .lh-hint {
    color: var(--text-muted);
    font-size: 11px;
  }
  .lh-gaps-scroll {
    max-height: 180px;
    overflow-y: auto;
    margin-top: 6px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
  }
  .lh-gaps table {
    width: 100%;
    border-collapse: collapse;
    font-family: var(--font-mono);
    font-size: 11px;
  }
  .lh-gaps th,
  .lh-gaps td {
    text-align: left;
    padding: 3px 8px;
    border-bottom: 1px solid var(--border);
  }
  .lh-gaps tr.bad td {
    color: var(--danger, #c0503f);
  }
  .lh-gaps tr.join td:last-child {
    color: var(--accent);
  }
  .lh-gaps-empty {
    padding: 8px;
    color: var(--text-muted);
    font-size: 12px;
  }

  .lh-checklist {
    font-size: 12px;
    color: var(--text-secondary);
  }
  .lh-checklist ol {
    margin: 4px 0 0;
    padding-left: 18px;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .lh-log {
    font-size: 11px;
    color: var(--text-secondary);
  }
  .lh-log-scroll {
    max-height: 120px;
    overflow-y: auto;
    margin-top: 4px;
    font-family: var(--font-mono);
  }
  .lh-log-scroll .t {
    color: var(--text-muted);
  }
</style>
