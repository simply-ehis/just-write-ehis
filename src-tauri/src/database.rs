use rusqlite::{Connection, Result as SqlResult};
use std::sync::Mutex;

pub struct Database {
  pub conn: Mutex<Connection>,
  pub vault_path: Mutex<std::path::PathBuf>,
  /// On-disk location of the database, when there is one.
  ///
  /// `backup_create` needs this to run `VACUUM INTO` on a SECOND connection:
  /// the copy reads the whole file, and doing it on `conn` held the only
  /// connection's mutex for the duration, stalling every concurrent command
  /// (autosave, search, RAG) on a large vault. WAL permits a reader alongside
  /// the writer, so a separate connection lets the app keep serving while the
  /// backup runs. `None` for in-memory databases, where there is no file to
  /// reopen and the caller must fall back to the locked path.
  pub db_path: Mutex<Option<std::path::PathBuf>>,
}

impl Database {
pub fn new(conn: Connection, vault_path: std::path::PathBuf) -> Self {
  Self {
  conn: Mutex::new(conn),
  vault_path: Mutex::new(vault_path),
  db_path: Mutex::new(None),
  }
  }

  /// Record the backing file so long-running reads can use their own
  /// connection. Separate from `new` so in-memory test databases stay valid.
  pub fn with_db_path(self, path: std::path::PathBuf) -> Self {
  if let Ok(mut slot) = self.db_path.lock() {
  *slot = Some(path);
  }
  self
  }

    pub fn initialize(&self) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute_batch("PRAGMA journal_mode=WAL;")?;
        conn.execute_batch("PRAGMA foreign_keys=ON;")?;
        conn.execute_batch("PRAGMA vec_enable=ON;")?;

        // WAL companions. Only `journal_mode` was set, so the rest ran at SQLite
        // defaults, which cost real time in this app specifically:
        //
        // - `synchronous` defaults to FULL, so every commit fsyncs the WAL. The
        //   editor autosaves on each pause while typing, making this the single
        //   most frequent disk sync in the product. NORMAL is the standard
        //   companion to WAL: still crash-safe against application crashes
        //   (only a power loss/OS crash can lose the last commits), and the app
        //   already has a snapshot + version-history layer for that case.
        // - `cache_size` defaults to ~2 MB, which is small against a vault large
        //   enough to make the scans in doc_store noticeable; these were
        //   re-reading from disk repeatedly.
        // - `mmap_size` unset means reads go through the syscall path rather
        //   than memory mapping.
        //
        // Negative `cache_size` is kibibytes rather than pages.
        conn.execute_batch(
            "PRAGMA synchronous=NORMAL;
             PRAGMA cache_size=-20000;
             PRAGMA mmap_size=268435456;
             PRAGMA temp_store=MEMORY;",
        )?;

        // Migrations run inside one transaction. `execute_batch` does NOT wrap
        // its statements, so a failure part-way through used to leave the
        // schema half-migrated — and because lib.rs maps an initialize() error
        // out of setup, that meant the app refused to launch with the vault
        // still on disk and no way in through the UI.
        //
        // Must come AFTER the PRAGMA block above: `PRAGMA journal_mode=WAL`
        // cannot run inside a transaction ("Safety level may not be changed
        // inside a transaction").
        conn.execute_batch("BEGIN;")?;

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
                embedding_ref TEXT,
                pinned INTEGER NOT NULL DEFAULT 0,
                goal_words INTEGER,
                deadline TEXT,
                locked INTEGER NOT NULL DEFAULT 0
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

            CREATE TABLE IF NOT EXISTS bible_mentions (
                id TEXT PRIMARY KEY,
                bible_doc_id TEXT NOT NULL,
                fact_key TEXT NOT NULL,
                kind TEXT NOT NULL,
                doc_id TEXT NOT NULL,
                snippet TEXT NOT NULL,
                attribute_key TEXT,
                attribute_value TEXT,
                created_at TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS bible_suggestions (
                id TEXT PRIMARY KEY,
                bible_doc_id TEXT NOT NULL,
                source_doc_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                snippet TEXT NOT NULL,
                attribute_key TEXT,
                attribute_value TEXT,
                status TEXT NOT NULL DEFAULT 'pending',
                created_at TEXT NOT NULL,
                FOREIGN KEY (source_doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS craft_metrics (
                id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                metrics_json TEXT NOT NULL,
                ts TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS doc_tags (
                doc_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (doc_id, tag),
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
            CREATE INDEX IF NOT EXISTS idx_bible_mentions_scope ON bible_mentions(bible_doc_id);
            CREATE INDEX IF NOT EXISTS idx_bible_mentions_doc ON bible_mentions(doc_id);
            CREATE INDEX IF NOT EXISTS idx_bible_suggestions_scope ON bible_suggestions(bible_doc_id);
            CREATE INDEX IF NOT EXISTS idx_craft_metrics_doc ON craft_metrics(doc_id);
            CREATE INDEX IF NOT EXISTS idx_docs_updated_at ON docs(updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_docs_locked ON docs(locked);
            CREATE INDEX IF NOT EXISTS idx_docs_pinned ON docs(pinned);
            CREATE INDEX IF NOT EXISTS idx_docs_activity_score ON docs(activity_score DESC);
            CREATE INDEX IF NOT EXISTS idx_docs_title ON docs(title COLLATE NOCASE);
            CREATE INDEX IF NOT EXISTS idx_docs_workspace_status ON docs(workspace, status);
            CREATE INDEX IF NOT EXISTS idx_bible_mentions_doc_fact ON bible_mentions(doc_id, fact_key);
            CREATE INDEX IF NOT EXISTS idx_bible_suggestions_source_status ON bible_suggestions(source_doc_id, status);
            CREATE INDEX IF NOT EXISTS idx_snapshots_doc_created ON snapshots(doc_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_usage_events_doc_event ON usage_events(doc_id, event);
            CREATE INDEX IF NOT EXISTS idx_usage_events_ts ON usage_events(ts);
            CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON doc_tags(tag);
            CREATE INDEX IF NOT EXISTS idx_doc_tags_doc ON doc_tags(doc_id);

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

        let has_suggestion_status: bool = conn.prepare("SELECT status FROM bible_suggestions LIMIT 1").is_ok();
        if !has_suggestion_status {
            conn.execute_batch("ALTER TABLE bible_suggestions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';")?;
        }
        let has_fact_scope_key: bool = conn.query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_bible_facts_doc_key_unique'",
            [],
            |_| Ok(()),
        ).is_ok();
        if !has_fact_scope_key {
            conn.execute_batch(
                "DELETE FROM bible_facts WHERE id NOT IN (SELECT MIN(id) FROM bible_facts GROUP BY doc_id, key);
                 CREATE UNIQUE INDEX IF NOT EXISTS idx_bible_facts_doc_key_unique ON bible_facts(doc_id, key);",
            )?;
        }

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS rag_vec USING vec0(
                chunk_id TEXT PRIMARY KEY,
                embedding float[256]
            );"
        )?;

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
                title,
                content,
                workspace,
                tokenize = 'porter unicode61'
            );"
        )?;

        let has_hash: bool = conn.prepare(
            "SELECT content_hash FROM snapshots LIMIT 1"
        ).is_ok();
        if !has_hash {
            conn.execute_batch(
                "ALTER TABLE snapshots ADD COLUMN content_hash TEXT;"
            )?;
        }

        let has_pinned: bool = conn.prepare(
            "SELECT pinned FROM docs LIMIT 1"
        ).is_ok();
        if !has_pinned {
            conn.execute_batch(
                "ALTER TABLE docs ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
                 ALTER TABLE docs ADD COLUMN goal_words INTEGER;
                 ALTER TABLE docs ADD COLUMN deadline TEXT;"
            )?;
        }

        let has_locked: bool = conn.prepare(
            "SELECT locked FROM docs LIMIT 1"
        ).is_ok();
        if !has_locked {
            conn.execute_batch(
                "ALTER TABLE docs ADD COLUMN locked INTEGER NOT NULL DEFAULT 0;"
            )?;
        }

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

        // The craft_metrics table gained `metric_type` in a later schema. The old
        // check only asked "does this table exist", so a DB that already had
        // the table but not the column never got it — and every later
        // get_doc failed with "no such column".
        //
        // Worse, the old body did `DROP TABLE IF EXISTS craft_metrics` before
        // recreating it, which silently destroyed every existing user's
        // craft-metric history on upgrade. Rename-and-copy instead: the old
        // rows survive, and the new column is added without data loss.
        let table_exists: bool = conn
            .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='craft_metrics'")
            .is_ok();
        let has_metric_type: bool = conn
            .prepare("SELECT metric_type FROM craft_metrics LIMIT 1")
            .is_ok();
        if table_exists && !has_metric_type {
            // Existing table without the new column: rename, copy, drop.
            // The old schema used metrics_json/ts; the new one uses
            // metric_type/value/created_at. Map old -> new explicitly.
            conn.execute_batch(
                "ALTER TABLE craft_metrics RENAME TO craft_metrics_old;
                 CREATE TABLE craft_metrics (
                     id TEXT PRIMARY KEY,
                     doc_id TEXT NOT NULL,
                     metric_type TEXT NOT NULL,
                     value REAL NOT NULL,
                     created_at TEXT NOT NULL,
                     FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
                 );
                 INSERT INTO craft_metrics (id, doc_id, metric_type, value, created_at)
                     SELECT id, doc_id, 'unknown', 0.0, ts FROM craft_metrics_old;
                 DROP TABLE craft_metrics_old;
                 CREATE INDEX IF NOT EXISTS idx_craft_metrics_doc ON craft_metrics(doc_id);"
            )?;
        }

        // COMMIT is the last statement of the migration batch. If any statement
        // failed, the `?` above returns early and the transaction rolls back,
        // leaving the schema exactly as it was.
        conn.execute_batch("COMMIT;")?;

        Ok(())
    }
}
