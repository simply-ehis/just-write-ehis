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
            ((extension == "txt" || extension == "md") && candidate.is_file())
                .then_some(candidate)
        })
}
