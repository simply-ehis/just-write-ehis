# Follow-scroll listen pass — 2026-10-25

Verdict: **PASS** — during a real read, the `.tts-active-sentence` highlight
followed the audio, the reader scrolled with it, and no TTS error surfaced.

## Setup

- Dev app already running from `npm run tauri dev` with
  `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223
  --remote-allow-origins=*` (exe built 02:32, includes the Rust fixes; the
  frontend is served live by Vite).
- Harnesses: `ai-runtime-check.mjs` (Settings → AI runtime buttons),
  `read-aloud-pass.mjs` (the listen pass), `read-aloud-diag.mjs` (console /
  network capture when a read stalls), `cdp-eval.mjs` (one-shot probes).
- Long run: `RUN_MS=300000 SAMPLE_MS=400 node read-aloud-pass.mjs`
  (`RUN_MS`/`SAMPLE_MS` are now overridable for slow machines).

## AI runtime checks (real app, real sidecars)

| Check | Result |
| --- | --- |
| Test STT | `STT model loaded` |
| Test TTS | `You should have heard a test voice.` (audible — confirmed by ear) |
| Test local model | `Local model replied READY (verbatim: READY READY READYREADREAD)` (first attempt reported "llama is still starting", succeeded on retry) |

Models folder now resolves to `C:\Users\ehis\Documents\Just Write ehis\models`
(rendered in Settings), and the 229 MB `lfm2.5-350m-q4_k_m.gguf` was moved out
of the app-data folder on boot: `%APPDATA%\com.just-write-ehis.app\models` is
empty, Documents holds the file, the local-model test then completed against
it. Migration + resolution verified end to end.

## Listen pass (687 samples over 300 s)

- Read started, **no `.tts-error` at any sample**.
- Transport advanced `0 / 41 → 11 / 41 → 23 / 41 → 32 / 41 → 41 / 41`.
- Highlight: 4 distinct blocks lit in sequence, each `activeTop` in the 334–478
  band (centred in the viewport) while it spoke.
- Scroll followed: `199 → 743 → 1122 → 1370`.
- Ended at `100%`, phase `playing`, final state clean after the stop click.

## Timing note (not a failure, a hardware limit)

The pill sits in `loading` for **~70 s** before the first sound: the first page
needs 45 s of rendered audio and this machine is a **2-core** AMD, where one
sentence synthesises in ~10–12 s (steady state, release-built
`phonon-server.exe`). 160 of the 687 samples were `loading`; there were no
render errors and no mid-read stall in this run. `phonon-server` burned ~230 s
CPU over the run — the cost is inference, not a deadlock.

Diagnosis path: `read-aloud-diag.mjs` showed `tts_render_start` → repeated
`tts_render_demand` polls, zero console errors and zero failed requests; a
direct `tts_synthesize` invoke returned in 10–12 s, which is what pointed at
per-sentence synthesis cost rather than a hung sidecar (`tts_health` was
`ready:true, model_loaded:true` throughout).
