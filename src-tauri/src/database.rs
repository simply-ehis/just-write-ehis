use rusqlite::{Connection, Result as SqlResult};
use std::collections::{HashMap, HashSet};
use std::sync::{mpsc, Mutex};

// Increment when the schema changes; the version commits with the migration.
const SCHEMA_VERSION: i64 = 5;

pub struct Database {
    pub conn: Mutex<Connection>,
    pub vault_path: std::path::PathBuf,
    /// Set after a failed migration to block document writes.
    pub read_only: bool,
    /// On-disk location used by backups and the derived-index worker.
    pub db_path: Option<std::path::PathBuf>,
    index_tx: Option<mpsc::Sender<DerivedIndexJob>>,
}

struct DerivedIndexJob {
    doc_id: String,
    content: String,
    refresh_rag: bool,
    refresh_backlink_titles: Vec<String>,
}

/// Rolls back a migration transaction unless it commits.
struct RollbackGuard<'a> {
    conn: &'a Connection,
    committed: bool,
}

impl Drop for RollbackGuard<'_> {
    fn drop(&mut self) {
        if !self.committed {
            let _ = self.conn.execute_batch("ROLLBACK;");
        }
    }
}

impl Database {
    pub fn new(conn: Connection, vault_path: std::path::PathBuf) -> Self {
        Self {
            conn: Mutex::new(conn),
            vault_path,
            db_path: None,
            read_only: false,
            index_tx: None,
        }
    }

    /// Set the backing file; in-memory databases leave it unset.
    pub fn with_db_path(mut self, path: std::path::PathBuf) -> Self {
        self.db_path = Some(path);
        self
    }

    pub fn start_derived_index_worker(&mut self) -> Result<(), String> {
        let path = self
            .db_path
            .clone()
            .ok_or_else(|| "database path is unavailable".to_string())?;
        let vault = self.vault_path.clone();
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        conn.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(|e| e.to_string())?;
        conn.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA synchronous=NORMAL;
             PRAGMA vec_enable=ON;",
        )
        .map_err(|e| e.to_string())?;
        let worker_db = Database::new(conn, vault);
        let (tx, rx) = mpsc::channel();
        self.index_tx = Some(tx);

        std::thread::Builder::new()
            .name("derived-index".into())
            .spawn(move || {
                while let Ok(first) = rx.recv() {
                    let mut pending = HashMap::new();
                    pending.insert(first.doc_id.clone(), first);
                    loop {
                        match rx.recv_timeout(std::time::Duration::from_millis(300)) {
                            Ok(job) => {
                                if let Some(previous) = pending.get_mut(&job.doc_id) {
                                    previous.content = job.content;
                                    previous.refresh_rag |= job.refresh_rag;
                                    previous
                                        .refresh_backlink_titles
                                        .extend(job.refresh_backlink_titles);
                                } else {
                                    pending.insert(job.doc_id.clone(), job);
                                }
                            }
                            Err(mpsc::RecvTimeoutError::Timeout)
                            | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        }
                    }

                    let mut refresh_backlink_titles = HashSet::new();
                    for job in pending.into_values() {
                        refresh_backlink_titles.extend(job.refresh_backlink_titles);
                        if let Err(error) =
                            worker_db.refresh_entities(&job.doc_id, &job.content)
                        {
                            eprintln!("[derived-index] entities refresh failed for {}: {error}", job.doc_id);
                        }
                        if let Err(error) =
                            worker_db.extract_backlinks(&job.doc_id, &job.content)
                        {
                            eprintln!("[derived-index] backlinks refresh failed for {}: {error}", job.doc_id);
                        }
                        if job.refresh_rag {
                            worker_db.refresh_rag_chunks(&job.doc_id);
                        }
                    }
                    if !refresh_backlink_titles.is_empty() {
                        let titles = refresh_backlink_titles.into_iter().collect::<Vec<_>>();
                        if let Err(error) = worker_db
                            .refresh_backlinks_for_titles(&titles)
                        {
                            eprintln!("[derived-index] backlink title refresh failed: {error}");
                        }
                    }
                }
            })
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn schedule_derived_indexes(
        &self,
        doc_id: &str,
        content: &str,
        refresh_rag: bool,
        refresh_backlink_titles: &[String],
    ) -> bool {
        let job = DerivedIndexJob {
            doc_id: doc_id.to_string(),
            content: content.to_string(),
            refresh_rag,
            refresh_backlink_titles: refresh_backlink_titles.to_vec(),
        };
        self.index_tx
            .as_ref()
            .is_some_and(|tx| tx.send(job).is_ok())
    }

    pub fn initialize(&self) -> SqlResult<()> {
        let current_version: i64 = {
            let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
            conn.query_row("PRAGMA user_version", [], |row| row.get(0))?
        };
        if current_version > SCHEMA_VERSION {
            return Err(rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(rusqlite::ffi::SQLITE_ERROR),
                Some(format!(
                    "database schema version {current_version} is newer than this app supports ({SCHEMA_VERSION})"
                )),
            ));
        }
        if current_version < SCHEMA_VERSION {
            if let Err(error) = self.backup_before_migration() {
                eprintln!("[db] pre-migration backup failed; migration remains transactional: {error}");
            }
        }

        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;
             PRAGMA foreign_keys=ON;
             PRAGMA vec_enable=ON;
             PRAGMA synchronous=NORMAL;",
        )?;

        if current_version == SCHEMA_VERSION {
            return Ok(());
        }

        // Keep schema changes atomic so a failed migration leaves the DB usable.
        conn.execute_batch("BEGIN;")?;
        let mut rollback_guard = RollbackGuard {
            conn: &conn,
            committed: false,
        };

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
                deadline TEXT
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
                metric_type TEXT NOT NULL,
                value REAL NOT NULL,
                created_at TEXT NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS doc_tags (
                doc_id TEXT NOT NULL,
                tag TEXT NOT NULL,
                PRIMARY KEY (doc_id, tag),
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_docs_parent ON docs(parent_id);
            CREATE INDEX IF NOT EXISTS idx_docs_path ON docs(path);
            CREATE INDEX IF NOT EXISTS idx_backlinks_target ON backlinks(target_id);
            CREATE INDEX IF NOT EXISTS idx_conversations_doc ON conversations(doc_id);
            CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation ON chat_messages(conversation_id);
            CREATE INDEX IF NOT EXISTS idx_bible_mentions_scope ON bible_mentions(bible_doc_id);
            CREATE INDEX IF NOT EXISTS idx_bible_suggestions_scope ON bible_suggestions(bible_doc_id);
            CREATE INDEX IF NOT EXISTS idx_docs_updated_at ON docs(updated_at DESC);
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

            CREATE TABLE IF NOT EXISTS rag_chunks (
                id TEXT PRIMARY KEY,
                doc_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL,
                start_word INTEGER NOT NULL,
                end_word INTEGER NOT NULL,
                FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_rag_chunks_doc ON rag_chunks(doc_id);"
        )?;

        let has_unused_chunk_embedding: bool =
            conn.prepare("SELECT embedding FROM rag_chunks LIMIT 0").is_ok();
        if has_unused_chunk_embedding {
            conn.execute_batch("ALTER TABLE rag_chunks DROP COLUMN embedding;")?;
        }

        // Drop redundant indexes left by earlier schemas.
        conn.execute_batch(
            "DROP INDEX IF EXISTS idx_docs_workspace;
             DROP INDEX IF EXISTS idx_snapshots_doc;
             DROP INDEX IF EXISTS idx_usage_events_doc;
             DROP INDEX IF EXISTS idx_backlinks_source;
             DROP INDEX IF EXISTS idx_bible_facts_doc;
             DROP INDEX IF EXISTS idx_bible_mentions_doc;
             DROP INDEX IF EXISTS idx_doc_tags_doc;
             DROP INDEX IF EXISTS idx_rag_chunks_content;",
        )?;

        let has_suggestion_status: bool = conn
            .prepare("SELECT status FROM bible_suggestions LIMIT 1")
            .is_ok();
        if !has_suggestion_status {
            conn.execute_batch(
                "ALTER TABLE bible_suggestions ADD COLUMN status TEXT NOT NULL DEFAULT 'pending';",
            )?;
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
            );",
        )?;

        conn.execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
                title,
                content,
                workspace,
                tokenize = 'porter unicode61'
            );",
        )?;

        // Keep command-palette search in sync with document writes.
        conn.execute_batch(
            "CREATE TRIGGER IF NOT EXISTS docs_fts_insert AFTER INSERT ON docs BEGIN
                 INSERT INTO docs_fts(rowid, title, content, workspace)
                 VALUES (new.rowid, new.title, new.content, new.workspace);
             END;
             CREATE TRIGGER IF NOT EXISTS docs_fts_update AFTER UPDATE OF title, content, workspace ON docs BEGIN
                 DELETE FROM docs_fts WHERE rowid = old.rowid;
                 INSERT INTO docs_fts(rowid, title, content, workspace)
                 VALUES (new.rowid, new.title, new.content, new.workspace);
             END;
             CREATE TRIGGER IF NOT EXISTS docs_fts_delete AFTER DELETE ON docs BEGIN
                 DELETE FROM docs_fts WHERE rowid = old.rowid;
             END;",
        )?;

        conn.execute_batch(
            "DELETE FROM docs_fts;
             INSERT INTO docs_fts(rowid, title, content, workspace)
             SELECT rowid, title, content, workspace FROM docs;",
        )?;

        let has_hash: bool = conn
            .prepare("SELECT content_hash FROM snapshots LIMIT 1")
            .is_ok();
        if !has_hash {
            conn.execute_batch("ALTER TABLE snapshots ADD COLUMN content_hash TEXT;")?;
        }

        for (column, definition) in [
            ("pinned", "pinned INTEGER NOT NULL DEFAULT 0"),
            ("goal_words", "goal_words INTEGER"),
            ("deadline", "deadline TEXT"),
        ] {
            if conn
                .prepare(&format!("SELECT {column} FROM docs LIMIT 1"))
                .is_err()
            {
                conn.execute_batch(&format!(
                    "ALTER TABLE docs ADD COLUMN {definition};"
                ))?;
            }
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
             CREATE INDEX IF NOT EXISTS idx_canvas_edges_target ON canvas_edges(target_id);",
        )?;

        // Preserve craft metrics when converting the old table shape.
        let has_metric_type: bool = conn
            .prepare("SELECT metric_type FROM craft_metrics LIMIT 1")
            .is_ok();
        if !has_metric_type {
            // Convert the old metrics_json/ts rows into the current columns.
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
                 DROP TABLE craft_metrics_old;",
            )?;
        }
        conn.execute_batch(
            "CREATE INDEX IF NOT EXISTS idx_craft_metrics_doc ON craft_metrics(doc_id);",
        )?;

        // Store the version in the same transaction as the schema changes.
        conn.execute_batch(&format!("PRAGMA user_version = {SCHEMA_VERSION};"))?;

        conn.execute_batch("COMMIT;")?;
        rollback_guard.committed = true;

        Ok(())
    }

    /// Copy the DB file to a timestamped backup before migrations run.
    ///
    /// Best-effort copy before the transactional schema update.
    fn backup_before_migration(&self) -> SqlResult<()> {
        let db_file = self.db_path.clone();
        let Some(path) = db_file else {
            return Ok(()); // in-memory (tests): nothing to back up
        };
        if !path.is_file() {
            return Ok(()); // first run: nothing to back up
        }
        let backup_dir = dirs::data_local_dir()
            .unwrap_or_default()
            .join("writing-app")
            .join("pre-migration-backups");
        std::fs::create_dir_all(&backup_dir).map_err(|e| {
            rusqlite::Error::SqliteFailure(
                rusqlite::ffi::Error::new(1),
                Some(format!("backup dir: {}", e)),
            )
        })?;
        let name = format!(
            "writing-{}.db",
            chrono::Local::now().format("%Y%m%d_%H%M%S")
        );
        let dest = backup_dir.join(name);
        // VACUUM INTO, not fs::copy. The DB runs in WAL mode, so the newest
        // committed transactions live in the -wal sidecar: copying the .db file
        // alone yields an older, torn snapshot -- precisely the state a
        // pre-migration safety net must never be in. VACUUM INTO reads through
        // SQLite and writes one consistent, self-contained file. This is the
        // same primitive backup_create uses.
        let quoted = dest.to_string_lossy().replace('\'', "''");
        let conn = self.conn.lock().unwrap_or_else(|e| e.into_inner());
        conn.execute_batch(&format!("VACUUM INTO '{}';", quoted))
            .map_err(|e| {
                rusqlite::Error::SqliteFailure(
                    rusqlite::ffi::Error::new(1),
                    Some(format!("backup copy: {}", e)),
                )
            })?;
        // Keep only the newest 5 pre-migration backups.
        if let Ok(entries) = std::fs::read_dir(&backup_dir) {
            let mut backups: Vec<_> = entries
                .filter_map(|e| e.ok().map(|x| x.path()))
                .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("db"))
                .collect();
            backups.sort();
            let excess = backups.len().saturating_sub(5);
            for old in backups.iter().take(excess) {
                let _ = std::fs::remove_file(old);
            }
        }
        Ok(())
    }
}
