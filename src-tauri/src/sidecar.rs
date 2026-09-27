use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::{Deserialize, Serialize};

// ── Shared process management ──────────────────────────────────────
//
// LAZY-START POLICY (one place): nothing spawns at boot or import time.
// Every sidecar starts on first user tap (ensure_*), stops on toggle-off.
// ManagedSidecar is the ONE child-process owner for the STT, TTS, memory,
// and LLM managers:
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

/// Resolve a sidecar script, tolerating raw portable exes run without the
/// installer layout. The frontend passes resourceDir/sidecars; when that
/// script is missing we also try beside the exe (portable bundle) before
/// failing with an actionable hint instead of a cryptic spawn error.
fn resolve_sidecar_script(sidecars_dir: &str, script: &str) -> Result<std::path::PathBuf, String> {
    let primary = std::path::PathBuf::from(sidecars_dir).join(script);
    if primary.is_file() {
        return Ok(primary);
    }
    let mut tried = vec![primary.clone()];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for cand in [
                dir.join("sidecars").join(script),
                dir.join(script),
                dir.join("resources").join("sidecars").join(script),
            ] {
                tried.push(cand.clone());
                if cand.is_file() {
                    return Ok(cand);
                }
            }
        }
    }
    let tried_list = tried
        .iter()
        .map(|p| p.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("; ");
    Err(format!(
        "{} not found. Tried: {}. If you ran the raw exe directly (no installer), run the setup exe or place the sidecars bundle beside the exe.",
        script, tried_list
    ))
}

fn resolve_sidecar_executable(sidecars_dir: &str, executable: &str) -> Option<std::path::PathBuf> {
    let mut candidates = vec![
        std::path::PathBuf::from(sidecars_dir).join("bin").join(executable),
        std::path::PathBuf::from(sidecars_dir).join(executable),
    ];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.join("sidecars").join("bin").join(executable));
            candidates.push(dir.join("sidecars").join(executable));
            candidates.push(dir.join("resources").join("sidecars").join("bin").join(executable));
        }
    }
    candidates.into_iter().find(|path| path.is_file())
}

pub fn native_runtime_available(sidecars_dir: &str, executable: &str) -> bool {
    resolve_sidecar_executable(sidecars_dir, executable).is_some()
}

fn sidecar_root_from_executable(executable: &std::path::Path) -> std::path::PathBuf {
    executable
        .parent()
        .and_then(|parent| {
            if parent.file_name().is_some_and(|name| name.to_string_lossy() == "bin") {
                parent.parent()
            } else {
                Some(parent)
            }
        })
        .unwrap_or_else(|| executable.parent().unwrap_or(executable))
        .to_path_buf()
}

fn terminate_child(child: &mut Child) -> Result<(), String> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let mut killer = Command::new(system_tool("taskkill"))
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| format!("failed to terminate sidecar process tree: {}", e))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            match killer.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
                Ok(None) => break None,
                Err(error) => return Err(format!("failed to terminate sidecar process tree: {}", error)),
            }
        };
        let Some(status) = status else {
            let _ = killer.kill();
            let _ = killer.wait();
            let _ = child.kill();
            let _ = child.wait();
            return Err("sidecar process-tree termination timed out".to_string());
        };
        if !status.success() {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("taskkill failed for sidecar process tree: {}", status));
        }
    }
    #[cfg(not(windows))]
    child.kill().map_err(|e| format!("failed to terminate sidecar: {}", e))?;
    child.wait().map_err(|e| format!("failed to reap sidecar: {}", e))?;
    Ok(())
}

async fn ensure_http_ok(response: reqwest::Response, label: &str) -> Result<reqwest::Response, String> {
    if response.status().is_success() {
        return Ok(response);
    }
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    Err(format!("{} HTTP {}: {}", label, status, body.trim()))
}

/// ONE managed child process shared by all sidecar managers.
pub struct ManagedSidecar {
    process: Mutex<Option<Child>>,
    port: u16,
    /// Short log name, e.g. "stt".
    name: &'static str,
}

#[derive(Debug, Clone)]
struct PortOwner {
    pid: String,
    image: String,
}

#[cfg(windows)]
fn system_tool(name: &str) -> std::path::PathBuf {
    std::env::var_os("WINDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join(name)
}

#[cfg(not(windows))]
fn system_tool(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
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
        self.start_with_env(program, args, cwd, start_label, &[])
    }

    pub fn start_with_env(
        &self,
        program: &str,
        args: &[String],
        cwd: &str,
        start_label: &str,
        envs: &[(&str, &str)],
    ) -> Result<(), String> {
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

        let mut command = Command::new(program);
        command.args(args).current_dir(cwd);
        command.env_remove("PYTHONHOME");
        command.env_remove("PYTHONPATH");
        command.env("PYTHONNOUSERSITE", "1");
        for (key, value) in envs {
            command.env(key, value);
        }
        let child = command
            .spawn()
            .map_err(|e| format!("Failed to start {} sidecar ({}): {}", start_label, program, e))?;
        guard.replace(child);
        Ok(())
    }

    /// kill()+wait(): the child is reaped, never a zombie.
    pub fn stop(&self) -> Result<(), String> {
        let mut guard = self.process.lock().map_err(|e| e.to_string())?;
        if let Some(mut child) = guard.take() {
            terminate_child(&mut child)?;
        }
        Ok(())
    }

    fn reclaim_stale_port(&self) -> Result<(), String> {
        use std::net::{SocketAddr, TcpStream};
        let addr: SocketAddr = format!("127.0.0.1:{}", self.port)
            .parse()
            .map_err(|e| format!("bad sidecar port: {}", e))?;
        if TcpStream::connect_timeout(&addr, Duration::from_millis(200)).is_err() {
            return Ok(());
        }
        let Some(owner) = Self::port_owner(self.port) else {
            return Err(format!(
                "port {} is already in use by an unknown process — stop it and retry",
                self.port
            ));
        };
        let image = owner.image.to_ascii_lowercase();
        let ours = matches!(
            image.as_str(),
            "stt-server.exe"
                | "stt-server"
                | "tts-server.exe"
                | "tts-server"
                | "memory-server.exe"
                | "memory-server"
                | "llama-server.exe"
                | "llama-server"
        );
        if !ours {
            return Err(format!(
                "port {} is held by {} (pid {}, not a verified sidecar) — stop it and retry",
                self.port, owner.image, owner.pid
            ));
        }
        eprintln!(
            "[{}] port {} held by verified orphan process ({}) — killed and restarted",
            self.name, self.port, owner.image
        );
        Self::kill_port_owner(&owner)?;
        std::thread::sleep(Duration::from_millis(500));
        Ok(())
    }

    fn port_owner(port: u16) -> Option<PortOwner> {
        #[cfg(windows)]
        {
            Self::port_owner_windows(port)
        }
        #[cfg(not(windows))]
        {
            Self::port_owner_unix(port)
        }
    }

    #[cfg(windows)]
    fn port_owner_windows(port: u16) -> Option<PortOwner> {
        let netstat = Command::new(system_tool("netstat")).args(["-ano", "-p", "TCP"]).output().ok()?;
        let out = String::from_utf8_lossy(&netstat.stdout);
        let needle = format!("127.0.0.1:{}", port);
        let pid = out.lines().find_map(|line| {
            let cols: Vec<&str> = line.split_whitespace().collect();
            (cols.len() >= 5 && cols[0] == "TCP" && cols[1] == needle && cols[3] == "LISTENING")
                .then(|| cols[4].to_string())
        })?;
        let tasklist = Command::new(system_tool("tasklist"))
            .args(["/FI", &format!("PID eq {}", pid), "/FO", "CSV", "/NH"])
            .output()
            .ok()?;
        let row = String::from_utf8_lossy(&tasklist.stdout);
        let image = row.split(',').next()?.trim_matches('"').to_string();
        (!image.is_empty()).then_some(PortOwner { pid, image })
    }

    #[cfg(not(windows))]
    fn port_owner_unix(port: u16) -> Option<PortOwner> {
        let output = Command::new("lsof").args(["-ti", &format!("tcp:{}", port)]).output().ok()?;
        let pid = String::from_utf8_lossy(&output.stdout).lines().next()?.trim().to_string();
        if pid.is_empty() {
            return None;
        }
        let ps = Command::new("ps").args(["-p", &pid, "-o", "comm="]).output().ok()?;
        let image = String::from_utf8_lossy(&ps.stdout).trim().to_string();
        (!image.is_empty()).then_some(PortOwner { pid, image })
    }

    fn kill_port_owner(owner: &PortOwner) -> Result<(), String> {
        #[cfg(windows)]
        let status = Command::new(system_tool("taskkill"))
            .args(["/F", "/T", "/PID", owner.pid.as_str()])
            .status()
            .map_err(|e| e.to_string())?;
        #[cfg(not(windows))]
        let status = Command::new("kill")
            .args(["-9", owner.pid.as_str()])
            .status()
            .map_err(|e| e.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(format!("could not kill verified orphan process {}", owner.pid))
        }
    }
}

impl Drop for ManagedSidecar {
    /// Best-effort: children die with the app, never orphaned on exit.
    fn drop(&mut self) {
        if let Ok(mut guard) = self.process.lock() {
            if let Some(mut child) = guard.take() {
                let _ = terminate_child(&mut child);
            }
        }
    }
}

// ── Moonshine Voice STT sidecar ──────────────────────────────────

pub struct SttManager {
    proc: ManagedSidecar,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SttHealth {
    pub status: String,
    pub ready: bool,
    pub model_loaded: bool,
    pub model: Option<String>,
    pub error: Option<String>,
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
        let mut args = vec![self.proc.port().to_string()];
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            args.push(m.to_string());
        }
        if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "stt-server.exe") {
            let working_dir = sidecar_root_from_executable(&executable);
            let working_dir_text = working_dir.to_string_lossy();
            return self.proc.start_with_env(
                &executable.to_string_lossy(),
                &args,
                &working_dir_text,
                "STT",
                &[("JWE_SIDECARS_DIR", &working_dir_text)],
            );
        }
        let script = resolve_sidecar_script(sidecars_dir, "stt_server.py")?;
        let working_dir = script.parent().unwrap_or(std::path::Path::new(sidecars_dir));
        let mut python_args = vec![script.to_string_lossy().to_string()];
        python_args.extend(args);
        self.proc.start(python_path, &python_args, &working_dir.to_string_lossy(), "STT")
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
        ensure_http_ok(&resp)?;
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
        ensure_http_ok(&resp)?;
        let result: SttTranscribeResponse = resp.json().await.map_err(|e| e.to_string())?;
        result.text.ok_or_else(|| result.error.unwrap_or_else(|| "transcription failed".into()))
    }

    pub async fn stream_start(&self) -> Result<(), String> {
        let client = http_client(30);
        let resp = client.post(format!("{}/stream/start", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
        Ok(())
    }

    pub async fn stream_chunk(&self, audio_b64: &str, format: &str) -> Result<(), String> {
        let client = http_client(30);
        let body = serde_json::json!({ "audio": audio_b64, "format": format });
        let resp = client.post(format!("{}/stream/chunk", self.base_url()))
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
        Ok(())
    }

    pub async fn stream_stop(&self) -> Result<String, String> {
        let client = http_client(30);
        let resp = client.post(format!("{}/stream/stop", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
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
    pub ready: bool,
    pub model_loaded: bool,
    pub error: Option<String>,
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
        let mut args = vec![self.proc.port().to_string()];
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            args.push(m.to_string());
        }
        if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "tts-server.exe") {
            let working_dir = sidecar_root_from_executable(&executable);
            let working_dir_text = working_dir.to_string_lossy();
            return self.proc.start_with_env(
                &executable.to_string_lossy(),
                &args,
                &working_dir_text,
                "TTS",
                &[("JWE_SIDECARS_DIR", &working_dir_text)],
            );
        }
        let script = resolve_sidecar_script(sidecars_dir, "tts_server.py")?;
        let working_dir = script.parent().unwrap_or(std::path::Path::new(sidecars_dir));
        let mut python_args = vec![script.to_string_lossy().to_string()];
        python_args.extend(args);
        self.proc.start(python_path, &python_args, &working_dir.to_string_lossy(), "TTS")
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
        ensure_http_ok(&resp)?;
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
        ensure_http_ok(&resp)?;
        let result: TtsSynthResponse = resp.json().await.map_err(|e| e.to_string())?;
        match (result.audio, result.sample_rate) {
            (Some(audio), Some(sr)) => Ok((audio, sr)),
            _ => Err(result.error.unwrap_or_else(|| "synthesis failed".into())),
        }
    }

    pub async fn stop_playback(&self) -> Result<(), String> {
        let client = http_client(30);
        let resp = client.post(format!("{}/stop", self.base_url()))
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
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
    auth_token: String,
}

impl MemoryManager {
    pub fn new(port: u16, data_dir: String) -> Self {
        Self {
            proc: ManagedSidecar::new(port, "memory"),
            data_dir,
            auth_token: uuid::Uuid::new_v4().to_string(),
        }
    }

    pub fn start(&self, python_path: &str, sidecars_dir: &str) -> Result<(), String> {
        let args = vec![self.proc.port().to_string(), self.data_dir.clone()];
        if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "memory-server.exe") {
            let working_dir = sidecar_root_from_executable(&executable);
            let working_dir_text = working_dir.to_string_lossy();
            return self.proc.start_with_env(
                &executable.to_string_lossy(),
                &args,
                &working_dir_text,
                "memory",
                &[
                    ("JWE_SIDECARS_DIR", working_dir_text.as_ref()),
                    ("JWE_MEMORY_TOKEN", self.auth_token.as_str()),
                ],
            );
        }
        let script = resolve_sidecar_script(sidecars_dir, "memory_server.py")?;
        let working_dir = script.parent().unwrap_or(std::path::Path::new(sidecars_dir));
        let mut python_args = vec![script.to_string_lossy().to_string()];
        python_args.extend(args);
        let working_dir_text = working_dir.to_string_lossy();
        self.proc.start_with_env(
            python_path,
            &python_args,
            &working_dir_text,
            "memory",
            &[("JWE_MEMORY_TOKEN", self.auth_token.as_str())],
        )
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
            .header("X-JWE-Memory-Token", &self.auth_token)
            .json(&body)
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn health(&self) -> Result<MemoryHealth, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/health", self.base_url()))
            .header("X-JWE-Memory-Token", &self.auth_token)
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
        resp.json().await.map_err(|e| e.to_string())
    }

    pub async fn learn(&self, text: &str) -> Result<i64, String> {
        let data = self.post_json("/learn", serde_json::json!({ "text": text })).await?;
        data["stored"].as_i64().ok_or_else(|| "bad /learn response".to_string())
    }

    pub async fn recall(&self, query: &str) -> Result<String, String> {
        let client = http_client(30);
        let resp = client.get(format!("{}/recall", self.base_url()))
            .header("X-JWE-Memory-Token", &self.auth_token)
            .query(&[("q", query)])
            .send().await.map_err(|e| e.to_string())?;
        ensure_http_ok(&resp)?;
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

fn resolve_llm_model_path(
    path: Option<&str>,
    asset_root: &std::path::Path,
    models_dir: &std::path::Path,
) -> Result<std::path::PathBuf, String> {
    let requested = path.map(str::trim).filter(|value| !value.is_empty());
    let Some(requested) = requested else {
        let default_path = models_dir.join("lfm2.5-350m-q4_k_m.gguf");
        if !default_path.is_file() {
            return Err(format!("LLM model not found: {}", default_path.to_string_lossy()));
        }
        return Ok(default_path);
    };
    if !requested.to_ascii_lowercase().ends_with(".gguf") {
        return Err("LLM model must be a .gguf file".to_string());
    }
    let requested_path = std::path::Path::new(requested);
    if requested_path.is_absolute() {
        if !requested_path.is_file() {
            return Err(format!("LLM model not found: {}", requested));
        }
        return Ok(requested_path.to_path_buf());
    }
    if requested.contains(':')
        || requested.starts_with('/')
        || requested.starts_with('\\')
        || requested_path.components().any(|component| {
            matches!(
                component,
                std::path::Component::ParentDir | std::path::Component::RootDir
            )
        }) {
        return Err("LLM model path must stay inside the bundled models directory".to_string());
    }
    let candidate = if requested_path.starts_with("models") {
        asset_root.join(requested_path)
    } else {
        models_dir.join(requested_path)
    };
    if !candidate.is_file() {
        return Err(format!("LLM model not found: {}", candidate.to_string_lossy()));
    }
    Ok(candidate)
}

pub struct LlmManager {
    proc: ManagedSidecar,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LlmHealth {
    pub status: String,
    pub model: Option<String>,
    pub error: Option<String>,
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
        // sidecars root so older/manual layouts keep working. Raw portable
        // exes also try beside the exe before failing with a fetch hint.
        let mut server_candidates = vec![
            sidecars.join("models").join("llama-server.exe"),
            sidecars.join("llama-server.exe"),
        ];
        if let Ok(exe) = std::env::current_exe() {
            if let Some(dir) = exe.parent() {
                server_candidates.push(dir.join("sidecars").join("models").join("llama-server.exe"));
                server_candidates.push(dir.join("sidecars").join("llama-server.exe"));
            }
        }
        let server_exe = server_candidates
            .iter()
            .find(|p| p.is_file())
            .cloned()
            .unwrap_or_else(|| sidecars.join("llama-server.exe"));
        if !server_exe.is_file() {
            return Err(format!(
                "llama-server not found at {}. Fetch it with sidecars/fetch_sidecars.py (see docs/MODELS.md). Raw-exe runs need the sidecars bundle beside the exe or use the setup installer.",
                server_exe.to_string_lossy()
            ));
        }
        let asset_root = server_exe
            .parent()
            .filter(|parent| parent.file_name().is_some_and(|name| name.to_string_lossy() == "models"))
            .and_then(std::path::Path::parent)
            .or_else(|| server_exe.parent())
            .unwrap_or(&sidecars)
            .to_path_buf();
        let models_dir = asset_root.join("models");
        let model_file = resolve_llm_model_path(model_path, &asset_root, &models_dir).map_err(|error| {
            format!("{} Fetch it with sidecars/fetch_sidecars.py (see docs/MODELS.md).", error)
        })?;

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
        let server_dir = server_exe.parent().unwrap_or(&sidecars);
        self.proc.start(
            &server_exe.to_string_lossy(),
            &args,
            &server_dir.to_string_lossy(),
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
        let resp = ensure_http_ok(resp, "LLM health").await?;
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
        let resp = ensure_http_ok(resp, "LLM completion").await?;
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
        let resp = ensure_http_ok(resp, "LLM chat completion").await?;
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
