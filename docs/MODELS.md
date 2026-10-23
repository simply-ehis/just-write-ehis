PURPOSE: which model per job, how to swap it, what the licenses allow
OWNS: model picks, slot routing, sidecar model plumbing
READ-WHEN: AI answers badly, swapping STT/TTS/LLM models, adding a new slot
KEY-FILES: Settings → AI & Providers, src/lib/stores/audio.ts, src-tauri/sidecars/{stt,tts}_server.py, src-tauri/sidecars/build_sidecars.py
INVARIANTS: small slot = ghost/light tasks; main slot = chat/composer/structurize; voice swaps apply on next sidecar start
GOTCHAS: release builds package Python runtimes and weights; source runs need a PATH Python command plus requirements; TTS is ready before its lazy first synthesis; model swaps require a sidecar restart
UPDATED: 2026-10-20

# MODELS.md — picks per job (researched Sept 2026)

## Slot routing (wired)

| Slot | Serves | Settings fields |
|---|---|---|
| Small | Ghost autocomplete, light tasks | Small endpoint + name |
| Main | Chat, Composer, Structurize | Main endpoint + name |
| STT | MicButton dictation | `sttModel` path → `stt_server.py argv[2]` |
| TTS | Read-aloud | `ttsModel` dir → `tts_server.py argv[2]` (called per sentence from the render-ahead job in `tts_render.rs`; the sidecar itself never plays audio) |

For the local LLM, place a `.gguf` file directly in the app data `models`
folder, refresh the list in Settings → AI, and select its filename. The app
loads the file as-is; it does not quantize or convert it. Remote providers
still use an endpoint and model id. Restart the sidecar after changing a
model.
Web exception: the browser build uses built-in speech recognition/synthesis,
so STT/TTS model fields only affect the desktop sidecars.

## Desktop runtime packaging

The Windows release is self-contained for STT, TTS, AI memory, and the bundled
LLM. `tauri.windows.conf.json` runs `build_sidecars.py` before a Windows
desktop build; that script creates `sidecars/bin/{stt,tts,memory}-server.exe`
with PyInstaller. The Rust sidecar managers prefer those executables and pass
`JWE_SIDECARS_DIR` so the packaged servers resolve the external model files
without embedding hundreds of megabytes inside each executable. STT, TTS, and
memory communicate over stdio JSON frames (no TCP ports); the LLM binds an
AF_UNIX socket at a per-session path. If a sidecar fails to start, startup
fails closed instead of killing unrelated processes.

The Python-script fallback remains for source/development runs only. It
requires `python`, `python3`, or `py` on PATH plus `requirements.txt`; custom
interpreter executable paths are rejected. End users do not need a separate
Python installation after a release build.

## Model selection contract

- Local LLMs are discovered from `.gguf` files directly inside the fixed app
  data `models` folder. Settings stores the selected filename; the backend
  resolves it inside that folder or the bundled resources folder.
- The local runner passes GGUFs through unchanged. Its runtime flags are
  Flash Attention on, K/V cache `q8_0`, and one server slot.
- Remote slots use an OpenAI-compatible endpoint and model id. Settings → AI
  → **Test** checks the configured endpoint.

## Light LLM (small slot)

The slot's jobs: inline continuation (Ghost), brace-directive extraction,
title/tag suggestions, craft-metric notes. All want instruction-following
+ structured output at minimum latency, not reasoning.

Picks (endpoint + model name — OpenAI, Google, Anthropic, or Custom):

1. **Local model endpoint** — default. The small-model sidecar serves it over
   a per-session AF_UNIX socket (zero config, no key). Add a GGUF to the app
   data models folder and choose it in Settings;
   the frontend's `is_local_llm_sentinel` matches the legacy
   `http://127.0.0.1:8093/v1` / `http://localhost:8093/v1` values and
   routes those to the socket transparently.
2. **OpenAI** — same account/key as the main slot, smaller model id.
3. **Google (Gemini)** — via Google's OpenAI-compatibility base URL.
4. **Anthropic** — via an OpenAI-compatible gateway (the slot only speaks
   `/chat/completions` + Bearer, so the native Anthropic API won't plug
   in directly).
5. **Custom** — any endpoint serving OpenAI-compatible `/chat/completions`
   + `/models` (the Test button verifies both).

### Provider notes

Remote providers speak `{base}/chat/completions` with a Bearer key and are
verified by `{base}/models`. The local model is started through its private
socket and must be a GGUF selected from the app data models folder.

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
- The STT sidecar runs `transcribe_cpp` in-process through the pinned
  `transcribe-cpp-native` runtime — no PyTorch, no separate transcribe CLI,
  and no network at runtime. 16 kHz mono WAV in, plain text out.
- Model source: `memoravox/moonshine-base-gguf` on Hugging Face.
- The legacy value `moonshine-base` resolves to the bundled
  `moonshine-base-Q8_0.gguf` for compatibility.
- Evaluated and rejected, on record: Nemotron 0.6B streaming and Parakeet
  TDT 0.6B (both 2.5GB — 10× the weight for short captures), Voxtral
  Mini 4B (needs 16GB GPU), cloud streaming APIs (against local-first).

### STT fetch (one-time)

```bash
python src-tauri/sidecars/fetch_sidecars.py --stt
```

The fetcher requires pinned SHA-256 values in `fetch_sidecars.py` for release downloads. For a local-only research fetch, set `JWE_ALLOW_UNPINNED_SIDECARS=1`; never use that override for a release.

This downloads:
- `moonshine-base-Q8_0.gguf` → `models/moonshine-base-Q8_0.gguf`

## TTS — Gradium Phonon q8 (Rust sidecar, torch-free)

- **Default (bundled)**: `models/phonon/model.q8.gguf` + voices —
  fetched by `fetch_sidecars.py --phonon`.
  - `phonon-40m-multilingual` (default): en, fr, de, es, pt — CC BY-NC 4.0
    (personal use; see Settings notice).
  - `phonon-31m-en`: English only — Apache-2.0 (commercial-safe).
  Switch checkpoint in Settings → AI & Providers → TTS Model.
- **Swap**: paste a local checkpoint directory containing `model.q8.gguf`,
  `tokenizer.json`, `config.json`, `default-voice.safetensors`, and
  optional `voices/*.safetensors` into Settings → AI →
  TTS Weights Repo. Empty = vendored default.
- The TTS sidecar is **`sidecars/phonon-server/`** — a Rust binary built
  with `cargo build --release`, driven by the `ptts`/`xn` crate.
  No PyTorch, no ONNX Runtime, no HuggingFace download at runtime,
  CPU-only, fully offline.
- Voices: 102 catalog voices from `gradium/phonon-voices` (Apache-2.0),
  including 37 English voices (25 standard + 12 character voices) and
  65 voices across fr, de, es, pt. See
  `src/lib/components/SettingsPane.svelte` PHONON_VOICES for the listed
  subset; the full catalog is at `gradium/phonon-voices`.
- Model source: `gradium/phonon-40m-multilingual` or
  `gradium/phonon-31m-en` on Hugging Face.
- Evaluated and rejected, on record: Pocket TTS v2.1 and Sopro v1.5
  (2026, smaller, cloning — but different architectures); Chatterbox
  (MIT, expressive cloning, ~0.5B + GPU); XTTS v2 (non-commercial);
  Fish Speech open variant (non-commercial); Piper (clear quality step
  down); Kokoro-82M via sherpa-onnx (replaced by Phonon — Kokoro’s own
  espeak-ng wrapper path degraded English pronunciation; Phonon’s native
  tokenizer is more accurate).

### TTS fetch (one-time)

```bash
python src-tauri/sidecars/fetch_sidecars.py --phonon
# or
python src-tauri/sidecars/fetch_sidecars.py --phonon --phonon-model phonon-31m-en
```

This downloads:
- `model.q8.gguf` (71 MB for 40m, 61 MB for 31m) → `models/phonon/`
- `config.json`, `tokenizer.json`, `default-voice.safetensors` → `models/phonon/`
- `voices.jsonl` + `voices/*.safetensors` → `models/phonon/voices/`
## Testing a slot

Settings → AI & Providers exposes **Test STT**, **Test TTS**, and **Test
bundled LLM**. STT performs a real model load, TTS generates a short test
waveform (its model intentionally lazy-loads on first synthesis), and the
LLM check performs a real completion after health verification. Run these
after changing a model path or upgrading a local runtime.
