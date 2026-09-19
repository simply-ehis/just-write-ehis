<script lang="ts">
  import { currentDoc } from "$lib/stores/app";

  function getBreadcrumb(doc: any): string[] {
    if (!doc) return [];
    const parts = doc.path.split("/");
    return parts.slice(0, -1);
  }
</script>

<div class="breadcrumb-bar">
  {#if $currentDoc}
    {#each getBreadcrumb($currentDoc) as part, i}
      {#if i > 0}
        <span class="separator">/</span>
      {/if}
      <span>{part}</span>
    {/each}
    <span class="separator">/</span>
    <span class="current">{$currentDoc.title}</span>
  {:else}
    <span>No document open</span>
  {/if}
</div>
