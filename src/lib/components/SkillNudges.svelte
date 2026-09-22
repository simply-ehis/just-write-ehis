<script lang="ts">
  import { settings } from "$lib/stores/settings";
  import { currentDoc } from "$lib/stores/app";
  import { api } from "$lib/api";
  import { dismissNudge } from "$lib/features";

  interface Nudge {
    id: string;
    feature: string;
    message: string;
    shortcut?: string;
  }

  const allNudges: Nudge[] = [
    { id: "nodemap", feature: "map", message: "Try the Node Map to see your doc connections", shortcut: "M" },
    { id: "composer", feature: "composer", message: "Composer mode can rewrite and transform your prose", shortcut: "AI Panel" },
    { id: "structurize", feature: "structurize", message: "Structurize turns raw notes into structured docs with {directives}" },
    { id: "ghost", feature: "ghost", message: "Ghost mode autocompletes as you type — enable in Settings" },
    { id: "commandpalette", feature: "palette", message: "Command Palette gives you every action at your fingertips", shortcut: "Ctrl+K" },
    { id: "export", feature: "export", message: "Export any doc — Markdown, HTML, Word, eBook, or PDF" },
  ];

  let currentNudge = $state<Nudge | null>(null);
  let nudgeIdx = $state(0);
  let craftNudge = $state<Nudge | null>(null);

  $effect(() => {
    const used = $settings.featuresUsed;
    const dismissed = $settings.dismissedNudges;
    const available = allNudges.filter(
      (n) => !used.includes(n.feature) && !dismissed.includes(n.id)
    );
    // A timely craft observation beats the feature rotation.
    if (craftNudge && !dismissed.includes(craftNudge.id)) {
      currentNudge = craftNudge;
    } else if (available.length > 0) {
      currentNudge = available[nudgeIdx % available.length];
    } else {
      currentNudge = null;
    }
  });

  // Craft skill: filter-word frequency creeping up over recent sessions
  // surfaces once, gently — then never again for that doc.
  $effect(() => {
    const doc = $currentDoc;
    craftNudge = null;
    if (!doc || doc.locked) return;
    const docId = doc.id;
    const dismissId = `craft-filter-${docId}`;
    if ($settings.dismissedNudges.includes(dismissId)) return;
    api.craftMetricsTrend(docId, "filter_words")
      .then((trend) => {
        if ($currentDoc?.id !== docId || trend.length < 5) return;
        const first = trend[0][1];
        const last = trend[trend.length - 1][1];
        if (last > 0.02 && last >= first * 1.2 && last - first >= 0.005) {
          craftNudge = {
            id: dismissId,
            feature: "craft",
            message: `Filter words have crept up in “${doc.title}” (${(first * 100).toFixed(1)}% → ${(last * 100).toFixed(1)}%). Nothing to fix mid-draft — just a heads-up.`,
          };
        }
      })
      .catch((e) => {
        console.warn("Skill nudge load failed:", e);
      });
  });

  function dismiss(id: string) {
    dismissNudge(id);
    nudgeIdx++;
  }
</script>

{#if currentNudge}
  <div class="skill-nudge">
    <span class="nudge-text">
      {currentNudge.message}
      {#if currentNudge.shortcut}
        <span class="nudge-shortcut">{currentNudge.shortcut}</span>
      {/if}
    </span>
    <button class="nudge-dismiss" onclick={() => dismiss(currentNudge!.id)}>&times;</button>
  </div>
{/if}

<style>
  .skill-nudge {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-left: 3px solid var(--accent-primary);
    border-radius: var(--radius-md);
    font-size: 12px;
    color: var(--text-secondary);
    margin: 4px 8px;
  }

  .nudge-text {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .nudge-shortcut {
    font-family: var(--font-mono);
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 3px;
    background: var(--surface-overlay);
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
  }

  .nudge-dismiss {
    width: 20px;
    height: 20px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    font-size: 12px;
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .nudge-dismiss:hover {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }
</style>
