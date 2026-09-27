use tauri::State;
use crate::database::Database;
use crate::models::*;

#[tauri::command]
pub fn doc_create(
    db: State<'_, Database>,
    workspace: String,
    kind: String,
    title: String,
    parent_id: Option<String>,
    content: Option<String>,
    frontmatter_json: Option<String>,
) -> Result<Doc, String> {
    db.create_doc(CreateDocRequest {
        workspace,
        kind,
        title,
        parent_id,
        content,
        frontmatter_json,
    })
}

#[tauri::command]
pub fn doc_get(db: State<'_, Database>, id: String) -> Result<Doc, String> {
    db.get_doc(&id)
}

#[tauri::command]
pub fn doc_save(
    db: State<'_, Database>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    status: Option<String>,
    frontmatter_json: Option<String>,
    parent_id: Option<String>,
) -> Result<Doc, String> {
    db.save_doc(SaveDocRequest {
        id,
        title,
        content,
        status,
        frontmatter_json,
        parent_id,
    })
}

#[tauri::command]
pub fn doc_delete(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.delete_doc(&id)
}

#[tauri::command]
pub fn doc_toggle_pin(db: State<'_, Database>, id: String) -> Result<Doc, String> {
    db.toggle_pin(&id)
}

#[tauri::command]
pub fn doc_set_goal(db: State<'_, Database>, id: String, goal_words: i64) -> Result<Doc, String> {
    db.set_goal(&id, goal_words)
}

#[tauri::command]
pub fn doc_move(
    db: State<'_, Database>,
    id: String,
    new_parent_id: Option<String>,
    new_path: Option<String>,
) -> Result<Doc, String> {
    db.move_doc(MoveDocRequest { id, new_parent_id, new_path })
}

#[tauri::command]
pub fn doc_search(
    db: State<'_, Database>,
    query: String,
    workspace: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    db.search_docs(&query, workspace.as_deref())
}

#[tauri::command]
pub fn doc_list_by_workspace(
    db: State<'_, Database>,
    workspace: String,
) -> Result<Vec<Doc>, String> {
    db.list_docs_by_workspace(&workspace)
}

#[tauri::command]
pub fn doc_list_pinned(db: State<'_, Database>) -> Result<Vec<Doc>, String> {
    db.list_pinned_docs()
}

#[tauri::command]
pub fn doc_set_locked(db: State<'_, Database>, id: String, locked: bool) -> Result<Doc, String> {
    db.set_locked(&id, locked)
}

#[tauri::command]
pub fn doc_get_stats(db: State<'_, Database>) -> Result<(i64, i64, i64), String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let total_docs: i64 = conn.query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let total_words: i64 = conn.query_row("SELECT COALESCE(SUM(word_count), 0) FROM docs", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    let total_backlinks: i64 = conn.query_row("SELECT COUNT(*) FROM backlinks", [], |r| r.get(0)).map_err(|e| e.to_string())?;
    Ok((total_docs, total_words, total_backlinks))
}

#[tauri::command]
pub fn backlinks_get(db: State<'_, Database>, doc_id: String) -> Result<Vec<Backlink>, String> {
    db.get_backlinks(&doc_id)
}

#[tauri::command]
pub fn implicit_links_get(db: State<'_, Database>, doc_id: String) -> Result<Vec<ImplicitLink>, String> {
    db.get_implicit_links(&doc_id)
}

#[tauri::command]
pub fn backlinks_extract(db: State<'_, Database>, doc_id: String) -> Result<(), String> {
    db.extract_backlinks(&doc_id)
}

#[tauri::command]
pub fn unlinked_mentions(db: State<'_, Database>, doc_id: String) -> Result<Vec<String>, String> {
    db.get_unlinked_mentions(&doc_id)
}

#[tauri::command]
pub fn usage_record(db: State<'_, Database>, doc_id: String, event: String) -> Result<(), String> {
    db.record_usage_event(&doc_id, &event)
}

#[tauri::command]
pub fn tabs_get(db: State<'_, Database>, workspace: String) -> Result<Option<TabState>, String> {
    db.get_tab_state(&workspace)
}

#[tauri::command]
pub fn tabs_set(db: State<'_, Database>, state: TabState) -> Result<(), String> {
    db.set_tab_state(state)
}

#[tauri::command]
pub fn log_get_or_create(db: State<'_, Database>, date: String) -> Result<Doc, String> {
    db.log_get_or_create(&date)
}

#[tauri::command]
pub fn log_list_entries(db: State<'_, Database>, limit: Option<i64>) -> Result<Vec<Doc>, String> {
    db.log_list_entries(limit.unwrap_or(30))
}

#[tauri::command]
pub fn graph_query(db: State<'_, Database>) -> Result<GraphQueryResult, String> {
    db.graph_query()
}

#[tauri::command]
pub fn entities_list(db: State<'_, Database>, project: Option<String>) -> Result<Vec<Entity>, String> {
    db.entity_list(project.as_deref())
}

#[tauri::command]
pub fn entity_occurrences(
    db: State<'_, Database>,
    entity_norm: String,
) -> Result<Vec<EntityOccurrence>, String> {
    db.entity_occurrences(&entity_norm)
}

#[tauri::command]
pub fn entities_backfill(db: State<'_, Database>) -> Result<usize, String> {
    db.entities_backfill()
}

#[tauri::command]
pub fn get_reopen_never_finish(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.get_reopen_never_finish()
}

#[tauri::command]
pub fn clear_tab_states(db: State<'_, Database>) -> Result<(), String> {
    db.clear_tab_states()
}
