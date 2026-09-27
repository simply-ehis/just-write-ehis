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

pub fn find_openable_file(path: &Path) -> Option<PathBuf> {
    if !path.is_file() {
        return None;
    }
    let extension = path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let text_exts = [
        "txt", "text", "rtf", "log",
        "md", "markdown", "mdown", "mkd", "mkdn", "mdwn",
        "rst", "org", "adoc", "asciidoc",
        "json", "yaml", "yml", "toml", "ini", "cfg", "conf", "xml", "csv", "tsv",
        "html", "htm", "css", "js", "ts", "jsx", "tsx",
        "py", "rs", "go", "java", "c", "cpp", "h", "hpp", "cs", "php", "rb", "swift", "kt", "scala",
        "sh", "bash", "zsh", "ps1", "bat", "cmd",
    ];
    if text_exts.contains(&extension.as_str()) {
        return Some(path.to_path_buf());
    }
    std::fs::read(path)
        .ok()
        .filter(|bytes| !bytes.contains(&0))
        .map(|_| path.to_path_buf())
}

pub fn file_type_label(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "md" | "markdown" | "mdown" | "mkd" | "mkdn" | "mdwn" => "Markdown",
        "txt" | "text" => "Text",
        "rtf" => "Rich Text",
        "json" | "yaml" | "yml" | "toml" | "ini" | "cfg" | "conf" | "xml" | "csv" | "tsv" => "Data",
        "html" | "htm" => "HTML",
        "js" | "ts" | "jsx" | "tsx" => "Script",
        "py" => "Python",
        "rs" => "Rust",
        "go" => "Go",
        "sh" | "bash" | "zsh" => "Shell",
        "ps1" | "bat" | "cmd" => "Batch",
        _ => "Document",
    }
}

pub fn is_openable(path: &Path) -> bool {
    find_openable_file(path).is_some()
}
