<script lang="ts">
  import { showToast } from '$lib/stores/notifications';
  import { currentDoc, currentWorkspace } from '$lib/stores/app';
  import { api } from '$lib/api';
  import Icon from '$lib/components/Icon.svelte';

  let open = $state(false);
  let listening = $state(false);
  let transcript = $state('');
  let command = $state('');
  let recognition: SpeechRecognition | null = null;

  const COMMANDS = [
    { trigger: 'new document', action: () => { api.docCreate(currentWorkspace === 'home' ? 'write' : currentWorkspace, 'doc', 'Untitled').then(doc => { showToast('New document created', 'success'); }); } },
    { trigger: 'save document', action: () => { if (currentDoc) api.docSave(currentDoc.id).then(() => showToast('Document saved', 'success')); } },
    { trigger: 'toggle sidebar', action: () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', ctrlKey: true })); } },
    { trigger: 'toggle ai', action: () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true })); } },
    { trigger: 'command palette', action: () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true })); } },
    { trigger: 'close tab', action: () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true })); } },
    { trigger: 'new tab', action: () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 't', ctrlKey: true })); } },
    { trigger: 'go home', action: () => { window.dispatchEvent(new CustomEvent('navigate-workspace', { detail: 'home' })); } },
    { trigger: 'go write', action: () => { window.dispatchEvent(new CustomEvent('navigate-workspace', { detail: 'write' })); } },
    { trigger: 'go novel', action: () => { window.dispatchEvent(new CustomEvent('navigate-workspace', { detail: 'novel' })); } },
  ];

  function startListening() {
    if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
      showToast('Speech recognition not supported in this browser', 'error');
      return;
    }
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      const transcript = event.results[0][0].transcript.toLowerCase();
      command = transcript;
      const cmd = COMMANDS.find(c => transcript.includes(c.trigger));
      if (cmd) {
        cmd.action();
        showToast(`Executed: ${c.trigger}`, 'success');
        stopListening();
      }
    };

    recognition.onerror = (event) => {
      showToast(`Voice error: ${event.error}`, 'error');
      stopListening();
    };

    recognition.onend = () => {
      listening = false;
      transcript = '';
    };

    recognition.start();
    listening = true;
  }

  function stopListening() {
    if (recognition) {
      recognition.stop();
      recognition = null;
    }
    listening = false;
  }

  function toggleVoice() {
    if (listening) stopListening();
    else startListening();
  }
</script>

<button class="voice-trigger icon-btn" onclick={toggleVoice} title="Voice Commands (say 'ehis')" aria-label="Toggle voice commands" class:listening>
  <Icon name="mic" size={15} />
</button>

{#if open}
  <div class="voice-overlay" onclick={(e) => { if (e.target === e.currentTarget) open = false; }} role="presentation" onkeydown={(e) => { if (e.key === 'Escape') open = false; }}>
    <div class="voice-panel" role="dialog" aria-label="Voice commands">
      <div class="panel-header">
        <h2>Voice Commands</h2>
        <button class="close-btn" onclick={() => open = false}>&times;</button>
      </div>
      <div class="voice-content">
        <p class="voice-hint">Say <strong>"ehis"</strong> followed by a command:</p>
        <ul class="command-list">
          {#each COMMANDS as cmd}
            <li>{cmd.trigger}</li>
          {/each}
        </ul>
        {#if listening}
          <div class="listening-indicator">
            <span class="pulse"></span>
            <span>Listening...</span>
          </div>
          {#if transcript}
            <div class="transcript">{transcript}</div>
          {/if}
        {/if}
        {#if command}
          <div class="command-echo">{command}</div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .voice-trigger {
    background: transparent;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    padding: 4px 8px;
    font-size: 14px;
    cursor: pointer;
    color: var(--text-secondary);
  }

  .voice-trigger.listening {
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-color: var(--accent-primary);
  }

  .voice-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 300;
  }

  .voice-panel {
    width: min(400px, 90vw);
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

  .voice-content {
    padding: 20px;
  }

  .voice-hint {
    font-size: 13px;
    color: var(--text-muted);
    margin-bottom: 12px;
  }

  .command-list {
    list-style: none;
    padding: 0;
    margin: 0 0 16px;
  }

  .command-list li {
    padding: 6px 12px;
    background: var(--surface-raised);
    border-radius: var(--radius-sm);
    margin-bottom: 4px;
    font-size: 12px;
  }

  .listening-indicator {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px;
    background: var(--accent-primary);
    color: var(--text-on-accent);
    border-radius: var(--radius-md);
    margin-bottom: 8px;
  }

  .pulse {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: currentColor;
    animation: pulse 1s infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }

  .transcript, .command-echo {
    font-size: 13px;
    font-style: italic;
    color: var(--text-secondary);
  }
</style>
