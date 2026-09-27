<script lang="ts">
  import { currentDoc } from '$lib/stores/app';
  import { showToast } from '$lib/stores/notifications';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);
  let mode = $state<'focus' | 'typewriter' | 'pomodoro'>('focus');
  let pomodoroMinutes = $state(25);
  let timeRemaining = $state(0);
  let timerRunning = $state(false);
  let timerInterval: ReturnType<typeof setInterval> | null = null;
  let wordsAtStart = $state(0);

  function openPanel() {
    open = true;
    if ($currentDoc) {
      wordsAtStart = $currentDoc.word_count;
    }
  }

  function closePanel() {
    open = false;
    stopTimer();
  }

  function startTimer() {
    timeRemaining = pomodoroMinutes * 60;
    timerRunning = true;
    timerInterval = setInterval(() => {
      timeRemaining--;
      if (timeRemaining <= 0) {
        stopTimer();
        showToast('Pomodoro complete! Take a break.', 'success');
      }
    }, 1000);
  }

  function stopTimer() {
    timerRunning = false;
    if (timerInterval) {
      clearInterval(timerInterval);
      timerInterval = null;
    }
  }

  function resetTimer() {
    stopTimer();
    timeRemaining = pomodoroMinutes * 60;
  }

  function formatTime(seconds: number): string {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }

  function getSessionWords(): number {
    if (!$currentDoc) return 0;
    return Math.max(0, $currentDoc.word_count - wordsAtStart);
  }

  $effect(() => {
    return () => stopTimer();
  });
</script>

<button class="focus-trigger icon-btn" onclick={openPanel} title="Focus Mode" aria-label="Open focus mode">
  <Icon name="target" size={15} />
</button>

{#if open}
  <div class="focus-overlay" onclick={(e) => { if (e.target === e.currentTarget) closePanel(); }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') closePanel(); }}>
    <div class="focus-panel" role="dialog" aria-label="Focus mode" tabindex="-1">
      <div class="panel-header">
        <h2>Focus Mode</h2>
        <button class="close-btn" onclick={closePanel}>&times;</button>
      </div>

      <div class="mode-tabs">
        <button class="mode-tab" class:active={mode === 'focus'} onclick={() => mode = 'focus'}>Focus</button>
        <button class="mode-tab" class:active={mode === 'typewriter'} onclick={() => mode = 'typewriter'}>Typewriter</button>
        <button class="mode-tab" class:active={mode === 'pomodoro'} onclick={() => mode = 'pomodoro'}>Pomodoro</button>
      </div>

      {#if mode === 'focus'}
        <div class="mode-content">
          <div class="focus-stats">
            <div class="stat">
              <span class="stat-value">{$currentDoc?.word_count?.toLocaleString() ?? 0}</span>
              <span class="stat-label">Words</span>
            </div>
            <div class="stat">
              <span class="stat-value">{getSessionWords()}</span>
              <span class="stat-label">Session</span>
            </div>
          </div>
          <p class="focus-hint">Minimize distractions. Write freely.</p>
        </div>
      {:else if mode === 'typewriter'}
        <div class="mode-content">
          <div class="typewriter-settings">
            <label>
              Scroll Speed
              <input type="range" min="1" max="10" value="5" />
            </label>
            <label>
              <input type="checkbox" checked /> Center Cursor
            </label>
            <label>
              <input type="checkbox" checked /> Smooth Scroll
            </label>
          </div>
        </div>
      {:else if mode === 'pomodoro'}
        <div class="mode-content">
          <div class="pomodoro-display">
            <div class="pomodoro-time">{formatTime(timeRemaining)}</div>
            <div class="pomodoro-controls">
              {#if !timerRunning}
                <button class="pomodoro-btn" onclick={startTimer}>Start</button>
              {:else}
                <button class="pomodoro-btn" onclick={stopTimer}>Pause</button>
              {/if}
              <button class="pomodoro-btn" onclick={resetTimer}>Reset</button>
            </div>
            <div class="pomodoro-presets">
              <button class="pomodoro-preset" onclick={() => { pomodoroMinutes = 15; resetTimer(); }}>15m</button>
              <button class="pomodoro-preset" onclick={() => { pomodoroMinutes = 25; resetTimer(); }}>25m</button>
              <button class="pomodoro-preset" onclick={() => { pomodoroMinutes = 50; resetTimer(); }}>50m</button>
            </div>
          </div>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .focus-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .focus-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .focus-panel {
    width: min(480px, 90vw);
    background: var(--surface-base);
    border-radius: var(--radius-lg);
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
    overflow: hidden;
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border-subtle);
  }

  .panel-header h2 {
    font-family: var(--font-heading);
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-bold);
  }

  .close-btn {
    width: 28px;
    height: 28px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: var(--radius-sm);
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 18px;
    cursor: pointer;
  }

  .mode-tabs {
    display: flex;
    border-bottom: 1px solid var(--border-subtle);
  }

  .mode-tab {
    flex: 1;
    padding: 12px;
    background: transparent;
    border: none;
    color: var(--text-secondary);
    font-size: 13px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
  }

  .mode-tab.active {
    color: var(--accent-primary);
    border-bottom-color: var(--accent-primary);
  }

  .mode-content {
    padding: 20px;
  }

  .focus-stats {
    display: flex;
    gap: 24px;
    margin-bottom: 16px;
  }

  .stat {
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .stat-value {
    font-size: 24px;
    font-weight: var(--font-weight-bold);
    color: var(--accent-primary);
  }

  .stat-label {
    font-size: 11px;
    color: var(--text-muted);
    text-transform: uppercase;
  }

  .focus-hint {
    text-align: center;
    color: var(--text-muted);
    font-size: 13px;
  }

  .typewriter-settings {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .typewriter-settings label {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }

  .pomodoro-display {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 16px;
  }

  .pomodoro-time {
    font-size: 48px;
    font-weight: var(--font-weight-bold);
    font-family: var(--font-mono);
    color: var(--accent-primary);
  }

  .pomodoro-controls {
    display: flex;
    gap: 8px;
  }

  .pomodoro-btn {
    padding: 8px 16px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border: none;
    border-radius: var(--radius-md);
    font-size: 13px;
    cursor: pointer;
  }

  .pomodoro-presets {
    display: flex;
    gap: 8px;
  }

  .pomodoro-preset {
    padding: 6px 12px;
    background: var(--surface-raised);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    font-size: 12px;
    cursor: pointer;
  }
</style>
