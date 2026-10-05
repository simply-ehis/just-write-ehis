mod models;
mod database;
mod doc_store;
mod commands;
mod convert;
mod docmodel;
mod docx;
mod epub;
mod pdf;
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
        // sqlite_vec bundles its own sqlite3-sys, so its init fn pointer type
        // can't be named from here — the transmute is load-bearing, not lazy.
        rusqlite::ffi::sqlite3_auto_extension(Some(
            #[allow(clippy::missing_transmute_annotations)]
            std::mem::transmute(sqlite_vec::sqlite3_vec_init as *const ()),
        ));
    }

    let builder = tauri::Builder::default();
    #[cfg(target_os = "windows")]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
        // A second launch must always resurface the main window: closing it
        // hides to the tray (see widgetBridge onCloseRequested), so a plain
        // double-click with no file arg would otherwise appear to do nothing.
        if let Some(main) = app.get_webview_window("main") {
            let _ = main.unminimize();
            let _ = main.show();
            let _ = main.set_focus();
        }
        let Some(path) = windows::find_text_file(&args, Path::new(&cwd)) else {
            return;
        };
        if let Some(pending) = app.try_state::<windows::PendingLaunchFile>() {
            pending.set(path.clone());
        }
        if let Some(main) = app.get_webview_window("main") {
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
            // Boot gate must be managed before anything slow, so the frontend
            // can wait for the backend instead of racing it (see BootReady).
            let boot_ready = commands::BootReady::default();
            app.manage(boot_ready);

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

            let db = database::Database::new(conn, vault_path).with_db_path(db_path.clone());
            db.initialize()
                .map_err(|e| format!("Failed to initialize database schema: {}", e))?;

            app.manage(db);
            app.manage(windows::PendingLaunchFile::default());
            let autostart = windows::AutostartLaunch::default();
            if std::env::args().any(|a| a == "--widget-autostart") {
                autostart.set();
            }
            app.manage(autostart);
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

            // Last statement of setup: the backend is now fully managed, so
            // the frontend may stop waiting and run its boot steps.
            app.state::<commands::BootReady>().mark_ready();
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::doc_create,
            commands::open_external_file,
            commands::take_launch_file,
            commands::autostart_launch,
            commands::app_boot_ready,
            commands::open_default_apps,
             commands::doc_get,
             commands::widget_doc_get,
             commands::widget_doc_save,
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
            commands::bible_scope_id,
            commands::bible_get_facts,
            commands::bible_upsert_fact,
            commands::bible_delete_fact,
            commands::bible_get_mentions,
            commands::bible_upsert_mention,
            commands::bible_delete_mentions,
            commands::bible_get_suggestions,
            commands::bible_confirm_suggestion,
            commands::bible_reject_suggestion,
            commands::bible_extract_mentions,
            commands::bible_rebuild_memory,
            commands::conversation_create,
            commands::conversation_list,
            commands::conversation_add_message,
            commands::conversation_get_messages,
            commands::ai_generate,
            commands::ai_generate_stream,
            commands::provider_probe,
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
             commands::widget_atomic_save,
            commands::setup_file_watcher,
            commands::memory_get_streak,
            commands::doc_search_full,
            commands::search_docs_fts,
            commands::reindex_fts,
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
             commands::sidecar_python_probe,
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
             commands::app_lock_configured,
             commands::app_lock_verify,
             commands::app_lock_reset,
             commands::get_doc_tags,
             commands::add_doc_tag,
             commands::remove_doc_tag,
             commands::search_by_tag,
        ])
        .on_window_event(|window, event| {
            // × quits for real: with no close-to-tray interception left, a
            // destroyed main window means the session is over — exit instead
            // of lingering windowless (the companion widget dies with us).
            if window.label() == "main"
                && matches!(event, tauri::WindowEvent::Destroyed)
            {
                window.app_handle().exit(0);
            }
        })
        .run(tauri::generate_context!())
        .unwrap_or_else(|e| eprintln!("Tauri application error: {}", e));
}
