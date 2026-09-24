<script lang="ts">
  /**
   * BootLoader — looped "writing of the logo" splash.
   * Reuses the real brand strokes (floating E-tick, ground line, pen nib)
   * with a stroke-draw loop in currentColor, so it follows the theme.
   * Pure CSS motion, transform/opacity-free layout impact, honors
   * prefers-reduced-motion (settles on the finished mark).
   */
  let { label = "Loading..." }: { label?: string } = $props();
</script>

<div class="boot-loader" role="status" aria-label={label}>
  <svg viewBox="0 0 960 400" aria-hidden="true">
    <g fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <path
        class="draw d1"
        pathLength="100"
        d="M 138 108 C 170 102 210 98 248 96"
        stroke-width="15"
      />
      <path
        class="draw d2"
        pathLength="100"
        d="M 42 316 L 856 316"
        stroke-width="4"
      />
    </g>
    <g class="nib" transform="translate(798 310) rotate(28)">
      <path
        d="M 0 0 L -20 -58 C -22 -76 -11 -98 0 -104 C 11 -98 22 -76 20 -58 L 0 0 Z"
        fill="currentColor"
      />
      <rect x="-24" y="-132" width="48" height="26" rx="5" fill="currentColor" />
    </g>
  </svg>
  <div class="message">{label}</div>
</div>

<style>
  .boot-loader {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 18px;
    color: var(--ink);
  }
  .boot-loader svg {
    width: min(280px, 60vw);
    height: auto;
  }
  .draw {
    stroke-dasharray: 100;
    stroke-dashoffset: 100;
    animation: write 2.6s ease-in-out infinite;
  }
  .d2 {
    animation-delay: 0.45s;
  }
  .nib {
    opacity: 0;
    transform-box: fill-box;
    animation: nib 2.6s ease-in-out infinite;
  }
  @keyframes write {
    0% { stroke-dashoffset: 100; opacity: 0; }
    12% { opacity: 1; }
    55% { stroke-dashoffset: 0; opacity: 1; }
    78% { stroke-dashoffset: 0; opacity: 1; }
    100% { stroke-dashoffset: -100; opacity: 0; }
  }
  @keyframes nib {
    0%, 100% { opacity: 0; }
    20%, 70% { opacity: 1; }
  }
  .message {
    color: var(--text-secondary);
    font-size: 13px;
  }
  @media (prefers-reduced-motion: reduce) {
    .draw { animation: none; stroke-dashoffset: 0; }
    .nib { animation: none; opacity: 1; }
  }
</style>
