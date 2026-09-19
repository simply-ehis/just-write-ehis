<script lang="ts">
  import { api } from "$lib/api";
  import { currentDoc, currentWorkspace, showSettings } from "$lib/stores/app";
  import { settings } from "$lib/stores/settings";
  import { showToast } from "$lib/stores/notifications";
  import { markUsed } from "$lib/features";
  import Icon from "./Icon.svelte";
  import TrendlineChart from "./TrendlineChart.svelte";

  interface PowerFeature {
    feature: string;
    label: string;
    desc: string;
    workspace: string | null;
    shortcut?: string;
  }

  // Same feature keys as SkillNudges.svelte so hints and this page agree.
  const catalog: PowerFeature[] = [
    { feature: "map", label: "Node Map", desc: "See your doc connections as a graph.", workspace: "map", shortcut: "M" },
    { feature: "composer", label: "Composer", desc: "Rewrite and transform your prose with AI.", workspace: "write", shortcut: "AI Panel" },
    { feature: "structurize", label: "Structurize", desc: "Turn raw notes into structured docs with {directives}.", workspace: "write" },
    { feature: "ghost", label: "Ghost mode", desc: "Autocomplete as you type — enable in Settings.", workspace: null, shortcut: "Settings" },
    { feature: "palette", label: "Command Palette", desc: "Every action at your fingertips.", workspace: null, shortcut: "Ctrl+K" },
    { feature: "export", label: "Export", desc: "Markdown, HTML, Word, eBook, or PDF.", workspace: "write" },
    { feature: "craft", label: "Craft analytics", desc: "Dialogue, sentence, and filter-word trends.", workspace: "craft" },
  ];

  let dialogueTrend = $state<[string, number][]>([]);
  let sentenceTrend = $state<[string, number][]>([]);
  let filterTrend = $state<[string, number][]>([]);
  let loading = $state(true);

  $effect(() => {
    const doc = $currentDoc;
    dialogueTrend = [];
    sentenceTrend = [];
    filterTrend = [];
    if (!doc || doc.locked) {
      loading = false;
      return;
    }
    loading = true;
    const docId = doc.id;
    Promise.all([
      api.craftMetricsTrend(docId, "dialogue_ratio"),
      api.craftMetricsTrend(docId, "avg_sentence_length"),
      api.craftMetricsTrend(docId, "filter_words"),
    ])
      .then(([d, s, f]) => {
        if ($currentDoc?.id !== docId) return;
        dialogueTrend = d;
        sentenceTrend = s;
        filterTrend = f;
      })
      .catch(() => {})
      .finally(() => {
        if ($currentDoc?.id === docId) loading = false;
      });
  });

  function tryFeature(pf: PowerFeature) {
    markUsed(pf.feature);
    if (pf.workspace === null && pf.feature === "ghost") {
      $showSettings = true;
    } else if (pf.workspace === null) {
      showToast("Press Ctrl+K anywhere to open the Command Palette", "info");
    } else {
      $currentWorkspace = pf.workspace;
    }
  }

  function restoreNudge(id: string) {
    const current = $settings;
    settings.set({ ...current, dismissedNudges: current.dismissedNudges.filter((n) => n !== id) });
    showToast("Hint restored — it may reappear when relevant", "info");
  }
</script>

<div class="skills-page">
  <div class="skills-header">
    <h1>Skills</h1>
    <span class="doc-title">{$currentDoc?.title || "No document selected"}</span>
  </div>

  <section class="skills-section">
    <h2>Power features</h2>
    <p class="section-hint">Unused features surface as gentle nudges. Try one to retire its hint forever.</p>
    <div class="feature-list">
      {#each catalog as pf}
        {@const used = $settings.featuresUsed.includes(pf.feature)}
        <div class="feature-card" class:used>
          <div class="feature-info">
            <span class="feature-label">
              {#if used}
                <Icon name="check" size={14} />
              {:else}
                <Icon name="sparkle" size={14} />
              {/if}
              {pf.label}
            </span>
            <span class="feature-desc">{pf.desc}</span>
          </div>
          <div class="feature-side">
            {#if pf.shortcut}
              <span class="feature-shortcut">{pf.shortcut}</span>
            {/if}
            {#if used}
              <span class="feature-used">In use</span>
            {:else}
              <button class="icon-btn" onclick={() => tryFeature(pf)} title="Try {pf.label}" aria-label="Try {pf.label}">
                <Icon name="arrow-right" size={14} />
              </button>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section class="skills-section">
    <h2>Craft trends</h2>
    {#if loading}
      <div class="skills-loading">Loading craft trends...</div>
    {:else if !$currentDoc}
      <div class="skills-empty">
        <p>Open a document to see its craft trends.</p>
      </div>
    {:else}
      <div class="trend-row">
        <TrendlineChart data={dialogueTrend} label="Dialogue Ratio" />
        <TrendlineChart data={sentenceTrend} label="Avg Sentence Length" color="#6e8efb" />
        <TrendlineChart data={filterTrend} label="Filter Words" color="#f39c12" />
      </div>
      <button class="link-btn" onclick={() => ($currentWorkspace = "craft")}>
        Open full Craft analytics <Icon name="arrow-right" size={13} />
      </button>
    {/if}
  </section>

  <section class="skills-section">
    <h2>Dismissed hints</h2>
    {#if $settings.dismissedNudges.length === 0}
      <p class="section-hint">Nothing dismissed. Hints you dismiss land here so you can bring them back.</p>
    {:else}
      <div class="dismissed-list">
        {#each $settings.dismissedNudges as id}
          <div class="dismissed-item">
            <span class="dismissed-id">{id}</span>
            <button class="icon-btn" onclick={() => restoreNudge(id)} title="Restore hint" aria-label="Restore hint {id}">
              <Icon name="refresh" size={14} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </section>
</div>

<style>
  .skills-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    height: 100%;
    overflow-y: auto;
    padding: var(--space-4);
  }

  .skills-header {
    display: flex;
    align-items: baseline;
    gap: var(--space-3);
  }

  .skills-header h1 {
    margin: 0;
    font-size: 20px;
  }

  .doc-title {
    font-size: 12px;
    color: var(--text-muted);
  }

  .skills-section h2 {
    margin: 0 0 var(--space-1) 0;
    font-size: 14px;
  }

  .section-hint {
    margin: 0 0 var(--space-2) 0;
    font-size: 12px;
    color: var(--text-muted);
  }

  .feature-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .feature-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
  }

  .feature-card.used {
    opacity: 0.65;
  }

  .feature-info {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .feature-label {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
    font-weight: 600;
  }

  .feature-desc {
    font-size: 12px;
    color: var(--text-secondary);
  }

  .feature-side {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    flex-shrink: 0;
  }

  .feature-shortcut {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
  }

  .feature-used {
    font-size: 11px;
    color: var(--text-muted);
  }

  .trend-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
  }

  .link-btn {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    margin-top: var(--space-2);
    font-size: 12px;
    color: var(--accent-primary);
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
  }

  .skills-loading,
  .skills-empty {
    font-size: 12px;
    color: var(--text-muted);
  }

  .skills-empty p {
    margin: 0;
  }

  .dismissed-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .dismissed-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px var(--space-2);
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--text-muted);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
  }
</style>
