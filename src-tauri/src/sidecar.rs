use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use serde::{Deserialize, Serialize};

// ── Shared process management ──────────────────────────────────────
//
// LAZY-START POLICY (one place): nothing spawns at boot or import time.
// Every sidecar starts on first user tap (ensure_*), stops on toggle-off.
// ManagedSidecar is the ONE child-process owner for all 5 managers:
// dead handles are reaped and respawned (never early-Ok on a corpse),
// stop() is kill()+wait() (reaped, no zombies), Drop kills best-effort
// so children die with the app, and every HTTP client carries a timeout
// (30s default, 180s for media generation) so no hang is indefinite.

/// HTTP client with a real timeout — replaces bare Client::new() (which
/// waits forever) everywhere in this module.
fn http_client(timeout_secs: u64) -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .expect("reqwest client with a timeout always builds")
}

/// ONE managed child process shared by all 5 sidecar managers.
pub struct ManagedSidecar {
    process: Mutex<Option<Child>>,
    port: u16,
    /// Short log name, e.g. "stt".
    name: &'static str,
}

impl ManagedSidecar {
    pub fn new(port: u16, name: &'static str) -> Self {
        Self {
            process: Mutex::new(None),
            port,
            name,
        }
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// True only when a live child exists (reaps corpses as a side effect).
    pub fn is_running(&self) -> bool {
        match self.process.lock().as_deref_mut() {
            Ok(Some(child)) => match child.try_wait() {
                Ok(None) => true,
                Ok(Some(status)) => {
                    if !status.success() {
                        eprintln!("[{}] child exited with error: {:?}", self.name, status.code());
                    }
                    false
                }
                Err(_) => false,
            },
            _ => false,
        }
    }

    /// Spawn `program`+`args` in `cwd`. A dead handle is reaped first and
    /// respawned (never early-Ok on a corpse). If our port is held by a
    /// stale holder, it is reclaimed (orphan restart) before spawning.
    pub fn start(&self, program: &str, args: &[String], cwd: &str, start_label: &str) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(child) = guard.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                _ => {
                    let _ = child.wait();
                    *guard = None;
                }
            }
        }

        self.reclaim_stale_port()?;

        let child = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .spawn()
            .map_err(|e| format!("Failed to start {} sidecar ({}): {}", start_label, program, e))?;
        guard.replace(child);
        Ok(())
    }

    /// kill()+wait(): the child is reaped, never a zombie.
    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        Ok(())
    }

    /// If our port is held while we own no live child, it is a stale
    /// holder (e.g. an orphaned sidecar from a killed app). When the
    /// holder looks like one of ours (a python/llama/transcribe process),
    /// kill it and let the caller respawn fresh; otherwise fail closed
    /// with a typed error instead of a silent health-false.
    fn reclaim_stale_port(&self) -> Result<(), String> {
        use std::net::{SocketAddr, TcpStream};
        let addr: SocketAddr = format!("127.0.0.1:{}", self.port)
            .parse()
            .map_err(|e| format!("bad sidecar port: {}", e))?;
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
            return Ok(()); // port free — normal path
        }
        match Self::holder_image(self.port) {
            Some(image) => {
                let lower = image.to_lowercase();
                let ours = lower.contains("python")
                    || lower.contains("llama-server")
                    || lower.contains("transcribe")
                    || lower.contains("kokoro")
                    || lower.contains("just-write");
                if ours {
                    eprintln!(
                        "[{}] port {} held by orphan process ({}) — killed and restarted",
                        self.name, self.port, image
                    );
                    Self::kill_port_holder(self.port)?;
                    std::thread::sleep(Duration::from_millis(500));
                    return Ok(());
                }
                Err(format!(
                    "port {} is held by {} (not a sidecar) — stop it and retry",
                    self.port, image
                ))
            }
            None => Err(format!(
                "port {} is already in use by an unknown process — stop it and retry",
                self.port
            )),
        }
    }

    /// Image name of the process listening on `port`, if identifiable.
    fn holder_image(port: u16) -> Option<String> {
        #[cfg(windows)]
        {
            Self::holder_image_windows(port)
        }
        #[cfg(not(windows))]
        {
            Self::holder_image_unix(port)
        }
    }

    #[cfg(windows)]
    fn holder_image_windows(port: u16) -> Option<String> {
        let netstat = Command::new("netstat").args(["-ano", "-p", "TCP"]).output().ok()?;
        let out = String::from_utf8_lossy(&netstat.stdout);
        let needle = format!("127.0.0.1:{}", port);
        let mut pid: Option<String> = None;
        for line in out.lines() {
            // TCP    127.0.0.1:8093    0.0.0.0:0    LISTENING    1234
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() >= 5 && cols[0] == "TCP" && cols[1] == needle && cols[3] == "LISTENING" {
                pid = Some(cols[4].to_string());
                break;
            }
        }
        let pid = pid?;
        let tasklist = Command::new("tasklist")
            .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        let row = String::from_utf8_lossy(&tasklist.stdout);
        // "python.exe","1234","Console","1","15,000 K"
        row.split(',').next().map(|s| s.trim_matches('"').to_string())
    }

    #[cfg(not(windows))]
    fn holder_image_unix(port: u16) -> Option<String> {
        // lsof preferred; /proc fallback on Linux.
        if let Ok(lsof) = Command::new("lsof").args(["-ti", &format!("tcp:{}", port)]).output() {
            let pid = String::from_utf8_lossy(&lsof.stdout).lines().next()?.trim().to_string();
            if pid.is_empty() {
                return None;
            }
            let ps = Command::new("ps").args(["-p", &pid, "-o", "comm="]).output().ok()?;
            let image = String::from_utf8_lossy(&ps.stdout).trim().to_string();
            if image.is_empty() {
                return None;
            }
            return Some(image);
        }
        #[cfg(target_os = "linux")]
        {
            for entry in std::fs::read_dir("/proc").ok()?.flatten() {
                let pid = entry.file_name().to_string_lossy().into_owned();
                if !pid.chars().all(|c| c.is_ascii_digit()) {
                    continue;
                }
                // Too coarse without fd parsing — report unknown, fail closed.
                let _ = pid;
            }
        }
        None
    }

    /// Kill whatever holds `port` (only called after holder_image identified
    /// it as one of ours).
    fn kill_port_holder(port: u16) -> Result<(), String> {
        #[cfg(windows)]
        {
            // Resolve PID the same way holder_image did, then taskkill it.
            let netstat = Command::new("netstat").args(["-ano", "-p", "TCP"]).output().map_err(|e| e.to_string())?;
            let out = String::from_utf8_lossy(&netstat.stdout);
            let needle = format!("127.0.0.1:{}", port);
            for line in out.lines() {
                let cols: Vec<&str> = line.split_whitespace().collect();
                if cols.len() >= 5 && cols[0] == "TCP" && cols[1] == needle && cols[3] == "LISTENING" {
                    let status = Command::new("taskkill").args(["/F", "/PID", cols[4]]).status().map_err(|e| e.to_string())?;
                    if !status.success() {
                        return Err(format!("could not kill orphan holder of port {}", port));
                    }
                    return Ok(());
                }
            }
            Err(format!("orphan holder of port {} vanished mid-reclaim", port))
        }
        #[cfg(not(windows))]
        {
            let out = Command::new("lsof").args(["-ti", &format!("tcp:{}", port)]).output().map_err(|e| e.to_string())?;
            let pid = String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").trim().to_string();
            if pid.is_empty() {
                return Err(format!("orphan holder of port {} vanished mid-reclaim", port));
            }
            let status = Command::new("kill").args(["-9", &pid]).status().map_err(|e| e.to_string())?;
            if !status.success() {
                return Err(format!("could not kill orphan holder of port {}", port));
            }
            Ok(())
        }
    }
}

impl Drop for ManagedSidecar {
    /// Best-effort: children die with the app, never orphaned on exit.
    fn drop(&mut self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut child) = guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

// ── Generic sidecar (AI harness, kept for backward compat) ───────

pub struct SidecarManager {
    proc: ManagedSidecar,
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
            proc: ManagedSidecar::new(8080, "sidecar"),
            endpoint: Mutex::new("http://localhost:8080".to_string()),
        }
    }

    pub fn start(&self, python_path: &str, harness_dir: &str) -> Result<(), String> {
        self.proc.start(
            python_path,
            &["-m".to_string(), "small_model_harness.server".to_string()],
            harness_dir,
            "harness",
        )
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub async fn query(&self, request: HarnessRequest) -> Result<HarnessResponse, String> {
        let endpoint = self.endpoint.lock().map_err(|e| e.to_string())?.clone();
        let client = http_client(30);
        let resp = client
            .post(format!("{}/chat", endpoint))
            .json(&request)
            .send()
            .await
            .map_err(|e| format!("Sidecar request failed: {}", e))?;
        resp.json().await.map_err(|e| format!("Parse error: {}", e))
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub fn set_endpoint(&self, endpoint: &str) -> Result<(), String> {
        *self.endpoint.lock().map_err(|e| e.to_string())? = endpoint.to_string();
        Ok(())
    }
}

// ── Moonshine Voice STT sidecar ──────────────────────────────────

pub struct SttManager {
    proc: ManagedSidecar,
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
            proc: ManagedSidecar::new(port, "stt"),
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str, model: Option<&str>) -> Result<(), String> {
        let script = std::path::PathBuf::from(sidecars_dir).join("stt_server.py");
        let mut args = vec![
            script.to_string_lossy().to_string(),
            self.proc.port().to_string(),
        ];
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            args.push(m.to_string());
        }
        self.proc.start(python_path, &args, sidecars_dir, "STT")
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub fn port(&self) -> u16 { self.proc.port() }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.proc.port())
    }

    pub async fn health(&self) -> Result<SttHealth, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn transcribe(&self, audio_b64: &str, format: &str) -> Result<String, String> {
        let client = http_client(180);
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
        let client = http_client(30);
        client.post(format!("{}/stream/start", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn stream_chunk(&self, audio_b64: &str, format: &str) -> Result<(), String> {
        let client = http_client(30);
        let body = serde_json::json!({ "audio": audio_b64, "format": format });
        client.post(format!("{}/stream/chunk", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        Ok(())
    }

    pub async fn stream_stop(&self) -> Result<String, String> {
        let client = http_client(30);
        let resp = client.post(format!("{}/stream/stop", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        let result: SttTranscribeResponse = resp.json().await.map_err(|e| e.to_string())?;
        result.text.ok_or_else(|| result.error.unwrap_or_else(|| "stream transcription failed".into()))
    }
}

// ── Kokoro TTS sidecar ───────────────────────────────────────────

pub struct TtsManager {
    proc: ManagedSidecar,
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
            proc: ManagedSidecar::new(port, "tts"),
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str, model: Option<&str>) -> Result<(), String> {
        let script = std::path::PathBuf::from(sidecars_dir).join("tts_server.py");
        let mut args = vec![
            script.to_string_lossy().to_string(),
            self.proc.port().to_string(),
        ];
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            args.push(m.to_string());
        }
        self.proc.start(python_path, &args, sidecars_dir, "TTS")
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub fn port(&self) -> u16 { self.proc.port() }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.proc.port())
    }

    pub async fn health(&self) -> Result<TtsHealth, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn synthesize(&self, text: &str, voice: &str, speed: f64,
                            lang_code: &str, split_pattern: &str, chunk_size: u32) -> Result<(String, u32), String> {
        let client = http_client(180);
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
        let client = http_client(30);
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
    proc: ManagedSidecar,
    data_dir: String,
}

impl MemoryManager {
    pub fn new(port: u16, data_dir: String) -> Self {
        Self {
            proc: ManagedSidecar::new(port, "memory"),
            data_dir,
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str) -> Result<(), String> {
        let script = std::path::PathBuf::from(sidecars_dir).join("memory_server.py");
        let args = vec![
            script.to_string_lossy().to_string(),
            self.proc.port().to_string(),
            self.data_dir.clone(),
        ];
        self.proc.start(python_path, &args, sidecars_dir, "memory")
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.proc.port())
    }

    async fn post_json(&self, path: &str, body: serde_json::Value) -> Result<serde_json::Value, String> {
        let client = http_client(30);
        let resp = client.post(format!("{}{}", self.base_url(), path))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn health(&self) -> Result<MemoryHealth, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn learn(&self, text: &str) -> Result<i64, String> {
        let data = self.post_json("/learn", serde_json::json!({ "text": text })).await?;
        data["stored"].as_i64().ok_or_else(|| "bad /learn response".to_string())
    }

    pub async fn recall(&self, query: &str) -> Result<String, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/recall", self.base_url()))
            .query(&[("q", query)])
            .send().await.map_err(|e| e.to_string())?;
        let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
        // Missing field is a broken response (real error); an empty string
        // is a legitimate "no facts" answer and stays Ok.
        data["facts"].as_str().map(String::from)
            .ok_or_else(|| "bad /recall response: missing facts field".to_string())
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
    proc: ManagedSidecar,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LlmHealth {
    pub status: String,
    pub model: Option<String>,
}

impl LlmManager {
    pub fn new(port: u16) -> Self {
        Self {
            proc: ManagedSidecar::new(port, "llm"),
        }
    }

    pub fn start(&self, sidecars_dir: &str, model_path: Option<&str>, ctx_size: Option<u32>) -> Result<(), String> {
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
        let args = vec![
            "-m".to_string(),
            model_file.to_string_lossy().to_string(),
            "--port".to_string(),
            self.proc.port().to_string(),
            "--host".to_string(),
            "127.0.0.1".to_string(),
            "--ctx-size".to_string(),
            ctx_size.unwrap_or(8192).to_string(),
            "--n-gpu-layers".to_string(),
            "0".to_string(),
            "--threads".to_string(),
            "4".to_string(),
            "--parallel".to_string(),
            "2".to_string(),
        ];
        self.proc.start(
            &server_exe.to_string_lossy().to_string(),
            &args,
            sidecars_dir,
            "LLM",
        )
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub fn port(&self) -> u16 { self.proc.port() }

    fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.proc.port())
    }

    pub async fn health(&self) -> Result<LlmHealth, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/health", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn completion(&self, prompt: &str, max_tokens: u32, temperature: f32) -> Result<String, String> {
        let client = http_client(180);
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
        data["content"].as_str().map(|s| s.to_string())
            .ok_or_else(|| "LLM server returned no content".to_string())
    }

    pub async fn chat_completion(&self, messages: Vec<serde_json::Value>, max_tokens: u32, temperature: f32) -> Result<String, String> {
        let client = http_client(180);
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
        data["choices"][0]["message"]["content"].as_str().map(|s| s.to_string())
            .ok_or_else(|| "LLM server returned no content".to_string())
    }
}

#[cfg(test)]
mod managed_tests {
    use super::*;

    #[test]
    fn start_invalid_program_errors_and_stays_down() {
        let m = ManagedSidecar::new(0, "test");
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let r = m.start("definitely-not-a-real-binary-xyz", &[], &dir, "TEST");
        assert!(r.is_err());
        assert!(!m.is_running());
    }

    /// Port held by a foreign (non-sidecar) listener must fail closed with
    /// a typed error — never silently adopt or kill it.
    #[test]
    fn stale_foreign_port_fails_closed() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("ephemeral port");
        let port = listener.local_addr().expect("addr").port();
        let m = ManagedSidecar::new(port, "test");
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let r = m.start("definitely-not-a-real-binary-xyz", &[], &dir, "TEST");
        assert!(r.is_err(), "expected a typed stale-port error");
        let msg = r.unwrap_err();
        assert!(
            msg.contains("already in use") || msg.contains("held by"),
            "unexpected message: {}",
            msg
        );
        drop(listener);
    }

    #[cfg(windows)]
    fn short_lived() -> (String, Vec<String>) {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), "ping -n 2 127.0.0.1 >nul".to_string()],
        )
    }

    #[cfg(not(windows))]
    fn short_lived() -> (String, Vec<String>) {
        ("sleep".to_string(), vec!["1".to_string()])
    }

    #[cfg(windows)]
    fn long_lived() -> (String, Vec<String>) {
        (
            "cmd".to_string(),
            vec!["/C".to_string(), "ping -n 30 127.0.0.1 >nul".to_string()],
        )
    }

    #[cfg(not(windows))]
    fn long_lived() -> (String, Vec<String>) {
        ("sleep".to_string(), vec!["30".to_string()])
    }

    fn wait_until_stopped(m: &ManagedSidecar) {
        for _ in 0..100 {
            if !m.is_running() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        panic!("child did not exit in time");
    }

    /// A dead handle is reaped and respawned — never early-Ok on a corpse.
    #[test]
    fn dead_handle_respawns() {
        let m = ManagedSidecar::new(0, "test");
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let (prog, args) = short_lived();
        m.start(&prog, &args, &dir, "TEST").expect("first spawn");
        assert!(m.is_running());
        wait_until_stopped(&m);
        // Handle is Some(dead) here: start must respawn, not early-Ok.
        m.start(&prog, &args, &dir, "TEST").expect("respawn");
        assert!(m.is_running(), "respawned child should be alive");
        m.stop().expect("stop");
        assert!(!m.is_running());
    }

    /// stop() is kill()+wait(): no zombie left behind.
    #[test]
    fn stop_reaps_child() {
        let m = ManagedSidecar::new(0, "test");
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let (prog, args) = long_lived();
        m.start(&prog, &args, &dir, "TEST").expect("spawn");
        assert!(m.is_running());
        m.stop().expect("stop");
        assert!(!m.is_running());
        // Second stop is a safe no-op.
        m.stop().expect("second stop");
    }
}
