use tauri::State;
use crate::database::Database;
use crate::models::*;
use crate::models::normalize_memory_key;

#[tauri::command]
pub fn memory_decay_activity(db: State<'_, Database>) -> Result<(), String> {
    db.decay_activity_scores()
}

#[tauri::command]
pub fn memory_smart_tabs(db: State<'_, Database>, workspace: String) -> Result<Vec<Doc>, String> {
    db.get_smart_tabs(&workspace)
}

#[tauri::command]
pub fn memory_record_metric(
    db: State<'_, Database>,
    doc_id: String,
    metric_type: String,
    value: f64,
) -> Result<(), String> {
    db.record_craft_metric(&doc_id, &metric_type, value)
}

#[tauri::command]
pub fn memory_get_metrics(
    db: State<'_, Database>,
    doc_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    db.get_craft_metrics(&doc_id)
}

#[tauri::command]
pub fn memory_get_streak(db: State<'_, Database>) -> Result<i64, String> {
    db.get_writing_streak()
}

#[tauri::command]
pub fn memory_sidecar_start() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn memory_sidecar_stop() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn memory_sidecar_running() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn memory_sidecar_health() -> Result<bool, String> {
    Ok(false)
}

#[tauri::command]
pub fn memory_learn() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn memory_recall() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn memory_redact() -> Result<(), String> {
    Ok(())
}

#[tauri::command]
pub fn memory_forget_all() -> Result<(), String> {
    Ok(())
}
