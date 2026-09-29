use tauri::{Manager, State};
use crate::database::Database;
use crate::models::*;
use crate::sidecar;
use std::io::Read;
use std::time::{Duration, Instant};
use std::sync::Mutex;
use std::collections::HashSet;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::process::Command;
use serde::Serialize;
use uuid::Uuid;
use crate::windows::PendingLaunchFile;

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
pub fn open_external_file(db: State<'_, Database>, path: String) -> Result<Option<Doc>, String> {
    #[cfg(not(target_os = "windows"))]
    {
        let _ = (db, path);
        return Ok(None);
    }
    #[cfg(target_os = "windows")]
    {
        let path = PathBuf::from(path);
        let extension = path.extension().and_then(|value| value.to_str()).unwrap_or("").to_ascii_lowercase();
        if extension != "txt" && extension != "md" {
            return Err("Only .txt and .md files can be opened from Windows file associations.".into());
        }
        if !path.is_file() {
            return Err(format!("File not found: {}", path.display()));
        }
        // Cap before reading: a multi-GB .txt would otherwise be loaded
        // whole into memory (25 MB mirrors attachment_save).
        if path.metadata().map(|m| m.len()).unwrap_or(0) > 25 * 1024 * 1024 {
            return Err("File over 25 MB — open it from its own app instead.".into());
        }
        let bytes = std::fs::read(&path).map_err(|error| format!("Couldn't read {}: {}", path.display(), error))?;
        if bytes.contains(&0) {
            return Err("That file looks binary, not UTF-8 text.".into());
        }
        let content = String::from_utf8(bytes).map_err(|_| "The file is not valid UTF-8 text.".to_string())?;
        let title = path.file_stem().and_then(|value| value.to_str()).filter(|value| !value.is_empty()).unwrap_or("Untitled").to_string();
        let doc = db.create_doc(CreateDocRequest {
            workspace: "write".into(),
            kind: "doc".into(),
            title,
            parent_id: None,
            content: Some(content),
            frontmatter_json: Some(serde_json::json!({ "source_path": path.to_string_lossy() }).to_string()),
        })?;
        Ok(Some(doc))
    }
}

#[tauri::command]
pub fn take_launch_file(pending: State<'_, PendingLaunchFile>) -> Option<String> {
    pending.take()
}

#[tauri::command]
pub fn open_default_apps() -> Result<(), String> {
    #[cfg(not(target_os = "windows"))]
    return Ok(());
    #[cfg(target_os = "windows")]
    Command::new("explorer.exe")
        .arg("ms-settings:defaultapps")
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Couldn't open Windows Default Apps settings: {}", error))
}

#[tauri::command]
pub fn doc_get(db: State<'_, Database>, id: String) -> Result<Doc, String> {
    db.get_doc(&id)
}

fn widget_doc_unlocked(db: &Database, id: &str) -> Result<Doc, String> {
    let doc = db.get_doc(id)?;
    if doc.locked {
        return Err("document is locked and unavailable to the companion window".to_string());
    }
    Ok(doc)
}

#[tauri::command]
pub fn widget_doc_get(db: State<'_, Database>, id: String) -> Result<Doc, String> {
    widget_doc_unlocked(&db, &id)
}

#[tauri::command]
pub fn widget_doc_save(
    db: State<'_, Database>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    status: Option<String>,
    frontmatter_json: Option<String>,
    parent_id: Option<Option<String>>,
) -> Result<Doc, String> {
    widget_doc_unlocked(&db, &id)?;
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
pub fn doc_save(
    db: State<'_, Database>,
    id: String,
    title: Option<String>,
    content: Option<String>,
    status: Option<String>,
    frontmatter_json: Option<String>,
    parent_id: Option<Option<String>>,
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
pub fn doc_toggle_pin(db: State<'_, Database>, id: String) -> Result<bool, String> {
    db.toggle_pin(&id)
}

#[tauri::command]
pub fn doc_set_goal(db: State<'_, Database>, id: String, goal_words: Option<i64>, deadline: Option<String>) -> Result<(), String> {
    db.set_goal(&id, goal_words, deadline)
}

#[tauri::command]
pub fn doc_set_locked(db: State<'_, Database>, id: String, locked: bool) -> Result<(), String> {
    db.set_locked(&id, locked)
}

#[tauri::command]
pub fn doc_list_pinned(db: State<'_, Database>) -> Result<Vec<Doc>, String> {
    db.list_pinned_docs()
}

#[tauri::command]
pub fn dashboard_today_rhythm(db: State<'_, Database>) -> Result<Vec<(i64, i64)>, String> {
    db.today_rhythm()
}

// ── AI memory sidecar (vendored harness) ───────────────────────────

#[tauri::command]
pub fn memory_sidecar_start(
    mem: State<'_, sidecar::MemoryManager>,
    python_path: String,
    sidecars_dir: String,
) -> Result<(), String> {
    require_sidecar_paths(&sidecars_dir)?;
    let python = python_for_sidecar(&python_path, &sidecars_dir, "memory-server.exe")?;
    mem.start(&python, &sidecars_dir)
}

#[tauri::command]
pub fn memory_sidecar_stop(mem: State<'_, sidecar::MemoryManager>) -> Result<(), String> {
    mem.stop()
}

#[tauri::command]
pub fn memory_sidecar_running(mem: State<'_, sidecar::MemoryManager>) -> bool {
    mem.is_running()
}

#[tauri::command]
pub async fn memory_sidecar_health(mem: State<'_, sidecar::MemoryManager>) -> Result<sidecar::MemoryHealth, String> {
    mem.health().await
}

#[tauri::command]
pub async fn memory_learn(mem: State<'_, sidecar::MemoryManager>, text: String) -> Result<i64, String> {
    mem.learn(&text).await
}

#[tauri::command]
pub async fn memory_recall(mem: State<'_, sidecar::MemoryManager>, query: String) -> Result<String, String> {
    mem.recall(&query).await
}

#[tauri::command]
pub async fn memory_redact(mem: State<'_, sidecar::MemoryManager>, text: String) -> Result<String, String> {
    mem.redact(&text).await
}

#[tauri::command]
pub async fn memory_forget_all(mem: State<'_, sidecar::MemoryManager>) -> Result<(), String> {
    mem.clear().await
}

#[tauri::command]
pub fn canvas_list(db: State<'_, Database>) -> Result<(Vec<CanvasNode>, Vec<CanvasEdge>), String> {
    db.canvas_list()
}

#[tauri::command]
pub fn canvas_upsert_node(db: State<'_, Database>, node: CanvasNode) -> Result<CanvasNode, String> {
    db.canvas_upsert_node(node)
}

#[tauri::command]
pub fn canvas_delete_node(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.canvas_delete_node(&id)
}

#[tauri::command]
pub fn canvas_connect(db: State<'_, Database>, source_id: String, target_id: String, label: String) -> Result<CanvasEdge, String> {
    db.canvas_connect(&source_id, &target_id, &label)
}

#[tauri::command]
pub fn canvas_delete_edge(db: State<'_, Database>, id: String) -> Result<(), String> {
    db.canvas_delete_edge(&id)
}

#[tauri::command]
pub fn doc_move(
    db: State<'_, Database>,
    id: String,
    new_parent_id: Option<String>,
    new_path: Option<String>,
) -> Result<Doc, String> {
    db.move_doc(MoveDocRequest {
        id,
        new_parent_id,
        new_path,
    })
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
pub fn backlinks_get(db: State<'_, Database>, doc_id: String) -> Result<Vec<Backlink>, String> {
    db.get_backlinks(&doc_id)
}

#[tauri::command]
pub fn implicit_links_get(db: State<'_, Database>, doc_id: String) -> Result<Vec<LinkImplicit>, String> {
    db.get_implicit_links(&doc_id)
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
pub fn graph_query(db: State<'_, Database>, workspace: Option<String>, tags: Option<Vec<String>>) -> Result<GraphQueryResult, String> {
    db.graph_query(workspace.as_deref(), tags.as_deref())
}

#[tauri::command]
pub fn backlinks_extract(db: State<'_, Database>, doc_id: String) -> Result<(), String> {
    let doc = db.get_doc(&doc_id)?;
    db.extract_backlinks(&doc_id, &doc.content)
}

#[tauri::command]
pub fn unlinked_mentions(db: State<'_, Database>, doc_id: String) -> Result<Vec<UnlinkedMention>, String> {
    db.get_unlinked_mentions(&doc_id)
}

#[tauri::command]
pub fn entities_list(db: State<'_, Database>) -> Result<Vec<EntitySummary>, String> {
    db.entity_list()
}

#[tauri::command]
pub fn entity_occurrences(db: State<'_, Database>, entity_norm: String) -> Result<Vec<EntityHit>, String> {
    db.entity_occurrences(&entity_norm)
}

#[tauri::command]
pub fn entities_backfill(db: State<'_, Database>) -> Result<i64, String> {
    db.entities_backfill()
}

#[tauri::command]
pub fn reader_update_position(db: State<'_, Database>, doc_id: String, position: f64) -> Result<(), String> {
    db.update_reading_position(&doc_id, position)
}

#[tauri::command]
pub fn reader_set_shelf_status(db: State<'_, Database>, doc_id: String, status: String) -> Result<(), String> {
    db.set_bookshelf_status(&doc_id, &status)
}

#[tauri::command]
pub fn reader_set_rating(db: State<'_, Database>, doc_id: String, rating: Option<i64>) -> Result<(), String> {
    db.set_book_rating(&doc_id, rating)
}

#[tauri::command]
pub fn reader_get_bookshelf(db: State<'_, Database>, filter: Option<String>) -> Result<Vec<BookshelfEntry>, String> {
    db.get_bookshelf(filter.as_deref())
}

#[tauri::command]
pub fn reader_import_book(db: State<'_, Database>, title: String, content: String, kind: String) -> Result<Doc, String> {
    db.import_book(&title, &content, &kind)
}

#[tauri::command]
pub fn novel_get_beat_board(db: State<'_, Database>, project_id: String) -> Result<BeatBoard, String> {
    db.get_beat_board(&project_id)
}

#[tauri::command]
pub fn novel_compile(db: State<'_, Database>, project_id: String) -> Result<String, String> {
    db.compile_beats(&project_id)
}

#[tauri::command]
pub fn bible_scope_id(db: State<'_, Database>, doc_id: String) -> Result<String, String> {
    db.bible_scope_id(&doc_id)
}

#[tauri::command]
pub fn bible_get_facts(db: State<'_, Database>, doc_id: String) -> Result<Vec<BibleFact>, String> {
    db.bible_get_facts(&doc_id)
}

#[tauri::command]
pub fn bible_upsert_fact(db: State<'_, Database>, doc_id: String, kind: String, key: String, value: String) -> Result<BibleFact, String> {
    db.bible_upsert_fact(&doc_id, &kind, &key, &value)
}

#[tauri::command]
pub fn bible_delete_fact(db: State<'_, Database>, fact_id: String) -> Result<(), String> {
    db.bible_delete_fact(&fact_id)
}

#[tauri::command]
pub fn bible_get_mentions(db: State<'_, Database>, bible_doc_id: String) -> Result<Vec<BibleMention>, String> {
    db.bible_get_mentions(&bible_doc_id)
}

#[tauri::command]
// Eight args is the Tauri IPC contract (one per invoke key); bundling them
// into a struct would break every caller, so the lint is allowed here.
#[allow(clippy::too_many_arguments)]
pub fn bible_upsert_mention(
    db: State<'_, Database>,
    bible_doc_id: String,
    doc_id: String,
    fact_key: String,
    kind: String,
    snippet: String,
    attribute_key: Option<String>,
    attribute_value: Option<String>,
) -> Result<BibleMention, String> {
    db.bible_upsert_mention(
        &bible_doc_id,
        &doc_id,
        &fact_key,
        &kind,
        &snippet,
        attribute_key.as_deref(),
        attribute_value.as_deref(),
    )
}

#[tauri::command]
pub fn bible_delete_mentions(
    db: State<'_, Database>,
    bible_doc_id: String,
    doc_id: Option<String>,
    fact_key: Option<String>,
) -> Result<(), String> {
    db.bible_delete_mentions(&bible_doc_id, doc_id.as_deref(), fact_key.as_deref())
}

#[tauri::command]
pub fn bible_get_suggestions(db: State<'_, Database>, bible_doc_id: String) -> Result<Vec<BibleSuggestion>, String> {
    db.bible_get_suggestions(&bible_doc_id)
}

#[tauri::command]
pub fn bible_confirm_suggestion(db: State<'_, Database>, bible_doc_id: String, suggestion_id: String) -> Result<BibleFact, String> {
    db.bible_confirm_suggestion(&bible_doc_id, &suggestion_id)
}

#[tauri::command]
pub fn bible_reject_suggestion(db: State<'_, Database>, bible_doc_id: String, suggestion_id: String) -> Result<(), String> {
    db.bible_reject_suggestion(&bible_doc_id, &suggestion_id)
}

#[tauri::command]
pub async fn bible_extract_mentions(
    db: State<'_, Database>,
    llm: State<'_, sidecar::LlmManager>,
    doc_id: String,
    expected_content: String,
) -> Result<BibleMemoryUpdate, String> {
    extract_bible_memory(&db, &llm, &doc_id, &expected_content).await
}

#[tauri::command]
pub async fn bible_rebuild_memory(
    db: State<'_, Database>,
    llm: State<'_, sidecar::LlmManager>,
    project_id: String,
) -> Result<BibleMemoryRebuild, String> {
    let docs = db.bible_descendant_docs(&project_id)?;
    let mut processed = 0u64;
    let mut matched = 0u64;
    let mut suggested = 0u64;
    let mut skipped = false;
    let mut retryable = false;
    for doc in docs {
        if !matches!(doc.kind.as_str(), "scene" | "chapter") {
            continue;
        }
        let update = extract_bible_memory(&db, &llm, &doc.id, &doc.content).await?;
        skipped |= update.skipped;
        retryable |= update.retryable;
        if !update.skipped {
            processed += 1;
            matched += update.matched;
            suggested += update.suggested;
        }
    }
    Ok(BibleMemoryRebuild { skipped, retryable, processed, matched, suggested })
}

#[tauri::command]
pub fn conversation_create(db: State<'_, Database>, doc_id: Option<String>, mode: Option<String>) -> Result<Conversation, String> {
    let mode = mode.filter(|m| !m.trim().is_empty()).unwrap_or_else(|| "chat".to_string());
    db.conversation_create(doc_id.as_deref(), &mode)
}

#[tauri::command]
pub fn conversation_list(db: State<'_, Database>) -> Result<Vec<Conversation>, String> {
    db.conversation_list()
}

#[tauri::command]
pub fn conversation_add_message(db: State<'_, Database>, conversation_id: String, role: String, content: String) -> Result<ChatMessage, String> {
    db.conversation_add_message(&conversation_id, &role, &content)
}

#[tauri::command]
pub fn conversation_get_messages(db: State<'_, Database>, conversation_id: String) -> Result<Vec<ChatMessage>, String> {
    db.conversation_get_messages(&conversation_id)
}

/// Default model slot: the shared Ollama-compatible endpoint + model.
/// ONE definition — ai_generate, ai_generate_stream, and ai_structurize
/// all resolve through here instead of repeating the fallback pair.
fn resolve_slot(provider: Option<String>, model: Option<String>) -> (String, String) {
    let endpoint = provider
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| "http://localhost:11434/v1".to_string());
    let model = model
        .filter(|m| !m.trim().is_empty())
        .unwrap_or_else(|| "llama3.2".to_string());
    (endpoint, model)
}

/// Friendly HTTP-status map shared by every chat-completions call.
fn friendly_http_status(status: u16) -> String {
    match status {
        401 | 403 => "API key rejected — check your provider settings".to_string(),
        429 => "Rate limited — wait a moment".to_string(),
        408 => "Request timed out — the model may be overloaded".to_string(),
        503 => "Model server overloaded — try again in a moment".to_string(),
        _ => format!("AI endpoint returned HTTP {}", status),
    }
}

fn authed_post(
    client: &reqwest::Client,
    endpoint: &str,
    body: &serde_json::Value,
    api_key: &Option<String>,
) -> reqwest::RequestBuilder {
    let mut req_builder = client
        .post(format!("{}/chat/completions", endpoint))
        .header("Content-Type", "application/json")
        .json(body);
    if let Some(key) = api_key.as_ref().filter(|k| !k.is_empty()) {
        req_builder = req_builder.header("Authorization", format!("Bearer {}", key));
    }
    req_builder
}

/// ONE non-streaming chat-completions call shared by ai_generate and
/// ai_structurize: status-checked like the stream path, one retry with
/// backoff on 429/503 only, and NEVER an empty string on empty choices.
async fn post_chat_completions(
    endpoint: &str,
    model: &str,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
    api_key: &Option<String>,
    timeout_secs: u64,
) -> Result<(String, Option<u32>), String> {
    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": max_tokens,
        "stream": false,
    });
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
        .build()
        .map_err(|e| e.to_string())?;

    // One retry with backoff for 429/503 only; everything else fails fast.
    let mut attempts = 0;
    let resp = loop {
        attempts += 1;
        let resp = authed_post(&client, endpoint, &body, api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if (status == 429 || status == 503) && attempts < 2 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        if !resp.status().is_success() {
            return Err(friendly_http_status(status));
        }
        break resp;
    };

    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

    let content = data["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| "AI endpoint returned an empty response.".to_string())?;

    let tokens = data["usage"]["total_tokens"].as_u64().map(|v| v as u32);

    Ok((content, tokens))
}

#[tauri::command]
pub async fn ai_generate(request: AiGenerateRequest) -> Result<AiGenerateResponse, String> {
    let (endpoint, model) = resolve_slot(request.provider, request.model);

    let mut messages = Vec::new();
    if let Some(sys) = &request.system_prompt {
        messages.push(serde_json::json!({"role": "system", "content": sys}));
    }
    messages.push(serde_json::json!({"role": "user", "content": request.prompt}));

    let (content, tokens) = post_chat_completions(
        &endpoint,
        &model,
        messages,
        request.max_tokens.unwrap_or(2048),
        &request.api_key,
        90,
    )
    .await?;

    Ok(AiGenerateResponse { content, tokens_used: tokens })
}

/// Pull model ids out of an OpenAI-compatible `/models` payload.
/// Pure (no I/O) so it is unit-testable: missing/non-array `data`,
/// entries without an `id`, and anything past 20 all yield a clean list.
fn parse_models_list(data: &serde_json::Value) -> Vec<String> {
    let mut models: Vec<String> = data
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id")?.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    models.truncate(20);
    models
}

/// Probe an OpenAI-compatible `/models` endpoint (Settings → Test buttons).
/// Runs in Rust so the stored API key is attached as a Bearer header and
/// the webview CSP can't block non-allow-listed hosts. Best-effort: any
/// failure is an Err string, like the other AI commands.
#[tauri::command]
pub async fn provider_probe(endpoint: String, api_key: Option<String>) -> Result<ProviderProbeResponse, String> {
    let base = endpoint.trim_end_matches('/');
    if base.is_empty() {
        return Err("Provider endpoint is empty.".to_string());
    }
    // Scheme allowlist: the renderer supplies this URL, so file://, ftp://
    // and other exotic schemes are rejected before any request is built.
    // (Private-IP gating is intentionally absent: endpoints are the user's
    // own configured providers, including localhost sidecars.)
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Provider endpoint must be an http(s) URL.".to_string());
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.get(format!("{}/models", base));
    if let Some(key) = api_key.as_ref().filter(|k| !k.is_empty()) {
        req = req.header("Authorization", format!("Bearer {}", key));
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(friendly_http_status(resp.status().as_u16()));
    }
    let data: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    Ok(ProviderProbeResponse { models: parse_models_list(&data) })
}

#[cfg(test)]
mod provider_probe_tests {
    use super::*;

    #[test]
    fn parses_model_ids() {
        let data = serde_json::json!({ "data": [{ "id": "gpt-4o-mini" }, { "id": "org/llama3.2" }] });
        assert_eq!(parse_models_list(&data), vec!["gpt-4o-mini", "org/llama3.2"]);
    }

    #[test]
    fn skips_entries_without_ids() {
        let data = serde_json::json!({ "data": [{ "id": "kept" }, { "name": "no-id" }, { "id": 42 }] });
        assert_eq!(parse_models_list(&data), vec!["kept"]);
    }

    #[test]
    fn missing_or_misshapen_data_yields_empty() {
        assert!(parse_models_list(&serde_json::json!({})).is_empty());
        assert!(parse_models_list(&serde_json::json!({ "data": "nope" })).is_empty());
        assert!(parse_models_list(&serde_json::json!({ "data": [] })).is_empty());
    }

    #[test]
    fn truncates_past_twenty() {
        let ids: Vec<serde_json::Value> = (0..30).map(|i| serde_json::json!({ "id": format!("m-{i}") })).collect();
        let models = parse_models_list(&serde_json::json!({ "data": ids }));
        assert_eq!(models.len(), 20);
        assert_eq!(models[0], "m-0");
        assert_eq!(models[19], "m-19");
    }
}

#[cfg(test)]
mod sanitize_tests {
    use super::*;

    #[test]
    fn script_closer_neutralized_in_any_case() {
        assert_eq!(neutralize_closer("a</script>b", "script"), "a<\\/script>b");
        assert_eq!(neutralize_closer("a</SCRIPT>b", "script"), "a<\\/SCRIPT>b");
        assert_eq!(neutralize_closer("a</ScRiPt>b", "script"), "a<\\/ScRiPt>b");
        assert_eq!(neutralize_closer("a</style>b", "script"), "a</style>b");
    }

    #[test]
    fn closer_scan_survives_unicode_prefix() {
        assert_eq!(neutralize_closer("héllo wörld</sCrIpT>x", "script"), "héllo wörld<\\/sCrIpT>x");
        assert_eq!(neutralize_closer("plain text", "script"), "plain text");
        assert_eq!(neutralize_closer("a</sty", "style"), "a</sty");
    }

    #[test]
    fn style_closer_neutralized() {
        assert_eq!(sanitize_inline_css("a</STYLE>b"), "a<\\/STYLE>b");
    }
}

/// Streaming twin of `ai_generate` (spec §3.3 `ai.complete(stream)`).
/// Forwards OpenAI-compatible SSE `delta.content` chunks over the channel
/// as they arrive; the caller assembles and persists the full text.
#[tauri::command]
pub async fn ai_generate_stream(
    request: AiGenerateRequest,
    on_event: tauri::ipc::Channel<String>,
) -> Result<(), String> {
    let (endpoint, model) = resolve_slot(request.provider, request.model);

    let mut messages = Vec::new();
    if let Some(sys) = &request.system_prompt {
        messages.push(serde_json::json!({"role": "system", "content": sys}));
    }
    messages.push(serde_json::json!({"role": "user", "content": request.prompt}));

    let body = serde_json::json!({
        "model": model,
        "messages": messages,
        "max_tokens": request.max_tokens.unwrap_or(2048),
        "stream": true,
    });

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // One retry with backoff for 429/503 only; everything else fails fast.
    let mut attempts = 0;
    let mut resp = loop {
        attempts += 1;
        let resp = authed_post(&client, &endpoint, &body, &request.api_key)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        let status = resp.status().as_u16();
        if (status == 429 || status == 503) && attempts < 2 {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        }
        break resp;
    };

    if !resp.status().is_success() {
        return Err(friendly_http_status(resp.status().as_u16()));
    }

    // `chunk()` needs no extra stream traits; split SSE frames manually.
    let mut buf: Vec<u8> = Vec::new();
    while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
        buf.extend_from_slice(&chunk);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            let text = String::from_utf8_lossy(&line);
            let text = text.trim();
            let Some(payload) = text.strip_prefix("data:") else { continue };
            let payload = payload.trim();
            if payload.is_empty() || payload == "[DONE]" { continue; }
            let Ok(value) = serde_json::from_str::<serde_json::Value>(payload) else { continue };
            if let Some(token) = value["choices"][0]["delta"]["content"].as_str() {
                if !token.is_empty() {
                    on_event.send(token.to_string()).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    Ok(())
}

#[tauri::command]
pub async fn ai_structurize(request: StructurizeRequest) -> Result<StructurizeResponse, String> {
    let (endpoint, model) = resolve_slot(request.provider, request.model);

    let target_format = match request.workspace.as_str() {
        "novel" => "chapter outline, beat sheet, character sheets, scene cards, or bible facts",
        "script" => "Fountain structure, scene list, or dialogue pass",
        "projects" => "task breakdown with statuses, board columns, or milestone timeline",
        "logs" | "write" => "cleaned prose, headings, or re-tagged entries",
        _ => "tables, outlines, properties/frontmatter, or diagrams",
    };

    let system_prompt = format!(
        r#"You are a document structurizer. The user will provide text containing directives in {{braces}}.
Your job: follow those directives exactly and transform the text accordingly.

Rules:
1. Extract ALL {{...}} directives — they are instructions, not content.
2. Apply each directive to the text it wraps or references.
3. Output ONLY the transformed result — no explanations, no directives in output.
4. Supported directives:
   - {{make this a table with columns for ...}} — render as a markdown table
   - {{draw a timeline}} — render as a Mermaid timeline diagram
   - {{split into chapters, one per act}} — split on heading boundaries
   - {{expand each bullet to 2 paragraphs}} — expand list items into prose
   - {{outline}} — convert prose into a structured outline
   - {{summarize}} — condense to key points
   - {{reorder as ...}} — rearrange content per instruction
   - Any other natural-language directive — interpret and apply faithfully.

Target format for this workspace: {target_format}

Output the final transformed document. Use markdown where appropriate."#
    );

    let messages = vec![
        serde_json::json!({"role": "system", "content": system_prompt}),
        serde_json::json!({"role": "user", "content": request.text}),
    ];

    let (result, tokens) = post_chat_completions(
        &endpoint,
        &model,
        messages,
        4096,
        &request.api_key,
        180,
    )
    .await?;

    Ok(StructurizeResponse { result, tokens_used: tokens })
}

fn normalize_memory_key(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .flat_map(|c| c.to_lowercase())
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
}

fn normalize_memory_kind(value: &str) -> Option<&'static str> {
    match value.trim().to_lowercase().as_str() {
        "character" | "person" | "people" => Some("character"),
        "location" | "place" | "setting" => Some("location"),
        "object" | "item" | "thing" => Some("object"),
        _ => None,
    }
}

fn clean_model_quote(value: &str) -> String {
    value.trim().trim_matches(['"', '\'', '“', '”']).trim().to_string()
}

fn collapse_model_text(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn surface_for_key(text: &str, key: &str) -> Option<String> {
    let key = key.trim();
    if key.is_empty() { return None; }
    let exact = text.find(key).map(|start| (start, start + key.len()));
    let lower = text.to_lowercase().find(&key.to_lowercase()).map(|start| (start, start + key.len()));
    let (start, end) = exact.or(lower)?;
    if !text.is_char_boundary(start) || !text.is_char_boundary(end) { return None; }
    if text[..start].chars().last().is_some_and(|c| c.is_alphanumeric()) { return None; }
    if text[end..].chars().next().is_some_and(|c| c.is_alphanumeric()) { return None; }
    Some(text[start..end].to_string())
}

fn sentence_for_key(text: &str, key: &str) -> Option<String> {
    let lower_key = key.to_lowercase();
    text.split_inclusive(['.', '!', '?', '\n'])
        .map(str::trim)
        .find(|sentence| !sentence.is_empty() && sentence.to_lowercase().contains(&lower_key))
        .map(str::to_string)
}

fn infer_memory_trait(sentence: &str) -> Option<(String, String)> {
    let words = sentence.split_whitespace().collect::<Vec<_>>();
    let colors = ["blue", "green", "red", "black", "brown", "white", "gold", "silver", "gray", "grey"];
    for (index, word) in words.iter().enumerate() {
        let clean = word.trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
        if colors.contains(&clean.as_str()) {
            if index > 0 {
                let key = words[index - 1].trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
                if !key.is_empty() && !["a", "an", "the", "has", "have", "had", "is", "are", "was", "were", "wears", "wore"].contains(&key.as_str()) {
                    return Some((key, clean));
                }
            }
            if index + 1 < words.len() {
                let key = words[index + 1].trim_matches(|c: char| !c.is_alphanumeric()).to_lowercase();
                if !key.is_empty() { return Some((key, clean)); }
            }
        }
    }
    None
}

fn parse_memory_names(raw: &str, text: &str, facts: &[BibleFact]) -> Vec<BibleMentionCandidate> {
    let trimmed = raw.trim();
    let start = trimmed.find('[').or_else(|| trimmed.find('{'));
    let end = trimmed.rfind(']').or_else(|| trimmed.rfind('}'));
    let json = match (start, end) {
        (Some(start), Some(end)) if end >= start => &trimmed[start..=end],
        _ => trimmed,
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return Vec::new() };
    let entries = value.as_array().or_else(|| value.get("mentions").and_then(|v| v.as_array()));
    let Some(entries) = entries else { return Vec::new() };
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for item in entries {
        let raw_key = item.as_str().or_else(|| item.get("name").and_then(|v| v.as_str())).or_else(|| item.get("fact_key").and_then(|v| v.as_str())).unwrap_or_default();
        let Some(key) = surface_for_key(text, raw_key) else { continue };
        let normalized = normalize_memory_key(&key);
        let fact = facts.iter().find(|fact| normalize_memory_key(&fact.key) == normalized);
        let kind = fact.map(|fact| {
            let kind = fact.kind.to_lowercase();
            if kind.contains("location") || kind.contains("place") || kind.contains("setting") { "location" }
            else if kind.contains("object") || kind.contains("item") { "object" }
            else { "character" }
        }).unwrap_or_else(|| {
            let lower_key = key.to_lowercase();
            let lower_sentence = sentence_for_key(text, &key).unwrap_or_default().to_lowercase();
            if ["by the ", "at the ", "in the ", "near the ", "inside the "].iter().any(|prefix| lower_sentence.contains(&format!("{}{}", prefix, lower_key))) { "location" }
            else if key.chars().next().map(|c| c.is_uppercase()).unwrap_or(false) { "character" }
            else { "object" }
        });
        let Some(snippet) = sentence_for_key(text, &key) else { continue };
        let (attribute_key, attribute_value) = infer_memory_trait(&snippet).map(|(key, value)| (Some(key), Some(value))).unwrap_or((None, None));
        let signature = format!("{}|{}|{}|{}", kind, normalized, snippet, attribute_value.clone().unwrap_or_default());
        if seen.insert(signature) {
            candidates.push(BibleMentionCandidate { key, kind: kind.to_string(), snippet, attribute_key, attribute_value });
        }
    }
    candidates
}

fn parse_memory_candidates(raw: &str, text: &str) -> Option<Vec<BibleMentionCandidate>> {
    let trimmed = raw.trim();
    let start = trimmed.find('{').or_else(|| trimmed.find('['));
    let end = trimmed.rfind('}').or_else(|| trimmed.rfind(']'));
    let json = match (start, end) {
        (Some(start), Some(end)) if end >= start => &trimmed[start..=end],
        _ => trimmed,
    };
    let Ok(value) = serde_json::from_str::<serde_json::Value>(json) else { return None };
    let entries = value.get("mentions").and_then(|v| v.as_array())
        .or_else(|| value.as_array());
    let entries = entries?;
    let source = collapse_model_text(text);
    let mut seen = HashSet::new();
    let mut candidates = Vec::new();
    for item in entries {
        let raw_key = item.get("fact_key").or_else(|| item.get("key")).or_else(|| item.get("name"))
            .and_then(|v| v.as_str()).unwrap_or_default();
        let Some(key) = surface_for_key(text, raw_key) else { continue };
        let kind = item.get("kind").and_then(|v| v.as_str()).and_then(normalize_memory_kind);
        let model_snippet = clean_model_quote(
            item.get("snippet").or_else(|| item.get("quote"))
                .and_then(|v| v.as_str()).unwrap_or_default(),
        );
        let snippet = sentence_for_key(text, &key).unwrap_or(model_snippet);
        let Some(kind) = kind else { continue };
        if key.is_empty() || key.len() > 160 || snippet.is_empty() || snippet.len() > 1200 {
            continue;
        }
        if !source.contains(&collapse_model_text(&snippet)) {
            continue;
        }
        let attribute_key = item.get("attribute_key").or_else(|| item.get("trait_key"))
            .and_then(|v| v.as_str()).and_then(|v| (!v.trim().is_empty()).then(|| v.trim().to_string()));
        let attribute_value = item.get("attribute_value").or_else(|| item.get("trait_value"))
            .and_then(|v| v.as_str()).and_then(|v| (!v.trim().is_empty()).then(|| v.trim().to_string()));
        if attribute_key.is_some() != attribute_value.is_some() {
            continue;
        }
        if let (Some(attribute_key), Some(attribute_value)) = (&attribute_key, &attribute_value) {
            let sentence = snippet.to_lowercase();
            if !sentence.contains(&attribute_key.to_lowercase()) || !sentence.contains(&attribute_value.to_lowercase()) {
                continue;
            }
        }
        let signature = format!("{}|{}|{}|{}|{}", kind, key.to_lowercase(), snippet, attribute_key.clone().unwrap_or_default(), attribute_value.clone().unwrap_or_default());
        if seen.insert(signature) {
            candidates.push(BibleMentionCandidate { key, kind: kind.to_string(), snippet, attribute_key, attribute_value });
        }
    }
    Some(candidates)
}

async fn extract_bible_memory(
    db: &Database,
    llm: &sidecar::LlmManager,
    doc_id: &str,
    expected_content: &str,
) -> Result<BibleMemoryUpdate, String> {
    let doc = db.get_doc(doc_id)?;
    if !db.bible_source_allowed(doc_id)? || !matches!(doc.kind.as_str(), "scene" | "chapter") {
        return Ok(BibleMemoryUpdate { skipped: true, retryable: false, matched: 0, suggested: 0 });
    }
    if doc.content != expected_content {
        return Ok(BibleMemoryUpdate { skipped: true, retryable: false, matched: 0, suggested: 0 });
    }
    let scope_id = db.bible_scope_id(doc_id)?;
    if doc.content.trim().is_empty() {
        return db.bible_replace_scene_memory(&scope_id, doc_id, &doc.content, Some(expected_content), &[]);
    }
    let facts = db.bible_get_facts(&scope_id)?;
    let known_keys = facts.iter().map(|fact| format!("{} ({})", fact.key, fact.kind)).collect::<Vec<_>>().join(", ");
    let system_prompt = format!(
        "{}\nKnown Story Bible fact keys: {}",
        r#"You extract Story Bible evidence from manuscript text. Return ONLY valid JSON with this shape: {"mentions":[{"fact_key":"exact name","kind":"character|location|object","snippet":"one exact supporting sentence","attribute_key":"optional trait name","attribute_value":"optional trait value"}]}. Include every character, location, and object mentioned. Do not infer facts not stated. The snippet must be copied exactly from the text. Do not add commentary or markdown."#,
        if known_keys.is_empty() { "none".to_string() } else { known_keys }
    );
    let messages = vec![
        serde_json::json!({"role": "system", "content": system_prompt}),
        serde_json::json!({"role": "user", "content": doc.content}),
    ];
    let raw = match llm.chat_completion(messages, 768, 0.1).await {
        Ok(value) => value,
        Err(_) => return Ok(BibleMemoryUpdate { skipped: true, retryable: true, matched: 0, suggested: 0 }),
    };
    let mut candidates = parse_memory_candidates(&raw, &doc.content).unwrap_or_default();
    if candidates.is_empty() {
        let fallback_prompt = format!(
            "List every character, location, and object name in this text. Return only a JSON array of strings. Do not explain. Text: {}",
            doc.content
        );
        if let Ok(fallback_raw) = llm.chat_completion(vec![serde_json::json!({"role": "user", "content": fallback_prompt})], 256, 0.0).await {
            for candidate in parse_memory_names(&fallback_raw, &doc.content, &facts) {
                let signature = format!("{}|{}|{}", candidate.key, candidate.snippet, candidate.attribute_value.clone().unwrap_or_default());
                if !candidates.iter().any(|item| format!("{}|{}|{}", item.key, item.snippet, item.attribute_value.clone().unwrap_or_default()) == signature) {
                    candidates.push(candidate);
                }
            }
        }
    }
    if candidates.is_empty() {
        return Ok(BibleMemoryUpdate { skipped: true, retryable: false, matched: 0, suggested: 0 });
    }
    db.bible_replace_scene_memory(&scope_id, doc_id, &doc.content, Some(expected_content), &candidates)
}

#[tauri::command]
pub fn memory_decay_activity(db: State<'_, Database>) -> Result<u64, String> {
    db.decay_activity_scores()
}

#[tauri::command]
pub fn memory_smart_tabs(db: State<'_, Database>, workspace: String) -> Result<Vec<Doc>, String> {
    db.get_smart_tabs(&workspace)
}

#[tauri::command]
pub fn memory_record_metric(db: State<'_, Database>, doc_id: String, metric_type: String, value: f64) -> Result<(), String> {
    db.record_craft_metric(&doc_id, &metric_type, value)
}

#[tauri::command]
pub fn memory_get_metrics(db: State<'_, Database>, doc_id: String) -> Result<Vec<(String, f64, String)>, String> {
    db.get_craft_metrics(&doc_id)
}

#[tauri::command]
pub fn craft_metrics_trend(db: State<'_, Database>, doc_id: String, metric_type: String) -> Result<Vec<(String, f64)>, String> {
    db.get_craft_metrics_trend(&doc_id, &metric_type)
}

#[tauri::command]
pub fn dashboard_recent_docs(db: State<'_, Database>, limit: i64) -> Result<Vec<(String, String, String)>, String> {
    db.dashboard_recent_docs(limit)
}

#[tauri::command]
pub fn dashboard_workspace_counts(db: State<'_, Database>) -> Result<Vec<(String, i64)>, String> {
    db.dashboard_workspace_counts()
}

#[tauri::command]
pub fn dashboard_writing_days(db: State<'_, Database>) -> Result<Vec<String>, String> {
    db.dashboard_writing_days()
}

#[tauri::command]
pub fn dashboard_patterns(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.dashboard_patterns()
}

#[tauri::command]
pub fn dashboard_goals(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let rows = db.dashboard_goals()?;
    Ok(serde_json::Value::Array(rows.into_iter().map(|(id, title, workspace, goal_words, word_count, deadline)| {
        serde_json::json!({
            "id": id,
            "title": title,
            "workspace": workspace,
            "goal_words": goal_words,
            "word_count": word_count,
            "deadline": deadline
        })
    }).collect()))
}

#[tauri::command]
pub fn get_reopen_never_finish(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let rows = db.get_reopen_never_finish()?;
    Ok(serde_json::Value::Array(rows.into_iter().map(|(doc, open_count, last_opened)| {
        serde_json::json!({"doc": doc, "openCount": open_count, "lastOpened": last_opened})
    }).collect()))
}

#[tauri::command]
pub fn dashboard_streak_heatmap(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let rows = db.dashboard_streak_heatmap()?;
    Ok(serde_json::Value::Array(rows.into_iter().map(|(date, words)| {
        serde_json::json!({"date": date, "words": words})
    }).collect()))
}

#[tauri::command]
pub fn dashboard_writing_time_patterns(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let rows = db.dashboard_writing_time_patterns()?;
    Ok(serde_json::Value::Array(rows.into_iter().map(|(hour, count)| {
        serde_json::json!({"hour": hour, "count": count})
    }).collect()))
}

#[tauri::command]
pub fn dashboard_writing_velocity(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    let rows = db.dashboard_writing_velocity()?;
    Ok(serde_json::Value::Array(rows.into_iter().map(|(date, words)| {
        serde_json::json!({"date": date, "words": words})
    }).collect()))
}

#[tauri::command]
pub fn dashboard_productivity_score(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.dashboard_productivity_score()
}

fn script_frontmatter_array(doc_id: &str, db: &State<'_, Database>, key: &str) -> Result<serde_json::Value, String> {
    let fm = db.get_doc_frontmatter(doc_id)?;
    Ok(fm.get(key).cloned().unwrap_or(serde_json::Value::Array(vec![])))
}

fn script_frontmatter_set(doc_id: &str, db: &State<'_, Database>, key: &str, value: serde_json::Value) -> Result<(), String> {
    let mut fm = db.get_doc_frontmatter(doc_id)?;
    let obj = fm.as_object_mut().ok_or("Frontmatter is not an object")?;
    obj.insert(key.to_string(), value);
    db.set_doc_frontmatter(doc_id, &serde_json::to_string(&fm).map_err(|e| e.to_string())?)?;
    Ok(())
}

#[tauri::command]
pub fn script_character_list(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    script_frontmatter_array(&doc_id, &db, "characters")
}

#[tauri::command]
pub fn script_character_add(db: State<'_, Database>, doc_id: String, name: String) -> Result<serde_json::Value, String> {
    let mut list = script_frontmatter_array(&doc_id, &db, "characters")?;
    let arr = list.as_array_mut().ok_or("characters is not an array")?;
    arr.push(serde_json::Value::String(name));
    script_frontmatter_set(&doc_id, &db, "characters", serde_json::Value::Array(arr.clone()))?;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub fn script_location_list(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    script_frontmatter_array(&doc_id, &db, "locations")
}

#[tauri::command]
pub fn script_location_add(db: State<'_, Database>, doc_id: String, name: String) -> Result<serde_json::Value, String> {
    let mut list = script_frontmatter_array(&doc_id, &db, "locations")?;
    let arr = list.as_array_mut().ok_or("locations is not an array")?;
    arr.push(serde_json::Value::String(name));
    script_frontmatter_set(&doc_id, &db, "locations", serde_json::Value::Array(arr.clone()))?;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub fn script_timeline_get(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    script_frontmatter_array(&doc_id, &db, "timeline")
}

#[tauri::command]
pub fn script_timeline_add(db: State<'_, Database>, doc_id: String, event: String, date: String, act: i64) -> Result<serde_json::Value, String> {
    let mut list = script_frontmatter_array(&doc_id, &db, "timeline")?;
    let arr = list.as_array_mut().ok_or("timeline is not an array")?;
    arr.push(serde_json::json!({"event": event, "date": date, "act": act}));
    script_frontmatter_set(&doc_id, &db, "timeline", serde_json::Value::Array(arr.clone()))?;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub fn script_role_list(db: State<'_, Database>, doc_id: String) -> Result<serde_json::Value, String> {
    script_frontmatter_array(&doc_id, &db, "roles")
}

#[tauri::command]
pub fn script_role_assign(db: State<'_, Database>, doc_id: String, role_id: String, assigned_to: String) -> Result<serde_json::Value, String> {
    let mut list = script_frontmatter_array(&doc_id, &db, "roles")?;
    let arr = list.as_array_mut().ok_or("roles is not an array")?;
    let mut found = false;
    for role in arr.iter_mut() {
        if role.get("id").and_then(|v| v.as_str()) == Some(role_id.as_str()) {
            if let Some(obj) = role.as_object_mut() {
                obj.insert("assignedTo".to_string(), serde_json::Value::String(assigned_to.clone()));
                found = true;
            }
        }
    }
    if !found {
        return Err(format!("Role not found: {}", role_id));
    }
    script_frontmatter_set(&doc_id, &db, "roles", serde_json::Value::Array(arr.clone()))?;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub fn script_role_create(db: State<'_, Database>, doc_id: String, name: String, color: String, assigned_to: Option<String>) -> Result<serde_json::Value, String> {
    let mut list = script_frontmatter_array(&doc_id, &db, "roles")?;
    let arr = list.as_array_mut().ok_or("roles is not an array")?;
    let role = serde_json::json!({
        "id": format!("role-{}", chrono::Utc::now().timestamp_millis()),
        "name": name,
        "color": color,
        "assignedTo": assigned_to.unwrap_or_default(),
    });
    arr.push(role.clone());
    script_frontmatter_set(&doc_id, &db, "roles", serde_json::Value::Array(arr.clone()))?;
    Ok(serde_json::json!({"role": role}))
}

#[tauri::command]
pub fn script_role_delete(db: State<'_, Database>, doc_id: String, role_id: String) -> Result<serde_json::Value, String> {
    let mut list = script_frontmatter_array(&doc_id, &db, "roles")?;
    let arr = list.as_array_mut().ok_or("roles is not an array")?;
    arr.retain(|role| role.get("id").and_then(|v| v.as_str()) != Some(role_id.as_str()));
    script_frontmatter_set(&doc_id, &db, "roles", serde_json::Value::Array(arr.clone()))?;
    Ok(serde_json::json!({"success": true}))
}

#[tauri::command]
pub fn vault_rename_preview(db: State<'_, Database>, old_title: String) -> Result<Vec<(String, String, String)>, String> {
    db.vault_rename_preview(&old_title)
}

#[tauri::command]
pub fn vault_rename_execute(db: State<'_, Database>, old_title: String, new_title: String) -> Result<u64, String> {
    db.vault_rename_execute(&old_title, &new_title)
}

#[tauri::command]
pub fn atomic_save(db: State<'_, Database>, doc_id: String, body: String) -> Result<(), String> {
    db.atomic_save(&doc_id, &body)
}

#[tauri::command]
pub fn widget_atomic_save(db: State<'_, Database>, doc_id: String, body: String) -> Result<(), String> {
    widget_doc_unlocked(&db, &doc_id)?;
    db.atomic_save(&doc_id, &body)
}

#[tauri::command]
pub fn setup_file_watcher(db: State<'_, Database>, app: tauri::AppHandle) -> Result<(), String> {
    db.setup_file_watcher(app)
}

#[tauri::command]
pub fn memory_get_streak(db: State<'_, Database>) -> Result<(i64, i64), String> {
    db.get_writing_streak()
}

#[tauri::command]
pub fn doc_search_full(db: State<'_, Database>, query: String, workspace: Option<String>) -> Result<Vec<SearchResult>, String> {
    db.search_docs(&query, workspace.as_deref())
}

#[tauri::command]
pub fn search_docs_fts(db: State<'_, Database>, query: String, workspace: Option<String>) -> Result<Vec<SearchResult>, String> {
    db.search_docs_fts(&query, workspace.as_deref())
}

#[tauri::command]
pub fn reindex_fts(db: State<'_, Database>) -> Result<u64, String> {
    db.reindex_fts()
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
pub fn snapshot_create(db: State<'_, Database>, doc_id: String) -> Result<Snapshot, String> {
    db.snapshot_create(&doc_id)
}

#[tauri::command]
pub fn snapshot_list(db: State<'_, Database>, doc_id: String) -> Result<Vec<Snapshot>, String> {
    db.snapshot_list(&doc_id)
}

#[tauri::command]
pub fn snapshot_restore(db: State<'_, Database>, snapshot_id: String) -> Result<Doc, String> {
    db.snapshot_restore(&snapshot_id)
}

#[tauri::command]
pub fn snapshot_delete_old(db: State<'_, Database>, retention_days: i64) -> Result<u64, String> {
    // Retention window comes from Settings → Vaults; honored, not hardcoded.
    db.snapshot_retention_prune_all(retention_days)
}

#[tauri::command]
pub fn backup_create(db: State<'_, Database>) -> Result<String, String> {
    db.backup_create()
}

#[tauri::command]
pub fn backup_list(db: State<'_, Database>) -> Result<Vec<(String, String, u64)>, String> {
    db.backup_list()
}

#[tauri::command]
pub fn rag_chunk_document(db: State<'_, Database>, doc_id: String, chunk_size: Option<usize>, overlap: Option<usize>) -> Result<Vec<RagChunk>, String> {
    db.rag_chunk_document(&doc_id, chunk_size.unwrap_or(200), overlap.unwrap_or(50))
}

#[tauri::command]
pub fn rag_search(db: State<'_, Database>, query: String, limit: Option<usize>) -> Result<Vec<(RagChunk, f64)>, String> {
    db.rag_search(&query, limit.unwrap_or(10))
}

#[tauri::command]
pub fn rag_get_context(db: State<'_, Database>, doc_id: String, query: String, max_chunks: Option<usize>) -> Result<String, String> {
    db.rag_get_context(&doc_id, &query, max_chunks.unwrap_or(5))
}

#[tauri::command]
pub fn publish_static_site(db: State<'_, Database>, config: serde_json::Value) -> Result<serde_json::Value, String> {
    use pulldown_cmark::{html, Parser};

    let title = config.get("title").and_then(|v| v.as_str()).unwrap_or("My Writing");
    let description = config.get("description").and_then(|v| v.as_str()).unwrap_or("Published from Just Write");
    let theme = config.get("theme").and_then(|v| v.as_str()).unwrap_or("auto");
    let include_workspaces: Vec<String> = config.get("includeWorkspaces")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(|v| v.as_str().map(String::from)).collect())
        .unwrap_or(vec!["write".into(), "novel".into(), "projects".into()]);
    let include_drafts = config.get("includeDrafts").and_then(|v| v.as_bool()).unwrap_or(false);
    let toc_depth = config.get("tocDepth").and_then(|v| v.as_u64()).unwrap_or(3) as usize;
    let custom_css = config.get("customCss").and_then(|v| v.as_str()).unwrap_or("");
    let custom_js = config.get("customJs").and_then(|v| v.as_str()).unwrap_or("");

    // Fetch all docs from included workspaces
    let mut all_docs = Vec::new();
    for ws in &include_workspaces {
        let mut docs = db.list_docs_by_workspace(ws)?;
        if !include_drafts {
            docs.retain(|d| d.status != "draft");
        }
        // Locked docs never publish: titles stay out of the bundle.
        docs.retain(|d| !d.locked);
        all_docs.extend(docs);
    }

    // Generate HTML for each workspace
    let mut html_parts = Vec::new();
    let mut files = Vec::new();
    let mut images_inlined: u64 = 0;
    let mut images_skipped: u64 = 0;

    for ws in &include_workspaces {
        let ws_docs: Vec<_> = all_docs.iter().filter(|d| d.workspace == *ws).collect();
        if ws_docs.is_empty() { continue; }
        
        html_parts.push(format!("<section id=\"{}\"><h2>{}</h2>", html_escape(ws), html_escape(ws)));
        
        for doc in ws_docs {
            let content = doc.content.as_str();

            // Process transclusions
            let processed = process_transclusions(content, &db)?;
            let (processed, inlined, skipped) = inline_attachments(&processed, &db);
            images_inlined += inlined;
            images_skipped += skipped;

            // Build TOC
            let toc = build_toc(&processed, toc_depth);

            // Convert markdown to HTML, then sanitize: pulldown-cmark
            // passes raw inline HTML (script/img-onerror) straight through.
            let parser = Parser::new(&processed);
            let mut body_raw = String::new();
            html::push_html(&mut body_raw, parser);
            let body = sanitize_body(&body_raw);

            html_parts.push(format!("<article><h1 id=\"{}\">{}{}</h1>{}</article>",
                html_escape(&doc.id),
                html_escape(&doc.title),
                toc,
                body
            ));
        }
        
        html_parts.push("</section>".to_string());
    }

    // Generate full HTML (single-file scope: one index.html, images
    // inlined as data URIs — documented in docs/EXPORT.md).
    let body_html = html_parts.join("\n");
    let full_html = render_publish_html(title, description, theme, &include_workspaces, &body_html, custom_css, custom_js);
    files.push("index.html".to_string());

    Ok(serde_json::json!({
        "indexHtml": full_html,
        "imagesInlined": images_inlined,
        "imagesSkipped": images_skipped,
        "files": files
    }))
}

fn process_transclusions(content: &str, db: &crate::database::Database) -> Result<String, String> {
    let re = regex::Regex::new(r"!\[\[([^\]]+)\]\]").map_err(|e| format!("Invalid transclusion regex: {}", e))?;
    let mut result = content.to_string();
    for cap in re.captures_iter(content) {
        let target = &cap[1];
        if let Some(transcluded) = resolve_transclusion(target, db) {
            result = result.replace(&cap[0], &transcluded);
        }
    }
    Ok(result)
}

fn resolve_transclusion(target: &str, db: &crate::database::Database) -> Option<String> {
    let (title_part, heading) = target.split_once('#').unwrap_or((target, ""));
    let is_id = title_part.len() >= 20 && title_part.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    
    let doc = if is_id {
        db.get_doc(title_part).ok()
    } else {
        db.get_doc_by_title(title_part).ok().flatten()
    };

    let doc = doc?;
    if doc.locked { return None; }

    let mut text = doc.content;
    if !heading.is_empty() {
        let heading_regex = regex::Regex::new(&format!(r"(?im)^(#+)\s+{}\s*$", regex::escape(heading))).ok()?;
        let lines: Vec<&str> = text.lines().collect();
        let mut start_idx = None;
        let mut heading_level = 0;
        for (i, line) in lines.iter().enumerate() {
            if let Some(m) = heading_regex.captures(line) {
                start_idx = Some(i);
                heading_level = m.get(1)?.as_str().len();
                break;
            }
        }
        let start = start_idx?;
        let mut end = lines.len();
        let end_re = regex::Regex::new(r"^(#+)\s+").ok()?;
        for (i, line) in lines.iter().enumerate().skip(start + 1) {
            if let Some(m) = end_re.captures(line) {
                if m.get(1)?.as_str().len() <= heading_level {
                    end = i;
                    break;
                }
            }
        }
        text = lines[start..end].join("\n");
    }
    Some(text)
}

fn build_toc(content: &str, max_depth: usize) -> String {
    // `{{`/`}}` emit literal braces so the regex gets `#{1,N}`.
    let re = match regex::Regex::new(&format!(r"(?m)^(#[{{1,{}}})\s+(.+)$", max_depth)) {
        Ok(re) => re,
        Err(_) => return String::new(),
    };
    let mut toc = String::new();
    toc.push_str("<div class=\"toc\"><strong>Contents</strong><ul>");
    for cap in re.captures_iter(content) {
        let level = cap[1].len();
        let text = &cap[2];
        let id = text.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>();
        toc.push_str(&format!("<li style=\"margin-left: {}rem\"><a href=\"#{}\">{}</a></li>", (level - 1) as f32 * 1.5, id, html_escape(text)));
    }
    toc.push_str("</ul></div>");
    toc
}

/// True entity escape for TEXT and double-quoted-attribute contexts
/// (titles, TOC entries, ids). Never a sanitizer: `A < B` must render
/// as text, not vanish. Raw markdown HTML bodies use `sanitize_body`.
fn html_escape(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#x27;")
}

/// Sanitizer for rendered-markdown HTML bodies: keeps formatting,
/// strips script/iframe/event-handlers. (ammonia, already a dep.)
fn sanitize_body(html: &str) -> String {
    ammonia::clean(html)
}

/// Inline `.attachments/` refs as data URIs (single-file publish scope).
/// Files over 2 MB are skipped and counted, never inlined silently.
/// Returns (rewritten_markdown, inlined_count, skipped_count).
fn inline_attachments(content: &str, db: &State<'_, Database>) -> (String, u64, u64) {
    let vault = match db.vault_path.lock().map(|v| v.clone()) {
        Ok(v) => v,
        Err(_) => return (content.to_string(), 0, 0),
    };
    let mut out = content.to_string();
    let mut inlined = 0u64;
    let mut skipped = 0u64;
    for r in crate::convert::attachment_refs(content) {
        let path = vault.join(&r);
        let mime = match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase().as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            // No "svg": inline SVG data URIs execute embedded scripts in
            // some view contexts, so SVGs stay linked and count as skipped.
            _ => {
                skipped += 1;
                continue;
            }
        };
        match std::fs::read(&path) {
            Ok(bytes) if bytes.len() <= 2 * 1024 * 1024 => {
                use base64::Engine as _;
                let uri = format!(
                    "data:{};base64,{}",
                    mime,
                    base64::engine::general_purpose::STANDARD.encode(&bytes)
                );
                out = out.replace(&r, &uri);
                inlined += 1;
            }
            _ => {
                skipped += 1;
            }
        }
    }
    (out, inlined, skipped)
}

/// Sanitize user-supplied inline CSS: neutralize `</style` breakouts.
/// Anything else passes through (it runs inside a <style> block).
fn sanitize_inline_css(css: &str) -> String {
    neutralize_closer(css, "style")
}

/// Sanitize user-supplied inline JS: neutralize `</script` breakouts so
/// customJs can never escape its own script element.
fn sanitize_inline_js(js: &str) -> String {
    neutralize_closer(js, "script")
}

/// Neutralize an HTML element closer (`</script`, `</style`) with ASCII
/// case-insensitive matching: HTML closes elements regardless of case, so
/// replacing only lowercase/uppercase misses `</ScRiPt>`. Byte-scans so
/// non-ASCII text before the match can't shift indices; the tag itself is
/// copied back with its original case.
fn neutralize_closer(src: &str, tag: &str) -> String {
    let bytes = src.as_bytes();
    let tag_bytes = tag.as_bytes();
    let mut out = String::with_capacity(src.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'<'
            && i + 2 + tag_bytes.len() <= bytes.len()
            && bytes[i + 1] == b'/'
            && bytes[i + 2..i + 2 + tag_bytes.len()].eq_ignore_ascii_case(tag_bytes)
        {
            out.push_str("<\\/");
            out.push_str(&src[i + 2..i + 2 + tag_bytes.len()]);
            i += 2 + tag_bytes.len();
        } else {
            let ch = src[i..].chars().next().unwrap_or('\u{FFFD}');
            out.push(ch);
            i += ch.len_utf8().max(1);
        }
    }
    out
}

fn render_publish_html(
    title: &str,
    description: &str,
    theme: &str,
    nav_workspaces: &[String],
    body: &str,
    custom_css: &str,
    custom_js: &str,
) -> String {
    let custom_css = sanitize_inline_css(custom_css);
    let custom_js = sanitize_inline_js(custom_js);
    let custom_css_block = if custom_css.trim().is_empty() {
        String::new()
    } else {
        format!("\n    /* site custom CSS */\n    {}", custom_css)
    };
    let custom_js_block = if custom_js.trim().is_empty() {
        String::new()
    } else {
        format!("\n  <script>\n  // site custom JS (breakouts neutralized)\n  {}\n  </script>", custom_js)
    };
    format!(r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>{0}</title>
  <meta name="description" content="{1}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&family=Merriweather:ital,wght@0,400;0,700;1,400&display=swap" rel="stylesheet">
  <style>
    :root {{
      --font-body: 'Merriweather', Georgia, serif;
      --font-mono: 'JetBrains Mono', monospace;
      --font-heading: 'Merriweather', Georgia, serif;
      --color-bg: #fafafa;
      --color-text: #1a1a2e;
      --color-muted: #6b6b80;
      --color-primary: #2d6cdf;
      --color-border: #e0e0e8;
      --max-width: 720px;
      --space-1: 4px; --space-2: 8px; --space-3: 16px; --space-4: 24px; --space-5: 32px;
      --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
    }}
    @media (prefers-color-scheme: dark) {{
      :root {{
        --color-bg: #1a1a2e;
        --color-text: #e8e8f0;
        --color-muted: #8b8ba8;
        --color-primary: #7aa2f7;
        --color-border: #2d2d44;
      }}
    }}
    [data-theme="dark"] {{
      --color-bg: #1a1a2e;
      --color-text: #e8e8f0;
      --color-muted: #8b8ba8;
      --color-primary: #7aa2f7;
      --color-border: #2d2d44;
    }}
    [data-theme="light"] {{
      --color-bg: #fafafa;
      --color-text: #1a1a2e;
      --color-muted: #6b6b80;
      --color-primary: #2d6cdf;
      --color-border: #e0e0e8;
    }}
    * {{ box-sizing: border-box; }}
    body {{
      font-family: var(--font-body);
      background: var(--color-bg);
      color: var(--color-text);
      line-height: 1.8;
      max-width: var(--max-width);
      margin: 0 auto;
      padding: var(--space-5) var(--space-3);
      font-size: 18px;
    }}
    header {{ margin-bottom: var(--space-5); padding-bottom: var(--space-4); border-bottom: 1px solid var(--color-border); }}
    header h1 {{ font-size: 2.5rem; margin: 0 0 var(--space-2); font-weight: 700; }}
    header .meta {{ color: var(--color-muted); font-size: 0.95rem; }}
    nav {{ margin-bottom: var(--space-5); padding: var(--space-3); background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); }}
    nav ul {{ list-style: none; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: var(--space-2); }}
    nav a {{ color: var(--color-primary); text-decoration: none; padding: var(--space-1) var(--space-2); border-radius: var(--radius-sm); }}
    nav a:hover {{ background: var(--color-border); }}
    article {{ padding-top: var(--space-4); }}
    h1, h2, h3, h4 {{ font-family: var(--font-heading); color: var(--color-text); margin-top: var(--space-5); margin-bottom: var(--space-3); line-height: 1.3; }}
    h1 {{ font-size: 2rem; }} h2 {{ font-size: 1.6rem; }} h3 {{ font-size: 1.3rem; }} h4 {{ font-size: 1.1rem; }}
    p {{ margin: var(--space-3) 0; }}
    code {{ font-family: var(--font-mono); background: var(--color-border); padding: 2px 6px; border-radius: var(--radius-sm); font-size: 0.9em; }}
    pre {{ background: #1e1e2e; color: #e8e8f0; padding: var(--space-3); border-radius: var(--radius-md); overflow-x: auto; font-size: 0.9rem; line-height: 1.6; }}
    pre code {{ background: none; padding: 0; font-size: inherit; }}
    blockquote {{ border-left: 3px solid var(--color-primary); padding-left: var(--space-3); margin: var(--space-3) 0; color: var(--color-muted); font-style: italic; }}
    a {{ color: var(--color-primary); }}
    a:hover {{ text-decoration: underline; }}
    img {{ max-width: 100%; height: auto; border-radius: var(--radius-md); }}
    hr {{ border: none; border-top: 1px solid var(--color-border); margin: var(--space-5) 0; }}
    footer {{ margin-top: var(--space-5); padding-top: var(--space-4); border-top: 1px solid var(--color-border); color: var(--color-muted); font-size: 0.85rem; text-align: center; }}
    .toc {{ background: var(--color-bg); border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-4); }}
    .toc ul {{ list-style: none; padding-left: var(--space-3); }}
    .toc li {{ margin: var(--space-1) 0; }}
    .toc a {{ text-decoration: none; color: var(--color-text); }}
    .toc a:hover {{ color: var(--color-primary); }}
    @media (max-width: 600px) {{ body {{ font-size: 16px; padding: var(--space-3); }} header h1 {{ font-size: 1.8rem; }} }}{6}
  </style>{7}
</head>
<body data-theme="{2}">
  <header>
    <h1>{0}</h1>
    <div class="meta">{1}</div>
  </header>
  <nav><ul>{3}</ul></nav>
  <article>{4}</article>
  <footer>Published from Just Write · {5}</footer>
  <script>
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    const saved = localStorage.getItem('theme');
    if (saved) document.body.dataset.theme = saved;
    else if (prefersDark) document.body.dataset.theme = 'dark';
  </script>
</body>
</html>"#, 
        html_escape(title),
        html_escape(description),
        html_escape(theme),
        nav_workspaces.iter().map(|w| format!("<li><a href=\"#{}\">{}</a></li>", html_escape(w), html_escape(w))).collect::<Vec<_>>().join(""),
        body,
        chrono::Utc::now().format("%B %d, %Y"),
        custom_css_block,
        custom_js_block,
    )
}

#[tauri::command]
pub fn perf_benchmark(db: State<'_, Database>) -> Result<serde_json::Value, String> {
    db.perf_benchmark()
}

/// Resolve a renderer-supplied path inside the vault, fail closed.
/// Symlinks are resolved (`canonicalize`) so a link pointing outside the
/// vault is refused; not-yet-existing paths resolve via the nearest
/// existing ancestor with `..`/absolute segments in the remainder rejected.
fn confine_to_vault(db: &State<'_, Database>, raw: &str) -> Result<std::path::PathBuf, String> {
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?.clone();
    confine_path_in(&vault, raw)
}

fn confine_path_in(vault: &std::path::Path, raw: &str) -> Result<std::path::PathBuf, String> {
    use std::ffi::OsStr;
    if raw.trim().is_empty() {
        return Err("Empty path.".into());
    }
    let base = vault
        .canonicalize()
        .map_err(|_| "Vault is unavailable.".to_string())?;
    let mut current = std::path::Path::new(raw);
    let mut tail: Vec<&OsStr> = Vec::new();
    loop {
        if current.exists() {
            break;
        }
        match (current.file_name(), current.parent()) {
            (Some(name), Some(parent)) if !parent.as_os_str().is_empty() => {
                tail.push(name);
                current = parent;
            }
            _ => return Err("Path does not resolve inside the vault.".into()),
        }
    }
    let mut resolved = current
        .canonicalize()
        .map_err(|e| e.to_string())?;
    for part in tail.iter().rev() {
        let text = part.to_string_lossy();
        if text.is_empty()
            || text == "."
            || text == ".."
            || text.contains('/')
            || text.contains('\\')
        {
            return Err("Refusing path outside the vault.".into());
        }
        resolved.push(part);
    }
    if !resolved.starts_with(&base) {
        return Err("Refusing path outside the vault.".into());
    }
    Ok(resolved)
}

/// A bare file/dir name (no separators, no parent escapes) for rename targets.
fn check_single_name(name: &str) -> Result<(), String> {
    if name.trim().is_empty()
        || name.contains('/')
        || name.contains('\\')
        || name == "."
        || name == ".."
    {
        return Err("Invalid name.".into());
    }
    Ok(())
}

#[tauri::command]
pub fn fs_list_dir(db: State<'_, Database>, path: String) -> Result<Vec<(String, bool, u64)>, String> {
    let dir = confine_to_vault(&db, &path)?;
    if !dir.is_dir() {
        return Err(format!("Not a directory: {}", path));
    }

    let mut entries: Vec<(String, bool, u64)> = Vec::new();
    for entry in std::fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let metadata = entry.metadata().map_err(|e| e.to_string())?;
        let name = entry.file_name().to_string_lossy().to_string();
        entries.push((name, metadata.is_dir(), metadata.len()));
    }

    entries.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(entries)
}

#[tauri::command]
pub fn fs_read_file(db: State<'_, Database>, path: String) -> Result<String, String> {
    let file = confine_to_vault(&db, &path)?;
    std::fs::read_to_string(&file).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_rename(db: State<'_, Database>, old_path: String, new_name: String) -> Result<String, String> {
    check_single_name(&new_name)?;
    let p = confine_to_vault(&db, &old_path)?;
    // `p` is already resolved inside the vault, so its parent is too, and
    // `new_name` carries no separators — the join cannot escape.
    let parent = p.parent().ok_or("No parent directory")?;
    let new_path = parent.join(&new_name);
    std::fs::rename(&p, &new_path).map_err(|e| e.to_string())?;
    Ok(new_path.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_delete(db: State<'_, Database>, path: String) -> Result<(), String> {
    let p = confine_to_vault(&db, &path)?;
    if p.is_dir() {
        std::fs::remove_dir_all(&p).map_err(|e| e.to_string())?;
    } else {
        std::fs::remove_file(&p).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn fs_move(db: State<'_, Database>, src: String, dest_dir: String) -> Result<String, String> {
    let src_path = confine_to_vault(&db, &src)?;
    let dest_base = confine_to_vault(&db, &dest_dir)?;
    if !dest_base.is_dir() {
        return Err(format!("Not a directory: {}", dest_dir));
    }
    let dest = dest_base.join(src_path.file_name().ok_or("No filename")?);
    std::fs::rename(&src_path, &dest).map_err(|e| e.to_string())?;
    Ok(dest.to_string_lossy().to_string())
}

#[tauri::command]
pub fn fs_create_dir(db: State<'_, Database>, path: String) -> Result<(), String> {
    let dir = confine_to_vault(&db, &path)?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn fs_write_file(db: State<'_, Database>, path: String, contents: String) -> Result<(), String> {
    if contents.len() > 25 * 1024 * 1024 {
        return Err("File over 25 MB — link it instead of saving inline.".to_string());
    }
    let file = confine_to_vault(&db, &path)?;
    std::fs::write(&file, contents).map_err(|e| e.to_string())
}

/// Save a dropped/pasted attachment into `<vault>/.attachments/` (A8.9).
/// The frontend sends the original filename + base64 bytes; the backend
/// sanitizes the name, ensures the dir, writes atomically, and returns the
/// vault-relative ref (`.attachments/<name>`) to insert into the doc.
/// Absolute vault resolution lives here because only the backend knows the
/// real vault dir — the frontend must never guess it from settings.
#[tauri::command]
pub fn attachment_save(
    db: State<'_, Database>,
    filename: String,
    base64_data: String,
) -> Result<String, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(base64_data.trim())
        .map_err(|e| format!("Bad attachment encoding: {}", e))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Attachment over 25 MB — link the file instead.".to_string());
    }
    let stem = std::path::Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("file");
    let safe: String = stem
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() { "file".to_string() } else { safe };
    let unique = format!(
        "{}-{}",
        chrono::Utc::now().format("%Y%m%d%H%M%S"),
        safe
    );
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?.clone();
    let dir = vault.join(".attachments");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let dest = dir.join(&unique);
    // Unique temp per write: same-second same-name saves from concurrent
    // commands must never share (and clobber) one temp file.
    let temp = dest.with_extension(format!("tmp.{}", Uuid::new_v4()));
    std::fs::write(&temp, &bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&temp, &dest).map_err(|e| e.to_string())?;
    Ok(format!(".attachments/{}", unique))
}

/// Reveal a vault path in the OS file manager (selects the file where the
/// OS supports it). No extra crates: plain std::process per platform.
/// Mobile has no file-manager reveal — the frontend falls back to copy-path.
#[tauri::command]
pub fn fs_reveal(db: State<'_, Database>, path: String) -> Result<(), String> {
    let target = confine_to_vault(&db, &path)?;
    let display = target.to_string_lossy().into_owned();
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(format!("/select,{}", display))
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&display)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    {
        // Linux/Android: no select-in-manager; open the containing folder
        // (or the dir itself). Android WebViews have no desktop shell, so
        // this resolves to an error the UI turns into a copy-path fallback.
        let dir = if target.is_dir() {
            display
        } else {
            target
                .parent()
                .map(|p| p.to_string_lossy().to_string())
                .unwrap_or(display)
        };
        std::process::Command::new("xdg-open")
            .arg(&dir)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn clear_conversations(db: State<'_, Database>) -> Result<u64, String> {
    db.clear_conversations()
}

#[tauri::command]
pub fn clear_messages(db: State<'_, Database>) -> Result<u64, String> {
    db.clear_messages()
}

#[tauri::command]
pub fn clear_snapshots(db: State<'_, Database>) -> Result<u64, String> {
    db.clear_snapshots()
}

#[tauri::command]
pub fn clear_usage_events(db: State<'_, Database>) -> Result<u64, String> {
    db.clear_usage_events()
}

#[tauri::command]
pub fn clear_tab_states(db: State<'_, Database>) -> Result<u64, String> {
    db.clear_tab_states()
}

#[tauri::command]
pub fn get_workspace_context(db: State<'_, Database>, doc_id: String, workspace: String) -> Result<String, String> {
    db.get_workspace_context(&doc_id, &workspace)
}

#[tauri::command]
pub fn get_vault_path(db: State<'_, Database>) -> Result<String, String> {
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?;
    Ok(vault.to_string_lossy().to_string())
}

// ── STT: Moonshine Voice ─────────────────────────────────────────

fn trusted_sidecars_dir(sidecars_dir: &str) -> bool {
    let requested = std::path::Path::new(sidecars_dir);
    if requested.components().any(|component| {
        matches!(component, std::path::Component::ParentDir)
    }) {
        return false;
    }
    let candidate = if requested.is_absolute() {
        requested.to_path_buf()
    } else if requested == std::path::Path::new("src-tauri/sidecars") {
        std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join(requested)
    } else {
        return false;
    };
    let Ok(candidate) = std::fs::canonicalize(candidate) else { return false };
    let mut roots = vec![std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("sidecars")];
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            roots.push(parent.join("resources").join("sidecars"));
            roots.push(parent.join("sidecars"));
        }
    }
    roots.iter().any(|root| {
        std::fs::canonicalize(root)
            .map(|root| candidate.starts_with(root))
            .unwrap_or(false)
    })
}

fn require_sidecar_paths(sidecars_dir: &str) -> Result<(), String> {
    if sidecars_dir.trim().is_empty() {
        return Err("sidecars directory is empty — reinstall or re-fetch the sidecar bundle.".to_string());
    }
    if !trusted_sidecars_dir(sidecars_dir) {
        return Err("sidecar directory is outside the application resource root".to_string());
    }
    Ok(())
}

fn trusted_python_command(requested: &str) -> Result<String, String> {
    let command = requested.trim();
    let command = if command.is_empty() { "python" } else { command };
    let name = std::path::Path::new(command)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let allowed = matches!(name.as_str(), "python" | "python.exe" | "python3" | "python3.exe" | "py" | "py.exe");
    if command.contains('/') || command.contains('\\') || command.contains(':')
        || std::path::Path::new(command).components().count() != 1
        || !allowed
    {
        return Err("custom Python paths are disabled; use python, python3, or py from PATH".to_string());
    }
    Ok(command.to_string())
}

fn python_for_sidecar(requested: &str, sidecars_dir: &str, executable: &str) -> Result<String, String> {
    if sidecar::native_runtime_available(sidecars_dir, executable) {
        Ok("python".to_string())
    } else {
        trusted_python_command(requested)
    }
}

#[tauri::command]
pub fn stt_start(
    stt: State<'_, sidecar::SttManager>,
    python_path: String,
    sidecars_dir: String,
    model: Option<String>,
) -> Result<(), String> {
    require_sidecar_paths(&sidecars_dir)?;
    let python = python_for_sidecar(&python_path, &sidecars_dir, "stt-server.exe")?;
    stt.start(&python, &sidecars_dir, model.as_deref())
}

#[tauri::command]
pub fn stt_stop(stt: State<'_, sidecar::SttManager>) -> Result<(), String> {
    stt.stop()
}

#[tauri::command]
pub fn stt_is_running(stt: State<'_, sidecar::SttManager>) -> bool {
    stt.is_running()
}

#[tauri::command]
pub async fn stt_health(stt: State<'_, sidecar::SttManager>) -> Result<sidecar::SttHealth, String> {
    stt.health().await
}

#[tauri::command]
pub fn stt_port(stt: State<'_, sidecar::SttManager>) -> u16 {
    stt.port()
}

#[tauri::command]
pub async fn stt_transcribe(
    stt: State<'_, sidecar::SttManager>,
    audio: String,
    format: String,
) -> Result<String, String> {
    stt.transcribe(&audio, &format).await
}

#[tauri::command]
pub async fn stt_stream_start(stt: State<'_, sidecar::SttManager>) -> Result<(), String> {
    stt.stream_start().await
}

#[tauri::command]
pub async fn stt_stream_chunk(
    stt: State<'_, sidecar::SttManager>,
    audio: String,
    format: String,
) -> Result<(), String> {
    stt.stream_chunk(&audio, &format).await
}

#[tauri::command]
pub async fn stt_stream_stop(stt: State<'_, sidecar::SttManager>) -> Result<String, String> {
    stt.stream_stop().await
}

// ── TTS: Kokoro-82M ──────────────────────────────────────────────

#[tauri::command]
pub fn tts_start(
    tts: State<'_, sidecar::TtsManager>,
    python_path: String,
    sidecars_dir: String,
    model: Option<String>,
) -> Result<(), String> {
    require_sidecar_paths(&sidecars_dir)?;
    let python = python_for_sidecar(&python_path, &sidecars_dir, "tts-server.exe")?;
    tts.start(&python, &sidecars_dir, model.as_deref())
}

/// Probe a python interpreter (`python --version`). Used by the Settings
/// voice section on blur so a missing/broken python shows an inline
/// error instead of failing later at sidecar start.
fn run_python_probe(python: &str) -> Result<String, String> {
    let mut child = std::process::Command::new(python)
        .arg("--version")
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("Python not found — STT/TTS/memory need it ({}); app features besides sidecars still work.", e))?;
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("Python probe timed out — use a responsive python command from PATH".to_string());
            }
            Err(error) => return Err(format!("Python probe failed: {}", error)),
        }
    };
    let mut stdout = Vec::new();
    let mut stderr = Vec::new();
    if let Some(mut pipe) = child.stdout.take() {
        let _ = pipe.read_to_end(&mut stdout);
    }
    if let Some(mut pipe) = child.stderr.take() {
        let _ = pipe.read_to_end(&mut stderr);
    }
    if !status.success() {
        return Err(format!(
            "Python probe failed — STT/TTS/memory need a working python; app features besides sidecars still work. ({})",
            String::from_utf8_lossy(&stderr).trim()
        ));
    }
    Ok(format!(
        "{}{}",
        String::from_utf8_lossy(&stdout),
        String::from_utf8_lossy(&stderr)
    ).trim().to_string())
}

#[tauri::command]
pub fn sidecar_python_probe(python_path: String) -> Result<String, String> {
    let python = trusted_python_command(&python_path)?;
    run_python_probe(&python)
}

#[tauri::command]
pub fn tts_stop(tts: State<'_, sidecar::TtsManager>) -> Result<(), String> {
    tts.stop()
}

#[tauri::command]
pub fn tts_is_running(tts: State<'_, sidecar::TtsManager>) -> bool {
    tts.is_running()
}

#[tauri::command]
pub async fn tts_health(tts: State<'_, sidecar::TtsManager>) -> Result<sidecar::TtsHealth, String> {
    tts.health().await
}

#[tauri::command]
pub fn tts_port(tts: State<'_, sidecar::TtsManager>) -> u16 {
    tts.port()
}

#[tauri::command]
pub async fn tts_synthesize(
    tts: State<'_, sidecar::TtsManager>,
    text: String,
    voice: String,
    speed: f64,
    lang_code: String,
    split_pattern: String,
    chunk_size: u32,
) -> Result<(String, u32), String> {
    tts.synthesize(&text, &voice, speed, &lang_code, &split_pattern, chunk_size).await
}

#[tauri::command]
pub async fn tts_stop_playback(tts: State<'_, sidecar::TtsManager>) -> Result<(), String> {
    tts.stop_playback().await
}

// ── LLM: llama.cpp server (LFM 2.5-350M) ─────────────────────────────

#[tauri::command]
pub fn llm_start(
    llm: State<'_, sidecar::LlmManager>,
    sidecars_dir: String,
    model: Option<String>,
    ctx_size: Option<u32>,
) -> Result<(), String> {
    require_sidecar_paths(&sidecars_dir)?;
    llm.start(&sidecars_dir, model.as_deref(), ctx_size)
}

#[tauri::command]
pub fn llm_stop(llm: State<'_, sidecar::LlmManager>) -> Result<(), String> {
    llm.stop()
}

#[tauri::command]
pub fn llm_is_running(llm: State<'_, sidecar::LlmManager>) -> bool {
    llm.is_running()
}

#[tauri::command]
pub async fn llm_health(llm: State<'_, sidecar::LlmManager>) -> Result<sidecar::LlmHealth, String> {
    llm.health().await
}

#[tauri::command]
pub fn llm_port(llm: State<'_, sidecar::LlmManager>) -> u16 {
    llm.port()
}

#[tauri::command]
pub async fn llm_completion(
    llm: State<'_, sidecar::LlmManager>,
    prompt: String,
    max_tokens: u32,
    temperature: f32,
) -> Result<String, String> {
    llm.completion(&prompt, max_tokens, temperature).await
}

#[tauri::command]
pub async fn llm_chat_completion(
    llm: State<'_, sidecar::LlmManager>,
    messages: Vec<serde_json::Value>,
    max_tokens: u32,
    temperature: f32,
) -> Result<String, String> {
    llm.chat_completion(messages, max_tokens, temperature).await
}

/// Title → raw markdown lookup for export preprocessing (embeds and
/// wikilink targets). Locked/missing docs resolve to None so the
/// preprocessors emit notes instead of leaking or failing.
fn export_lookup<'a>(db: &'a State<'a, Database>) -> impl Fn(&str) -> Option<String> + 'a {
    move |title: &str| {
        let doc = db.get_doc_by_title(title).ok().flatten()?;
        if doc.locked {
            return None;
        }
        Some(doc.content.clone())
    }
}

/// Convert one doc's current content into md/txt/html (built in) or
/// docx/epub/pdf (pandoc). Content runs through the shared export
/// preprocess (embeds, wikilinks, frontmatter, attachments) first.
/// Returns filename + mime + base64 for download.
#[tauri::command]
pub fn convert_run(
    db: State<'_, Database>,
    app: tauri::AppHandle,
    doc_id: String,
    out_fmt: String,
) -> Result<crate::convert::ConvertOutput, String> {
    let doc = db.get_doc(&doc_id)?;
    let lookup = export_lookup(&db);
    let prepared = crate::convert::prepare_export(&doc.title, &doc.content, doc.frontmatter_json.as_deref(), &lookup);
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())
        .ok();
    let pandoc = crate::convert::find_pandoc(resource_dir);
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?;
    crate::convert::convert_markdown(&doc.title, &prepared, &out_fmt, pandoc, Some(&vault))
}

/// Compile an explicitly ordered set of docs into one manuscript file
/// (spec Amendment 5: `compile.run`). Order = the given id sequence
/// (caller-owned: board order). Each doc gets an H1 title with its
/// content demoted a level, so titles can never collide with content.
#[tauri::command]
pub fn compile_run(
    db: State<'_, Database>,
    app: tauri::AppHandle,
    doc_ids: Vec<String>,
    out_fmt: String,
    title: Option<String>,
) -> Result<crate::convert::ConvertOutput, String> {
    if doc_ids.is_empty() {
        return Err("Nothing to compile: no documents selected.".into());
    }
    let lookup = export_lookup(&db);
    let mut prepared = Vec::with_capacity(doc_ids.len());
    let mut authors: Vec<String> = Vec::new();
    for id in &doc_ids {
        let doc = db.get_doc(id)?;
        // Per-doc author/date ride into ONE manuscript-level YAML header
        // below (mid-document YAML blocks would render as <hr/> noise —
        // only the leading block is metadata; bodies stay bare here).
        let fm = crate::convert::parse_frontmatter(doc.frontmatter_json.as_deref());
        if let Some(a) = fm.author {
            let a = a.trim().to_string();
            if !a.is_empty() && !authors.contains(&a) {
                authors.push(a);
            }
        }
        prepared.push((
            doc.title.clone(),
            crate::convert::prepare_export_body(&doc.content, &lookup),
        ));
    }
    let refs: Vec<(&str, &str)> = prepared.iter().map(|(t, c)| (t.as_str(), c.as_str())).collect();
    let manuscript = crate::convert::join_manuscript(&refs);
    if manuscript.len() > crate::convert::COMPILE_CHAR_CAP {
        return Err(format!(
            "Manuscript is {:.1} MB of source — past the compile cap. Export a zip of chapters instead (Export Open Tabs).",
            manuscript.len() as f64 / 1_000_000.0
        ));
    }
    let name = title.unwrap_or_else(|| "manuscript".into());
    // ONE leading YAML header for the whole manuscript (title + merged
    // authors). Per-section blocks would render as visible noise.
    let header = crate::convert::ExportFrontmatter {
        title: Some(name.clone()),
        author: if authors.is_empty() { None } else { Some(authors.join(", ")) },
        date: None,
        extra: Vec::new(),
    };
    let manuscript = crate::convert::inject_frontmatter(&manuscript, &header);
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())
        .ok();
    let pandoc = crate::convert::find_pandoc(resource_dir);
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?;
    crate::convert::convert_markdown(&name, &manuscript, &out_fmt, pandoc, Some(&vault))
}

/// Which export formats are available right now (pandoc present or not).
#[tauri::command]
pub fn convert_status(app: tauri::AppHandle) -> Result<crate::convert::ConvertStatus, String> {
    let resource_dir = app.path().resource_dir().map_err(|e| e.to_string()).ok();
    let pandoc = crate::convert::find_pandoc(resource_dir);
    let available = pandoc.is_some();
    Ok(crate::convert::ConvertStatus {
        formats: crate::convert::all_formats(available),
        pandoc: available,
        bundled: crate::convert::is_bundled(&pandoc),
    })
}

/// Binary-safe vault attachment read for export bundling (zip/publish).
/// Vault-relative `.attachments/` refs only; `..` fails closed. 25 MB cap
/// mirrors attachment_save. fs_read_file stays text-only by design.
#[tauri::command]
pub fn attachment_read(db: State<'_, Database>, path: String) -> Result<String, String> {
    if path.contains("..") {
        return Err("Refusing path escaping the vault.".into());
    }
    let rel = path.trim_start_matches(['/', '\\']);
    if !rel.starts_with(".attachments/") {
        return Err("Only .attachments/ refs can be bundled.".into());
    }
    // Canonicalize and re-check: a symlink inside .attachments/ pointing
    // outside the vault must not be followed.
    let vault = db.vault_path.lock().map_err(|e| e.to_string())?.clone();
    let vault_canon = vault.canonicalize().map_err(|_| "Vault is unavailable.".to_string())?;
    let target = vault_canon.join(rel).canonicalize().map_err(|e| format!("Attachment unreadable: {}", e))?;
    if !target.starts_with(&vault_canon) {
        return Err("Refusing path escaping the vault.".into());
    }
    let bytes = std::fs::read(&target).map_err(|e| format!("Attachment unreadable: {}", e))?;
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("Attachment over 25 MB — link the file instead.".into());
    }
    use base64::Engine as _;
    Ok(base64::engine::general_purpose::STANDARD.encode(&bytes))
}

/// Reports whether the Tauri updater is configured (endpoints + a real
/// pubkey in tauri.conf.json). The frontend uses this to show setup
/// guidance instead of a cryptic signature error.
#[tauri::command]
pub fn app_update_status(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let empty = serde_json::Map::new();
    let updater = app
        .config()
        .plugins
        .0
        .get("updater")
        .and_then(|v| v.as_object())
        .unwrap_or(&empty);
    let endpoints: Vec<String> = updater
        .get("endpoints")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|e| e.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let pubkey = updater
        .get("pubkey")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let configured = !endpoints.is_empty()
        && !pubkey.is_empty()
        && pubkey != "REPLACE_WITH_UPDATER_PUBLIC_KEY";
    Ok(serde_json::json!({
        "configured": configured,
        "endpoint": endpoints.first(),
    }))
}

// ── Ghosts (scene forking) ──────────────────────────────────────

#[tauri::command]
pub fn ghost_fork(db: State<'_, Database>, doc_id: String, label: Option<String>) -> Result<Doc, String> {
    db.ghost_fork(&doc_id, label.as_deref())
}

#[tauri::command]
pub fn ghost_list(db: State<'_, Database>, doc_id: String) -> Result<GhostGroup, String> {
    db.ghost_list(&doc_id)
}

#[tauri::command]
pub fn ghost_merge(db: State<'_, Database>, ghost_id: String, target_id: Option<String>) -> Result<Doc, String> {
    db.ghost_merge(&ghost_id, target_id.as_deref())
}

#[tauri::command]
pub fn ghost_dismiss(db: State<'_, Database>, ghost_id: String) -> Result<(), String> {
    db.ghost_dismiss(&ghost_id)
}

// ── Atlas (star-sky memory) ─────────────────────────────────────

#[tauri::command]
pub fn atlas_get_stars(db: State<'_, Database>) -> Result<Vec<AtlasStar>, String> {
    db.atlas_get_stars()
}

// ── OS keychain secrets (apiKey, appLockPin) ────────────────────

const KEYCHAIN_SERVICE: &str = "com.just-write-ehis.app";
const APP_LOCK_MIN_PIN_LENGTH: usize = 4;

const PIN_BASE_BACKOFF_MS: u64 = 2_000;
const PIN_MAX_BACKOFF_MS: u64 = 60_000;
const PIN_MAX_FAILED_ATTEMPTS: u32 = 5;

#[derive(Default)]
struct PinLockoutState {
    failures: u32,
    until: Option<Instant>,
}

#[derive(Default)]
pub struct PinLockout {
    state: Mutex<PinLockoutState>,
}

#[derive(Serialize)]
pub struct PinVerification {
    pub verified: bool,
    pub retry_after_ms: u64,
}

impl PinLockout {
    fn retry_after_ms(&self) -> u64 {
        let Ok(state) = self.state.lock() else { return 0 };
        state.until
            .and_then(|until| until.checked_duration_since(Instant::now()))
            .map(|remaining| remaining.as_millis() as u64)
            .unwrap_or(0)
    }

    fn record_failure(&self) -> u64 {
        let Ok(mut state) = self.state.lock() else { return PIN_MAX_BACKOFF_MS };
        state.failures = state.failures.saturating_add(1);
        if state.failures < PIN_MAX_FAILED_ATTEMPTS {
            return 0;
        }
        let exponent = state.failures - PIN_MAX_FAILED_ATTEMPTS;
        let delay = PIN_BASE_BACKOFF_MS.saturating_mul(2u64.saturating_pow(exponent.min(31)));
        let delay = delay.min(PIN_MAX_BACKOFF_MS);
        state.until = Some(Instant::now() + Duration::from_millis(delay));
        delay
    }

    fn reset(&self) {
        if let Ok(mut state) = self.state.lock() {
            state.failures = 0;
            state.until = None;
        }
    }
}

fn keychain_entry(key: &str) -> Result<keyring::Entry, String> {
    // Static error: never echo the caller-supplied key (log/forgery surface).
    if key != "apiKey" && key != "appLockPin" {
        return Err("unknown secret key".to_string());
    }
    // Static error: keyring internals (paths, backends) stay out of the UI.
    keyring::Entry::new(KEYCHAIN_SERVICE, key).map_err(|_| "keychain unavailable".to_string())
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    let entry = keychain_entry(&key)?;
    if key == "appLockPin" && !value.trim().is_empty() && value.trim().len() < APP_LOCK_MIN_PIN_LENGTH {
        return Err("app PIN must be at least 4 characters".to_string());
    }
    if value.is_empty() {
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err("keychain delete failed".to_string()),
        }
    } else {
        entry.set_password(&value).map_err(|_| "keychain write failed".to_string())
    }
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    let left = left.as_bytes();
    let right = right.as_bytes();
    if left.len() != right.len() {
        return false;
    }
    left.iter().zip(right).fold(0u8, |difference, (a, b)| difference | (a ^ b)) == 0
}

#[tauri::command]
pub fn app_lock_configured() -> Result<bool, String> {
    Ok(secret_get("appLockPin".to_string())?.is_some_and(|pin| pin.trim().len() >= APP_LOCK_MIN_PIN_LENGTH))
}

fn verify_pin_value(expected: &str, candidate: &str) -> bool {
    let expected = expected.trim();
    expected.len() >= APP_LOCK_MIN_PIN_LENGTH && constant_time_eq(expected, candidate.trim())
}

#[tauri::command]
pub fn app_lock_verify(lockout: State<'_, PinLockout>, pin: String) -> Result<PinVerification, String> {
    let retry_after_ms = lockout.retry_after_ms();
    if retry_after_ms > 0 {
        return Ok(PinVerification { verified: false, retry_after_ms });
    }
    let expected = secret_get("appLockPin".to_string())?.unwrap_or_default();
    if verify_pin_value(&expected, &pin) {
        lockout.reset();
        return Ok(PinVerification { verified: true, retry_after_ms: 0 });
    }
    let retry_after_ms = lockout.record_failure();
    Ok(PinVerification { verified: false, retry_after_ms })
}

#[tauri::command]
pub fn app_lock_reset(lockout: State<'_, PinLockout>) {
    lockout.reset();
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    let entry = keychain_entry(&key)?;
    match entry.get_password() {
        Ok(v) => Ok(Some(v)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("keychain read failed".to_string()),
    }
}

#[cfg(test)]
mod ai_slot_tests {
    use super::*;

    #[test]
    fn pin_lockout_tracks_retry_window() {
        let lockout = PinLockout::default();
        for _ in 0..5 {
            lockout.record_failure();
        }
        assert!(lockout.retry_after_ms() > 0);
        lockout.reset();
        assert_eq!(lockout.retry_after_ms(), 0);
    }

    #[test]
    fn pin_verification_rejects_empty_values() {
        assert!(!verify_pin_value("", ""));
        assert!(!verify_pin_value("   ", "   "));
        assert!(!verify_pin_value("123", "123"));
        assert!(verify_pin_value("2468", " 2468 "));
        assert!(!verify_pin_value("2468", "2467"));
    }

    #[test]
    fn python_command_allowlist_rejects_paths() {
        assert_eq!(trusted_python_command("python").unwrap(), "python");
        assert_eq!(trusted_python_command("py.exe").unwrap(), "py.exe");
        assert!(trusted_python_command("C:/Python312/python.exe").is_err());
        assert!(trusted_python_command("a/python").is_err());
        assert!(trusted_python_command("python -c").is_err());
    }

    #[test]
    fn resolve_slot_defaults() {
        let (e, m) = resolve_slot(None, None);
        assert_eq!(e, "http://localhost:11434/v1");
        assert_eq!(m, "llama3.2");
    }

    #[test]
    fn resolve_slot_blank_means_default() {
        let (e, m) = resolve_slot(Some("  ".to_string()), Some("".to_string()));
        assert_eq!(e, "http://localhost:11434/v1");
        assert_eq!(m, "llama3.2");
    }

    #[test]
    fn resolve_slot_keeps_explicit_values() {
        let (e, m) = resolve_slot(
            Some("http://127.0.0.1:8093/v1".to_string()),
            Some("lfm2.5-350m".to_string()),
        );
        assert_eq!(e, "http://127.0.0.1:8093/v1");
        assert_eq!(m, "lfm2.5-350m");
    }

    #[test]
    fn friendly_status_mapping() {
        assert!(friendly_http_status(401).contains("API key"));
        assert!(friendly_http_status(403).contains("API key"));
        assert!(friendly_http_status(429).contains("Rate limited"));
        assert!(friendly_http_status(408).contains("timed out"));
        assert!(friendly_http_status(500).contains("500"));
    }

    #[test]
    fn memory_parser_repairs_short_model_snippets() {
        let text = "Elena has blue eyes. Mara waited by the gate.";
        let candidates = parse_memory_candidates(
            r#"{"mentions":[{"fact_key":"Elena","kind":"character","snippet":"Elena","attribute_key":"eyes","attribute_value":"blue"},{"fact_key":"Mara","kind":"character","snippet":"Mara","attribute_key":null,"attribute_value":null}]}"#,
            text,
        ).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].snippet, "Elena has blue eyes.");
        assert_eq!(candidates[0].attribute_value.as_deref(), Some("blue"));
        assert_eq!(candidates[1].snippet, "Mara waited by the gate.");
    }

    #[test]
    fn memory_parser_rejects_malformed_output() {
        assert!(parse_memory_candidates("not json", "Elena waited.").is_none());
    }

    #[test]
    fn memory_parser_grounds_model_attributes_in_the_snippet() {
        let candidates = parse_memory_candidates(
            r#"{"mentions":[{"fact_key":"Elena","kind":"character","snippet":"Elena wore a coat.","attribute_key":"color","attribute_value":"blue"}]}"#,
            "Elena wore a coat.",
        ).unwrap();
        assert!(candidates.is_empty());
    }

    #[test]
    fn memory_name_fallback_infers_real_sentences_and_traits() {
        let facts = vec![BibleFact { id: "f".into(), doc_id: "b".into(), kind: "world_characters".into(), key: "Elena".into(), value: "protagonist".into() }];
        let candidates = parse_memory_names(r#"["Elena", "Mara"]"#, "Elena has blue eyes. Mara waited by the gate.", &facts);
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].snippet, "Elena has blue eyes.");
        assert_eq!(candidates[0].attribute_key.as_deref(), Some("eyes"));
        assert_eq!(candidates[1].snippet, "Mara waited by the gate.");
    }
}

use rusqlite::params as _tag_params;

#[tauri::command]
pub fn get_doc_tags(db: State<'_, Database>, doc_id: String) -> Result<Vec<String>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare("SELECT tag FROM doc_tags WHERE doc_id = ?1 ORDER BY tag")
        .map_err(|e| e.to_string())?;
    let rows = stmt.query_map([&doc_id], |row| row.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[tauri::command]
pub fn add_doc_tag(db: State<'_, Database>, doc_id: String, tag: String) -> Result<(), String> {
    let tag = tag.trim().to_lowercase();
    if tag.is_empty() {
        return Err("Tag cannot be empty".into());
    }
    if tag.chars().count() > 64 {
        return Err("Tag too long".into());
    }
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT OR IGNORE INTO doc_tags (doc_id, tag) VALUES (?1, ?2)",
        _tag_params![&doc_id, &tag],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn remove_doc_tag(db: State<'_, Database>, doc_id: String, tag: String) -> Result<(), String> {
    let tag = tag.trim().to_lowercase();
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    conn.execute(
        "DELETE FROM doc_tags WHERE doc_id = ?1 AND tag = ?2",
        _tag_params![&doc_id, &tag],
    ).map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn search_by_tag(db: State<'_, Database>, tag: String) -> Result<Vec<Doc>, String> {
    let conn = db.conn.lock().map_err(|e| e.to_string())?;
    let mut stmt = conn.prepare(
        "SELECT d.id, d.workspace, d.kind, d.title, d.path, d.parent_id, d.created_at, d.updated_at, d.content, d.word_count, d.reading_position, d.status, d.frontmatter_json, d.activity_score, d.embedding_ref, d.pinned, d.goal_words, d.deadline, d.locked FROM docs d INNER JOIN doc_tags dt ON dt.doc_id = d.id WHERE dt.tag = ?1 AND d.locked = 0 ORDER BY d.updated_at DESC"
    ).map_err(|e| e.to_string())?;
    let tag_lc = tag.trim().to_lowercase();
    let rows = stmt.query_map([&tag_lc], |row| {
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
    Ok(rows.filter_map(|r| r.ok()).collect())
}

#[cfg(test)]
mod fs_confinement_tests {
    use super::*;

    fn vault(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("jwe-confine-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("write")).unwrap();
        dir
    }

    #[test]
    fn inside_paths_resolve() {
        let base = vault("inside");
        let file = base.join("write").join("note.md");
        std::fs::write(&file, "hi").unwrap();
        assert_eq!(
            confine_path_in(&base, &file.to_string_lossy()).unwrap(),
            file.canonicalize().unwrap()
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn traversal_and_absolute_escapes_are_refused() {
        let base = vault("escape");
        for evil in [
            base.join("..").join("escaped.md").to_string_lossy().into_owned(),
            "/etc/hostname".to_string(),
            String::from(""),
            String::from("   "),
        ] {
            assert!(confine_path_in(&base, &evil).is_err(), "accepted {evil:?}");
        }
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn not_yet_existing_nested_paths_resolve_inside() {
        let base = vault("nested");
        let target = base.join("write").join("new").join("note.md");
        assert!(confine_path_in(&base, &target.to_string_lossy()).is_ok());
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn single_names_reject_separators() {
        for bad in ["a/b", "a\\b", "..", ".", "", "  "] {
            assert!(check_single_name(bad).is_err(), "accepted {bad:?}");
        }
        assert!(check_single_name("renamed.md").is_ok());
    }
}

