<script lang="ts">
  let { content, height = 12 }: { content: string; height?: number } = $props();

  let bars = $derived.by(() => {
    if (!content) return [];
    const blocks = content.split(/\n\n+/).filter((b) => b.trim().length > 0);
    const wcs = blocks.map((b) => b.trim().split(/\s+/).filter(Boolean).length);
    const max = Math.max(1, ...wcs);
    return wcs.map((wc) => wc / max);
  });

  /** Map ratio (0-1) to a cool→warm hue. */
  function ratioToColor(r: number): string {
    // 220 (cool blue) → 0 (warm red)
    const h = Math.round(220 - r * 220);
    return `hsl(${h}, 65%, 55%)`;
  }
</script>

{#if bars.length > 0}
  <div
    class="rhythm-heatmap"
    style="height: {height}px"
    title="Paragraph density: {bars.length} paragraphs"
    role="img"
    aria-label="Paragraph density heatmap"
  >
    {#each bars as ratio}
      <div
        class="heatmap-bar"
        style="background: {ratioToColor(ratio)}; width: {100 / bars.length}%"
      ></div>
    {/each}
  </div>
{/if}

<style>
  .rhythm-heatmap {
    display: flex;
    overflow: hidden;
    border-radius: 2px;
    gap: 1px;
    opacity: 0.85;
  }

  .heatmap-bar {
    min-width: 1px;
    flex-shrink: 0;
  }
</style>
