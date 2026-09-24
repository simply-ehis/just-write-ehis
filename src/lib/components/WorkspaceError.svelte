<script lang="ts">
  /**
   * WorkspaceError — visible, retryable data-load failure inside a
   * workspace pane. Chunk-load failures are owned by LazyWorkspace;
   * this owns everything after the chunk mounts (project, bookshelf,
   * graph, list loads) so a tab never sits blank in silence.
   */
  let {
    message,
    onRetry,
  }: {
    message: string;
    onRetry: () => void;
  } = $props();
</script>

<div class="workspace-error" role="alert">
  <span>{message}</span>
  <button class="workspace-retry" onclick={onRetry}>Retry</button>
</div>

<style>
  .workspace-error {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    min-height: 120px;
    padding: 20px;
    text-align: center;
    color: var(--text-primary);
    background: var(--surface-base);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    font-size: 13px;
  }
  .workspace-retry {
    padding: 6px 16px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    font-size: 12px;
    cursor: pointer;
  }
  .workspace-retry:hover {
    background: var(--surface-hover);
  }
</style>
