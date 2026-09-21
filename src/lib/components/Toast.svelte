<script lang="ts">
  import { toasts, dismissToast } from "$lib/stores/notifications";

  function iconFor(kind: string): string {
    switch (kind) {
      case "success": return "\u2713";
      case "error": return "\u2717";
      case "warning": return "\u26A0";
      default: return "\u2139";
    }
  }
</script>

<div class="toast-stack">
  {#each $toasts as toast (toast.id)}
    <button class="toast toast-{toast.kind}" onclick={() => dismissToast(toast.id)} aria-label="Dismiss notification">
      <span class="toast-icon">{iconFor(toast.kind)}</span>
      <span class="toast-msg">{toast.message}</span>
      <span class="toast-close" aria-hidden="true">&times;</span>
    </button>
  {/each}
</div>

<style>
  .toast-stack {
    position: fixed;
    bottom: 40px;
    right: 16px;
    z-index: 9999;
    display: flex;
    flex-direction: column;
    gap: 8px;
    pointer-events: none;
  }

  .toast {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 14px;
    border-radius: var(--radius-md);
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    font-size: 12px;
    color: var(--text-primary);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
    pointer-events: auto;
    animation: slideIn 0.2s ease-out;
    cursor: pointer;
    text-align: left;
    width: 100%;
  }

  .toast:hover { opacity: 0.85; }

  .toast-success { border-left: 3px solid var(--success); }
  .toast-error { border-left: 3px solid var(--error); }
  .toast-warning { border-left: 3px solid var(--warning); }
  .toast-info { border-left: 3px solid var(--accent-primary); }

  .toast-icon {
    font-size: 14px;
    flex-shrink: 0;
  }

  .toast-msg { flex: 1; }

  .toast-close {
    font-size: 16px;
    opacity: 0.4;
    flex-shrink: 0;
  }
  .toast:hover .toast-close { opacity: 1; }

  .toast-success .toast-icon { color: var(--success); }
  .toast-error .toast-icon { color: var(--error); }
  .toast-warning .toast-icon { color: var(--warning); }
  .toast-info .toast-icon { color: var(--accent-primary); }

  @keyframes slideIn {
    from { transform: translateX(20px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
