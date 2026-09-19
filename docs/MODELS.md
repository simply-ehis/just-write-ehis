PURPOSE: which model per job, how to swap it, what the licenses allow
OWNERS: model picks, slot routing, sidecar model plumbing
READ-WHEN: AI answers badly, swapping STT/TTS/LLM models, adding a new slot
KEY-FILES: Settings → AI & Providers, src/lib/stores/audio.ts, src-tauri/sidecars/{stt,tts}_server.py, src-tauri/sidecars/fetch_sidecars.py
INVARIANTS: small slot = ghost/light tasks; main slot = chat/composer/structurize; voice swaps apply on next sidecar start
GOTCHAS: sidecars download weights on first run (network needed once); voice swaps need a sidecar restart, LLM swaps take effect immediately; fetch script downloads binaries + weights to models/; verify ollama tags with `ollama pull` before trusting names here
UPDATED: 2026-09-17

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

Changeability contract (every pick below must satisfy all three, verified):
1. paste the name/id/repo into its Settings field — no code change;
2. Settings → AI → **Test** confirms the endpoint serves it;
3. no weights are bundled — `fetch_sidecars.py` downloads once, swapping never bloats the repo.

## Light LLM (small slot, cap 0.5B — deep-researched Sept 2026)

The slot's jobs: inline continuation (Ghost), brace-directive extraction,
title/tag suggestions, craft-metric notes. All want instruction-following
+ structured output at minimum latency, not reasoning.

Ranked:

1. **LFM2.5-350M** (Liquid AI) — **default, keep.** Native function
   calling, 32K context, marketed verbatim as "data extraction and tool
   use". Three confirmed routes: Ollama `LiquidAI/lfm2.5-350m` (`:q4_0`,
   `:q8_0`), GGUF `LiquidAI/LFM2.5-350M-GGUF:Q4_K_M`
   (`ollama run hf.co/LiquidAI/LFM2.5-350M-GGUF:Q4_K_M` or
   `llama serve -hf …`), llama.cpp/LM Studio/vLLM. Best fit per job.
2. **`qwen3:0.6b`** (Ollama) — biggest instruct jump in the survey data
   (BBH ~41 vs ~16 for Qwen2.5-0.5B), native tool calling, safest
   one-command install: `ollama pull qwen3:0.6b`. First fallback.
3. **Falcon-H1-0.5B** (TII) — exactly at cap; hybrid Transformer+Mamba,
   claims ~2024-7B-class performance, instruct + tool-calling variants,
   GGUF in `tiiuae`'s collection, Ollama-able. Caveats: hybrid arch wants
   a recent llama.cpp, and the Falcon-LLM license needs a read before
   commercial use. Bench it, don't default it.
4. **SmolLM2-360M-Instruct** (HuggingFace, Apache 2.0) — the license-safe
   pick (`ollama run smollm2:360m`); solid, unexciting, honest.
5. **`granite4:350m`** (Ollama, tools-tagged) — IBM entry with explicit
   tool-calling; bench option if extraction fidelity disappoints.

Also-rans: `gemma3:270m` (fine generalist, weaker instruction-following),
Falcon-H1-Tiny-90M (fascinating for classification-only micro-tasks, too
small for continuation — not a slot replacement), MobileLLM-Flash-350M /
Apertus-Mini-0.5B / MobileMoE-0.3B (paper-strong, weak GGUF/Ollama
availability — revisit when packaged).

No "Baron" tiny model exists: the name matches either an 8B uncensored
Ollama fine-tune (4.9GB, 10× over cap, wrong job) or PyCQA/baron, a Python
parser, not a model. Not pursued.

### Finetune verdict: base wins

The LFM2.5-350M finetune landscape is encoders, embeddings, language
variants, MLX/ONNX ports, and near-zero-traction experiments
(home-assistant SFT, uncensored/heretic forks). Nothing beats base for
extraction or continuation — **run base**. Revisit only if a finetune
ships with evals.

### Constraint audit (Sept 2026 Hub sweep — why the shortlist is short)

Under 2026 + non-giant + ≤0.5B + packaged generalist, the Hub set is
empty; each name below costs one constraint:

| Candidate | Disqualifier |
|---|---|
| Falcon-H1-0.5B (+ Tiny-Tool-Calling-90M) | excluded by instruction |
| SmolLM2-360M (+ finetunes) | 2024; finetunes ~0 signal |
| Gemma-270M (+ finetunes) | 2025; finetunes zero signal |
| Qwen3-0.6B | excluded family; 600M over cap |
| Apertus Mini, MobileLLM-Flash, EuroLLM/Sailor 0.5B | not packaged / don't exist |
| Granite 350M | no GGUF (Ollama-only) |
| Danube3-500M, PleIAs-Nano | 2024 (+over-cap/llama-arch for Nano) |
| xLAM, Hammer | nothing ≤0.5B |
| MobileMoE | MoE arch risk + unpackaged |
| Mistral 0.4B drafts | speculative-decode dummies, wrong job |
| SmolVLM, Minueza-3-95M | vision / roleplay — wrong job |
| BitCPM4-0.5B | 2025 only — closest alternate (434M, Apache 2.0, official GGUF) |

## Main LLM (main slot)

- `qwen3:8b` (Ollama) — capable local chat/prose work on modest hardware.
- `qwen3:0.6b` — when the main box is weak; still coherent for short turns.
- `llama3.2` — the safe default everything was built against.
- Any OpenAI-compatible API also works (keys in Settings); per-workspace
  local-only toggles still apply.

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