<script lang="ts">
  import { currentWorkspace, currentDoc, openTabs } from "$lib/stores/app";
  import { api } from "$lib/api";
  import Icon from "$lib/components/Icon.svelte";
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

  async function handleNew() {
    try {
      const doc = await api.docCreate($currentWorkspace, "doc", "Untitled");
      $currentDoc = doc;
      $openTabs = [doc, ...$openTabs];
    } catch (e) {
      domainError("Workspace", "couldn't create document", e);
    }
  }
</script>

<div class="empty-state">
  <div class="icon"><Icon name={hint.icon} size={44} /></div>
  <div class="message">{hint.message}</div>
  <div class="hint">{hint.hint}</div>
  <button class="btn-primary" onclick={handleNew}>New Document</button>
</div>
