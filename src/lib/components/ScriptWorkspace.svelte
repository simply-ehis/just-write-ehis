<script lang="ts">
  import { api, type Doc } from '$lib/api';
  import { currentDoc, openTabs } from '$lib/stores/app';
  import { settings } from '$lib/stores/settings';
  import { showToast } from '$lib/stores/notifications';
  import MicButton from '$lib/components/MicButton.svelte';
  import ReadAloudButton from '$lib/components/ReadAloudButton.svelte';
  import DeleteButton from '$lib/components/DeleteButton.svelte';
  import Icon from '$lib/components/Icon.svelte';
  import { downloadConvertOutput } from '$lib/download';
  import { readImportFile } from '$lib/importFile';

  let scripts = $state<Doc[]>([]);
  let selectedScript = $state<Doc | null>(null);
  let rawContent = $state('');
  let parsedElements = $state<FountainElement[]>([]);
  let viewMode = $state<'edit' | 'screenplay'>('edit');
  let loading = $state(false);
  let showCast = $state(false);
  let roles = $state<Array<{ id: string; name: string; color: string; assignedTo: string }>>([]);
  let newRoleName = $state('');
  let newRoleColor = $state('#8FC7A9');
  let listCollapsed = $state(false);
  // Debounce handle: plain let, only touched in event handlers (never in
  // an $effect), so it can't resubscribe anything.
  let saveTimer: ReturnType<typeof setTimeout> | null = null;

  let showExportMenu = $state(false);
  let exportFormats = $state<string[]>(["md", "txt", "html"]);
  let exportMenuLoaded = $state(false);
  let importInput = $state<HTMLInputElement | null>(null);

  function exportLabel(format: string): string {
    switch (format) {
      case 'md': return 'Markdown (.md)';
      case 'txt': return 'Plain Text (.txt)';
      case 'html': return 'HTML (.html)';
      case 'docx': return 'Word (.docx)';
      case 'epub': return 'eBook (.epub)';
      case 'pdf': return 'PDF (.pdf)';
      default: return format;
    }
  }

  async function toggleExportMenu() {
    showExportMenu = !showExportMenu;
    if (showExportMenu && !exportMenuLoaded) {
      try {
        const status = await api.convertStatus();
        exportFormats = status.formats;
      } catch {
        exportFormats = ["md", "txt", "html"];
      }
      exportMenuLoaded = true;
    }
  }

  async function exportAs(format: string) {
    if (!selectedScript) return;
    showExportMenu = false;
    if (format === 'fountain') {
      const content = rawContent;
      const title = selectedScript.title || 'untitled';
      const blob = new Blob([content], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${title}.fountain`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    try {
      await api.docSave(selectedScript.id, undefined, rawContent);
      const out = await api.convertRun(selectedScript.id, format);
      downloadConvertOutput(out);
      showToast(`Exported ${out.filename}`, 'success');
    } catch (e) {
      showToast(`Export failed: ${e instanceof Error ? e.message : e}`, 'error');
    }
  }

  interface FountainElement {
    type: 'title_page' | 'scene_heading' | 'action' | 'character' | 'dialogue' | 'parenthetical' | 'transition' | 'centered' | 'note' | 'empty';
    content: string;
    raw: string;
  }

  async function loadScripts() {
    loading = true;
    try {
      scripts = await api.docListByWorkspace('script');
    } catch (e) {
      console.error('Failed to load scripts:', e);
    } finally {
      loading = false;
    }
  }

  async function selectScript(doc: Doc) {
    // Flush the outgoing script first — unsaved typing must not die on switch.
    if (selectedScript && selectedScript.id !== doc.id) {
      try {
        await api.docSave(selectedScript.id, undefined, rawContent);
      } catch (e) {
        console.error('Failed to save outgoing script:', e);
      }
    }
    selectedScript = doc;
    rawContent = doc.content || '';
    parsedElements = parseFountain(rawContent);
    $currentDoc = doc;
    if (!$openTabs.find((t) => t.id === doc.id)) $openTabs = [doc, ...$openTabs];
    loadRoles(doc.id);
  }

  async function loadRoles(docId: string) {
    try {
      const list = await api.scriptRoleList(docId);
      roles = Array.isArray(list) ? list : [];
    } catch {
      roles = [];
    }
  }

  /** Cast auto-detected from the script: unique character cues + line counts. */
  let castList = $derived.by(() => {
    const counts = new Map<string, number>();
    let current: string | null = null;
    for (const el of parsedElements) {
      if (el.type === 'character') {
        current = el.content.replace(/\.$/, '').trim();
        if (!counts.has(current)) counts.set(current, 0);
      } else if (el.type === 'dialogue' && current) {
        counts.set(current, (counts.get(current) ?? 0) + 1);
      } else if (el.type !== 'parenthetical') {
        current = null;
      }
    }
    return [...counts.entries()]
      .map(([name, lines]) => ({ name, lines }))
      .sort((a, b) => b.lines - a.lines);
  });

  async function addRole() {
    if (!selectedScript || !newRoleName.trim()) return;
    try {
      const res = await api.scriptRoleCreate(selectedScript.id, newRoleName.trim(), newRoleColor);
      roles = [...roles, res.role];
      newRoleName = '';
    } catch (e) {
      console.error('Failed to add role:', e);
    }
  }

  async function assignRole(roleId: string, assignedTo: string) {
    if (!selectedScript) return;
    try {
      await api.scriptRoleAssign(selectedScript.id, roleId, assignedTo);
      roles = roles.map((r) => (r.id === roleId ? { ...r, assignedTo } : r));
    } catch (e) {
      console.error('Failed to assign role:', e);
    }
  }

  async function deleteRole(roleId: string) {
    if (!selectedScript) return;
    try {
      await api.scriptRoleDelete(selectedScript.id, roleId);
      roles = roles.filter((r) => r.id !== roleId);
    } catch (e) {
      console.error('Failed to delete role:', e);
    }
  }

  function roleColorFor(characterName: string): string {
    const role = roles.find((r) => r.name.toLowerCase() === characterName.toLowerCase());
    return role?.color ?? 'var(--text-muted)';
  }

  function parseFountain(text: string): FountainElement[] {
    const lines = text.split('\n');
    const elements: FountainElement[] = [];
    let inTitlePage = false;
    let titlePageLines: string[] = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];
      const trimmed = line.trim();

      if (i === 0 && trimmed.match(/^[A-Z ]+:/)) {
        inTitlePage = true;
      }

      if (inTitlePage) {
        if (trimmed === '') {
          inTitlePage = false;
          elements.push({ type: 'title_page', content: titlePageLines.join('\n'), raw: titlePageLines.join('\n') });
          titlePageLines = [];
        } else {
          titlePageLines.push(line);
        }
        i++;
        continue;
      }

      if (trimmed === '') {
        elements.push({ type: 'empty', content: '', raw: line });
        i++;
        continue;
      }

      if (trimmed.match(/^===+$/) || trimmed.match(/^---+$/)) {
        elements.push({ type: 'transition', content: trimmed === '===' ? 'FADE OUT.' : '-----', raw: line });
        i++;
        continue;
      }

      if (trimmed.match(/^(>.*<|>[A-Z ]+>$)/)) {
        elements.push({ type: 'centered', content: trimmed.replace(/^>|<$/g, ''), raw: line });
        i++;
        continue;
      }

      if (trimmed.match(/^>/)) {
        elements.push({ type: 'transition', content: trimmed.replace(/^>\s*/, ''), raw: line });
        i++;
        continue;
      }

      if (trimmed.match(/^(INT\.|EXT\.|EST\.|I\/E\.|INT\/EXT\.)/)) {
        elements.push({ type: 'scene_heading', content: trimmed, raw: line });
        i++;
        continue;
      }

      if (trimmed.match(/^[A-Z][A-Z ]+\.?$/)) {
        elements.push({ type: 'character', content: trimmed, raw: line });
        i++;
        if (i < lines.length && lines[i].trim().match(/^\(/)) {
          const parenLines: string[] = [];
          while (i < lines.length && !lines[i].trim().match(/^\)/)) {
            parenLines.push(lines[i].trim());
            i++;
          }
          if (i < lines.length) {
            parenLines.push(lines[i].trim());
            i++;
          }
          elements.push({ type: 'parenthetical', content: parenLines.join(' '), raw: parenLines.join('\n') });
        }
        while (i < lines.length && lines[i].trim() !== '' && !lines[i].trim().match(/^[A-Z][A-Z ]+\.?$/) && !lines[i].trim().match(/^(INT\.|EXT\.|EST\.|I\/E\.|INT\/EXT\.)/)) {
          elements.push({ type: 'dialogue', content: lines[i].trim(), raw: lines[i] });
          i++;
        }
        continue;
      }

      if (trimmed.match(/^\.+[A-Z]/)) {
        elements.push({ type: 'action', content: trimmed.replace(/^\.+/, ''), raw: line });
        i++;
        continue;
      }

      elements.push({ type: 'action', content: trimmed, raw: line });
      i++;
    }

    if (titlePageLines.length > 0) {
      elements.push({ type: 'title_page', content: titlePageLines.join('\n'), raw: titlePageLines.join('\n') });
    }

    return elements;
  }

  async function handleSave() {
    if (!selectedScript) return;
    try {
      await api.docSave(selectedScript.id, undefined, rawContent);
    } catch (e) {
      console.error('Failed to save script:', e);
    }
  }

  async function handleNewScript() {
    try {
      const doc = await api.docCreate('script', 'fountain', 'Untitled Script');
      scripts.unshift(doc);
      selectScript(doc);
    } catch (e) {
      console.error('Failed to create script:', e);
    }
  }

  async function handleImportScript(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    try {
      const lower = file.name.toLowerCase();
      if (lower.endsWith(".epub") || lower.endsWith(".pdf") || lower.endsWith(".docx")) {
        showToast(`Extracting text from ${file.name}…`, "info");
      }
      const res = await readImportFile(file);
      if (res.encodingNote) showToast(res.encodingNote, "warning");
      // Scripts stay fountain docs; book text lands as fountain body
      // (same as before — structure comes from .fountain sources).
      const doc = await api.docCreate("script", "fountain", res.title, undefined, res.text);
      scripts.unshift(doc);
      selectScript(doc);
      showToast(`Imported "${res.title}"`, "success");
    } catch (err) {
      showToast(`Import failed: ${err instanceof Error ? err.message : err}`, "error");
    }
  }

  function handleContentChange(e: Event) {
    const textarea = e.target as HTMLTextAreaElement;
    rawContent = textarea.value;
    parsedElements = parseFountain(rawContent);
    // Typing activity: lets the shell auto-hide chrome for focus.
    window.dispatchEvent(new CustomEvent("editor-typing"));
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void handleSave();
    }, 1200);
  }

  loadScripts();
</script>

<div class="script-workspace" class:list-collapsed={listCollapsed}>
  {#if !selectedScript}
    <div class="script-list full">
      <div class="list-header">
        <h1>Scripts</h1>
        <button class="new-btn" onclick={handleNewScript}>+ New Script</button>
      </div>
      {#if loading}
        <div class="empty-msg">Loading...</div>
      {:else if scripts.length === 0}
        <div class="empty-msg">No scripts yet. Create one to get started.</div>
      {:else}
        {#each scripts as doc}
          <button class="script-item" onclick={() => selectScript(doc)}>
            <div class="script-title">{doc.title}</div>
            <div class="script-meta">{doc.word_count} words</div>
          </button>
        {/each}
      {/if}
    </div>
  {:else}
    <div class="script-editor">
      <div class="editor-toolbar">
        <button class="back-btn" onclick={() => { selectedScript = null; }}>← Scripts</button>
        <button class="back-btn" onclick={() => (listCollapsed = !listCollapsed)} title={listCollapsed ? "Show script list" : "Focus editor — hide list"} aria-pressed={listCollapsed}>{listCollapsed ? "List" : "Focus"}</button>
        <span class="script-name">{selectedScript.title}</span>
        <div class="view-toggle">
          <button class:active={viewMode === 'edit'} onclick={() => viewMode = 'edit'}>Edit</button>
          <button class:active={viewMode === 'screenplay'} onclick={() => viewMode = 'screenplay'}>Screenplay</button>
        </div>
        <button class="save-btn" onclick={handleSave}>Save</button>
        <button class="save-btn import-btn" onclick={() => importInput?.click()} title="Import script (.fountain .md .txt .epub .pdf .docx)" aria-label="Import script">
          <Icon name="download" size={14} /><span>Import</span>
        </button>
        <input
          bind:this={importInput}
          type="file"
          accept=".fountain,.md,.txt,.epub,.pdf,.docx"
          onchange={handleImportScript}
          hidden
        />
        <div class="export-wrapper">
          <button class="export-btn icon-btn" onclick={toggleExportMenu} title="Export script" aria-label="Export script">
            <Icon name="upload" size={14} />
          </button>
          {#if showExportMenu}
            <div class="export-menu" role="menu" aria-label="Export formats">
              {#each exportFormats as fmt}
                <button onclick={() => exportAs(fmt)} title="Export as {exportLabel(fmt)}">{exportLabel(fmt)}</button>
              {/each}
              <button onclick={() => exportAs('fountain')} title="Export raw Fountain source">Fountain (.fountain)</button>
            </div>
          {/if}
        </div>
        <DeleteButton
          doc={selectedScript}
          label="Delete this script"
          onDeleted={(id) => {
            scripts = scripts.filter((s) => s.id !== id);
            selectedScript = null;
          }}
        />
        <button class="save-btn cast-toggle" class:active={showCast} onclick={() => showCast = !showCast} title="Cast & roles" aria-label="Toggle cast and roles panel">
          Cast{roles.length > 0 ? ` (${roles.length})` : ''}
        </button>
        {#if $settings.sttEnabled && viewMode === 'edit'}
          <MicButton onTranscribe={(text) => {
            const textarea = document.querySelector('.fountain-input') as HTMLTextAreaElement;
            if (textarea) {
              const start = textarea.selectionStart;
              const end = textarea.selectionEnd;
              rawContent = rawContent.slice(0, start) + text + ' ' + rawContent.slice(end);
              textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
          }} />
        {/if}
        {#if $settings.ttsEnabled}
          <ReadAloudButton
            getText={() => rawContent}
            getSelection={() => {
              const textarea = document.querySelector('.fountain-input') as HTMLTextAreaElement;
              if (textarea && textarea.selectionStart !== textarea.selectionEnd) {
                return rawContent.slice(textarea.selectionStart, textarea.selectionEnd);
              }
              return '';
            }}
          />
        {/if}
      </div>

      {#if viewMode === 'edit'}
        <textarea
          class="fountain-input"
          value={rawContent}
          oninput={handleContentChange}
          placeholder="Write your screenplay in Fountain format..."
          spellcheck="true"
        ></textarea>
      {:else}
        <div class="screenplay-view">
          {#each parsedElements as el}
            {#if el.type === 'title_page'}
              <div class="sp-title-page">{el.content}</div>
            {:else if el.type === 'scene_heading'}
              <div class="sp-scene-heading">{el.content}</div>
            {:else if el.type === 'action'}
              <div class="sp-action">{el.content}</div>
            {:else if el.type === 'character'}
              <div class="sp-character">{el.content}</div>
            {:else if el.type === 'dialogue'}
              <div class="sp-dialogue">{el.content}</div>
            {:else if el.type === 'parenthetical'}
              <div class="sp-parenthetical">{el.content}</div>
            {:else if el.type === 'transition'}
              <div class="sp-transition">{el.content}</div>
            {:else if el.type === 'centered'}
              <div class="sp-centered">{el.content}</div>
            {:else if el.type === 'empty'}
              <div class="sp-empty"></div>
            {/if}
          {/each}
        </div>
      {/if}
      {#if showCast}
        <aside class="cast-panel" aria-label="Cast and roles">
          <h2>Cast <span class="cast-count">{castList.length}</span></h2>
          {#if castList.length === 0}
            <p class="cast-empty">No speaking characters yet. Add a CHARACTER cue in ALL CAPS.</p>
          {:else}
            <ul class="cast-list">
              {#each castList as c}
                <li class="cast-item">
                  <span class="cast-dot" style="background: {roleColorFor(c.name)}"></span>
                  <span class="cast-name">{c.name}</span>
                  <span class="cast-lines">{c.lines} {c.lines === 1 ? 'line' : 'lines'}</span>
                </li>
              {/each}
            </ul>
          {/if}
          <h2>Roles</h2>
          {#if roles.length === 0}
            <p class="cast-empty">No roles assigned. Create one for multi-take, multi-character shoots.</p>
          {:else}
            <ul class="role-list">
              {#each roles as role}
                <li class="role-item">
                  <span class="cast-dot" style="background: {role.color}"></span>
                  <span class="role-name">{role.name}</span>
                  <input
                    class="role-assignee"
                    type="text"
                    value={role.assignedTo}
                    placeholder="Assign to…"
                    aria-label="Assign {role.name} to"
                    onchange={(e) => assignRole(role.id, (e.target as HTMLInputElement).value)}
                  />
                  <button class="role-delete" onclick={() => deleteRole(role.id)} title="Delete role" aria-label="Delete {role.name}">×</button>
                </li>
              {/each}
            </ul>
          {/if}
          <div class="role-add">
            <input
              class="role-name-input"
              type="text"
              bind:value={newRoleName}
              placeholder="New role name…"
              aria-label="New role name"
              onkeydown={(e) => { if (e.key === 'Enter') addRole(); }}
            />
            <input
              class="role-color-input"
              type="color"
              bind:value={newRoleColor}
              aria-label="New role color"
            />
            <button class="save-btn" onclick={addRole} disabled={!newRoleName.trim()}>Add</button>
          </div>
        </aside>
      {/if}
    </div>
  {/if}
</div>

<style>
  .script-workspace {
    display: flex;
    height: 100%;
    background: var(--surface-base);
    color: var(--text-primary);
    min-height: 0;
  }

  .script-workspace.list-collapsed .script-list {
    display: none;
  }

  .script-list {
    width: 280px;
    border-right: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    flex-shrink: 0;
  }

  .script-list.full {
    width: 100%;
    max-width: 560px;
    margin: 0 auto;
    border-right: none;
  }

  .list-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .list-header h1 {
    font-family: var(--font-heading);
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-bold);
  }

  .new-btn {
    padding: var(--space-1) var(--space-3);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .empty-msg {
    padding: var(--space-8);
    color: var(--text-muted);
    text-align: center;
  }

  .script-item {
    display: block;
    width: 100%;
    text-align: left;
    padding: var(--space-3) var(--space-4);
    border: none;
    border-bottom: 1px solid var(--border-subtle);
    background: transparent;
    color: var(--text-primary);
    cursor: pointer;
  }

  .script-item:hover {
    background: var(--surface-raised);
  }

  .script-title {
    font-weight: var(--font-weight-semibold);
    font-size: var(--font-size-sm);
  }

  .script-meta {
    font-size: var(--font-size-xs);
    color: var(--text-muted);
    margin-top: var(--space-1);
  }

  .script-editor {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    position: relative;
  }

  .editor-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
  }

  .back-btn,
  .save-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
  }

  .save-btn {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .script-name {
    flex: 1;
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
  }

  .view-toggle {
    display: flex;
    gap: var(--space-1);
  }

  .view-toggle button {
    padding: var(--space-1) var(--space-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-muted);
    font-size: var(--font-size-xs);
    cursor: pointer;
  }

  .view-toggle button.active {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .fountain-input {
    flex: 1;
    width: 100%;
    max-width: 760px;
    margin: 0 auto;
    padding: var(--space-6) var(--space-4);
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--font-size-base);
    line-height: 1.8;
    resize: none;
    outline: none;
  }

  .screenplay-view {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-6) var(--space-4);
  }

  /* Centered reading column that never overrides element-level widths
     (:where keeps specificity at zero, so dialogue/parenthetical keep
     their own narrower measures). */
  .screenplay-view > :where(div) {
    max-width: 700px;
    margin-inline: auto;
  }

  .sp-title-page {
    text-align: center;
    margin-bottom: var(--space-8);
    font-family: var(--font-body);
    font-size: var(--font-size-lg);
    white-space: pre-wrap;
  }

  .sp-scene-heading {
    font-family: var(--font-mono);
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-bold);
    text-transform: uppercase;
    margin-top: var(--space-4);
    margin-bottom: var(--space-2);
  }

  .sp-action {
    font-family: var(--font-body);
    margin-bottom: var(--space-2);
  }

  .sp-character {
    font-family: var(--font-body);
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    text-align: center;
    margin-top: var(--space-3);
    margin-bottom: 0;
  }

  .sp-dialogue {
    font-family: var(--font-body);
    max-width: 360px;
    margin: 0 auto;
    text-align: left;
    margin-bottom: var(--space-1);
  }

  .sp-parenthetical {
    font-family: var(--font-body);
    font-style: italic;
    max-width: 300px;
    margin: 0 auto;
    text-align: center;
    margin-bottom: var(--space-1);
  }

  .sp-transition {
    font-family: var(--font-body);
    text-align: right;
    text-transform: uppercase;
    margin-top: var(--space-3);
    margin-bottom: var(--space-3);
  }

  .sp-centered {
    text-align: center;
    margin-bottom: var(--space-2);
  }

  .sp-empty {
    height: var(--space-3);
  }

  .cast-toggle.active {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .cast-panel {
    position: absolute;
    right: 12px;
    top: 52px;
    bottom: 12px;
    width: 300px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    padding: var(--space-4);
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    background: var(--surface-raised);
    z-index: 20;
  }

  .cast-panel h2 {
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-muted);
    margin: var(--space-2) 0 0;
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .cast-count {
    font-family: var(--font-mono);
    background: var(--surface-overlay);
    border-radius: var(--radius-sm);
    padding: 0 6px;
  }

  .cast-empty {
    font-size: 12px;
    color: var(--text-muted);
    font-style: italic;
  }

  .cast-list,
  .role-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .cast-item,
  .role-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
  }

  .cast-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex-shrink: 0;
  }

  .cast-name,
  .role-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cast-lines {
    font-size: 11px;
    color: var(--text-muted);
    font-family: var(--font-mono);
  }

  .role-assignee,
  .role-name-input {
    padding: 4px 8px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: var(--surface-raised);
    color: var(--text-primary);
    font-size: 12px;
  }

  .role-assignee {
    width: 110px;
  }

  .role-delete {
    border: none;
    background: transparent;
    color: var(--text-muted);
    cursor: pointer;
    font-size: 14px;
    line-height: 1;
  }

  .role-delete:hover {
    color: var(--accent-semantic-red);
  }

  .role-add {
    display: flex;
    gap: var(--space-2);
    margin-top: var(--space-2);
  }

  .role-name-input {
    flex: 1;
    min-width: 0;
  }

  .role-color-input {
    width: 32px;
    height: 28px;
    padding: 0;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    cursor: pointer;
  }

  .import-btn {
    padding: var(--space-1) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .import-btn:hover:not(:disabled) {
    background: var(--surface-overlay);
    color: var(--text-primary);
  }

  .import-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .export-wrapper {
    position: relative;
  }

  .export-btn {
    padding: 4px 10px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: transparent;
    color: var(--text-secondary);
    font-size: 11px;
    cursor: pointer;
  }

  .export-menu {
    position: absolute;
    top: 100%;
    right: 0;
    margin-top: 4px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    box-shadow: 0 4px 12px rgba(0,0,0,0.3);
    z-index: 50;
    min-width: 160px;
  }

  .export-menu button {
    display: block;
    width: 100%;
    text-align: left;
    padding: 8px 12px;
    border: none;
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }

  .export-menu button:hover {
    background: var(--surface-overlay);
  }
</style>
