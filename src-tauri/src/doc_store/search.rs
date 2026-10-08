    use super::*;

    impl Database {

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

    pub fn reindex_fts(&self) -> Result<u64, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Collect first: the read cursor must be drained before writing on
        // the same connection, and DELETE+INSERTs run atomically so a crash
        // can never leave the FTS index half-empty.
        let docs: Vec<(String, String, String, String)> = {
            let mut stmt = conn.prepare(
                "SELECT id, title, content, workspace FROM docs WHERE locked = 0"
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            }).map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM docs_fts", []).map_err(|e| e.to_string())?;
        let mut count = 0u64;
        for (id, title, content, workspace) in &docs {
            tx.execute(
                "INSERT INTO docs_fts(rowid, title, content, workspace) VALUES ((SELECT rowid FROM docs WHERE id = ?1), ?2, ?3, ?4)",
                params![id, title, content, workspace],
            ).map_err(|e| e.to_string())?;
            count += 1;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(count)
    }

    pub fn search_docs_fts(&self, query: &str, workspace: Option<&str>) -> Result<Vec<SearchResult>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        // Quote each token against FTS syntax injection; drop tokens that
        // are empty after stripping quotes (a `"`-only query must return
        // no hits, not a SQLite syntax error).
        let terms: Vec<String> = query.split_whitespace()
            .map(|w| w.replace('"', ""))
            .filter(|w| !w.is_empty())
            .map(|w| format!("\"{}\"", w))
            .collect();
        if terms.is_empty() {
            return Ok(Vec::new());
        }
        let fts_query = terms.join(" OR ");
        // Rank convention (shared with `search_docs`): higher rank sorts
        // first downstream. bm25() is negative (lower is better), so the
        // stored rank is `-bm25` and rows arrive best-first.
        if let Some(ws) = workspace {
            let mut s = conn.prepare(
                "SELECT d.id, d.workspace, d.kind, d.title, d.path, d.parent_id, d.created_at, d.updated_at, d.content, d.word_count, d.reading_position, d.status, d.frontmatter_json, d.activity_score, d.embedding_ref, d.pinned, d.goal_words, d.deadline, d.locked, snippet(docs_fts, 2, '<mark>', '</mark>', '...', 32) as snip, bm25(docs_fts) as rank
                 FROM docs_fts
                 JOIN docs d ON d.rowid = docs_fts.rowid
                 WHERE docs_fts MATCH ?1 AND d.workspace = ?2 AND d.locked = 0
                 ORDER BY rank LIMIT 50"
            ).map_err(|e| e.to_string())?;
            let rows = s.query_map(params![fts_query, ws], |row| {
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
                    row.get::<_, String>(19).ok(),
                    row.get::<_, f64>(20).unwrap_or(0.0),
                ))
            }).map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).map(|(doc, snippet, score)| SearchResult { doc, snippet, rank: -score }).collect())
        } else {
            let mut s = conn.prepare(
                "SELECT d.id, d.workspace, d.kind, d.title, d.path, d.parent_id, d.created_at, d.updated_at, d.content, d.word_count, d.reading_position, d.status, d.frontmatter_json, d.activity_score, d.embedding_ref, d.pinned, d.goal_words, d.deadline, d.locked, snippet(docs_fts, 2, '<mark>', '</mark>', '...', 32) as snip, bm25(docs_fts) as rank
                 FROM docs_fts
                 JOIN docs d ON d.rowid = docs_fts.rowid
                 WHERE docs_fts MATCH ?1 AND d.locked = 0
                 ORDER BY rank LIMIT 50"
            ).map_err(|e| e.to_string())?;
            let rows = s.query_map(params![fts_query], |row| {
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
                    row.get::<_, String>(19).ok(),
                    row.get::<_, f64>(20).unwrap_or(0.0),
                ))
            }).map_err(|e| e.to_string())?;
            Ok(rows.filter_map(|r| r.ok()).map(|(doc, snippet, score)| SearchResult { doc, snippet, rank: -score }).collect())
        }
    }
}

