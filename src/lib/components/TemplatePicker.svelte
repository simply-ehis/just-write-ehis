<script lang="ts">
  import { onMount } from "svelte";
  import { templates, type Template, resolveVariables, createDocFromTemplate, getTemplatesForWorkspace } from "$lib/stores/templates";
  import { currentWorkspace } from "$lib/stores/app";
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

  let filteredTemplates = $derived(
    get(templates)
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