//! JSON-lines protocol between the Tauri backend and the phonon-server.
//!
//! Request (stdin):  {"id": <u64>, "method": <str>, "params": <Value>}
//! Response (stdout): {"id": <u64>, "ok": true,  "result": <Value>}
//!                   or {"id": <u64>, "ok": false, "error": <str>}

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
pub struct Request {
    pub id: u64,
    pub method: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Response {
    Ok { id: u64, ok: bool, result: Value },
    Err { id: u64, ok: bool, error: String },
}

impl Response {
    pub fn ok(id: u64, result: Value) -> Self {
        Response::Ok { id, ok: true, result }
    }

    pub fn err(id: u64, error: impl Into<String>) -> Self {
        Response::Err { id, ok: false, error: error.into() }
    }
}

impl Request {
    pub fn param_str(&self, key: &str) -> Option<String> {
        self.params.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
    }

    pub fn param_f64(&self, key: &str) -> Option<f64> {
        self.params.get(key).and_then(|v| v.as_f64())
    }

    #[allow(dead_code)]
    pub fn param_u32(&self, key: &str) -> Option<u32> {
        self.params.get(key).and_then(|v| v.as_u64()).map(|v| v as u32)
    }
}

pub struct HealthResult {
    pub status: String,
    pub ready: bool,
    pub model_loaded: bool,
    pub sample_rate: u32,
    pub default_voice: Option<String>,
    pub voices: Vec<String>,
    pub error: Option<String>,
}

impl HealthResult {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "status": self.status,
            "ready": self.ready,
            "model_loaded": self.model_loaded,
            "sample_rate": self.sample_rate,
            "default_voice": self.default_voice,
            "voices": self.voices,
            "error": self.error,
        })
    }
}

pub struct SynthesizeResult {
    pub audio_b64: String,
    pub sample_rate: u32,
    pub voice_fallback: Option<String>,
}

impl SynthesizeResult {
    pub fn to_value(&self) -> Value {
        let mut obj = serde_json::json!({
            "audio": self.audio_b64,
            "sample_rate": self.sample_rate,
            "format": "wav",
        });
        if let Some(ref fb) = self.voice_fallback {
            obj.as_object_mut().unwrap().insert("voice_fallback".to_string(), Value::String(fb.clone()));
        }
        obj
    }
}

/// Response for `stream_start`.
pub struct StreamStartResult {
    pub stream_id: u64,
    pub sample_rate: u32,
}

impl StreamStartResult {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "stream_id": self.stream_id,
            "sample_rate": self.sample_rate,
        })
    }
}

/// Response for `stream_chunk`.
pub struct StreamChunkResult {
    pub audio_b64: Option<String>,  // None when stream has ended
    pub sample_rate: u32,
    pub done: bool,
}

impl StreamChunkResult {
    pub fn to_value(&self) -> Value {
        serde_json::json!({
            "audio": self.audio_b64,
            "sample_rate": self.sample_rate,
            "done": self.done,
        })
    }
}
