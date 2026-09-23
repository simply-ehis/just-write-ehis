use std::process::{Child, Command};
use std::sync::Mutex;
use serde::{Deserialize, Serialize};

// ── Generic sidecar (AI harness, kept for backward compat) ───────

pub struct SidecarManager {
    process: Mutex<Option<Child>>,
    endpoint: Mutex<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HarnessRequest {
    pub prompt: String,
    pub session_id: String,
    pub tools: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct HarnessResponse {
    pub response: String,
    pub confidence: f64,
    pub escalated: bool,
    pub tool_used: Option<String>,
}

impl SidecarManager {
    pub fn new() -> Self {
        Self {
            process: Mutex::new(None),
            endpoint: Mutex::new("http://localhost:8080".to_string()),
        }
    }

    pub fn start(&self, python_path: &str, harness_dir: &str) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() { return Ok(()); }

        let child = Command::new(python_path)
            .arg("-m")
            .arg("small_model_harness.server")
            .current_dir(harness_dir)
            .spawn()
            .map_err(|e| format!("Failed to start sidecar: {}", e))?;
        *proc = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *proc {
            child.kill().map_err(|e| e.to_string())?;
        }
        *proc = None;
        Ok(())
    }

    pub async fn query(&self, request: HarnessRequest) -> Result<HarnessResponse, String> {
        let endpoint = self.endpoint.lock().map_err(|e| e.to_string())?.clone();
        let client = reqwest::Client::new();
        let resp = client
            .post(format!("{}/chat", endpoint))
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Sidecar request failed: {}", e))?;
        resp.json().await.map_err(|e| format!("Parse error: {}", e))
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().map(|mut p| {
            match *p {
                Some(ref mut child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            eprintln!("[sidecar] SidecarManager process exited with error: {:?}", status.code());
                        }
                        false
                    }
                    Ok(None) => true,
                    Err(_) => false,
                },
                None => false,
            }
        }).unwrap_or(false)
    }

    pub fn set_endpoint(&self, endpoint: &str) -> Result<(), String> {
        *self.endpoint.lock().map_err(|e| e.to_string())? = endpoint.to_string();
        Ok(())
    }
}

// ── Moonshine Voice STT sidecar ──────────────────────────────────

pub struct SttManager {
    process: Mutex<Option<Child>>,
    port: u16,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SttHealth {
    pub status: String,
    pub model_loaded: bool,
    pub model: Option<String>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SttTranscribeResponse {
    pub text: Option<String>,
    pub error: Option<String>,
}

impl SttManager {
    pub fn new(port: u16) -> Self {
        Self {
            process: Mutex::new(None),
            port,
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str, model: Option<&str>) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() { return Ok(()); }

        let script = std::path::PathBuf::from(sidecars_dir).join("stt_server.py");
        let mut cmd = Command::new(python_path);
        cmd.arg(script.to_string_lossy().to_string())
            .arg(self.port.to_string());
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            cmd.arg(m);
        }
        let child = cmd
            .current_dir(sidecars_dir)
            .spawn()
            .map_err(|e| format!("Failed to start STT sidecar: {}", e))?;

        *proc = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *proc {
            child.kill().map_err(|e| e.to_string())?;
        }
        *proc = None;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().map(|mut p| {
            match *p {
                Some(ref mut child) => child.try_wait().ok().flatten().is_none(),
                None => false,
            }
        }).unwrap_or(false)
    }

    pub fn port(&self) -> u16 { self.port }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub async fn health(&self) -> Result<SttHealth, String> {
        let client = reqwest::Client::new();
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn transcribe(&self, audio_b64: &str, format: &str) -> Result<String, String> {
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "audio": audio_b64,
            "format": format,
        });
        let resp = client.post(format!("{}/transcribe", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        let result: SttTranscribeResponse = resp.json().await.map_err(|e| e.to_string())?;
        result.text.ok_or_else(|| result.error.unwrap_or_else(|| "transcription failed".into()))
    }

    pub async fn stream_start(&self) -> Result<(), String> {
        let client = reqwest::Client::new();
        client.post(format!("{}/stream/start", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn stream_chunk(&self, audio_b64: &str, format: &str) -> Result<(), String> {
        let client = reqwest::Client::new();
        let body = serde_json::json!({ "audio": audio_b64, "format": format });
        client.post(format!("{}/stream/chunk", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn stream_stop(&self) -> Result<String, String> {
        let client = reqwest::Client::new();
        let resp = client.post(format!("{}/stream/stop", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        let result: SttTranscribeResponse = resp.json().await.map_err(|e| e.to_string())?;
        result.text.ok_or_else(|| result.error.unwrap_or_else(|| "stream transcription failed".into()))
    }
}

// ── Kokoro TTS sidecar ───────────────────────────────────────────

pub struct TtsManager {
    process: Mutex<Option<Child>>,
    port: u16,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TtsHealth {
    pub status: String,
    pub model_loaded: bool,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TtsSynthResponse {
    pub audio: Option<String>,  // base64 WAV
    pub sample_rate: Option<u32>,
    pub format: Option<String>,
    pub error: Option<String>,
}
impl TtsManager {
    pub fn new(port: u16) -> Self {
        Self {
            process: Mutex::new(None),
            port,
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str, model: Option<&str>) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() { return Ok(()); }

        let script = std::path::PathBuf::from(sidecars_dir).join("tts_server.py");

        let mut cmd = Command::new(python_path);
        cmd.arg(script.to_string_lossy().to_string())
            .arg(self.port.to_string());
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            cmd.arg(m);
        }
        let child = cmd
            .current_dir(sidecars_dir)
            .spawn()
            .map_err(|e| format!("Failed to start TTS sidecar: {}", e))?;

        *proc = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *proc {
            child.kill().map_err(|e| e.to_string())?;
        }
        *proc = None;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().map(|mut p| {
            match *p {
                Some(ref mut child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            eprintln!("[tts] Process exited with error: {:?}", status.code());
                        }
                        false
                    }
                    Ok(None) => true,
                    Err(_) => false,
                },
                None => false,
            }
        }).unwrap_or(false)
    }

    pub fn port(&self) -> u16 { self.port }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub async fn health(&self) -> Result<TtsHealth, String> {
        let client = reqwest::Client::new();
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn synthesize(&self, text: &str, voice: &str, speed: f64,
                            lang_code: &str, split_pattern: &str, chunk_size: u32) -> Result<(String, u32), String> {
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "text": text,
            "voice": voice,
            "speed": speed,
            "lang_code": lang_code,
            "split_pattern": split_pattern,
            "chunk_size": chunk_size,
        });
        let resp = client.post(format!("{}/synthesize", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        let result: TtsSynthResponse = resp.json().await.map_err(|e| e.to_string())?;
        match (result.audio, result.sample_rate) {
            (Some(audio), Some(sr)) => Ok((audio, sr)),
            _ => Err(result.error.unwrap_or_else(|| "synthesis failed".into())),
        }
    }

    pub async fn stop_playback(&self) -> Result<(), String> {
        let client = reqwest::Client::new();
        client.post(format!("{}/stop", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ── AI memory sidecar (vendored harness memory + redaction) ──────

#[derive(Serialize, Deserialize, Debug)]
pub struct MemoryHealth {
    pub status: String,
    pub facts: i64,
}

pub struct MemoryManager {
    process: Mutex<Option<Child>>,
    port: u16,
    data_dir: String,
}

impl MemoryManager {
    pub fn new(port: u16, data_dir: String) -> Self {
        Self {
            process: Mutex::new(None),
            port,
            data_dir,
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() { return Ok(()); }

        let script = std::path::PathBuf::from(sidecars_dir).join("memory_server.py");
        let child = Command::new(python_path)
            .arg(script.to_string_lossy().to_string())
            .arg(self.port.to_string())
            .arg(self.data_dir.clone())
            .current_dir(sidecars_dir)
            .spawn()
            .map_err(|e| format!("Failed to start memory sidecar: {}", e))?;

        *proc = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *proc {
            child.kill().map_err(|e| e.to_string())?;
        }
        *proc = None;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().map(|mut p| {
            match *p {
                Some(ref mut child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            eprintln!("[sidecar] MemoryManager process exited with error: {:?}", status.code());
                        }
                        false
                    }
                    Ok(None) => true,
                    Err(_) => false,
                },
                None => false,
            }
        }).unwrap_or(false)
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    async fn post_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let client = reqwest::Client::new();
        let resp = client.post(format!("{}{}", self.base_url(), path))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn health(&self) -> Result<MemoryHealth, String> {
        let client = reqwest::Client::new();
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn learn(&self, text: &str) -> Result<i64, String> {
        let data = self.post_json("/learn", serde_json::json!({ "text": text })).await?;
        data["stored"].as_i64().ok_or_else(|| "bad /learn response".to_string())
    }

    pub async fn recall(&self, query: &str) -> Result<String, String> {
        let client = reqwest::Client::new();
        let resp = client.get(format!("{}/recall", self.base_url()))
            .query(&[("q", query)])
            .send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(data["facts"].as_str().unwrap_or("").to_string())
    }

    pub async fn redact(&self, text: &str) -> Result<String, String> {
        let data = self.post_json("/redact", serde_json::json!({ "text": text })).await?;
        data["text"].as_str().map(String::from)
            .ok_or_else(|| "bad /redact response".to_string())
    }

    pub async fn clear(&self) -> Result<(), String> {
        self.post_json("/clear", serde_json::json!({})).await?;
        Ok(())
    }
}

// ── LLM sidecar (llama.cpp server) ─────────────────────────────────

pub struct LlmManager {
    process: Mutex<Option<Child>>,
    port: u16,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LlmHealth {
    pub status: String,
    pub model: Option<String>,
}

impl LlmManager {
    pub fn new(port: u16) -> Self {
        Self {
            process: Mutex::new(None),
            port,
        }
    }

    pub fn start(&self, sidecars_dir: &str, model_path: Option<&str>, ctx_size: Option<u32>) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if proc.is_some() { return Ok(()); }

        let sidecars = std::path::PathBuf::from(sidecars_dir);
        // fetch_sidecars.py lands the server under models/; fall back to the
        // sidecars root so older/manual layouts keep working.
        let server_exe = {
            let in_models = sidecars.join("models").join("llama-server.exe");
            if in_models.exists() {
                in_models
            } else {
                sidecars.join("llama-server.exe")
            }
        };
        let model_file = model_path
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|| std::path::PathBuf::from(sidecars_dir).join("models").join("lfm2.5-350m-q4_k_m.gguf"));

        // NOTE (b11047+): --no-mmap/--mlock were removed upstream; the
        // 350M default model pages fine without them.
        let mut cmd = Command::new(&server_exe);
        cmd.arg("-m").arg(model_file)
            .arg("--port").arg(self.port.to_string())
            .arg("--host").arg("127.0.0.1")
            .arg("--ctx-size").arg(ctx_size.unwrap_or(8192).to_string())
            .arg("--n-gpu-layers").arg("0")
            .arg("--threads").arg("4")
            .arg("--parallel").arg("2");
        let child = cmd
            .current_dir(sidecars_dir)
            .spawn()
            .map_err(|e| format!("Failed to start LLM sidecar: {}", e))?;

        *proc = Some(child);
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut proc = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(ref mut child) = *proc {
            child.kill().map_err(|e| e.to_string())?;
        }
        *proc = None;
        Ok(())
    }

    pub fn is_running(&self) -> bool {
        self.process.lock().map(|mut p| {
            match *p {
                Some(ref mut child) => match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            eprintln!("[llm] Process exited with error: {:?}", status.code());
                        }
                        false
                    }
                    Ok(None) => true,
                    Err(_) => false,
                },
                None => false,
            }
        }).unwrap_or(false)
    }

    pub fn port(&self) -> u16 { self.port }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }

    pub async fn health(&self) -> Result<LlmHealth, String> {
        let client = reqwest::Client::new();
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn completion(&self, prompt: &str, max_tokens: u32, temperature: f32) -> Result<String, String> {
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "prompt": prompt,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": false,
        });
        let resp = client.post(format!("{}/completion", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(data["content"].as_str().unwrap_or("").to_string())
    }

    pub async fn chat_completion(&self, messages: Vec<serde_json::Value>, max_tokens: u32, temperature: f32) -> Result<String, String> {
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "messages": messages,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "stream": false,
        });
        let resp = client.post(format!("{}/v1/chat/completions", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        Ok(data["choices"][0]["message"]["content"].as_str().unwrap_or("").to_string())
    }
}
