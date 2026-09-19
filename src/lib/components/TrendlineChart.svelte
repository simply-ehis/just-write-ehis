<script lang="ts">
  interface Props {
    data: [string, number][];
    label?: string;
    width?: number;
    height?: number;
    color?: string;
  }

  let { data, label = "", width = 280, height = 80, color = "var(--accent)" }: Props = $props();

  const padding = { top: 8, right: 8, bottom: 20, left: 8 };

  let points = $derived.by(() => {
    if (data.length < 2) return "";
    const vals = data.map((d) => d[1]);
    const minV = Math.min(...vals);
    const maxV = Math.max(...vals);
    const range = maxV - minV || 1;
    const innerW = width - padding.left - padding.right;
    const innerH = height - padding.top - padding.bottom;

    return data
      .map((d, i) => {
        const x = padding.left + (i / (data.length - 1)) * innerW;
        const y = padding.top + innerH - ((d[1] - minV) / range) * innerH;
        return `${x},${y}`;
      })
      .join(" ");
  });

  let yMin = $derived(data.length > 0 ? Math.min(...data.map((d) => d[1])) : 0);
  let yMax = $derived(data.length > 0 ? Math.max(...data.map((d) => d[1])) : 1);

  function formatVal(v: number): string {
    if (v >= 100) return Math.round(v).toString();
    if (v >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }
</script>

<div class="trendline-chart">
  {#if label}
    <div class="chart-label">{label}</div>
  {/if}
  {#if data.length < 2}
    <div class="chart-empty">Not enough data points</div>
  {:else}
    <svg {width} {height} viewBox="0 0 {width} {height}">
      <!-- Grid lines -->
      <line
        x1={padding.left} y1={padding.top}
        x2={width - padding.right} y2={padding.top}
        stroke="var(--border-subtle)" stroke-width="0.5" opacity="0.5"
      />
      <line
        x1={padding.left} y1={padding.top + (height - padding.top - padding.bottom) / 2}
        x2={width - padding.right} y2={padding.top + (height - padding.top - padding.bottom) / 2}
        stroke="var(--border-subtle)" stroke-width="0.5" opacity="0.3"
      />
      <line
        x1={padding.left} y1={height - padding.bottom}
        x2={width - padding.right} y2={height - padding.bottom}
        stroke="var(--border-subtle)" stroke-width="0.5" opacity="0.5"
      />

      <!-- Area fill -->
      <polygon
        points="{padding.left},{height - padding.bottom} {points} {width - padding.right},{height - padding.bottom}"
        fill={color} opacity="0.1"
      />

      <!-- Line -->
      <polyline
        {points}
        fill="none"
        stroke={color}
        stroke-width="1.5"
        stroke-linejoin="round"
        stroke-linecap="round"
      />

      <!-- End dot -->
      {#if data.length > 0}
        {@const lastX = padding.left + ((data.length - 1) / (data.length - 1)) * (width - padding.left - padding.right)}
        {@const vals = data.map((d) => d[1])}
        {@const range = Math.max(...vals) - Math.min(...vals) || 1}
        {@const lastY = padding.top + (height - padding.top - padding.bottom) - ((data[data.length - 1][1] - Math.min(...vals)) / range) * (height - padding.top - padding.bottom)}
        <circle cx={lastX} cy={lastY} r="3" fill={color} />
      {/if}

      <!-- Y-axis labels -->
      <text x={padding.left + 2} y={padding.top + 8} fill="var(--text-muted)" font-size="9">
        {formatVal(yMax)}
      </text>
      <text x={padding.left + 2} y={height - padding.bottom - 3} fill="var(--text-muted)" font-size="9">
        {formatVal(yMin)}
      </text>
    </svg>
  {/if}
</div>

<style>
  .trendline-chart {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .chart-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .chart-empty {
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
    padding: 12px 0;
  }

  svg {
    display: block;
  }
</style>
