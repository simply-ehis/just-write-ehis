//! Voice registration for the phonon server.
//!
//! Voice embeddings live in `models/phonon/voices/` as `<name>.safetensors`,
//! and `voices.jsonl` (if present) lists `{"name", "filename"}` entries.

use std::path::Path;

use crate::engine::{EngineError, Result, TtsEngine};

/// Register every voice found in `model_dir` with the engine.
pub fn register_all(engine: &TtsEngine, model_dir: &Path) -> Result<()> {
    let voices_dir = model_dir.join("voices");
    if voices_dir.is_dir() {
        if let Ok(entries) = std::fs::read_dir(&voices_dir) {
            for entry in entries.flatten() {
                let path = entry.path();
                if path.extension().and_then(|e| e.to_str()) == Some("safetensors") {
                    let name = path.file_stem().unwrap_or_default().to_string_lossy().to_string();
                    engine.register_voice_file(&name, &path)?;
                }
            }
        }
    }

    // voices.jsonl overrides/adds to the directory scan
    let catalog = model_dir.join("voices.jsonl");
    if catalog.is_file() {
        register_catalog(engine, &catalog)?;
    }

    Ok(())
}

fn register_catalog(engine: &TtsEngine, catalog: &Path) -> Result<()> {
    let content = std::fs::read_to_string(catalog).map_err(|e| EngineError::Io(e.to_string()))?;
    let dir = catalog.parent().unwrap_or(std::path::Path::new(""));
    for (i, line) in content.lines().enumerate() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let entry: serde_json::Value = serde_json::from_str(line)
            .map_err(|e| EngineError::Model(format!("{}:{}: {e}", catalog.display(), i + 1)))?;
        let name = entry.get("name").and_then(|v| v.as_str()).unwrap_or("");
        let filename = entry.get("filename").and_then(|v| v.as_str()).unwrap_or("");
        if name.is_empty() || filename.is_empty() {
            continue;
        }
        let path = dir.join(filename);
        engine.register_voice_file(name, &path)?;
    }
    Ok(())
}

/// Return the default voice name, preferring "default" if registered.
pub fn default_voice_name(engine: &TtsEngine) -> Option<String> {
    let voices = engine.voices();
    if voices.contains(&"default".to_string()) {
        return Some("default".to_string());
    }
    voices.into_iter().next()
}
