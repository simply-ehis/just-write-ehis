<script lang="ts">
  import RhythmWaveform from "./RhythmWaveform.svelte";
  import TrendlineChart from "./TrendlineChart.svelte";

  let {
    content,
    dialogueTrend,
    sentenceTrend,
    onJumpToLine,
  }: {
    content: string;
    dialogueTrend: [string, number][];
    sentenceTrend: [string, number][];
    onJumpToLine?: (line: number) => void;
  } = $props();

  let stats = $derived.by(() => {
    if (!content) return { avg: 0, longest: 0, shortest: 0, dialoguePct: 0, paraCount: 0, pacing: "" };
    const blocks = content.split(/\n\n+/).filter((b) => b.trim().length > 0);
    const wcs = blocks.map((b) => b.trim().split(/\s+/).filter(Boolean).length);
    const dialogue = blocks.filter((b) => {
      const t = b.trim();
      return t.startsWith('"') || t.startsWith("\u201c") || t.startsWith("\u2018") || t.startsWith(">");
    });
    const avg = wcs.length ? Math.round(wcs.reduce((a, b) => a + b, 0) / wcs.length) : 0;
    const longest = wcs.length ? Math.max(...wcs) : 0;
    const shortest = wcs.length ? Math.min(...wcs) : 0;
    const dialoguePct = blocks.length ? Math.round((dialogue.length / blocks.length) * 100) : 0;

    // Detect pacing zones
    let pacing = "";
    const shortBursts = wcs.filter((w) => w < 15).length;
    const longSwells = wcs.filter((w) => w > 60).length;
    if (shortBursts > wcs.length * 0.6) pacing = "Fast / staccato";
    else if (longSwells > wcs.length * 0.4) pacing = "Slow / contemplative";
    else pacing = "Mixed";

    return { avg, longest, shortest, dialoguePct, paraCount: wcs.length, pacing };
  });
</script>

<div class="rhythm-panel">
  <div class="rhythm-section">
    <span class="rhythm-label">Paragraph Rhythm</span>
    <RhythmWaveform {content} {onJumpToLine} />
  </div>
  <div class="rhythm-stats">
    <div class="rhythm-stat">
      <span class="stat-value">{stats.paraCount}</span>
      <span class="stat-label">paragraphs</span>
    </div>
    <div class="rhythm-stat">
      <span class="stat-value">{stats.avg}</span>
      <span class="stat-label">avg words</span>
    </div>
    <div class="rhythm-stat">
      <span class="stat-value">{stats.dialoguePct}%</span>
      <span class="stat-label">dialogue</span>
    </div>
    <div class="rhythm-stat">
      <span class="stat-value">{stats.pacing}</span>
      <span class="stat-label">pacing</span>
    </div>
  </div>
  <div class="rhythm-charts">
    <TrendlineChart data={dialogueTrend} label="Dialogue Ratio" />
    <TrendlineChart data={sentenceTrend} label="Avg Sentence Length" color="#6e8efb" />
  </div>
</div>

<style>
  .rhythm-panel {
    padding: 8px 16px;
    border-bottom: 1px solid var(--border-subtle);
    background: var(--surface-base);
  }

  .rhythm-section {
    margin-bottom: 8px;
  }

  .rhythm-label {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 4px;
    display: block;
  }

  .rhythm-stats {
    display: flex;
    gap: 16px;
    padding: 6px 0;
    border-top: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
    margin: 8px 0;
  }

  .rhythm-stat {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1px;
  }

  .stat-value {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .stat-label {
    font-size: 10px;
    color: var(--text-muted);
  }

  .rhythm-charts {
    display: flex;
    gap: 24px;
  }
</style>
