use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Default)]
pub struct PendingLaunchFile {
    path: Mutex<Option<PathBuf>>,
}

impl PendingLaunchFile {
    pub fn set(&self, path: PathBuf) {
        if let Ok(mut pending) = self.path.lock() {
            *pending = Some(path);
        }
    }

    pub fn take(&self) -> Option<String> {
        self.path
            .lock()
            .ok()
            .and_then(|mut pending| pending.take())
            .map(|path| path.to_string_lossy().into_owned())
    }
}

/// True when this process was launched by OS autostart (login) rather than
/// the user. The frontend stays hidden and warms up instead of popping a
/// window; the user opens it later via tray, dock, or a second launch.
#[derive(Default)]
pub struct AutostartLaunch {
    warm: Mutex<bool>,
}

impl AutostartLaunch {
    pub fn set(&self) {
        if let Ok(mut warm) = self.warm.lock() {
            *warm = true;
        }
    }

    pub fn get(&self) -> bool {
        self.warm.lock().map(|warm| *warm).unwrap_or(false)
    }
}

pub fn find_text_file(args: &[String], cwd: &Path) -> Option<PathBuf> {
    args.iter()
        .filter(|arg| !arg.starts_with("--"))
        .find_map(|arg| {
            let candidate = PathBuf::from(arg);
            let candidate = if candidate.is_absolute() {
                candidate
            } else {
                cwd.join(candidate)
            };
            let extension = candidate
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            if !candidate.is_file() {
                return None;
            }
            let text_exts = [
                "txt", "text", "rtf", "log",
                "md", "markdown", "mdown", "mkd", "mkdn", "mdwn",
                "rst", "org", "adoc", "asciidoc",
                "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "csv", "tsv",
                "html", "htm", "css", "js", "ts", "jsx", "tsx",
                "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "php", "rb", "swift", "kt", "scala",
                "sh", "bash", "zsh", "ps1", "bat", "cmd",
            ];
            text_exts.contains(&extension.as_str()).then_some(candidate)
        })
}

#[cfg(test)]
mod windows_tests {
    use super::*;

    #[test]
    fn text_file_args_resolve() {
        let dir = std::env::temp_dir();
        let probe = dir.join("jwe-probe-notes.md");
        std::fs::write(&probe, "# probe").unwrap();
        let found = find_text_file(
            &[probe.to_string_lossy().into_owned()],
            &dir,
        );
        assert_eq!(found, Some(probe.clone()));
        let _ = std::fs::remove_file(&probe);
    }

    #[test]
    fn non_text_args_are_ignored() {
        let dir = std::env::temp_dir();
        assert_eq!(
            find_text_file(&["--widget-autostart".to_string()], &dir),
            None
        );
    }

    #[test]
    fn binaries_and_missing_files_are_ignored() {
        let dir = std::env::temp_dir();
        assert_eq!(find_text_file(&["app.exe".to_string()], &dir), None);
        assert_eq!(
            find_text_file(&["jwe-no-such-file-xyz.md".to_string()], &dir),
            None
        );
    }

    #[test]
    fn relative_paths_resolve_against_cwd() {
        let dir = std::env::temp_dir().join(format!("jwe-rel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("rel.md"), "# rel").unwrap();
        let found = find_text_file(&["rel.md".to_string()], &dir);
        assert_eq!(found, Some(dir.join("rel.md")));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
