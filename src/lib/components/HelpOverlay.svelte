<script lang="ts">
  /**
   * HelpOverlay — keyboard shortcut cheat sheet (? key, A9.4).
   * Shows shortcuts + short feature blurbs. Dismissable with ? or Esc.
   */
  import { settings } from "$lib/stores/settings";

  let visible = $state(false);

  const shortcuts = [
    { keys: "Ctrl+K", desc: "Command palette — fuzzy search docs, actions, AI ops" },
    { keys: "Ctrl+J", desc: "Toggle AI panel" },
    { keys: "Ctrl+N", desc: "New document" },
    { keys: "Ctrl+W", desc: "Close tab" },
    { keys: "Ctrl+Tab", desc: "Next tab" },
    { keys: "Ctrl+Shift+Tab", desc: "Previous tab" },
    { keys: "Ctrl+S", desc: "Force save to disk" },
    { keys: "Ctrl+Z", desc: "Undo" },
    { keys: "Ctrl+Shift+Z", desc: "Redo" },
    { keys: "M", desc: "Open Node Map" },
    { keys: "?", desc: "Toggle this help overlay" },
    { keys: "Esc", desc: "Close panel / modal / zen mode" },
  ];

  const features = [
    { name: "Logs", desc: "Daily journal entries, one per day, auto-created." },
    { name: "Just Write", desc: "Distraction-free writing with AI ghost, structurize, compose." },
    { name: "Node Map", desc: "Force-graph of all docs and their wikilink connections." },
    { name: "Novel Studio", desc: "Chapters, Story Bible, beat sheets, character sheets." },
    { name: "Script", desc: "Fountain screenplay format with scene navigator." },
    { name: "Projects", desc: "Task boards, kanban, table views with custom properties." },
    { name: "Reader", desc: "Reading mode for books and markdown files." },
    { name: "Inbox", desc: "Quick capture from any source — picks, thoughts, clips." },
    { name: "Canvas", desc: "Freeform board: cards, links, and doc-links, pan and zoom." },
    { name: "Library", desc: "Every document as table, board, or calendar, with saved views." },
    { name: "Files", desc: "Browse vault folder structure, open any file." },
    { name: "AI Panel", desc: "Chat, Composer, Ghost, Structurize — right docked panel." },
    { name: "Zen Mode", desc: "One keystroke hides all chrome, leaving only text." },
  ];

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "?" || (e.key === "/" && e.shiftKey)) {
      e.preventDefault();
      visible = !visible;
    } else if (e.key === "Escape" && visible) {
      visible = false;
    }
  }

  $effect(() => {
    window.addEventListener("keydown", handleKeydown);
    return () => window.removeEventListener("keydown", handleKeydown);
  });
</script>

{#if visible}
  <div class="help-overlay" onclick={(e) => { if (e.target === e.currentTarget) visible = false; }} onkeydown={(e) => { if (e.key === 'Escape') visible = false; }} role="presentation">
    <div class="help-panel" role="dialog" aria-label="Keyboard shortcuts" tabindex="-1">
      <div class="help-header">
        <h2>Keyboard Shortcuts & Features</h2>
        <button class="help-close" onclick={() => visible = false} aria-label="Close help">×</button>
      </div>
      <div class="help-body">
        <div class="help-section">
          <h3>Shortcuts</h3>
          <div class="shortcut-list">
            {#each shortcuts as s}
              <div class="shortcut-row">
                <kbd class="shortcut-keys">{s.keys}</kbd>
                <span class="shortcut-desc">{s.desc}</span>
              </div>
            {/each}
          </div>
        </div>
        <div class="help-section">
          <h3>Workspaces</h3>
          <div class="feature-list">
            {#each features as f}
              <div class="feature-row">
                <span class="feature-name">{f.name}</span>
                <span class="feature-desc">{f.desc}</span>
              </div>
            {/each}
          </div>
        </div>
        {#if $settings.aiPersona}
          <div class="help-section">
            <h3>AI Persona</h3>
            <p class="persona-preview">{$settings.aiPersona.slice(0, 200)}{$settings.aiPersona.length > 200 ? "..." : ""}</p>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .help-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }

  .help-panel {
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    width: 100%;
    max-width: 640px;
    max-height: 80vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .help-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
  }

  .help-header h2 {
    font-size: 16px;
    font-weight: 600;
    color: var(--text-primary);
  }

  .help-close {
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    border: none;
    background: transparent;
    color: var(--text-secondary);
    font-size: 20px;
    cursor: pointer;
    border-radius: var(--radius-md);
  }

  .help-close:hover {
    background: var(--surface-raised);
    color: var(--text-primary);
  }

  .help-body {
    padding: 20px;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 24px;
  }

  .help-section h3 {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 10px;
  }

  .shortcut-list, .feature-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .shortcut-row, .feature-row {
    display: flex;
    align-items: baseline;
    gap: 12px;
    padding: 4px 0;
  }

  .shortcut-keys {
    font-family: var(--font-mono);
    font-size: 12px;
    padding: 2px 6px;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    white-space: nowrap;
    flex-shrink: 0;
    min-width: 100px;
    text-align: center;
  }

  .shortcut-desc, .feature-desc {
    font-size: 13px;
    color: var(--text-secondary);
  }

  .feature-name {
    font-size: 13px;
    font-weight: 600;
    color: var(--text-primary);
    min-width: 100px;
    flex-shrink: 0;
  }

  .persona-preview {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
    line-height: 1.5;
  }

  @media (max-width: 600px) {
    .help-overlay { padding: 12px; }
    .help-panel { max-height: 90vh; }
    .shortcut-row { flex-direction: column; gap: 2px; }
    .shortcut-keys { min-width: auto; }
  }
</style>
