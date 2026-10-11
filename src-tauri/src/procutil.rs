//! Shared child-process helpers.
//!
//! hide_console: Windows otherwise flashes a console window for every
//! console child we spawn (python probe, typst, taskkill, the sidecar
//! servers themselves). GUI shells (explorer/ms-settings) don't need
//! this and must not get it — CREATE_NO_WINDOW on them is harmless but
//! pointless, so only helper consoles call this.
//!
//! terminate_child: kill()+wait() via taskkill /T on Windows (kills the
//! whole process tree — a python sidecar spawns no grandchildren today,
//! but llama-server might) with a bounded deadline, plain kill elsewhere.
//! Shared by ManagedSidecar (LLM) and IpcSidecar (stdio sidecars).
use std::process::{Child, Command};
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
