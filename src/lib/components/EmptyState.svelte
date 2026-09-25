<script lang="ts">
  import { currentWorkspace, currentDoc, openTabs } from "$lib/stores/app";
  import { api } from "$lib/api";
  import Icon from "$lib/components/Icon.svelte";
  import TemplatePicker from "$lib/components/TemplatePicker.svelte";
  import { domainError } from "$lib/errors";

  const workspaceHints: Record<string, { icon: string; message: string; hint: string }> = {
    logs: { icon: "calendar", message: "No logs yet", hint: "Your daily notes will appear here" },
    write: { icon: "pencil", message: "Start writing", hint: "Press + to create a new doc" },
    map: { icon: "graph", message: "No nodes", hint: "Docs you create will appear as nodes" },
    novel: { icon: "book", message: "No novel project", hint: "Create a novel project to get started" },
    script: { icon: "film", message: "No scripts", hint: "Create a script to get started" },
    projects: { icon: "folder", message: "No projects", hint: "Create a project to organize your docs" },
    reader: { icon: "book-open", message: "No books", hint: "Import a book to start reading" },
  };

  let hint = $derived(workspaceHints[$currentWorkspace] ?? workspaceHints.write);

  let showTemplates = $state(false);

  async function handleNew() {
    try {
      const doc = await api.docCreate($currentWorkspace, "doc", "Untitled");
      $currentDoc = doc;
      $openTabs = [doc, ...$openTabs];
    } catch (e) {
      domainError("Workspace", "couldn't create document", e);
    }
  }

  async function handleTemplateDoc(docId: string) {
    showTemplates = false;
    try {
      const doc = await api.docGet(docId);
      $currentDoc = doc;
      if (!$openTabs.find((t) => t.id === doc.id)) $openTabs = [doc, ...$openTabs];
    } catch (e) {
      domainError("Workspace", "couldn't open templated document", e);
    }
  }
</script>

<div class="empty-state">
  <div class="empty-card">
    <div class="empty-icon"><Icon name={hint.icon} size={40} /></div>
    <div class="message">{hint.message}</div>
    <div class="hint">{hint.hint}</div>
    <div class="empty-actions">
      <button class="btn-primary" onclick={handleNew}>New Document</button>
      <button class="btn-secondary" onclick={() => (showTemplates = true)}>Start from template</button>
    </div>
  </div>
</div>

{#if showTemplates}
  <TemplatePicker
    workspace={$currentWorkspace}
    onClose={() => (showTemplates = false)}
    onCreate={handleTemplateDoc}
  />
{/if}

<style>
  .empty-state {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 100%;
    padding: 32px;
  }
  .empty-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    max-width: 420px;
    padding: 44px 40px;
    text-align: center;
    background: var(--surface-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
  }
  .empty-icon {
    display: grid;
    place-items: center;
    width: 72px;
    height: 72px;
    margin-bottom: 6px;
    border-radius: var(--radius-lg);
    background: var(--accent-soft);
    color: var(--accent-primary);
  }
  .message {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--text-primary);
  }
  .hint {
    font-size: 13px;
    line-height: 1.55;
    color: var(--text-secondary);
  }
  .empty-actions {
    display: flex;
    gap: 10px;
    margin-top: 10px;
    flex-wrap: wrap;
    justify-content: center;
  }
</style>
