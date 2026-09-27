use tauri::State;
use crate::database::Database;
use crate::models::*;

#[tauri::command]
pub fn bible_scope_id(db: State<'_, Database>, doc_id: String) -> Result<Option<String>, String> {
    db.bible_scope_id(&doc_id)
}

#[tauri::command]
pub fn bible_get_facts(
    db: State<'_, Database>,
    project: String,
) -> Result<Vec<BibleFact>, String> {
    db.bible_get_facts(&project)
}

#[tauri::command]
pub fn bible_upsert_fact(
    db: State<'_, Database>,
    project: String,
    kind: String,
    key: String,
    value: String,
) -> Result<BibleFact, String> {
    db.bible_upsert_fact(&project, &kind, &key, &value)
}

#[tauri::command]
pub fn bible_delete_fact(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.bible_delete_fact(&id)
}

#[tauri::command]
pub fn bible_get_mentions(
    db: State<'_, Database>,
    project: String,
) -> Result<Vec<BibleMention>, String> {
    db.bible_get_mentions(&project)
}

#[tauri::command]
pub fn bible_upsert_mention(
    db: State<'_, Database>,
    project: String,
    fact_key: String,
    kind: String,
    doc_id: String,
    snippet: String,
    attribute_key: Option<String>,
    attribute_value: Option<String>,
) -> Result<BibleMention, String> {
    db.bible_upsert_mention(&project, &fact_key, &kind, &doc_id, &snippet, attribute_key, attribute_value)
}

#[tauri::command]
pub fn bible_delete_mentions(
    db: State<'_, Database>,
    project: String,
    doc_id: String,
) -> Result<(), String> {
    db.bible_delete_mentions(&project, &doc_id)
}

#[tauri::command]
pub fn bible_get_suggestions(
    db: State<'_, Database>,
    project: String,
) -> Result<Vec<BibleSuggestion>, String> {
    db.bible_get_suggestions(&project)
}

#[tauri::command]
pub fn bible_confirm_suggestion(
    db: State<'_, Database>,
    project: String,
    suggestion_id: String,
) -> Result<BibleFact, String> {
    db.bible_confirm_suggestion(&project, &suggestion_id)
}

#[tauri::command]
pub fn bible_reject_suggestion(
    db: State<'_, Database>,
    project: String,
    suggestion_id: String,
) -> Result<(), String> {
    db.bible_reject_suggestion(&project, &suggestion_id)
}

#[tauri::command]
pub fn bible_extract_mentions(
    db: State<'_, Database>,
    doc_id: String,
) -> Result<(), String> {
    db.bible_extract_mentions(&doc_id)
}

#[tauri::command]
pub fn bible_rebuild_memory(
    db: State<'_, Database>,
    project: String,
) -> Result<(), String> {
    db.bible_rebuild_memory(&project)
}
