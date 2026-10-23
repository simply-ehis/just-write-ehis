<script lang="ts">
  import { onMount } from "svelte";
import { templates, type Template, createDocFromTemplate } from "$lib/stores/templates";
  import { currentWorkspace } from "$lib/stores/app";
import { settings } from "$lib/stores/settings";
import { api } from "$lib/api";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "./Icon.svelte";
  import { get } from "svelte/store";

  let { workspace = $currentWorkspace, onClose = () => {}, onCreate = () => {} }: {
    workspace?: string;
    onClose?: () => void;
    onCreate?: (docId: string) => void;
  } = $props();

  let search = $state("");
  let selectedIndex = $state(0);
  let showVariableModal = $state(false);
  let selectedTemplate: Template | null = $state(null);
  let variableValues: Record<string, string> = $state({});
  let showGenerator = $state(false);
  let templateIdea = $state("");
  let generating = $state(false);

  let filteredTemplates = $derived(
    $templates
      .filter((t) => t.workspace === workspace || t.workspace === "global")
      .filter((t) => t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()))
  );

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showVariableModal) {
        showVariableModal = false;
        selectedTemplate = null;
      } else {
        onClose();
      }
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      selectedIndex = Math.min(selectedIndex + 1, filteredTemplates.length - 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      selectedIndex = Math.max(selectedIndex - 1, 0);
    } else if (e.key === "Enter") {
      e.preventDefault();
      const template = filteredTemplates[selectedIndex];
      if (template) {
        if (template.variables.length > 0) {
          selectedTemplate = template;
          variableValues = {};
          for (const v of template.variables) {
            variableValues[v.name] = v.default ?? "";
          }
          showVariableModal = true;
        } else {
          createDocFromTemplate(template.id, {}).then((id) => {
            if (id) {
              onCreate(id);
              onClose();
            }
          });
        }
      }
    }
  }

  function handleVariableSubmit() {
    if (!selectedTemplate) return;
    const missing = selectedTemplate.variables.filter((v) => v.required && !variableValues[v.name]?.trim());
    if (missing.length > 0) {
      showToast(`Missing required fields: ${missing.map((v) => v.label).join(", ")}`, "error");
      return;
    }
    createDocFromTemplate(selectedTemplate.id, variableValues).then((id) => {
      if (id) {
        onCreate(id);
        onClose();
      }
    });
    showVariableModal = false;
    selectedTemplate = null;
  }

  async function generateTemplate() {
    const idea = templateIdea.trim();
    if (!idea || generating) return;
    generating = true;
    try {
      const config = get(settings);
      const response = await api.aiGenerate({
        prompt: `Create a reusable Markdown starter template for: ${idea}\n\nReturn only the template body. Keep it concise, use clear headings where useful, and include {{date}} only where it belongs. Do not fill it with sample prose.`,
        mode: "chat",
        provider: config.mainModelEndpoint || undefined,
        model: config.mainModelName || undefined,
        api_key: config.apiKey || undefined,
      });
      const content = response.content.trim().replace(/^```(?:markdown)?\s*/i, "").replace(/\s*```$/, "");
      if (!content) throw new Error("The model returned an empty template.");
      const now = Date.now();
      const name = `${idea.slice(0, 48)} Template`;
      templates.update((all) => [{
        id: `ai-${now}`,
        name,
        description: `AI-generated starter for ${idea}`,
        content,
        variables: [],
        workspace,
        createdAt: now,
        updatedAt: now,
      }, ...all]);
      showToast(`Created template: ${name}`, "success");
      showGenerator = false;
      templateIdea = "";
    } catch (error) {
      showToast(`Couldn't generate a template: ${error instanceof Error ? error.message : error}`, "error");
    } finally {
      generating = false;
    }
  }

  onMount(() => {
    selectedIndex = 0;
  });

  function formatDate(d: string) {
    return new Date(d).toLocaleDateString();
  }
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions: listbox-style picker — keydown provides arrow/Enter/Escape navigation; options are buttons and search is an input. -->
<div class="template-picker" onkeydown={handleKeydown} role="application">
  <div class="picker-header">
    <span class="picker-icon"><Icon name="files" size={16} /></span>
    <input
      bind:value={search}
      placeholder="Search templates…"
      class="picker-search"
      aria-label="Search templates"
    />
    <span class="picker-hint">↑↓ Enter Esc</span>
  </div>

  <div class="template-generator">
    <button class="generator-toggle" onclick={() => (showGenerator = !showGenerator)} aria-expanded={showGenerator}>
      {showGenerator ? "Close AI template" : "Generate a starter with AI"}
    </button>
    {#if showGenerator}
      <textarea
        class="generator-prompt"
        bind:value={templateIdea}
        onkeydown={(event) => event.stopPropagation()}
        placeholder="What are you writing? e.g. a grant proposal or a mystery chapter"
        aria-label="Describe the template to generate"
        rows={2}
      ></textarea>
      <div class="generator-footer">
        <span>Only this request is sent to your selected AI provider.</span>
        <button class="generator-submit" onclick={generateTemplate} disabled={generating || !templateIdea.trim()}>
          {generating ? "Generating…" : "Create template"}
        </button>
      </div>
    {/if}
  </div>

  <div class="picker-list" role="listbox">
    {#if filteredTemplates.length === 0}
      <div class="picker-empty">No templates found</div>
    {:else}
      {#each filteredTemplates as template, i}
        <button
          class="picker-item"
          class:selected={i === selectedIndex}
          role="option"
          aria-selected={i === selectedIndex}
          onmouseenter={() => (selectedIndex = i)}
          onclick={() => {
            selectedIndex = i;
            if (template.variables.length > 0) {
              selectedTemplate = template;
              variableValues = {};
              for (const v of template.variables) {
                variableValues[v.name] = v.default ?? "";
              }
              showVariableModal = true;
            } else {
              createDocFromTemplate(template.id, {}).then((id) => {
                if (id) {
                  onCreate(id);
                  onClose();
                }
              });
            }
          }}
        >
          <span class="item-icon"><Icon name="files" size={14} /></span>
          <div class="item-content">
            <span class="item-name">{template.name}</span>
            <span class="item-desc">{template.description}</span>
          </div>
          {#if template.variables.length > 0}
            <span class="item-badge">{template.variables.length} fields</span>
          {/if}
        </button>
      {/each}
    {/if}
  </div>

  {#if showVariableModal && selectedTemplate}
    <div class="modal-overlay" onclick={(e) => { if (e.target === e.currentTarget) showVariableModal = false; }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') showVariableModal = false; }}>
      <div class="modal" role="dialog" aria-label="Template Variables" tabindex="-1">
        <div class="modal-header">
          <h3>{selectedTemplate.name}</h3>
          <p class="modal-desc">{selectedTemplate.description}</p>
        </div>
        <div class="modal-body">
          {#each selectedTemplate.variables as variable}
            <div class="variable-field">
              <label for="var-{variable.name}">{variable.label} {variable.required && "*"}</label>
              {#if variable.type === "select"}
                <select
                  id="var-{variable.name}"
                  bind:value={variableValues[variable.name]}
                  required={variable.required}
                >
                  {#each variable.options as opt}
                    <option value={opt}>{opt}</option>
                  {/each}
                </select>
              {:else if variable.type === "textarea"}
                <textarea
                  id="var-{variable.name}"
                  bind:value={variableValues[variable.name]}
                  required={variable.required}
                  rows={3}
                ></textarea>
              {:else if variable.type === "date"}
                <input
                  type="date"
                  id="var-{variable.name}"
                  bind:value={variableValues[variable.name]}
                  required={variable.required}
                />
              {:else}
                <input
                  type="text"
                  id="var-{variable.name}"
                  bind:value={variableValues[variable.name]}
                  required={variable.required}
                  placeholder={variable.default}
                />
              {/if}
            </div>
          {/each}
        </div>
        <div class="modal-actions">
          <button class="btn-secondary" onclick={() => (showVariableModal = false)}>Cancel</button>
          <button class="btn-primary" onclick={handleVariableSubmit}>Create Document</button>
        </div>
      </div>
    </div>
  {/if}
</div>

<style>
  .template-picker {
    display: flex;
    flex-direction: column;
    width: min(480px, 94vw);
    max-height: 600px;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 8px;
    overflow: hidden;
    font-family: inherit;
  }

  .picker-header {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .picker-icon {
    color: var(--text-muted);
  }

  .picker-search {
    flex: 1;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-elevated);
    color: var(--text-primary);
    font-size: 14px;
  }

  .picker-hint {
    font-size: 11px;
    color: var(--text-muted);
  }

  .template-generator {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .generator-toggle,
  .generator-submit {
    align-self: flex-start;
    padding: 5px 9px;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-secondary);
    cursor: pointer;
    font-size: 12px;
  }

  .generator-prompt {
    width: 100%;
    resize: vertical;
    padding: var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-elevated);
    color: var(--text-primary);
    font: inherit;
    font-size: 13px;
  }

  .generator-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    color: var(--text-muted);
    font-size: 10px;
  }

  .generator-submit:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .picker-list {
    flex: 1;
    overflow-y: auto;
    padding: var(--space-2);
  }

  .picker-empty {
    padding: var(--space-6);
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .picker-item {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-primary);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
    transition: background 0.1s;
  }

  .picker-item:hover,
  .picker-item.selected {
    background: var(--surface-hover);
  }

  .item-icon {
    color: var(--text-muted);
    flex-shrink: 0;
  }

  .item-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }

  .item-name {
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-desc {
    font-size: 11px;
    color: var(--text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-badge {
    font-size: 10px;
    padding: 1px 6px;
    border-radius: 4px;
    background: var(--accent-primary);
    color: var(--accent-on);
  }

  .modal-overlay {
    position: fixed;
    inset: 0;
    background: var(--bg-primary);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .modal {
    width: 90%;
    max-width: min(480px, 94vw);
    max-height: 80vh;
    overflow-y: auto;
    background: var(--surface-base);
    border: 1px solid var(--border);
    border-radius: 8px;
    padding: var(--space-4);
  }

  .modal-header {
    margin-bottom: var(--space-4);
  }

  .modal-header h3 {
    margin: 0 0 var(--space-1);
    font-size: 16px;
  }

  .modal-desc {
    margin: 0;
    font-size: 13px;
    color: var(--text-muted);
  }

  .variable-field {
    margin-bottom: var(--space-3);
  }

  .variable-field label {
    display: block;
    margin-bottom: var(--space-1);
    font-size: 13px;
    font-weight: 500;
  }

  .variable-field input,
  .variable-field select,
  .variable-field textarea {
    width: 100%;
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--border);
    border-radius: 6px;
    background: var(--surface-elevated);
    color: var(--text-primary);
    font-size: 13px;
    font-family: inherit;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
    margin-top: var(--space-4);
    padding-top: var(--space-3);
    border-top: 1px solid var(--border);
  }

  .btn-primary,
  .btn-secondary {
    padding: var(--space-2) var(--space-4);
    border-radius: 6px;
    border: none;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary {
    background: var(--accent-primary);
    color: var(--accent-on);
  }

  .btn-secondary {
    background: var(--surface-hover);
    color: var(--text-primary);
  }
</style>
