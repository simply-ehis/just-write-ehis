use tauri::State;
use crate::database::Database;
use crate::models::*;
use crate::convert::convert_document;
use base64::Engine;

#[tauri::command]
pub fn convert_document_cmd(
    db: State<'_, Database>,
    doc_id: String,
    format: String,
) -> Result<serde_json::Value, String> {
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?.clone();
    let (filename, bytes) = convert_document(&doc_id, &format, &vault)?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
    Ok(serde_json::json!({ "filename": filename, "base64": b64 }))
}

#[tauri::command]
pub fn get_doc_tags(db: State<'_, Database>, doc_id: String) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT tag FROM doc_tags WHERE doc_id = ?1 ORDER BY tag")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&doc_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.filter_map(|r| r.ok()).collect()
}

#[tauri::command]
pub fn add_doc_tag(db: State<'_, Database>, doc_id: String, tag: String) -> Result<(), String> {
    let tag = tag.trim().to_lowercase();
    if tag.is_empty() {
        return Err("Tag cannot be empty".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?1, ?2)",
        params![&doc_id, &tag],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_doc_tag(db: State<'_, Database>, doc_id: String, tag: String) -> Result<(), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM doc_tags WHERE doc_id = ?1 AND tag = ?2",
        params![&doc_id, &tag],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_by_tag(db: State<'_, Database>, tag: String) -> Result<Vec<Doc>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT d.id, d.workspace, d.kind, d.title, d.path, d.parent_id, d.created_at, d.updated_at,
                d.content, d.word_count, d.reading_position, d.status, d.frontmatter_json,
                d.activity_score, d.embedding_ref, d.pinned, d.goal_words, d.deadline, d.locked
         FROM docs d
         INNER JOIN doc_tags dt ON dt.doc_id = d.id
         WHERE dt.tag = ?1 AND d.locked = 0
         ORDER BY d.updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&tag], |row| {
        Ok(Doc {
            id: row.get(0)?,
            workspace: row.get(1)?,
            kind: row.get(2)?,
            title: row.get(3)?,
            path: row.get(4)?,
            parent_id: row.get(5)?,
            created_at: row.get(6)?,
            updated_at: row.get(7)?,
            content: row.get(8)?,
            word_count: row.get(9)?,
            reading_position: row.get(10)?,
            status: row.get(11)?,
            frontmatter_json: row.get(12)?,
            activity_score: row.get(13)?,
            embedding_ref: row.get(14)?,
            pinned: row.get::<_, i64>(15).unwrap_or(0) != 0,
            goal_words: row.get(16)?,
            deadline: row.get(17)?,
            locked: row.get::<_, i64>(18).unwrap_or(0) != 0,
        })
    }).map_err(|e| e.to_string())?;
    rows.filter_map(|r| r.ok()).collect()
}
