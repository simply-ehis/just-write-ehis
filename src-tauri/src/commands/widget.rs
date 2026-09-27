use tauri::State;
use crate::database::Database;
use crate::models::*;

fn widget_doc_unlocked(db: &Database, doc_id: &str) -> Result<Doc, String> {
    let doc = db.get_doc(doc_id)?;
    if doc.locked {
        return Err("Document is locked".into());
    }
    Ok(doc)
}

#[tauri::command]
pub fn widget_doc_get(db: State<'_, Database>, doc_id: String) -> Result<Doc, String> {
    widget_doc_unlocked(&db, &doc_id)
}

#[tauri::command]
pub fn widget_doc_save(
    db: State<'_, Database>,
    doc_id: String,
    content: String,
) -> Result<Doc, String> {
    widget_doc_unlocked(&db, &doc_id)?;
    db.save_doc(SaveDocRequest {
        id: doc_id,
        title: None,
        content: Some(content),
        status: None,
        frontmatter_json: None,
        parent_id: None,
    })
}

#[tauri::command]
pub fn widget_atomic_save(
    db: State<'_, Database>,
    doc_id: String,
    content: String,
) -> Result<Doc, String> {
    widget_doc_unlocked(&db, &doc_id)?;
    db.atomic_save(&doc_id, &content)
}

#[tauri::command]
pub fn open_external_file(db: State<'_, Database>, path: String) -> Result<Option<Doc>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (db, path);
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        use std::path::PathBuf;
        let path = PathBuf::from(path);
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if extension != "txt" && extension != "md" {
            return Err("Only .txt and .md files can be opened from Windows file associations.".into());
        }
        let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
        let title = path.file_stem().and_then(|s| s.to_str()).unwrap_or("Untitled").to_string();
        let doc = db.create_doc(CreateDocRequest {
            workspace: "home".into(),
            kind: "doc".into(),
            title,
            parent_id: None,
            content: Some(content),
            frontmatter_json: None,
        })?;
        Ok(Some(doc))
    }
}

#[tauri::command]
pub fn take_launch_file(app: tauri::AppHandle) -> Result<Option<String>, String> {
    let pending = app.try_state::<crate::windows::PendingLaunchFile>();
    match pending {
        Some(p) => {
            let path = p.get();
            if path.is_empty() {
                Ok(None)
            } else {
                p.set(String::new());
                Ok(Some(path))
            }
        }
        None => Ok(None),
    }
}

#[tauri::command]
pub fn open_default_apps() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "ms-settings:defaultapps"])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
