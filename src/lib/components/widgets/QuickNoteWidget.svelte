<script lang="ts">
  /**
   * QuickNoteWidget: ONE job. Type a thought, press Ctrl+Enter, it lands in
   * today's log. No calendar, no day list, no editor, no other tabs.
   *
   * The unsent draft survives hiding the widget or quitting (a note you typed
   * and did not save is never silently lost), and a failed save keeps the
   * text so it can be retried.
   */
  import { onDestroy, onMount } from "svelte";
  import { api } from "$lib/api";
  import { appendNote, clock, dayKey, recentNotes } from "$lib/widgets/quickNote";

  const DRAFT_KEY = "jwe-widget-quicknote-draft";

  function readDraft(): string {
    try {
      return localStorage.getItem(DRAFT_KEY) ?? "";
    } catch {
      return "";
    }
  }
  function writeDraft(value: string) {
    try {
      if (value) localStorage.setItem(DRAFT_KEY, value);
      else localStorage.removeItem(DRAFT_KEY);
    } catch {
      /* storage unavailable: the draft just won't persist */
    }
  }

  let text = $state(readDraft());
  let saving = $state(false);
  let error = $state("");
  let savedAt = $state("");
  let recent = $state<{ time: string; text: string }[]>([]);
  let input = $state<HTMLTextAreaElement>();
  let draftTimer: ReturnType<typeof setTimeout> | null = null;

  $effect(() => {
    const value = text;
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => writeDraft(value), 250);
  });

  onMount(() => input?.focus());
  onDestroy(() => {
    if (draftTimer) clearTimeout(draftTimer);
    writeDraft(text);
  });

  async function save() {
    const body = text.trim();
    if (!body || saving) return;
    saving = true;
    error = "";
    try {
      const now = new Date();
      // Fetch the day's log fresh right before appending, so a note written
      // in the main app a moment ago is never overwritten with stale text.
      const doc = await api.logGetOrCreate(dayKey(now));
      const updated = await api.docSave(doc.id, undefined, appendNote(doc.content, clock(now), body));
      recent = recentNotes(updated.content, 2);
      savedAt = clock(now);
      text = "";
      writeDraft("");
      input?.focus();
    } catch (e) {
      error = `Couldn't save: ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      saving = false;
    }
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void save();
    }
  }
</script>

<section class="quicknote">
  <textarea
    bind:this={input}
    bind:value={text}
    onkeydown={onKeydown}
    placeholder="Jot something down…"
    aria-label="Note for today's log"
    disabled={saving}
  ></textarea>
  <div class="row">
    <span class="status" role="status" aria-live="polite">
      {#if error}
        <span class="err">{error}</span>
      {:else if savedAt}
        Saved {savedAt}
      {:else}
        Ctrl+Enter to save
      {/if}
    </span>
    <button class="save" onclick={save} disabled={!text.trim() || saving}>{saving ? "Saving…" : "Add to today"}</button>
  </div>
  {#if recent.length}
    <ul class="recent" aria-label="Notes added this session">
      {#each recent as note}
        <li><time>{note.time}</time><span>{note.text}</span></li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .quicknote { display: flex; flex-direction: column; gap: 8px; height: 100%; padding: 10px; box-sizing: border-box; }
  textarea {
    flex: 1;
    min-height: 56px;
    resize: none;
    padding: 8px 10px;
    border: 1px solid var(--border, rgb(128 128 128 / 40%));
    border-radius: var(--radius-sm, 6px);
    background: var(--surface-raised, #fffdf8);
    color: var(--text-primary, #1a1a1a);
    font: inherit;
    font-size: 14px;
    line-height: 1.5;
  }
  textarea:focus-visible { outline: 2px solid var(--accent-primary, #b8860b); outline-offset: -1px; }
  .row { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
  .status { min-width: 0; overflow: hidden; color: var(--text-muted, #777); font-size: 12px; text-overflow: ellipsis; white-space: nowrap; }
  .err { color: var(--accent-semantic-red, #c0392b); white-space: normal; }
  .save {
    flex-shrink: 0;
    padding: 5px 12px;
    border: 1px solid var(--accent-primary, #b8860b);
    border-radius: var(--radius-sm, 6px);
    background: transparent;
    color: var(--accent-primary, #b8860b);
    font-size: 12px;
    cursor: pointer;
  }
  .save:hover:not(:disabled) { background: var(--accent-primary, #b8860b); color: var(--surface-base, #fff); }
  .save:disabled { opacity: 0.45; cursor: default; }
  .recent { margin: 0; padding: 0; list-style: none; max-height: 72px; overflow: auto; border-top: 1px solid var(--border-subtle, rgb(128 128 128 / 25%)); }
  .recent li { display: flex; gap: 8px; padding: 4px 0; color: var(--text-secondary, #555); font-size: 12px; }
  .recent time { flex-shrink: 0; color: var(--text-muted, #777); font-variant-numeric: tabular-nums; }
  .recent span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  /* Small widget: the note box matters, the history does not. */
  @media (max-height: 260px) { .recent { display: none; } }
</style>
