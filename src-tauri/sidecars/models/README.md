# models/ — fetched sidecar assets (not in version control)

This dir is populated by the fetcher (pinned releases, no network at runtime):

```sh
python src-tauri/sidecars/fetch_sidecars.py --stt   # transcribe-cli + moonshine-base GGUF
python src-tauri/sidecars/fetch_sidecars.py --tts   # kokoro-multi-lang-v1_0 bundle
python src-tauri/sidecars/fetch_sidecars.py --llm   # llama-server + LFM 2.5-350M GGUF
```

Expected layout after fetching:

```
models/
  transcribe-cli.exe
  moonshine-base-Q8_0.gguf
  kokoro-multi-lang-v1_0/   (model.onnx, voices.bin, tokens.txt, espeak-ng-data/)
  llama-server/             (extracted release tree)
  llama-server.exe          (copied up by the fetcher)
  lfm2.5-350m-q4_k_m.gguf
```

The backend resolves `models/llama-server.exe` first, then the sidecars root
(see `LlmManager::start`). This README keeps the `models/*` bundle glob
resolving before the first fetch; it ships harmlessly (1 KB).
