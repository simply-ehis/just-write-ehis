use tauri::State;
use crate::database::Database;
use crate::models::*;
use crate::convert::html_escape;
use ammonia;

fn sanitize_body(html: &str) -> String {
    ammonia::clean(html)
}

fn sanitize_inline_css(css: &str) -> String {
    css.replace("expression(", "")
        .replace("javascript:", "")
}

fn sanitize_inline_js(js: &str) -> String {
    js.replace("</script", "<\\/script")
}

#[tauri::command]
pub fn publish_static_site(
    db: State<'_, Database>,
    config: serde_json::Value,
) -> Result<String, String> {
    let title = config["title"].as_str().unwrap_or("Published Site");
    let description = config["description"].as_str().unwrap_or("");
    let theme = config["theme"].as_str().unwrap_or("auto");
    let include_workspaces = config["includeWorkspaces"]
        .as_array()
        .map(|arr| arr.iter().filter_map(|v| v.as_str()).collect::<Vec<_>>())
        .unwrap_or_default();
    let custom_css = config["customCss"].as_str().unwrap_or("");
    let custom_js = config["customJs"].as_str().unwrap_or("");
    let toc_depth = config["tocDepth"].as_u64().unwrap_or(3).clamp(1, 6) as usize;

    let docs = if include_workspaces.is_empty() {
        db.list_all_docs()?
    } else {
        let mut all = Vec::new();
        for ws in &include_workspaces {
            all.extend(db.list_docs_by_workspace(ns)?);
        }
        all
    };

    let mut html = String::new();
    html.push_str(&format!("<!DOCTYPE html>\n<html lang=\"en\" data-theme=\"{}\">\n<head>\n", html_escape(theme)));
    html.push_str(&format!("<meta charset=\"UTF-8\">\n<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\">\n"));
    html.push_str(&format!("<title>{}</title>\n", html_escape(title)));
    html.push_str(&format!("<meta name=\"description\" content=\"{}\">\n", html_escape(description)));
    html.push_str("<style>\n");
    html.push_str("body{font-family:system-ui,sans-serif;max-width:800px;margin:0 auto;padding:2rem;line-height:1.6;}\n");
    html.push_str(&format!("{}\n", sanitize_inline_css(custom_css)));
    html.push_str("</style>\n</head>\n<body>\n");

    let mut toc = String::new();
    toc.push_str("<div class=\"toc\"><strong>Contents</strong><ul>");
    let heading_regex = regex::Regex::new(&format!(r"(?m)^(#{{1,{}}})\s+(.+)$", toc_depth)).map_err(|e| e.to_string())?;
    for doc in &docs {
        if doc.locked {
            continue;
        }
        for cap in heading_regex.captures_iter(&doc.content) {
            let level = cap[1].len();
            let text = &cap[2];
            toc.push_str(&format!("<li style=\"margin-left:{}rem\">{}</li>\n", level - 1, html_escape(text)));
        }
    }
    toc.push_str("</ul></div>\n");
    html.push_str(&toc);

    for doc in &docs {
        if doc.locked {
            continue;
        }
        let body = sanitize_body(&doc.content);
        html.push_str(&format!("<article>\n<h1>{}</h1>\n{}\n</article>\n", html_escape(&doc.title), body));
    }

    html.push_str("<script>\n");
    html.push_str(&sanitize_inline_js(custom_js));
    html.push_str("\n</script>\n</body>\n</html>");

    Ok(html)
}

#[tauri::command]
pub fn vault_rename_preview(
    db: State<'_, Database>,
    old_title: String,
    new_title: String,
) -> Result<Vec<serde_json::Value>, String> {
    db.vault_rename_preview(&old_title, &new_title)
}

#[tauri::command]
pub fn vault_rename_execute(
    db: State<'_, Database>,
    old_title: String,
    new_title: String,
) -> Result<usize, String> {
    db.vault_rename_execute(&old_title, &new_title)
}

#[tauri::command]
pub fn atomic_save(
    db: State<'_, Database>,
    doc_id: String,
    content: String,
) -> Result<Doc, String> {
    db.atomic_save(&doc_id, &content)
}

#[tauri::command]
pub fn setup_file_watcher(
    app: tauri::AppHandle,
    db: State<'_, Database>,
) -> Result<(), String> {
    db.setup_file_watcher(app)
}

#[tauri::command]
pub fn get_workspace_context(
    db: State<'_, Database>,
    doc_id: String,
) -> Result<serde_json::Value, String> {
    db.get_workspace_context(&doc_id)
}

#[tauri::command]
pub fn get_vault_path(db: State<'_, Database>) -> Result<String, String> {
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?;
    Ok(vault.to_string_lossy().to_string())
}

#[tauri::command]
pub fn perf_benchmark(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.perf_benchmark()
}

#[tauri::command]
pub fn clear_conversations(db: State<'_, Database>) -> Result<(), String> {
    db.clear_conversations()
}

#[tauri::command]
pub fn clear_messages(db: State<'_, Database>) -> Result<(), String> {
    db.clear_messages()
}

#[tauri::command]
pub fn clear_snapshots(db: State<'_, Database>) -> Result<(), String> {
    db.clear_snapshots()
}

#[tauri::command]
pub fn clear_usage_events(db: State<'_, Database>) -> Result<(), String> {
    db.clear_usage_events()
}

#[tauri::command]
pub fn app_update_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let config = app.config();
    let pubkey = config.plugins.updater.pubkey.as_deref().unwrap_or("");
    let endpoints = config.plugins.updater.endpoints.as_ref().map(|e| e.as_slice()).unwrap_or(&[]);
    Ok(serde_json::json!({
        "hasPubkey": !pubkey.is_empty(),
        "endpoints": endpoints,
    }))
}

#[tauri::command]
pub fn convert_run(
    db: State<'_, Database>,
    doc_id: String,
    format: String,
) -> Result<String, String> {
    let doc = db.get_doc(&doc_id)?;
    crate::convert::convert_doc(&doc.content, &format)
}

#[tauri::command]
pub fn compile_run(
    db: State<'_, Database>,
    doc_ids: Vec<String>,
    format: String,
) -> Result<String, String> {
    let mut output = String::new();
    for id in &doc_ids {
        let doc = db.get_doc(id)?;
        output.push_str(&crate::convert::convert_doc(&doc.content, &format)?);
        output.push_str("\n\n---\n\n");
    }
    Ok(output)
}

#[tauri::command]
pub fn convert_status() -> Result<serde_json::Value, String> {
    let pandoc = crate::convert::find_pandoc();
    Ok(serde_json::json!({
        "pandocAvailable": pandoc.is_some(),
        "pandocPath": pandoc,
    }))
}

#[tauri::command]
pub fn ghost_fork(db: State<'_, Database>, doc_id: String) -> Result<Doc, String> {
    db.ghost_fork(&doc_id)
}

#[tauri::command]
pub fn ghost_list(db: State<'_, Database>, doc_id: String) -> Result<Vec<Doc>, String> {
    db.ghost_list(&doc_id)
}

#[tauri::command]
pub fn ghost_merge(db: State<'_, Database>, ghost_id: String) -> Result<Doc, String> {
    db.ghost_merge(&ghost_id)
}

#[tauri::command]
pub fn ghost_dismiss(db: State<'_, Database>, ghost_id: String) -> Result<(), String> {
    db.ghost_dismiss(&ghost_id)
}

#[tauri::command]
pub fn atlas_get_stars(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.atlas_get_stars()
}

#[tauri::command]
pub fn canvas_list(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.canvas_list()
}

#[tauri::command]
pub fn canvas_upsert_node(db: State<'_, Database>, node: serde_json::Value) -> Result<serde_json::Value, String> {
    db.canvas_upsert_node(node)
}

#[tauri::command]
pub fn canvas_delete_node(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.canvas_delete_node(&id)
}

#[tauri::command]
pub fn canvas_connect(db: State<'_, Database>, source_id: String, target_id: String, label: String) -> Result<serde_json::Value, String> {
    db.canvas_connect(&source_id, &target_id, &label)
}

#[tauri::command]
pub fn canvas_delete_edge(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.canvas_delete_edge(&id)
}

#[tauri::command]
pub fn reader_update_position(db: State<'_, Database>, doc_id: String, position: f64) -> Result<(), String> {
    db.update_reader_position(&doc_id, position)
}

#[tauri::command]
pub fn reader_set_shelf_status(db: State<'_, Database>, doc_id: String, status: String) -> Result<(), String> {
    db.set_shelf_status(&doc_id, &status)
}

#[tauri::command]
pub fn reader_set_rating(db: State<'_, Database>, doc_id: String, rating: i64) -> Result<(), String> {
    db.set_rating(&doc_id, rating)
}

#[tauri::command]
pub fn reader_get_bookshelf(db: State<'_, Database>) -> Result<Vec<Doc>, String> {
    db.get_bookshelf()
}

#[tauri::command]
pub fn reader_import_book(db: State<'_, Database>, title: String, content: String) -> Result<Doc, String> {
    db.import_book(&title, &content)
}

#[tauri::command]
pub fn novel_get_beat_board(db: State<'_, Database>, project: String) -> Result<serde_json::Value, String> {
    db.get_beat_board(&project)
}

#[tauri::command]
pub fn novel_compile(db: State<'_, Database>, project: String) -> Result<String, String> {
    db.compile_novel(&project)
}

#[tauri::command]
pub fn conversation_create(db: State<'_, Database>, mode: String) -> Result<serde_json::Value, String> {
    db.create_conversation(&mode)
}

#[tauri::command]
pub fn conversation_list(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.list_conversations()
}

#[tauri::command]
pub fn conversation_add_message(
    db: State<'_, Database>,
    conversation_id: String,
    role: String,
    content: String,
) -> Result<(), String> {
    db.add_message(&conversation_id, &role, &content)
}

#[tauri::command]
pub fn conversation_get_messages(
    db: State<'_, Database>,
    conversation_id: String,
) -> Result<Vec<serde_json::Value>, String> {
    db.get_messages(&conversation_id)
}

#[tauri::command]
pub fn snapshot_create(db: State<'_, Database>, doc_id: String, label: String) -> Result<serde_json::Value, String> {
    db.snapshot_create(&doc_id, &label)
}

#[tauri::command]
pub fn snapshot_list(db: State<'_, Database>, doc_id: String) -> Result<Vec<serde_json::Value>, String> {
    db.snapshot_list(&doc_id)
}

#[tauri::command]
pub fn snapshot_restore(db: State<'_, Database>, snapshot_id: String) -> Result<Doc, String> {
    db.snapshot_restore(&snapshot_id)
}

#[tauri::command]
pub fn snapshot_delete_old(db: State<'_, Database>, doc_id: String, keep: i64) -> Result<(), String> {
    db.snapshot_delete_old(&doc_id, keep)
}

#[tauri::command]
pub fn backup_create(db: State<'_, Database>) -> Result<String, String> {
    db.backup_create()
}

#[tauri::command]
pub fn backup_list(db: State<'_, Database>) -> Result<Vec<serde_json::Value>, String> {
    db.backup_list()
}

#[tauri::command]
pub fn rag_chunk_document(db: State<'_, Database>, doc_id: String) -> Result<(), String> {
    db.rag_chunk_document(&doc_id)
}

#[tauri::command]
pub fn rag_search(db: State<'_, Database>, query: String, limit: Option<i64>) -> Result<Vec<serde_json::Value>, String> {
    db.rag_search(&query, limit.unwrap_or(5))
}

#[tauri::command]
pub fn rag_get_context(db: State<'_, Database>, query: String, doc_id: Option<String>) -> Result<String, String> {
    db.rag_get_context(&query, doc_id.as_deref())
}

#[tauri::command]
pub fn sidecar_python_probe() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({
        "pythonAvailable": false,
        "pythonPath": null,
    }))
}
