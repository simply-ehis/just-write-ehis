use tauri::State;
use crate::database::Database;
use crate::models::*;

#[tauri::command]
pub fn fs_list_dir(path: String) -> Result<Vec<serde_json::Value>, String> {
    let entries = std::fs::read_dir(&path).map_err(|e| e.to_string())?;
    let mut result = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        result.push(serde_json::json!({
            "name": entry.file_name().to_string_lossy(),
            "path": entry.path().to_string_lossy(),
            "is_dir": metadata.is_dir(),
            "size": metadata.len(),
        }));
    }
    Ok(result)
}

#[tauri::command]
pub fn fs_read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_rename(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_delete(path: String) -> Result<(), String> {
    let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if metadata.is_dir() {
        std::fs::remove_dir_all(&path).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(&path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn fs_move(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_reveal(path: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg("/select,")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn attachment_save(
    db: State<'_, Database>,
    doc_id: String,
    filename: String,
    data_base64: String,
) -> Result<String, String> {
    let data = base64::decode(&data_base64).map_err(|e| e.to_string())?;
    if data.len() > 10 * 1024 * 1024 {
        return Err("Attachment too large (max 10MB)".into());
    }
    let safe_name: String = filename
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '.' || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if safe_name.is_empty() || safe_name == "." || safe_name == ".." || safe_name.starts_with('.') {
        return Err("Invalid filename".into());
    }
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?.clone();
    let attachments_dir = vault.join(".attachments").join(&doc_id);
    std::fs::create_dir_all(&attachments_dir).map_err(|e| e.to_string())?;
    let path = attachments_dir.join(&safe_name);
    std::fs::write(&path, &data).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn attachment_read(path: String) -> Result<String, String> {
    if !path.contains(".attachments/") {
        return Err("Invalid attachment path".into());
    }
    if path.contains("..") {
        return Err("Path traversal not allowed".into());
    }
    let data = std::fs::read(&path).map_err(|e| e.to_string())?;
    Ok(base64::encode(&data))
}
