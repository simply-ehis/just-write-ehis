<script lang="ts">
  import { currentDoc } from '$lib/stores/app';
  import { showToast } from '$lib/stores/notifications';
  import { api } from '$lib/api';
  import Icon from '$lib/components/Icon.svelte';

  interface ExportPreset {
    id: string;
    name: string;
    format: string;
    description: string;
    icon: string;
  }

  let open = $state(false);
  let exporting = $state(false);
  let selectedFormat = $state('markdown');

  const presets: ExportPreset[] = [
    { id: 'markdown', name: 'Markdown', format: 'md', description: 'Plain Markdown with frontmatter', icon: 'file' },
    { id: 'html', name: 'HTML', format: 'html', description: 'Standalone HTML page', icon: 'globe' },
    { id: 'pdf', name: 'PDF', format: 'pdf', description: 'Print-ready PDF document', icon: 'file-text' },
    { id: 'docx', name: 'Word', format: 'docx', description: 'Microsoft Word document', icon: 'file-text' },
    { id: 'epub', name: 'ePub', format: 'epub', description: 'E-book format for e-readers', icon: 'book' },
    { id: 'txt', name: 'Plain Text', format: 'txt', description: 'Simple text file', icon: 'file' },
  ];

  function openPanel() { open = true; }
  function closePanel() { open = false; }

  async function exportDoc(preset: ExportPreset) {
    if (!$currentDoc) {
      showToast('No document selected', 'warning');
      return;
    }
    exporting = true;
    try {
      const result = await api.convertDocument($currentDoc.id, preset.format);
      showToast(`Exported as ${preset.name}`, 'success');
      closePanel();
    } catch (e) {
      showToast(`Export failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      exporting = false;
    }
  }

  async function exportAll() {
    if (!$currentDoc) {
      showToast('No document selected', 'warning');
      return;
    }
    exporting = true;
    try {
      const result = await api.batchExport([$currentDoc.id], selectedFormat);
      showToast(`Exported as ${selectedFormat.toUpperCase()}`, 'success');
      closePanel();
    } catch (e) {
      showToast(`Export failed: ${e instanceof Error ? e.message : e}`, 'error');
    } finally {
      exporting = false;
    }
  }
</script>

<button class="export-trigger icon-btn" onclick={openPanel} title="Export" aria-label="Open export presets">
  <Icon name="download" size={15} />
</button>

{#if open}
  <div class="export-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="export-panel" role="dialog" aria-label="Export presets" tabindex="-1">
      <div class="panel-header">
        <h2>Export Document</h2>
        <button class="close-btn" onclick={closePanel}>&times;</button>
      </div>
      <div class="export-content">
        {#if exporting}
          <div class="exporting">Exporting...</div>
        {:else}
          <div class="preset-grid">
            {#each presets as preset}
              <button class="preset-card" onclick={() => exportDoc(preset)}>
                <Icon name={preset.icon} size={24} />
                <span class="preset-name">{preset.name}</span>
                <span class="preset-desc">{preset.description}</span>
              </button>
            {/each}
          </div>
          <div class="export-all">
            <select bind:value={selectedFormat} aria-label="Export format">
              {#each presets as preset}
                <option value={preset.format}>{preset.name}</option>
              {/each}
            </select>
            <button class="export-all-btn" onclick={exportAll}>Export All</button>
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .export-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .export-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .export-panel {
    width: min(560px, 90vw);
    background: var(--surface-base);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .panel-header h2 {
    font-family: var(--font-heading);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
  }

  .close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 18px;
    cursor: pointer;
  }

  .export-content {
    padding: 20px;
  }

  .exporting {
    text-align: center;
    color: var(--text-muted);
    padding: 40px 0;
  }

  .preset-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }

  .preset-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    cursor: pointer;
    transition: border-color 0.1s;
  }

  .preset-card:hover {
    border-color: var(--accent-primary);
  }

  .preset-name {
    font-size: 13px;
    font-weight: var(--font-weight-semibold);
  }

  .preset-desc {
    font-size: 11px;
    color: var(--text-muted);
    text-align: center;
  }

  .export-all {
    display: flex;
    gap: 8px;
    align-items: center;
  }

  .export-all select {
    flex: 1;
    padding: 8px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-primary);
    font-size: 13px;
  }

  .export-all-btn {
    padding: 8px 16px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 13px;
    cursor: pointer;
  }
</style>
