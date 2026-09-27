mod models;
mod database;
mod doc_store;
mod commands;
mod convert;
mod sidecar;
mod windows;

use rusqlite::Connection;
use tauri::Manager;
#[cfg(target_os = "windows")]
use std::path::{Path, PathBuf};
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

    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        let Some(path) = windows::find_text_file(&args, Path::new(&cwd)) else {
            return;
        };
        if let Some(pending) = app.try_state::<windows::PendingLaunchFile>() {
            pending.set(path.clone());
        }
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.show();
            let _ = main.set_focus();
            let _ = main.emit("native-file-open", path.to_string_lossy().into_owned());
        }
    }));
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(
        tauri_plugin_autostart::Builder::new()
            .app_name("Just Write ehis")
            .arg("--widget-autostart")
            .build(),
    );
    builder
        .setup(|app| {
            let app_dir = dirs::home_dir()
                .unwrap_or_else(|| PathBuf::from("."))
                .join(".local/share/just-write-ehis");
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
            app.manage(windows::PendingLaunchFile::default());
            #[cfg(target_os = "windows")]
            {
                let args: Vec<String> = std::env::args().collect();
                let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
                if let Some(path) = windows::find_text_file(&args, &cwd) {
                    app.state::<windows::PendingLaunchFile>().set(path.clone());
                    if let Some(main) = app.get_webview_window("main") {
                        let _ = main.show();
                        let _ = main.set_focus();
                        let _ = main.emit("native-file-open", path.to_string_lossy().into_owned());
                    }
                }
            }
            app.manage(commands::PinLockout::default());

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
             commands::doc::doc_create,
             commands::widget::open_external_file,
             commands::widget::take_launch_file,
             commands::widget::open_default_apps,
             commands::doc::doc_get,
             commands::widget::widget_doc_get,
             commands::widget::widget_doc_save,
             commands::doc::doc_save,
             commands::doc::doc_delete,
             commands::doc::doc_toggle_pin,
             commands::doc::doc_set_goal,
             commands::doc::doc_move,
             commands::doc::doc_search,
             commands::doc::doc_list_by_workspace,
             commands::doc::backlinks_get,
             commands::doc::implicit_links_get,
             commands::doc::usage_record,
             commands::doc::tabs_get,
             commands::doc::tabs_set,
             commands::doc::log_get_or_create,
             commands::doc::log_list_entries,
             commands::doc::graph_query,
             commands::doc::backlinks_extract,
             commands::doc::unlinked_mentions,
             commands::doc::entities_list,
             commands::doc::entity_occurrences,
             commands::doc::entities_backfill,
             commands::misc::reader_update_position,
             commands::misc::reader_set_shelf_status,
             commands::misc::reader_set_rating,
             commands::misc::reader_get_bookshelf,
             commands::misc::reader_import_book,
             commands::misc::novel_get_beat_board,
             commands::misc::novel_compile,
             commands::bible::bible_scope_id,
             commands::bible::bible_get_facts,
             commands::bible::bible_upsert_fact,
             commands::bible::bible_delete_fact,
             commands::bible::bible_get_mentions,
             commands::bible::bible_upsert_mention,
             commands::bible::bible_delete_mentions,
             commands::bible::bible_get_suggestions,
             commands::bible::bible_confirm_suggestion,
             commands::bible::bible_reject_suggestion,
             commands::bible::bible_extract_mentions,
             commands::bible::bible_rebuild_memory,
             commands::misc::conversation_create,
             commands::misc::conversation_list,
             commands::misc::conversation_add_message,
             commands::misc::conversation_get_messages,
             commands::ai::ai_generate,
             commands::ai::ai_generate_stream,
             commands::memory::memory_decay_activity,
             commands::memory::memory_smart_tabs,
             commands::memory::memory_record_metric,
             commands::memory::memory_get_metrics,
             commands::dashboard::craft_metrics_trend,
             commands::dashboard::dashboard_recent_docs,
             commands::dashboard::dashboard_workspace_counts,
             commands::dashboard::dashboard_writing_days,
             commands::dashboard::dashboard_patterns,
             commands::dashboard::dashboard_goals,
             commands::doc::get_reopen_never_finish,
             commands::dashboard::dashboard_streak_heatmap,
             commands::dashboard::dashboard_writing_time_patterns,
             commands::dashboard::dashboard_writing_velocity,
             commands::dashboard::dashboard_productivity_score,
             commands::script::script_character_list,
             commands::script::script_character_add,
             commands::script::script_location_list,
             commands::script::script_location_add,
             commands::script::script_timeline_get,
             commands::script::script_timeline_add,
             commands::script::script_role_list,
             commands::script::script_role_assign,
             commands::script::script_role_create,
             commands::script::script_role_delete,
             commands::misc::vault_rename_preview,
             commands::misc::vault_rename_execute,
             commands::misc::atomic_save,
             commands::widget::widget_atomic_save,
             commands::misc::setup_file_watcher,
             commands::memory::memory_get_streak,
             commands::doc::doc_get_stats,
             commands::misc::snapshot_create,
             commands::misc::snapshot_list,
             commands::misc::snapshot_restore,
             commands::misc::snapshot_delete_old,
             commands::misc::backup_create,
             commands::misc::backup_list,
             commands::misc::rag_chunk_document,
             commands::misc::rag_search,
             commands::misc::rag_get_context,
             commands::ai::ai_structurize,
             commands::misc::perf_benchmark,
             commands::fs::fs_list_dir,
             commands::fs::fs_read_file,
             commands::fs::fs_rename,
             commands::fs::fs_delete,
             commands::fs::fs_move,
             commands::fs::fs_create_dir,
             commands::fs::fs_write_file,
             commands::fs::attachment_save,
             commands::fs::attachment_read,
             commands::fs::fs_reveal,
             commands::misc::clear_conversations,
             commands::misc::clear_messages,
             commands::misc::clear_snapshots,
             commands::misc::clear_usage_events,
             commands::doc::clear_tab_states,
             commands::misc::sidecar_python_probe,
             commands::misc::get_workspace_context,
             commands::misc::get_vault_path,
             commands::sidecar::stt_start,
             commands::sidecar::stt_stop,
             commands::sidecar::stt_is_running,
             commands::sidecar::stt_health,
             commands::sidecar::stt_port,
             commands::sidecar::stt_transcribe,
             commands::sidecar::stt_stream_start,
             commands::sidecar::stt_stream_chunk,
             commands::sidecar::stt_stream_stop,
             commands::sidecar::tts_start,
             commands::sidecar::tts_stop,
             commands::sidecar::tts_is_running,
             commands::sidecar::tts_health,
             commands::sidecar::tts_port,
             commands::sidecar::tts_synthesize,
             commands::sidecar::tts_stop_playback,
             commands::sidecar::llm_start,
             commands::sidecar::llm_stop,
             commands::sidecar::llm_is_running,
             commands::sidecar::llm_health,
             commands::sidecar::llm_port,
             commands::sidecar::llm_completion,
             commands::sidecar::llm_chat_completion,
             commands::misc::app_update_status,
             commands::misc::convert_run,
             commands::misc::compile_run,
             commands::misc::convert_status,
             commands::doc::doc_set_locked,
             commands::doc::doc_list_pinned,
             commands::dashboard::dashboard_today_rhythm,
             commands::memory::memory_sidecar_start,
             commands::memory::memory_sidecar_stop,
             commands::memory::memory_sidecar_running,
             commands::memory::memory_sidecar_health,
             commands::memory::memory_learn,
             commands::memory::memory_recall,
             commands::memory::memory_redact,
             commands::memory::memory_forget_all,
             commands::misc::canvas_list,
             commands::misc::canvas_upsert_node,
             commands::misc::canvas_delete_node,
             commands::misc::canvas_connect,
             commands::misc::canvas_delete_edge,
             commands::misc::publish_static_site,
             commands::misc::ghost_fork,
             commands::misc::ghost_list,
             commands::misc::ghost_merge,
             commands::misc::ghost_dismiss,
             commands::misc::atlas_get_stars,
             commands::keychain::secret_set,
             commands::keychain::secret_get,
             commands::keychain::app_lock_configured,
             commands::keychain::app_lock_verify,
             commands::keychain::app_lock_reset,
             commands::convert_document_cmd,
             commands::get_doc_tags,
             commands::add_doc_tag,
             commands::remove_doc_tag,
             commands::search_by_tag,
        ])
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| eprintln!("Tauri application error: {}", e));
}
