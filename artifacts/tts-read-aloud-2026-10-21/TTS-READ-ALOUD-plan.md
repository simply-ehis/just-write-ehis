# Read-aloud v2: render ahead, play on one clock

Date: 2026-10-21. Supersedes **section 2 ("Chunking: one sentence per call")** of
`AGENT-PROMPT-tts-phonon.md`. Everything else in that prompt (Phonon 31M via `ptts`,
Kokoro removal, the Settings > Voice table, migration, acceptance numbers) stands as
written. This plan replaces only *how audio is produced and how the UI tracks it*.

## 1. Why the current design is being replaced

Today `ReadAloudButton.svelte` builds a per-sentence queue and, for each sentence,
runs one `tts_synthesize` IPC → base64 WAV → `playWavBase64`, with a one-sentence
prefetch. Three problems, confirmed in the code:

1. **The UI is slaved to synth calls, not to audio.** `onSentence`/`onSection` fire
   when a *call completes*, so highlight/scroll-follow drift by up to one synth
   latency at every boundary and any slow call visibly stalls the reading flow.
2. **Chatty round trips.** One IPC per sentence (~2500 calls for a 100k-word doc),
   each paying base64 encode/decode of a whole WAV.
3. **Fragile.** Prefetch depth of 1 means any synthesis slower than realtime
   produces an audible gap; skip/jump mid-decode has generation-check hacks.

## 2. The design: one render job → pages + timeline → one audio clock

```
 doc snapshot
     │ segment once (frontend, pure)
     ▼
 Segment[]  {text, sectionIdx, paraIdx, charStart, charEnd, pauseAfter}
     │ tts_render_start(renderId, segments, params)     ← one IPC
     ▼
 Rust TtsRenderer  (loops sentences internally, inserts pauses,
     │              records sample offsets, emits pages)
     │  events: render_page / render_progress / render_done
     ▼
 Page[]  {pageIdx, pcm:i16@24kHz, startSample, endSample}   Timeline: SegmentTiming[]
     │ scheduled gapless on the AudioContext clock
     ▼
 one rAF loop reads ctx.currentTime → playheadSample → binary-search segment
     → highlight, follow-scroll, pill progress, resume memory
```

The app-level contract is **pages + timeline**. Whether the backend feeds the
runtime one sentence or one paragraph per internal call is an implementation
detail inside `TtsRenderer` (the runtime wants ~one sentence per call so its codec
state is clean — that stays; but no sentence ever crosses IPC or gets played as its
own buffer).

### 2.1 Segmentation (frontend, at play start)

Extend `readerSections.ts` — keep `splitSections`, `stripForTts`, `sentenceChunks`
reflow (soft wraps → paragraphs) — and emit segments that carry **char offsets into
the doc snapshot** plus a `pauseAfter: "sentence" | "paragraph" | "section"` flag.
Hard cap ~200 chars per segment (split long sentences at commas/semicolons, fall
back to spaces). Selection reads reuse the same path over the selected range.
Cost: <50 ms on 100k words; ~15k segments — trivial.

### 2.2 Rust `TtsRenderer` (new; sits beside the existing Kokoro `TtsManager`
until the Phonon swap, then replaces it)

Commands:
- `tts_render_start(segments: RenderSegment[], params: RenderParams) -> renderId`
- `tts_render_cancel(renderId)`
- `tts_render_demand(renderId, seconds)` — playback asks for more headroom

Events (Tauri `emit`, PCM as **raw i16le bytes via `ipc::Response`/binary payload**,
not base64 — avoids the 33 % tax):
- `tts://render-page {renderId, pageIdx, startSample, endSample, pcm}`
- `tts://render-progress {renderId, done, total}`
- `tts://render-done {renderId, totalSamples}`

Behavior:
- Loops segments; synthesizes each (per-sentence internal calls, ~50-token cap);
  appends `sentencePauseMs` silence between sentences, `paragraphPauseMs` at
  paragraph breaks, `~600 ms` at section breaks. Silence is generated, not
  synthesized — cheap and exact.
- **Records `SegmentTiming {segId, startSample, endSample}` as it goes** and ships
  the timings for a page's segments *with that page*. This is the whole trick:
  the timeline is sample-accurate because the thing that wrote the PCM wrote the
  offsets.
- **Page boundary snapped to a paragraph** where possible (~60 s of audio per
  page, 24 kHz i16 ≈ 2.8 MB — one binary IPC every several seconds, fine).
- **Bounded producer**: renders until `renderedAhead > 45 s`, then blocks until
  `tts_render_demand`. Memory is bounded on a 100k-word doc (~4.6 MB PCM resident;
  played pages are evicted by the frontend).
- Params (`voice`, `temperature`, `cfg_coef`, `seed`, pauses, speed factor) are
  fixed at render start; changes mid-read apply from the render frontier (see 2.4).

### 2.3 Playback + UI sync (frontend)

New module `src/lib/tts/player.ts` + store `src/lib/stores/readAloud.ts`
(`ReadAloudButton` becomes thin UI over it; `onSentence`/`onSection` prop
signatures are preserved so `EditorPane` / `ReaderWorkspace` / `JustWriteWorkspace`
keep working):

- **Gapless scheduling**: pages are decoded to `AudioBuffer`s and chained at
  `start(anchorCtxTime + (page.startSample - anchorSample) / sampleRate)`. Joins
  are sample-exact — a page boundary is physically incapable of producing a gap.
- **One clock, one rAF loop** (throttled ~10 Hz): `playheadSample =
  (ctx.currentTime - anchorCtxTime) * sampleRate + anchorSample`. Binary search
  over `SegmentTiming[]` → active segment → fires `onSentence`/`onSection`,
  updates the pill, drives follow-scroll. Highlight tracks audio within ~100 ms,
  through pauses and seeks, forever.
- **Pause/resume**: keep `AudioContext.suspend()` — it freezes `currentTime`, so
  the anchor math needs no rework.
- **Prev/next sentence**: map to `SegmentTiming[i].startSample`, stop sources,
  resume scheduling from that sample in whatever page holds it (re-render
  request if already evicted). Mid-paragraph skips are exact by construction.
- **Underrun safety net**: if playback reaches the render frontier, *hold* on the
  last sample with a subtle "catching up…" pill state and resume when the page
  lands — never stutter, never synth-call mid-sentence. (With Phonon faster than
  realtime this should be unreachable; it exists so the failure mode is silence
 -then-go, not choppy audio.)
- **Speed**: the runtime has no speed control, and plain `playbackRate` changes
  pitch (forbidden). Bake it in the renderer: WSOLA-class time-stretch with pitch
  preserved over the PCM stream (Rust, on the renderer output). Because the
  renderer is only ~45 s ahead, Ctrl+Shift+↑/↓ takes effect within one page —
  "a settings change applies from the next sentence" is satisfied. Timeline stays
  sample-accurate because stretching happens before offsets are finalized.
- **Browser preview path** stays what it is: `speechSynthesis` sentence queue.
  The player abstracts over both; only the desktop backend uses pages.
- **Doc edits during a read**: v1 freezes the snapshot the read started from
  (same effective behavior as today's prebuilt queue). Highlight maps against the
  snapshot; a follow-up can do dirty-range re-render using the char offsets
  already carried by segments.

### 2.4 Settings semantics under render-ahead

| Setting | Effect under this design |
|---|---|
| Sentence/paragraph pause | Backend-inserted silence; applies from the frontier (next unrendered page). Old pages keep their pauses. |
| Speed | WSOLA in the renderer; applies from the frontier (~45 s max lag). |
| Voice / temperature / cfg_coef / seed | Fixed per render. Changing mid-read restarts the render job from the current segment (playing page finishes first). |
| Volume | Gain node — instant, whole stream. |

### 2.5 What is deleted / kept

- Deleted: the per-sentence `playChunk` loop, the one-sentence prefetch, the
  `playWavBase64`-per-sentence path in `ReadAloudButton`, `TTS_SPLIT_PATTERN` /
  `TTS_CHUNK_SIZE` (already slated for removal by the Phonon prompt).
- Kept: `tts_synthesize` command **only** for the Settings voice Preview button
  (single short utterance, no timeline needed); warm-on-intent (warms the
  renderer instead); idle-offload; pause/resume/Esc; section-resume memory
  (now derived from the timeline's last-played segment, not queue index).

## 3. Files touched

| File | Change |
|---|---|
| `src/lib/readerSections.ts` | segments with char offsets + pause flags; 200-char hard cap with comma splitting |
| `src/lib/tts/player.ts` (new) | page scheduler, clock loop, seek/prev/next, underrun hold |
| `src/lib/stores/readAloud.ts` (new) | player state stores (playhead, activeSegment, progress, buffering) |
| `src/lib/stores/audio.ts` | drop per-sentence synth glue; wire render events; keep warm/idle-offload |
| `src/lib/components/ReadAloudButton.svelte` | thin UI over the player; pill gains progress % from playhead |
| `src-tauri/src/tts_render.rs` (new) | `TtsRenderer`: pauses, offsets, pages, bounded producer |
| `src-tauri/src/commands.rs` | `tts_render_start/cancel/demand`; `tts_synthesize` kept for Preview |
| `src-tauri/src/lib.rs`, `build.rs`, `permissions/main.toml`, `src/lib/api.ts` | new commands registered together (same rule as the Phonon prompt) |
| `docs/ARCHITECTURE.md`, `docs/MODELS.md` | document the render pipeline |

## 4. Phasing (each phase leaves the app working)

1. **Rust renderer with a stub synth** (no adapter layer for the old per-sentence
   path — it is deleted, not adapted)
2. **Timeline player + clock loop** against the stub renderer (silence + beeps) → proves page chaining,
   timeline math, seeks, underrun hold under unit tests without waiting on the
   Phonon integration.
3. **Phonon `ptts` in-process** behind the renderer (per the prompt's integration
   order: crate → sidecar binary → Python stop-gap).
4. **WSOLA speed**, pill progress, follow-scroll verification, delete leftovers.

## 5. Tests

- **Node (vitest)**: segmentation offsets round-trip into source text; binary
  search hits first/last/every segment; page-chain start times are contiguous
  (gap = 0 samples); prev/next at doc start/end; underrun hold then resume;
  freeze-snapshot behavior on doc edit.
- **Rust unit**: silence inserted is exactly `pauseMs * 24` samples; segment
  offsets monotonic and cover the stream; page snap lands on paragraph; bounded
  producer blocks at 45 s; seed determinism (same params → identical PCM).
- **Manual Windows listen pass** (unchanged acceptance): hard-wrapped paragraph
  has no gap > sentence pause + 50 ms; skip mid-page; speed change mid-read;
  numbers/dates/email/currency/pronunciation spot checks.

## 6. Acceptance deltas vs. the Phonon prompt

Everything in its section 5 still applies, with these reinterpreted:
- "no gap longer than the set sentence pause plus 50 ms" now includes **page
  joins** — guaranteed by construction; the listen test just confirms it.
- "previous/next sentence work mid-paragraph" — instant seeks on the timeline.
- "a settings change applies from the next sentence" — from the render frontier
  (≤45 s behind); acceptable and documented in the UI tooltip.
- New: time-to-first-audio is *first page*, not whole document (measure; target
  <1.5 s warm, ~2–4 s cold incl. model load); 100k-word doc never holds more
  than ~45 s of PCM (measure RSS).
