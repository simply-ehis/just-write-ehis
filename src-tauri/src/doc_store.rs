use rusqlite::params;
use crate::database::Database;
use crate::models::*;
use chrono::Utc;
use uuid::Uuid;
use std::collections::HashMap;
use zerocopy::IntoBytes;
use tauri::Emitter;

fn uuid_v7() -> String {
    Uuid::new_v4().to_string()
}

/// Compute the on-disk path for a doc based on workspace, kind, title, and vault root.
/// Spec §3.1:
///   logs/            YYYY/MM/YYYY-MM-DD.md
///   write/           sessions & free docs
///   map/             (no folder — docs live in their homes)
///   novels/<name>/   chapters/ characters/ world/ notes/ snippets/ bible.md
///   scripts/<name>/  *.fountain + notes/
///   projects/<name>/ any structure
///   reader/          imported books + exports
///   inbox/           quick-captured snippets, untriaged
fn compute_disk_path(
    vault: &std::path::Path,
    workspace: &str,
    _kind: &str,
    title: &str,
    id: &str,
) -> std::path::PathBuf {
    match workspace {
        "logs" => {
            // Title is expected to be YYYY-MM-DD
            let date_part = if title.len() >= 10 { &title[..10] } else { title };
            let parts: Vec<&str> = date_part.split('-').collect();
            if parts.len() >= 3 {
                vault.join("logs").join(parts[0]).join(parts[1]).join(format!("{}.md", date_part))
            } else {
                vault.join("logs").join(format!("{}.md", id))
            }
        }
        "write" => {
            vault.join("write").join(format!("{}.md", id))
        }
        "novel" => {
            vault.join("novels").join(sanitize_filename(title)).join(format!("{}.md", id))
        }
        "script" => {
            vault.join("scripts").join(sanitize_filename(title)).join(format!("{}.md", id))
        }
        "projects" => {
            vault.join("projects").join(sanitize_filename(title)).join(format!("{}.md", id))
        }
        "reader" => {
            vault.join("reader").join(format!("{}.md", id))
        }
        "inbox" => {
            vault.join("inbox").join(format!("{}.md", id))
        }
        _ => {
            vault.join(workspace).join(format!("{}.md", id))
        }
    }
}

/// Sanitize a string for use as a directory/file name.
fn sanitize_filename(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => result.push('_'),
            ' ' => result.push('_'),
            _ => result.push(c),
        }
    }
    // Truncate to reasonable length
    if result.len() > 64 {
        result.truncate(64);
    }
    if result.is_empty() {
        result = "untitled".to_string();
    }
    result
}

/// Write content to disk atomically (temp file + rename).
fn write_to_disk(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
    }
    let temp = path.with_extension("tmp");
    std::fs::write(&temp, content.as_bytes()).map_err(|e| format!("Failed to write temp: {}", e))?;
    std::fs::rename(&temp, path).map_err(|e| format!("Failed to rename temp: {}", e))?;
    Ok(())
}

/// Compute SHA-256 content hash for snapshot deduplication.
fn compute_content_hash(content: &str) -> String {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};
    let mut hasher = DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

/// Count words that changed between two texts (simple diff).
fn word_diff_count(old: &str, new: &str) -> usize {
    let old_words: Vec<&str> = old.split_whitespace().collect();
    let new_words: Vec<&str> = new.split_whitespace().collect();
    // Simple: count words in new that aren't at the same position in old
    let mut changes = 0;
    let max_len = old_words.len().max(new_words.len());
    for i in 0..max_len {
        let o = old_words.get(i).copied().unwrap_or("");
        let n = new_words.get(i).copied().unwrap_or("");
        if o != n { changes += 1; }
    }
    changes
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

const EMBEDDING_DIM: usize = 256;

/// Simple TF-IDF-inspired vectorizer: hashes words into a fixed-size vector
fn text_to_embedding(text: &str) -> Vec<f32> {
    let mut vec = vec![0.0f32; EMBEDDING_DIM];
    let words: Vec<&str> = text.split_whitespace().collect();
    if words.is_empty() {
        return vec;
    }

    let mut word_counts: HashMap<String, usize> = HashMap::new();
    for word in &words {
        let normalized = word.to_lowercase()
            .chars()
            .filter(|c| c.is_alphanumeric())
            .collect::<String>();
        if !normalized.is_empty() && normalized.len() > 1 {
            *word_counts.entry(normalized).or_insert(0) += 1;
        }
    }

    for (word, count) in &word_counts {
        let hash: u32 = word.bytes().fold(0u32, |acc, b| acc.wrapping_mul(31).wrapping_add(b as u32));
        let pos = (hash as usize) % EMBEDDING_DIM;
        let weight = (1.0 + *count as f32).ln();
        vec[pos] += weight;
    }

    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in &mut vec {
            *x /= norm;
        }
    }

    vec
}

impl Database {
    pub fn create_doc(&self, req: CreateDocRequest) -> Result<Doc, String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        let content = req.content.unwrap_or_default();
        let word_count = content.split_whitespace().count() as i64;

        // Compute proper on-disk path
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
        let disk_path = compute_disk_path(&vault, &req.workspace, &req.kind, &req.title, &id);
        let path_str = disk_path.to_string_lossy().to_string();
        drop(vault);

        // Write content to disk
        if !content.is_empty() {
            write_to_disk(&disk_path, &content)?;
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT INTO docs (id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, status, frontmatter_json, activity_score)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 'draft', ?11, 0.0)",
            params![id, req.workspace, req.kind, req.title, path_str, req.parent_id, now, now, content, word_count, req.frontmatter_json],
        ).map_err(|e| e.to_string())?;

        let doc = Doc {
            id,
            workspace: req.workspace,
            kind: req.kind,
            title: req.title,
            path: path_str,
            parent_id: req.parent_id,
            created_at: now.clone(),
            updated_at: now,
            content,
            word_count,
            reading_position: None,
            status: "draft".to_string(),
            frontmatter_json: req.frontmatter_json,
            activity_score: 0.0,
            embedding_ref: None,
            pinned: false,
            goal_words: None,
            deadline: None,
            locked: false,
        };

        Ok(doc)
    }

    pub fn get_doc(&self, id: &str) -> Result<Doc, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.query_row(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
             FROM docs WHERE id = ?1",
            params![id],
            |row| {
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
            },
        ).map_err(|e| e.to_string())
    }

    pub fn get_doc_by_title(&self, title: &str) -> Result<Option<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
             FROM docs WHERE title = ?1 COLLATE NOCASE LIMIT 1",
            params![title],
            |row| {
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
            },
        );
        match result {
            Ok(doc) => Ok(Some(doc)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn save_doc(&self, req: SaveDocRequest) -> Result<Doc, String> {
        let content_changed = req.content.is_some();
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let now = Utc::now().to_rfc3339();

            if let Some(title) = &req.title {
                conn.execute(
                    "UPDATE docs SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![title, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(content) = &req.content {
                let word_count = content.split_whitespace().count() as i64;
                conn.execute(
                    "UPDATE docs SET content = ?1, word_count = ?2, updated_at = ?3 WHERE id = ?4",
                    params![content, word_count, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(status) = &req.status {
                conn.execute(
                    "UPDATE docs SET status = ?1, updated_at = ?2 WHERE id = ?3",
                    params![status, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(fm) = &req.frontmatter_json {
                conn.execute(
                    "UPDATE docs SET frontmatter_json = ?1, updated_at = ?2 WHERE id = ?3",
                    params![fm, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(parent_id) = &req.parent_id {
                conn.execute(
                    "UPDATE docs SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
                    params![parent_id, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
        }

        // Write content to disk if changed + auto-snapshot on meaningful diff
        if content_changed {
            let doc = self.get_doc(&req.id)?;

            // Check if diff is meaningful (>20 words changed) — auto-snapshot per A10.2
            if let Some(new_content) = &req.content {
                let old_word_count = doc.word_count as usize;
                let new_word_count = new_content.split_whitespace().count();
                let word_delta = (old_word_count as i64 - new_word_count as i64).abs();
                if word_delta > 20 {
                    let _ = self.snapshot_create(&req.id);
                    // Same throttle feeds retrieval: re-chunk only on real movement.
                    self.refresh_rag_chunks(&req.id);
                }
            }

            let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
            let disk_path = std::path::PathBuf::from(&doc.path);
            let full_path = if disk_path.is_absolute() { disk_path } else { vault.join(&doc.path) };
            drop(vault);
            let _ = write_to_disk(&full_path, &doc.content);
            let _ = self.extract_backlinks(&req.id, &doc.content);
        }

        self.get_doc(&req.id)
    }

    pub fn delete_doc(&self, id: &str) -> Result<(), String> {
        // 1. Collect the doc + all descendants (a deleted project takes its
        //    chapters/tasks; nothing orphans).
        let mut ids = vec![id.to_string()];
        let mut i = 0;
        while i < ids.len() {
            let parent = ids[i].clone();
            i += 1;
            let kids: Vec<String> = {
                let conn = self.conn.lock().map_err(|e| e.to_string())?;
                let mut stmt = conn
                    .prepare("SELECT id FROM docs WHERE parent_id = ?1")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![parent], |row| row.get(0))
                    .map_err(|e| e.to_string())?;
                rows.filter_map(|r| r.ok()).collect()
            };
            for k in kids {
                if !ids.contains(&k) {
                    ids.push(k);
                }
            }
        }

        // 2. Remove files (best-effort; a missing file is already gone).
        //    Files are the source of truth — a row-only delete would leave
        //    ghosts visible in Files and re-importable clutter.
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?.clone();
        for del_id in &ids {
            if let Ok(doc) = self.get_doc(del_id) {
                let p = std::path::PathBuf::from(&doc.path);
                let full = if p.is_absolute() { p } else { vault.join(&p) };
                let _ = std::fs::remove_file(&full);
            }
        }

        // 3. Delete rows. FK cascades (foreign_keys=ON) clean snapshots,
        //    usage, craft metrics, backlinks, links, rag chunks.
        //    Tables WITHOUT an FK get explicit cleanup below.
        {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            for del_id in &ids {
                conn.execute("DELETE FROM docs WHERE id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
            }
            for del_id in &ids {
                // bible_facts + conversations have no FK to docs.
                conn.execute("DELETE FROM bible_facts WHERE doc_id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM conversations WHERE doc_id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
                // Canvas cards keep existing; just unlink the dead doc.
                conn.execute("UPDATE canvas_nodes SET doc_id = NULL WHERE doc_id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
            }
            // Chunks cascade; vectors have no FK — sweep the orphans.
            let _ = conn.execute(
                "DELETE FROM rag_vec WHERE chunk_id NOT IN (SELECT id FROM rag_chunks)",
                [],
            );
        }
        Ok(())
    }

    pub fn toggle_pin(&self, id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let current: i64 = conn.query_row(
            "SELECT pinned FROM docs WHERE id = ?1", params![id], |r| r.get(0)
        ).map_err(|e| e.to_string())?;
        let new_val = if current == 0 { 1 } else { 0 };
        conn.execute("UPDATE docs SET pinned = ?1, updated_at = ?2 WHERE id = ?3",
            params![new_val, Utc::now().to_rfc3339(), id],
        ).map_err(|e| e.to_string())?;
        Ok(new_val != 0)
    }

    pub fn set_goal(&self, id: &str, goal_words: Option<i64>, deadline: Option<String>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE docs SET goal_words = ?1, deadline = ?2, updated_at = ?3 WHERE id = ?4",
            params![goal_words, deadline, Utc::now().to_rfc3339(), id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_locked(&self, id: &str, locked: bool) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE docs SET locked = ?1, updated_at = ?2 WHERE id = ?3",
            params![if locked { 1 } else { 0 }, Utc::now().to_rfc3339(), id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Pinned docs across all workspaces (Home quick-launch). Titles only
    /// travel here; opening content stays PIN-gated in the frontend.
    pub fn list_pinned_docs(&self) -> Result<Vec<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE pinned = 1 ORDER BY updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
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

        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    /// Canvas board: all cards + connections (A11.1).
    pub fn canvas_list(&self) -> Result<(Vec<CanvasNode>, Vec<CanvasEdge>), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut ns = conn.prepare(
            "SELECT id, title, body, x, y, color, doc_id, updated_at FROM canvas_nodes ORDER BY updated_at ASC"
        ).map_err(|e| e.to_string())?;
        let nodes: Vec<CanvasNode> = ns.query_map([], |row| {
            Ok(CanvasNode {
                id: row.get(0)?,
                title: row.get(1)?,
                body: row.get(2)?,
                x: row.get(3)?,
                y: row.get(4)?,
                color: row.get(5)?,
                doc_id: row.get(6)?,
                updated_at: row.get(7)?,
            })
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        let mut es = conn.prepare(
            "SELECT id, source_id, target_id, label FROM canvas_edges"
        ).map_err(|e| e.to_string())?;
        let edges: Vec<CanvasEdge> = es.query_map([], |row| {
            Ok(CanvasEdge {
                id: row.get(0)?,
                source_id: row.get(1)?,
                target_id: row.get(2)?,
                label: row.get(3)?,
            })
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok((nodes, edges))
    }

    /// Insert or update a card by id (empty id = create).
    pub fn canvas_upsert_node(&self, mut node: CanvasNode) -> Result<CanvasNode, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        if node.id.is_empty() {
            node.id = uuid_v7();
        }
        node.updated_at = now_iso();
        conn.execute(
            "INSERT INTO canvas_nodes (id, title, body, x, y, color, doc_id, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
             ON CONFLICT(id) DO UPDATE SET title = ?2, body = ?3, x = ?4, y = ?5, color = ?6, doc_id = ?7, updated_at = ?8",
            params![node.id, node.title, node.body, node.x, node.y, node.color, node.doc_id, node.updated_at],
        ).map_err(|e| e.to_string())?;
        Ok(node)
    }

    pub fn canvas_delete_node(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM canvas_edges WHERE source_id = ?1 OR target_id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM canvas_nodes WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn canvas_connect(&self, source_id: &str, target_id: &str, label: &str) -> Result<CanvasEdge, String> {
        if source_id == target_id {
            return Err("A card cannot connect to itself.".into());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM canvas_nodes WHERE id = ?1) AND EXISTS(SELECT 1 FROM canvas_nodes WHERE id = ?2)",
            params![source_id, target_id],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !exists {
            return Err("Both cards must exist.".into());
        }
        let edge = CanvasEdge {
            id: uuid_v7(),
            source_id: source_id.to_string(),
            target_id: target_id.to_string(),
            label: label.to_string(),
        };
        conn.execute(
            "INSERT INTO canvas_edges (id, source_id, target_id, label) VALUES (?1, ?2, ?3, ?4)",
            params![edge.id, edge.source_id, edge.target_id, edge.label],
        ).map_err(|e| e.to_string())?;
        Ok(edge)
    }

    pub fn canvas_delete_edge(&self, id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM canvas_edges WHERE id = ?1", params![id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Today's usage-event counts per hour (0-23) for the streak sparkline.
    pub fn today_rhythm(&self) -> Result<Vec<(i64, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT CAST(strftime('%H', ts) AS INTEGER) AS hour, COUNT(*) FROM usage_events WHERE date(ts) = date('now') GROUP BY hour"
        ).map_err(|e| e.to_string())?;
        let mut buckets = vec![0i64; 24];
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows.filter_map(|r| r.ok()) {
            if (0..24).contains(&r.0) {
                buckets[r.0 as usize] = r.1;
            }
        }
        Ok(buckets.into_iter().enumerate().map(|(h, c)| (h as i64, c)).collect())
    }

    pub fn move_doc(&self, req: MoveDocRequest) -> Result<Doc, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();

        if let Some(parent_id) = &req.new_parent_id {
            conn.execute(
                "UPDATE docs SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![parent_id, now, req.id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(path) = &req.new_path {
            conn.execute(
                "UPDATE docs SET path = ?1, updated_at = ?2 WHERE id = ?3",
                params![path, now, req.id],
            ).map_err(|e| e.to_string())?;
        }

        self.get_doc(&req.id)
    }

    pub fn search_docs(&self, query: &str, workspace: Option<&str>) -> Result<Vec<SearchResult>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let search_term = format!("%{}%", query);

        let mut stmt = if let Some(ws) = workspace {
            let mut s = conn.prepare(
                 "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
                  FROM docs WHERE workspace = ?1 AND locked = 0 AND (title LIKE ?2 OR path LIKE ?2)
                  ORDER BY updated_at DESC LIMIT 50"
            ).map_err(|e| e.to_string())?;
            let rows = s.query_map(params![ws, search_term], |row| {
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
            rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
        } else {
            let mut s = conn.prepare(
                 "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
                  FROM docs WHERE locked = 0 AND (title LIKE ?1 OR path LIKE ?1)
                  ORDER BY updated_at DESC LIMIT 50"
            ).map_err(|e| e.to_string())?;
            let rows = s.query_map(params![search_term], |row| {
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
            rows.filter_map(|r| r.ok()).collect::<Vec<_>>()
        };

        Ok(stmt.drain(..).map(|doc| SearchResult {
            rank: doc.activity_score,
            snippet: None,
            doc,
        }).collect())
    }

    pub fn list_docs_by_workspace(&self, workspace: &str) -> Result<Vec<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
             FROM docs WHERE workspace = ?1 ORDER BY pinned DESC, updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![workspace], |row| {
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

        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    pub fn get_backlinks(&self, doc_id: &str) -> Result<Vec<Backlink>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT source_id, target_id, context_snippet FROM backlinks WHERE target_id = ?1"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![doc_id], |row| {
            Ok(Backlink {
                source_id: row.get(0)?,
                target_id: row.get(1)?,
                context_snippet: row.get(2)?,
            })
        }).map_err(|e| e.to_string())?;

        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    pub fn record_usage_event(&self, doc_id: &str, event: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO usage_events (doc_id, event, ts) VALUES (?1, ?2, ?3)",
            params![doc_id, event, now],
        ).map_err(|e| e.to_string())?;

        // Spec 8.2: weighted bumps — edits count most, reads least.
        let weight: f64 = match event {
            "edit" | "write" => 2.0,
            "ai_call" => 1.5,
            "open" => 1.0,
            "read" => 0.5,
            _ => 1.0,
        };
        conn.execute(
            "UPDATE docs SET activity_score = activity_score + ?1 WHERE id = ?2",
            params![weight, doc_id],
        ).map_err(|e| e.to_string())?;

        Ok(())
    }

    pub fn get_tab_state(&self, workspace: &str) -> Result<Option<TabState>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let result = conn.query_row(
            "SELECT workspace, tab_stack_json, active_id, cursor, scroll FROM tab_state WHERE workspace = ?1",
            params![workspace],
            |row| {
                Ok(TabState {
                    workspace: row.get(0)?,
                    tab_stack_json: row.get(1)?,
                    active_id: row.get(2)?,
                    cursor: row.get(3)?,
                    scroll: row.get(4)?,
                })
            },
        );

        match result {
            Ok(state) => Ok(Some(state)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn set_tab_state(&self, state: TabState) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "INSERT OR REPLACE INTO tab_state (workspace, tab_stack_json, active_id, cursor, scroll)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![state.workspace, state.tab_stack_json, state.active_id, state.cursor, state.scroll],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn log_get_or_create(&self, date: &str) -> Result<Doc, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let result = conn.query_row(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
             FROM docs WHERE workspace = 'logs' AND kind = 'daily' AND title = ?1",
            params![date],
            |row| {
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
            },
        );

        match result {
            Ok(doc) => Ok(doc),
            Err(rusqlite::Error::QueryReturnedNoRows) => {
                drop(conn);
                self.create_doc(CreateDocRequest {
                    workspace: "logs".to_string(),
                    kind: "daily".to_string(),
                    title: date.to_string(),
                    parent_id: None,
                    content: Some(format!("# {}\n\n", date)),
                    frontmatter_json: None,
                })
            }
            Err(e) => Err(e.to_string()),
        }
    }

    pub fn log_list_entries(&self, limit: i64) -> Result<Vec<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
             FROM docs WHERE workspace = 'logs' AND kind = 'daily'
             ORDER BY title DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![limit], |row| {
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

        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    pub fn extract_backlinks(&self, doc_id: &str, content: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        conn.execute("DELETE FROM backlinks WHERE source_id = ?1", params![doc_id])
            .map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM links_implicit WHERE source_id = ?1", params![doc_id])
            .map_err(|e| e.to_string())?;

        let all_docs: Vec<(String, String)> = {
            let mut stmt = conn.prepare("SELECT id, title FROM docs").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let wiki_re = regex::Regex::new(r"\[\[([^\]]+)\]\]").map_err(|e| e.to_string())?;
        let title_to_id: std::collections::HashMap<String, String> = all_docs.iter()
            .map(|(id, title)| (title.to_lowercase(), id.clone()))
            .collect();

        for cap in wiki_re.captures_iter(content) {
            let link_text = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let link_lower = link_text.to_lowercase();
            if let Some(target_id) = title_to_id.get(&link_lower) {
                if target_id != doc_id {
                    let start = cap.get(0).map(|m| m.start()).unwrap_or(0);
                    let snippet = content[start.saturating_sub(40)..std::cmp::min(content.len(), start + cap.get(0).map(|m| m.len()).unwrap_or(0) + 40)].to_string();
                    conn.execute(
                        "INSERT OR IGNORE INTO backlinks (source_id, target_id, context_snippet) VALUES (?1, ?2, ?3)",
                        params![doc_id, target_id, snippet],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }

        for (title, target_id) in &title_to_id {
            if target_id == doc_id { continue; }
            if content.to_lowercase().contains(title) && !wiki_re.is_match(content) {
                conn.execute(
                    "INSERT OR IGNORE INTO links_implicit (source_id, target_id, match_type) VALUES (?1, ?2, ?3)",
                    params![doc_id, target_id, "title_mention"],
                ).map_err(|e| e.to_string())?;
            }
        }

        Ok(())
    }

    pub fn graph_query(&self) -> Result<GraphQueryResult, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT id, title, workspace, kind, word_count, activity_score FROM docs"
        ).map_err(|e| e.to_string())?;

        let docs: Vec<(String, String, String, String, i64, f64)> = {
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, f64>(5)?))
            }).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut edge_stmt = conn.prepare(
            "SELECT source_id, target_id, context_snippet FROM backlinks"
        ).map_err(|e| e.to_string())?;

        let backlink_edges: Vec<(String, String, String)> = {
            let rows = edge_stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            }).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut implicit_stmt = conn.prepare(
            "SELECT source_id, target_id, match_type FROM links_implicit"
        ).map_err(|e| e.to_string())?;

        let implicit_edges: Vec<(String, String, String)> = {
            let rows = implicit_stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
            }).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let mut degree_map: std::collections::HashMap<String, i64> = std::collections::HashMap::new();
        for (src, tgt, _) in &backlink_edges {
            *degree_map.entry(src.clone()).or_insert(0) += 1;
            *degree_map.entry(tgt.clone()).or_insert(0) += 1;
        }
        for (src, tgt, _) in &implicit_edges {
            *degree_map.entry(src.clone()).or_insert(0) += 1;
            *degree_map.entry(tgt.clone()).or_insert(0) += 1;
        }

        let nodes: Vec<GraphNode> = docs.iter().map(|(id, title, workspace, kind, wc, score)| {
            GraphNode {
                id: id.clone(),
                title: title.clone(),
                workspace: workspace.clone(),
                kind: kind.clone(),
                word_count: *wc,
                activity_score: *score,
                degree: degree_map.get(id).copied().unwrap_or(0),
            }
        }).collect();

        let mut edges: Vec<GraphEdge> = backlink_edges.iter().map(|(src, tgt, ctx)| {
            GraphEdge {
                source: src.clone(),
                target: tgt.clone(),
                kind: "backlink".to_string(),
                context_snippet: Some(ctx.clone()),
            }
        }).collect();

        for (src, tgt, mt) in &implicit_edges {
            edges.push(GraphEdge {
                source: src.clone(),
                target: tgt.clone(),
                kind: mt.clone(),
                context_snippet: None,
            });
        }

        let node_ids: std::collections::HashSet<String> = docs.iter().map(|(id, _, _, _, _, _)| id.clone()).collect();
        let connected: std::collections::HashSet<String> = edges.iter()
            .flat_map(|e| vec![e.source.clone(), e.target.clone()])
            .collect();
        let orphans: Vec<String> = node_ids.iter()
            .filter(|id| !connected.contains(*id))
            .cloned()
            .collect();

        let mut hubs: Vec<(String, i64)> = degree_map.iter()
            .filter(|(_, deg)| **deg >= 3)
            .map(|(id, deg)| (id.clone(), *deg))
            .collect();
        hubs.sort_by(|a, b| b.1.cmp(&a.1));
        hubs.truncate(20);

        Ok(GraphQueryResult { nodes, edges, orphans, hubs })
    }

    pub fn get_unlinked_mentions(&self, doc_id: &str) -> Result<Vec<UnlinkedMention>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let doc = self.get_doc(doc_id)?;
        let content_lower = doc.content.to_lowercase();

        let all_docs: Vec<(String, String)> = {
            let mut stmt = conn.prepare("SELECT id, title FROM docs WHERE id != ?1").map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![doc_id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        let wiki_re = regex::Regex::new(r"\[\[([^\]]+)\]\]").map_err(|e| e.to_string())?;
        let linked_titles: Vec<String> = wiki_re.captures_iter(&doc.content)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_lowercase()))
            .collect();

        let mut mentions = Vec::new();
        for (_other_id, other_title) in &all_docs {
            let title_lower = other_title.to_lowercase();
            if content_lower.contains(&title_lower) && !linked_titles.contains(&title_lower) {
                let pos = content_lower.find(&title_lower).unwrap_or(0);
                let snippet = doc.content[pos.saturating_sub(40)..std::cmp::min(doc.content.len(), pos + other_title.len() + 40)].to_string();
                mentions.push(UnlinkedMention {
                    source_id: doc_id.to_string(),
                    source_title: doc.title.clone(),
                    mentioned_title: other_title.clone(),
                    context_snippet: snippet,
                });
            }
        }

        Ok(mentions)
    }

    pub fn update_reading_position(&self, doc_id: &str, position: f64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE docs SET reading_position = ?1 WHERE id = ?2",
            params![position, doc_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_bookshelf_status(&self, doc_id: &str, status: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE docs SET status = ?1 WHERE id = ?2",
            params![status, doc_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn set_book_rating(&self, doc_id: &str, rating: Option<i64>) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let fm = rating.map(|r| serde_json::json!({"rating": r}).to_string());
        conn.execute(
            "UPDATE docs SET frontmatter_json = ?1 WHERE id = ?2",
            params![fm, doc_id],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_bookshelf(&self, shelf_filter: Option<&str>) -> Result<Vec<BookshelfEntry>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let query: &str = match shelf_filter {
            Some("to-read") => "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE workspace = 'reader' AND status = 'to-read' ORDER BY updated_at DESC",
            Some("reading") => "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE workspace = 'reader' AND status = 'reading' ORDER BY updated_at DESC",
            Some("finished") => "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE workspace = 'reader' AND status = 'finished' ORDER BY updated_at DESC",
            _ => "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE workspace = 'reader' ORDER BY updated_at DESC",
        };

        let mut stmt = conn.prepare(query).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
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

        let entries: Vec<BookshelfEntry> = rows.filter_map(|r| r.ok()).map(|doc| {
            let rating = doc.frontmatter_json.as_ref().and_then(|fm| {
                serde_json::from_str::<serde_json::Value>(fm).ok().and_then(|v| v.get("rating")?.as_i64())
            });
            BookshelfEntry {
                shelf_status: doc.status.clone(),
                rating,
                doc,
            }
        }).collect();

        Ok(entries)
    }

    pub fn import_book(&self, title: &str, content: &str, kind: &str) -> Result<Doc, String> {
        self.create_doc(CreateDocRequest {
            workspace: "reader".to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
            parent_id: None,
            content: Some(content.to_string()),
            frontmatter_json: Some(serde_json::json!({"status": "to-read"}).to_string()),
        })
    }

    pub fn bible_get_facts(&self, doc_id: &str) -> Result<Vec<BibleFact>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, doc_id, kind, key, value FROM bible_facts WHERE doc_id = ?1 ORDER BY kind, key"
        ).map_err(|e| e.to_string())?;

        let facts = stmt.query_map(params![doc_id], |row| {
            Ok(BibleFact {
                id: row.get(0)?,
                doc_id: row.get(1)?,
                kind: row.get(2)?,
                key: row.get(3)?,
                value: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(facts)
    }

    pub fn bible_upsert_fact(&self, doc_id: &str, kind: &str, key: &str, value: &str) -> Result<BibleFact, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid_v7();
        conn.execute(
            "INSERT OR REPLACE INTO bible_facts (id, doc_id, kind, key, value) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, doc_id, kind, key, value],
        ).map_err(|e| e.to_string())?;
        Ok(BibleFact { id, doc_id: doc_id.to_string(), kind: kind.to_string(), key: key.to_string(), value: value.to_string() })
    }

    pub fn bible_delete_fact(&self, fact_id: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM bible_facts WHERE id = ?1", params![fact_id])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_beat_board(&self, project_id: &str) -> Result<BeatBoard, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE parent_id = ?1 ORDER BY updated_at ASC"
        ).map_err(|e| e.to_string())?;

        let docs: Vec<Doc> = stmt.query_map(params![project_id], |row| {
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
            .filter_map(|r| r.ok())
            .collect();

        let mut acts = Vec::new();
        let mut sequences = Vec::new();
        let mut scenes = Vec::new();

        for doc in docs {
            let fm: serde_json::Value = doc.frontmatter_json.as_ref()
                .and_then(|s| serde_json::from_str(s).ok())
                .unwrap_or(serde_json::json!({}));

            let beat = BeatNode {
                doc: doc.clone(),
                act: fm.get("act").and_then(|v| v.as_i64()),
                sequence: fm.get("sequence").and_then(|v| v.as_i64()),
                status: fm.get("status").and_then(|v| v.as_str()).unwrap_or("idea").to_string(),
                summary: fm.get("summary").and_then(|v| v.as_str()).map(String::from),
                pov: fm.get("pov").and_then(|v| v.as_str()).map(String::from),
                location: fm.get("location").and_then(|v| v.as_str()).map(String::from),
                timeframe: fm.get("timeframe").and_then(|v| v.as_str()).map(String::from),
                characters: fm.get("characters").and_then(|v| v.as_array()).map(|a| {
                    a.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                }).unwrap_or_default(),
            };

            match doc.kind.as_str() {
                "act" => acts.push(beat),
                "sequence" => sequences.push(beat),
                _ => scenes.push(beat),
            }
        }

        // Manual arrangement = compile order: drag-reorder on the board
        // persists frontmatter `order`; ties keep updated_at (creation) order.
        acts.sort_by(|a, b| Self::beat_order_static(&a.doc).partial_cmp(&Self::beat_order_static(&b.doc)).unwrap_or(std::cmp::Ordering::Equal));
        sequences.sort_by(|a, b| {
            (a.act, Self::beat_order_static(&a.doc)).partial_cmp(&(b.act, Self::beat_order_static(&b.doc))).unwrap_or(std::cmp::Ordering::Equal)
        });
        scenes.sort_by(|a, b| {
            (a.act, a.sequence, Self::beat_order_static(&a.doc)).partial_cmp(&(b.act, b.sequence, Self::beat_order_static(&b.doc))).unwrap_or(std::cmp::Ordering::Equal)
        });

        Ok(BeatBoard { acts, sequences, scenes })
    }

    /// Frontmatter `order` set by board drag-reorder; missing = 0.0 (creation order wins ties).
    fn beat_order_static(doc: &Doc) -> f64 {
        doc.frontmatter_json.as_ref()
            .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
            .and_then(|v| v.get("order").and_then(|o| o.as_f64()))
            .unwrap_or(0.0)
    }

    pub fn compile_beats(&self, project_id: &str) -> Result<String, String> {
        let board = self.get_beat_board(project_id)?;
        let mut output = String::new();

        for act in &board.acts {
            output.push_str(&format!("{}\n\n", act.doc.title));
            for seq in board.sequences.iter().filter(|s| s.act == act.act) {
                output.push_str(&format!("  {}\n", seq.doc.title));
                for scene in board.scenes.iter().filter(|sc| sc.act == act.act && sc.sequence == seq.sequence) {
                    if !scene.doc.content.is_empty() {
                        output.push_str(&format!("    {}\n\n", scene.doc.content));
                    }
                }
            }
        }

        if output.is_empty() {
            for scene in &board.scenes {
                if !scene.doc.content.is_empty() {
                    output.push_str(&scene.doc.content);
                    output.push_str("\n\n");
                }
            }
        }

        Ok(output)
    }

    pub fn conversation_create(&self, doc_id: Option<&str>, mode: &str) -> Result<Conversation, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid_v7();
        let now = now_iso();
        conn.execute(
            "INSERT INTO conversations (id, doc_id, mode, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, doc_id, mode, now, now],
        ).map_err(|e| e.to_string())?;
        Ok(Conversation { id, doc_id: doc_id.map(String::from), mode: mode.to_string(), created_at: now.clone(), updated_at: now })
    }

    pub fn conversation_list(&self) -> Result<Vec<Conversation>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, doc_id, mode, created_at, updated_at FROM conversations ORDER BY updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let convos = stmt.query_map([], |row| {
            Ok(Conversation {
                id: row.get(0)?,
                doc_id: row.get(1)?,
                mode: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(convos)
    }

    pub fn conversation_add_message(&self, conversation_id: &str, role: &str, content: &str) -> Result<ChatMessage, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid_v7();
        let now = now_iso();
        conn.execute(
            "INSERT INTO chat_messages (id, conversation_id, role, content, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, conversation_id, role, content, now],
        ).map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE conversations SET updated_at = ?1 WHERE id = ?2",
            params![now, conversation_id],
        ).map_err(|e| e.to_string())?;
        Ok(ChatMessage { id, conversation_id: conversation_id.to_string(), role: role.to_string(), content: content.to_string(), created_at: now })
    }

    pub fn conversation_get_messages(&self, conversation_id: &str) -> Result<Vec<ChatMessage>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, conversation_id, role, content, created_at FROM chat_messages WHERE conversation_id = ?1 ORDER BY created_at ASC"
        ).map_err(|e| e.to_string())?;

        let messages = stmt.query_map(params![conversation_id], |row| {
            Ok(ChatMessage {
                id: row.get(0)?,
                conversation_id: row.get(1)?,
                role: row.get(2)?,
                content: row.get(3)?,
                created_at: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(messages)
    }

    pub fn decay_activity_scores(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = now_iso();
        let updated = conn.execute(
            "UPDATE docs SET activity_score = MAX(0, activity_score * 0.95) WHERE updated_at < datetime(?1, '-7 days')",
            params![now],
        ).map_err(|e| e.to_string())?;
        Ok(updated as u64)
    }

    pub fn get_smart_tabs(&self, workspace: &str) -> Result<Vec<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE workspace = ?1 AND locked = 0 ORDER BY activity_score DESC, updated_at DESC LIMIT 20"
        ).map_err(|e| e.to_string())?;

        let docs = stmt.query_map(params![workspace], |row| {
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
            .filter_map(|r| r.ok())
            .collect();

        Ok(docs)
    }

    pub fn record_craft_metric(&self, doc_id: &str, metric_type: &str, value: f64) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let id = uuid_v7();
        let now = now_iso();
        conn.execute(
            "INSERT INTO craft_metrics (id, doc_id, metric_type, value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![id, doc_id, metric_type, value, now],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn get_craft_metrics(&self, doc_id: &str) -> Result<Vec<(String, f64, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT metric_type, value, created_at FROM craft_metrics WHERE doc_id = ?1 ORDER BY created_at DESC"
        ).map_err(|e| e.to_string())?;

        let metrics = stmt.query_map(params![doc_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, String>(2)?))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(metrics)
    }

    pub fn get_craft_metrics_trend(&self, doc_id: &str, metric_type: &str) -> Result<Vec<(String, f64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT date(created_at) as day, AVG(value) FROM craft_metrics WHERE doc_id = ?1 AND metric_type = ?2 GROUP BY day ORDER BY day"
        ).map_err(|e| e.to_string())?;

        let trend = stmt.query_map(params![doc_id, metric_type], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(trend)
    }

    pub fn get_writing_streak(&self) -> Result<(i64, i64), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT date(ts) as day FROM usage_events WHERE event = 'write' ORDER BY day DESC"
        ).map_err(|e| e.to_string())?;

        let days: Vec<String> = stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut streak: i64 = 0;
        let today = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let mut expected = today.clone();

        for day in &days {
            if day == &expected {
                streak += 1;
                if let Ok(dt) = chrono::NaiveDate::parse_from_str(&expected, "%Y-%m-%d") {
                    expected = (dt - chrono::Duration::days(1)).format("%Y-%m-%d").to_string();
                }
            } else {
                break;
            }
        }

        let total_words: i64 = conn.query_row(
            "SELECT COALESCE(SUM(word_count), 0) FROM docs WHERE workspace IN ('write', 'novel', 'script')",
            [],
            |row| row.get(0),
        ).map_err(|e| e.to_string())?;

        Ok((streak, total_words))
    }

    pub fn snapshot_create(&self, doc_id: &str) -> Result<Snapshot, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let doc = {
            let mut stmt = conn.prepare(
                "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked FROM docs WHERE id = ?1"
            ).map_err(|e| e.to_string())?;
            stmt.query_row(params![doc_id], |row| {
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

        let hash = compute_content_hash(&doc.content);

        // Dedup: skip if content_hash matches the most recent snapshot
        let last_hash: Option<String> = conn.query_row(
            "SELECT content_hash FROM snapshots WHERE doc_id = ?1 ORDER BY created_at DESC LIMIT 1",
            params![doc_id],
            |row| row.get(0),
        ).unwrap_or(None);

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
        let word_count = doc.content.split_whitespace().count() as i64;
        let label = format!("v{}", now.split('T').next().unwrap_or(&now));

        conn.execute(
            "INSERT INTO snapshots (id, doc_id, label, content, word_count, content_hash, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![id, doc_id, label, doc.content, word_count, hash, now],
        ).map_err(|e| e.to_string())?;

        Ok(Snapshot { id, doc_id: doc_id.to_string(), label, content: Some(doc.content), word_count, content_hash: Some(hash), created_at: now })
    }

    pub fn snapshot_list(&self, doc_id: &str) -> Result<Vec<Snapshot>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, doc_id, label, content, word_count, content_hash, created_at FROM snapshots WHERE doc_id = ?1 ORDER BY created_at DESC"
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

        // Write restored content to disk
        drop(conn);
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
        let disk_path = std::path::PathBuf::from(&doc.path);
        let full_path = if disk_path.is_absolute() { disk_path } else { vault.join(&doc.path) };
        drop(vault);
        let _ = write_to_disk(&full_path, &doc.content);

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

    pub fn backup_create(&self) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let backup_dir = dirs::data_local_dir()
            .unwrap_or_default()
            .join("writing-app")
            .join("backups");
        std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_path = backup_dir.join(format!("backup_{}.db", timestamp));

        // Use VACUUM INTO for backup (SQLite 3.27.0+)
        conn.execute_batch(&format!("VACUUM INTO '{}';", backup_path.to_string_lossy()))
            .map_err(|e| e.to_string())?;

        Ok(backup_path.to_string_lossy().to_string())
    }

    pub fn backup_list(&self) -> Result<Vec<(String, String, u64)>, String> {
        let backup_dir = dirs::data_local_dir()
            .unwrap_or_default()
            .join("writing-app")
            .join("backups");

        if !backup_dir.exists() {
            return Ok(Vec::new());
        }

        let mut backups = Vec::new();
        for entry in std::fs::read_dir(&backup_dir).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("db") {
                let name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
                let metadata = std::fs::metadata(&path).map_err(|e| e.to_string())?;
                let size = metadata.len();
                let modified = metadata.modified()
                    .map(|t| {
                        let dt: chrono::DateTime<chrono::Utc> = t.into();
                        dt.format("%Y-%m-%d %H:%M:%S").to_string()
                    })
                    .unwrap_or_default();
                backups.push((name, modified, size));
            }
        }

        backups.sort_by(|a, b| b.1.cmp(&a.1));
        Ok(backups)
    }

    pub fn rag_chunk_document(&self, doc_id: &str, chunk_size: usize, overlap: usize) -> Result<Vec<RagChunk>, String> {
        let doc = self.get_doc(doc_id)?;
        let content = doc.content;
        let words: Vec<&str> = content.split_whitespace().collect();

        if words.len() < chunk_size {
            let chunk_text = content.clone();
            let embedding = text_to_embedding(&chunk_text);
            let chunk = RagChunk {
                id: format!("{}-0", doc_id),
                doc_id: doc_id.to_string(),
                chunk_index: 0,
                content: chunk_text,
                start_word: 0,
                end_word: words.len(),
            };
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO rag_chunks (id, doc_id, chunk_index, content, start_word, end_word) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![chunk.id, chunk.doc_id, chunk.chunk_index, chunk.content, chunk.start_word, chunk.end_word],
            ).map_err(|e| e.to_string())?;
            conn.execute(
                "INSERT OR REPLACE INTO rag_vec (chunk_id, embedding) VALUES (?1, ?2)",
                params![chunk.id, embedding.as_bytes()],
            ).map_err(|e| e.to_string())?;
            return Ok(vec![chunk]);
        }

        let mut chunks = Vec::new();
        let mut start = 0;
        let mut chunk_index = 0;

        while start < words.len() {
            let end = std::cmp::min(start + chunk_size, words.len());
            let chunk_text = words[start..end].join(" ");
            let chunk = RagChunk {
                id: format!("{}-{}", doc_id, chunk_index),
                doc_id: doc_id.to_string(),
                chunk_index,
                content: chunk_text,
                start_word: start,
                end_word: end,
            };
            chunks.push(chunk);
            chunk_index += 1;
            start += chunk_size - overlap;
            if start + overlap >= words.len() {
                break;
            }
        }

        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        for chunk in &chunks {
            conn.execute(
                "INSERT OR REPLACE INTO rag_chunks (id, doc_id, chunk_index, content, start_word, end_word) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![chunk.id, chunk.doc_id, chunk.chunk_index, chunk.content, chunk.start_word, chunk.end_word],
            ).map_err(|e| e.to_string())?;
            let emb = text_to_embedding(&chunk.content);
            conn.execute(
                "INSERT OR REPLACE INTO rag_vec (chunk_id, embedding) VALUES (?1, ?2)",
                params![chunk.id, emb.as_bytes()],
            ).map_err(|e| e.to_string())?;
        }

        Ok(chunks)
    }

    /// Rebuild one doc's retrieval chunks after a meaningful edit.
    /// Best-effort by design: a stale index is worse than none, but a
    /// failed re-chunk must never fail the save that triggered it.
    fn refresh_rag_chunks(&self, doc_id: &str) {
        let count = match self.rag_chunk_document(doc_id, 200, 50) {
            Ok(chunks) => chunks.len() as i64,
            Err(_) => return,
        };
        if let Ok(conn) = self.conn.lock() {
            // Drop chunks orphaned by shrinkage + vectors pointing nowhere.
            let _ = conn.execute(
                "DELETE FROM rag_chunks WHERE doc_id = ?1 AND chunk_index >= ?2",
                params![doc_id, count],
            );
            let _ = conn.execute(
                "DELETE FROM rag_vec WHERE chunk_id NOT IN (SELECT id FROM rag_chunks)",
                [],
            );
        }
    }

    pub fn rag_search(&self, query: &str, limit: usize) -> Result<Vec<(RagChunk, f64)>, String> {
        let query_emb = text_to_embedding(query);
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Try semantic search via sqlite-vec first
        let semantic_results: Vec<(String, f64)> = {
            let mut stmt = conn.prepare(
                "SELECT chunk_id, distance FROM rag_vec WHERE embedding MATCH ?1 ORDER BY distance LIMIT ?2"
            ).map_err(|e| e.to_string())?;

            let rows = stmt.query_map(params![query_emb.as_bytes(), limit as i64], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?))
            }).map_err(|e| e.to_string())?;

            rows.filter_map(|r| r.ok()).collect()
        };

        // Locked docs never surface in AI retrieval.
        let locked_ids: std::collections::HashSet<String> = {
            let mut s = conn.prepare("SELECT id FROM docs WHERE locked = 1").map_err(|e| e.to_string())?;
            let rows = s.query_map([], |row| row.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        // Fall back to keyword search if no semantic results
        if semantic_results.is_empty() {
            let mut stmt = conn.prepare(
                "SELECT c.id, c.doc_id, c.chunk_index, c.content, c.start_word, c.end_word FROM rag_chunks c JOIN docs d ON d.id = c.doc_id WHERE d.locked = 0 AND c.content LIKE '%' || ?1 || '%' LIMIT ?2"
            ).map_err(|e| e.to_string())?;

            let query_lower = query.to_lowercase();
            let chunks: Vec<RagChunk> = stmt.query_map(params![query, limit as i64], |row| {
                Ok(RagChunk {
                    id: row.get(0)?,
                    doc_id: row.get(1)?,
                    chunk_index: row.get(2)?,
                    content: row.get(3)?,
                    start_word: row.get(4)?,
                    end_word: row.get(5)?,
                })
            }).map_err(|e| e.to_string())?
                .filter_map(|r| r.ok())
                .collect();

            let scored: Vec<(RagChunk, f64)> = chunks.into_iter().map(|c| {
                let content_lower = c.content.to_lowercase();
                let matches = content_lower.matches(&query_lower).count();
                let score = (matches as f64) / (c.content.split_whitespace().count() as f64 + 1.0);
                (c, score)
            }).collect();

            let mut sorted = scored;
            sorted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            sorted.truncate(limit);
            return Ok(sorted);
        }

        // Fetch chunk data for semantic results
        let mut results = Vec::new();
        for (chunk_id, distance) in semantic_results {
            let chunk: RagChunk = conn.query_row(
                "SELECT id, doc_id, chunk_index, content, start_word, end_word FROM rag_chunks WHERE id = ?1",
                params![chunk_id],
                |row| {
                    Ok(RagChunk {
                        id: row.get(0)?,
                        doc_id: row.get(1)?,
                        chunk_index: row.get(2)?,
                        content: row.get(3)?,
                        start_word: row.get(4)?,
                        end_word: row.get(5)?,
                    })
                },
            ).map_err(|e| e.to_string())?;
            if locked_ids.contains(&chunk.doc_id) {
                continue;
            }
            // Convert distance to similarity score (lower distance = more similar)
            let score = 1.0 / (1.0 + distance);
            results.push((chunk, score));
        }

        Ok(results)
    }

    pub fn rag_get_context(&self, doc_id: &str, query: &str, max_chunks: usize) -> Result<String, String> {
        let results = self.rag_search(query, max_chunks)?;
        let context: Vec<String> = results.iter()
            .filter(|(c, _)| c.doc_id == doc_id)
            .map(|(c, _)| c.content.clone())
            .collect();

        if context.is_empty() {
            let all_results = self.rag_search(query, max_chunks)?;
            Ok(all_results.into_iter().map(|(c, _)| c.content).collect::<Vec<_>>().join("\n\n"))
        } else {
            Ok(context.join("\n\n"))
        }
    }

    pub fn dashboard_recent_docs(&self, limit: i64) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, title, updated_at FROM docs WHERE locked = 0 ORDER BY updated_at DESC LIMIT ?1"
        ).map_err(|e| e.to_string())?;

        let docs = stmt.query_map(params![limit], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(docs)
    }

    pub fn dashboard_workspace_counts(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT workspace, COUNT(*) FROM docs WHERE locked = 0 GROUP BY workspace ORDER BY COUNT(*) DESC"
        ).map_err(|e| e.to_string())?;

        let counts = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(counts)
    }

    pub fn dashboard_writing_days(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT DISTINCT date(u.ts) as day FROM usage_events u JOIN docs d ON d.id = u.doc_id WHERE u.event = 'write' AND d.locked = 0 ORDER BY day DESC LIMIT 90"
        ).map_err(|e| e.to_string())?;

        let days = stmt.query_map([], |row| row.get(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(days)
    }

    pub fn dashboard_patterns(&self) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let peak_hour: Option<String> = conn
            .query_row(
                "SELECT strftime('%H', u.ts) as hour FROM usage_events u JOIN docs d ON d.id = u.doc_id WHERE u.event = 'write' AND d.locked = 0 AND u.ts >= date('now', '-30 days') GROUP BY hour ORDER BY COUNT(*) DESC LIMIT 1",
                [],
                |r| r.get(0),
            )
            .ok();

        let most_active_ws: Option<(String, i64, i64)> = conn
            .query_row(
                "SELECT workspace, \
                 SUM(CASE WHEN created_at >= date('now', '-7 days') THEN 1 ELSE 0 END) as this_week, \
                 SUM(CASE WHEN created_at >= date('now', '-14 days') AND created_at < date('now', '-7 days') THEN 1 ELSE 0 END) as last_week \
                 FROM docs WHERE locked = 0 AND updated_at >= date('now', '-14 days') GROUP BY workspace ORDER BY this_week DESC LIMIT 1",
                [],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
            )
            .ok();

        let this_week_words: i64 = conn
            .query_row(
                "SELECT COALESCE(SUM(word_count), 0) FROM docs WHERE locked = 0 AND updated_at >= date('now', '-7 days')",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0);

        let avg_weekly_words: f64 = conn
            .query_row(
                "SELECT COALESCE(AVG(weekly_total), 0) FROM ( \
                 SELECT date(updated_at) as day, SUM(word_count) as weekly_total FROM docs \
                 WHERE locked = 0 AND updated_at >= date('now', '-35 days') GROUP BY strftime('%W', updated_at) \
                 )",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0.0);

        let momentum = if avg_weekly_words > 0.0 {
            ((this_week_words as f64 - avg_weekly_words) / avg_weekly_words * 100.0).round()
        } else {
            0.0
        };

        let avg_session_min: f64 = conn
            .query_row(
                "SELECT COALESCE(AVG(CAST((julianday(ended_at) - julianday(started_at)) * 1440 AS REAL)), 0) FROM ( \
                 SELECT MIN(u.ts) as started_at, MAX(u.ts) as ended_at FROM usage_events u JOIN docs d ON d.id = u.doc_id \
                  WHERE u.event = 'write' AND d.locked = 0 AND u.ts >= date('now', '-30 days') \
                  GROUP BY date(u.ts) \
                 )",
                [],
                |r| r.get(0),
            )
            .unwrap_or(0.0);

        Ok(serde_json::json!({
            "peak_hour": peak_hour,
            "most_active_workspace": most_active_ws.map(|(ws, tw, lw)| serde_json::json!({"workspace": ws, "this_week": tw, "last_week": lw})),
            "momentum": momentum,
            "avg_session_minutes": avg_session_min.round(),
        }))
    }

    /// Spec 8.3: docs opened 2+ times with no write since the last open.
    /// Locked docs are excluded (invisible to stats).
    pub fn get_reopen_never_finish(&self) -> Result<Vec<(Doc, i64, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT d.id, d.workspace, d.kind, d.title, d.path, d.parent_id, d.created_at, d.updated_at, d.content, d.word_count, d.reading_position, d.status, d.frontmatter_json, d.activity_score, d.embedding_ref, d.pinned, d.goal_words, d.deadline, d.locked,
                    u.opens, u.last_open
             FROM docs d JOIN (
                 SELECT doc_id,
                        SUM(CASE WHEN event = 'open' THEN 1 ELSE 0 END) AS opens,
                        MAX(CASE WHEN event = 'open' THEN ts END) AS last_open,
                        MAX(CASE WHEN event IN ('write', 'edit') THEN ts END) AS last_write
                 FROM usage_events GROUP BY doc_id
             ) u ON u.doc_id = d.id
             WHERE d.locked = 0 AND u.opens >= 2 AND (u.last_write IS NULL OR u.last_write < u.last_open)
             ORDER BY u.last_open DESC"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
            Ok((
                Doc {
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
                },
                row.get::<_, i64>(19)?,
                row.get::<_, String>(20)?,
            ))
        }).map_err(|e| e.to_string())?;

        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    /// Words per day (unlocked docs), oldest first. Powers the streak heatmap.
    pub fn dashboard_streak_heatmap(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT date(updated_at) as day, SUM(word_count) FROM docs WHERE locked = 0 GROUP BY day ORDER BY day"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    /// Usage-event counts per hour (0-23), all events, last 90 days.
    pub fn dashboard_writing_time_patterns(&self) -> Result<Vec<(i64, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT CAST(strftime('%H', ts) AS INTEGER) AS hour, COUNT(*) FROM usage_events WHERE ts >= date('now', '-90 days') GROUP BY hour"
        ).map_err(|e| e.to_string())?;
        let mut buckets = vec![0i64; 24];
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows.filter_map(|r| r.ok()) {
            if (0..24).contains(&r.0) {
                buckets[r.0 as usize] = r.1;
            }
        }
        Ok(buckets.into_iter().enumerate().map(|(h, c)| (h as i64, c)).collect())
    }

    /// Words per day for the last 7 days (unlocked docs). Zero-filled.
    pub fn dashboard_writing_velocity(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT date(updated_at) as day, SUM(word_count) FROM docs WHERE locked = 0 AND updated_at >= date('now', '-7 days') GROUP BY day"
        ).map_err(|e| e.to_string())?;
        let mut by_day = std::collections::HashMap::new();
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows.filter_map(|r| r.ok()) {
            by_day.insert(r.0, r.1);
        }
        let today = chrono::Utc::now().date_naive();
        let mut out = Vec::with_capacity(7);
        for back in (0..7).rev() {
            let day = (today - chrono::Duration::days(back)).format("%Y-%m-%d").to_string();
            out.push((day.clone(), *by_day.get(&day).unwrap_or(&0)));
        }
        Ok(out)
    }

    /// Composite productivity score + totals. Mirrors the browser backend formula.
    pub fn dashboard_productivity_score(&self) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let total_words: i64 = conn.query_row(
            "SELECT COALESCE(SUM(word_count), 0) FROM docs WHERE locked = 0", [], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let total_docs: i64 = conn.query_row(
            "SELECT COUNT(*) FROM docs WHERE locked = 0", [], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let active_days: i64 = conn.query_row(
            "SELECT COUNT(DISTINCT date(updated_at)) FROM docs WHERE locked = 0", [], |r| r.get(0),
        ).map_err(|e| e.to_string())?;
        let avg_words = if total_docs > 0 { total_words / total_docs } else { 0 };
        let score = ((total_words as f64 / 10000.0) * 30.0 + active_days as f64 * 2.0 + total_docs as f64 * 0.5).round().min(100.0) as i64;
        Ok(serde_json::json!({
            "score": score,
            "totalWords": total_words,
            "totalDocs": total_docs,
            "activeDays": active_days,
            "avgWords": avg_words,
        }))
    }

    /// Usage-event counts per hour (0-23), zero-filled.
    pub fn analytics_heatmap_hourly(&self) -> Result<Vec<i64>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT CAST(strftime('%H', ts) AS INTEGER) AS hour, COUNT(*) FROM usage_events GROUP BY hour"
        ).map_err(|e| e.to_string())?;
        let mut buckets = vec![0i64; 24];
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows.filter_map(|r| r.ok()) {
            if (0..24).contains(&r.0) {
                buckets[r.0 as usize] = r.1;
            }
        }
        Ok(buckets)
    }

    /// Usage-event counts per weekday (0=Sunday..6=Saturday).
    pub fn analytics_heatmap_daily(&self) -> Result<Vec<i64>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT CAST(strftime('%w', ts) AS INTEGER) AS day, COUNT(*) FROM usage_events GROUP BY day"
        ).map_err(|e| e.to_string())?;
        let mut buckets = vec![0i64; 7];
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        for r in rows.filter_map(|r| r.ok()) {
            if (0..7).contains(&r.0) {
                buckets[r.0 as usize] = r.1;
            }
        }
        Ok(buckets)
    }

    /// Word totals per workspace (unlocked docs).
    pub fn analytics_word_count_by_workspace(&self) -> Result<Vec<(String, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT workspace, COALESCE(SUM(word_count), 0) FROM docs WHERE locked = 0 GROUP BY workspace ORDER BY 2 DESC"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    /// Per-day words + touched-doc counts (unlocked docs).
    pub fn analytics_activity_timeline(&self) -> Result<Vec<(String, i64, i64)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT date(updated_at) as day, COALESCE(SUM(word_count), 0), COUNT(*) FROM docs WHERE locked = 0 GROUP BY day ORDER BY day"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?))
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    /// Raw frontmatter JSON for script metadata editing (roles, cast, timeline).
    pub fn get_doc_frontmatter(&self, doc_id: &str) -> Result<serde_json::Value, String> {
        let doc = self.get_doc(doc_id)?;
        match doc.frontmatter_json {
            Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
            None => Ok(serde_json::json!({})),
        }
    }

    /// Replace frontmatter JSON (goes through save_doc: updates updated_at).
    pub fn set_doc_frontmatter(&self, doc_id: &str, frontmatter_json: &str) -> Result<Doc, String> {
        serde_json::from_str::<serde_json::Value>(frontmatter_json).map_err(|e| e.to_string())?;
        self.save_doc(SaveDocRequest {
            id: doc_id.to_string(),
            title: None,
            content: None,
            status: None,
            frontmatter_json: Some(frontmatter_json.to_string()),
            parent_id: None,
        })
    }

    pub fn vault_rename_preview(&self, old_title: &str) -> Result<Vec<(String, String, String)>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let pattern = format!("[[{}]]", old_title);
        let mut stmt = conn.prepare(
            "SELECT id, title, content FROM docs WHERE content LIKE ?1"
        ).map_err(|e| e.to_string())?;

        let docs = stmt.query_map(params![format!("%{}%", pattern)], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(docs)
    }

    pub fn vault_rename_execute(&self, old_title: &str, new_title: &str) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let old_link = format!("[[{}]]", old_title);
        let new_link = format!("[[{}]]", new_title);

        let count = conn.execute(
            "UPDATE docs SET content = REPLACE(content, ?1, ?2) WHERE content LIKE ?3",
            params![old_link, new_link, format!("%{}%", old_link)],
        ).map_err(|e| e.to_string())?;

        Ok(count as u64)
    }

    pub fn atomic_save(&self, doc_id: &str, body: &str) -> Result<(), String> {
        let doc = self.get_doc(doc_id)?;

        // Auto-snapshot on meaningful diff (>20 words changed) per A10.2
        let old_word_count = doc.word_count as usize;
        let new_word_count = body.split_whitespace().count();
        let word_delta = (old_word_count as i64 - new_word_count as i64).abs();
        if word_delta > 20 {
            let _ = self.snapshot_create(doc_id);
        }

        let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
        let disk_path = std::path::PathBuf::from(&doc.path);
        let full_path = if disk_path.is_absolute() { disk_path } else { vault.join(&doc.path) };
        drop(vault);

        write_to_disk(&full_path, body)?;

        let word_count = body.split_whitespace().count() as i64;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute(
            "UPDATE docs SET content = ?1, word_count = ?2, updated_at = ?3 WHERE id = ?4",
            params![body, word_count, now_iso(), doc_id],
        ).map_err(|e| e.to_string())?;
        drop(conn);

        // Re-extract backlinks
        let _ = self.extract_backlinks(doc_id, body);

        // Same >20-word throttle as above: keep the retrieval index fresh.
        if word_delta > 20 {
            self.refresh_rag_chunks(doc_id);
        }

        Ok(())
    }

    pub fn setup_file_watcher(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        use notify::{Watcher, RecursiveMode, Event, EventKind};
        use std::sync::mpsc;

        let vault = self.vault_path.lock().map_err(|e| e.to_string())?.clone();

        if !vault.exists() {
            return Ok(());
        }

        let (tx, rx) = mpsc::channel::<Result<Event, notify::Error>>();
        let mut watcher = notify::recommended_watcher(tx).map_err(|e| e.to_string())?;

        watcher.watch(&vault, RecursiveMode::Recursive).map_err(|e| e.to_string())?;

        let handle = app_handle.clone();
        std::thread::spawn(move || {
            for res in rx {
                if let Ok(event) = res {
                    match event.kind {
                        EventKind::Create(_) | EventKind::Modify(_) => {
                            for path in event.paths {
                                if path.extension().and_then(|e| e.to_str()) == Some("md") {
                                    let _ = handle.emit("file-changed", path.to_string_lossy().to_string());
                                }
                            }
                        }
                        _ => {}
                    }
                }
            }
        });

        Ok(())
    }

    pub fn perf_benchmark(&self) -> Result<serde_json::Value, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Doc count
        let doc_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        // Snapshot count
        let snapshot_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM snapshots", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        // Graph edge count
        let edge_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM backlinks", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        // RAG chunk count
        let rag_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM rag_chunks", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        // Search latency test: run 10 FTS5 searches and average
        let search_query = "SELECT id FROM docs WHERE title LIKE '%test%' OR content LIKE '%test%' LIMIT 10";
        let iterations = 10u32;
        let mut total_us: u64 = 0;
        for _ in 0..iterations {
            let start = std::time::Instant::now();
            let _ = conn.execute(search_query, []);
            total_us += start.elapsed().as_micros() as u64;
        }
        let search_latency_us = total_us / iterations as u64;

        // Snapshot restore latency: pick one snapshot, time a read
        let snapshot_latency_us: u64 = {
            let start = std::time::Instant::now();
            let _: Result<String, _> = conn.query_row(
                "SELECT content FROM snapshots LIMIT 1",
                [],
                |r| r.get(0),
            );
            start.elapsed().as_micros() as u64
        };

        // Graph query latency: simulate graph_query with actual data
        let graph_latency_us: u64 = {
            let start = std::time::Instant::now();
            // Simple timing: fetch all nodes and edges count (avoids stmt lifetime issues)
            let _node_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM docs", [], |r| r.get(0)
            ).unwrap_or(0);
            let _edge_count: i64 = conn.query_row(
                "SELECT COUNT(*) FROM backlinks", [], |r| r.get(0)
            ).unwrap_or(0);
            let _rows: Vec<(String, String)> = conn
                .prepare("SELECT source_id, target_id FROM backlinks")
                .and_then(|mut stmt| {
                    let results = stmt.query_map([], |row| {
                        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                    })?.filter_map(|r| r.ok()).collect();
                    Ok(results)
                })
                .unwrap_or_default();
            start.elapsed().as_micros() as u64
        };

        // Memory estimate: current process RSS (Windows)
        let memory_mb: u64 = {
            #[cfg(target_os = "windows")]
            {
                // Use process::Command to get memory via tasklist or PowerShell
                use std::process::Command;
                let pid = std::process::id();
                if let Ok(output) = Command::new("powershell")
                    .args(["-NoProfile", "-Command", &format!(
                        "(Get-Process -Id {}).WorkingSet64 / 1MB", pid
                    )])
                    .output()
                {
                    let s = String::from_utf8_lossy(&output.stdout).trim().to_string();
                    s.parse::<f64>().unwrap_or(0.0) as u64
                } else {
                    0
                }
            }
            #[cfg(not(target_os = "windows"))]
            {
                0
            }
        };

        // Word count total
        let total_words: i64 = conn
            .query_row("SELECT COALESCE(SUM(word_count), 0) FROM docs", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;

        Ok(serde_json::json!({
            "doc_count": doc_count,
            "snapshot_count": snapshot_count,
            "edge_count": edge_count,
            "rag_chunk_count": rag_count,
            "total_words": total_words,
            "search_latency_us": search_latency_us,
            "snapshot_latency_us": snapshot_latency_us,
            "graph_latency_us": graph_latency_us,
            "memory_mb": memory_mb,
        }))
    }

    pub fn clear_conversations(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count = conn.execute("DELETE FROM conversations", []).map_err(|e| e.to_string())?;
        Ok(count as u64)
    }

    pub fn clear_messages(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count = conn.execute("DELETE FROM messages", []).map_err(|e| e.to_string())?;
        Ok(count as u64)
    }

    pub fn clear_snapshots(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count = conn.execute("DELETE FROM snapshots", []).map_err(|e| e.to_string())?;
        Ok(count as u64)
    }

    pub fn clear_usage_events(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count = conn.execute("DELETE FROM usage_events", []).map_err(|e| e.to_string())?;
        Ok(count as u64)
    }

    pub fn clear_tab_states(&self) -> Result<u64, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let count = conn.execute("DELETE FROM tab_states", []).map_err(|e| e.to_string())?;
        Ok(count as u64)
    }

    /// Assemble workspace-specific context for the AI panel.
    /// Returns a string to inject into the system prompt.
    pub fn get_workspace_context(&self, doc_id: &str, workspace: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut context = String::new();

        // Locked docs are invisible to AI: no content, no bible, no neighbors.
        let is_locked: bool = conn.query_row(
            "SELECT locked FROM docs WHERE id = ?1",
            params![doc_id],
            |row| row.get::<_, i64>(0),
        ).map(|v| v != 0).unwrap_or(false);
        if is_locked {
            return Ok(String::new());
        }

        // Common: current doc summary
        if let Ok(doc) = conn.query_row(
            "SELECT title, content, word_count FROM docs WHERE id = ?1",
            params![doc_id],
            |row| {
                let title: String = row.get(0)?;
                let content: String = row.get(1)?;
                let word_count: i64 = row.get(2)?;
                Ok((title, content, word_count))
            },
        ) {
            let snippet = if doc.1.len() > 500 {
                format!("{}...", &doc.1[..500])
            } else {
                doc.1.clone()
            };
            context.push_str(&format!(
                "Current document: \"{}\" ({} words)\n{}\n\n",
                doc.0, doc.2, snippet
            ));
        }

        match workspace {
            "novel" => {
                // Story Bible digest — best-effort: a bible hiccup must never
                // fail whole context assembly, so errors fall back to empty.
                let facts: Vec<(String, String, String)> = (|| {
                    let mut stmt = conn.prepare(
                        "SELECT kind, key, value FROM bible_facts WHERE doc_id = ?1 ORDER BY kind, key"
                    ).ok()?;
                    let rows = stmt.query_map(params![doc_id], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    }).ok()?;
                    Some(rows.filter_map(|r| r.ok()).collect())
                })().unwrap_or_default();

                if !facts.is_empty() {
                    context.push_str("Story Bible:\n");
                    for (kind, key, value) in &facts {
                        context.push_str(&format!("  [{}] {}: {}\n", kind, key, value));
                    }
                    context.push('\n');
                }

                // Previous scene (sibling doc with same parent, earlier in order)
                if let Ok(parent) = conn.query_row(
                    "SELECT parent_id FROM docs WHERE id = ?1",
                    params![doc_id],
                    |row| row.get::<_, Option<String>>(0),
                ) {
                    if let Some(pid) = parent {
                        if let Ok(prev) = conn.query_row(
                            "SELECT title, content FROM docs WHERE parent_id = ?1 AND id != ?2 AND locked = 0 ORDER BY updated_at DESC LIMIT 1",
                            params![pid, doc_id],
                            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                        ) {
                            let snippet = if prev.1.len() > 300 { format!("{}...", &prev.1[..300]) } else { prev.1 };
                            context.push_str(&format!("Previous scene: \"{}\"\n{}\n\n", prev.0, snippet));
                        }
                    }
                }
            }
            "logs" => {
                // Last 7 daily notes
                if let Ok(mut stmt) = conn.prepare(
                    "SELECT title, content FROM docs WHERE workspace = 'logs' AND locked = 0 ORDER BY created_at DESC LIMIT 7"
                ) {
                    let notes: Vec<(String, String)> = stmt.query_map([], |row| {
                        Ok((row.get(0)?, row.get(1)?))
                    }).map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok()).collect();

                    if !notes.is_empty() {
                        context.push_str("Recent daily notes:\n");
                        for (title, content) in &notes {
                            let snippet = if content.len() > 200 { format!("{}...", &content[..200]) } else { content.clone() };
                            context.push_str(&format!("  [{}] {}\n", title, snippet));
                        }
                        context.push('\n');
                    }
                }
            }
            "reader" => {
                // Book metadata + position
                if let Ok(doc) = conn.query_row(
                    "SELECT title, content, reading_position, frontmatter_json FROM docs WHERE id = ?1",
                    params![doc_id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<f64>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                        ))
                    },
                ) {
                    context.push_str(&format!("Reading: \"{}\"\n", doc.0));
                    if let Some(pos) = doc.2 {
                        context.push_str(&format!("Position: {:.1}%\n", pos * 100.0));
                    }
                    if let Some(fm) = &doc.3 {
                        context.push_str(&format!("Metadata: {}\n", fm));
                    }
                    context.push('\n');
                }
            }
            "map" | "projects" => {
                // Linked docs one hop out (backlinks + outgoing)
                if let Ok(mut stmt) = conn.prepare(
                    "SELECT d.title, d.workspace, b.context_snippet FROM backlinks b JOIN docs d ON d.id = b.source_id WHERE b.target_id = ?1 AND d.locked = 0 LIMIT 10"
                ) {
                    let linked: Vec<(String, String, String)> = stmt.query_map(params![doc_id], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    }).map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok()).collect();

                    if !linked.is_empty() {
                        context.push_str("Linked documents (backlinks):\n");
                        for (title, ws, snippet) in &linked {
                            context.push_str(&format!("  [{}] \"{}\" — {}\n", ws, title, snippet));
                        }
                        context.push('\n');
                    }
                }

                // Outgoing links
                if let Ok(mut stmt) = conn.prepare(
                    "SELECT d.title, d.workspace, b.context_snippet FROM backlinks b JOIN docs d ON d.id = b.target_id WHERE b.source_id = ?1 AND d.locked = 0 LIMIT 10"
                ) {
                    let outgoing: Vec<(String, String, String)> = stmt.query_map(params![doc_id], |row| {
                        Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                    }).map_err(|e| e.to_string())?
                        .filter_map(|r| r.ok()).collect();

                    if !outgoing.is_empty() {
                        context.push_str("Outgoing links:\n");
                        for (title, ws, snippet) in &outgoing {
                            context.push_str(&format!("  [{}] \"{}\" — {}\n", ws, title, snippet));
                        }
                        context.push('\n');
                    }
                }
            }
            _ => {}
        }

        Ok(context)
    }
}

trait Pipe {
    fn pipe<F, R>(self, f: F) -> R
    where
        F: FnOnce(Self) -> R,
        Self: Sized,
    {
        f(self)
    }
}

impl<T> Pipe for Vec<T> {}
