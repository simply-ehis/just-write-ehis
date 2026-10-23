/**
 * tts/player — the render-ahead timeline player.
 *
 * Pages of PCM arrive from the Rust renderer (`tts://render-page` meta +
 * `tts_render_page` bytes) and are scheduled gapless on one AudioContext
 * clock: a page that starts at sample S plays at
 * `anchorCtxTime + (S - anchorSample) / RATE`, so joins are sample-exact
 * by construction and a page boundary physically cannot produce a gap.
 *
 * One rAF-rate tick reads `ctx.currentTime` → `playheadSample`, binary-
 * searches the merged SegmentTiming list and drives highlight / transport
 * / demand from the AUDIO clock — never from synthesis calls. The pure
 * math below is intentionally free of DOM/WebAudio types so node can
 * import this module directly for tests (repo convention: tests/*.mjs
 * import src/lib/*.ts).
 */

export const RENDER_SAMPLE_RATE = 24000;

/** How far ahead of ctx.currentTime pages are anchored (decode slack). */
const LEAD_SECONDS = 0.12;
/** Clock tick period — ~10 Hz is plenty for highlight (plan: ~10 Hz). */
const TICK_MS = 100;
/** Demand more rendering when playback is this close to the frontier. */
const DEMAND_LOOKAHEAD_SAMPLES = 15 * RENDER_SAMPLE_RATE;
/** Grace before declaring the end of a completed render. */
const END_GRACE_SAMPLES = Math.floor(0.4 * RENDER_SAMPLE_RATE);
/** Minimum gap between render demands. */
const DEMAND_THROTTLE_MS = 700;

export interface SegmentTiming {
  segId: number;
  startSample: number;
  endSample: number;
}

export interface PageMeta {
  pageIdx: number;
  startSample: number;
  endSample: number;
  timings: SegmentTiming[];
}

// ── Pure timeline math (node-testable) ───────────────────────────────

/**
 * Index into the timings list whose audio (or trailing pause) owns
 * `sample`: the last timing that has started. Before the first segment →
 * -1. Past a segment's endSample the answer stays that segment, so the
 * highlight holds through trailing silence — pauses never fall "between"
 * sentences.
 */
export function findSegmentAt(timings: SegmentTiming[], sample: number): number {
  if (timings.length === 0 || sample < timings[0].startSample) return -1;
  let lo = 0;
  let hi = timings.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (timings[mid].startSample <= sample) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** The page holding `sample` (pages sorted by pageIdx = ascending), or -1. */
export function findPageFor(pages: PageMeta[], sample: number): number {
  if (pages.length === 0) return -1;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = pages[mid];
    if (sample < p.startSample) hi = mid - 1;
    else if (sample >= p.endSample) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/** A contiguous chain has zero missing samples between page joins. */
export function pageChainIsContiguous(pages: PageMeta[]): boolean {
  const sorted = [...pages].sort((a, b) => a.pageIdx - b.pageIdx);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startSample !== sorted[i - 1].endSample) return false;
  }
  return true;
}

export interface TickState {
  playhead: number;
  /** endSample of everything received (fetch frontier). */
  receivedEnd: number;
  /** endSample of everything decoded + scheduled (audio frontier). */
  readyEnd: number;
  totalSamples: number;
  renderDone: boolean;
  hasPages: boolean;
}

export interface TickDecision {
  /** Playback ran out of scheduled audio while the job is still going. */
  underrun: boolean;
  /** Renderer should be asked for more (absolute playhead seconds). */
  demand: boolean;
  /** Completed render played to its last sample. */
  ended: boolean;
}

/** The underrun-hold / demand / end predicates, pure and testable. */
export function tickDecision(s: TickState): TickDecision {
  return {
    underrun: s.hasPages && !s.renderDone && s.playhead >= s.readyEnd,
    demand: !s.renderDone && s.playhead + DEMAND_LOOKAHEAD_SAMPLES > s.receivedEnd,
    ended: s.renderDone && s.playhead + END_GRACE_SAMPLES >= s.totalSamples,
  };
}

/**
 * Samples to drop from a page's head when it lands late: the clock has
 * already passed the page's ideal start, so we trim exactly the elapsed
 * amount and the audio realigns with the playhead — never audible as a
 * skip because the skipped samples are ones the clock already counted.
 */
export function lateTrimSamples(
  idealStartCtxTime: number,
  nowCtxTime: number,
  sampleRate: number,
): number {
  if (idealStartCtxTime >= nowCtxTime) return 0;
  return Math.round((nowCtxTime - idealStartCtxTime) * sampleRate);
}

/**
 * Overall progress from the audio clock; null until the render's total
 * length is known (set on render-done). Clamped to 0..1 so a late tick
 * past the end never reads >100 %.
 */
export function progressRatio(playhead: number, totalSamples: number): number | null {
  if (totalSamples <= 0) return null;
  return Math.min(1, Math.max(0, playhead / totalSamples));
}

// ── Player ───────────────────────────────────────────────────────────

export interface PlayerHooks {
  /** Active segment changed; null on stop/end. */
  onSegment: (segId: number | null) => void;
  /** Renderer wants more audio; arg is absolute playhead seconds. */
  onDemand: (playheadSeconds: number) => void;
  /** Completed render played through. */
  onEnd: () => void;
  /** The page covering this sample is unavailable — re-render there. */
  onMissingPage: (sample: number) => void;
  /** Underrun hold began (true) or resumed (false) — "catching up…". */
  onUnderrun: (underrun: boolean) => void;
  /** UI phase for the pill/spinner. */
  onPhase: (phase: "waiting" | "playing" | "paused" | "idle") => void;
  /** Overall progress 0..1 once the total is known (pill %). */
  onProgress?: (ratio: number) => void;
}

type PageEntry = {
  meta: PageMeta;
  buffer: AudioBuffer | null;
  scheduled: boolean;
};

interface HeldPage {
  meta: PageMeta;
  pcm: Int16Array;
}

export class TtsTimelinePlayer {
  private ctx: AudioContext;
  private hooks: PlayerHooks;
  private renderId: number | null = null;
  private pages = new Map<number, PageEntry>();
  private held: HeldPage[] = []; // metas with PCM not yet decoded/scheduled
  private timings: SegmentTiming[] = [];
  private sources = new Set<AudioBufferSourceNode>();
  private anchor: { ctxTime: number; sample: number } | null = null;
  private phase: "idle" | "waiting" | "playing" | "paused" | "underrun" = "idle";
  private interval: ReturnType<typeof setInterval> | null = null;
  private receivedEnd = 0;
  private readyEnd = 0;
  private expectedPageIdx = 0;
  private totalSamples = 0;
  private renderDone = false;
  private lastSegId: number | null = null;
  private lastProgress: number | null = null;
  private lastDemandAt = 0;
  private exposedPhase: "waiting" | "playing" | "paused" | "idle" | null = null;

  constructor(ctx: AudioContext, hooks: PlayerHooks) {
    this.ctx = ctx;
    this.hooks = hooks;
  }

  /** Reset for a (new) render job. */
  load(renderId: number): void {
    this.teardownTransport();
    this.renderId = renderId;
    this.pages.clear();
    this.held = [];
    this.timings = [];
    this.receivedEnd = 0;
    this.readyEnd = 0;
    this.expectedPageIdx = 0;
    this.totalSamples = 0;
    this.renderDone = false;
    this.lastSegId = null;
    this.lastProgress = null;
    this.anchor = null;
    this.phase = "idle";
  }

  /** Page metadata + PCM from a `tts://render-page` event + fetched bytes. */
  addPage(meta: PageMeta, pcm: Int16Array): void {
    if (this.renderId === null) return;
    if (this.pages.has(meta.pageIdx)) return;
    if (meta.pageIdx !== this.expectedPageIdx) {
      // Out-of-order arrival = a hole in the chain; restart there.
      this.hooks.onMissingPage(this.receivedEnd);
      return;
    }
    this.expectedPageIdx = meta.pageIdx + 1;
    for (const t of meta.timings) this.timings.push(t);
    this.receivedEnd = Math.max(this.receivedEnd, meta.endSample);
    this.held.push({ meta, pcm });
    this.decodeAndSchedule();
    if (this.phase === "waiting") this.setPhase("playing");
    if (this.phase === "underrun") this.maybeResume();
  }

  /** Renderer finished: total length known; `completed` false = errored. */
  markRenderDone(totalSamples: number, completed: boolean): void {
    this.renderDone = true;
    this.totalSamples = completed ? totalSamples : this.receivedEnd;
    if (this.phase === "underrun") this.maybeResume();
  }

  /** Begin playback at `sample` (0 for a fresh read, target for resume). */
  start(sample = 0): void {
    if (this.renderId === null) return;
    void this.ctx.resume().catch(() => {});
    this.anchor = { ctxTime: this.ctx.currentTime + LEAD_SECONDS, sample };
    this.phase = this.receivedEnd > 0 ? "playing" : "waiting";
    this.setPhase(this.phase === "waiting" ? "waiting" : "playing");
    this.scheduleHeld();
    this.lastSegId = null;
    this.interval = setInterval(() => this.tick(), TICK_MS);
    this.demand(sample / RENDER_SAMPLE_RATE);
  }

  pause(): void {
    if (this.phase !== "playing" && this.phase !== "waiting") return;
    void this.ctx.suspend().catch(() => {});
    this.phase = "paused";
    this.setPhase("paused");
  }

  resume(): void {
    if (this.phase !== "paused") return;
    void this.ctx.resume().catch(() => {});
    this.phase = this.readyEnd > 0 ? "playing" : "waiting";
    this.setPhase(this.phase === "waiting" ? "waiting" : "playing");
  }

  /** Jump to a segment boundary by its global segId.
   * False when the segment was never rendered (frontier) — the caller
   * re-renders from there instead. */
  seekToSegId(segId: number): boolean {
    const t = this.timings.find((x) => x.segId === segId);
    if (!t) return false;
    this.seek(t.startSample);
    return true;
  }

  /** Which segment owns this sample in the CURRENT job's timeline. */
  segIdAt(sample: number): number | null {
    const idx = findSegmentAt(this.timings, sample);
    return idx >= 0 ? this.timings[idx].segId : null;
  }

  /** Current audio-clock position, in samples (0 when idle). */
  playheadNow(): number {
    return this.playheadSample();
  }

  /** Pages decoded into the timeline so far. */
  pagesReceived(): number {
    return this.pages.size;
  }

  /** Fetch frontier in samples — seeks past this need a re-render. */
  receivedEndSamples(): number {
    return this.receivedEnd;
  }

  seek(sample: number): void {
    if (this.renderId === null) return;
    const covered = [...this.pages.values()].some(
      (p) => p.meta.startSample <= sample && sample < p.meta.endSample && p.buffer,
    );
    if (!covered) {
      this.hooks.onMissingPage(sample);
      return;
    }
    this.stopSources();
    void this.ctx.resume().catch(() => {});
    this.anchor = { ctxTime: this.ctx.currentTime + LEAD_SECONDS, sample };
    this.phase = "playing";
    this.setPhase("playing");
    for (const p of this.pages.values()) p.scheduled = false;
    this.scheduleHeld();
    this.lastSegId = null;
    this.forceSegmentEmit(sample);
    this.demand(sample / RENDER_SAMPLE_RATE);
  }

  /** Stop transport (render cancel + unlisten happen at the store level). */
  stop(): void {
    this.teardownTransport();
    this.renderId = null;
    this.setPhase("idle");
    this.hooks.onSegment(null);
    this.hooks.onUnderrun(false);
  }

  destroy(): void {
    this.stop();
  }

  // ── internals ─────────────────────────────────────────────────────

  private teardownTransport(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
    this.stopSources();
    if (this.phase === "paused" || this.phase === "underrun") {
      void this.ctx.resume().catch(() => {});
    }
    this.phase = "idle";
  }

  private stopSources(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already ended */
      }
      try {
        s.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.sources.clear();
  }

  private setPhase(phase: "waiting" | "playing" | "paused" | "idle"): void {
    if (this.exposedPhase === phase) return;
    this.exposedPhase = phase;
    this.hooks.onPhase(phase);
  }

  private demand(seconds: number): void {
    const now = Date.now();
    if (now - this.lastDemandAt < DEMAND_THROTTLE_MS) return;
    this.lastDemandAt = now;
    this.hooks.onDemand(seconds);
  }

  private decodeAndSchedule(): void {
    while (this.held.length > 0) {
      const next = this.held[0];
      const buffer = this.pcmToBuffer(next.pcm);
      this.held.shift();
      const entry: PageEntry = { meta: next.meta, buffer, scheduled: false };
      this.pages.set(next.meta.pageIdx, entry);
      if (this.anchor && (this.phase === "playing" || this.phase === "underrun" || this.phase === "waiting")) {
        this.schedulePage(entry);
      }
    }
    if (this.phase === "underrun") this.maybeResume();
  }

  private scheduleHeld(): void {
    for (const entry of this.pages.values()) {
      if (!entry.scheduled && entry.buffer) this.schedulePage(entry);
    }
  }

  private schedulePage(entry: PageEntry): void {
    if (!entry.buffer || !this.anchor || entry.scheduled) return;
    if (entry.meta.endSample <= this.anchor.sample) {
      entry.scheduled = true; // entirely behind us
      return;
    }
    const ideal =
      this.anchor.ctxTime + (entry.meta.startSample - this.anchor.sample) / RENDER_SAMPLE_RATE;
    const now = this.ctx.currentTime;
    const trim = lateTrimSamples(ideal, now, RENDER_SAMPLE_RATE);
    let buffer = entry.buffer;
    if (trim >= buffer.length) {
      entry.scheduled = true;
      return;
    }
    if (trim > 0) {
      buffer = this.ctx.createBuffer(1, buffer.length - trim, RENDER_SAMPLE_RATE);
      buffer.copyToChannel(entry.buffer.getChannelData(0).subarray(trim), 0);
    }
    const source = this.ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(this.ctx.destination);
    const startAt = Math.max(ideal, now);
    source.start(startAt);
    this.sources.add(source);
    source.onended = () => {
      this.sources.delete(source);
      try {
        source.disconnect();
      } catch {
        /* noop */
      }
    };
    entry.scheduled = true;
    this.readyEnd = Math.max(this.readyEnd, entry.meta.endSample);
  }

  private pcmToBuffer(pcm: Int16Array): AudioBuffer {
    const buffer = this.ctx.createBuffer(1, pcm.length, RENDER_SAMPLE_RATE);
    const f32 = new Float32Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) f32[i] = pcm[i] / 32768;
    buffer.copyToChannel(f32, 0);
    return buffer;
  }

  private playheadSample(): number {
    if (!this.anchor) return 0;
    const raw = (this.ctx.currentTime - this.anchor.ctxTime) * RENDER_SAMPLE_RATE + this.anchor.sample;
    // During the scheduling lead the clock runs slightly before the
    // anchor; hold at the anchor so segment search never rewinds.
    return Math.max(raw, this.anchor.sample);
  }

  private forceSegmentEmit(sample: number): void {
    const idx = findSegmentAt(this.timings, sample);
    const segId = idx >= 0 ? this.timings[idx].segId : null;
    this.lastSegId = segId;
    if (segId !== null) this.hooks.onSegment(segId);
  }

  private maybeResume(): void {
    if (this.phase !== "underrun") return;
    if (this.readyEnd > this.playheadSample() || this.renderDone) {
      void this.ctx.resume().catch(() => {});
      this.phase = this.readyEnd > 0 ? "playing" : "waiting";
      this.setPhase(this.phase === "waiting" ? "waiting" : "playing");
      this.hooks.onUnderrun(false);
    }
  }

  private tick(): void {
    if (this.phase === "idle" || this.phase === "paused" || this.anchor === null) return;
    const playhead = this.playheadSample();
    const decision = tickDecision({
      playhead,
      receivedEnd: this.receivedEnd,
      readyEnd: this.readyEnd,
      totalSamples: this.totalSamples,
      renderDone: this.renderDone,
      hasPages: this.pages.size > 0 || this.held.length > 0,
    });

    if (this.phase === "playing" && decision.underrun) {
      // Hold on the current sample (suspend freezes the clock, so the
      // anchor math survives the wait untouched) — never stutter.
      void this.ctx.suspend().catch(() => {});
      this.phase = "underrun";
      this.hooks.onUnderrun(true);
    } else if (this.phase === "underrun") {
      this.maybeResume();
    }

    // Pill progress %: continuous from the AUDIO clock once the total
    // length is known (render-done); updates at ≥0.5 % steps.
    const ratio = progressRatio(playhead, this.totalSamples);
    if (ratio !== null && (this.lastProgress === null || Math.abs(ratio - this.lastProgress) >= 0.005)) {
      this.lastProgress = ratio;
      this.hooks.onProgress?.(ratio);
    }

    const endedNow = this.phase === "playing" && decision.ended;
    if (!endedNow) this.demand(playhead / RENDER_SAMPLE_RATE);

    const idx = findSegmentAt(this.timings, playhead);
    const segId = idx >= 0 ? this.timings[idx].segId : null;
    if (segId !== this.lastSegId) {
      this.lastSegId = segId;
      this.hooks.onSegment(segId);
    }

    if (endedNow) {
      this.teardownTransport();
      this.setPhase("idle");
      this.hooks.onSegment(null);
      this.hooks.onEnd();
    }
  }
}
