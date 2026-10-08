    use super::*;

    impl Database {
    pub fn bible_scope_id(&self, doc_id: &str) -> Result<String, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut current = doc_id.to_string();
        let mut seen = HashSet::new();
        loop {
            let row: Option<(Option<String>, String)> = conn.query_row(
                "SELECT parent_id, kind FROM docs WHERE id = ?1",
                params![&current],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok();
            let Some((parent_id, kind)) = row else { return Err("Document is missing".into()) };
            if !seen.insert(current.clone()) { return Err("Document hierarchy contains a cycle".into()); }
            if kind == "project" { return Ok(current); }
            let Some(parent_id) = parent_id else { return Ok(current); };
            if parent_id == current { return Err("Document hierarchy contains a cycle".into()); }
            current = parent_id;
        }
    }

    fn bible_source_allowed_tx(tx: &Transaction<'_>, doc_id: &str) -> Result<bool, String> {
        let mut current = doc_id.to_string();
        let mut seen = HashSet::new();
        loop {
            let row: Option<(Option<String>, i64)> = tx.query_row(
                "SELECT parent_id, locked FROM docs WHERE id = ?1",
                params![&current],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok();
            let Some((parent_id, locked)) = row else { return Ok(false) };
            if locked != 0 || !seen.insert(current.clone()) { return Ok(false); }
            let Some(parent_id) = parent_id else { return Ok(true) };
            if parent_id == current { return Ok(false) };
            current = parent_id;
        }
    }

    fn bible_scope_id_tx(tx: &Transaction<'_>, doc_id: &str) -> Result<String, String> {
        let mut current = doc_id.to_string();
        let mut seen = HashSet::new();
        loop {
            let (parent_id, kind): (Option<String>, String) = tx.query_row(
                "SELECT parent_id, kind FROM docs WHERE id = ?1",
                params![&current],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).map_err(|e| e.to_string())?;
            if !seen.insert(current.clone()) { return Err("Document hierarchy contains a cycle".into()); }
            if kind == "project" { return Ok(current); }
            let Some(parent_id) = parent_id else { return Ok(current); };
            if parent_id == current { return Err("Document hierarchy contains a cycle".into()); }
            current = parent_id;
        }
    }

    pub fn bible_source_allowed(&self, doc_id: &str) -> Result<bool, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut current = doc_id.to_string();
        let mut seen = HashSet::new();
        loop {
            let row: Option<(Option<String>, i64)> = conn.query_row(
                "SELECT parent_id, locked FROM docs WHERE id = ?1",
                params![&current],
                |row| Ok((row.get(0)?, row.get(1)?)),
            ).ok();
            let Some((parent_id, locked)) = row else { return Ok(false) };
            if locked != 0 || !seen.insert(current.clone()) { return Ok(false); }
            let Some(parent_id) = parent_id else { return Ok(true) };
            if parent_id == current { return Ok(false); }
            current = parent_id;
        }
    }
    pub fn bible_get_facts(&self, doc_id: &str) -> Result<Vec<BibleFact>, String> {
        if !self.bible_source_allowed(doc_id)? {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, doc_id, kind, key, value FROM bible_facts WHERE doc_id = ?1 ORDER BY kind, key"
        ).map_err(|e| e.to_string())?;
        let facts = stmt.query_map(params![doc_id], |row| {
            Ok(BibleFact {
                id: row.get(0)?, doc_id: row.get(1)?, kind: row.get(2)?,
                key: row.get(3)?, value: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?.filter_map(|r| r.ok()).collect();
        Ok(facts)
    }

    pub fn bible_upsert_fact(&self, doc_id: &str, kind: &str, key: &str, value: &str) -> Result<BibleFact, String> {
        if self.bible_scope_id(doc_id)? != doc_id || !self.bible_source_allowed(doc_id)? {
            return Err("Story Bible facts require an unlocked project scope".into());
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let existing: Option<String> = conn.query_row(
            "SELECT id FROM bible_facts WHERE doc_id = ?1 AND key = ?2 LIMIT 1",
            params![doc_id, key],
            |row| row.get(0),
        ).ok();
        let id = existing.unwrap_or_else(uuid_v7);
        conn.execute(
            "INSERT INTO bible_facts (id, doc_id, kind, key, value) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(doc_id, key) DO UPDATE SET kind = excluded.kind, value = excluded.value",
            params![id, doc_id, kind, key, value],
        ).map_err(|e| e.to_string())?;
        Ok(BibleFact { id, doc_id: doc_id.to_string(), kind: kind.to_string(), key: key.to_string(), value: value.to_string() })
    }

    pub fn bible_delete_fact(&self, fact_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let fact: Option<(String, String)> = tx.query_row(
            "SELECT doc_id, key FROM bible_facts WHERE id = ?1",
            params![fact_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        ).ok();
        if let Some((doc_id, key)) = fact {
            if !Self::bible_source_allowed_tx(&tx, &doc_id)? {
                return Err("Locked documents cannot modify Story Memory evidence".into());
            }
            let mut stmt = tx.prepare("SELECT DISTINCT source_id FROM (SELECT doc_id AS source_id FROM bible_mentions WHERE bible_doc_id = ?1 AND fact_key = ?2 UNION SELECT source_doc_id AS source_id FROM bible_suggestions WHERE bible_doc_id = ?1 AND key = ?2)")
                .map_err(|e| e.to_string())?;
            let sources: Vec<String> = stmt.query_map(params![&doc_id, &key], |row| row.get(0))
                .map_err(|e| e.to_string())?.filter_map(|row| row.ok()).collect();
            drop(stmt);
            if sources.iter().any(|source| !Self::bible_source_allowed_tx(&tx, source).unwrap_or(false)) {
                return Err("Locked documents cannot modify Story Memory evidence".into());
            }
            tx.execute("DELETE FROM bible_mentions WHERE bible_doc_id = ?1 AND fact_key = ?2", params![doc_id, key])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM bible_suggestions WHERE bible_doc_id = ?1 AND key = ?2", params![doc_id, key])
                .map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM bible_facts WHERE id = ?1", params![fact_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn bible_get_mentions(&self, bible_doc_id: &str) -> Result<Vec<BibleMention>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT m.id, m.bible_doc_id, m.fact_key, m.kind, m.doc_id, COALESCE(d.title, ''), m.snippet, m.attribute_key, m.attribute_value, COALESCE(d.content, ''), m.created_at
             FROM bible_mentions m
             LEFT JOIN docs d ON d.id = m.doc_id
             LEFT JOIN docs b ON b.id = m.bible_doc_id
             WHERE m.bible_doc_id = ?1 AND COALESCE(d.locked, 0) = 0 AND COALESCE(b.locked, 0) = 0 ORDER BY d.title, m.created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![bible_doc_id], bible_mention_from_row)
            .map_err(|e| e.to_string())?;
        let rows: Vec<BibleMention> = rows.filter_map(|r| r.ok()).collect();
        drop(stmt);
        drop(conn);
        Ok(rows.into_iter().filter(|mention| {
            self.bible_source_allowed(bible_doc_id).unwrap_or(false)
                && self.bible_scope_id(&mention.doc_id).map(|scope| scope == bible_doc_id).unwrap_or(false)
                && self.bible_source_allowed(&mention.doc_id).unwrap_or(false)
        }).collect())
    }

    // Eight params mirror the Tauri command's one-arg-per-invoke-key shape;
    // bundling them would churn every caller for no behavior gain.
    #[allow(clippy::too_many_arguments)]
    pub fn bible_upsert_mention(&self, bible_doc_id: &str, doc_id: &str, fact_key: &str, kind: &str, snippet: &str, attribute_key: Option<&str>, attribute_value: Option<&str>) -> Result<BibleMention, String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let actual_scope = Self::bible_scope_id_tx(&tx, doc_id)?;
        if actual_scope != bible_doc_id {
            return Err("Mention source does not belong to this Story Bible".into());
        }
        if !Self::bible_source_allowed_tx(&tx, doc_id)? || !Self::bible_source_allowed_tx(&tx, bible_doc_id)? {
            return Err("Locked documents cannot receive Story Memory evidence".into());
        }
        let existing: Option<String> = tx.query_row(
            "SELECT id FROM bible_mentions WHERE bible_doc_id = ?1 AND fact_key = ?2 AND kind = ?3 AND doc_id = ?4 AND snippet = ?5 AND attribute_key IS ?6 AND attribute_value IS ?7 LIMIT 1",
            params![bible_doc_id, fact_key, kind, doc_id, snippet, attribute_key, attribute_value],
            |row| row.get(0),
        ).ok();
        let id = existing.clone().unwrap_or_else(uuid_v7);
        if existing.is_none() {
            tx.execute(
                "INSERT INTO bible_mentions (id, bible_doc_id, fact_key, kind, doc_id, snippet, attribute_key, attribute_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![id, bible_doc_id, fact_key, kind, doc_id, snippet, attribute_key, attribute_value, now_iso()],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        drop(conn);
        self.bible_get_mentions(bible_doc_id)?.into_iter().find(|m| m.id == id)
            .ok_or_else(|| "Mention was not readable after write".to_string())
    }

    pub fn bible_delete_mentions(&self, bible_doc_id: &str, doc_id: Option<&str>, fact_key: Option<&str>) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if !Self::bible_source_allowed_tx(&tx, bible_doc_id)? {
            return Err("Locked documents cannot modify Story Memory evidence".into());
        }
        if let Some(source_doc_id) = doc_id {
            if Self::bible_scope_id_tx(&tx, source_doc_id)? != bible_doc_id || !Self::bible_source_allowed_tx(&tx, source_doc_id)? {
                return Err("Mention source does not belong to an unlocked Story Bible".into());
            }
        } else {
            let mut stmt = tx.prepare("SELECT DISTINCT doc_id FROM bible_mentions WHERE bible_doc_id = ?1")
                .map_err(|e| e.to_string())?;
            let sources: Vec<String> = stmt.query_map(params![bible_doc_id], |row| row.get(0))
                .map_err(|e| e.to_string())?.filter_map(|row| row.ok()).collect();
            drop(stmt);
            if sources.iter().any(|source| !Self::bible_source_allowed_tx(&tx, source).unwrap_or(false)) {
                return Err("Locked documents cannot modify Story Memory evidence".into());
            }
        }
        tx.execute(
            "DELETE FROM bible_mentions WHERE bible_doc_id = ?1 AND (?2 IS NULL OR doc_id = ?2) AND (?3 IS NULL OR fact_key = ?3)",
            params![bible_doc_id, doc_id, fact_key],
        ).map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn bible_get_suggestions(&self, bible_doc_id: &str) -> Result<Vec<BibleSuggestion>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT s.id, s.bible_doc_id, s.source_doc_id, COALESCE(d.title, ''), s.kind, s.key, s.value, s.snippet, s.attribute_key, s.attribute_value, s.status, COALESCE(d.content, ''), s.created_at
             FROM bible_suggestions s
             LEFT JOIN docs d ON d.id = s.source_doc_id
             LEFT JOIN docs b ON b.id = s.bible_doc_id
             WHERE s.bible_doc_id = ?1 AND s.status = 'pending' AND COALESCE(d.locked, 0) = 0 AND COALESCE(b.locked, 0) = 0 ORDER BY s.created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![bible_doc_id], bible_suggestion_from_row)
            .map_err(|e| e.to_string())?;
        let rows: Vec<BibleSuggestion> = rows.filter_map(|r| r.ok()).collect();
        drop(stmt);
        drop(conn);
        Ok(rows.into_iter().filter(|suggestion| {
            self.bible_source_allowed(bible_doc_id).unwrap_or(false)
                && self.bible_scope_id(&suggestion.source_doc_id).map(|scope| scope == bible_doc_id).unwrap_or(false)
                && self.bible_source_allowed(&suggestion.source_doc_id).unwrap_or(false)
        }).collect())
    }

    pub fn bible_reject_suggestion(&self, bible_doc_id: &str, suggestion_id: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if !Self::bible_source_allowed_tx(&tx, bible_doc_id)? {
            return Err("Locked documents cannot modify Story Memory evidence".into());
        }
        let source_doc_id: String = tx.query_row(
            "SELECT source_doc_id FROM bible_suggestions WHERE bible_doc_id = ?1 AND id = ?2 AND status = 'pending'",
            params![bible_doc_id, suggestion_id],
            |row| row.get(0),
        ).map_err(|_| "Suggestion not found".to_string())?;
        if Self::bible_scope_id_tx(&tx, &source_doc_id)? != bible_doc_id || !Self::bible_source_allowed_tx(&tx, &source_doc_id)? {
            return Err("Suggestion source does not belong to an unlocked Story Bible".into());
        }
        tx.execute("UPDATE bible_suggestions SET status = 'rejected' WHERE bible_doc_id = ?1 AND id = ?2 AND status = 'pending'", params![bible_doc_id, suggestion_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn bible_confirm_suggestion(&self, bible_doc_id: &str, suggestion_id: &str) -> Result<BibleFact, String> {
        if !self.bible_source_allowed(bible_doc_id)? {
            return Err("Locked documents cannot confirm Story Memory evidence".into());
        }
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        let suggestion = {
            let mut stmt = tx.prepare(
                "SELECT s.id, s.bible_doc_id, s.source_doc_id, COALESCE(d.title, ''), s.kind, s.key, s.value, s.snippet, s.attribute_key, s.attribute_value, s.status, COALESCE(d.content, ''), s.created_at
                 FROM bible_suggestions s
                 LEFT JOIN docs d ON d.id = s.source_doc_id
                 WHERE s.bible_doc_id = ?1 AND s.id = ?2 AND s.status = 'pending'",
            ).map_err(|e| e.to_string())?;
            stmt.query_row(params![bible_doc_id, suggestion_id], bible_suggestion_from_row)
                .map_err(|_| "Suggestion not found".to_string())?
        };
        let source_scope = Self::bible_scope_id_tx(&tx, &suggestion.source_doc_id)?;
        let source_content: Option<String> = tx.query_row("SELECT content FROM docs WHERE id = ?1", params![&suggestion.source_doc_id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        if source_scope != bible_doc_id || !Self::bible_source_allowed_tx(&tx, &suggestion.source_doc_id)? {
            return Err("Suggestion source is no longer in this Story Bible".into());
        }
        if !source_content.unwrap_or_default().contains(&suggestion.snippet) {
            return Err("Suggestion source changed before confirmation".into());
        }
        let fact_kind = match suggestion.kind.as_str() {
            "character" => "world_characters",
            "location" | "object" => "world_settings",
            other => other,
        };
        let existing_fact_id: Option<String> = tx.query_row(
            "SELECT id FROM bible_facts WHERE doc_id = ?1 AND key = ?2 LIMIT 1",
            params![bible_doc_id, &suggestion.key],
            |row| row.get(0),
        ).ok();
        let fact_id = existing_fact_id.clone().unwrap_or_else(uuid_v7);
        tx.execute(
            "INSERT INTO bible_facts (id, doc_id, kind, key, value) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(doc_id, key) DO UPDATE SET kind = excluded.kind, value = excluded.value",
            params![fact_id, bible_doc_id, fact_kind, &suggestion.key, &suggestion.value],
        ).map_err(|e| e.to_string())?;
        let mention_id: Option<String> = tx.query_row(
            "SELECT id FROM bible_mentions WHERE bible_doc_id = ?1 AND fact_key = ?2 AND kind = ?3 AND doc_id = ?4 AND snippet = ?5 AND attribute_key IS ?6 AND attribute_value IS ?7 LIMIT 1",
            params![bible_doc_id, &suggestion.key, &suggestion.kind, &suggestion.source_doc_id, &suggestion.snippet, suggestion.attribute_key, suggestion.attribute_value],
            |row| row.get(0),
        ).ok();
        if mention_id.is_none() {
            tx.execute(
                "INSERT INTO bible_mentions (id, bible_doc_id, fact_key, kind, doc_id, snippet, attribute_key, attribute_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![uuid_v7(), bible_doc_id, &suggestion.key, &suggestion.kind, &suggestion.source_doc_id, &suggestion.snippet, suggestion.attribute_key, suggestion.attribute_value, now_iso()],
            ).map_err(|e| e.to_string())?;
        }
        tx.execute("DELETE FROM bible_suggestions WHERE bible_doc_id = ?1 AND id = ?2", params![bible_doc_id, suggestion_id])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        Ok(BibleFact { id: fact_id, doc_id: bible_doc_id.to_string(), kind: fact_kind.to_string(), key: suggestion.key, value: suggestion.value })
    }

    pub fn bible_replace_scene_memory(&self, bible_doc_id: &str, doc_id: &str, content: &str, expected_content: Option<&str>, candidates: &[BibleMentionCandidate]) -> Result<BibleMemoryUpdate, String> {
        let _ = content;
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        let tx = conn.transaction().map_err(|e| e.to_string())?;
        if let Some(expected) = expected_content {
            let current: Option<String> = tx.query_row("SELECT content FROM docs WHERE id = ?1", params![doc_id], |row| row.get(0))
                .map_err(|e| e.to_string())?;
            if current.unwrap_or_default() != expected {
                return Ok(BibleMemoryUpdate { skipped: true, retryable: false, matched: 0, suggested: 0 });
            }
        }
        let actual_scope = Self::bible_scope_id_tx(&tx, doc_id)?;
        if actual_scope != bible_doc_id || !Self::bible_source_allowed_tx(&tx, bible_doc_id)? || !Self::bible_source_allowed_tx(&tx, doc_id)? {
            return Err("Mention source does not belong to an unlocked Story Bible".into());
        }
        if !content.trim().is_empty() && candidates.is_empty() {
            return Ok(BibleMemoryUpdate { skipped: true, retryable: false, matched: 0, suggested: 0 });
        }
        let facts: Vec<BibleFact> = {
            let mut stmt = tx.prepare("SELECT id, doc_id, kind, key, value FROM bible_facts WHERE doc_id = ?1 ORDER BY kind, key")
                .map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![bible_doc_id], |row| Ok(BibleFact {
                id: row.get(0)?, doc_id: row.get(1)?, kind: row.get(2)?, key: row.get(3)?, value: row.get(4)?,
            })).map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        let existing: Vec<BibleMention> = {
            let mut stmt = tx.prepare(
                "SELECT m.id, m.bible_doc_id, m.fact_key, m.kind, m.doc_id, COALESCE(d.title, ''), m.snippet, m.attribute_key, m.attribute_value, COALESCE(d.content, ''), m.created_at
                 FROM bible_mentions m LEFT JOIN docs d ON d.id = m.doc_id
                 WHERE m.bible_doc_id = ?1 AND m.doc_id = ?2 ORDER BY m.created_at",
            ).map_err(|e| e.to_string())?;
            let rows = stmt.query_map(params![bible_doc_id, doc_id], bible_mention_from_row).map_err(|e| e.to_string())?;
            rows.filter_map(|row| row.ok()).collect()
        };
        let existing_signatures = existing.iter().map(mention_signature).collect::<HashSet<_>>();
        let mut desired = HashSet::new();
        let mut matched = 0u64;
        let mut suggested = 0u64;
        tx.execute("DELETE FROM bible_suggestions WHERE bible_doc_id = ?1 AND source_doc_id = ?2 AND status = 'pending'", params![bible_doc_id, doc_id])
            .map_err(|e| e.to_string())?;
        for candidate in candidates {
            let key = candidate.key.trim();
            if key.is_empty() { continue; }
            let normalized = normalize_memory_key(key);
            let fact = facts.iter().find(|fact| memory_kind_matches(&candidate.kind, &fact.kind) && normalize_memory_key(&fact.key) == normalized)
                .or_else(|| facts.iter().find(|fact| {
                    if !memory_kind_matches(&candidate.kind, &fact.kind) || normalized.chars().count() < 4 { return false; }
                    let name = normalize_memory_key(&fact.key);
                    let prefix = normalized.chars().zip(name.chars()).take_while(|(left, right)| left == right).count();
                    prefix > 0 && memory_edit_distance(&normalized, &name) <= if name.chars().count() >= 8 { 2 } else { 1 }
                }));
            if let Some(fact) = fact {
                let signature = mention_signature_from_parts(&fact.key, &candidate.kind, &candidate.snippet, candidate.attribute_key.as_deref(), candidate.attribute_value.as_deref());
                desired.insert(signature.clone());
                if !existing_signatures.contains(&signature) {
                    tx.execute(
                        "INSERT INTO bible_mentions (id, bible_doc_id, fact_key, kind, doc_id, snippet, attribute_key, attribute_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                        params![uuid_v7(), bible_doc_id, &fact.key, &candidate.kind, doc_id, &candidate.snippet, candidate.attribute_key, candidate.attribute_value, now_iso()],
                    ).map_err(|e| e.to_string())?;
                }
                matched += 1;
            } else {
                let value = candidate.attribute_value.clone().unwrap_or_default();
                let existing_suggestion: Option<String> = tx.query_row(
                    "SELECT id FROM bible_suggestions WHERE bible_doc_id = ?1 AND source_doc_id = ?2 AND kind = ?3 AND key = ?4 AND snippet = ?5 AND attribute_key IS ?6 AND attribute_value IS ?7 LIMIT 1",
                    params![bible_doc_id, doc_id, &candidate.kind, key, &candidate.snippet, candidate.attribute_key, candidate.attribute_value],
                    |row| row.get(0),
                ).ok();
                let rejected = tx.query_row(
                    "SELECT 1 FROM bible_suggestions WHERE bible_doc_id = ?1 AND source_doc_id = ?2 AND kind = ?3 AND key = ?4 AND status = 'rejected' LIMIT 1",
                    params![bible_doc_id, doc_id, &candidate.kind, key],
                    |row| row.get::<_, i64>(0),
                ).is_ok();
                if existing_suggestion.is_none() && !rejected {
                    tx.execute(
                        "INSERT INTO bible_suggestions (id, bible_doc_id, source_doc_id, kind, key, value, snippet, attribute_key, attribute_value, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params![uuid_v7(), bible_doc_id, doc_id, &candidate.kind, key, value, &candidate.snippet, candidate.attribute_key, candidate.attribute_value, now_iso()],
                    ).map_err(|e| e.to_string())?;
                    suggested += 1;
                }
            }
        }
        for mention in existing {
            if !desired.contains(&mention_signature(&mention)) {
                tx.execute("DELETE FROM bible_mentions WHERE id = ?1", params![mention.id]).map_err(|e| e.to_string())?;
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(BibleMemoryUpdate { skipped: false, retryable: false, matched, suggested })
    }

    pub fn bible_descendant_docs(&self, project_id: &str) -> Result<Vec<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "WITH RECURSIVE descendants(id) AS (
                SELECT id FROM docs WHERE id = ?1
                 UNION
                 SELECT d.id FROM docs d JOIN descendants p ON d.parent_id = p.id
             )
             SELECT d.id, d.workspace, d.kind, d.title, d.path, d.parent_id, d.created_at, d.updated_at, d.content, d.word_count, d.reading_position, d.status, d.frontmatter_json, d.activity_score, d.embedding_ref, d.pinned, d.goal_words, d.deadline, d.locked
             FROM docs d JOIN descendants x ON d.id = x.id ORDER BY d.created_at"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![project_id], |row| Ok(Doc {
            id: row.get(0)?, workspace: row.get(1)?, kind: row.get(2)?, title: row.get(3)?, path: row.get(4)?,
            parent_id: row.get(5)?, created_at: row.get(6)?, updated_at: row.get(7)?, content: row.get(8)?,
            word_count: row.get(9)?, reading_position: row.get(10)?, status: row.get(11)?, frontmatter_json: row.get(12)?,
            activity_score: row.get(13)?, embedding_ref: row.get(14)?, pinned: row.get::<_, i64>(15).unwrap_or(0) != 0,
            goal_words: row.get(16)?, deadline: row.get(17)?, locked: row.get::<_, i64>(18).unwrap_or(0) != 0,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }
}
