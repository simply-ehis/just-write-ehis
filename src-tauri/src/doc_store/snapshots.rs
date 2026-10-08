    use super::*;

    impl Database {
    /// the text being written rather than the text being overwritten.
    /// See `snapshot_create_from`.
    pub fn snapshot_create(&self, doc_id: &str) -> Result<Snapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let content: String = conn
            .query_row(
                "SELECT content FROM docs WHERE id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .map_err(|e| e.to_string())?;
        drop(conn);
        self.snapshot_create_from(doc_id, &content)
    }

    /// Snapshot an explicit body. Used by the save path, which already holds
    /// the pre-edit content and must not re-read the row after committing.
    pub fn snapshot_create_from(&self, doc_id: &str, content: &str) -> Result<Snapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let hash = compute_content_hash(content);

        // Dedup: skip if content_hash matches the most recent snapshot
        let last_hash: Option<String> = conn
            .query_row(
                "SELECT content_hash FROM snapshots WHERE doc_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![doc_id],
                |row| row.get(0),
            )
            .unwrap_or(None);

        if last_hash.as_deref() == Some(hash.as_str()) {
            // Identical content — skip snapshot (dedup per A10.2)
            // Return the last snapshot instead
            let snap = conn.query_row(
                "SELECT id, doc_id, label, content, word_count, content_hash, created_at FROM snapshots WHERE doc_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![doc_id],
                |row| {
                    Ok(Snapshot {
                        id: row.get(0)?,
                        doc_id: row.get(1)?,
                        label: row.get(2)?,
                        content: row.get(3)?,
                        word_count: row.get(4)?,
                        content_hash: row.get(5)?,
                        created_at: row.get(6)?,
                    })
                },
            ).map_err(|e| e.to_string())?;
            return Ok(snap);
        }

        let id = uuid_v7();
        let now = now_iso();
        let word_count = content.split_whitespace().count() as i64;

        // Label: include word diff from previous snapshot
        let prev_content: Option<String> = conn
            .query_row(
                "SELECT content FROM snapshots WHERE doc_id = ?1 ORDER BY created_at DESC LIMIT 1",
                params![doc_id],
                |row| row.get(0),
            )
            .unwrap_or(None);
        let label = match prev_content {
            Some(ref prev) => {
                let diff = word_diff_count(prev, content);
                if diff >= 0 {
                    format!("v{} (+{} words)", now.split('T').next().unwrap_or(&now), diff)
                } else {
                    format!("v{} ({} words)", now.split('T').next().unwrap_or(&now), diff)
                }
            }
            None => format!("v{}", now.split('T').next().unwrap_or(&now)),
        };

        conn.execute(
            "INSERT INTO snapshots (id, doc_id, label, content, word_count, content_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, doc_id, label, content, word_count, hash, now],
        ).map_err(|e| e.to_string())?;

        Ok(Snapshot { id, doc_id: doc_id.to_string(), label, content: Some(content.to_string()), word_count, content_hash: Some(hash), created_at: now })
    }

    pub fn snapshot_list(&self, doc_id: &str) -> Result<Vec<Snapshot>, String> {
        // Snapshots carry the FULL document body, so a locked doc's history is
        // as sensitive as the doc itself. Every other read path filters on
        // `docs.locked`; this one did not, and `allow-snapshot-list` is granted
        // to the companion window — so it silently defeated the widget ACL's
        // "locked docs stay out of the companion" guarantee.
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.doc_id, s.label, s.content, s.word_count, s.content_hash, s.created_at
             FROM snapshots s
             WHERE s.doc_id = ?1
               AND EXISTS (SELECT 1 FROM docs d WHERE d.id = s.doc_id AND d.locked = 0)
             ORDER BY s.created_at DESC"
        ).map_err(|e| e.to_string())?;

        let snapshots = stmt.query_map(params![doc_id], |row| {
            Ok(Snapshot {
                id: row.get(0)?,
                doc_id: row.get(1)?,
                label: row.get(2)?,
                content: row.get(3)?,
                word_count: row.get(4)?,
                content_hash: row.get(5)?,
                created_at: row.get(6)?,
            })
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(snapshots)
    }

    pub fn snapshot_restore(&self, snapshot_id: &str) -> Result<Doc, String> {
        // Snapshot the CURRENT content before overwriting it. Without this,
        // restoring the wrong snapshot was unrecoverable — the text the user
        // was on before pressing Restore was gone forever.
        let current = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT d.id, d.content FROM docs d JOIN snapshots s ON s.doc_id = d.id WHERE s.id = ?1",
                params![snapshot_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .ok()
        };
        if let Some((doc_id, content)) = current {
            let _ = self.snapshot_create_from(&doc_id, &content);
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let snapshot = {
            let mut stmt = conn.prepare(
                "SELECT id, doc_id, label, content, word_count, content_hash, created_at FROM snapshots WHERE id = ?1"
            ).map_err(|e| e.to_string())?;
            stmt.query_row(params![snapshot_id], |row| {
                Ok(Snapshot {
                    id: row.get(0)?,
                    doc_id: row.get(1)?,
                    label: row.get(2)?,
                    content: row.get(3)?,
                    word_count: row.get(4)?,
                    content_hash: row.get(5)?,
                    created_at: row.get(6)?,
                })
            }).map_err(|e| e.to_string())?
        };

        let now = now_iso();
        let word_count = snapshot.content.as_ref().map(|c| c.split_whitespace().count() as i64).unwrap_or(0);

        conn.execute(
            "UPDATE docs SET content = ?1, word_count = ?2, updated_at = ?3 WHERE id = ?4",
            params![snapshot.content, word_count, now, snapshot.doc_id],
        ).map_err(|e| e.to_string())?;

        let doc = {
            let mut stmt = conn.prepare(
                "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE id = ?1"
            ).map_err(|e| e.to_string())?;
            stmt.query_row(params![snapshot.doc_id], |row| {
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
            }).map_err(|e| e.to_string())?
        };

        // Write restored content to disk. Propagate the error: a silent failure
        // here leaves the DB with the restored text and the .md with the old
        // text, and the caller sees Ok.
        drop(conn);
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
        let full_path = resolve_in_vault(&vault, &doc.path)?;
        drop(vault);
        write_to_disk(&full_path, &doc.content)?;

        // Re-extract backlinks
        if let Some(content) = &snapshot.content {
            let _ = self.extract_backlinks(&snapshot.doc_id, content);
        }

        self.get_doc(&snapshot.doc_id)
    }

    /// Thin snapshots per A10.2 (retention window is caller-configured):
    /// - Dedupe identical content_hash (already handled in snapshot_create)
    /// - Thin older-than-window to 1/day
    /// - Cap at 500/doc (weekly thinning past that)
    pub fn snapshot_retention_prune(&self, doc_id: &str, retention_days: i64) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_iso();
        // i64 interpolated, never user text — no injection surface.
        let window = format!("-{} days", retention_days.max(1));

        // 1. Remove exact duplicates (keep newest of each content_hash per day)
        let deduped = conn.execute(
            "DELETE FROM snapshots WHERE doc_id = ?1 AND id NOT IN (
                SELECT id FROM (
                    SELECT id, content_hash, DATE(created_at) as day,
                           ROW_NUMBER() OVER (PARTITION BY content_hash, DATE(created_at) ORDER BY created_at DESC) as rn
                    FROM snapshots WHERE doc_id = ?1
                ) WHERE rn = 1
            )",
            params![doc_id],
        ).map_err(|e| e.to_string())?;

        // 2. Thin older-than-window to 1/day (keep newest per day)
        let thin_sql = format!(
            "DELETE FROM snapshots WHERE doc_id = ?1 AND created_at < datetime(?2, '{}')
             AND id NOT IN (
                SELECT id FROM (
                    SELECT id, DATE(created_at) as day,
                           ROW_NUMBER() OVER (PARTITION BY DATE(created_at) ORDER BY created_at DESC) as rn
                    FROM snapshots WHERE doc_id = ?1 AND created_at < datetime(?2, '{}')
                ) WHERE rn = 1
            )",
            window, window
        );
        let thinned = conn.execute(
            &thin_sql,
            params![doc_id, now],
        ).map_err(|e| e.to_string())?;

        // 3. Cap at 500: if >500, thin oldest to weekly
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM snapshots WHERE doc_id = ?1",
            params![doc_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        let over_cap = if count > 500 { (count - 500) as u64 } else { 0 };
        let weekly_thinned = if over_cap > 0 {
            conn.execute(
                "DELETE FROM snapshots WHERE doc_id = ?1 AND id NOT IN (
                    SELECT id FROM (
                        SELECT id, strftime('%Y-%W', created_at) as week,
                               ROW_NUMBER() OVER (PARTITION BY strftime('%Y-%W', created_at) ORDER BY created_at DESC) as rn
                        FROM snapshots WHERE doc_id = ?1
                    ) WHERE rn = 1
                ) AND created_at < datetime(?2, '-7 days')
                LIMIT ?3",
                params![doc_id, now, over_cap],
            ).map_err(|e| e.to_string())?
        } else { 0 };

        Ok((deduped + thinned + weekly_thinned) as u64)
    }

    /// Prune snapshots for all docs (used by snapshot_delete_old command).
    pub fn snapshot_retention_prune_all(&self, retention_days: i64) -> Result<u64, String> {
        let doc_ids: Vec<String> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.prepare("SELECT DISTINCT doc_id FROM snapshots")
                .and_then(|mut stmt| {
                    let results = stmt.query_map([], |row| row.get(0))?
                        .filter_map(|r| r.ok()).collect();
                    Ok(results)
                })
                .unwrap_or_default()
        };

        let mut total = 0u64;
        for doc_id in &doc_ids {
            total += self.snapshot_retention_prune(doc_id, retention_days)?;
        }
        Ok(total)
    }
}

