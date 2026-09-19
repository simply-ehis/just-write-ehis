<script lang="ts">
  import { toasts } from "$lib/stores/notifications";

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
    <div class="toast toast-{toast.kind}">
      <span class="toast-icon">{iconFor(toast.kind)}</span>
      <span class="toast-msg">{toast.message}</span>
    </div>
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
  }

  .toast-success { border-left: 3px solid var(--success); }
  .toast-error { border-left: 3px solid var(--error); }
  .toast-warning { border-left: 3px solid var(--warning); }
  .toast-info { border-left: 3px solid var(--accent-primary); }

  .toast-icon {
    font-size: 14px;
    flex-shrink: 0;
  }

  .toast-success .toast-icon { color: var(--success); }
  .toast-error .toast-icon { color: var(--error); }
  .toast-warning .toast-icon { color: var(--warning); }
  .toast-info .toast-icon { color: var(--accent-primary); }

  @keyframes slideIn {
    from { transform: translateX(20px); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
</style>
