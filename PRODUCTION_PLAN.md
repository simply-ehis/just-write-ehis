# Production Readiness Plan — Just Write ehis (v3)

## Scope
Cancel generations, rate limiting (cooldown only), request timeouts, model activity indicator (all bundled models), STT/TTS/LFM lifecycle fixes, error handling polish, new logo, misc production fixes.

---

## Phase 1: AI Generation Controls

### 1.1 Cancel Button for AI Generations
**Files:** `AiPanel.svelte`, `api.ts`, `commands.rs`

- Add `AbortController` in `AiPanel.svelte` — stored as component state
- Modify `api.aiGenerateStream` to accept an `AbortSignal` and pass it through the Tauri Channel
- In `commands.rs`: add a shared `CancellationToken` (`Arc<AtomicBool>`) per stream. When cancelled, break the SSE read loop. Return partial content collected so far.
- Add cancel button to UI: appears when `generating === true`, positioned next to the "Thinking..." indicator
- On cancel: abort the stream, save partial response (if any), reset `generating` state
- Clean up: cancel any pending request on component unmount (`onDestroy`)

### 1.2 Rate Limiting (Cooldown Only)
**Files:** `AiPanel.svelte`, `settings.ts`

- Minimum 3-second cooldown between sends (configurable in settings)
- Show cooldown timer on send button ("Wait 2s...")
- Track last send timestamp in component state
- **No hourly cap**

Settings addition:
```typescript
aiRateLimitCooldown: number;  // seconds between sends, default 3
```

### 1.3 Request Timeouts
**Files:** `commands.rs`

- Add timeout to `reqwest::Client` builder: 90s for chat, 180s for composer/structurize
- On timeout: return clear error "Request timed out — the model may be overloaded"

---

## Phase 2: Model Activity Indicator (All Bundled Models)

### 2.1 Model Indicator Component
**Files:** new `ModelIndicator.svelte`, `TabBar.svelte` or `StatusBar.svelte`

Location: Right side of TabBar (or StatusBar), shows all active bundled models as tiny colored dots/icons.

States per model:
- **Not downloaded**: gray dot, tooltip "Model not downloaded"
- **Downloaded, not running**: amber dot, tooltip "Model ready, not running"
- **Starting**: pulsing dot, tooltip "Starting {model}..."
- **Running**: solid colored dot, tooltip "{model} — active"
- **Crashed**: red dot with `×`, tooltip "{model} crashed — click to restart"

Each dot is clickable: toggles the model on/off or restarts on crash.

### 2.2 Model Type Colors
| Model | Color | Port |
|-------|-------|------|
| LFM 2.5-350m (LLM) | `#C45D3E` terracotta | 8093 |
| Moonshine (STT) | `#4A9D8E` teal | 8090 |
| Kokoro (TTS) | `#2563eb` blue | 8091 |
| External model (main) | `#7C5CFC` purple | varies |
| Memory sidecar | `#7A7268` muted | 8092 |

### 2.3 Fix LFM Lifecycle (Critical)
**Files:** `audio.ts`, `commands.rs`, `sidecar.rs`, `EditorPane.svelte`

**Problem:** `ensureLlm()` exists but is never called — ghost autocomplete assumes llama.cpp is running.

Fix:
- Call `ensureLlm()` from `EditorPane.svelte` before first ghost request
- Fix `is_running()` to actually check process status (use `try_wait()` or poll the child PID, not just `Mutex<Option<Child>>`)
- Add crash detection: periodic health check (every 30s) when model is supposed to be running
- On crash: set `llmRunning = false`, show red indicator, notify user

### 2.4 Fix STT Lifecycle
**Files:** `audio.ts`, `MicButton.svelte`

- Add cancel for in-flight transcription (AbortController on the fetch call)
- Add recording elapsed timer (show "0:05" while recording)
- Fix `is_running()` same as LFM — check actual process status

### 2.5 Fix TTS Lifecycle
**Files:** `audio.ts`, `ReadAloudButton.svelte`

- Add progress indicator during playback (simple elapsed/total or progress bar)
- Add cancel for synthesis (not just playback)
- Fix `is_running()` same as LFM

### 2.6 Sidecar Health Watchdog
**Files:** new `sidecarWatchdog.ts` or in `audio.ts`

- After any sidecar starts, poll health every 30s
- On health failure → mark as crashed, update indicator
- On restart attempt → exponential backoff (1s, 2s, 4s, max 3 retries)
- All sidecars share the same watchdog pattern

---

## Phase 3: Error Handling Polish

### 3.1 Toast for AI Failures
**Files:** `AiPanel.svelte`

- On generation failure: `showToast("AI generation failed: {short message}", "error")`
- Keep inline error in chat too

### 3.2 Retry Button After Failed Generation
**Files:** `AiPanel.svelte`

- After error in chat, show small "Retry" button
- Re-sends last user message with same context

### 3.3 Friendly Error Messages
**Files:** `AiPanel.svelte`

Map errors to readable text:
- 401/403 → "API key rejected — check your provider settings"
- 429 → "Rate limited — wait a moment"
- 408/timeout → "Timed out — model may be overloaded"
- Network → "Can't reach AI server — is it running?"
- Empty → "Empty response — try rephrasing"

### 3.4 Composer/Structurize Error Polish
**Files:** `AiPanel.svelte`

- Styled error blocks, not raw text
- Retry button for each

---

## Phase 4: Toast Polish

### 4.1 Toast Dismiss
**Files:** `Toast.svelte`

- Add `×` close button
- Click-to-dismiss
- Max 3 visible, queue rest

---

## Phase 5: New Logo

### 5.1 Generate All Sizes
**Files:** `src-tauri/icons/*`, `public/icon-*.png`, `public/logo.svg`, `public/logo-light.svg`, installer BMPs

- SVG wordmark/monogram ("JW" or "Just Write")
- Export via Python (Pillow) to all required PNG/ICO/BMP sizes
- Warm editorial feel, terracotta accent

---

## Phase 6: Misc Production Polish

### 6.1 Global Loading Indicator
**Files:** `App.svelte`

- Use for export, backup, compile manuscript (>500ms operations)

### 6.2 Settings Polish
**Files:** `SettingsPane.svelte`

- AI test buttons show latency + model name
- Endpoint URL validation

---

## Implementation Order

| Step | What | Est. Effort |
|------|------|-------------|
| 1 | Cancel button + abort mechanism | Medium |
| 2 | Rate limiting (cooldown only) | Small |
| 3 | Request timeouts in Rust | Small |
| 4 | Fix `is_running()` for all sidecars (actual process check) | Small |
| 5 | Fix `ensureLlm()` — wire it to EditorPane ghost autocomplete | Small |
| 6 | Add crash detection watchdog (30s health poll) | Medium |
| 7 | Model indicator component (dots for all bundled models) | Medium |
| 8 | STT cancel + elapsed timer | Small |
| 9 | TTS progress indicator + synthesis cancel | Small |
| 10 | Toast for AI errors + friendly messages + retry | Small |
| 11 | Composer/structurize error polish | Small |
| 12 | Toast dismiss button | Small |
| 13 | Logo generation (all sizes) | Medium |
| 14 | Global loading + settings polish | Small |

Total: ~14 steps. Medium effort overall, spread across a session.

---

## Verification

After each step:
- `npx svelte-check` — 0 errors
- `npm run build` — clean
- `npm run test:e2e` — all pass

After all steps:
- Full `npx tauri build` with signing
- Manual test: AI cancel, model indicator shows all bundled models, STT record+transcribe, TTS play+stop, crash detection works
