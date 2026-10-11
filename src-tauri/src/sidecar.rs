use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::ipc::{IpcSidecar, SockClient};
use crate::procutil::{hide_console, terminate_child};

// ── Shared process management ──────────────────────────────────────
//
// LAZY-START POLICY (one place): nothing spawns at boot or import time.
// Every sidecar starts on first user tap (ensure_*), stops on toggle-off.
//
// TRANSPORT (slice 4): no sidecar binds a TCP port.
// - STT / TTS / memory: private stdio JSON-line pipes (IpcSidecar) —
//   frames on the child's own stdin/stdout, logs on stderr.
// - LLM: llama-server binds an AF_UNIX socket (`--host <path>.sock`);
//   SockClient speaks HTTP/1.1 over that socket. No loopback listener,
//   so nothing else on the machine (or in a browser) can reach it.
// Per-launch tokens are still passed as env at spawn: the servers
// refuse to start without one, which keeps old/new builds
// interchangeable and documents the private-pipe contract.

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

/// ONE managed child process — used by the LLM (llama-server over
/// AF_UNIX). The stdio sidecars use IpcSidecar instead, which owns its
/// own pipes. No port: nothing here reclaims or inspects one.
pub struct ManagedSidecar {
    process: Mutex<Option<Child>>,
    /// Short log name, e.g. "llm".
    name: &'static str,
}

impl ManagedSidecar {
    pub fn new(name: &'static str) -> Self {
        Self {
            process: Mutex::new(None),
            name,
        }
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
    /// respawned (never early-Ok on a corpse).
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

        let mut command = Command::new(program);
        command.args(args).current_dir(cwd);
        command.env_remove("PYTHONHOME");
        command.env_remove("PYTHONPATH");
        command.env("PYTHONNOUSERSITE", "1");
        for (key, value) in envs {
            command.env(key, value);
        }
        hide_console(&mut command);
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

/// Model override travels as child-process argv: keep it a bare name so a
/// crafted value can't redirect the sidecar's model resolution elsewhere.
fn check_model_name(model: &str) -> Result<(), String> {
    if model.contains('/') || model.contains('\\') || model.contains("..") {
        return Err("Invalid model name.".into());
    }
    Ok(())
}

// ── Moonshine Voice STT sidecar (stdio) ───────────────────────────

pub struct SttManager {
    proc: IpcSidecar,
    /// Per-launch token, minted in `new` and required by the server at
    /// startup (env JWE_SIDECAR_TOKEN). The pipe itself is private; the
    /// token keeps the startup contract stable across builds.
    auth_token: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SttHealth {
    pub status: String,
    pub ready: bool,
    pub model_loaded: bool,
    pub model: Option<String>,
    pub error: Option<String>,
}

const HEALTH_TIMEOUT: Duration = Duration::from_secs(120);
const MEDIA_TIMEOUT: Duration = Duration::from_secs(180);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(30);

impl SttManager {
    pub fn new() -> Self {
        Self {
            proc: IpcSidecar::new("stt"),
            auth_token: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// argv is now [model?] — the server no longer takes a port.
    pub fn start(&self, python_path: &str, sidecars_dir: &str, model: Option<&str>) -> Result<(), String> {
        let mut args = Vec::new();
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            check_model_name(m)?;
            args.push(m.to_string());
        }
        let token = ("JWE_SIDECAR_TOKEN", self.auth_token.as_str());
        if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "stt-server.exe") {
            let working_dir = sidecar_root_from_executable(&executable);
            let working_dir_text = working_dir.to_string_lossy();
            return self.proc.start_with_env(
                &executable.to_string_lossy(),
                &args,
                &working_dir_text,
                &[("JWE_SIDECARS_DIR", &working_dir_text), token],
            );
        }
        let script = resolve_sidecar_script(sidecars_dir, "stt_server.py")?;
        let working_dir = script.parent().unwrap_or(std::path::Path::new(sidecars_dir));
        let mut python_args = vec![script.to_string_lossy().to_string()];
        python_args.extend(args);
        let working_dir_text = working_dir.to_string_lossy().to_string();
        self.proc.start_with_env(python_path, &python_args, &working_dir_text, &[token])
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub async fn health(&self) -> Result<SttHealth, String> {
        let value = self.proc.request("health", json!({}), HEALTH_TIMEOUT).await?;
        serde_json::from_value(value).map_err(|e| format!("bad health response: {}", e))
    }

    pub async fn transcribe(&self, audio_b64: &str, format: &str) -> Result<String, String> {
        let value = self
            .proc
            .request(
                "transcribe",
                json!({ "audio": audio_b64, "format": format }),
                MEDIA_TIMEOUT,
            )
            .await?;
        value
            .get("text")
            .and_then(|t| t.as_str())
            .map(String::from)
            .ok_or_else(|| "transcription failed".to_string())
    }

    pub async fn stream_start(&self) -> Result<(), String> {
        self.proc
            .request("stream_start", json!({}), CONTROL_TIMEOUT)
            .await?;
        Ok(())
    }

    pub async fn stream_chunk(&self, audio_b64: &str, format: &str) -> Result<(), String> {
        self.proc
            .request(
                "stream_chunk",
                json!({ "audio": audio_b64, "format": format }),
                CONTROL_TIMEOUT,
            )
            .await?;
        Ok(())
    }

    pub async fn stream_stop(&self) -> Result<String, String> {
        let value = self.proc.request("stream_stop", json!({}), MEDIA_TIMEOUT).await?;
        value
            .get("text")
            .and_then(|t| t.as_str())
            .map(String::from)
            .ok_or_else(|| "stream transcription failed".to_string())
    }
}

// ── Kokoro TTS sidecar (stdio) ────────────────────────────────────

pub struct TtsManager {
    proc: IpcSidecar,
    auth_token: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct TtsHealth {
    pub status: String,
    pub ready: bool,
    pub model_loaded: bool,
    pub error: Option<String>,
}

impl TtsManager {
    pub fn new() -> Self {
        Self {
            proc: IpcSidecar::new("tts"),
            auth_token: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// argv is now [model_dir?] — no port.
    pub fn start(&self, python_path: &str, sidecars_dir: &str, model: Option<&str>) -> Result<(), String> {
        let mut args = Vec::new();
        if let Some(m) = model.filter(|m| !m.trim().is_empty()) {
            check_model_name(m)?;
            args.push(m.to_string());
        }
        let token = ("JWE_SIDECAR_TOKEN", self.auth_token.as_str());
        if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "tts-server.exe") {
            let working_dir = sidecar_root_from_executable(&executable);
            let working_dir_text = working_dir.to_string_lossy();
            return self.proc.start_with_env(
                &executable.to_string_lossy(),
                &args,
                &working_dir_text,
                &[("JWE_SIDECARS_DIR", &working_dir_text), token],
            );
        }
        let script = resolve_sidecar_script(sidecars_dir, "tts_server.py")?;
        let working_dir = script.parent().unwrap_or(std::path::Path::new(sidecars_dir));
        let mut python_args = vec![script.to_string_lossy().to_string()];
        python_args.extend(args);
        let working_dir_text = working_dir.to_string_lossy().to_string();
        self.proc.start_with_env(python_path, &python_args, &working_dir_text, &[token])
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub async fn health(&self) -> Result<TtsHealth, String> {
        let value = self.proc.request("health", json!({}), HEALTH_TIMEOUT).await?;
        serde_json::from_value(value).map_err(|e| format!("bad health response: {}", e))
    }

    pub async fn synthesize(
        &self,
        text: &str,
        voice: &str,
        speed: f64,
        lang_code: &str,
        split_pattern: &str,
        chunk_size: u32,
    ) -> Result<(String, u32), String> {
        let value = self
            .proc
            .request(
                "synthesize",
                json!({
                    "text": text,
                    "voice": voice,
                    "speed": speed,
                    "lang_code": lang_code,
                    "split_pattern": split_pattern,
                    "chunk_size": chunk_size,
                }),
                MEDIA_TIMEOUT,
            )
            .await?;
        let audio = value
            .get("audio")
            .and_then(|a| a.as_str())
            .filter(|a| !a.is_empty())
            .ok_or_else(|| "synthesis failed".to_string())?;
        let sample_rate = value
            .get("sample_rate")
            .and_then(|s| s.as_u64())
            .ok_or_else(|| "synthesis failed: missing sample rate".to_string())? as u32;
        Ok((audio.to_string(), sample_rate))
    }

    pub async fn stop_playback(&self) -> Result<(), String> {
        self.proc
            .request("stop", json!({}), CONTROL_TIMEOUT)
            .await?;
        Ok(())
    }
}

// ── AI memory sidecar (vendored harness memory + redaction, stdio) ─

#[derive(Serialize, Deserialize, Debug)]
pub struct MemoryHealth {
    pub status: String,
    pub facts: i64,
}

pub struct MemoryManager {
    proc: IpcSidecar,
    data_dir: String,
    auth_token: String,
}

impl MemoryManager {
    pub fn new(data_dir: String) -> Self {
        Self {
            proc: IpcSidecar::new("memory"),
            data_dir,
            auth_token: uuid::Uuid::new_v4().to_string(),
        }
    }

    /// argv is now [data_dir] only — no port.
    pub fn start(&self, python_path: &str, sidecars_dir: &str) -> Result<(), String> {
        let args = vec![self.data_dir.clone()];
        if let Some(executable) = resolve_sidecar_executable(sidecars_dir, "memory-server.exe") {
            let working_dir = sidecar_root_from_executable(&executable);
            let working_dir_text = working_dir.to_string_lossy();
            return self.proc.start_with_env(
                &executable.to_string_lossy(),
                &args,
                &working_dir_text,
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
            &[("JWE_MEMORY_TOKEN", self.auth_token.as_str())],
        )
    }

    pub fn stop(&self) -> Result<(), String> {
        self.proc.stop()
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub async fn health(&self) -> Result<MemoryHealth, String> {
        let value = self.proc.request("health", json!({}), HEALTH_TIMEOUT).await?;
        serde_json::from_value(value).map_err(|e| format!("bad health response: {}", e))
    }

    pub async fn learn(&self, text: &str) -> Result<i64, String> {
        let value = self
            .proc
            .request("learn", json!({ "text": text }), CONTROL_TIMEOUT)
            .await?;
        value
            .get("stored")
            .and_then(|s| s.as_i64())
            .ok_or_else(|| "bad learn response".to_string())
    }

    pub async fn recall(&self, query: &str) -> Result<String, String> {
        let value = self
            .proc
            .request("recall", json!({ "q": query }), CONTROL_TIMEOUT)
            .await?;
        value
            .get("facts")
            .and_then(|f| f.as_str())
            .map(String::from)
            .ok_or_else(|| "bad recall response: missing facts field".to_string())
    }

    pub async fn redact(&self, text: &str) -> Result<String, String> {
        let value = self
            .proc
            .request("redact", json!({ "text": text }), CONTROL_TIMEOUT)
            .await?;
        value
            .get("text")
            .and_then(|t| t.as_str())
            .map(String::from)
            .ok_or_else(|| "bad redact response".to_string())
    }

    pub async fn clear(&self) -> Result<(), String> {
        self.proc
            .request("clear", json!({}), CONTROL_TIMEOUT)
            .await?;
        Ok(())
    }
}

// ── LLM sidecar (llama.cpp server over AF_UNIX) ───────────────────

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
        // Absolute model paths are confined to the bundled/known model
        // roots: an arbitrary .gguf anywhere on disk must not be mmap'd
        // into the backend on renderer input (info disclosure via crafted
        // files, network-share hangs on probe).
        let canon = requested_path
            .canonicalize()
            .map_err(|_| format!("LLM model not found: {}", requested))?;
        let inside = |dir: &std::path::Path| {
            dir.canonicalize()
                .map(|base| canon.starts_with(&base))
                .unwrap_or(false)
        };
        if !(inside(models_dir) || inside(asset_root)) {
            return Err("LLM model must live inside the app models directory".to_string());
        }
        if !canon.is_file() {
            return Err(format!("LLM model not found: {}", requested));
        }
        return Ok(canon);
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
    /// Per-launch bearer token; also passed as --api-key so llama-server
    /// refuses anyone else even if they somehow reached the socket.
    auth_token: String,
    /// Per-launch AF_UNIX socket path (under the OS temp dir). Unlinked
    /// before each spawn so a stale file from a crashed run can't block
    /// the bind.
    sock_path: std::path::PathBuf,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct LlmHealth {
    pub status: String,
    pub model: Option<String>,
    pub error: Option<String>,
}

impl LlmManager {
    pub fn new() -> Self {
        Self {
            proc: ManagedSidecar::new("llm"),
            auth_token: uuid::Uuid::new_v4().to_string(),
            sock_path: std::env::temp_dir().join(format!("jwe-llm-{}.sock", uuid::Uuid::new_v4())),
        }
    }

    fn sock_client(&self) -> SockClient {
        SockClient::new(self.sock_path.clone(), self.auth_token.clone())
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

        // Unlink a stale socket file from a previous crashed run: llama-
        // server fails to bind if the path already exists.
        let _ = std::fs::remove_file(&self.sock_path);

        // `--api-key` is load-bearing, not decoration: even on a private
        // AF_UNIX socket the key keeps the startup contract explicit and
        // stops any local process that somehow obtained the socket path
        // (e.g. via a world-readable temp listing) from driving inference.
        // `--host <path>.sock` binds AF_UNIX instead of TCP — nothing
        // listens on a port, so no loopback (or browser) request can
        // reach this server at all.
        let args = vec![
            "-m".to_string(),
            model_file.to_string_lossy().to_string(),
            "--host".to_string(),
            self.sock_path.to_string_lossy().to_string(),
            "--api-key".to_string(),
            self.auth_token.clone(),
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
        let server_dir_text = server_dir.to_string_lossy().to_string();
        self.proc.start(
            &server_exe.to_string_lossy(),
            &args,
            &server_dir_text,
            "LLM",
        )
    }

    pub fn stop(&self) -> Result<(), String> {
        let result = self.proc.stop();
        // Best-effort socket cleanup so the next start binds clean.
        let _ = std::fs::remove_file(&self.sock_path);
        result
    }

    pub fn is_running(&self) -> bool {
        self.proc.is_running()
    }

    pub async fn health(&self) -> Result<LlmHealth, String> {
        let value = self.sock_client().get_json("/health", HEALTH_TIMEOUT).await?;
        serde_json::from_value(value).map_err(|e| format!("bad health response: {}", e))
    }

    pub async fn completion(&self, prompt: &str, max_tokens: u32, temperature: f32) -> Result<String, String> {
        let value = self
            .sock_client()
            .post_json(
                "/completion",
                &json!({
                    "prompt": prompt,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "stream": false,
                }),
                MEDIA_TIMEOUT,
            )
            .await?;
        value
            .get("content")
            .and_then(|c| c.as_str())
            .map(|s| s.to_string())
            .ok_or_else(|| "LLM server returned no content".to_string())
    }

    pub async fn chat_completion(
        &self,
        messages: Vec<serde_json::Value>,
        max_tokens: u32,
        temperature: f32,
    ) -> Result<String, String> {
        let value = self
            .sock_client()
            .post_json(
                "/v1/chat/completions",
                &json!({
                    "messages": messages,
                    "max_tokens": max_tokens,
                    "temperature": temperature,
                    "stream": false,
                }),
                MEDIA_TIMEOUT,
            )
            .await?;
        value["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| "LLM server returned no content".to_string())
    }

    /// OpenAI-compatible /v1/models over the socket (Settings Test
    /// buttons route the sentinel endpoint here).
    pub async fn list_models(&self) -> Result<Vec<String>, String> {
        let value = self.sock_client().get_json("/v1/models", CONTROL_TIMEOUT).await?;
        Ok(value
            .get("data")
            .and_then(|d| d.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default())
    }
}

#[cfg(test)]
mod managed_tests {
    use super::*;

    #[test]
    fn start_invalid_program_errors_and_stays_down() {
        let m = ManagedSidecar::new("test");
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let r = m.start("definitely-not-a-real-binary-xyz", &[], &dir, "TEST");
        assert!(r.is_err());
        assert!(!m.is_running());
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
        let m = ManagedSidecar::new("test");
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
        let m = ManagedSidecar::new("test");
        let dir = std::env::temp_dir().to_string_lossy().to_string();
        let (prog, args) = long_lived();
        m.start(&prog, &args, &dir, "TEST").expect("spawn");
        assert!(m.is_running());
        m.stop().expect("stop");
        assert!(!m.is_running());
        // Second stop is a safe no-op.
        m.stop().expect("second stop");
    }

    /// Model overrides ride as child argv: bare names pass, anything that
    /// could redirect resolution (separators, parent escapes) fails closed.
    #[test]
    fn model_name_allows_bare_names_only() {
        assert!(check_model_name("moonshine-base.gguf").is_ok());
        assert!(check_model_name("kokoro-v1.0").is_ok());
        assert!(check_model_name("../evil").is_err());
        assert!(check_model_name("sub/dir").is_err());
        assert!(check_model_name("C:\\models\\x").is_err());
    }
}
