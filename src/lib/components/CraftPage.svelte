<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { api } from "$lib/api";
  import { currentDoc, currentWorkspace } from "$lib/stores/app";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "./Icon.svelte";
  import TrendlineChart from "./TrendlineChart.svelte";

  // Data state
  let dialogueTrend = $state<[string, number][]>([]);
  let sentenceTrend = $state<[string, number][]>([]);
  let filterTrend = $state<[string, number][]>([]);
  let repetitionTrend = $state<[string, number][]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let intervalId: ReturnType<typeof setInterval> | null = null;

  // Selected doc for analysis (defaults to current doc)
  let selectedDocId = $state<string | null>(null);

  async function loadTrends(docId: string) {
    loading = true;
    error = null;
    try {
      const [dialogue, sentence, filter, repetition] = await Promise.all([
        api.craftMetricsTrend(docId, "dialogue_ratio"),
        api.craftMetricsTrend(docId, "avg_sentence_length"),
        api.craftMetricsTrend(docId, "filter_words"),
        api.craftMetricsTrend(docId, "repetition_constructions").catch(() => []), // may not exist yet
      ]);
      dialogueTrend = dialogue;
      sentenceTrend = sentence;
      filterTrend = filter;
      repetitionTrend = repetition;
    } catch (e) {
      error = e instanceof Error ? e.message : "Failed to load craft trends";
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    if ($currentDoc) {
      selectedDocId = $currentDoc.id;
      loadTrends($currentDoc.id);
    }
    // Refresh every 60 seconds
    intervalId = setInterval(() => {
      if (selectedDocId) loadTrends(selectedDocId);
    }, 60000);
  });

  onDestroy(() => {
    if (intervalId) clearInterval(intervalId);
  });

  $effect(() => {
    if ($currentDoc && $currentDoc.id !== selectedDocId) {
      selectedDocId = $currentDoc.id;
      loadTrends(selectedDocId);
    }
  });

  function formatDate(d: string): string {
    return new Date(d).toLocaleDateString();
  }

  function lastValue(trend: [string, number][]): number | null {
    return trend.length > 0 ? trend[trend.length - 1][1] : null;
  }

  // Summary colors computed in script: `<` comparisons are illegal
  // inside HTML attribute strings, so they live here instead.
  let filterColor = $derived.by(() => {
    const v = lastValue(filterTrend);
    if (v === null) return "#95a5a6";
    return v < 0.02 ? "#27ae60" : v < 0.04 ? "#f39c12" : "#e74c3c";
  });
  let sentenceColor = $derived.by(() => {
    const v = lastValue(sentenceTrend);
    if (v === null) return "#95a5a6";
    return v < 15 ? "#27ae60" : v < 22 ? "#f39c12" : "#e74c3c";
  });
  let dialogueColor = $derived.by(() => {
    const v = lastValue(dialogueTrend);
    if (v === null) return "#95a5a6";
    return v > 0.3 ? "#27ae60" : v > 0.15 ? "#f39c12" : "#e74c3c";
  });
  let filterLabel = $derived.by(() => {
    const v = lastValue(filterTrend);
    return v === null ? "N/A" : (v * 100).toFixed(1) + "%";
  });
  let sentenceLabel = $derived.by(() => {
    const v = lastValue(sentenceTrend);
    return v === null ? "N/A" : v.toFixed(1) + " words";
  });
  let dialogueLabel = $derived.by(() => {
    const v = lastValue(dialogueTrend);
    return v === null ? "N/A" : (v * 100).toFixed(1) + "%";
  });

  function getTrendDirection(trend: [string, number][]): "up" | "down" | "flat" {
    if (trend.length < 2) return "flat";
    const first = trend[0][1];
    const last = trend[trend.length - 1][1];
    if (last > first * 1.05) return "up";
    if (last < first * 0.95) return "down";
    return "flat";
  }
  function trendArrow(trend: [string, number][]): string {
    const dir = getTrendDirection(trend);
    return dir === "up" ? "\u2191" : dir === "down" ? "\u2193" : "\u2192";
  }

  interface MetricSection {
    title: string;
    data: [string, number][];
    label: string;
    color: string;
    note: string;
  }

  let metricSections = $derived.by((): MetricSection[] => {
    const sections: MetricSection[] = [
      { title: "Dialogue Ratio", data: dialogueTrend, label: "Dialogue %", color: "#e74c3c", note: "Percentage of text in dialogue. Higher = more scene-driven." },
      { title: "Avg Sentence Length", data: sentenceTrend, label: "Words", color: "#3498db", note: "Average words per sentence. Lower = punchier prose." },
      { title: "Filter Words", data: filterTrend, label: "Filter %", color: "#f39c12", note: "Frequency of weak words (very, really, just, etc.). Lower = tighter prose." },
    ];
    if (repetitionTrend.length > 0) {
      sections.push({ title: "Repeated Constructions", data: repetitionTrend, label: "Count", color: "#9b59b6", note: "Repeated sentence starters and structural patterns. Lower = more varied syntax." });
    }
    return sections;
  });
</script>

<div class="craft-page">
  <div class="craft-header">
    <h1>Craft Analytics</h1>
    <div class="doc-selector">
      <Icon name="files" size={16} />
      <span class="doc-title">{$currentDoc?.title || "No document selected"}</span>
    </div>
  </div>

  {#if loading}
    <div class="craft-loading">Loading craft analytics...</div>
  {:else if error}
    <div class="craft-error">
      <Icon name="warn" size={20} />
      <span>{error}</span>
    </div>
  {:else if !$currentDoc}
    <div class="craft-empty">
      <Icon name="files" size={48} />
      <p>Open a document to see craft analytics</p>
    </div>
  {:else}
    <div class="craft-grid">
      {#each metricSections as section}
        <section class="craft-section">
          <header class="section-header">
            <h2>{section.title}</h2>
            <span class="trend-badge {getTrendDirection(section.data)}">{trendArrow(section.data)}</span>
          </header>
          <TrendlineChart data={section.data} label={section.label} color={section.color} />
          <p class="metric-note">{section.note}</p>
        </section>
      {/each}

      <section class="craft-section craft-summary">
        <h2>Craft Summary</h2>
        <div class="summary-grid">
          <div class="summary-card">
            <h3>Prose Tightness</h3>
            <p class="score" style="color: {filterColor}">{filterLabel}</p>
            <p class="label">Filter word frequency</p>
          </div>
          <div class="summary-card">
            <h3>Sentence Variety</h3>
            <p class="score" style="color: {sentenceColor}">{sentenceLabel}</p>
            <p class="label">Avg sentence length</p>
          </div>
          <div class="summary-card">
            <h3>Dialogue Balance</h3>
            <p class="score" style="color: {dialogueColor}">{dialogueLabel}</p>
            <p class="label">Dialogue ratio</p>
          </div>
        </div>
      </section>
    </div>
    {/if}
  </div>

<style>
  .craft-page {
    display: flex;
    flex-direction: column;
    height: 100%;
    padding: var(--space-4);
    gap: var(--space-4);
    overflow-y: auto;
  }

  .craft-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding-bottom: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .craft-header h1 {
    margin: 0;
    font-size: 20px;
  }

  .doc-selector {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    font-size: 13px;
    color: var(--text-secondary);
  }

  .doc-title {
    font-weight: 500;
    color: var(--text-primary);
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .craft-loading,
  .craft-error,
  .craft-empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    height: 100%;
    color: var(--text-muted);
    text-align: center;
    gap: var(--space-3);
  }

  .craft-error {
    color: var(--accent-semantic-red);
  }

  .craft-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
    gap: var(--space-4);
    flex: 1;
    overflow-y: auto;
  }

  .craft-section {
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: var(--space-2);
  }

  .section-header h2 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .trend-badge {
    font-size: 11px;
    padding: 1px 6px;
    border-radius: var(--radius-sm);
    font-weight: 600;
  }

  .trend-badge.up {
    background: #e74c3c22;
    color: #e74c3c;
  }

  .trend-badge.down {
    background: #27ae6022;
    color: #27ae60;
  }

  .trend-badge.flat {
    background: var(--surface-overlay);
    color: var(--text-muted);
  }

  .metric-note {
    margin: 0;
    font-size: 11px;
    color: var(--text-muted);
    font-style: italic;
  }

  .craft-summary {
    grid-column: 1 / -1;
  }

  .craft-summary h2 {
    margin: 0 0 var(--space-3);
    font-size: 14px;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: var(--space-3);
  }

  .summary-card {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    text-align: center;
  }

  .summary-card h3 {
    margin: 0 0 var(--space-2);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
  }

  .summary-card .score {
    margin: 0 0 var(--space-1);
    font-size: 20px;
    font-weight: 700;
  }

  .summary-card .label {
    margin: 0;
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
</style>
