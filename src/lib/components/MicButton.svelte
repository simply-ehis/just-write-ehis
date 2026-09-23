<script lang="ts">
  /**
   * MicButton — Moonshine STT.
   * Press to record → press again to stop → transcribe → insert at cursor.
   * Captures real 16 kHz mono WAV via WebAudio (ScriptProcessor, muted tap)
   * and posts it to the transcribe.cpp STT sidecar.
   * Lazy-loads STT sidecar on first tap (A7.6).
   */
import {
  ensureStt,
  sttRecording,
  sttTranscribing,
  sttError,
  sttModelLoaded,
  sttProbed,
  sttStarting,
  STT_FETCH_HINT,
} from '$lib/stores/audio';
import { startDictation, voiceSupported, type VoiceHandle } from '$lib/voice';

  let {
    onTranscribe = (text: string) => {},
  }: {
    onTranscribe?: (text: string) => void;
  } = $props();

  let recording = $state(false);
  let processing = $state(false);
  // Explicit one-tap fallback: offered (never auto-switched) when the
  // sidecar fails but Web Speech exists. Browser dictation may hit the
  // network — the tap is the consent.
  let offerBrowserVoice = $state(false);
  let browserVoiceOn = $state(false);
  let browserHandle = $state<VoiceHandle | null>(null);
  // Gated only after a probe attempt: never disabled on cold boot.
  let gated = $derived($sttProbed && !$sttModelLoaded);
  // WebAudio capture chain — produces real 16 kHz mono WAV for the STT server.
  let audioCtx: AudioContext | null = null;
  let micStream: MediaStream | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let processorNode: ScriptProcessorNode | null = null;
  let muteNode: GainNode | null = null;
  let pcmChunks: Float32Array[] = [];
  let captureRate = 16000;

  async function handleToggle() {
    if (recording) {
      // Stop recording
      stopRecording();
    } else {
      // Start recording
      await startRecording();
    }
  }

  async function startRecording() {
    // Lazy-load sidecar on first tap
    offerBrowserVoice = false;
    const ready = await ensureStt();
    if (!ready) {
      // Offer (don't auto-switch) browser dictation when available.
      if (voiceSupported()) offerBrowserVoice = true;
      return;
    }
    if ($sttProbed && !$sttModelLoaded) {
      $sttError = STT_FETCH_HINT;
      if (voiceSupported()) offerBrowserVoice = true;
      return;
    }

    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });

      // Ask for 16 kHz; resampled below if the device insists otherwise.
      audioCtx = new AudioContext({ sampleRate: 16000 });
      captureRate = audioCtx.sampleRate;
      sourceNode = audioCtx.createMediaStreamSource(micStream);
      processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
      muteNode = audioCtx.createGain();
      muteNode.gain.value = 0; // never play the mic back

      pcmChunks = [];
      processorNode.onaudioprocess = (e) => {
        pcmChunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };

      sourceNode.connect(processorNode);
      processorNode.connect(muteNode);
      muteNode.connect(audioCtx.destination);

      recording = true;
      $sttRecording = true;
    } catch (e) {
      $sttError = `Mic access denied: ${e}`;
    }
  }

  function stopRecording() {
    try {
      processorNode?.disconnect();
      muteNode?.disconnect();
      sourceNode?.disconnect();
      micStream?.getTracks().forEach((t) => t.stop());
      void audioCtx?.close();
    } finally {
      audioCtx = null;
      micStream = null;
      sourceNode = null;
      processorNode = null;
      muteNode = null;
      recording = false;
      $sttRecording = false;
      void processRecording();
    }
  }

  /** Float32 chunks @ captureRate → 16 kHz mono 16-bit WAV bytes. */
  function encodeWav16k(chunks: Float32Array[], srcRate: number): Uint8Array {
    let merged: Float32Array;
    if (srcRate === 16000) {
      const total = chunks.reduce((n, c) => n + c.length, 0);
      merged = new Float32Array(total);
      let off = 0;
      for (const c of chunks) {
        merged.set(c, off);
        off += c.length;
      }
    } else {
      // Linear-interp resample to 16 kHz.
      const totalIn = chunks.reduce((n, c) => n + c.length, 0);
      const flat = new Float32Array(totalIn);
      let off = 0;
      for (const c of chunks) {
        flat.set(c, off);
        off += c.length;
      }
      const outLen = Math.floor((totalIn * 16000) / srcRate);
      merged = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const pos = (i * srcRate) / 16000;
        const j = Math.floor(pos);
        const frac = pos - j;
        const a = flat[j] ?? 0;
        const b = flat[j + 1] ?? a;
        merged[i] = a + (b - a) * frac;
      }
    }
    const buf = new ArrayBuffer(44 + merged.length * 2);
    const dv = new DataView(buf);
    const writeStr = (o: number, s: string) => {
      for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    dv.setUint32(4, 36 + merged.length * 2, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    dv.setUint32(16, 16, true);
    dv.setUint16(20, 1, true); // PCM
    dv.setUint16(22, 1, true); // mono
    dv.setUint32(24, 16000, true);
    dv.setUint32(28, 16000 * 2, true);
    dv.setUint16(32, 2, true);
    dv.setUint16(34, 16, true);
    writeStr(36, 'data');
    dv.setUint32(40, merged.length * 2, true);
    for (let i = 0; i < merged.length; i++) {
      const v = Math.max(-1, Math.min(1, merged[i]));
      dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Uint8Array(buf);
  }

  function bytesToB64(bytes: Uint8Array): string {
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(bin);
  }

  function startBrowserDictation() {
    offerBrowserVoice = false;
    try {
      browserHandle = startDictation(
        (text, isFinal) => {
          if (isFinal && text.trim()) onTranscribe(text.trim() + " ");
        },
        (reason) => {
          $sttError = reason;
        },
      );
      browserVoiceOn = true;
      $sttRecording = true;
    } catch {
      $sttError = "Voice input not supported in this browser.";
    }
  }

  function stopBrowserDictation() {
    try {
      browserHandle?.stop();
    } finally {
      browserHandle = null;
      browserVoiceOn = false;
      $sttRecording = false;
    }
  }

  async function processRecording() {
    processing = true;
    $sttTranscribing = true;

    try {
      if (pcmChunks.length === 0) {
        $sttError = 'No audio captured — try again.';
        return;
      }
      const wavBytes = encodeWav16k(pcmChunks, captureRate);
      const audioB64 = bytesToB64(wavBytes);

      // Transcribe via Moonshine (real 16 kHz mono WAV)
      const { transcribeAudio } = await import('$lib/stores/audio');
      const text = await transcribeAudio(audioB64, 'wav');

      if (text && text.trim()) {
        onTranscribe(text.trim());
      }
    } catch (e) {
      $sttError = `Transcription failed: ${e}`;
    } finally {
      processing = false;
      $sttTranscribing = false;
      pcmChunks = [];
    }
  }
</script>

<button
  class="mic-btn"
  class:recording
  class:processing
  disabled={processing || gated}
  onclick={() => {
    if (browserVoiceOn) {
      stopBrowserDictation();
      return;
    }
    void handleToggle();
  }}
  title={gated ? STT_FETCH_HINT : recording ? 'Stop recording' : 'Record (Moonshine Voice STT)'}
  aria-label={gated ? 'Voice model not loaded' : recording ? 'Stop recording' : 'Start voice recording'}
>
  {#if processing}
    <svg width="16" height="16" viewBox="0 0 16 16" class="spinner">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="20 12" />
    </svg>
  {:else if recording || browserVoiceOn}
    <!-- Stop icon (square) -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <rect x="3" y="3" width="10" height="10" rx="1" fill="currentColor" />
    </svg>
  {:else}
    <!-- Mic icon -->
    <svg width="16" height="16" viewBox="0 0 16 16">
      <path d="M8 1a3 3 0 0 0-3 3v4a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" fill="none" stroke="currentColor" stroke-width="1.5"/>
      <path d="M4 7a4 4 0 0 0 8 0" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="8" y1="11" x2="8" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      <line x1="6" y1="14" x2="10" y2="14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
    </svg>
  {/if}
</button>

{#if $sttStarting && !recording && !processing}
  <div class="stt-progress">{$sttStarting}</div>
{/if}
{#if offerBrowserVoice}
  <button class="browser-voice-offer" onclick={startBrowserDictation}>
    Use browser dictation instead
  </button>
{/if}
{#if $sttError}
  <div class="stt-error">{$sttError}</div>
{/if}

<style>
  .mic-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    border: 1px solid var(--border, #333);
    border-radius: 4px;
    background: var(--surface, #1a1a1a);
    color: var(--text, #ccc);
    cursor: pointer;
    padding: 0;
    transition: background 0.15s, color 0.15s;
  }
  .mic-btn:hover {
    background: var(--surface-hover, #2a2a2a);
  }
  .mic-btn.recording {
    background: #dc2626;
    color: white;
    border-color: #dc2626;
  }
  .mic-btn.processing {
    opacity: 0.6;
    cursor: wait;
  }
  .spinner {
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  .stt-error {
    font-size: 11px;
    color: #dc2626;
    margin-top: 2px;
  }
  .stt-progress {
    font-size: 11px;
    color: var(--text-muted);
    margin-top: 2px;
  }
  .browser-voice-offer {
    font-size: 11px;
    color: var(--accent-primary);
    text-decoration: underline;
    margin-top: 2px;
    padding: 6px 4px;
  }
  @media (max-width: 480px) {
    .mic-btn {
      width: 44px;
      height: 44px;
    }
    .browser-voice-offer {
      min-height: 44px;
    }
  }
</style>
