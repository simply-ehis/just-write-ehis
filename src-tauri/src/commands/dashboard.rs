use tauri::State;
use crate::database::Database;
use crate::models::*;

#[tauri::command]
pub fn dashboard_recent_docs(db: State<'_, Database>) -> Result<Vec<Doc>, String> {
    db.get_recent_docs(10)
}

#[tauri::command]
pub fn dashboard_workspace_counts(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_workspace_counts()
}

#[tauri::command]
pub fn dashboard_writing_days(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_writing_days()
}

#[tauri::command]
pub fn dashboard_patterns(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.dashboard_patterns()
}

#[tauri::command]
pub fn dashboard_goals(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_goals()
}

#[tauri::command]
pub fn dashboard_streak_heatmap(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_streak_heatmap()
}

#[tauri::command]
pub fn dashboard_writing_time_patterns(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_writing_time_patterns()
}

#[tauri::command]
pub fn dashboard_writing_velocity(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_writing_velocity()
}

#[tauri::command]
pub fn dashboard_productivity_score(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.get_productivity_score()
}

#[tauri::command]
pub fn dashboard_today_rhythm(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.get_today_rhythm()
}

#[tauri::command]
pub fn craft_metrics_trend(
    db: State<'_, Database>,
    doc_id: String,
    metric_type: String,
) -> Result<Vec<serde_json::Value>, String> {
    db.get_craft_metrics_trend(&doc_id, &metric_type)
}
