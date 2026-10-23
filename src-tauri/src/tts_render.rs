//! Render-ahead TTS: one job renders pages of PCM plus a sample-accurate
//! segment timeline; playback schedules pages gapless on the audio clock.
//!
//! The contract with the frontend is **pages + timeline**: segments in,
//! `tts://render-page` metadata + `tts://render-progress`/`-done` events out,
//! PCM pulled per page as raw i16le bytes (`tts_render_page`) — no base64.
//! The renderer loops per-sentence synthesis internally (codec state stays
//! clean per sentence), inserts pauses as generated silence, and records
//! `SegmentTiming` offsets in the same pass that writes the PCM — that is
//! what makes the timeline sample-accurate.
//!
//! Synthesis today comes from the Phonon sidecar (`TtsManager`); the Phonon
//! swap replaces only the synth source inside `synth_segment`. Tests drive
//! `PageAssembler` directly with the deterministic stub synth — no sidecar.

use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

/// The one timeline rate. Phonon's native rate — anything else is
/// resampled on ingest so page/sample math never sees two clocks.
pub const RENDER_SAMPLE_RATE: u32 = 24_000;

/// Default silence class when a segment omits its pause (the frontend
/// normally computes per-segment pauses from this policy).
pub const SENTENCE_PAUSE_MS: u32 = 220;

fn default_sentence_pause() -> u32 {
    SENTENCE_PAUSE_MS
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Boundary {
    Sentence,
    Paragraph,
    Section,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderSegment {
    pub id: u32,
    pub text: String,
    /// Silence appended after this segment's audio, in ms.
    #[serde(default = "default_sentence_pause")]
    pub pause_after_ms: u32,
    /// Page-flush preference: pages snap after non-sentence boundaries.
    pub boundary: Boundary,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RenderParams {
    pub voice: String,
    pub speed: f64,
    pub lang_code: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SegmentTiming {
    pub seg_id: u32,
    pub start_sample: u64,
    pub end_sample: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageMeta {
    pub page_idx: u32,
    pub start_sample: u64,
    pub end_sample: u64,
    pub timings: Vec<SegmentTiming>,
}

#[derive(Clone, Debug)]
pub struct RenderedPage {
    pub meta: PageMeta,
    pub pcm: Vec<i16>,
}

#[derive(Clone, Copy, Debug)]
pub struct RenderConfig {
    /// Flush at a paragraph/section boundary once the page is this long.
    pub page_target_samples: u64,
    /// Hard page cap: flush on any boundary once the page is this long.
    pub page_force_samples: u64,
    /// Initial render budget (first page must never depend on a demand).
    pub initial_budget_samples: u64,
}

impl Default for RenderConfig {
    fn default() -> Self {
        let sec = RENDER_SAMPLE_RATE as u64;
        Self {
            page_target_samples: 45 * sec,
            page_force_samples: 90 * sec,
            initial_budget_samples: 46 * sec,
        }
    }
}

fn samples_for_ms(ms: u32) -> u64 {
    // Integer math: exactly pauseMs * rate / 1000 samples — unit-tested.
    (RENDER_SAMPLE_RATE as u64 * ms as u64) / 1000
}

// ── Page assembler (the timeline math; unit-tested directly) ─────────

pub struct PageAssembler {
    cfg: RenderConfig,
    page: Vec<i16>,
    page_start: u64,
    page_timings: Vec<SegmentTiming>,
    page_idx: u32,
    total: u64,
}

impl PageAssembler {
    pub fn new(cfg: RenderConfig) -> Self {
        Self {
            cfg,
            page: Vec::new(),
            page_start: 0,
            page_timings: Vec::new(),
            page_idx: 0,
            total: 0,
        }
    }

    pub fn total_samples(&self) -> u64 {
        self.total
    }

    /// Append one segment's audio + its trailing pause; flush the page
    /// when it reaches the target at a paragraph/section boundary, or the
    /// force cap anywhere. Returns the flushed page, if any.
    pub fn push_segment(
        &mut self,
        seg_id: u32,
        pcm: Vec<i16>,
        pause_after_ms: u32,
        boundary: Boundary,
    ) -> Option<RenderedPage> {
        let start = self.total;
        self.page_timings.push(SegmentTiming {
            seg_id,
            start_sample: start,
            end_sample: start + pcm.len() as u64,
        });
        self.total += pcm.len() as u64;
        self.page.extend(pcm);

        // Silence is generated, not synthesized: cheap and exact.
        let silence = samples_for_ms(pause_after_ms);
        self.page.extend(std::iter::repeat(0i16).take(silence as usize));
        self.total += silence;

        let page_len = self.total - self.page_start;
        let at_boundary = boundary != Boundary::Sentence && page_len >= self.cfg.page_target_samples;
        let forced = page_len >= self.cfg.page_force_samples;
        if at_boundary || forced {
            return self.flush();
        }
        None
    }

    /// Emit whatever the current page holds (used when the producer must
    /// block — the frontend is never starved — and for the final tail).
    pub fn flush(&mut self) -> Option<RenderedPage> {
        if self.page.is_empty() && self.page_timings.is_empty() {
            return None;
        }
        let meta = PageMeta {
            page_idx: self.page_idx,
            start_sample: self.page_start,
            end_sample: self.total,
            timings: std::mem::take(&mut self.page_timings),
        };
        let pcm = std::mem::take(&mut self.page);
        self.page_start = self.total;
        self.page_idx += 1;
        Some(RenderedPage { meta, pcm })
    }
}

// ── Audio decoding helpers ───────────────────────────────────────────

pub fn decode_base64(input: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(input.trim())
        .map_err(|e| format!("bad base64 audio: {e}"))
}

/// Parse a PCM16 WAV file → (samples, sample_rate).
pub fn decode_wav(data: &[u8]) -> Result<(Vec<i16>, u32), String> {
    if data.len() < 44 || &data[0..4] != b"RIFF" || &data[8..12] != b"WAVE" {
        return Err("not a RIFF/WAVE file".into());
    }
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None;
    let mut pcm: Option<Vec<i16>> = None;
    while pos + 8 <= data.len() {
        let id = &data[pos..pos + 4];
        let size = u32::from_le_bytes([data[pos + 4], data[pos + 5], data[pos + 6], data[pos + 7]]) as usize;
        let body_start = pos + 8;
        let body_end = (body_start + size).min(data.len());
        let body = &data[body_start..body_end];
        match id {
            b"fmt " if body.len() >= 16 => {
                let format = u16::from_le_bytes([body[0], body[1]]);
                let channels = u16::from_le_bytes([body[2], body[3]]);
                let rate = u32::from_le_bytes([body[4], body[5], body[6], body[7]]);
                let bits = u16::from_le_bytes([body[14], body[15]]);
                if format != 1 || bits != 16 {
                    return Err(format!("unsupported WAV format (format={format}, bits={bits})"));
                }
                fmt = Some((format, channels, rate, bits));
            }
            b"data" => {
                let mut out = Vec::with_capacity(body.len() / 2);
                let mut i = 0;
                while i + 1 < body.len() {
                    out.push(i16::from_le_bytes([body[i], body[i + 1]]));
                    i += 2;
                }
                pcm = Some(out);
            }
            _ => {}
        }
        if body_end <= pos {
            break; // corrupt size field — stop rather than loop forever
        }
        pos = body_end + (size & 1) as usize; // chunks are word-aligned
    }
    let (_, channels, rate, _) = fmt.ok_or("WAV missing fmt chunk")?;
    let pcm = pcm.ok_or("WAV missing data chunk")?;
    let mono = if channels > 1 {
        pcm.chunks(channels as usize)
            .map(|frame| {
                let sum: i32 = frame.iter().map(|&s| s as i32).sum();
                (sum / frame.len() as i32) as i16
            })
            .collect()
    } else {
        pcm
    };
    Ok((mono, rate))
}

/// Linear resample to the timeline rate. No-op at 24 kHz.
pub fn resample_to_timeline(samples: Vec<i16>, from_rate: u32) -> Vec<i16> {
    if from_rate == RENDER_SAMPLE_RATE || from_rate == 0 || samples.is_empty() {
        return samples;
    }
    let ratio = RENDER_SAMPLE_RATE as f64 / from_rate as f64;
    let out_len = ((samples.len() as f64) * ratio).round().max(1.0) as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let src = i as f64 / ratio;
        let idx = src.floor() as usize;
        let next = (idx + 1).min(samples.len() - 1);
        let frac = src - idx as f64;
        let a = samples[idx.min(samples.len() - 1)] as f64;
        let b = samples[next] as f64;
        out.push((a + (b - a) * frac).round().clamp(i16::MIN as f64, i16::MAX as f64) as i16);
    }
    out
}

// ── WSOLA time-stretch (phase 4: pitch-preserving speed) ─────────────
//
// Speed is applied HERE — after synthesis and resampling, before the
// assembler records offsets — so the timeline is built over the
// stretched PCM and pages stay sample-accurate at any rate. The
// WebAudio `playbackRate` alternative would pitch-shift (forbidden by
// the plan); WSOLA keeps voiced runs phase-continuous by searching for
// each analysis frame's best continuation. Pauses are NOT stretched:
// they stay the configured milliseconds at every speed.

/// Analysis frame (~43 ms at 24 kHz): long enough for voiced
/// continuity, short enough to bound the per-segment cost.
const WSOLA_FRAME: usize = 1024;
/// Input advance per synthesis frame (50 % overlap at rate 1.0).
const WSOLA_HOP: usize = WSOLA_FRAME / 2;
/// Search tolerance around the natural continuation (±~11 ms).
const WSOLA_TOLERANCE: usize = WSOLA_HOP / 2;

fn hann_window(n: usize) -> Vec<f32> {
    (0..n)
        .map(|i| 0.5 - 0.5 * (std::f32::consts::TAU * i as f32 / n as f32).cos())
        .collect()
}

/// Normalized cross-correlation of two equal-length slices.
fn ncc(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f64;
    let mut na = 0.0f64;
    let mut nb = 0.0f64;
    for i in 0..a.len() {
        let (x, y) = (a[i] as f64, b[i] as f64);
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na <= 1e-12 || nb <= 1e-12 {
        return 0.0;
    }
    (dot / (na.sqrt() * nb.sqrt())) as f32
}

/// Next analysis position: the lag within ±WSOLA_TOLERANCE of the
/// natural continuation that best correlates the new frame's head with
/// the previous frame's overlap tail. Candidates are tried in outward
/// spiral order with a strict `>`, so ties prefer the natural position
/// (silence and steady tones never drift).
fn wsola_continue(x: &[f32], prev: usize, natural: usize, syn_hop: usize, cmp_len: usize) -> usize {
    let max_pos = x.len() - WSOLA_FRAME;
    let natural = natural.min(max_pos);
    let tail_start = prev + syn_hop;
    if tail_start + cmp_len > x.len() {
        return natural;
    }
    let tail = &x[tail_start..tail_start + cmp_len];
    let mut best = natural;
    let mut best_score = f32::NEG_INFINITY;
    for off in 0..=WSOLA_TOLERANCE {
        let mut cands = [natural as isize + off as isize, 0];
        if off > 0 {
            cands[1] = natural as isize - off as isize;
            for &p in &cands {
                if p < 0 || p as usize > max_pos {
                    continue;
                }
                let s = p as usize;
                let score = ncc(&x[s..s + cmp_len], tail);
                if score > best_score {
                    best_score = score;
                    best = s;
                }
            }
        } else {
            let s = natural;
            best_score = ncc(&x[s..s + cmp_len], tail);
        }
    }
    best
}

/// Time-stretch `pcm` by `rate` (rate > 1 = faster/shorter, < 1 =
/// slower/longer, clamped to 0.5–2.0). Analysis frames advance
/// WSOLA_HOP samples in the input; synthesis frames advance
/// round(WSOLA_HOP / rate); each frame slides by the best-correlating
/// lag so voiced runs stay phase-continuous.
pub fn wsola_stretch(pcm: &[i16], rate: f64) -> Vec<i16> {
    let rate = if rate.is_finite() { rate.clamp(0.5, 2.0) } else { 1.0 };
    if (rate - 1.0).abs() < 0.01 || pcm.len() < WSOLA_FRAME {
        return pcm.to_vec();
    }
    let syn_hop = ((WSOLA_HOP as f64) / rate).round().max(2.0) as usize;
    let cmp_len = syn_hop.min(WSOLA_FRAME - syn_hop).max(1);

    // Work in −1..1 floats; pad a frame so the tail windows are full.
    let mut x: Vec<f32> = pcm.iter().map(|&s| s as f32 / 32768.0).collect();
    x.resize(x.len() + WSOLA_FRAME * 2, 0.0);
    let w = hann_window(WSOLA_FRAME);

    let keep = ((pcm.len() as f64) / rate).round().max(1.0) as usize;
    let mut out = vec![0.0f32; keep + WSOLA_FRAME];
    let mut win_sum = vec![0.0f32; keep + WSOLA_FRAME];

    let mut pos = 0usize;
    let mut oi = 0usize;
    let mut first = true;
    while pos + WSOLA_FRAME <= x.len() && oi + WSOLA_FRAME <= out.len() {
        for i in 0..WSOLA_FRAME {
            out[oi + i] += x[pos + i] * w[i];
            win_sum[oi + i] += w[i];
        }
        let natural = (pos + WSOLA_HOP).min(x.len() - WSOLA_FRAME);
        pos = if first {
            first = false;
            natural
        } else {
            wsola_continue(&x, pos, natural, syn_hop, cmp_len)
        };
        oi += syn_hop;
    }

    let mut y = Vec::with_capacity(keep);
    for i in 0..keep {
        let s = if win_sum[i] > 1e-6 { out[i] / win_sum[i] } else { 0.0 };
        y.push((s.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16);
    }
    y
}

// ── Job state (shared between the async worker and the commands) ─────

#[derive(Debug)]
struct Budget {
    demanded_samples: u64,
    cancelled: bool,
}

pub struct JobShared {
    budget: Mutex<Budget>,
    /// PCM of rendered, not-yet-fetched pages, plus the last few fetched
    /// pages kept for cheap back-seeks (evicted pages force a re-render).
    pages: Mutex<PagesStore>,
    /// Live WSOLA stretch factor (phase 4): the producer reads it per
    /// segment, so a change lands from the render frontier (≤ one page)
    /// without re-synthesis.
    speed: Mutex<f64>,
}

struct PagesStore {
    pending: HashMap<u32, Vec<i16>>,
    metas: HashMap<u32, PageMeta>,
    recent: VecDeque<(u32, Vec<i16>)>,
}

/// Fetched pages kept in memory for back-seek (≈3 × ~45 s worst case).
const RECENT_KEPT: usize = 3;

impl JobShared {
    fn new(initial_budget_samples: u64, initial_speed: f64) -> Self {
        Self {
            budget: Mutex::new(Budget {
                demanded_samples: initial_budget_samples,
                cancelled: false,
            }),
            pages: Mutex::new(PagesStore {
                pending: HashMap::new(),
                metas: HashMap::new(),
                recent: VecDeque::new(),
            }),
            speed: Mutex::new(clamp_speed(initial_speed)),
        }
    }

    pub(crate) fn current_speed(&self) -> f64 {
        *self.speed.lock().unwrap()
    }

    pub(crate) fn set_speed(&self, speed: f64) {
        *self.speed.lock().unwrap() = clamp_speed(speed);
    }

    pub(crate) fn budget_samples(&self) -> u64 {
        self.budget.lock().unwrap().demanded_samples
    }

    fn is_cancelled(&self) -> bool {
        self.budget.lock().unwrap().cancelled
    }

    fn cancel(&self) {
        self.budget.lock().unwrap().cancelled = true;
    }

    /// `seconds` is the absolute stream position the frontend wants
    /// rendered (playhead + render-ahead window).
    pub(crate) fn demand(&self, seconds: f64) {
        let samples = (seconds.max(0.0) * RENDER_SAMPLE_RATE as f64) as u64;
        let mut b = self.budget.lock().unwrap();
        if samples > b.demanded_samples {
            b.demanded_samples = samples;
        }
    }

    fn store_page(&self, page: &RenderedPage) {
        let mut ps = self.pages.lock().unwrap();
        ps.pending.insert(page.meta.page_idx, page.pcm.clone());
        ps.metas.insert(page.meta.page_idx, page.meta.clone());
    }

    pub(crate) fn take_page_bytes(&self, page_idx: u32) -> Result<Vec<u8>, String> {
        let mut ps = self.pages.lock().unwrap();
        let pcm = if let Some(pcm) = ps.pending.remove(&page_idx) {
            // Keep a short tail of fetched pages for back-seeks.
            ps.recent.push_back((page_idx, pcm.clone()));
            while ps.recent.len() > RECENT_KEPT {
                ps.recent.pop_front();
            }
            pcm
        } else if let Some((_, pcm)) = ps.recent.iter().find(|(idx, _)| *idx == page_idx) {
            pcm.clone()
        } else {
            return Err(format!(
                "page {page_idx} was already evicted — restart the render from that position"
            ));
        };
        let mut bytes = Vec::with_capacity(pcm.len() * 2);
        for s in pcm {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        Ok(bytes)
    }
}

#[derive(Default)]
pub struct RenderRegistry {
    jobs: Mutex<HashMap<u64, Arc<JobShared>>>,
    next_id: Mutex<u64>,
}

impl RenderRegistry {
    fn insert(&self, shared: Arc<JobShared>) -> u64 {
        let mut next = self.next_id.lock().unwrap();
        *next += 1;
        let id = *next;
        self.jobs.lock().unwrap().insert(id, shared);
        id
    }

    pub(crate) fn get(&self, id: u64) -> Result<Arc<JobShared>, String> {
        self.jobs
            .lock()
            .unwrap()
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("unknown render job {id}"))
    }

    pub(crate) fn cancel(&self, id: u64) -> Result<(), String> {
        let job = self.jobs.lock().unwrap().remove(&id);
        match job {
            Some(shared) => {
                shared.cancel();
                Ok(())
            }
            None => Ok(()), // cancel is idempotent (stop fires twice)
        }
    }
}

// ── Events ───────────────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PageEvent {
    render_id: u64,
    #[serde(flatten)]
    page: PageMeta,
}

fn emit_page(app: &AppHandle, render_id: u64, page: &RenderedPage) {
    let event = PageEvent {
        render_id,
        page: page.meta.clone(),
    };
    let _ = app.emit("tts://render-page", event);
}

fn emit_error(app: &AppHandle, render_id: u64, message: &str) {
    let _ = app.emit(
        "tts://render-error",
        serde_json::json!({ "renderId": render_id, "message": message }),
    );
}

// ── Synthesis (sidecar source; Phonon swap replaces this function) ───

/// The server-side split pattern: segments are ≤200 chars and already
/// sentence-bounded, so this never actually splits — it keeps the server
/// contract unchanged for the Preview path sharing the same command.
const NO_SPLIT: &str = r"(?<=[.!?。！？])\s+";

async fn synth_segment(
    app: &AppHandle,
    seg: &RenderSegment,
    params: &RenderParams,
) -> Result<Vec<i16>, String> {
    let tts = app.state::<crate::sidecar::TtsManager>();
    // Native synthesis speed is NOT used on the render path (phase 4):
    // WSOLA owns pacing, so live speed changes need no re-synthesis.
    // The Preview path (tts_synthesize) keeps passing settings speed.
    let (b64, _rate) = tts
        .synthesize(
            &seg.text,
            &params.voice,
            1.0,
            &params.lang_code,
            NO_SPLIT,
            100_000,
        )
        .await?;
    let wav = decode_base64(&b64)?;
    let (pcm, src_rate) = decode_wav(&wav)?;
    Ok(resample_to_timeline(pcm, src_rate))
}

// ── The worker ───────────────────────────────────────────────────────

pub fn spawn_render(
    app: AppHandle,
    registry: Arc<RenderRegistry>,
    segments: Vec<RenderSegment>,
    params: RenderParams,
) -> Result<u64, String> {
    if segments.is_empty() {
        return Err("render job has no segments".into());
    }
    let cfg = RenderConfig::default();
    let shared = Arc::new(JobShared::new(cfg.initial_budget_samples, params.speed));
    let id = registry.insert(shared.clone());
    let job_id = id;
    tauri::async_runtime::spawn(async move {
        run_job(app, job_id, shared, segments, params, cfg).await;
    });
    Ok(id)
}

async fn run_job(
    app: AppHandle,
    render_id: u64,
    shared: Arc<JobShared>,
    segments: Vec<RenderSegment>,
    params: RenderParams,
    cfg: RenderConfig,
) {
    let mut asm = PageAssembler::new(cfg);
    let total_segments = segments.len() as u32;
    let mut completed = true;

    'render: for seg in &segments {
        // Bounded producer: never render more than `budget` samples, and
        // flush whatever we hold before blocking so the frontend is never
        // starved while waiting for the next demand.
        loop {
            if shared.is_cancelled() {
                completed = false;
                break 'render;
            }
            if asm.total_samples() < shared.budget_samples() {
                break;
            }
            if let Some(page) = asm.flush() {
                shared.store_page(&page);
                emit_page(&app, render_id, &page);
            }
            tokio::time::sleep(Duration::from_millis(80)).await;
        }

        let pcm = match synth_segment(&app, seg, &params).await {
            Ok(pcm) => pcm,
            Err(e) => {
                emit_error(&app, render_id, &e);
                completed = false;
                break 'render;
            }
        };
        // Phase 4: WSOLA speed — pitch-preserving stretch BEFORE offsets
        // are finalized, so the timeline stays sample-accurate at any
        // rate. Read per segment: a live set-speed lands from here (the
        // render frontier, ≤ one page ahead of the playhead).
        let pcm = wsola_stretch(&pcm, shared.current_speed());
        if let Some(page) = asm.push_segment(seg.id, pcm, seg.pause_after_ms, seg.boundary) {
            shared.store_page(&page);
            emit_page(&app, render_id, &page);
            let _ = app.emit(
                "tts://render-progress",
                serde_json::json!({
                    "renderId": render_id,
                    "done": seg.id.saturating_add(1),
                    "total": total_segments,
                }),
            );
        }
    }

    if let Some(page) = asm.flush() {
        shared.store_page(&page);
        emit_page(&app, render_id, &page);
    }
    let _ = app.emit(
        "tts://render-done",
        serde_json::json!({
            "renderId": render_id,
            "totalSamples": asm.total_samples(),
            "completed": completed,
        }),
    );
}

// ── Tests ────────────────────────────────────────────────────────────

/// Speeds live in 0.5–2.0 (the settings slider's range); anything
/// non-finite falls back to 1.0.
fn clamp_speed(speed: f64) -> f64 {
    if speed.is_finite() {
        speed.clamp(0.5, 2.0)
    } else {
        1.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic stand-in for the codec: a short beep followed by
    /// silence proportional to the text length. Same input → same PCM.
    fn stub_synth(text: &str) -> Vec<i16> {
        let rate = RENDER_SAMPLE_RATE as usize;
        let speech = ((text.len() as f64 / 15.0) * rate as f64).round() as usize;
        let beep_len = rate * 8 / 100; // 80 ms
        let mut out = Vec::with_capacity(beep_len + speech);
        for i in 0..beep_len {
            let phase = i as f64 / rate as f64 * 440.0 * std::f64::consts::TAU;
            out.push((f64::sin(phase) * 0.2 * i16::MAX as f64) as i16);
        }
        out.extend(std::iter::repeat(0i16).take(speech.saturating_sub(beep_len)));
        out
    }

    fn render_seg(id: u32, text: &str, pause: u32, boundary: Boundary) -> RenderSegment {
        RenderSegment {
            id,
            text: text.to_string(),
            pause_after_ms: pause,
            boundary,
        }
    }

    // ── Phase 4: WSOLA speed ──────────────────────────────────────────

    fn tone(seconds: f64, hz: f64, amp: f64) -> Vec<i16> {
        let rate = RENDER_SAMPLE_RATE as f64;
        let n = (seconds * rate) as usize;
        (0..n)
            .map(|i| {
                (f64::sin(i as f64 / rate * hz * std::f64::consts::TAU) * amp * i16::MAX as f64)
                    as i16
            })
            .collect()
    }

    #[test]
    fn wsola_is_identity_at_rate_one() {
        let pcm = stub_synth("A sentence long enough to matter.");
        assert_eq!(wsola_stretch(&pcm, 1.0), pcm);
        assert_eq!(wsola_stretch(&pcm, 1.005), pcm); // inside the near-1.0 guard
    }

    #[test]
    fn wsola_output_length_tracks_rate() {
        let pcm = tone(2.0, 220.0, 0.3);
        let n = pcm.len() as f64;
        let fast = wsola_stretch(&pcm, 1.5);
        let slow = wsola_stretch(&pcm, 0.75);
        // Expected length within one analysis frame (edge truncation).
        assert!(
            (fast.len() as f64 - n / 1.5).abs() <= WSOLA_FRAME as f64,
            "fast len {} vs expected {}",
            fast.len(),
            n / 1.5
        );
        assert!(
            (slow.len() as f64 - n / 0.75).abs() <= WSOLA_FRAME as f64,
            "slow len {} vs expected {}",
            slow.len(),
            n / 0.75
        );
    }

    #[test]
    fn wsola_silence_stays_silent_and_steady_tone_holds_level() {
        let silence = vec![0i16; RENDER_SAMPLE_RATE as usize];
        assert!(wsola_stretch(&silence, 1.4).iter().all(|&s| s == 0));

        let flat = vec![8_000i16; RENDER_SAMPLE_RATE as usize];
        let out = wsola_stretch(&flat, 1.4);
        let mid = &out[out.len() / 4..out.len() * 3 / 4];
        for &s in mid {
            assert!((s as i32 - 8_000).abs() <= 400, "level drift: {s}");
        }
    }

    #[test]
    fn wsola_clamps_and_survives_degenerate_input() {
        assert_eq!(wsola_stretch(&[1, 2, 3], 1.5), vec![1, 2, 3]); // too short
        assert!(!wsola_stretch(&stub_synth("hello there"), 99.0).is_empty());
        assert!(!wsola_stretch(&stub_synth("hello there"), f64::NAN).is_empty());
    }

    #[test]
    fn stretch_keeps_pause_silence_untouched() {
        // Pauses scale with NOTHING: exact pause-ms silence at any speed.
        let pcm = tone(0.5, 330.0, 0.2);
        let mut asm = PageAssembler::new(RenderConfig::default());
        assert!(
            asm.push_segment(0, wsola_stretch(&pcm, 1.6), 220, Boundary::Sentence)
                .is_none()
        );
        let page = asm.flush().expect("tail page");
        let silence = samples_for_ms(220) as usize;
        assert!(page.pcm.len() >= silence);
        assert!(page.pcm[page.pcm.len() - silence..].iter().all(|&s| s == 0));
        // Timeline total = stretched audio + untouched pause.
        assert_eq!(
            page.meta.end_sample,
            (page.pcm.len() - silence) as u64 + silence as u64
        );
    }

    #[test]
    fn job_speed_is_shared_and_clamped() {
        let job = JobShared::new(1000, 1.0);
        assert_eq!(job.current_speed(), 1.0);
        job.set_speed(1.5);
        assert_eq!(job.current_speed(), 1.5);
        job.set_speed(0.1); // below the floor
        assert_eq!(job.current_speed(), 0.5);
        job.set_speed(9.0); // above the ceiling
        assert_eq!(job.current_speed(), 2.0);
        job.set_speed(f64::NAN);
        assert_eq!(job.current_speed(), 1.0);
        // Initial speed clamps too.
        assert_eq!(JobShared::new(1000, 4.0).current_speed(), 2.0);
    }

    #[test]
    fn silence_is_exactly_pause_ms_times_rate() {
        assert_eq!(samples_for_ms(220), 220 * RENDER_SAMPLE_RATE as u64 / 1000);
        assert_eq!(samples_for_ms(480), 11_520);
        assert_eq!(samples_for_ms(600), 14_400);
        assert_eq!(samples_for_ms(0), 0);
        // Builder round-trips the frontend contract.
        let s = render_seg(7, "hi", 220, Boundary::Sentence);
        assert_eq!(s.pause_after_ms, 220);
        assert_eq!(s.boundary, Boundary::Sentence);
    }

    #[test]
    fn timings_mononic_and_cover_the_stream() {
        let cfg = RenderConfig {
            page_target_samples: u64::MAX,
            page_force_samples: u64::MAX,
            initial_budget_samples: u64::MAX,
        };
        let mut asm = PageAssembler::new(cfg);
        let mut expected_total = 0u64;
        for (i, pause) in [(0u32, 220u32), (1, 480), (2, 0)] {
            let pcm = stub_synth("hello world");
            expected_total += pcm.len() as u64 + samples_for_ms(pause);
            asm.push_segment(i, pcm, pause, Boundary::Sentence);
        }
        assert_eq!(asm.total_samples(), expected_total);
        let page = asm.flush().expect("tail flush");
        let timings = &page.meta.timings;
        assert_eq!(timings.len(), 3);
        let mut prev_end = 0u64;
        for (i, t) in timings.iter().enumerate() {
            assert_eq!(t.seg_id, i as u32);
            assert!(t.start_sample >= prev_end, "overlapping segments");
            // The gap between segments is exactly the previous silence.
            let prev_pause = [220u32, 480, 0][i.checked_sub(0).unwrap_or(0)];
            if i > 0 {
                let prev = &timings[i - 1];
                let silence = samples_for_ms([220u32, 480, 0][i - 1]);
                assert_eq!(t.start_sample - prev.end_sample, silence);
            }
            let _ = prev_pause;
            prev_end = t.end_sample;
        }
        // First segment starts at 0; page covers every sample.
        assert_eq!(timings[0].start_sample, 0);
        assert_eq!(page.meta.start_sample, 0);
        assert_eq!(page.meta.end_sample, asm.total_samples());
        assert_eq!(page.pcm.len() as u64, page.meta.end_sample - page.meta.start_sample);
    }

    #[test]
    fn page_flush_snaps_on_paragraph_and_force_caps() {
        let sec = RENDER_SAMPLE_RATE as u64;
        let cfg = RenderConfig {
            page_target_samples: 2 * sec,
            page_force_samples: 5 * sec,
            initial_budget_samples: u64::MAX,
        };
        let mut asm = PageAssembler::new(cfg);
        // Long sentence-bounded segments: no boundary flush until force.
        let mut flushed = Vec::new();
        let mut id = 0;
        loop {
            let page = asm.push_segment(id, vec![0i16; sec as usize], 220, Boundary::Sentence);
            id += 1;
            if let Some(p) = page {
                flushed.push(p);
                break;
            }
            assert!(id < 100, "never force-flushed");
        }
        assert!(flushed[0].meta.end_sample >= 5 * sec, "force cap respected");

        // Paragraph boundary at/after target flushes inside push.
        let mut asm = PageAssembler::new(cfg);
        let page = asm
            .push_segment(0, vec![0i16; (2 * sec) as usize], 480, Boundary::Paragraph)
            .expect("paragraph flush happened in push");
        assert_eq!(page.meta.page_idx, 0);
        assert_eq!(page.meta.start_sample, 0);

        // Paragraph *before* target does not flush mid-page: a later
        // flush still returns the held page (if push had flushed, the
        // page would be empty now).
        let mut asm = PageAssembler::new(cfg);
        let out = asm.push_segment(0, vec![0i16; sec as usize], 480, Boundary::Paragraph);
        assert!(out.is_none());
        assert!(asm.flush().is_some());
    }

    #[test]
    fn stub_synth_is_deterministic() {
        assert_eq!(stub_synth("same text"), stub_synth("same text"));
        assert_ne!(stub_synth("short"), stub_synth("a longer piece of text"));
        assert!(stub_synth("x").len() > 0);
    }

    #[test]
    fn wav_roundtrip_and_resample() {
        // Build a tiny WAV by hand: 44100 Hz mono PCM16, 8 samples.
        let samples: Vec<i16> = vec![0, 1000, -1000, 20000, -20000, 500, -500, 0];
        let mut wav = Vec::new();
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&(36u32 + samples.len() as u32 * 2).to_le_bytes());
        wav.extend_from_slice(b"WAVE");
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes()); // PCM
        wav.extend_from_slice(&1u16.to_le_bytes()); // mono
        wav.extend_from_slice(&44100u32.to_le_bytes());
        wav.extend_from_slice(&(44100u32 * 2).to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&(samples.len() as u32 * 2).to_le_bytes());
        for s in &samples {
            wav.extend_from_slice(&s.to_le_bytes());
        }
        let (pcm, rate) = decode_wav(&wav).expect("decode");
        assert_eq!(rate, 44100);
        assert_eq!(pcm, samples);

        // Resample 44100 → 24000 keeps shape, changes length ~0.544×.
        let out = resample_to_timeline(pcm.clone(), 44100);
        let want = ((pcm.len() as f64) * 24000.0 / 44100.0).round() as usize;
        assert_eq!(out.len(), want);
        // Identity at timeline rate.
        assert_eq!(resample_to_timeline(pcm, 24000).len(), 8);
    }

    #[test]
    fn base64_decodes_audio() {
        assert_eq!(decode_base64("aGVsbG8=").unwrap(), b"hello");
        assert!(decode_base64("!!not-base64!!").is_err());
    }

    #[test]
    fn budget_blocks_then_advances_and_pages_stay_fetchable() {
        let cfg = RenderConfig {
            page_target_samples: 1000,
            page_force_samples: 2000,
            initial_budget_samples: 0,
        };
        let shared = Arc::new(JobShared::new(cfg.initial_budget_samples, 1.0));
        assert_eq!(shared.budget_samples(), 0);
        shared.demand(1.0);
        assert_eq!(shared.budget_samples(), RENDER_SAMPLE_RATE as u64);
        shared.demand(0.5); // demands are floors — never shrink
        assert_eq!(shared.budget_samples(), RENDER_SAMPLE_RATE as u64);

        let mut asm = PageAssembler::new(cfg);
        asm.push_segment(0, vec![0i16; 1500], 0, Boundary::Sentence);
        let page = asm.flush().unwrap();
        shared.store_page(&page);
        let bytes = shared.take_page_bytes(0).expect("pending page");
        assert_eq!(bytes.len(), 1500 * 2);
        // Re-fetch of a recently taken page still works (back-seek tail).
        assert!(shared.take_page_bytes(0).is_ok());
        // Evicted page says so explicitly.
        let mut ps = shared.pages.lock().unwrap();
        ps.pending.clear();
        ps.recent.clear();
        ps.metas.clear();
        drop(ps);
        assert!(shared.take_page_bytes(0).is_err());

        shared.cancel();
        assert!(shared.is_cancelled());
        assert!(shared.budget_samples() > 0);
    }
}
