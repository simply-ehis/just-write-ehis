<script lang="ts">
  import { onMount } from "svelte";

  let { content, onJumpToLine }: { content: string; onJumpToLine?: (line: number) => void } = $props();

  interface ParaInfo {
    index: number;
    wordCount: number;
    isDialogue: boolean;
    lineStart: number;
    preview: string;
  }

  let paragraphs = $derived.by<ParaInfo[]>(() => {
    if (!content) return [];
    const blocks = content.split(/\n\n+/);
    let line = 0;
    return blocks
      .filter((b) => b.trim().length > 0)
      .map((block, i) => {
        const words = block.trim().split(/\s+/).filter(Boolean);
        const trimmed = block.trim();
        const preview = trimmed.slice(0, 60) + (trimmed.length > 60 ? "..." : "");
        const isDialogue =
          trimmed.startsWith('"') ||
          trimmed.startsWith("\u201c") ||
          trimmed.startsWith("\u2018") ||
          trimmed.startsWith(">");
        const result: ParaInfo = {
          index: i,
          wordCount: words.length,
          isDialogue,
          lineStart: line,
          preview,
        };
        line += block.split("\n").length + 1; // +1 for the blank line
        return result;
      });
  });

  let hoveredIdx = $state<number | null>(null);
  let svgEl = $state<SVGSVGElement>();

  const W = 800;
  const H = 100;
  const PAD = { top: 8, right: 4, bottom: 16, left: 4 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  let maxWc = $derived(Math.max(1, ...paragraphs.map((p) => p.wordCount)));
  let barW = $derived(
    paragraphs.length > 0 ? Math.max(2, innerW / paragraphs.length - 1) : 4
  );

  function barColor(p: ParaInfo, idx: number): string {
    const ratio = p.wordCount / maxWc;
    if (p.isDialogue) return "var(--ws-script, #B54434)";
    if (ratio > 0.75) return "var(--ws-novel, #7A6F9B)";
    if (ratio > 0.4) return "var(--ws-write, #726F62)";
    return "var(--ws-map, #3F6656)";
  }

  function handleBarClick(idx: number) {
    if (onJumpToLine && paragraphs[idx]) {
      onJumpToLine(paragraphs[idx].lineStart);
    }
  }

  let tooltipX = $state(0);
  let tooltipY = $state(0);

  function handleMouseMove(e: MouseEvent) {
    if (!svgEl) return;
    const rect = svgEl.getBoundingClientRect();
    tooltipX = e.clientX - rect.left;
    tooltipY = e.clientY - rect.top;
  }
</script>

<div class="rhythm-waveform" role="img" aria-label="Paragraph rhythm waveform">
  {#if paragraphs.length < 2}
    <div class="rhythm-empty">Not enough paragraphs to visualize</div>
  {:else}
    <svg
      bind:this={svgEl}
      viewBox="0 0 {W} {H}"
      preserveAspectRatio="none"
      class="waveform-svg"
      onmousemove={handleMouseMove}
      onmouseleave={() => (hoveredIdx = null)}
    >
      {#each paragraphs as p, i}
        {@const x = PAD.left + i * (barW + 1)}
        {@const barH = (p.wordCount / maxWc) * innerH}
        <rect
          {x}
          y={PAD.top + innerH - barH}
          width={barW}
          height={barH}
          fill={barColor(p, i)}
          opacity={hoveredIdx === null || hoveredIdx === i ? 0.85 : 0.35}
          rx="1"
          role="button"
          tabindex="-1"
          onmouseenter={() => (hoveredIdx = i)}
          onmouseleave={() => (hoveredIdx = null)}
          onclick={() => handleBarClick(i)}
          onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') handleBarClick(i); }}
          style="cursor: {onJumpToLine ? 'pointer' : 'default'}"
        />
      {/each}
      <!-- baseline -->
      <line
        x1={PAD.left}
        y1={PAD.top + innerH}
        x2={W - PAD.right}
        y2={PAD.top + innerH}
        stroke="var(--border-subtle)"
        stroke-width="0.5"
      />
    </svg>
    {#if hoveredIdx !== null && paragraphs[hoveredIdx]}
      <div class="rhythm-tooltip" style="left: {Math.min(tooltipX, W - 200)}px; top: {Math.max(tooltipY - 40, 0)}px">
        <span class="tooltip-words">{paragraphs[hoveredIdx].wordCount} words</span>
        {#if paragraphs[hoveredIdx].isDialogue}<span class="tooltip-tag">dialogue</span>{/if}
        <span class="tooltip-preview">{paragraphs[hoveredIdx].preview}</span>
      </div>
    {/if}
  {/if}
</div>

<style>
  .rhythm-waveform {
    position: relative;
    width: 100%;
  }

  .waveform-svg {
    width: 100%;
    height: 100px;
    display: block;
  }

  .rhythm-empty {
    color: var(--text-muted);
    font-size: 12px;
    text-align: center;
    padding: 24px;
  }

  .rhythm-tooltip {
    position: absolute;
    z-index: 20;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    padding: 6px 10px;
    pointer-events: none;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
    max-width: 220px;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .tooltip-words {
    font-size: 11px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .tooltip-tag {
    font-size: 9px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--ws-script, #B54434);
    font-weight: 600;
  }

  .tooltip-preview {
    font-size: 10px;
    color: var(--text-muted);
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
