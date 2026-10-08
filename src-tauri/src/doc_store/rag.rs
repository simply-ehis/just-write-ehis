    use super::*;

    impl Database {
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
    pub(super) fn refresh_rag_chunks(&self, doc_id: &str) {
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

        // Fetch chunk data for semantic results.
        //
        // Batched: this was one `query_row` per hit (default 10, each walking
        // the b-tree again) while the single connection mutex was held for the
        // whole loop. One `IN (...)` statement replaces it; the per-hit distance
        // is re-attached afterwards so ordering and scoring are unchanged.
        if semantic_results.is_empty() {
            return Ok(Vec::new());
        }
        let ids: Vec<String> = semantic_results.iter().map(|(id, _)| id.clone()).collect();
        let placeholders = ids.iter().map(|_| "?").collect::<Vec<_>>().join(",");
        let sql = format!(
            "SELECT id, doc_id, chunk_index, content, start_word, end_word FROM rag_chunks WHERE id IN ({})",
            placeholders
        );
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let id_refs: Vec<&dyn rusqlite::ToSql> =
            ids.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        let by_id: std::collections::HashMap<String, RagChunk> = stmt
            .query_map(id_refs.as_slice(), |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    RagChunk {
                        id: row.get(0)?,
                        doc_id: row.get(1)?,
                        chunk_index: row.get(2)?,
                        content: row.get(3)?,
                        start_word: row.get(4)?,
                        end_word: row.get(5)?,
                    },
                ))
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        let mut results = Vec::new();
        for (chunk_id, distance) in semantic_results {
            // A chunk can vanish between the vec scan and this read (a
            // concurrent delete); skip it rather than failing the whole search,
            // matching the previous `continue`-on-locked behaviour.
            let Some(chunk) = by_id.get(&chunk_id) else { continue };
            if locked_ids.contains(&chunk.doc_id) {
                continue;
            }
            // Convert distance to similarity score (lower distance = more similar)
            let score = 1.0 / (1.0 + distance);
            results.push((chunk.clone(), score));
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
}
