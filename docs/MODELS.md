PURPOSE: which model per job, how to swap it, what the licenses allow
OWNERS: model picks, slot routing, sidecar model plumbing
READ-WHEN: AI answers badly, swapping STT/TTS/LLM models, adding a new slot
KEY-FILES: Settings → AI & Providers, src/lib/stores/audio.ts, src-tauri/sidecars/{stt,tts}_server.py, src-tauri/sidecars/fetch_sidecars.py
INVARIANTS: small slot = ghost/light tasks; main slot = chat/composer/structurize; voice swaps apply on next sidecar start
GOTCHAS: sidecars download weights on first run (network needed once); voice swaps need a sidecar restart; main slot needs a provider key — Test it before trusting it mid-sentence
UPDATED: 2026-09-23

# MODELS.md — picks per job (researched Sept 2026)

## Slot routing (wired)

| Slot | Serves | Settings fields |
|---|---|---|
| Small | Ghost autocomplete, light tasks | Small endpoint + name |
| Main | Chat, Composer, Structurize | Main endpoint + name |
| STT | MicButton dictation | `sttModel` path → `stt_server.py argv[2]` |
| TTS | Read-aloud | `ttsModel` dir → `tts_server.py argv[2]` |

Swapping is paste-a-path: model names/ids/repos are strings end to end.
Restart the sidecar (toggle the feature or restart the app) after a voice swap.
Web exception: the browser build uses built-in speech recognition/synthesis,
so STT/TTS model fields only affect the desktop sidecars.

Changeability contract (every pick below must satisfy all three, verified):
1. paste the name/id/repo into its Settings field — no code change;
2. Settings → AI → **Test** confirms the endpoint serves it;
3. no weights are bundled — `fetch_sidecars.py` downloads once, swapping never bloats the repo.

## Light LLM (small slot)

The slot's jobs: inline continuation (Ghost), brace-directive extraction,
title/tag suggestions, craft-metric notes. All want instruction-following
+ structured output at minimum latency, not reasoning.

Picks (endpoint + model name — OpenAI, Google, Anthropic, or Custom):

1. **Bundled local endpoint** — default, keep. The small-model sidecar
   serves it at `http://127.0.0.1:8093/v1` with zero config and no key.
2. **OpenAI** — same account/key as the main slot, smaller model id.
3. **Google (Gemini)** — via Google's OpenAI-compatibility base URL.
4. **Anthropic** — via an OpenAI-compatible gateway (the slot only speaks
   `/chat/completions` + Bearer, so the native Anthropic API won't plug
   in directly).
5. **Custom** — any endpoint serving OpenAI-compatible `/chat/completions`
   + `/models` (the Test button verifies both).

### Provider notes

Both slots speak the same contract: `{base}/chat/completions` with a
Bearer key, verified up front by `{base}/models`. If Test lists your model
id, the slot works — provider-agnostic. No local-model tags, Ollama
commands, or GGUF paths are listed here on purpose; the bundled sidecar
is the only local exception and it needs no model pick.

## Main LLM (main slot)

Chat, Composer, Structurize. Paste the endpoint + model, add the key in
Settings → AI, then Test — the slot never assumes a provider.

- **OpenAI** — `https://api.openai.com/v1` + model id (default). Key required.
- **Google (Gemini)** — Google's OpenAI-compatibility base URL + Gemini
  model id (see Gemini docs for the current base URL). Key required.
- **Anthropic** — through an OpenAI-compatible gateway/proxy; the native
  Anthropic API won't plug in directly. Key lives in the gateway.
- **Custom** — any OpenAI-compatible endpoint (self-hosted gateway,
  compatible proxy). Paste base URL + model id, add a key if it needs one.
- Per-workspace local-only toggles still apply: a private workspace never
  calls the main slot.

## STT — Moonshine streaming only (locked, torch-free)

- **Default (bundled)**: `models/moonshine-base-Q8_0.gguf` — best accuracy
  in the family, fetched by `fetch_sidecars.py --stt`.
- **Swap**: paste a local `.gguf` path or a `models/<filename>.gguf` into
  Settings → AI → STT Model. Empty = bundled default.
- The STT sidecar runs the **transcribe.cpp CLI** (whisper.cpp heritage) —
  no PyTorch, no `moonshine-onnx`, no network at runtime. 16 kHz mono WAV
  in, plain text out.
- Model source: `memoravox/moonshine-base-gguf` on Hugging Face.
- Binary source: `transcribe.cpp` release `v0.2.3` → `transcribe-cli(.exe)`.
- Evaluated and rejected, on record: Nemotron 0.6B streaming and Parakeet
  TDT 0.6B (both 2.5GB — 10× the weight for short captures), Voxtral
  Mini 4B (needs 16GB GPU), cloud streaming APIs (against local-first).

### STT fetch (one-time)

```bash
python src-tauri/sidecars/fetch_sidecars.py --stt
```

This downloads:
- `transcribe-cli.exe` (Windows) + DLLs → `models/transcribe-cli/`
- `moonshine-base-Q8_0.gguf` → `models/moonshine-base-Q8_0.gguf`

## TTS — Kokoro-82M only (locked, torch-free)

- **Default (bundled)**: `models/kokoro-multi-lang-v1_0/` — 53 speakers,
  fetched by `fetch_sidecars.py --tts`.
- **Swap**: paste a local bundle directory containing `model.onnx`,
  `voices.bin`, `tokens.txt`, `espeak-ng-data/` into Settings → AI →
  TTS Weights Repo. Empty = vendored default.
- The TTS sidecar uses **sherpa-onnx `OfflineTtsKokoroModelConfig`** —
  no PyTorch, no HuggingFace download at runtime, CPU-only wheels.
- Voices available in v1.0 bundle (53 total):

  | Lang | Voices |
  |---|---|
  | `a` (en-US) | `af_alloy`, `af_aoede`, `af_bella`, `af_heart`, `af_jessica`, `af_kore`, `af_nicole`, `af_nova`, `af_river`, `af_sarah`, `af_sky`, `am_adam`, `am_echo`, `am_eric`, `am_fenrir`, `am_liam`, `am_michael`, `am_onyx`, `am_puck`, `am_santa` |
  | `b` (en-GB) | `bf_alice`, `bf_emma`, `bf_isabella`, `bf_lily`, `bm_daniel`, `bm_fable`, `bm_george`, `bm_lewis` |
  | `j` (ja) | `jf_alpha`, `jf_gongitsune`, `jf_nezumi`, `jf_tebukuro`, `jm_kumo` |
  | `z` (zh) | `zf_xiaobei`, `zf_xiaoni`, `zf_xiaoxiao`, `zf_xiaoyi`, `zm_yunjian`, `zm_yunxi`, `zm_yunxia`, `zm_yunyang` |
  | `e` (es) | `ef_dora`, `em_alex` |
  | `f` (fr) | `ff_siwis` |
  | `h` (hi) | `hf_alpha`, `hf_beta`, `hm_omega`, `hm_psi` |
  | `i` (it) | `if_sara`, `im_nicola` |
  | `p` (pt) | `pf_dora`, `pm_alex`, `pm_santa` |

  **Missing from v1.0 (fall back to `af_heart` with warning):** `jf_never`,
  `fm_alpha`, `hf_baya`, `hm_pratik`, `it_paola`, `pm_mario`, all `kf_*`,
  `km_*`. Korean has no v1.0 voice — see SHERPA docs for updates.
- Model source: sherpa-onnx release `tts-models/kokoro-multi-lang-v1_0.tar.bz2`
- Evaluated and rejected, on record: Pocket TTS v2.1 and Sopro v1.5
  (2026, smaller, cloning — but different architectures, need new sidecar
  servers, not repo swaps); Chatterbox (MIT, expressive cloning, ~0.5B +
  GPU); XTTS v2 (non-commercial); Fish Speech open variant
  (non-commercial); Piper (clear quality step down).

### TTS fetch (one-time)

```bash
python src-tauri/sidecars/fetch_sidecars.py --tts
```

This downloads:
- `kokoro-multi-lang-v1_0.tar.bz2` → extracts to `models/kokoro-multi-lang-v1_0/`

## Testing a slot

Settings → AI → **Test** per slot pings `{endpoint}/health` and reports
latency plus whether the configured model is loaded — do this before
trusting a new model mid-sentence.