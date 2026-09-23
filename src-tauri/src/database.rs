use rusqlite::{Connection, Result as SqlResult};
use std::sync::Mutex;

pub struct Database {
    pub conn: Mutex<Connection>,
    pub vault_path: Mutex<std::path::PathBuf>,
}

impl Database {
    pub fn new(conn: Connection, vault_path: std::path::PathBuf) -> Self {
        Self {
            conn: Mutex::new(conn),
            vault_path: Mutex::new(vault_path),
        }
    }

    pub fn initialize(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        conn.execute_batch("PRAGMA vec_enable=ON;")?;

        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS docs (
                id TEXT PRIMARY KEY,
                workspace TEXT NOT NULL,
                kind TEXT NOT NULL DEFAULT 'doc',
                title TEXT NOT NULL,
                path TEXT NOT NULL,
                parent_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                word_count INTEGER NOT NULL DEFAULT 0,
                reading_position REAL,
                status TEXT NOT NULL DEFAULT 'draft',
                frontmatter_json TEXT,
                activity_score REAL NOT NULL DEFAULT 0.0,
                embedding_ref TEXT
            );

            CREATE TABLE IF NOT EXISTS backlinks (
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                context_snippet TEXT NOT NULL,
                PRIMARY KEY (source_id, target_id),
                FOREIGN KEY (source_id) REFERENCES docs(id) ON DELETE CASCADE,
                FOREIGN KEY (target_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS links_implicit (
                source_id TEXT NOT NULL,
                target_id TEXT NOT NULL,
                match_type TEXT NOT NULL,
                PRIMARY KEY (source_id, target_id, match_type),
                FOREIGN KEY (source_id) REFERENCES docs(id) ON DELETE CASCADE,
                FOREIGN KEY (target_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS entity_occurrences (
                entity_norm TEXT NOT NULL,
                display TEXT NOT NULL,
                kind TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                span_start INTEGER NOT NULL,
                span_end INTEGER NOT NULL,
                PRIMARY KEY (entity_norm, doc_id, span_start),
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_entity_norm ON entity_occurrences(entity_norm);

            CREATE TABLE IF NOT EXISTS snapshots (
                id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                label TEXT NOT NULL,
                content TEXT,
                word_count INTEGER NOT NULL DEFAULT 0,
                content_hash TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS usage_events (
                doc_id TEXT NOT NULL,
                event TEXT NOT NULL,
                ts TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS tab_state (
                workspace TEXT PRIMARY KEY,
                tab_stack_json TEXT NOT NULL DEFAULT '[]',
                active_id TEXT,
                cursor TEXT,
                scroll REAL
            );

            CREATE TABLE IF NOT EXISTS conversations (
                id TEXT PRIMARY KEY,
                doc_id TEXT,
                mode TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS chat_messages (
                id TEXT PRIMARY KEY,
                conversation_id TEXT NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS bible_facts (
                id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS craft_metrics (
                id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                metrics_json TEXT NOT NULL,
                ts TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_docs_workspace ON docs(workspace);
            CREATE INDEX IF NOT EXISTS idx_docs_parent ON docs(parent_id);
            CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
            CREATE INDEX IF NOT EXISTS idx_backlinks_source ON backlinks(source_id);
            CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_id);
            CREATE INDEX IF NOT EXISTS idx_snapshots_doc ON snapshots(doc_id);
            CREATE INDEX IF NOT EXISTS idx_usage_events_doc ON usage_events(doc_id);
            CREATE INDEX IF NOT EXISTS idx_conversations_doc ON conversations(doc_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_bible_facts_doc ON bible_facts(doc_id);
            CREATE INDEX IF NOT EXISTS idx_craft_metrics_doc ON craft_metrics(doc_id);

            CREATE TABLE IF NOT EXISTS rag_chunks (
                id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                start_word INTEGER NOT NULL,
                end_word INTEGER NOT NULL,
                embedding BLOB,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);
            CREATE INDEX IF NOT EXISTS idx_rag_chunks_content ON rag_chunks(content);"
        )?;

        // Create vector virtual table for semantic search
        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS rag_vec USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding float[256]
            );"
        )?;

        // Migration: add content_hash to snapshots if missing
        let has_hash: bool = conn.prepare(
            "SELECT content_hash FROM snapshots LIMIT 1"
        ).is_ok();
        if !has_hash {
            let _ = conn.execute_batch(
                "ALTER TABLE snapshots ADD COLUMN content_hash TEXT;"
            );
        }

        // Migration: add pinned, goal_words, deadline to docs if missing (A11.5, A11.8)
        let has_pinned: bool = conn.prepare(
            "SELECT pinned FROM docs LIMIT 1"
        ).is_ok();
        if !has_pinned {
            let _ = conn.execute_batch(
                "ALTER TABLE docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE docs ADD COLUMN goal_words INTEGER;
                 ALTER TABLE docs ADD COLUMN deadline TEXT;"
            );
        }

        // Migration: add locked to docs if missing (per-doc lock)
        let has_locked: bool = conn.prepare(
            "SELECT locked FROM docs LIMIT 1"
        ).is_ok();
        if !has_locked {
            let _ = conn.execute_batch(
                "ALTER TABLE docs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;"
            );
        }

        // Canvas board (A11.1): freeform cards + connections.
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS canvas_nodes (
                 id TEXT PRIMARY KEY,
                 title TEXT NOT NULL DEFAULT '',
                 body TEXT NOT NULL DEFAULT '',
                 x REAL NOT NULL DEFAULT 0.0,
                 y REAL NOT NULL DEFAULT 0.0,
                 color TEXT NOT NULL DEFAULT 'slate',
                 doc_id TEXT,
                 updated_at TEXT NOT NULL
             );
             CREATE TABLE IF NOT EXISTS canvas_edges (
                 id TEXT PRIMARY KEY,
                 source_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
                 target_id TEXT NOT NULL REFERENCES canvas_nodes(id) ON DELETE CASCADE,
                 label TEXT NOT NULL DEFAULT ''
             );
             CREATE INDEX IF NOT EXISTS idx_canvas_edges_source ON canvas_edges(source_id);
             CREATE INDEX IF NOT EXISTS idx_canvas_edges_target ON canvas_edges(target_id);"
        )?;

        // Migration: repair craft_metrics schema. The original table was
        // created as (id, doc_id, metrics_json, ts) but every reader/writer
        // uses (id, doc_id, metric_type, value, created_at) — so no valid
        // row could ever have been written; rebuild empty is lossless.
        let has_metric_type: bool = conn.prepare(
            "SELECT metric_type FROM craft_metrics LIMIT 1"
        ).is_ok();
        if !has_metric_type {
            let _ = conn.execute_batch(
                "DROP TABLE IF EXISTS craft_metrics;
                 CREATE TABLE craft_metrics (
                     id TEXT PRIMARY KEY,
                     doc_id TEXT NOT NULL,
                     metric_type TEXT NOT NULL,
                     value REAL NOT NULL,
                     created_at TEXT NOT NULL,
                     FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
                 );
                 CREATE INDEX IF NOT EXISTS idx_craft_metrics_doc ON craft_metrics(doc_id);"
            );
        }

        Ok(())
    }
}
