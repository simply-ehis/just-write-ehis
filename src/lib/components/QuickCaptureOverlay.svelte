<script lang="ts">
  /**
   * QuickCaptureOverlay — global capture (Ctrl+Shift+F) into Inbox.
   * Solid docked panel (no floating icons, no transparency).
   */
  import { api } from "$lib/api";
  import { currentDoc, openTabs, currentWorkspace } from "$lib/stores/app";
  import { showToast } from "$lib/stores/notifications";

  let open = $state(false);
  let text = $state("");
  let target = $state("inbox");
  let saving = $state(false);
  let inputEl = $state<HTMLInputElement | null>(null);

  const targets = ["inbox", "logs", "write", "novel", "script", "projects", "reader"];

  function launch() {
    open = true;
    text = "";
    setTimeout(() => inputEl?.focus(), 10);
  }

  function close() {
    open = false;
    text = "";
    saving = false;
  }

  async function save() {
    const body = text.trim();
    if (!body || saving) return;
    saving = true;
    try {
      const title = body.slice(0, 80);
      const doc = await api.docCreate(target, target === "inbox" ? "snippet" : "doc", title, undefined, body);
      $currentDoc = doc;
      $currentWorkspace = target;
      if (!$openTabs.find((t) => t.id === doc.id)) $openTabs = [doc, ...$openTabs];
      showToast(`Captured to ${target}`, "success");
      close();
    } catch (e) {
      showToast(`Capture failed: ${e instanceof Error ? e.message : e}`, "error");
      saving = false;
    }
  }

  function handleKey(e: KeyboardEvent) {
    if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "F" || e.key === "f")) {
      e.preventDefault();
      if (open) close();
      else launch();
    } else if (e.key === "Escape" && open) {
      close();
    }
  }

  $effect(() => {
    window.addEventListener("keydown", handleKey);
    const fromBar = () => launch();
    window.addEventListener("open-quick-capture", fromBar);
    return () => {
      window.removeEventListener("keydown", handleKey);
      window.removeEventListener("open-quick-capture", fromBar);
    };
  });
</script>

{#if open}
  <div class="qc-overlay" onclick={(e) => { if (e.target === e.currentTarget) close(); }} role="presentation" onkeydown={(e) => { if (e.key === "Escape") close(); }}>
    <div class="qc-panel" role="dialog" aria-label="Quick capture" tabindex="-1">
      <div class="qc-header">
        <span class="qc-title">Quick capture</span>
        <span class="qc-hint">Ctrl+Shift+F · Esc closes</span>
      </div>
      <div class="qc-row">
        <input
          bind:this={inputEl}
          bind:value={text}
          placeholder="Capture to inbox… (Enter saves)"
          aria-label="Quick capture text"
          disabled={saving}
          onkeydown={(e) => { if (e.key === "Enter") save(); }}
        />
        <select bind:value={target} title="Capture target" aria-label="Capture target" disabled={saving}>
          {#each targets as t}
            <option value={t}>{t}</option>
          {/each}
        </select>
        <button class="qc-save" onclick={save} disabled={saving || !text.trim()}>
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  </div>
{/if}

<style>
  .qc-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    justify-content: center;
    padding-top: 12vh;
    z-index: 400;
  }

  .qc-panel {
    width: min(560px, 92vw);
    height: fit-content;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .qc-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .qc-title {
    font-size: 13px;
    font-weight: 600;
  }

  .qc-hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  .qc-row {
    display: flex;
    gap: 8px;
  }

  .qc-row input {
    flex: 1;
    height: 34px;
  }

  .qc-row select {
    height: 34px;
    font-size: 12px;
  }

  .qc-save {
    height: 34px;
    padding: 0 14px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: 12px;
    white-space: nowrap;
  }

  .qc-save:disabled {
    opacity: 0.5;
  }
</style>
