<script lang="ts">
  import { api } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";

  let { docId }: { docId: string } = $props();
  let tags = $state<string[]>([]);
  let draft = $state("");
  let busy = $state(false);

  $effect(() => {
    const id = docId;
    let active = true;
    api.getDocTags(id)
      .then((result) => { if (active) tags = result; })
      .catch(() => { if (active) tags = []; });
    return () => { active = false; };
  });

  async function addTag() {
    const tag = draft.trim().replace(/^#/, "");
    if (!tag || busy || tags.some((item) => item.toLowerCase() === tag.toLowerCase())) return;
    busy = true;
    try {
      await api.addDocTag(docId, tag);
      tags = [...tags, tag].sort((a, b) => a.localeCompare(b));
      draft = "";
    } catch (error) {
      showToast(`Couldn't add tag: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      busy = false;
    }
  }

  async function removeTag(tag: string) {
    if (busy) return;
    busy = true;
    try {
      await api.removeDocTag(docId, tag);
      tags = tags.filter((item) => item !== tag);
    } catch (error) {
      showToast(`Couldn't remove tag: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      busy = false;
    }
  }
</script>

<div class="tag-bar" role="group" aria-label="Document tags">
  <span class="tag-label">Tags</span>
  {#each tags as tag (tag)}
    <span class="tag-chip">
      <span>#{tag}</span>
      <button onclick={() => removeTag(tag)} disabled={busy} aria-label={`Remove tag ${tag}`}>×</button>
    </span>
  {/each}
  <form onsubmit={(event) => { event.preventDefault(); void addTag(); }}>
    <input bind:value={draft} maxlength="48" placeholder="Add a tag" aria-label="Add a tag" disabled={busy} />
    {#if draft.trim()}
      <button type="submit" disabled={busy} aria-label="Save tag">Add</button>
    {/if}
  </form>
</div>

<style>
  .tag-bar {
    display: flex;
    align-items: center;
    gap: 6px;
    min-height: 34px;
    padding: 4px 16px;
    border-top: 1px solid var(--border-subtle);
    background: var(--surface-base);
    overflow-x: auto;
    flex-shrink: 0;
  }

  .tag-label { color: var(--text-muted); font-size: 11px; }
  .tag-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 7px;
    border: 1px solid var(--border-subtle);
    border-radius: 999px;
    color: var(--text-secondary);
    font-size: 11px;
    white-space: nowrap;
  }
  .tag-chip button, form button {
    border: 0;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
  }
  form { display: inline-flex; align-items: center; gap: 4px; }
  form input {
    width: 96px;
    border: 0;
    outline: 0;
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: 11px;
  }
  form input::placeholder { color: var(--text-muted); }
</style>
