mod models;
mod database;
mod doc_store;
mod commands;
mod convert;
mod sidecar;

use rusqlite::Connection;
use tauri::Manager;
#[cfg(desktop)]
use tauri::{
    menu::{MenuBuilder, MenuItemBuilder},
    tray::TrayIconBuilder,
    Emitter,
};

pub fn run() {
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let app_dir = app.path().app_data_dir()
                .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;
            std::fs::create_dir_all(&app_dir)
                .map_err(|e| format!("Failed to create app data directory {:?}: {}", app_dir, e))?;

            let db_path = app_dir.join("writing.db");
            let conn = Connection::open(&db_path)
                .map_err(|e| format!("Failed to open database {:?}: {}", db_path, e))?;

            // Vault path: use ~/WritingVault as default
            let vault_path = dirs::home_dir()
                .unwrap_or_else(|| app_dir.clone())
                .join("WritingVault");
            std::fs::create_dir_all(&vault_path)
                .map_err(|e| format!("Failed to create vault directory {:?}: {}", vault_path, e))?;

            let db = database::Database::new(conn, vault_path);
            db.initialize()
                .map_err(|e| format!("Failed to initialize database schema: {}", e))?;

            app.manage(db);
            app.manage(sidecar::SidecarManager::new());
            app.manage(sidecar::SttManager::new(8090));
            app.manage(sidecar::TtsManager::new(8091));
            app.manage(sidecar::LlmManager::new(8093));
            let memory_dir = app_dir.join("ai-memory");
            std::fs::create_dir_all(&memory_dir)
                .map_err(|e| format!("Failed to create AI memory directory {:?}: {}", memory_dir, e))?;
            app.manage(sidecar::MemoryManager::new(8092, memory_dir.to_string_lossy().to_string()));

            // System-tray quick capture (§4.8): works app-closed on desktop.
            // Mobile has no tray — Android uses notification/widget/share
            // capture instead (separate platform work, not this block).
            #[cfg(desktop)]
            {
                let show = MenuItemBuilder::with_id("show", "Show Just Write ehis").build(app)?;
                let capture =
                    MenuItemBuilder::with_id("capture", "Quick capture to Inbox").build(app)?;
                let widget = MenuItemBuilder::with_id("widget", "Show / Hide Widget").build(app)?;
                let quit = MenuItemBuilder::with_id("quit", "Quit").build(app)?;
                let menu = MenuBuilder::new(app)
                    .items(&[&show, &capture, &widget, &quit])
                    .build()?;
                let mut tray = TrayIconBuilder::new()
                    .menu(&menu)
                    .tooltip("Just Write ehis — quick capture")
                    .on_menu_event(|app, event| match event.id().as_ref() {
                        "show" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = w.emit("main-window-shown", ());
                            }
                        }
                        "capture" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                                let _ = w.emit("tray-capture", ());
                            }
                        }
                        "widget" => {
                            if let Some(w) = app.get_webview_window("widget") {
                                match w.is_visible() {
                                    Ok(true) => match w.hide() {
                                        Ok(()) => {
                                            let _ = w.emit("widget-tray-visibility", false);
                                        }
                                        Err(e) => eprintln!("[tray] failed to hide widget: {}", e),
                                    },
                                    Ok(false) => match w.show() {
                                        Ok(()) => {
                                            let _ = w.emit("widget-tray-visibility", true);
                                            if let Err(e) = w.set_focus() {
                                                eprintln!("[tray] widget shown without focus: {}", e);
                                            }
                                        }
                                        Err(e) => eprintln!("[tray] failed to show widget: {}", e),
                                    },
                                    Err(e) => eprintln!("[tray] failed to read widget visibility: {}", e),
                                }
                            }
                        }
                        "quit" => app.exit(0),
                        _ => {}
                    });
                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                let _tray = tray.build(app)?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::doc_create,
            commands::doc_get,
            commands::doc_save,
            commands::doc_delete,
            commands::doc_toggle_pin,
            commands::doc_set_goal,
            commands::doc_move,
            commands::doc_search,
            commands::doc_list_by_workspace,
            commands::backlinks_get,
            commands::implicit_links_get,
            commands::usage_record,
            commands::tabs_get,
            commands::tabs_set,
            commands::log_get_or_create,
            commands::log_list_entries,
            commands::graph_query,
            commands::backlinks_extract,
            commands::unlinked_mentions,
            commands::entities_list,
            commands::entity_occurrences,
            commands::entities_backfill,
            commands::reader_update_position,
            commands::reader_set_shelf_status,
            commands::reader_set_rating,
            commands::reader_get_bookshelf,
            commands::reader_import_book,
            commands::novel_get_beat_board,
            commands::novel_compile,
            commands::bible_get_facts,
            commands::bible_upsert_fact,
            commands::bible_delete_fact,
            commands::conversation_create,
            commands::conversation_list,
            commands::conversation_add_message,
            commands::conversation_get_messages,
            commands::ai_generate,
            commands::ai_generate_stream,
            commands::memory_decay_activity,
            commands::memory_smart_tabs,
            commands::memory_record_metric,
            commands::memory_get_metrics,
            commands::craft_metrics_trend,
            commands::dashboard_recent_docs,
            commands::dashboard_workspace_counts,
            commands::dashboard_writing_days,
            commands::dashboard_patterns,
            commands::dashboard_goals,
            commands::get_reopen_never_finish,
            commands::dashboard_streak_heatmap,
            commands::dashboard_writing_time_patterns,
            commands::dashboard_writing_velocity,
            commands::dashboard_productivity_score,
            commands::script_character_list,
            commands::script_character_add,
            commands::script_location_list,
            commands::script_location_add,
            commands::script_timeline_get,
            commands::script_timeline_add,
            commands::script_role_list,
            commands::script_role_assign,
            commands::script_role_create,
            commands::script_role_delete,
            commands::vault_rename_preview,
            commands::vault_rename_execute,
            commands::atomic_save,
            commands::setup_file_watcher,
            commands::memory_get_streak,
            commands::doc_search_full,
            commands::doc_get_stats,
            commands::snapshot_create,
            commands::snapshot_list,
            commands::snapshot_restore,
            commands::snapshot_delete_old,
            commands::backup_create,
            commands::backup_list,
            commands::rag_chunk_document,
            commands::rag_search,
            commands::rag_get_context,
            commands::ai_structurize,
            commands::perf_benchmark,
            commands::fs_list_dir,
            commands::fs_read_file,
            commands::fs_rename,
            commands::fs_delete,
            commands::fs_move,
            commands::fs_create_dir,
            commands::fs_write_file,
            commands::attachment_save,
            commands::attachment_read,
            commands::fs_reveal,
            commands::clear_conversations,
            commands::clear_messages,
            commands::clear_snapshots,
            commands::clear_usage_events,
            commands::clear_tab_states,
            commands::sidecar_start,
            commands::sidecar_python_probe,
            commands::sidecar_stop,
            commands::sidecar_is_running,
            commands::sidecar_set_endpoint,
            commands::sidecar_query,
            commands::get_workspace_context,
            commands::get_vault_path,
            commands::stt_start,
            commands::stt_stop,
            commands::stt_is_running,
            commands::stt_health,
            commands::stt_port,
            commands::stt_transcribe,
            commands::stt_stream_start,
            commands::stt_stream_chunk,
            commands::stt_stream_stop,
            commands::tts_start,
            commands::tts_stop,
            commands::tts_is_running,
            commands::tts_health,
            commands::tts_port,
            commands::tts_synthesize,
            commands::tts_stop_playback,
            commands::llm_start,
            commands::llm_stop,
            commands::llm_is_running,
            commands::llm_health,
            commands::llm_port,
            commands::llm_completion,
            commands::llm_chat_completion,
            commands::app_update_status,
            commands::convert_run,
            commands::compile_run,
            commands::convert_status,
            commands::doc_set_locked,
            commands::doc_list_pinned,
            commands::dashboard_today_rhythm,
            commands::memory_sidecar_start,
            commands::memory_sidecar_stop,
            commands::memory_sidecar_running,
            commands::memory_sidecar_health,
            commands::memory_learn,
            commands::memory_recall,
            commands::memory_redact,
            commands::memory_forget_all,
            commands::canvas_list,
            commands::canvas_upsert_node,
            commands::canvas_delete_node,
            commands::canvas_connect,
            commands::canvas_delete_edge,
            commands::publish_static_site,
            commands::ghost_fork,
            commands::ghost_list,
            commands::ghost_merge,
            commands::ghost_dismiss,
            commands::atlas_get_stars,
            commands::secret_set,
            commands::secret_get,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| eprintln!("Tauri application error: {}", e));
}
