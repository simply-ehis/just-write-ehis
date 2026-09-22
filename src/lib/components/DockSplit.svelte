<script lang="ts">
  /**
   * DockSplit — resizable split with a draggable in-flow divider bar.
   * Vertical: top board/list (persisted % height) over the docked editor.
   * Horizontal: left content with a resizable right panel (notes).
   * Solid surfaces only, keyboard resizable.
   */
  import type { Snippet } from "svelte";

  let {
    storageKey,
    topLabel,
    hasBottom,
    topCompact = false,
    direction = "vertical",
    defaultPct = 42,
    top,
    bottom,
  }: {
    storageKey: string;
    topLabel: string;
    hasBottom: boolean;
    topCompact?: boolean;
    direction?: "vertical" | "horizontal";
    defaultPct?: number;
    top: Snippet;
    bottom: Snippet;
  } = $props();

  const MIN = 12;
  const MAX = 85;

  function load(): number {
    try {
      const v = parseFloat(localStorage.getItem(storageKey) ?? "");
      if (Number.isFinite(v)) return Math.min(MAX, Math.max(MIN, v));
    } catch (e) {
      console.warn(`Failed to load split position for ${storageKey}:`, e);
    }
    return Math.min(MAX, Math.max(MIN, defaultPct));
  }

  let topPct = $state(load());
  let container = $state<HTMLElement | null>(null);
  let dragging = $state(false);
  let horizontal = $derived(direction === "horizontal");

  function clamp(v: number): number {
    return Math.min(MAX, Math.max(MIN, v));
  }

  function save() {
    try {
      localStorage.setItem(storageKey, String(Math.round(topPct)));
    } catch (e) {
      console.warn(`Failed to save split position for ${storageKey}:`, e);
    }
  }

  function onPointerDown(e: PointerEvent) {
    dragging = true;
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragging || !container) return;
    const r = container.getBoundingClientRect();
    if (horizontal) {
      if (r.width <= 0) return;
      topPct = clamp(((e.clientX - r.left) / r.width) * 100);
    } else {
      if (r.height <= 0) return;
      topPct = clamp(((e.clientY - r.top) / r.height) * 100);
    }
  }

  function onPointerUp() {
    if (dragging) {
      dragging = false;
      save();
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    const down = horizontal ? "ArrowRight" : "ArrowDown";
    const up = horizontal ? "ArrowLeft" : "ArrowUp";
    if (e.key === up) {
      e.preventDefault();
      topPct = clamp(topPct - 3);
      save();
    } else if (e.key === down) {
      e.preventDefault();
      topPct = clamp(topPct + 3);
      save();
    }
  }

  let slotStyle = $derived(
    hasBottom && !topCompact
      ? horizontal
        ? `width: ${topPct}%;`
        : `height: ${topPct}%;`
      : undefined
  );
</script>

<div class="dock-split" class:horizontal bind:this={container}>
  <div
    class="ds-top"
    class:ds-full={!hasBottom}
    class:ds-compact={topCompact && hasBottom}
    style={slotStyle}
  >
    {@render top()}
  </div>
  {#if hasBottom}
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions: separator widget — arrow keys resize, drag resizes; focus ring is visible. -->
    <div
      class="ds-bar"
      class:horizontal
      role="separator"
      aria-orientation={horizontal ? "vertical" : "horizontal"}
      aria-label={topLabel}
      aria-valuenow={Math.round(topPct)}
      aria-valuemin={MIN}
      aria-valuemax={MAX}
      tabindex="0"
      title="Drag to resize panels (arrow keys work too)"
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onkeydown={onKeyDown}
    >
      <span aria-hidden="true"></span>
    </div>
    <div class="ds-bottom">
      {@render bottom()}
    </div>
  {/if}
</div>

<style>
  .dock-split {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
  }

  .dock-split.horizontal {
    flex-direction: row;
  }

  .ds-top {
    display: flex;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
    overflow: hidden;
    flex: 0 0 auto;
  }

  .ds-top.ds-full {
    flex: 1 1 auto;
    height: auto;
  }

  .ds-top.ds-compact {
    height: auto;
  }

  .ds-bar {
    flex: 0 0 auto;
    height: 10px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: row-resize;
    background: var(--surface-base);
    border-top: 1px solid var(--border-subtle);
    border-bottom: 1px solid var(--border-subtle);
    touch-action: none;
  }

  .ds-bar span {
    width: 44px;
    height: 3px;
    background: var(--border-strong);
  }

  .ds-bar.horizontal {
    width: 10px;
    height: auto;
    flex-direction: column;
    cursor: col-resize;
    border-top: none;
    border-bottom: none;
    border-left: 1px solid var(--border-subtle);
    border-right: 1px solid var(--border-subtle);
  }

  .ds-bar.horizontal span {
    width: 3px;
    height: 44px;
  }

  .ds-bar:hover span,
  .ds-bar:focus-visible span {
    background: var(--accent-primary);
  }

  .ds-bar:focus-visible {
    outline: 2px solid var(--accent-primary);
    outline-offset: -2px;
  }

  .ds-bottom {
    flex: 1 1 auto;
    min-height: 0;
    min-width: 0;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
</style>
