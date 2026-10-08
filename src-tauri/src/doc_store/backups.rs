    use super::*;

    impl Database {

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
}

