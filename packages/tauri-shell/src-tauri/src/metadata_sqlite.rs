//! Opaque private records shared by the desktop bridge and Android service JNI.
//! Encryption remains in TypeScript. SQLite is the durable owner, never a cache fallback.
use rusqlite::{params, Connection, OptionalExtension};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

pub struct MetadataDatabase {
    connection: Connection,
    pub directory: PathBuf,
}

fn error(value: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("Metadata database: {value}"))
}

impl MetadataDatabase {
    pub fn replace_record(
        &self,
        name: &str,
        bytes: &[u8],
        modified_ms: u64,
        expected: Option<&str>,
        exclusive: bool,
    ) -> io::Result<()> {
        let transaction = rusqlite::Transaction::new_unchecked(
            &self.connection,
            rusqlite::TransactionBehavior::Immediate,
        )
        .map_err(error)?;
        let current = self.entry(name)?.map(|entry| entry.revision);
        if current.as_deref() != expected || (exclusive && current.is_some()) {
            return Err(error("record changed during replacement"));
        }
        self.put("private", name, bytes, modified_ms)?;
        transaction.commit().map_err(error)
    }
    pub fn entry(&self, name: &str) -> io::Result<Option<crate::replica_storage::ReplicaEntry>> {
        self.connection.query_row("SELECT id, length(value), revision, modified_ms FROM records WHERE namespace = 'private' AND id = ? AND deleted = 0",
            [name], metadata_entry).optional().map_err(error)
    }
    pub fn open(base: &Path, root: &Path, identity: &str) -> io::Result<Self> {
        let key = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
        let directory = base.join("folders").join(key);
        if directory.starts_with(root) {
            return Err(error("must be outside selected folder"));
        }
        fs::create_dir_all(&directory)?;
        let database = directory.join("metadata.sqlite3");
        let initialized = directory.join("initialized");
        if initialized.exists() && !database.exists() {
            return Err(error("missing; restore a backup"));
        }
        for path in [
            &directory,
            &database,
            &directory.join("metadata.sqlite3-wal"),
            &directory.join("metadata.sqlite3-shm"),
        ] {
            if fs::symlink_metadata(path).is_ok_and(|entry| entry.is_symlink()) {
                return Err(error("symlinks are forbidden"));
            }
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
        }
        let mut connection = Connection::open(&database).map_err(error)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&database, fs::Permissions::from_mode(0o600))?;
        }
        connection
            .busy_timeout(Duration::from_secs(5))
            .map_err(error)?;
        connection
            .execute_batch("PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL;")
            .map_err(error)?;
        let version: u32 = connection
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .map_err(error)?;
        match version {
            0 if !initialized.exists() => connection
                .execute_batch(include_str!("../../../core/sqlite/metadata.sql"))
                .map_err(error)?,
            1 => {}
            _ => {
                return Err(error(
                    "missing or unsupported schema; restore compatible storage",
                ))
            }
        }
        connection
            .execute_batch("PRAGMA journal_mode = WAL;")
            .map_err(error)?;
        let check: String = connection
            .query_row("PRAGMA quick_check", [], |row| row.get(0))
            .map_err(error)?;
        if check != "ok" {
            return Err(error("integrity validation failed"));
        }
        let transaction = connection
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(error)?;
        let stored: Option<Vec<u8>> = transaction
            .query_row(
                "SELECT value FROM records WHERE namespace = 'system' AND id = 'root'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        if let Some(stored) = stored {
            if stored != identity.as_bytes() {
                return Err(error("selected folder identity changed"));
            }
        } else {
            if initialized.exists() {
                return Err(error("root identity missing; restore a backup"));
            }
            transaction.execute("INSERT INTO records(namespace,id,value,modified_ms) VALUES ('system','root',?,0)", [identity.as_bytes()]).map_err(error)?;
        }
        transaction.commit().map_err(error)?;
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(initialized)?
            .sync_all()?;
        Ok(Self {
            connection,
            directory,
        })
    }

    pub fn get(&self, namespace: &str, name: &str) -> io::Result<Option<Vec<u8>>> {
        self.connection
            .query_row(
                "SELECT value FROM records WHERE namespace = ? AND id = ? AND deleted = 0",
                params![namespace, name],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)
    }

    pub fn put(
        &self,
        namespace: &str,
        name: &str,
        bytes: &[u8],
        modified_ms: u64,
    ) -> io::Result<()> {
        self.connection.execute("INSERT INTO records(namespace,id,value,modified_ms) VALUES (?,?,?,?)
            ON CONFLICT(namespace,id) DO UPDATE SET value=excluded.value, revision=records.revision+1,
            modified_ms=excluded.modified_ms, deleted=0 WHERE records.value != excluded.value OR records.deleted != 0", params![namespace, name, bytes, i64::try_from(modified_ms).map_err(error)?]).map_err(error)?;
        Ok(())
    }

    pub fn remove(&self, name: &str) -> io::Result<()> {
        self.connection.execute("UPDATE records SET value = zeroblob(0), deleted = 1, revision = revision + 1 WHERE namespace = 'private' AND id = ? AND deleted = 0", [name]).map_err(error)?;
        Ok(())
    }

    pub fn entries(&self) -> io::Result<Vec<crate::replica_storage::ReplicaEntry>> {
        let mut statement = self.connection.prepare("SELECT id, length(value), revision, modified_ms FROM records WHERE namespace = 'private' AND deleted = 0 ORDER BY id").map_err(error)?;
        let rows = statement.query_map([], metadata_entry).map_err(error)?;
        rows.collect::<Result<_, _>>().map_err(error)
    }

    pub fn read(&self, name: &str, offset: u64, size: usize) -> io::Result<Vec<u8>> {
        let value: Vec<u8> = self.connection.query_row("SELECT substr(value, ?, ?) FROM records WHERE namespace = 'private' AND id = ? AND deleted = 0",
            params![i64::try_from(offset + 1).map_err(error)?, i64::try_from(size).map_err(error)?, name], |row| row.get(0)).map_err(error)?;
        if value.len() != size {
            return Err(error("read exceeds record bounds"));
        }
        Ok(value)
    }

    pub fn backup(&self, destination: &Path) -> io::Result<()> {
        if destination.exists() {
            return Err(error("backup destination already exists"));
        }
        self.connection
            .backup("main", destination, None)
            .map_err(error)
    }

    pub fn create_backup(&self) -> io::Result<PathBuf> {
        let directory = self.directory.join("backups");
        fs::create_dir_all(&directory)?;
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(error)?
            .as_nanos();
        let destination = directory.join(format!("metadata-{stamp}.sqlite3"));
        self.backup(&destination)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&destination, fs::Permissions::from_mode(0o600))?;
        }
        Ok(destination)
    }
}

fn metadata_entry(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<crate::replica_storage::ReplicaEntry> {
    Ok(crate::replica_storage::ReplicaEntry {
        name: row.get(0)?,
        kind: "file",
        size: row.get::<_, i64>(1)? as u64,
        modified_ms: row.get::<_, i64>(3)? as u64,
        revision: format!("sqlite:{}", row.get::<_, i64>(2)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_revisions_reject_stale_writers_even_after_delete_and_recreate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        let state = temp.path().join("state");
        let first = MetadataDatabase::open(&state, &root, "fixture").unwrap();
        let second = MetadataDatabase::open(&state, &root, "fixture").unwrap();
        first
            .replace_record("record", &[1], 0, None, false)
            .unwrap();
        let original = first.entry("record").unwrap().unwrap().revision;
        second.remove("record").unwrap();
        second
            .replace_record("record", &[2], 0, None, false)
            .unwrap();
        assert!(first
            .replace_record("record", &[3], 0, Some(&original), false)
            .is_err());
        assert_eq!(first.read("record", 0, 1).unwrap(), [2]);
        assert_eq!(first.entries().unwrap().len(), 1);
    }

    #[test]
    fn metadata_sqlite_reopen_backup_identity_and_corruption() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        let state = temp.path().join("state");
        let db = MetadataDatabase::open(&state, &root, "fixture-identity").unwrap();
        db.put("private", "opaque", &[0, 255, 1], 1).unwrap();
        assert_eq!(db.read("opaque", 1, 2).unwrap(), [255, 1]);
        assert!(db.read("opaque", 2, 2).is_err());
        let backup = temp.path().join("backup.sqlite3");
        db.backup(&backup).unwrap();
        assert!(db.backup(&backup).is_err());
        drop(db);
        let db = MetadataDatabase::open(&state, &root, "fixture-identity").unwrap();
        assert_eq!(db.get("private", "opaque").unwrap().unwrap(), [0, 255, 1]);
        assert!(MetadataDatabase::open(&state, &root, "replacement").is_err());
        let filename = db.directory.join("metadata.sqlite3");
        drop(db);
        fs::write(&filename, b"corrupt").unwrap();
        assert!(MetadataDatabase::open(&state, &root, "fixture-identity").is_err());
        fs::remove_file(filename).unwrap();
        assert!(MetadataDatabase::open(&state, &root, "fixture-identity").is_err());
    }
}
