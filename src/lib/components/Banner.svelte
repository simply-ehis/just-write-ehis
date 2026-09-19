<script lang="ts">
  import { banners, dismissBanner } from "$lib/stores/notifications";
</script>

{#if $banners.length > 0}
  <div class="banner-stack">
    {#each $banners as banner (banner.id)}
      <div class="banner banner-{banner.kind}">
        <span class="banner-msg">{banner.message}</span>
        <button class="banner-dismiss" onclick={() => dismissBanner(banner.id)}>&times;</button>
      </div>
    {/each}
  </div>
{/if}

<style>
  .banner-stack {
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    z-index: 9998;
    display: flex;
    flex-direction: column;
    pointer-events: none;
  }

  .banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 8px 16px;
    font-size: 12px;
    color: var(--text-primary);
    pointer-events: auto;
    animation: slideDown 0.2s ease-out;
  }

  .banner-warning {
    background: color-mix(in srgb, var(--warning) 15%, var(--surface-base));
    border-bottom: 1px solid var(--warning);
  }

  .banner-error {
    background: color-mix(in srgb, var(--error) 15%, var(--surface-base));
    border-bottom: 1px solid var(--error);
  }

  .banner-info {
    background: color-mix(in srgb, var(--accent-primary) 15%, var(--surface-base));
    border-bottom: 1px solid var(--accent-primary);
  }

  .banner-dismiss {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 16px;
    cursor: pointer;
    padding: 0 4px;
    line-height: 1;
  }

  .banner-dismiss:hover {
    color: var(--text-primary);
  }

  @keyframes slideDown {
    from { transform: translateY(-100%); opacity: 0; }
    to { transform: translateY(0); opacity: 1; }
  }
</style>
