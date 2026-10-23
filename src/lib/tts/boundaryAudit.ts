/**
 * boundaryAudit — pure gap bookkeeping for the TTS listen harness
 * (ListenHarness.svelte, tests/listen-harness.mjs).
 *
 * The Rust renderer generates each segment's trailing silence INTO the
 * PCM (`pause_after_ms` → exactly pauseMs*rate/1000 samples) and pages
 * are sample-contiguous, so every boundary gap — intra-page or across a
 * page join — is measurable from the merged SegmentTiming chain:
 *
 *     gapAfter(i) = startSample(i+1) − endSample(i)
 *
 * A clean read therefore shows one expected pause per boundary and
 * EXACTLY zero extra samples at page joins; any drift is audible AND
 * visible here. No DOM/WebAudio types — node imports this directly
 * (repo convention: tests/*.mjs import src/lib/*.ts).
 */
import type { SegmentTiming } from "./player";

export type BoundaryClass = "sentence" | "paragraph" | "section";

export interface PageRange {
  startSample: number;
  endSample: number;
}

export interface GapRow {
  /** Segment whose trailing pause this gap measures. */
  segId: number;
  klass: BoundaryClass;
  expectedMs: number;
  actualMs: number;
  deltaMs: number;
  /** |delta| within tolerance (default: one sample @ 24 kHz + ε). */
  ok: boolean;
  /** Gap straddles a page join (last seg of one page → first of next). */
  crossPage: boolean;
}

export interface GapAudit {
  rows: GapRow[];
  /** Page ranges form a gapless chain (start == previous end, sorted). */
  contiguous: boolean;
  okCount: number;
  badCount: number;
}

/** A contiguous chain has zero missing samples between page joins. */
export function rangesContiguous(ranges: PageRange[]): boolean {
  const sorted = [...ranges].sort((a, b) => a.startSample - b.startSample);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startSample !== sorted[i - 1].endSample) return false;
  }
  return true;
}

/**
 * Measure every inter-segment pause in the received chain. Timings may
 * arrive in any order; overlapping/out-of-order pairs surface as
 * not-ok rows (a negative gap is impossible audio). Segments unknown to
 * `classOf` are treated as sentence pauses (the default class).
 */
export function auditGaps(opts: {
  timings: SegmentTiming[];
  classOf: (segId: number) => BoundaryClass;
  pauseMs: Record<BoundaryClass, number>;
  sampleRate: number;
  pageRanges: PageRange[];
  /** Tolerance in ms (default: 1/24000 s rounded up — integer sample math). */
  toleranceMs?: number;
}): GapAudit {
  const { timings, classOf, pauseMs, sampleRate, pageRanges } = opts;
  const toleranceMs = opts.toleranceMs ?? 1000 / sampleRate;
  const sorted = [...timings].sort((a, b) => a.startSample - b.startSample);
  const pageEnds = new Set(pageRanges.map((r) => r.endSample));

  const rows: GapRow[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const prev = sorted[i];
    const next = sorted[i + 1];
    const klass = classOf(prev.segId);
    const expectedMs = pauseMs[klass];
    const gapSamples = next.startSample - prev.endSample;
    const actualMs = (gapSamples / sampleRate) * 1000;
    const deltaMs = actualMs - expectedMs;
    rows.push({
      segId: prev.segId,
      klass,
      expectedMs,
      actualMs: Math.round(actualMs * 1000) / 1000,
      deltaMs: Math.round(deltaMs * 1000) / 1000,
      ok: Math.abs(deltaMs) <= toleranceMs,
      crossPage: pageEnds.has(prev.endSample),
    });
  }

  const okCount = rows.filter((r) => r.ok).length;
  return {
    rows,
    contiguous: rangesContiguous(pageRanges),
    okCount,
    badCount: rows.length - okCount,
  };
}
