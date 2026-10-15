//! Private sidecar transports — no TCP anywhere.
//!
//! IpcSidecar: STT/TTS/memory servers speak newline-delimited JSON over
//! their own stdin/stdout pipes. One request frame per line in, one
//! response frame per line out (`{"id","method","params"}` →
//! `{"id","ok",result|error}`); diagnostics stay on the child's stderr.
//! A reader thread routes response frames to per-request oneshot
//! channels by id, so concurrent requests are safe and a dead child
//! fails every pending call instead of hanging it.
//!
//! SockClient: the LLM (llama-server) is a real HTTP server but binds
//! an AF_UNIX socket (`--host <path>.sock`) instead of a TCP port. We
//! speak HTTP/1.1 over that socket by hand — non-streaming only, which
//! covers /health, /completion, /v1/chat/completions and /v1/models.
//! On Windows AF_UNIX needs raw ws2_32 calls (std has no UnixStream
//! there); the connected socket is then wrapped in a TcpStream, whose
//! Read/Write are plain recv/send and work for any SOCKET.

use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::oneshot;

use crate::procutil::{hide_console, sidecar_stderr, terminate_child};

type PendingMap = Arc<Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

// ── IpcSidecar: stdio JSON frames ─────────────────────────────────

struct IpcState {
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    /// Fresh Arc per start: a reader thread from a previous generation
    /// drains only its own map on EOF, never the new one's.
    pending: Option<PendingMap>,
    next_id: u64,
}

pub struct IpcSidecar {
    name: &'static str,
    state: Mutex<IpcState>,
}

impl IpcSidecar {
    pub fn new(name: &'static str) -> Self {
        Self {
            name,
            state: Mutex::new(IpcState {
                child: None,
                stdin: None,
                pending: None,
                next_id: 1,
            }),
        }
    }

    pub fn is_running(&self) -> bool {
        match self.state.lock().as_mut() {
            Ok(state) => match state.child.as_mut() {
                Some(child) => match child.try_wait() {
                    Ok(None) => true,
                    Ok(Some(status)) => {
                        if !status.success() {
                            eprintln!(
                                "[{}] child exited with error: {:?}",
                                self.name,
                                status.code()
                            );
                        }
                        false
                    }
                    Err(_) => false,
                },
                None => false,
            },
            Err(_) => false,
        }
    }

    /// Spawn with stdin/stdout piped (stderr to the sidecar log file —
    /// never inherited, which would strand it in a hidden console). A
    /// live child is left alone; a dead handle is reaped and respawned.
    pub fn start_with_env(
        &self,
        program: &str,
        args: &[String],
        cwd: &str,
        envs: &[(&str, &str)],
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        if let Some(child) = state.child.as_mut() {
            match child.try_wait() {
                Ok(None) => return Ok(()),
                _ => {
                    let _ = child.wait();
                    state.child = None;
                    state.stdin = None;
                }
            }
        }

        let mut command = Command::new(program);
        command
            .args(args)
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(sidecar_stderr(self.name));
        command.env_remove("PYTHONHOME");
        command.env_remove("PYTHONPATH");
        command.env("PYTHONNOUSERSITE", "1");
        for (key, value) in envs {
            command.env(key, value);
        }
        hide_console(&mut command);
        let mut child = command
            .spawn()
            .map_err(|e| format!("Failed to start {} sidecar ({}): {}", self.name, program, e))?;
        let stdin = child.stdin.take().expect("stdin piped");
        let stdout = child.stdout.take().expect("stdout piped");

        let pending: PendingMap = Arc::new(Mutex::new(HashMap::new()));
        spawn_reader(self.name, stdout, Arc::clone(&pending));

        state.child = Some(child);
        state.stdin = Some(stdin);
        state.pending = Some(pending);
        state.next_id = 1;
        Ok(())
    }

    pub fn stop(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|e| e.to_string())?;
        // Closing stdin first lets a well-behaved server exit on EOF;
        // terminate_child then covers anything still alive.
        state.stdin = None;
        if let Some(mut child) = state.child.take() {
            terminate_child(&mut child)?;
        }
        state.pending = None;
        Ok(())
    }

    /// Send one request frame and await its response. Errors immediately
    /// when not running; a dead child fails pending calls via the
    /// reader's EOF drain; `timeout` bounds a wedged server.
    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let (id, rx) = {
            let mut state = self.state.lock().map_err(|e| e.to_string())?;
            if !self.is_running_locked(&state) {
                return Err(format!("{} sidecar is not running", self.name));
            }
            let id = state.next_id;
            state.next_id += 1;
            let (tx, rx) = oneshot::channel();
            let pending = state
                .pending
                .as_ref()
                .ok_or_else(|| format!("{} sidecar is not running", self.name))?;
            pending.lock().map_err(|e| e.to_string())?.insert(id, tx);
            let frame = json!({ "id": id, "method": method, "params": params });
            let mut line = serde_json::to_string(&frame).map_err(|e| e.to_string())?;
            line.push('\n');
            let stdin = state
                .stdin
                .as_mut()
                .ok_or_else(|| format!("{} sidecar stdin closed", self.name))?;
            stdin
                .write_all(line.as_bytes())
                .map_err(|e| format!("{} sidecar write failed: {}", self.name, e))?;
            stdin
                .flush()
                .map_err(|e| format!("{} sidecar write failed: {}", self.name, e))?;
            (id, rx)
        };

        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(format!(
                "{} sidecar exited while a request was in flight",
                self.name
            )),
            Err(_) => {
                // Evict the stale pending entry so a late frame is dropped.
                if let Ok(state) = self.state.lock() {
                    if let Some(pending) = state.pending.as_ref() {
                        if let Ok(mut map) = pending.lock() {
                            map.remove(&id);
                        }
                    }
                }
                Err(format!("{} sidecar request timed out", self.name))
            }
        }
    }

    fn is_running_locked(&self, state: &IpcState) -> bool {
        // try_wait needs &mut; we can't get that through a &IpcState, so
        // treat a present-but-unchecked child as running and let the
        // request path surface death via the reader's EOF drain.
        state.child.is_some() && state.pending.is_some()
    }
}

impl Drop for IpcSidecar {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.stdin = None;
            if let Some(mut child) = state.child.take() {
                let _ = terminate_child(&mut child);
            }
        }
    }
}

fn spawn_reader(name: &'static str, stdout: ChildStdout, pending: PendingMap) {
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let Ok(frame) = serde_json::from_str::<Value>(line) else {
                eprintln!("[{}] non-frame stdout line: {}", name, line);
                continue;
            };
            let Some(id) = frame.get("id").and_then(Value::as_u64) else {
                continue;
            };
            let result = match frame.get("ok").and_then(Value::as_bool) {
                Some(true) => Ok(frame.get("result").cloned().unwrap_or(Value::Null)),
                _ => Err(frame
                    .get("error")
                    .and_then(Value::as_str)
                    .unwrap_or("sidecar error")
                    .to_string()),
            };
            if let Ok(mut map) = pending.lock() {
                if let Some(tx) = map.remove(&id) {
                    let _ = tx.send(result);
                }
            }
        }
        // EOF / crash: fail everything still in flight.
        if let Ok(mut map) = pending.lock() {
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(format!("{} sidecar exited", name)));
            }
        }
    });
}

// ── SockClient: HTTP/1.1 over an AF_UNIX socket ───────────────────

/// Unified stream: Windows wraps the connected AF_UNIX SOCKET in a
/// TcpStream (recv/send work for any socket); elsewhere std UnixStream.
enum SockStream {
    #[cfg(windows)]
    Tcp(std::net::TcpStream),
    #[cfg(not(windows))]
    Ux(std::os::unix::net::UnixStream),
}

impl SockStream {
    fn set_read_timeout(&self, t: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(windows)]
            SockStream::Tcp(s) => s.set_read_timeout(t),
            #[cfg(not(windows))]
            SockStream::Ux(s) => s.set_read_timeout(t),
        }
    }

    fn set_write_timeout(&self, t: Option<Duration>) -> std::io::Result<()> {
        match self {
            #[cfg(windows)]
            SockStream::Tcp(s) => s.set_write_timeout(t),
            #[cfg(not(windows))]
            SockStream::Ux(s) => s.set_write_timeout(t),
        }
    }
}

impl Read for SockStream {
    fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(windows)]
            SockStream::Tcp(s) => s.read(buf),
            #[cfg(not(windows))]
            SockStream::Ux(s) => s.read(buf),
        }
    }
}

impl Write for SockStream {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self {
            #[cfg(windows)]
            SockStream::Tcp(s) => s.write(buf),
            #[cfg(not(windows))]
            SockStream::Ux(s) => s.write(buf),
        }
    }

    fn flush(&mut self) -> std::io::Result<()> {
        match self {
            #[cfg(windows)]
            SockStream::Tcp(s) => s.flush(),
            #[cfg(not(windows))]
            SockStream::Ux(s) => s.flush(),
        }
    }
}

/// ws2_32 FFI for AF_UNIX on Windows. AF_UNIX/SOCK_STREAM values are
/// fixed by the Winsock ABI (1/1); INVALID_SOCKET is !0.
#[cfg(windows)]
mod win_afunix {
    use std::os::windows::io::RawSocket;
    use std::path::Path;

    #[link(name = "ws2_32")]
    extern "system" {
        fn socket(af: i32, ty: i32, protocol: i32) -> RawSocket;
        fn connect(s: RawSocket, name: *const u8, namelen: i32) -> i32;
        fn closesocket(s: RawSocket) -> i32;
    }

    pub const AF_UNIX: i32 = 1;
    pub const SOCK_STREAM: i32 = 1;
    const INVALID_SOCKET: RawSocket = RawSocket::MAX;

    /// sockaddr_un on Windows: u16 family + 108-byte narrow path.
    #[repr(C)]
    struct SockaddrUn {
        sun_family: u16,
        sun_path: [u8; 108],
    }

    /// Connect to a Unix domain socket path. On success the caller owns
    /// the SOCKET and must close it (via TcpStream::from_raw_socket).
    pub fn connect_path(path: &Path) -> std::io::Result<std::net::TcpStream> {
        use std::os::windows::io::FromRawSocket;
        // Windows AF_UNIX takes the narrow (UTF-8) path in sun_path.
        let utf8 = path.to_string_lossy().into_owned().into_bytes();
        if utf8.len() >= 108 {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "AF_UNIX path too long",
            ));
        }
        unsafe {
            let fd = socket(AF_UNIX, SOCK_STREAM, 0);
            if fd == INVALID_SOCKET {
                return Err(std::io::Error::last_os_error());
            }
            let mut addr: SockaddrUn = std::mem::zeroed();
            addr.sun_family = AF_UNIX as u16;
            addr.sun_path[..utf8.len()].copy_from_slice(&utf8);
            // sun_path is zeroed, so the path is already NUL-terminated.
            let len = (2 + utf8.len() + 1) as i32;
            if connect(fd, &addr as *const SockaddrUn as *const u8, len) != 0 {
                let err = std::io::Error::last_os_error();
                closesocket(fd);
                return Err(err);
            }
            Ok(std::net::TcpStream::from_raw_socket(fd))
        }
    }
}

fn connect_sock(path: &Path) -> std::io::Result<SockStream> {
    #[cfg(windows)]
    {
        win_afunix::connect_path(path).map(SockStream::Tcp)
    }
    #[cfg(not(windows))]
    {
        std::os::unix::net::UnixStream::connect(path).map(SockStream::Ux)
    }
}

pub struct SockClient {
    path: PathBuf,
    token: String,
}

impl SockClient {
    pub fn new(path: impl Into<PathBuf>, token: impl Into<String>) -> Self {
        Self {
            path: path.into(),
            token: token.into(),
        }
    }

    pub async fn get_json(&self, route: &str, timeout: Duration) -> Result<Value, String> {
        let path = self.path.clone();
        let token = self.token.clone();
        let route = route.to_string();
        tauri::async_runtime::spawn_blocking(move || {
            let mut stream = connect_sock(&path).map_err(|e| format!("llm socket connect failed: {}", e))?;
            stream
                .set_read_timeout(Some(timeout))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(timeout))
                .map_err(|e| e.to_string())?;
            let request = format!(
                "GET {} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nConnection: close\r\n\r\n",
                route, token
            );
            stream
                .write_all(request.as_bytes())
                .map_err(|e| format!("llm socket write failed: {}", e))?;
            read_http_response(&mut stream)
        })
        .await
        .map_err(|e| format!("llm request task failed: {}", e))?
    }

    pub async fn post_json(
        &self,
        route: &str,
        body: &Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let path = self.path.clone();
        let token = self.token.clone();
        let route = route.to_string();
        let payload = serde_json::to_vec(body).map_err(|e| e.to_string())?;
        tauri::async_runtime::spawn_blocking(move || {
            let mut stream = connect_sock(&path).map_err(|e| format!("llm socket connect failed: {}", e))?;
            stream
                .set_read_timeout(Some(timeout))
                .map_err(|e| e.to_string())?;
            stream
                .set_write_timeout(Some(timeout))
                .map_err(|e| e.to_string())?;
            let header = format!(
                "POST {} HTTP/1.1\r\nHost: localhost\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                route,
                token,
                payload.len()
            );
            stream
                .write_all(header.as_bytes())
                .map_err(|e| format!("llm socket write failed: {}", e))?;
            stream
                .write_all(&payload)
                .map_err(|e| format!("llm socket write failed: {}", e))?;
            read_http_response(&mut stream)
        })
        .await
        .map_err(|e| format!("llm request task failed: {}", e))?
    }
}

/// Parse one complete HTTP/1.1 response (Connection: close semantics:
/// read to EOF; honor Content-Length or chunked when present). Returns
/// the JSON body, or a status-tagged error for non-2xx.
fn read_http_response(stream: &mut SockStream) -> Result<Value, String> {
    let mut raw = Vec::new();
    stream
        .read_to_end(&mut raw)
        .map_err(|e| format!("llm socket read failed: {}", e))?;
    let split = raw
        .windows(4)
        .position(|w| w == b"\r\n\r\n")
        .ok_or_else(|| "llm socket: malformed HTTP response".to_string())?;
    let head = String::from_utf8_lossy(&raw[..split]).into_owned();
    let body_bytes = &raw[split + 4..];
    let mut lines = head.lines();
    let status_line = lines.next().ok_or("llm socket: empty HTTP head")?;
    let status: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .ok_or_else(|| format!("llm socket: bad status line: {}", status_line))?;
    let mut chunked = false;
    let mut content_length: Option<usize> = None;
    for line in lines {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let value = value.trim();
        if key == "transfer-encoding" && value.to_ascii_lowercase().contains("chunked") {
            chunked = true;
        } else if key == "content-length" {
            content_length = value.parse().ok();
        }
    }
    let body: &[u8] = if chunked {
        &dechunk(body_bytes)
    } else if let Some(len) = content_length {
        if body_bytes.len() < len {
            return Err(format!(
                "llm socket: truncated body ({} of {} bytes)",
                body_bytes.len(),
                len
            ));
        }
        &body_bytes[..len]
    } else {
        body_bytes
    };
    let text = String::from_utf8_lossy(body);
    if !(200..300).contains(&status) {
        let snippet: String = text.trim().chars().take(300).collect();
        return Err(format!("llm HTTP {}: {}", status, snippet));
    }
    if text.trim().is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(text.trim()).map_err(|e| format!("llm socket: bad JSON body: {}", e))
}

/// Decode a complete chunked body (all chunks present — we already read
/// to EOF). Malformed input degrades to the bytes seen so far.
fn dechunk(input: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    let mut rest = input;
    loop {
        let Some(pos) = rest.windows(2).position(|w| w == b"\r\n") else {
            out.extend_from_slice(rest);
            break;
        };
        let head = String::from_utf8_lossy(&rest[..pos]).into_owned();
        let size_text = head.split(';').next().unwrap_or("").trim();
        let Ok(size) = usize::from_str_radix(size_text, 16) else {
            out.extend_from_slice(rest);
            break;
        };
        if size == 0 {
            break;
        }
        let start = pos + 2;
        let end = (start + size).min(rest.len());
        out.extend_from_slice(&rest[start..end]);
        if end + 2 > rest.len() {
            break;
        }
        rest = &rest[end + 2..];
    }
    out
}

// ── Tests ─────────────────────────────────────────────────────────

#[cfg(test)]
mod ipc_tests {
    use super::*;

    /// A dead IpcSidecar fails fast instead of hanging.
    #[test]
    fn request_without_start_errors() {
        let sidecar = IpcSidecar::new("test");
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .unwrap()
            .block_on(sidecar.request("health", json!({}), Duration::from_secs(1)));
        assert!(result.is_err());
    }

    /// Chunked bodies decode to the payload.
    #[test]
    fn dechunk_reassembles() {
        let encoded = b"5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n";
        assert_eq!(dechunk(encoded), b"hello world");
    }
}
