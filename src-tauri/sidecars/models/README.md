# models/ — fetched sidecar assets (not in version control)

This dir is populated by the fetcher (pinned releases, no network at runtime).
Release fetches require the SHA-256 values in `fetch_sidecars.py`; set
`JWE_ALLOW_UNPINNED_SIDECARS=1` only for local investigation.

```sh
python src-tauri/sidecars/fetch_sidecars.py --stt   # moonshine-base GGUF
python src-tauri/sidecars/fetch_sidecars.py --phonon   # phonon-31m-en bundle
python src-tauri/sidecars/fetch_sidecars.py --llm   # llama-server only (optional, not bundled)
```

Expected layout after fetching:

```
models/
  moonshine-base-Q8_0.gguf
  phonon-31m-en/   (model.q8.gguf, config.json, tokenizer.json, default-voice.safetensors, voices.jsonl, voices/*.safetensors)
  llama-server.exe + runtime DLLs   (only after --llm; never shipped)
```

Small LLM weights are not bundled. Place a GGUF directly in the app data
`models` folder; Settings scans that folder and lets you select the file.
The Windows resource list includes only the STT weight, the Phonon voice
bundle and `sidecars/bin/` — the LLM runner and its DLLs are deliberately
left out, so a local GGUF in this development folder is never copied into
the installer.

`build_sidecars.py` packages the Python servers and their native inference
dependencies under `sidecars/bin/`; model files stay here so one copy is
shared by development and installed runtimes.

The backend resolves `models/llama-server.exe` first, then the sidecars root
(see `LlmManager::start`), and reports "runner not found — run
`fetch_sidecars.py --llm`" when the optional runner is absent.
