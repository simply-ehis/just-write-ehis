//! Phonon TTS engine — wraps the `ptts` crate and exposes it through the
//! same JSON-lines stdio protocol the existing Kokoro sidecar used.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::mpsc;
use std::sync::Mutex;
use std::thread;

use ptts::preprocess::{Lang, Normalize};
use ptts::synth::{Quant, Synth};
use ptts::Error;
use serde_json::Value;
use base64::engine::{general_purpose::STANDARD as BASE64, Engine as _};

pub type Result<T> = std::result::Result<T, EngineError>;

#[derive(Debug)]
pub enum EngineError {
    Io(String),
    Model(String),
    Request(String),
    Voice(String),
    Stream(String),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::Io(s) => write!(f, "io error: {s}"),
            EngineError::Model(s) => write!(f, "model error: {s}"),
            EngineError::Request(s) => write!(f, "request error: {s}"),
            EngineError::Voice(s) => write!(f, "voice error: {s}"),
            EngineError::Stream(s) => write!(f, "stream error: {s}"),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<Error> for EngineError {
    fn from(e: Error) -> Self {
        EngineError::Model(e.to_string())
    }
}

impl From<std::io::Error> for EngineError {
    fn from(e: std::io::Error) -> Self {
        EngineError::Io(e.to_string())
    }
}

/// One loaded Phonon checkpoint, ready to synthesize.
pub struct TtsEngine {
    synth: Mutex<Option<Synth>>,
    sample_rate: u32,
    voices: Mutex<HashMap<String, VoiceEntry>>,
    default_voice: Mutex<Option<String>>,
    #[allow(dead_code)]
    model_dir: PathBuf,
    streams: Mutex<HashMap<u64, StreamSession>>,
    next_stream_id: Mutex<u64>,
}

struct VoiceEntry {
    #[allow(dead_code)]
    name: String,
    #[allow(dead_code)]
    path: PathBuf,
}

/// One active streaming session. Holds the receiver end of an mpsc channel
/// that a background thread fills with PCM chunks from `ptts::SpeechStream`.
struct StreamSession {
    rx: mpsc::Receiver<std::result::Result<Vec<f32>, String>>,
    _handle: thread::JoinHandle<()>,
}

impl TtsEngine {
    /// Load a checkpoint from `model_dir` and register every voice found there.
    pub fn load(model_dir: &Path) -> Result<Self> {
        if !model_dir.is_dir() {
            return Err(EngineError::Model(format!(
                "model directory not found: {}",
                model_dir.display()
            )));
        }

        let checkpoint = ptts::checkpoint::Checkpoint::open(model_dir)
            .map_err(|e| EngineError::Model(format!("checkpoint open failed: {e}")))?;

        let normalize = Normalize::for_lang(Lang::En);
        let mut builder = checkpoint.builder(normalize);
        builder = builder.quant(Quant::Q80);

        let synth = builder.build().map_err(|e| EngineError::Model(format!("build failed: {e}")))?;
        let sample_rate = synth.sample_rate();
        let default_voice = synth.default_voice();

        let mut voices = HashMap::new();
        for (name, path) in &checkpoint.voices {
            voices.insert(name.clone(), VoiceEntry { name: name.clone(), path: path.clone() });
        }

        // Also register voices from voices.jsonl if present
        let catalog = model_dir.join("voices.jsonl");
        if catalog.is_file() {
            if let Ok(catalog_voices) = ptts::loader::read_voice_catalog(&catalog) {
                for (name, path) in &catalog_voices {
                    voices.insert(name.clone(), VoiceEntry { name: name.clone(), path: path.clone() });
                }
            }
        }

        Ok(Self {
            synth: Mutex::new(Some(synth)),
            sample_rate,
            voices: Mutex::new(voices),
            default_voice: Mutex::new(default_voice),
            model_dir: model_dir.to_path_buf(),
            streams: Mutex::new(HashMap::new()),
            next_stream_id: Mutex::new(1),
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    /// True when the model has been loaded successfully.
    pub fn is_ready(&self) -> bool {
        self.synth.lock().unwrap().is_some()
    }

    /// Default voice name, or None if no voices are registered.
    pub fn default_voice_name(&self) -> Option<String> {
        self.default_voice.lock().unwrap().clone()
    }

    /// Names of all registered voices.
    pub fn voice_names(&self) -> Vec<String> {
        self.voices.lock().unwrap().keys().cloned().collect()
    }

    #[allow(dead_code)]
    pub fn health(&self) -> Value {
        let ready = self.is_ready();
        serde_json::json!({
            "status": if ready { "ok" } else { "error" },
            "ready": ready,
            "model_loaded": ready,
            "sample_rate": self.sample_rate,
            "default_voice": self.default_voice_name(),
            "voices": self.voice_names(),
            "error": if ready { None as Option<String> } else { Some("model not loaded".to_string()) },
        })
    }

    /// Synthesize `text` and return base64-encoded WAV.
    pub fn synthesize(
        &self,
        text: &str,
        voice: Option<&str>,
        _speed: f64,
    ) -> Result<(String, u32)> {
        let synth = self.synth.lock().unwrap();
        let synth = synth.as_ref().ok_or_else(|| EngineError::Model("model not loaded".to_string()))?;

        let voice_name = voice
            .and_then(|v| self.resolve_voice(v))
            .or_else(|| self.default_voice.lock().unwrap().clone())
            .unwrap_or_else(|| "default".to_string());

        // Synthesize with the selected voice. ptts Synth::say uses the default voice;
        // for per-request voices we need a session. Use session_default for simplicity.
        let session = synth.session_default(&ptts::synth::SpeechOptions::default().voice(&voice_name))
            .map_err(|e| EngineError::Request(format!("session failed: {e}")))?;

        let pcm = session.say(text).map_err(|e| EngineError::Request(format!("synthesis failed: {e}")))?;

        // Convert f32 PCM to base64-encoded 16-bit WAV
        let wav_bytes = pcm_to_wav_bytes(&pcm, self.sample_rate)?;
        let audio_b64 = BASE64.encode(&wav_bytes);

        Ok((audio_b64, self.sample_rate))
    }

    fn resolve_voice(&self, name: &str) -> Option<String> {
        let voices = self.voices.lock().unwrap();
        if voices.contains_key(name) {
            return Some(name.to_string());
        }
        // Try case-insensitive match
        for known in voices.keys() {
            if known.eq_ignore_ascii_case(name) {
                return Some(known.clone());
            }
        }
        None
    }

    pub fn register_voice_file(&self, name: &str, path: &Path) -> Result<()> {
        let mut synth = self.synth.lock().unwrap();
        let synth = synth.as_mut().ok_or_else(|| EngineError::Model("model not loaded".to_string()))?;
        synth.add_voice_file(name, path).map_err(|e| EngineError::Voice(e.to_string()))?;
        self.voices.lock().unwrap().insert(name.to_string(), VoiceEntry { name: name.to_string(), path: path.to_path_buf() });
        Ok(())
    }

    /// List registered voice names.
    pub fn voices(&self) -> Vec<String> {
        self.voices.lock().unwrap().keys().cloned().collect()
    }

    /// Start a streaming synthesis session. Returns (stream_id, sample_rate).
    pub fn stream_start(&self, text: &str, voice: Option<&str>) -> Result<(u64, u32)> {
        let synth = self.synth.lock().unwrap();
        let synth = synth.as_ref().ok_or_else(|| EngineError::Model("model not loaded".to_string()))?;

        let voice_name = voice
            .and_then(|v| self.resolve_voice(v))
            .or_else(|| self.default_voice.lock().unwrap().clone())
            .unwrap_or_else(|| "default".to_string());

        let session = synth.session_default(&ptts::synth::SpeechOptions::default().voice(&voice_name))
            .map_err(|e| EngineError::Request(format!("session failed: {e}")))?;

        let (tx, rx) = mpsc::channel();
        let text_owned = text.to_string();
        let handle = thread::spawn(move || {
            let stream = session.stream(&text_owned).map_err(|e| {
                let _ = tx.send(Err(format!("stream start failed: {e}")));
            }).ok();
            let mut stream = match stream {
                Some(s) => s,
                None => return,
            };
            for chunk in &mut stream {
                match chunk {
                    Ok(pcm) => {
                        if tx.send(Ok(pcm)).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        let _ = tx.send(Err(format!("stream decode failed: {e}")));
                        break;
                    }
                }
            }
        });

        let stream_id = {
            let mut ids = self.next_stream_id.lock().unwrap();
            let id = *ids;
            *ids += 1;
            id
        };

        self.streams.lock().unwrap().insert(stream_id, StreamSession { rx, _handle: handle });

        Ok((stream_id, self.sample_rate))
    }

    /// Receive the next PCM chunk from a streaming session. Returns Ok(Some(pcm)) when a chunk
    /// is available, Ok(None) when the stream has ended, or Err on failure.
    pub fn stream_chunk(&self, stream_id: u64) -> Result<std::result::Result<Option<Vec<f32>>, String>> {
        let mut streams = self.streams.lock().unwrap();
        let session = streams.get_mut(&stream_id).ok_or_else(|| EngineError::Stream(format!("stream {stream_id} not found")))?;
        match session.rx.recv() {
            Ok(Ok(pcm)) => Ok(Ok(Some(pcm))),
            Ok(Err(e)) => Ok(Err(e)),
            Err(_) => Ok(Ok(None)), // channel closed = stream ended
        }
    }

    /// Stop and drop a streaming session.
    pub fn stream_stop(&self, stream_id: u64) -> Result<()> {
        self.streams.lock().unwrap().remove(&stream_id)
            .ok_or_else(|| EngineError::Stream(format!("stream {stream_id} not found")))?;
        Ok(())
    }
}

/// Convert f32 mono PCM to 16-bit WAV bytes.
pub fn pcm_to_wav_bytes(pcm: &[f32], sample_rate: u32) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    ptts::wav::write_pcm_as_wav(&mut buf, pcm, sample_rate, 1)
        .map_err(|e| EngineError::Io(e.to_string()))?;
    Ok(buf)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wav_roundtrip_header() {
        let pcm: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0, -1.0];
        let wav = pcm_to_wav_bytes(&pcm, 24000).unwrap();
        assert!(wav.len() > 44);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
    }
}
