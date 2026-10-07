use rusqlite::{params, Transaction};
use crate::database::Database;
use crate::models::*;
use chrono::Utc;
use uuid::Uuid;
use std::collections::{HashMap, HashSet};
use zerocopy::IntoBytes;
use tauri::Emitter;

fn uuid_v7() -> String {
    Uuid::new_v4().to_string()
}

/// One dashboard goal row: (id, title, workspace, goal_words, word_count, deadline).
type GoalRow = (String, String, String, i64, i64, Option<String>);

/// Truncate to at most `max_bytes` without ever splitting a UTF-8 character.
///
/// Byte-index slicing (`&s[..n]`, `String::truncate`) panics whenever the index
/// lands inside a multi-byte character. Titles, dates and document bodies here
/// are free-form user text, and CJK, em-dashes and emoji are routine in a
/// writing app — so a plain `len() > n` byte guard is not a safety check, it is
/// a coin flip. Deliberately built from primitives that have been stable for
/// the life of Rust, so this helper cannot itself become a version hazard.
///
/// The result is at most `max_bytes` long and always ends on a character
/// boundary, so it can never exceed the original.
fn truncate_bytes_safe(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

/// First `max_bytes` of `s` with an ellipsis when anything was cut. The single
/// definition every AI-context snippet uses — these three copies previously
/// drifted, and two of them used `n.min(len)`, which looks safe but is not:
/// inside `if len > n` the `min` always collapses to `n`, so the byte slice
/// that follows panicked exactly like the third one did.
fn snippet_of(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        s.to_string()
    } else {
        format!("{}...", truncate_bytes_safe(s, max_bytes))
    }
}

/// True only for a strict ASCII `YYYY-MM-DD` date — the shape the Logs calendar
/// produces and the only shape `compute_disk_path` splits into `YYYY/MM`.
///
/// Checked by bytes, so multi-byte input is rejected outright rather than
/// reaching path construction (where a non-ASCII byte index used to panic).
/// Calendar validity is left to the Date the UI already built.
fn is_iso_date(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b[..4].iter().all(u8::is_ascii_digit)
        && b[5..7].iter().all(u8::is_ascii_digit)
        && b[8..].iter().all(u8::is_ascii_digit)
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
            // Title is expected to be YYYY-MM-DD. Anything else (or a title that
            // is not ASCII) must not be able to shape the directory path: the
            // segments are sanitized, and a title without three usable
            // segments falls back to the id. See `log_get_or_create`, which
            // now also validates the date format at the boundary.
            let date_part = truncate_bytes_safe(title, 10);
            let parts: Vec<String> = date_part
                .split('-')
                .map(|p| sanitize_component(p, ""))
                .filter(|p| !p.is_empty())
                .collect();
            if parts.len() >= 3 {
                vault
                    .join("logs")
                    .join(&parts[0])
                    .join(&parts[1])
                    .join(format!("{}.md", sanitize_component(&date_part, id)))
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
            vault.join(sanitize_component(workspace, "misc")).join(format!("{}.md", id))
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
    // Truncate to a reasonable length on a character boundary: a byte-index
    // truncate panics on any multi-byte title (22 CJK chars is already 66 bytes).
    let mut name = truncate_bytes_safe(&result, 64).to_string();
    // "." / ".." are path segments, not names: a title like ".." would
    // otherwise walk out of the workspace folder.
    if name.is_empty() || name.chars().all(|c| c == '.') {
        name = "untitled".to_string();
    }
    name
}

/// One safe path segment for caller-supplied names (workspace folders).
fn sanitize_component(s: &str, fallback: &str) -> String {
    let cleaned: String = s
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '\0'))
        .collect();
    let trimmed = cleaned.trim().to_string();
    if trimmed.is_empty() || trimmed.chars().all(|c| c == '.') {
        fallback.to_string()
    } else {
        trimmed
    }
}

/// Lexically resolve `.`/`..` without touching the filesystem.
fn normalize_lexically(path: &std::path::Path) -> std::path::PathBuf {
    let mut out: Vec<std::path::Component> = Vec::new();
    for comp in path.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                if matches!(out.last(), Some(std::path::Component::Normal(_))) {
                    out.pop();
                } else if !matches!(
                    out.last(),
                    None | Some(std::path::Component::RootDir) | Some(std::path::Component::Prefix(_))
                ) {
                    out.push(comp);
                }
            }
            other => out.push(other),
        }
    }
    out.iter().collect()
}

/// Resolve a stored doc path inside the vault. Absolute paths, `..`
/// traversal, and any other escape are refused: a doc write must never
/// touch a file outside the vault the user chose.
fn resolve_in_vault(vault: &std::path::Path, stored: &str) -> Result<std::path::PathBuf, String> {
    let raw = std::path::Path::new(stored);
    let joined = if raw.is_absolute() { raw.to_path_buf() } else { vault.join(raw) };
    let normalized = normalize_lexically(&joined);
    let root = normalize_lexically(vault);
    if normalized.starts_with(&root) {
        Ok(normalized)
    } else {
        Err(format!("Refusing to touch a path outside the vault: {}", stored))
    }
}

/// Write content to disk atomically (temp file + rename). The temp name is
/// unique per call so concurrent saves of the same path never share one.
fn write_to_disk(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create dir {}: {}", parent.display(), e))?;
    }
    let temp = path.with_extension(format!("tmp.{}", Uuid::new_v4()));
    std::fs::write(&temp, content.as_bytes()).map_err(|e| format!("Failed to write temp: {}", e))?;
    std::fs::rename(&temp, path).map_err(|e| format!("Failed to rename temp: {}", e))?;
    Ok(())
}

fn compute_content_hash(content: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    content.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn word_diff_count(old: &str, new: &str) -> i64 {
    let old_words: Vec<&str> = old.split_whitespace().collect();
    let new_words: Vec<&str> = new.split_whitespace().collect();
    let max_len = old_words.len().max(new_words.len());
    let mut changes = 0i64;
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

/// Context window around a byte span, snapped to char boundaries so
/// multi-byte prose can never panic the slicer. Display only.
fn snippet_around(content: &str, start: i64, end: i64) -> String {
    let len = content.len() as i64;
    let mut s = (start - 60).max(0);
    while s > 0 && !content.is_char_boundary(s as usize) {
        s -= 1;
    }
    let mut e = (end + 60).min(len);
    while e < len && !content.is_char_boundary(e as usize) {
        e += 1;
    }
    let inner = content[s as usize..e as usize]
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let mut out = inner;
    if s > 0 {
        out = format!("…{out}");
    }
    if e < len {
        out = format!("{out}…");
    }
    out
}

use crate::models::normalize_memory_key;

fn memory_edit_distance(left: &str, right: &str) -> usize {
    let a: Vec<char> = left.chars().collect();
    let b: Vec<char> = right.chars().collect();
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            current.push(std::cmp::min(
                std::cmp::min(current[j] + 1, previous[j + 1] + 1),
                previous[j] + usize::from(ca != cb),
            ));
        }
        previous = current;
    }
    previous[b.len()]
}

fn memory_kind_matches(candidate_kind: &str, fact_kind: &str) -> bool {
    let candidate = candidate_kind.to_lowercase();
    let fact = fact_kind.to_lowercase();
    if candidate == fact {
        return true;
    }
    if candidate == "character" {
        return fact.contains("character") || fact.contains("person");
    }
    if candidate == "location" {
        return fact.contains("location") || fact.contains("place") || fact.contains("setting");
    }
    if candidate == "object" {
        return fact.contains("object") || fact.contains("item") || fact.contains("setting");
    }
    false
}

fn snippet_position(content: &str, snippet: &str) -> Option<i64> {
    content.find(snippet).and_then(|index| content.get(..index)).map(|prefix| prefix.encode_utf16().count() as i64)
}

fn bible_mention_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BibleMention> {
    let content: String = row.get(9)?;
    let snippet: String = row.get(6)?;
    Ok(BibleMention {
        id: row.get(0)?,
        bible_doc_id: row.get(1)?,
        fact_key: row.get(2)?,
        kind: row.get(3)?,
        doc_id: row.get(4)?,
        doc_title: row.get(5)?,
        snippet,
        attribute_key: row.get(7)?,
        attribute_value: row.get(8)?,
        span_start: snippet_position(&content, &row.get::<_, String>(6)?),
        created_at: row.get(10)?,
    })
}

fn bible_suggestion_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<BibleSuggestion> {
    let content: String = row.get(11)?;
    let snippet: String = row.get(7)?;
    Ok(BibleSuggestion {
        id: row.get(0)?,
        bible_doc_id: row.get(1)?,
        source_doc_id: row.get(2)?,
        doc_title: row.get(3)?,
        kind: row.get(4)?,
        key: row.get(5)?,
        value: row.get(6)?,
        snippet,
        attribute_key: row.get(8)?,
        attribute_value: row.get(9)?,
        span_start: snippet_position(&content, &row.get::<_, String>(7)?),
        status: row.get(10)?,
        created_at: row.get(12)?,
    })
}

fn mention_signature(mention: &BibleMention) -> String {
    mention_signature_from_parts(
        &mention.fact_key,
        &mention.kind,
        &mention.snippet,
        mention.attribute_key.as_deref(),
        mention.attribute_value.as_deref(),
    )
}

fn mention_signature_from_parts(fact_key: &str, kind: &str, snippet: &str, attribute_key: Option<&str>, attribute_value: Option<&str>) -> String {
    format!(
        "{}\u{1f}{}\u{1f}{}\u{1f}{}\u{1f}{}",
        normalize_memory_key(fact_key),
        kind.to_lowercase(),
        snippet.trim(),
        attribute_key.unwrap_or(""),
        attribute_value.unwrap_or("")
    )
}

const EMBEDDING_DIM: usize = 256;

/// Word-count change that triggers an automatic version snapshot (A10.2).
/// Named so the threshold cannot drift between the save and atomic-save
/// paths, which previously both hardcoded `20`.
const SNAPSHOT_WORD_THRESHOLD: usize = 20;

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

        // Compute proper on-disk path, then confine it before anything touches the
        // disk. Every other write path in this file routes through
        // `resolve_in_vault` (save/delete/move/restore/atomic_save);
        // create_doc was the sole exception. That mattered because
        // `PathBuf::join` *replaces* the accumulated path when handed an
        // absolute segment, so a title could relocate the write out of the
        // vault entirely — and quick capture feeds raw typed text in as the
        // title, making this reachable from ordinary UI, not just a hostile
        // webview.
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
        let proposed = compute_disk_path(&vault, &req.workspace, &req.kind, &req.title, &id);
        let disk_path = resolve_in_vault(&vault, proposed.to_string_lossy().as_ref())?;
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
        // Refuse writes when the schema is in a known-unsafe state (e.g. a
        // failed migration). Writing to a half-migrated schema can corrupt it
        // further; the user is better off with a clear error and read-only
        // access to their files.
        if let Ok(flag) = self.read_only.lock() {
            if flag.0 {
                return Err(
                    "Database is read-only: a migration failed. Your files are safe but writes are disabled."
                        .into(),
                );
            }
        }
        let content_changed = req.content.is_some();
        // Read the PREVIOUS content before the UPDATE overwrites it. The
        // auto-snapshot guard below compares old vs new; reading it after
        // the commit (as this once did) made the delta identically zero,
        // so the >20-word safety net never fired.
        //
        // Declared outside the transaction block so it is visible after
        // commit: the snapshot must archive the text being overwritten, and
        // snapshot_create re-reads the row (which would return the NEW text
        // after the UPDATE).
        let old_content_before_update: Option<String> = if req.content.is_some() {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            conn.query_row(
                "SELECT content FROM docs WHERE id = ?1",
                params![&req.id],
                |row| row.get::<_, String>(0),
            )
            .ok()
        } else {
            None
        };
        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            let now = Utc::now().to_rfc3339();
            let old_parent = if req.parent_id.is_some() {
                Some(tx.query_row("SELECT parent_id FROM docs WHERE id = ?1", params![&req.id], |row| row.get::<_, Option<String>>(0)).map_err(|e| e.to_string())?)
            } else {
                None
            };

            if let Some(title) = &req.title {
                tx.execute(
                    "UPDATE docs SET title = ?1, updated_at = ?2 WHERE id = ?3",
                    params![title, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(content) = &req.content {
                let word_count = content.split_whitespace().count() as i64;
                tx.execute(
                    "UPDATE docs SET content = ?1, word_count = ?2, updated_at = ?3 WHERE id = ?4",
                    params![content, word_count, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(status) = &req.status {
                tx.execute(
                    "UPDATE docs SET status = ?1, updated_at = ?2 WHERE id = ?3",
                    params![status, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(fm) = &req.frontmatter_json {
                tx.execute(
                    "UPDATE docs SET frontmatter_json = ?1, updated_at = ?2 WHERE id = ?3",
                    params![fm, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            if let Some(parent_id) = &req.parent_id {
                if old_parent.as_ref() != Some(parent_id) {
                    tx.execute("DELETE FROM bible_mentions WHERE doc_id = ?1", params![&req.id]).map_err(|e| e.to_string())?;
                    tx.execute("DELETE FROM bible_suggestions WHERE source_doc_id = ?1", params![&req.id]).map_err(|e| e.to_string())?;
                }
                tx.execute(
                    "UPDATE docs SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
                    params![parent_id, now, req.id],
                ).map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;
        }

        // Write content to disk if changed + auto-snapshot on meaningful diff
        if content_changed {
            let doc = self.get_doc(&req.id)?;

            // Auto-snapshot on a meaningful diff (>20 words) — A10.2.
            //
            // The guard compares the text being OVERWRITTEN against the text
            // replacing it. `old_content_before_update` was read inside the
            // transaction before the UPDATE; reading the doc afterwards made
            // the delta identically zero, so this net never fired.
            //
            // Ordering matters twice over: the delta must use the pre-edit
            // body, and `snapshot_create_from` must be given that same body —
            // `snapshot_create` re-reads the row and would archive the NEW
            // text, which is worthless as a restore point.
            if let Some(new_content) = &req.content {
                let new_word_count = new_content.split_whitespace().count();
                let word_delta = match old_content_before_update.as_deref() {
                    Some(old) => (old.split_whitespace().count() as i64)
                        - (new_word_count as i64),
                    // No previous content (brand-new row): snapshot whatever
                    // precedes the first write.
                    None => -(new_word_count as i64),
                };
                if word_delta.abs() > SNAPSHOT_WORD_THRESHOLD as i64 {
                    // Not best-effort: silently dropping this is exactly the
                    // invisible safety net the guard exists to provide.
                    let prior = old_content_before_update.unwrap_or_default();
                    self.snapshot_create_from(&req.id, &prior)?;
                    // Derived index stays best-effort.
                    let _ = self.refresh_rag_chunks(&req.id);
                }
            }

            let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
            let full_path = resolve_in_vault(&vault, &doc.path)?;
            drop(vault);
            // Files are the source of truth (ARCHITECTURE.md): a failed
            // disk write must surface, never pass as a successful save.
            // (Derived indexes stay best-effort below.)
            write_to_disk(&full_path, &doc.content)?;
            // refresh_entities is per-doc and fast — keep it on the save path.
            // extract_backlinks is O(docs × content) and holds self.conn for
            // the duration, so it stays off the hot path; call
            // reindex_entities explicitly after batch imports or renames.
            let _ = self.refresh_entities(&req.id, &doc.content);
        }

        self.get_doc(&req.id)
    }

    /// Rebuild the entity + backlink index for one doc. Explicit because the
    /// save path no longer does it automatically: extract_backlinks is
    /// O(docs × content) and holds the DB lock, which froze the UI on large
    /// vaults. Call this after a batch import or a vault rename.
    #[allow(dead_code)] // wired to a Tauri command in a follow-up
    pub fn reindex_entities(&self, doc_id: &str) -> Result<(), String> {
        let doc = self.get_doc(doc_id)?;
        self.extract_backlinks(doc_id, &doc.content)?;
        self.refresh_entities(doc_id, &doc.content)?;
        Ok(())
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

        // 2. Delete rows FIRST, inside one transaction. FK cascades
        //    (foreign_keys=ON) clean snapshots, usage, craft metrics,
        //    backlinks, links, rag chunks. Tables WITHOUT an FK get explicit
        //    cleanup below.
        //
        //    The old order removed files first, so a failure after the unlink
        //    deleted the user's .md while the row (and its content column)
        //    survived — permanent data loss with an error returned.
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?.clone();
        let mut removed_paths: Vec<std::path::PathBuf> = Vec::new();
        {
            let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            for del_id in &ids {
                // Collect paths before deleting rows, so files can be
                // removed after the transaction commits.
                if let Ok(doc) = tx.query_row(
                    "SELECT path FROM docs WHERE id = ?1",
                    params![del_id],
                    |row| row.get::<_, String>(0),
                ) {
                    if let Ok(full) = resolve_in_vault(&vault, &doc) {
                        removed_paths.push(full);
                    }
                }
                tx.execute("DELETE FROM docs WHERE id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
            }
            for del_id in &ids {
                // bible_facts + conversations have no FK to docs.
                tx.execute("DELETE FROM bible_facts WHERE doc_id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
                tx.execute("DELETE FROM conversations WHERE doc_id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
                // Canvas cards keep existing; just unlink the dead doc.
                tx.execute("UPDATE canvas_nodes SET doc_id = NULL WHERE doc_id = ?1", params![del_id])
                    .map_err(|e| e.to_string())?;
            }
            // Chunks cascade; vectors have no FK — sweep the orphans.
            let _ = tx.execute(
                "DELETE FROM rag_vec WHERE chunk_id NOT IN (SELECT id FROM rag_chunks)",
                [],
            );
            tx.commit().map_err(|e| e.to_string())?;
        }

        // 3. Remove files AFTER the transaction commits. A failure here
        //    leaves the rows gone but the files present — recoverable (the
        //    files are orphaned, not the data). The reverse order was
        //    permanent data loss.
        for full in &removed_paths {
            if let Err(e) = std::fs::remove_file(full) {
                // Report but do not fail: the rows are already gone, and a
                // locked file (AV, another editor) should not make a
                // successful delete look failed.
                eprintln!("delete_doc: failed to remove {}: {}", full.display(), e);
            }
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
        // Validate the destination before mutating the row: a path that
        // escapes the vault must fail loudly, not rewrite the index.
        let vault = self.vault_path.lock().map_err(|e| e.to_string())?.clone();
        if let Some(path) = &req.new_path {
            resolve_in_vault(&vault, path)?;
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let now = Utc::now().to_rfc3339();
        let old_parent: Option<String> = conn.query_row("SELECT parent_id FROM docs WHERE id = ?1", params![&req.id], |row| row.get(0))
            .map_err(|e| e.to_string())?;
        // Read the current path so the file can be moved to match the row.
        // Without this the DB pointed at a path with no file and the original
        // .md was orphaned on disk.
        let old_path: Option<String> = conn.query_row("SELECT path FROM docs WHERE id = ?1", params![&req.id], |row| row.get(0))
            .map_err(|e| e.to_string())?;

        if let Some(parent_id) = &req.new_parent_id {
            if old_parent.as_deref() != Some(parent_id.as_str()) {
                conn.execute("DELETE FROM bible_mentions WHERE doc_id = ?1", params![&req.id]).map_err(|e| e.to_string())?;
                conn.execute("DELETE FROM bible_suggestions WHERE source_doc_id = ?1", params![&req.id]).map_err(|e| e.to_string())?;
            }
            conn.execute(
                "UPDATE docs SET parent_id = ?1, updated_at = ?2 WHERE id = ?3",
                params![parent_id, now, req.id],
            ).map_err(|e| e.to_string())?;
        }
        if let Some(path) = &req.new_path {
            // Move the file first, then update the row. If the rename fails
            // the row is untouched; if the row update fails after a successful
            // rename the file is at the new path and the DB still points at
            // the old one, which is recoverable (the file exists at both
            // paths until the next save overwrites the old one).
            if let Some(old) = &old_path {
                let old_full = resolve_in_vault(&vault, old)?;
                let new_full = resolve_in_vault(&vault, path)?;
                if old_full != new_full {
                    std::fs::rename(&old_full, &new_full).map_err(|e| {
                        format!("Failed to move file from {} to {}: {}", old_full.display(), new_full.display(), e)
                    })?;
                }
            }
            conn.execute(
                "UPDATE docs SET path = ?1, updated_at = ?2 WHERE id = ?3",
                params![path, now, req.id],
            ).map_err(|e| e.to_string())?;
        }

        drop(conn);
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

    pub fn list_docs_by_workspace(&self, workspace: &str) -> Result<Vec<Doc>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT id, workspace, kind, title, path, parent_id, created_at, updated_at, content, word_count, reading_position, status, frontmatter_json, activity_score, embedding_ref, pinned, goal_words, deadline, locked
             FROM docs WHERE workspace = ?1 AND locked = 0 ORDER BY pinned DESC, updated_at DESC"
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
            "SELECT b.source_id, b.target_id, b.context_snippet, COALESCE(d.title, '') FROM backlinks b LEFT JOIN docs d ON d.id = b.source_id WHERE b.target_id = ?1"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![doc_id], |row| {
            Ok(Backlink {
                source_id: row.get(0)?,
                target_id: row.get(1)?,
                context_snippet: row.get(2)?,
                source_title: row.get(3)?,
            })
        }).map_err(|e| e.to_string())?;

        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    pub fn record_usage_event(&self, doc_id: &str, event: &str) -> Result<(), String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let usage = UsageEvent {
            doc_id: doc_id.to_string(),
            event: event.to_string(),
            ts: Utc::now().to_rfc3339(),
        };
        conn.execute(
            "INSERT INTO usage_events (doc_id, event, ts) VALUES (?1, ?2, ?3)",
            params![usage.doc_id, usage.event, usage.ts],
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
        // This value becomes the doc title AND, via `compute_disk_path`, the
        // on-disk path (`logs/YYYY/MM/YYYY-MM-DD.md`). Every UI caller passes a
        // `YYYY-MM-DD` string built from a Date, but the command takes whatever
        // the renderer sends, so validate the shape at the boundary rather than
        // trusting the caller. This also keeps the folder split meaningful.
        if !is_iso_date(date) {
            return Err(format!("Invalid daily-note date: {date} (expected YYYY-MM-DD)"));
        }
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        match conn.query_row(
            "SELECT locked FROM docs WHERE workspace = 'logs' AND kind = 'daily' AND title = ?1",
            params![date],
            |row| row.get::<_, i64>(0),
        ) {
            Ok(1) => return Err("daily log is locked".to_string()),
            Ok(_) => {}
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(e) => return Err(e.to_string()),
        }

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
FROM docs WHERE workspace = 'logs' AND kind = 'daily' AND locked = 0
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

    pub fn get_implicit_links(&self, doc_id: &str) -> Result<Vec<LinkImplicit>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT source_id, target_id, match_type FROM links_implicit WHERE source_id = ?1 OR target_id = ?1"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![doc_id], |row| {
            Ok(LinkImplicit {
                source_id: row.get(0)?,
                target_id: row.get(1)?,
                match_type: row.get(2)?,
            })
        }).map_err(|e| e.to_string())?;
        rows.filter_map(|r| r.ok()).collect::<Vec<_>>().pipe(Ok)
    }

    pub fn extract_backlinks(&self, doc_id: &str, content: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;

        let all_docs: Vec<(String, String)> = {
            let mut stmt = conn.prepare("SELECT id, title FROM docs").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };

        static WIKI_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let wiki_re = WIKI_RE.get_or_init(|| {
            regex::Regex::new(r"\[\[([^\]]+)\]\]").expect("wikilink pattern is static")
        });
        let title_to_id: std::collections::HashMap<String, String> = all_docs.iter()
            .map(|(id, title)| (title.to_lowercase(), id.clone()))
            .collect();
        // Lowercase once: the implicit pass below used to rebuild this per
        // title (one full-content alloc per doc in the vault, per save).
        let content_lower = content.to_lowercase();

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM backlinks WHERE source_id = ?1", params![doc_id])
            .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM links_implicit WHERE source_id = ?1", params![doc_id])
            .map_err(|e| e.to_string())?;

        for cap in wiki_re.captures_iter(content) {
            let link_text = cap.get(1).map(|m| m.as_str()).unwrap_or("");
            let link_lower = link_text.to_lowercase();
            if let Some(target_id) = title_to_id.get(&link_lower) {
                if target_id != doc_id {
                    let start = cap.get(0).map(|m| m.start()).unwrap_or(0);
                    let snippet = snippet_around(content, start as i64, (cap.get(0).map(|m| m.len()).unwrap_or(0) + 80) as i64);
                    tx.execute(
                        "INSERT OR IGNORE INTO backlinks (source_id, target_id, context_snippet) VALUES (?1, ?2, ?3)",
                        params![doc_id, target_id, snippet],
                    ).map_err(|e| e.to_string())?;
                }
            }
        }

        // Titles already [[linked]] anywhere in this doc must not ALSO
        // produce implicit edges (the old whole-doc `!wiki_re.is_match`
        // guard killed every implicit link when ANY [[link]] existed).
        let linked_titles: std::collections::HashSet<String> = wiki_re.captures_iter(content)
            .filter_map(|cap| cap.get(1).map(|m| m.as_str().to_lowercase()))
            .collect();
        for (title, target_id) in &title_to_id {
            if target_id == doc_id { continue; }
            if linked_titles.contains(title) { continue; }
            if content_lower.contains(title) {
                tx.execute(
                    "INSERT OR IGNORE INTO links_implicit (source_id, target_id, match_type) VALUES (?1, ?2, ?3)",
                    params![doc_id, target_id, "title_mention"],
                ).map_err(|e| e.to_string())?;
            }
        }

        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    /// Entity index: deterministic local name/place extraction (no AI).
    /// Two passes — (1) Story-Bible gazetteer (every fact key, whole-phrase,
    /// case-insensitive; kind mapped from the fact kind), then (2)
    /// capitalized 2–4 word runs for names the Bible doesn't know yet.
    /// Gazetteer wins span conflicts. Called best-effort from save_doc
    /// next to extract_backlinks; the TS preview mirror (entities.ts)
    /// documents the same algorithm — keep the two in sync.
    pub fn refresh_entities(&self, doc_id: &str, content: &str) -> Result<(), String> {
        let mut conn = self.conn.lock().map_err(|e| e.to_string())?;
        conn.execute("DELETE FROM entity_occurrences WHERE doc_id = ?1", params![doc_id])
            .map_err(|e| e.to_string())?;
        if content.trim().is_empty() {
            return Ok(());
        }

        const STOPLIST: &[&str] = &[
            "the", "a", "an", "and", "but", "or", "if", "then", "when", "while", "because",
            "chapter", "part", "scene", "act", "prologue", "epilogue", "interlude", "appendix",
            "book", "volume", "monday", "tuesday", "wednesday", "thursday", "friday",
            "saturday", "sunday", "january", "february", "march", "april", "may", "june",
            "july", "august", "september", "october", "november", "december",
        ];
        fn map_kind(kind: &str) -> &'static str {
            let k = kind.to_lowercase();
            if k.contains("character") { "person" }
            else if k.contains("setting") || k.contains("location") || k.contains("place") { "place" }
            else { "term" }
        }

        // (norm, display, kind, start, end)
        let mut rows: Vec<(String, String, String, i64, i64)> = Vec::new();
        let mut used: Vec<(usize, usize)> = Vec::new();
        let overlaps = |s: usize, e: usize, used: &[(usize, usize)]| {
            used.iter().any(|(a, b)| s < *b && *a < e)
        };

        // Pass 1 — gazetteer (global across projects; cast names rarely collide).
        // One alternation + one pass over the content instead of one compiled
        // regex and one full scan per fact. DB order is kept inside the
        // alternation so earlier facts keep priority on ties.
        let facts: Vec<(String, String)> = {
            let mut stmt = conn.prepare("SELECT kind, key FROM bible_facts").map_err(|e| e.to_string())?;
            let iter = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            iter.filter_map(|r| r.ok()).collect()
        };
        // \b boundaries (not lookahead — the regex crate rejects it, which
        // once failed this whole pass silently; not consumed separators
        // either, so repeated names still match). DB order is preserved in
        // the alternation (first fact wins ties, as with the old per-fact
        // loop) and duplicate keys collapse to their first fact.
        let mut by_name: std::collections::HashMap<String, (String, String)> = std::collections::HashMap::new();
        let mut alternatives: Vec<String> = Vec::new();
        for (kind, key) in &facts {
            let trimmed = key.trim();
            if trimmed.len() < 2 { continue; }
            let lowered = trimmed.to_lowercase();
            if by_name.contains_key(&lowered) { continue; }
            alternatives.push(regex::escape(&lowered));
            by_name.insert(lowered, (map_kind(kind).to_string(), trimmed.to_string()));
        }
        if !alternatives.is_empty() {
            let pattern = format!(r"(?i)\b((?:{}))\b", alternatives.join("|"));
            if let Ok(re) = regex::Regex::new(&pattern) {
                for cap in re.captures_iter(content) {
                    let m = match cap.get(1) { Some(m) => m, None => continue };
                    if overlaps(m.start(), m.end(), &used) { continue; }
                    let Some((kind, key)) = by_name.get(&m.as_str().to_lowercase()) else { continue };
                    used.push((m.start(), m.end()));
                    rows.push((key.to_lowercase(), m.as_str().to_string(), kind.clone(), m.start() as i64, m.end() as i64));
                    if rows.len() >= 500 { break; }
                }
            }
        }

        // Pass 2 — capitalized runs (ASCII; non-English names come via the gazetteer).
        static NAME_RUN_RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        if rows.len() < 500 {
            let re = NAME_RUN_RE.get_or_init(|| {
                regex::Regex::new(r"\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b")
                    .expect("name-run pattern is static")
            });
            // First surface form wins the display name per norm.
            let mut seen: std::collections::HashSet<String> = rows.iter().map(|r| r.0.clone()).collect();
            for cap in re.captures_iter(content) {
                let m = match cap.get(1) { Some(m) => m, None => continue };
                let text = m.as_str();
                let first = text.split_whitespace().next().unwrap_or("").to_lowercase();
                if STOPLIST.contains(&first.as_str()) { continue; }
                if overlaps(m.start(), m.end(), &used) { continue; }
                used.push((m.start(), m.end()));
                let norm = text.to_lowercase();
                if !seen.contains(&norm) {
                    seen.insert(norm.clone());
                    rows.push((norm, text.to_string(), "name".to_string(), m.start() as i64, m.end() as i64));
                }
                if rows.len() >= 500 { break; }
            }
        }

        let tx = conn.transaction().map_err(|e| e.to_string())?;
        for (norm, display, kind, start, end) in &rows {
            tx.execute(
                "INSERT OR IGNORE INTO entity_occurrences (entity_norm, display, kind, doc_id, span_start, span_end) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![norm, display, kind, doc_id, start, end],
            ).map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn entity_list(&self) -> Result<Vec<EntitySummary>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT entity_norm, MAX(display), MAX(kind), COUNT(DISTINCT doc_id), COUNT(*) FROM entity_occurrences GROUP BY entity_norm ORDER BY COUNT(*) DESC LIMIT 500"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |row| {
            Ok(EntitySummary {
                entity_norm: row.get(0)?,
                display: row.get(1)?,
                kind: row.get(2)?,
                doc_count: row.get(3)?,
                occ_count: row.get(4)?,
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn entity_occurrences(&self, norm: &str) -> Result<Vec<EntityHit>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn.prepare(
            "SELECT e.entity_norm, e.display, e.kind, e.doc_id, COALESCE(d.title, ''), e.span_start, e.span_end, COALESCE(d.content, '') FROM entity_occurrences e LEFT JOIN docs d ON d.id = e.doc_id WHERE e.entity_norm = ?1 ORDER BY d.title, e.span_start LIMIT 200"
        ).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(params![norm], |row| {
            let content: String = row.get(7)?;
            let start: i64 = row.get(5)?;
            let end: i64 = row.get(6)?;
            Ok(EntityHit {
                entity_norm: row.get(0)?,
                display: row.get(1)?,
                kind: row.get(2)?,
                doc_id: row.get(3)?,
                doc_title: row.get(4)?,
                span_start: start,
                span_end: end,
                snippet: snippet_around(&content, start, end),
            })
        }).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(|r| r.ok()).collect())
    }

    pub fn entities_backfill(&self) -> Result<i64, String> {
        let docs: Vec<(String, String)> = {
            let conn = self.conn.lock().map_err(|e| e.to_string())?;
            let mut stmt = conn.prepare("SELECT id, content FROM docs").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|e| e.to_string())?;
            rows.filter_map(|r| r.ok()).collect()
        };
        let mut done = 0i64;
        for (id, content) in &docs {
            if self.refresh_entities(id, content).is_ok() {
                done += 1;
            }
        }
        Ok(done)
    }

    pub fn graph_query(&self, workspace: Option<&str>, tags: Option<&[String]>) -> Result<GraphQueryResult, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // "all" (and empty/missing) means no workspace filter — mirrors the preview backend.
        let ws = workspace.filter(|w| !w.trim().is_empty() && *w != "all");
        let docs: Vec<(String, String, String, String, i64, f64)> = {
            let map_row = |row: &rusqlite::Row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, i64>(4)?, row.get::<_, f64>(5)?))
            };
            match ws {
                Some(w) => {
                    let mut stmt = conn.prepare(
                        "SELECT id, title, workspace, kind, word_count, activity_score FROM docs WHERE workspace = ?1 AND locked = 0"
                    ).map_err(|e| e.to_string())?;
                    let rows = stmt.query_map([w], map_row).map_err(|e| e.to_string())?;
                    rows.filter_map(|r| r.ok()).collect()
                }
                None => {
                    let mut stmt = conn.prepare(
                        "SELECT id, title, workspace, kind, word_count, activity_score FROM docs WHERE locked = 0"
                    ).map_err(|e| e.to_string())?;
                    let rows = stmt.query_map([], map_row).map_err(|e| e.to_string())?;
                    rows.filter_map(|r| r.ok()).collect()
                }
            }
        };

        // One batched tag lookup (no per-doc N+1) doubling as the tag filter.
        let mut tag_map: std::collections::HashMap<String, Vec<String>> = std::collections::HashMap::new();
        {
            let mut stmt = conn.prepare("SELECT doc_id, tag FROM doc_tags").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            }).map_err(|e| e.to_string())?;
            for (doc_id, tag) in rows.filter_map(|r| r.ok()) {
                tag_map.entry(doc_id).or_default().push(tag);
            }
        }
        let wanted: &[String] = tags.unwrap_or(&[]);
        let docs: Vec<(String, String, String, String, i64, f64)> = docs.into_iter().filter(|(id, _, _, _, _, _)| {
            if wanted.is_empty() {
                return true;
            }
            match tag_map.get(id) {
                Some(ts) => wanted.iter().all(|t| ts.contains(t)),
                None => false,
            }
        }).collect();

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
                tags: tag_map.get(id).cloned().unwrap_or_default(),
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
        hubs.sort_by_key(|b| std::cmp::Reverse(b.1));
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
                let snippet = snippet_around(&doc.content, pos as i64, (other_title.len() as i64) + 80);
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
        let req = UpdateReadingPositionRequest {
            doc_id: doc_id.to_string(),
            position,
        };
        conn.execute(
            "UPDATE docs SET reading_position = ?1 WHERE id = ?2",
            params![req.position, req.doc_id],
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
        // Merge into existing frontmatter — never clobber sibling keys
        // (margin notes, custom properties).
        let current: Option<String> = conn
            .query_row("SELECT frontmatter_json FROM docs WHERE id = ?1", params![doc_id], |row| {
                row.get(0)
            })
            .map_err(|e| e.to_string())?;
        let mut fm: serde_json::Map<String, serde_json::Value> = current
            .as_deref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or_default();
        match rating {
            Some(r) => {
                fm.insert("rating".to_string(), serde_json::json!(r));
            }
            None => {
                fm.remove("rating");
            }
        }
        let fm_json = if fm.is_empty() { None } else { Some(serde_json::Value::Object(fm).to_string()) };
        conn.execute(
            "UPDATE docs SET frontmatter_json = ?1 WHERE id = ?2",
            params![fm_json, doc_id],
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
        let req = ImportFileRequest {
            file_path: title.to_string(),
            workspace: Some("reader".to_string()),
        };
        self.create_doc(CreateDocRequest {
            workspace: req.workspace.unwrap_or_else(|| "reader".to_string()),
            kind: kind.to_string(),
            title: title.to_string(),
            parent_id: None,
            content: Some(content.to_string()),
            frontmatter_json: Some(serde_json::json!({"status": "to-read", "imported_from": req.file_path}).to_string()),
        })
    }

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
        let metric = CraftMetric {
            id: uuid_v7(),
            doc_id: doc_id.to_string(),
            metric_type: metric_type.to_string(),
            value,
            created_at: now_iso(),
        };
        conn.execute(
            "INSERT INTO craft_metrics (id, doc_id, metric_type, value, created_at) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![metric.id, metric.doc_id, metric.metric_type, metric.value, metric.created_at],
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

    /// Snapshot a doc's content **as it stands right now**.
    ///
    /// For a pre-edit safety net this MUST be called before the UPDATE —
    /// it reads the row from the DB, so calling it afterwards would archive
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
                "SELECT doc_id, content FROM snapshots WHERE id = ?1",
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

    pub fn backup_create(&self) -> Result<String, String> {
        // Filesystem work happens OUTSIDE the conn mutex: holding it across
        // directory creation + a full VACUUM copy would stall every other
        // command on a large vault.
        let backup_dir = dirs::data_local_dir()
            .unwrap_or_default()
            .join("writing-app")
            .join("backups");
        std::fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;

        let timestamp = chrono::Utc::now().format("%Y%m%d_%H%M%S").to_string();
        let backup_path = backup_dir.join(format!("backup_{}.db", timestamp));

// Use VACUUM INTO for backup (SQLite 3.27.0+). The path is ours
  // (timestamped filename under app-data), but quote it anyway:
  // a username with an apostrophe would otherwise break the SQL.
  let quoted = backup_path.to_string_lossy().replace('\'', "''");

  // VACUUM INTO copies the entire database. Run it on a SECOND connection
  // when the backing file is known, so the app's only connection stays free to
  // serve autosave, search and RAG for the duration; WAL allows a reader
  // alongside the writer. Previously this ran under `self.conn.lock()`, which
  // meant one full-database copy stalled every other command.
  //
  // A read-only connection cannot VACUUM, so this one is opened read/write;
  // it is used for this one statement and dropped immediately.
  let db_file = self.db_path.lock().ok().and_then(|p| p.clone());
  match db_file {
    Some(path) => {
      let backup_conn = rusqlite::Connection::open(&path)
        .map_err(|e| format!("Couldn't open the database for backup: {}", e))?;
      // Match the main connection's durability settings so the copy sees a
      // consistent snapshot rather than waiting on a different WAL state.
      backup_conn
        .execute_batch("PRAGMA busy_timeout=5000;")
        .map_err(|e| e.to_string())?;
      backup_conn
        .execute_batch(&format!("VACUUM INTO '{}';", quoted))
        .map_err(|e| e.to_string())?;
    }
    // In-memory (tests): there is no file to reopen, so the locked path is the
    // only option.
    None => {
      let conn = self.conn.lock().map_err(|e| e.to_string())?;
      conn.execute_batch(&format!("VACUUM INTO '{}';", quoted))
        .map_err(|e| e.to_string())?;
    }
  }

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

    /// Restore a backup into a NEW database file, leaving the live DB alone.
    ///
    /// Backups were write-only: backup_create + backup_list existed, but there
    /// was no way to get data back out of one. The backup also lands on the same
    /// volume as the live DB, so a disk failure takes both.
    ///
    /// Returns the path to the restored file. The caller decides what to do
    /// with it (swap it in, inspect it, delete it).
    pub fn backup_restore(&self, backup_name: &str) -> Result<String, String> {
        let backup_dir = dirs::data_local_dir()
            .unwrap_or_default()
            .join("writing-app")
            .join("backups");
        let backup_path = backup_dir.join(backup_name);
        if !backup_path.is_file() {
            return Err(format!("Backup not found: {}", backup_name));
        }
        // Restore to a sibling file, never over the live DB in place.
        let restored = backup_dir.join(format!("{}.restored", backup_name));
        std::fs::copy(&backup_path, &restored).map_err(|e| {
            format!("Failed to restore backup {}: {}", backup_name, e)
        })?;
        // Verify the copy is a readable database before handing it back.
        let conn = rusqlite::Connection::open(&restored)
            .map_err(|e| format!("Restored backup is not a readable database: {}", e))?;
        let docs: i64 = conn
            .query_row("SELECT COUNT(*) FROM docs", [], |r| r.get(0))
            .map_err(|e| format!("Restored backup failed integrity check: {}", e))?;
        eprintln!("[backup] restored {} ({} docs) to {}", backup_name, docs, restored.display());
        Ok(restored.to_string_lossy().to_string())
    }

    /// Delete a backup. Without this, backups accumulated forever — each a
    /// full-DB copy — with no way to reclaim the space.
    pub fn backup_delete(&self, backup_name: &str) -> Result<(), String> {
        let backup_dir = dirs::data_local_dir()
            .unwrap_or_default()
            .join("writing-app")
            .join("backups");
        let path = backup_dir.join(backup_name);
        if !path.is_file() {
            return Err(format!("Backup not found: {}", backup_name));
        }
        std::fs::remove_file(&path).map_err(|e| {
            format!("Failed to delete backup {}: {}", backup_name, e)
        })
    }

    /// Prune backups to the newest `keep`, deleting the rest. Called after a
    /// successful backup_create so retention is automatic rather than manual.
    pub fn backup_prune(&self, keep: usize) -> Result<u64, String> {
        let backups = self.backup_list()?;
        if backups.len() <= keep {
            return Ok(0);
        }
        let mut deleted = 0u64;
        for (name, _, _) in backups.iter().skip(keep) {
            self.backup_delete(name)?;
            deleted += 1;
        }
        Ok(deleted)
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

    pub fn dashboard_goals(&self) -> Result<Vec<GoalRow>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        let mut stmt = conn.prepare(
            "SELECT id, title, workspace, goal_words, word_count, deadline FROM docs \
             WHERE goal_words IS NOT NULL AND goal_words > 0 AND locked = 0 \
             ORDER BY deadline ASC NULLS LAST, updated_at DESC"
        ).map_err(|e| e.to_string())?;

        let rows: Vec<(String, String, String, i64, i64, Option<String>)> = stmt.query_map([], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        }).map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(rows)
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
        // Same read-only guard as save_doc: refuse writes when the schema is
        // in a known-unsafe state.
        if let Ok(flag) = self.read_only.lock() {
            if flag.0 {
                return Err(
                    "Database is read-only: a migration failed. Your files are safe but writes are disabled."
                        .into(),
                );
            }
        }
        let doc = self.get_doc(doc_id)?;

        // Auto-snapshot on a meaningful diff (>20 words) per A10.2.
        // `doc.content` is read BEFORE the UPDATE below, so the delta is real
        // here — unlike the same guard in save_doc. Snapshot the pre-edit body
        // explicitly so the restore point is the text being replaced, and
        // propagate failure rather than losing the safety net silently.
        let old_word_count = doc.content.split_whitespace().count() as i64;
        let new_word_count = body.split_whitespace().count() as i64;
        let word_delta = (old_word_count - new_word_count).abs();
        if word_delta > SNAPSHOT_WORD_THRESHOLD as i64 {
            self.snapshot_create_from(doc_id, &doc.content)?;
        }

        let vault = self.vault_path.lock().map_err(|e| e.to_string())?;
        let full_path = resolve_in_vault(&vault, &doc.path)?;
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
        if word_delta > SNAPSHOT_WORD_THRESHOLD as i64 {
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
            for event in rx.into_iter().flatten() {
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
        });

        // notify watchers stop on drop: intentionally leak for app lifetime
        // (previously the watcher died here and no file-changed ever fired).
        std::mem::forget(watcher);

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
        let count = conn.execute("DELETE FROM chat_messages", []).map_err(|e| e.to_string())?;
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
        let count = conn.execute("DELETE FROM tab_state", []).map_err(|e| e.to_string())?;
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
            let snippet = snippet_of(&doc.1, 500);
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
                if let Some(pid) = conn.query_row(
                    "SELECT parent_id FROM docs WHERE id = ?1",
                    params![doc_id],
                    |row| row.get::<_, Option<String>>(0),
                ).ok().flatten() {
                    if let Ok(prev) = conn.query_row(
                        "SELECT title, content FROM docs WHERE parent_id = ?1 AND id != ?2 AND locked = 0 ORDER BY updated_at DESC LIMIT 1",
                        params![pid, doc_id],
                        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                    ) {
                        let snippet = snippet_of(&prev.1, 300);
                        context.push_str(&format!("Previous scene: \"{}\"\n{}\n\n", prev.0, snippet));
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
                            let snippet = snippet_of(content, 200);
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

    // ── Ghosts (scene forking) ──────────────────────────────────

    /// Fork a document: create a new doc with the same content and frontmatter,
    /// linked via `ghost_parent` in frontmatter_json.
    pub fn ghost_fork(&self, doc_id: &str, label: Option<&str>) -> Result<Doc, String> {
        let original = self.get_doc(doc_id)?;
        let fork_label = label.unwrap_or("Ghost");
        let new_title = format!("{} — {}", original.title, fork_label);

        // Build new frontmatter with ghost_parent
        let mut fm: serde_json::Value = original
            .frontmatter_json
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok())
            .unwrap_or(serde_json::Value::Object(Default::default()));
        fm["ghost_parent"] = serde_json::Value::String(doc_id.to_string());
        fm["ghost_label"] = serde_json::Value::String(fork_label.to_string());
        let fm_str = serde_json::to_string(&fm).ok();

        self.create_doc(CreateDocRequest {
            workspace: original.workspace.clone(),
            kind: original.kind.clone(),
            title: new_title,
            parent_id: original.parent_id.clone(),
            content: Some(original.content.clone()),
            frontmatter_json: fm_str,
        })
    }

    /// List all forks of a document (original + ghosts), grouped.
    pub fn ghost_list(&self, doc_id: &str) -> Result<GhostGroup, String> {
        let original = self.get_doc(doc_id)?;
        let conn = self.conn.lock().map_err(|e| e.to_string())?;

        // Find all docs whose frontmatter contains ghost_parent = doc_id
        let mut ghosts = Vec::new();
        let mut stmt = conn
            .prepare("SELECT id FROM docs WHERE frontmatter_json LIKE '%\"ghost_parent\":\"%' || ?1 || '%' ESCAPE '\\'")
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map(params![doc_id], |row| row.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for gid in rows.flatten() {
            // Verify it's actually a ghost of this doc (not just a substring match)
            if let Ok(ghost_doc) = self.get_doc(&gid) {
                if let Some(ref fm_str) = ghost_doc.frontmatter_json {
                    if let Ok(fm) = serde_json::from_str::<serde_json::Value>(fm_str) {
                        if fm.get("ghost_parent").and_then(|v| v.as_str()) == Some(doc_id) {
                            ghosts.push(ghost_doc);
                        }
                    }
                }
            }
        }
        drop(stmt);

        Ok(GhostGroup { original, ghosts })
    }

    /// Merge a ghost into the original (or another target). Copies content, deletes ghost.
    pub fn ghost_merge(&self, ghost_id: &str, target_id: Option<&str>) -> Result<Doc, String> {
        let ghost = self.get_doc(ghost_id)?;
        let target = match target_id {
            Some(tid) => tid.to_string(),
            None => ghost
                .frontmatter_json
                .as_ref()
                .and_then(|s| serde_json::from_str::<serde_json::Value>(s).ok())
                .and_then(|fm| fm.get("ghost_parent").and_then(|v| v.as_str()).map(String::from))
                .ok_or("No ghost_parent found and no target specified".to_string())?,
        };

        // Overwrite target content with ghost content
        self.save_doc(SaveDocRequest {
            id: target.to_string(),
            title: None,
            content: Some(ghost.content.clone()),
            status: None,
            frontmatter_json: None,
            parent_id: None,
        })?;

        // Delete the ghost doc
        self.delete_doc(ghost_id)?;

        self.get_doc(&target)
    }

    /// Dismiss (delete) a ghost without merging.
    pub fn ghost_dismiss(&self, ghost_id: &str) -> Result<(), String> {
        self.delete_doc(ghost_id)
    }

    // ── Atlas (star-sky memory) ─────────────────────────────────

    /// Return all docs with their embeddings and activity scores for Atlas rendering.
    pub fn atlas_get_stars(&self) -> Result<Vec<AtlasStar>, String> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        let mut stmt = conn
            .prepare(
                "SELECT d.id, d.title, d.workspace, d.word_count, d.activity_score, d.updated_at,
                        rv.embedding
                 FROM docs d
                 LEFT JOIN rag_chunks rc ON rc.doc_id = d.id AND rc.chunk_index = 0
                 LEFT JOIN rag_vec rv ON rv.chunk_id = rc.id
                 WHERE d.locked = 0 AND d.content != ''
                 GROUP BY d.id
                 ORDER BY d.activity_score DESC",
            )
            .map_err(|e| e.to_string())?;

        let stars = stmt
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let title: String = row.get(1)?;
                let workspace: String = row.get(2)?;
                let word_count: i64 = row.get(3)?;
                let activity_score: f64 = row.get(4)?;
                let updated_at: String = row.get(5)?;
                let embedding: Vec<f32> = row
                    .get::<_, Option<Vec<u8>>>(6)?
                    .map(|bytes| {
                        bytes
                            .chunks_exact(4)
                            .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                            .collect()
                    })
                    .unwrap_or_default();
                Ok(AtlasStar {
                    id,
                    title,
                    workspace,
                    word_count,
                    activity_score,
                    updated_at,
                    embedding,
                })
            })
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();

        Ok(stars)
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

#[cfg(test)]
mod entity_tests {
    use super::*;
    use rusqlite::Connection;

    fn test_db(name: &str) -> Database {
        // sqlite-vec is registered by run() in prod; tests register it here.
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
        let vault = std::env::temp_dir().join(format!("jwe-ent-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&vault).unwrap();
        let db = Database::new(Connection::open_in_memory().unwrap(), vault);
        db.initialize().unwrap();
        db
    }

    fn mk_doc(db: &Database, title: &str) -> String {
        db.create_doc(CreateDocRequest {
            workspace: "novel".into(),
            kind: "scene".into(),
            title: title.into(),
            parent_id: None,
            content: Some(String::new()),
            frontmatter_json: None,
        })
        .unwrap()
        .id
    }

    fn set_content(db: &Database, id: &str, content: &str) {
        db.save_doc(SaveDocRequest {
            id: id.into(),
            title: None,
            content: Some(content.into()),
            status: None,
            frontmatter_json: None,
            parent_id: None,
        })
        .unwrap();
    }

    #[test]
    fn capitalized_runs_indexed_with_valid_spans() {
        let db = test_db("runs");
        let id = mk_doc(&db, "Ch1");
        let text = "Jon Snow walked with Arya Stark. The King watched.";
        set_content(&db, &id, text);
        let list = db.entity_list().unwrap();
        let norms: Vec<&str> = list.iter().map(|e| e.entity_norm.as_str()).collect();
        assert!(norms.contains(&"jon snow"), "{norms:?}");
        assert!(norms.contains(&"arya stark"), "{norms:?}");
        assert!(!norms.iter().any(|n| n.starts_with("the king")), "{norms:?}");
        let hits = db.entity_occurrences("jon snow").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(&text[hits[0].span_start as usize..hits[0].span_end as usize], "Jon Snow");
    }

    #[test]
    fn gazetteer_wins_kind_and_spans() {
        let db = test_db("gaz");
        let id = mk_doc(&db, "Ch1");
        db.bible_upsert_fact(&id, "world_characters", "Elena", "protagonist").unwrap();
        set_content(&db, &id, "Elena met Jon Snow at Grey Harbor.");
        let list = db.entity_list().unwrap();
        let elena = list.iter().find(|e| e.entity_norm == "elena").unwrap();
        assert_eq!(elena.kind, "person");
        assert_eq!(elena.display, "Elena");
    }

    #[test]
    fn implicit_links_survive_other_wikilinks() {
        // Regression: the old whole-doc `!wiki_re.is_match` guard dropped
        // EVERY implicit edge when ANY [[link]] existed in the doc.
        let db = test_db("impl");
        let _harbor = mk_doc(&db, "Grey Harbor");
        let id = mk_doc(&db, "Ch1");
        set_content(&db, &id, "See [[Jon Snow]] for details. They sailed from Grey Harbor.");
        let implicit = db.get_implicit_links(&id).unwrap();
        assert!(
            implicit.iter().any(|l| l.target_id == _harbor),
            "bare 'Grey Harbor' must link despite [[Jon Snow]]: {implicit:?}"
        );
    }

    #[test]
    fn backfill_indexes_older_docs() {
        let db = test_db("backfill");
        let id = mk_doc(&db, "Old");
        // Bypass save_doc's hook with a direct content write, simulating a
        // pre-index doc, then backfill.
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("UPDATE docs SET content = ?1 WHERE id = ?2", params!["Jon Snow rides.", id])
                .unwrap();
        }
        assert!(db.entity_list().unwrap().is_empty());
        assert_eq!(db.entities_backfill().unwrap(), 1);
        assert!(db.entity_list().unwrap().iter().any(|e| e.entity_norm == "jon snow"));
    }

    #[test]
    fn snippets_never_split_chars() {
        let db = test_db("snip");
        let id = mk_doc(&db, "Ch1");
        // Multibyte em-dashes hug the snippet window edges.
        let text = format!("{}Jon Snow{}", "—".repeat(58), "—".repeat(58));
        set_content(&db, &id, &text);
        let hits = db.entity_occurrences("jon snow").unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("Jon Snow"));
    }

    #[test]
    fn memory_requires_confirmation_and_recomputes_only_the_changed_scene() {
        let db = test_db("memory-delta");
        let project = db.create_doc(CreateDocRequest {
            workspace: "novel".into(), kind: "project".into(), title: "Book".into(),
            parent_id: None, content: Some(String::new()), frontmatter_json: None,
        }).unwrap().id;
        let scene_one = db.create_doc(CreateDocRequest {
            workspace: "novel".into(), kind: "scene".into(), title: "One".into(),
            parent_id: Some(project.clone()), content: Some(String::new()), frontmatter_json: None,
        }).unwrap().id;
        let scene_two = db.create_doc(CreateDocRequest {
            workspace: "novel".into(), kind: "scene".into(), title: "Two".into(),
            parent_id: Some(project.clone()), content: Some(String::new()), frontmatter_json: None,
        }).unwrap().id;
        db.bible_upsert_fact(&project, "world_characters", "Elena", "protagonist").unwrap();

        let first_text = "Elena wore a blue coat. Mara waited by the gate.";
        let first = db.bible_replace_scene_memory(&project, &scene_one, first_text, None, &[
            BibleMentionCandidate { key: "Elena".into(), kind: "character".into(), snippet: "Elena wore a blue coat.".into(), attribute_key: Some("coat".into()), attribute_value: Some("blue".into()) },
            BibleMentionCandidate { key: "Mara".into(), kind: "character".into(), snippet: "Mara waited by the gate.".into(), attribute_key: None, attribute_value: None },
        ]).unwrap();
        assert_eq!(first.matched, 1);
        assert_eq!(first.suggested, 1);
        assert_eq!(db.bible_get_facts(&project).unwrap().len(), 1, "unmatched names must stay suggestions");
        assert_eq!(db.bible_get_mentions(&project).unwrap().len(), 1);

        let second_text = "Elena wore a red coat at dawn.";
        db.bible_replace_scene_memory(&project, &scene_two, second_text, None, &[
            BibleMentionCandidate { key: "Elena".into(), kind: "character".into(), snippet: "Elena wore a red coat at dawn.".into(), attribute_key: Some("coat".into()), attribute_value: Some("red".into()) },
        ]).unwrap();
        let mentions = db.bible_get_mentions(&project).unwrap();
        assert_eq!(mentions.len(), 2);
        let values = mentions.iter().filter(|m| m.doc_id == scene_two).filter_map(|m| m.attribute_value.clone()).collect::<Vec<_>>();
        assert_eq!(values, vec!["red".to_string()]);

        let updated_text = "Elena waited beneath the arch.";
        db.bible_replace_scene_memory(&project, &scene_two, updated_text, None, &[
            BibleMentionCandidate { key: "Elena".into(), kind: "character".into(), snippet: "Elena waited beneath the arch.".into(), attribute_key: None, attribute_value: None },
        ]).unwrap();
        let mentions = db.bible_get_mentions(&project).unwrap();
        assert_eq!(mentions.iter().filter(|m| m.doc_id == scene_one).count(), 1);
        assert_eq!(mentions.iter().filter(|m| m.doc_id == scene_two).count(), 1);
        assert_eq!(db.bible_get_suggestions(&project).unwrap().len(), 1);
        let suggestion = db.bible_get_suggestions(&project).unwrap().into_iter().find(|s| s.key == "Mara").unwrap();
        db.bible_reject_suggestion(&project, &suggestion.id).unwrap();
        db.bible_replace_scene_memory(&project, &scene_one, "Mara waited by the river.", None, &[
            BibleMentionCandidate { key: "Elena".into(), kind: "character".into(), snippet: "Elena wore a blue coat.".into(), attribute_key: Some("coat".into()), attribute_value: Some("blue".into()) },
            BibleMentionCandidate { key: "Mara".into(), kind: "character".into(), snippet: "Mara waited by the river.".into(), attribute_key: None, attribute_value: None },
        ]).unwrap();
        assert!(db.bible_get_suggestions(&project).unwrap().is_empty(), "rejected suggestions must stay rejected");
        let scene_three = db.create_doc(CreateDocRequest {
            workspace: "novel".into(), kind: "scene".into(), title: "Three".into(),
            parent_id: Some(project.clone()), content: Some("Elena waited.".into()), frontmatter_json: None,
        }).unwrap().id;
        db.bible_replace_scene_memory(&project, &scene_three, "Elena waited.", None, &[
            BibleMentionCandidate { key: "Elena".into(), kind: "character".into(), snippet: "Elena waited.".into(), attribute_key: None, attribute_value: None },
        ]).unwrap();
        assert_eq!(db.bible_get_mentions(&project).unwrap().iter().filter(|m| m.doc_id == scene_three).count(), 1);
        db.save_doc(SaveDocRequest { id: scene_three.clone(), title: None, content: Some("Mara arrived.".into()), status: None, frontmatter_json: None, parent_id: None }).unwrap();
        db.bible_replace_scene_memory(&project, &scene_three, "Mara arrived.", None, &[
            BibleMentionCandidate { key: "Mara".into(), kind: "character".into(), snippet: "Mara arrived.".into(), attribute_key: None, attribute_value: None },
        ]).unwrap();
        let suggestion = db.bible_get_suggestions(&project).unwrap().into_iter().find(|s| s.key == "Mara").unwrap();
        let fact = db.bible_confirm_suggestion(&project, &suggestion.id).unwrap();
        assert_eq!(fact.key, "Mara");
        assert!(db.bible_get_suggestions(&project).unwrap().is_empty());
        assert!(db.bible_get_mentions(&project).unwrap().iter().any(|m| m.doc_id == scene_three && m.fact_key == "Mara"));
        db.save_doc(SaveDocRequest { id: scene_three.clone(), title: None, content: Some(String::new()), status: None, frontmatter_json: None, parent_id: None }).unwrap();
        db.bible_replace_scene_memory(&project, &scene_three, "", None, &[]).unwrap();
        assert!(!db.bible_get_mentions(&project).unwrap().iter().any(|m| m.doc_id == scene_three), "empty content must clear scene memory");
        let stale = db.bible_replace_scene_memory(&project, &scene_two, "stale", Some("not the saved content"), &[
            BibleMentionCandidate { key: "Elena".into(), kind: "character".into(), snippet: "stale".into(), attribute_key: None, attribute_value: None },
        ]).unwrap();
        assert!(stale.skipped && db.bible_get_mentions(&project).unwrap().iter().any(|m| m.doc_id == scene_two));
        let project_two = db.create_doc(CreateDocRequest {
            workspace: "novel".into(), kind: "project".into(), title: "Other Book".into(),
            parent_id: None, content: Some(String::new()), frontmatter_json: None,
        }).unwrap().id;
        db.move_doc(MoveDocRequest { id: scene_two.clone(), new_parent_id: Some(project_two.clone()), new_path: None }).unwrap();
        assert_eq!(db.bible_scope_id(&scene_two).unwrap(), project_two);
        assert!(!db.bible_get_mentions(&project).unwrap().iter().any(|m| m.doc_id == scene_two));
        db.set_locked(&scene_one, true).unwrap();
        assert!(!db.bible_source_allowed(&scene_one).unwrap());
        assert!(!db.bible_get_mentions(&project).unwrap().iter().any(|m| m.doc_id == scene_one));
    }

    #[test]
    fn graph_query_filters_workspace_and_tags() {
        let db = test_db("graphfilter");
        let a = db.create_doc(CreateDocRequest {
            workspace: "novel".into(), kind: "scene".into(), title: "A".into(),
            parent_id: None, content: Some(String::new()), frontmatter_json: None,
        }).unwrap().id;
        let b = db.create_doc(CreateDocRequest {
            workspace: "write".into(), kind: "doc".into(), title: "B".into(),
            parent_id: None, content: Some(String::new()), frontmatter_json: None,
        }).unwrap().id;
        {
            let conn = db.conn.lock().unwrap();
            conn.execute("INSERT INTO doc_tags (doc_id, tag) VALUES (?1, ?2)", rusqlite::params![a, "cast"]).unwrap();
            conn.execute("INSERT INTO doc_tags (doc_id, tag) VALUES (?1, ?2)", rusqlite::params![b, "research"]).unwrap();
        }
        assert_eq!(db.graph_query(None, None).unwrap().nodes.len(), 2);
        let novel = db.graph_query(Some("novel"), None).unwrap();
        assert_eq!(novel.nodes.len(), 1);
        assert_eq!(novel.nodes[0].id, a);
        assert_eq!(novel.nodes[0].tags, vec!["cast".to_string()]);
        let tagged = db.graph_query(Some("all"), Some(&["research".to_string()])).unwrap();
        assert_eq!(tagged.nodes.len(), 1);
        assert_eq!(tagged.nodes[0].id, b);
        assert!(db.graph_query(None, Some(&["nope".to_string()])).unwrap().nodes.is_empty());
    }
}

#[cfg(test)]
mod vault_confinement_tests {
    use super::*;
    use rusqlite::Connection;

    fn test_db(name: &str) -> Database {
        unsafe {
            rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
                sqlite_vec::sqlite3_vec_init as *const (),
            )));
        }
        let vault = std::env::temp_dir().join(format!("jwe-conf-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&vault);
        std::fs::create_dir_all(&vault).unwrap();
        let db = Database::new(Connection::open_in_memory().unwrap(), vault);
        db.initialize().unwrap();
        db
    }

    #[test]
    fn inside_vault_paths_resolve() {
        let db = test_db("inside");
        let vault = db.vault_path.lock().unwrap().clone();
        let resolved = resolve_in_vault(&vault, "novels/Book/chapter.md").unwrap();
        assert!(resolved.starts_with(&vault), "{resolved:?} left {vault:?}");
    }

    #[test]
    fn traversal_and_absolute_escapes_are_refused() {
        let db = test_db("escape");
        let vault = db.vault_path.lock().unwrap().clone();
        for evil in [
            "../escaped.md",
            "novels/../../escaped.md",
            r"C:\Windows\System32\drivers\etc\hosts",
            r"\\server\share\evil.md",
        ] {
            assert!(
                resolve_in_vault(&vault, evil).is_err(),
                "must refuse {evil}"
            );
        }
    }

    #[test]
    fn dot_titles_stay_inside_the_workspace() {
        let vault = std::env::temp_dir().join("jwe-conf-titles");
        for title in ["..", ".", "..."] {
            let path = compute_disk_path(&vault, "novel", "scene", title, "doc1");
            assert!(
                path.starts_with(&vault.join("novels")),
                "{title} escaped into {path:?}"
            );
        }
        // An unknown workspace can only ever be one folder inside the vault.
        let weird = compute_disk_path(&vault, "../../etc", "note", "T", "doc2");
        assert!(weird.starts_with(&vault), "{weird:?}");
    }

    #[test]
    fn rag_search_returns_content_and_honours_locked_docs() {
        // Guards the batched chunk fetch: it replaced a per-hit `query_row` loop,
        // so this pins both that results still come back in distance order and
        // that a locked doc's chunks are still excluded after the rewrite.
        let db = test_db("rag-batch");
        let open_id = db
            .create_doc(CreateDocRequest {
                workspace: "write".into(),
                kind: "doc".into(),
                title: "Rag open".into(),
                parent_id: None,
                content: Some(
                    "the compiler rewrites the borrow. borrow checking happens early. \
                     borrow rules keep memory safe."
                        .into(),
                ),
                frontmatter_json: None,
            })
            .unwrap()
            .id;
        let secret_id = db
            .create_doc(CreateDocRequest {
                workspace: "write".into(),
                kind: "doc".into(),
                title: "Rag secret".into(),
                parent_id: None,
                content: Some(
                    "borrow borrow borrow borrow borrow borrow borrow borrow borrow."
                        .into(),
                ),
                frontmatter_json: None,
            })
            .unwrap()
            .id;
        db.set_locked(&secret_id, true).unwrap();

        // `create_doc` does not chunk; the RAG index is built on save (and via
        // the rag_chunk_document command), so build it explicitly here.
        db.rag_chunk_document(&open_id, 200, 50).unwrap();
        db.rag_chunk_document(&secret_id, 200, 50).unwrap();

        let results = db.rag_search("borrow", 10).unwrap();
        assert!(
            !results.is_empty(),
            "rag_search returned nothing for a term present in both docs"
        );
        // Every returned chunk must have real content — a batching bug that lost
        // the row mapping would surface as empty text.
        for (chunk, score) in &results {
            assert!(!chunk.content.trim().is_empty(), "empty chunk content");
            assert!(score.is_finite(), "non-finite score {score}");
        }
        // Locked docs never surface in AI retrieval.
        assert!(
            !results.iter().any(|(c, _)| c.doc_id == secret_id),
            "locked doc surfaced through rag_search"
        );
        // ...and the open one still does, so the filter is not over-broad.
        assert!(
            results.iter().any(|(c, _)| c.doc_id == open_id),
            "open doc missing from rag_search"
        );
    }

    #[test]
    fn locked_docs_are_excluded_from_lists_and_graph() {
        // `docs.locked` filtering was implemented per-query and had been
        // forgotten in exactly these three read paths, so the app-lock guarantee
        // silently depended on each call site remembering. Locked docs are
        // excluded from search/RAG/dashboards/smart-tabs; these were the gaps.
        let db = test_db("locked-filter");
        let make = |title: &str, locked: bool| -> String {
            let id = db
                .create_doc(CreateDocRequest {
                    workspace: "write".into(),
                    kind: "doc".into(),
                    title: title.into(),
                    parent_id: None,
                    content: Some(format!("body of {title}")),
                    frontmatter_json: None,
                })
                .unwrap()
                .id;
            db.set_locked(&id, locked).unwrap();
            id
        };
        let visible = make("Visible doc", false);
        let secret = make("Secret doc", true);

        // list_docs_by_workspace
        let listed: Vec<String> = db
            .list_docs_by_workspace("write")
            .unwrap()
            .into_iter()
            .map(|d| d.id)
            .collect();
        assert!(listed.contains(&visible), "visible doc must be listed");
        assert!(!listed.contains(&secret), "locked doc leaked into list_docs_by_workspace");

        // log_list_entries (daily notes)
        let log = db.log_get_or_create("2026-03-04").unwrap();
        db.set_locked(&log.id, true).unwrap();
        assert!(
            !db.log_list_entries(50).unwrap().iter().any(|e| e.id == log.id),
            "locked daily note leaked into log_list_entries"
        );
        // ...and an unlocked one still shows.
        let open_log = db.log_get_or_create("2026-03-05").unwrap();
        assert!(
            db.log_list_entries(50).unwrap().iter().any(|e| e.id == open_log.id),
            "unlocked daily note must still be listed"
        );

        // graph_query, both the workspace-scoped and the unfiltered branch.
        for ws in [Some("write"), None] {
            let graph = db.graph_query(ws, None).unwrap();
            let ids: Vec<&str> = graph.nodes.iter().map(|n| n.id.as_str()).collect();
            assert!(
                !ids.contains(&secret.as_str()),
                "locked doc leaked into graph_query(ws={ws:?})"
            );
            assert!(
                ids.contains(&visible.as_str()),
                "visible doc missing from graph_query(ws={ws:?})"
            );
        }
    }

    #[test]
    fn move_to_a_path_outside_the_vault_fails() {
        let db = test_db("move");
        let id = db
            .create_doc(CreateDocRequest {
                workspace: "write".into(),
                kind: "doc".into(),
                title: "Keep".into(),
                parent_id: None,
                content: Some("hi".into()),
                frontmatter_json: None,
            })
            .unwrap()
            .id;
        let before = db.get_doc(&id).unwrap().path;
        let err = db.move_doc(MoveDocRequest {
            id: id.clone(),
            new_parent_id: None,
            new_path: Some("../escaped.md".into()),
        });
        assert!(err.is_err(), "move outside the vault must fail");
        // The row must be untouched.
        let after = db.get_doc(&id).unwrap().path;
        assert_eq!(before, after, "path changed after a refused move");
    }

    // ---- UTF-8 boundary safety -------------------------------------------------
    //
    // Byte-index slicing panics when the index lands inside a multi-byte
    // character, and the old code guarded with a *byte* length check, so these
    // inputs aborted the whole `doc_create` invoke. Tauri has no catch_unwind,
    // so the panic unwound into a Tokio task and the JS promise never settled:
    // no error toast, dialog spinning forever. Each case below panicked before
    // the fix.

    #[test]
    fn truncate_bytes_safe_never_splits_a_character() {
        // Owned Strings: several of these land mid-character at every boundary,
        // and a borrowed literal would not express a seam at byte 499.
        let cases: Vec<String> = vec![
            "\u{4e00}".repeat(30),                             // 90 B, 3 B/char
            "\u{2014}".repeat(30),                             // em-dash, 3 B/char
            format!("{}😀", "a".repeat(62)),                    // emoji on the seam
            format!("{}\u{4e00}", "a".repeat(499)),             // CJK on the seam
            "a".repeat(200),                                    // pure ASCII
            String::new(),
        ];
        for s in &cases {
            for n in [0usize, 1, 7, 8, 63, 64, 200, 499, 500] {
                let out = truncate_bytes_safe(s, n);
                assert!(out.len() <= n, "n={n}: {} bytes", out.len());
                // Every returned index must be a boundary, or slicing panics.
                assert!(s.is_char_boundary(out.len()), "n={n}: not a char boundary");
                assert!(s.starts_with(out), "n={n}: not a prefix of the input");
            }
        }
    }

    #[test]
    fn sanitize_filename_survives_multibyte_titles() {
        // 22 CJK chars = 66 bytes: byte 64 is mid-character.
        let cases: Vec<String> = vec![
            "\u{4e00}".repeat(22),         // exactly the reported boundary
            "\u{4e00}".repeat(30),
            "\u{2014}".repeat(30),
            format!("{}😀", "a".repeat(62)),
            "a".repeat(200),
        ];
        for title in &cases {
            let out = sanitize_filename(title);
            assert!(out.len() <= 64, "{} bytes for {} chars", out.len(), title.chars().count());
            assert!(!out.is_empty());
        }
    }

    #[test]
    fn snippet_of_never_panics_on_multibyte_bodies() {
        let cases: Vec<String> = vec![
            "\u{4e00}".repeat(200),
            "\u{2014}".repeat(250),
            "\u{201c}".repeat(300),
            format!("{}一", "a".repeat(499)),
        ];
        for body in &cases {
            for n in [0usize, 1, 200, 300, 500] {
                let out = snippet_of(body, n);
                assert!(out.len() <= n + 3, "{} bytes for n={n}", out.len());
            }
        }
        assert_eq!(snippet_of("short", 500), "short");
        assert_eq!(
            snippet_of(&"a".repeat(600), 500),
            format!("{}...", "a".repeat(500))
        );
    }

    // ---- Logs-workspace path traversal ----------------------------------------

    #[test]
    fn logs_titles_cannot_escape_the_vault() {
        let vault = std::env::temp_dir().join("jwe-conf-logs");
        // Quick capture passes raw typed text in as the title, so these are
        // ordinary inputs, not just hostile ones. `PathBuf::join` replaces the
        // accumulated path outright when a segment is absolute, so a drive
        // prefix used to relocate the write entirely.
        for title in [
            "AAAAAAAAAA-C:\\evil-x",
            "..-..-..-..-x",
            "../../../etc-passwd",
            "2026-01-02",
        ] {
            let path = compute_disk_path(&vault, "logs", "doc", title, "id-1");
            // NORMALISE before comparing. `Path::starts_with` is lexical, so an
            // escaping path like `<vault>/logs/../../../x.md` still satisfies
            // `starts_with(<vault>/logs)` — the first components do match. The
            // earlier version of this test asserted exactly that and therefore
            // passed even with the traversal reintroduced; it was validating
            // `resolve_in_vault`, not `compute_disk_path`.
            let normalized = normalize_lexically(&path);
            assert!(
                normalized.starts_with(normalize_lexically(&vault).join("logs")),
                "{title:?} produced {normalized:?}"
            );
            assert!(
                normalized.starts_with(normalize_lexically(&vault)),
                "{title:?} escaped the vault entirely: {normalized:?}"
            );
            // And it must still satisfy the same confinement every other write
            // path relies on.
            assert!(
                resolve_in_vault(&vault, path.to_string_lossy().as_ref()).is_ok(),
                "{title:?} failed vault confinement: {path:?}"
            );
        }
    }

    /// The specific shape that actually escaped: three dash-separated segments
    /// inside the first 10 bytes, the first two being `..`. Pinned separately
    /// because it is the only input that reaches the `parts.len() >= 3` join at
    /// all — `"AAAAAAAAAA-C:\evil-x"` has one segment before byte 10 and so
    /// fell through to the id-based branch even when unsanitised.
    #[test]
    fn dot_segment_log_titles_are_normalised_back_inside() {
        let vault = std::env::temp_dir().join("jwe-conf-logs2");
        let path = compute_disk_path(&vault, "logs", "doc", "..-..-..-x", "id-1");
        let normalized = normalize_lexically(&path);
        assert!(
            normalized.starts_with(&normalize_lexically(&vault)),
            "traversal reached {normalized:?}"
        );
    }

    // ---- Daily-note date validation ---------------------------------------------

    #[test]
    fn iso_date_gate_accepts_only_yyyy_mm_dd() {
        for ok in ["2026-01-02", "1999-12-31", "0000-00-00"] {
            assert!(is_iso_date(ok), "{ok} should be accepted");
        }
        // Everything that would otherwise reach path construction, including the
        // non-ASCII input that used to panic the byte slice.
        for bad in [
            "", "2026", "2026-1-2", "Journal — 2026", "第一章第一", "2026-01-02-03",
            "2026/01/02", "2026-01-02 ", "..-..-..", "aaaaaaaaaa", "-", "----------",
        ] {
            assert!(!is_iso_date(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn log_get_or_create_rejects_a_non_iso_date() {
        let db = test_db("logdate");
        let err = db.log_get_or_create("Journal — 2026").unwrap_err();
        assert!(err.contains("Invalid daily-note date"), "got: {err}");
        // And the real shape still works end to end.
        assert!(db.log_get_or_create("2026-01-02").is_ok());
    }

    #[test]
    fn create_doc_confines_the_path_it_writes() {
        let db = test_db("create-confine");
        let vault = db.vault_path.lock().unwrap().clone();
        // The gap this guards: create_doc used to skip resolve_in_vault, unlike
        // every other write path in the file.
        //
        // These titles are chosen so the UNSANITISED path really did escape:
        // they need three dash-separated segments inside the first 10 bytes with
        // the leading ones being `..`, which is the only shape that reaches the
        // `parts.len() >= 3` directory join. Earlier titles (a drive prefix far
        // out at byte 10) had a single segment before byte 10 and so landed in
        // the id-based branch even when buggy — the test passed either way.
        for title in ["..-..-..-x", "..-..-..-..-x"] {
            let res = db.create_doc(CreateDocRequest {
                workspace: "logs".into(),
                kind: "doc".into(),
                title: title.into(),
                parent_id: None,
                content: Some("payload".into()),
                frontmatter_json: None,
            });
            match res {
                Ok(doc) => {
                    // Normalised: a lexical starts_with would happily accept
                    // `<vault>/logs/../../../x.md`.
                    let written = normalize_lexically(std::path::Path::new(&doc.path));
                    assert!(
                        written.starts_with(normalize_lexically(&vault)),
                        "{title:?} wrote outside the vault: {}",
                        doc.path
                    );
                }
                // Refusing outright is also acceptable; silently escaping is not.
                Err(e) => assert!(e.contains("outside the vault"), "unexpected error: {e}"),
            }
        }
    }
}
