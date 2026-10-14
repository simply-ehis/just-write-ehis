//! Shared child-process helpers.
//!
//! hide_console: Windows otherwise flashes a console window for every
//! console child we spawn (python probe, typst, taskkill, the sidecar
//! servers themselves). GUI shells (explorer/ms-settings) don't need
//! this and must not get it — CREATE_NO_WINDOW on them is harmless but
//! pointless, so only helper consoles call this.
//!
//! CREATE_NO_WINDOW is deliberately the ONLY console-creation flag.
//! Adding DETACHED_PROCESS reads like a stronger guarantee but measures
//! worse: the STT/TTS/memory sidecars are PyInstaller onefile builds
//! whose bootloader spawns a *second* process. With CREATE_NO_WINDOW the
//! parent owns a hidden console that grandchild inherits, so nothing is
//! ever shown; with DETACHED_PROCESS the parent has no console at all,
//! so that grandchild allocates a fresh, VISIBLE one — reopening the
//! exact window this flag exists to close. Measured 2026-10-14 on
//! Windows 11 with Windows Terminal as the default console host:
//! CREATE_NO_WINDOW showed no window, DETACHED_PROCESS |
//! CREATE_NO_WINDOW showed one titled `...stt-server.exe`. Guarded by
//! tests/sidecar-console-guard.mjs.
//!
//! sidecar logs: a hidden console is one a user can never read, so the
//! servers' output is redirected into the folder recorded by
//! `set_log_dir` instead. That keeps output off every console entirely
//! and leaves evidence behind when a sidecar dies. When no folder is
//! recorded (unit tests, path resolution failure) the streams go to the
//! null device — never to a console.
//!
//! terminate_child: kill()+wait() via taskkill /T on Windows (kills the
//! whole process tree — a python sidecar spawns no grandchildren today,
//! but llama-server might) with a bounded deadline, plain kill elsewhere.
//! Shared by ManagedSidecar (LLM) and IpcSidecar (stdio sidecars).
use std::fs::{File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::OnceLock;
use std::time::{Duration, Instant};

pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // 0x08000000 == CREATE_NO_WINDOW
        cmd.creation_flags(0x0800_0000);
    }
    #[cfg(not(windows))]
    {
        let _ = cmd;
    }
}

/// Sidecar output folder. Set once from `lib.rs` before any sidecar
/// starts; `None` means "logging unavailable", which degrades to the
/// null device rather than to a console.
static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Per-file cap: past this the log is renamed `<name>.old.log` and starts
/// fresh, so a crash-looping sidecar cannot fill the disk.
const LOG_ROTATE_BYTES: u64 = 4 * 1024 * 1024;

/// Record the log folder, creating it eagerly so it exists — and is
/// findable — even if no sidecar ever starts. Idempotent: first wins.
pub fn set_log_dir(dir: PathBuf) {
    let _ = std::fs::create_dir_all(&dir);
    let _ = LOG_DIR.set(dir);
}

/// The folder sidecar logs live in, when one was recorded.
pub fn log_dir() -> Option<&'static PathBuf> {
    LOG_DIR.get()
}

/// The null device — infallible fallback when logging is unavailable.
fn null_stdio() -> Stdio {
    Stdio::null()
}

/// Open `<log_dir>/<name>.log` for append, rotating a file past
/// `LOG_ROTATE_BYTES`. `None` when logging is unavailable.
fn open_log_file(name: &str, banner: bool) -> Option<File> {
    let dir = LOG_DIR.get()?;
    let _ = std::fs::create_dir_all(dir);
    let path = dir.join(format!("{}.log", name));
    if std::fs::metadata(&path).map(|m| m.len() > LOG_ROTATE_BYTES).unwrap_or(false) {
        let _ = std::fs::rename(&path, dir.join(format!("{}.old.log", name)));
    }
    let mut file = OpenOptions::new().create(true).append(true).open(&path).ok()?;
    if banner {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let _ = writeln!(file, "\n=== {} spawn @ unix {} ===", name, stamp);
    }
    Some(file)
}

/// Stdio for a sidecar that carries no protocol on stdout (the LLM): both
/// streams land in the same log file, so no output can reach a console
/// even if one were ever allocated.
pub fn sidecar_stdio(name: &str) -> (Stdio, Stdio) {
    let out = match open_log_file(name, true) {
        Some(f) => Stdio::from(f),
        None => null_stdio(),
    };
    let err = match open_log_file(name, false) {
        Some(f) => Stdio::from(f),
        None => null_stdio(),
    };
    (out, err)
}

/// stderr only, for the stdio-IPC sidecars: stdout is the JSON-line
/// protocol pipe and must stay a pipe.
pub fn sidecar_stderr(name: &str) -> Stdio {
    match open_log_file(name, true) {
        Some(f) => Stdio::from(f),
        None => null_stdio(),
    }
}

#[cfg(windows)]
pub fn system_tool(name: &str) -> std::path::PathBuf {
    std::env::var_os("WINDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| std::path::PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join(name)
}

#[cfg(not(windows))]
pub fn system_tool(name: &str) -> std::path::PathBuf {
    std::path::PathBuf::from(name)
}

pub fn terminate_child(child: &mut Child) -> Result<(), String> {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return Ok(());
    }
    #[cfg(windows)]
    {
        let pid = child.id().to_string();
        let mut killer = Command::new(system_tool("taskkill"));
        killer
            .args(["/PID", pid.as_str(), "/T", "/F"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null());
        hide_console(&mut killer);
        let mut killer = killer
            .spawn()
            .map_err(|e| format!("failed to terminate sidecar process tree: {}", e))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        let status = loop {
            match killer.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(25))
                }
                Ok(None) => break None,
                Err(error) => {
                    return Err(format!("failed to terminate sidecar process tree: {}", error))
                }
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
            // taskkill races: if the child already exited between our spawn
            // and taskkill's lookup, taskkill fails with exit 255 (or 128)
            // even though the process is gone. Treat "child already dead"
            // as success so stop() stays idempotent and test-safe.
            if matches!(child.try_wait(), Ok(Some(_))) {
                return Ok(());
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("taskkill failed for sidecar process tree: {}", status));
        }
    }
    #[cfg(not(windows))]
    child
        .kill()
        .map_err(|e| format!("failed to terminate sidecar: {}", e))?;
    #[cfg(not(windows))]
    child
        .wait()
        .map_err(|e| format!("failed to reap sidecar: {}", e))?;
    Ok(())
}
