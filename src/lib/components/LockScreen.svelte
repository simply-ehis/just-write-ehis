<script lang="ts">
  /**
   * LockScreen — PIN gate shown over locked docs (A11.4).
   * Unlocks for this session only; backend already excludes locked
   * content from AI, search, and stats regardless of this screen.
   */
  import type { Doc } from "$lib/api";
  import { hasPin, markUnlocked, pinLockoutRemaining, verifyPin } from "$lib/stores/lock";
  import { showToast } from "$lib/stores/notifications";
  import Icon from "$lib/components/Icon.svelte";

  let { doc }: { doc: Doc } = $props();

  let pin = $state("");
  let error = $state("");
  let busy = $state(false);
  let waitSeconds = $state(0);
  let inputEl = $state<HTMLInputElement | null>(null);

  $effect(() => {
    const timer = setInterval(() => {
      waitSeconds = Math.ceil(pinLockoutRemaining() / 1000);
    }, 500);
    return () => clearInterval(timer);
  });

  $effect(() => {
    // Depend on doc.id: switching locked docs resets stale PIN/error.
    void doc.id;
    pin = "";
    error = "";
    busy = false;
    setTimeout(() => inputEl?.focus(), 50);
  });

  async function unlock() {
    if (busy || waitSeconds > 0) return;
    busy = true;
    try {
      if (!(await hasPin())) {
        error = "No PIN set. Set one in Settings → Privacy & Security.";
        return;
      }
      if (await verifyPin(pin)) {
        markUnlocked(doc.id);
        showToast(`Unlocked "${doc.title}" for this session`, "success");
      } else {
        const wait = Math.ceil(pinLockoutRemaining() / 1000);
        error = wait > 0
          ? `Wrong PIN. Too many attempts — wait ${wait}s.`
          : "Wrong PIN. Try again.";
        pin = "";
      }
    } finally {
      busy = false;
    }
  }
</script>

<div class="lock-screen">
  <span class="lock-icon"><Icon name="lock" size={36} /></span>
  <h2>{doc.title}</h2>
  <p class="lock-sub">This document is locked. It stays out of AI context, search, and stats until unlocked.</p>
  <div class="lock-row">
    <input
      bind:this={inputEl}
      type="password"
      inputmode="numeric"
      bind:value={pin}
      placeholder="Enter PIN"
      aria-label="Document PIN"
      disabled={busy || waitSeconds > 0}
      onkeydown={(e) => { if (e.key === "Enter") unlock(); }}
    />
    <button class="unlock-btn" onclick={unlock} disabled={busy || waitSeconds > 0}>
      {busy ? "…" : waitSeconds > 0 ? `Wait ${waitSeconds}s` : "Unlock"}
    </button>
  </div>
  {#if error}
    <p class="lock-error">{error}</p>
  {/if}
</div>

<style>
  .lock-screen {
    position: absolute;
    inset: 0;
    z-index: 50;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    padding: 24px;
    text-align: center;
    background: var(--surface-base);
    color: var(--text-primary);
  }

  .lock-icon {
    color: var(--text-muted);
    display: inline-flex;
  }

  .lock-screen h2 {
    margin: 0;
    font-size: 17px;
  }

  .lock-sub {
    margin: 0;
    font-size: 12px;
    color: var(--text-muted);
    max-width: 340px;
  }

  .lock-row {
    display: flex;
    gap: 8px;
    margin-top: 6px;
  }

  .lock-row input {
    width: 160px;
    height: 36px;
    text-align: center;
  }

  .unlock-btn {
    height: 36px;
    padding: 0 18px;
    border-radius: var(--radius-md);
    background: var(--accent-primary);
    color: var(--text-on-accent);
    font-size: 13px;
  }

  .lock-error {
    margin: 0;
    font-size: 12px;
    color: var(--accent-semantic-red);
  }
</style>
