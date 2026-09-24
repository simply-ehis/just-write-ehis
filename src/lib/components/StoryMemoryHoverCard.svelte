<script lang="ts">
  import Icon from "$lib/components/Icon.svelte";
  import type { BibleMention } from "$lib/api";
  import type { StoryMemoryView } from "$lib/storyMemoryEditor";

  let {
    visible = $bindable(false),
    position = $bindable({ x: 0, y: 0 }),
    entity = $bindable<StoryMemoryView | null>(null),
    onJump,
  }: {
    visible: boolean;
    position: { x: number; y: number };
    entity: StoryMemoryView | null;
    onJump: (mention: BibleMention) => void;
  } = $props();
</script>

{#if visible && entity}
  <div
    class="story-memory-card"
    style={`left: ${Math.min(position.x, Math.max(16, window.innerWidth - 340))}px; top: ${position.y + 10}px;`}
    role="dialog"
    aria-label={`Story Bible memory for ${entity.fact.key}`}
  >
    <div class="story-memory-head">
      <div>
        <strong>{entity.fact.key}</strong>
        <span class="story-memory-kind">{entity.fact.kind.replaceAll("_", " ")}</span>
      </div>
      <span class="story-memory-count">{entity.appearances.length} appearance{entity.appearances.length === 1 ? "" : "s"}</span>
    </div>
    <div class="story-memory-canonical">
      <span>Canonical</span>
      <strong>{entity.fact.value || "No trait value recorded"}</strong>
    </div>
    {#if entity.contradictions.length > 0}
      <div class="story-memory-warning">
        <Icon name="warn" size={14} />
        <span>Contradiction{entity.contradictions.length === 1 ? "" : "s"} detected</span>
      </div>
      {#each entity.contradictions as contradiction}
        <div class="story-memory-conflict">
          <span class="story-memory-attribute">{contradiction.attributeKey}</span>
          {#each contradiction.values as value}
            <button onclick={() => onJump(value.mentions[0])}>{value.value} · {value.mentions[0]?.doc_title}</button>
          {/each}
        </div>
      {/each}
    {/if}
    <div class="story-memory-appearances-label">Top appearances</div>
    <div class="story-memory-appearances">
      {#each entity.appearances.slice(0, 5) as mention}
        <button class="story-memory-appearance" onclick={() => onJump(mention)}>
          <span>{mention.doc_title}</span>
          <small>{mention.snippet}</small>
        </button>
      {/each}
      {#if entity.appearances.length === 0}
        <div class="story-memory-empty">No saved evidence yet</div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .story-memory-card {
    position: fixed;
    z-index: 1100;
    width: 320px;
    max-height: 360px;
    overflow-y: auto;
    padding: 12px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    box-shadow: var(--shadow-md);
    color: var(--text-primary);
  }

  .story-memory-head,
  .story-memory-canonical,
  .story-memory-warning {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }

  .story-memory-head {
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .story-memory-head strong,
  .story-memory-canonical strong {
    display: block;
    font-size: 13px;
  }

  .story-memory-kind,
  .story-memory-count,
  .story-memory-canonical span,
  .story-memory-appearances-label,
  .story-memory-attribute {
    color: var(--text-muted);
    font-size: 10px;
  }

  .story-memory-kind {
    display: block;
    margin-top: 2px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .story-memory-canonical {
    align-items: flex-start;
    padding: 9px 0;
  }

  .story-memory-canonical strong {
    color: var(--text-secondary);
    font-size: 11px;
    font-weight: 500;
    text-align: right;
  }

  .story-memory-warning {
    justify-content: flex-start;
    padding: 7px 8px;
    border: 1px solid var(--accent-semantic-yellow);
    border-radius: var(--radius-sm);
    color: var(--accent-semantic-yellow);
    font-size: 11px;
  }

  .story-memory-conflict {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 6px;
  }

  .story-memory-conflict button {
    max-width: 100%;
    overflow: hidden;
    padding: 3px 6px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-overlay);
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 10px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .story-memory-attribute {
    width: 100%;
    font-weight: 600;
  }

  .story-memory-appearances-label {
    margin: 10px 0 4px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }

  .story-memory-appearances {
    display: flex;
    flex-direction: column;
    gap: 3px;
  }

  .story-memory-appearance {
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 5px 6px;
    border: 1px solid transparent;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
    text-align: left;
  }

  .story-memory-appearance:hover {
    border-color: var(--border-subtle);
    background: var(--surface-overlay);
  }

  .story-memory-appearance span {
    color: var(--accent-primary);
    font-size: 10px;
    font-weight: 600;
  }

  .story-memory-appearance small,
  .story-memory-empty {
    color: var(--text-muted);
    font-size: 10px;
    line-height: 1.35;
  }
</style>
