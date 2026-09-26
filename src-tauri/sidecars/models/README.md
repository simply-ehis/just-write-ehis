# models/ — fetched sidecar assets (not in version control)

This dir is populated by the fetcher (pinned releases, no network at runtime).
Release fetches require the SHA-256 values in `fetch_sidecars.py`; set
`JWE_ALLOW_UNPINNED_SIDECARS=1` only for local investigation.

```sh
python src-tauri/sidecars/fetch_sidecars.py --stt   # moonshine-base GGUF
python src-tauri/sidecars/fetch_sidecars.py --tts   # kokoro-multi-lang-v1_0 bundle
python src-tauri/sidecars/fetch_sidecars.py --llm   # llama-server + LFM 2.5-350M GGUF
```

Expected layout after fetching:

```
models/
  moonshine-base-Q8_0.gguf
  kokoro-multi-lang-v1_0/   (model.int8.onnx, voices.bin, tokens.txt, espeak-ng-data/)
  llama-server.exe + runtime DLLs
  lfm2.5-350m-q4_k_m.gguf
```

`build_sidecars.py` packages the Python servers and their native inference
dependencies under `sidecars/bin/`; model files stay here so one copy is
shared by development and installed runtimes.

The backend resolves `models/llama-server.exe` first, then the sidecars root
(see `LlmManager::start`). This README keeps the `models/*` bundle glob
resolving before the first fetch; it ships harmlessly (1 KB).
