use tauri::State;
use crate::database::Database;
use crate::models::*;

#[tauri::command]
pub fn script_character_list(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    db.script_frontmatter_array(&doc_id, "characters")
}

#[tauri::command]
pub fn script_character_add(
    db: State<'_, Database>,
    doc_id: String,
    value: String,
) -> Result<serde_json::Value, String> {
    db.script_frontmatter_add(&doc_id, "characters", &value)
}

#[tauri::command]
pub fn script_location_list(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    db.script_frontmatter_array(&doc_id, "locations")
}

#[tauri::command]
pub fn script_location_add(
    db: State<'_, Database>,
    doc_id: String,
    value: String,
) -> Result<serde_json::Value, String> {
    db.script_frontmatter_add(&doc_id, "locations", &value)
}

#[tauri::command]
pub fn script_timeline_get(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    db.script_frontmatter_array(&doc_id, "timeline")
}

#[tauri::command]
pub fn script_timeline_add(
    db: State<'_, Database>,
    doc_id: String,
    value: String,
) -> Result<serde_json::Value, String> {
    db.script_frontmatter_add(&doc_id, "timeline", &value)
}

#[tauri::command]
pub fn script_role_list(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    db.script_frontmatter_array(&doc_id, "roles")
}

#[tauri::command]
pub fn script_role_assign(
    db: State<'_, Database>,
    doc_id: String,
    character: String,
    role: String,
) -> Result<serde_json::Value, String> {
    db.script_frontmatter_add(&doc_id, "roles", &format!("{}:{}", character, role))
}

#[tauri::command]
pub fn script_role_create(
    db: State<'_, Database>,
    doc_id: String,
    value: String,
) -> Result<serde_json::Value, String> {
    db.script_frontmatter_add(&doc_id, "roles", &value)
}

#[tauri::command]
pub fn script_role_delete(
    db: State<'_, Database>,
    doc_id: String,
    value: String,
) -> Result<serde_json::Value, String> {
    db.script_frontmatter_remove(&doc_id, "roles", &value)
}
