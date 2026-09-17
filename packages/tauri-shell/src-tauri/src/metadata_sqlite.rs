//! SQLCipher-backed private records shared by the desktop bridge and Android service JNI.
//! Document payload encryption remains in TypeScript; the database also encrypts local metadata.
use rusqlite::{backup::Backup, params, Connection, OptionalExtension};
use hmac::{Hmac, Mac};
use sha2::Sha256;
#[cfg(test)]
use sha2::Digest;
use std::{
    fs, io::{self, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub struct MetadataDatabase {
    connection: Connection,
    pub directory: PathBuf,
    key: [u8; 32],
}

fn error(value: impl std::fmt::Display) -> io::Error {
    io::Error::other(format!("Metadata database: {value}"))
}

fn key_connection(connection: &Connection, key: &[u8; 32]) -> io::Result<()> {
    // Use the C API so the key never appears in SQL text, diagnostics, or a query trace.
    let status = unsafe {
        rusqlite::ffi::sqlite3_key(connection.handle(), key.as_ptr().cast(), key.len() as i32)
    };
    if status != rusqlite::ffi::SQLITE_OK {
        return Err(error("could not unlock encrypted storage"));
    }
    Ok(())
}

fn check_metadata_key(base: &Path, key: &[u8; 32]) -> io::Result<()> {
    let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(error)?;
    mac.update(b"syncpeer.metadata-root.v1");
    let expected = mac.finalize().into_bytes();
    if fs::symlink_metadata(base).is_ok_and(|entry| entry.file_type().is_symlink()) {
        return Err(error("metadata root symlink is forbidden"));
    }
    fs::create_dir_all(base)?;
    #[cfg(unix)] {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(base, fs::Permissions::from_mode(0o700))?;
    }
    let marker = base.join("key-check");
    if fs::symlink_metadata(&marker).is_ok_and(|entry| entry.file_type().is_symlink()) {
        return Err(error("metadata key check symlink is forbidden"));
    }
    if !marker.exists() {
        let folders = base.join("folders");
        if folders.is_dir() && fs::read_dir(folders)?.next().is_some() {
            return Err(error("metadata key check is missing; restore or reset local storage"));
        }
        match fs::OpenOptions::new().write(true).create_new(true).open(&marker) {
            Ok(mut file) => {
                #[cfg(unix)] {
                    use std::os::unix::fs::PermissionsExt;
                    file.set_permissions(fs::Permissions::from_mode(0o600))?;
                }
                file.write_all(&expected)?;
                file.sync_all()?;
            }
            Err(value) if value.kind() == io::ErrorKind::AlreadyExists => {}
            Err(value) => return Err(value),
        }
    }
    if fs::read(&marker)? != expected.as_slice() {
        return Err(error("metadata key does not match this installation"));
    }
    Ok(())
}

impl Drop for MetadataDatabase {
    fn drop(&mut self) {
        self.key.fill(0);
    }
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
    pub fn open(base: &Path, root: &Path, identity: &str, key: &[u8; 32]) -> io::Result<Self> {
        check_metadata_key(base, key)?;
        let mut mac = Hmac::<Sha256>::new_from_slice(key).map_err(error)?;
        mac.update(root.to_string_lossy().as_bytes());
        let root_hash = format!("{:x}", mac.finalize().into_bytes());
        let directory = base.join("folders").join(root_hash);
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
        key_connection(&connection, key)?;
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
            key: *key,
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
        let mut output = Connection::open(destination).map_err(error)?;
        let result = (|| {
            key_connection(&output, &self.key)?;
            Backup::new(&self.connection, &mut output)
                .map_err(error)?
                .run_to_completion(128, Duration::from_millis(10), None)
                .map_err(error)?;
            let check: String = output.query_row("PRAGMA quick_check", [], |row| row.get(0)).map_err(error)?;
            if check != "ok" {
                return Err(error("encrypted backup integrity validation failed"));
            }
            Ok(())
        })();
        drop(output);
        if result.is_err() {
            let _ = fs::remove_file(destination);
        }
        result
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
    fn metadata_database_requires_key_and_encrypts_database_and_backup() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        let state = temp.path().join("state");
        let key = [7u8; 32];
        let marker = b"synthetic-private-record";
        let db = MetadataDatabase::open(&state, &root, "fixture", &key).unwrap();
        let plain_path_hash = format!("{:x}", Sha256::digest(root.to_string_lossy().as_bytes()));
        assert_ne!(db.directory.file_name().unwrap().to_string_lossy(), plain_path_hash);
        db.put("private", "secret", marker, 0).unwrap();
        let wal = db.directory.join("metadata.sqlite3-wal");
        let wal_contents = fs::read(&wal).unwrap();
        assert!(!wal_contents.windows(marker.len()).any(|window| window == marker));
        let backup = temp.path().join("backup.sqlite3");
        db.backup(&backup).unwrap();
        let database = db.directory.join("metadata.sqlite3");
        drop(db);
        for path in [&database, &backup] {
            let contents = fs::read(path).unwrap();
            assert!(!contents.starts_with(b"SQLite format 3"));
            assert!(!contents.windows(marker.len()).any(|window| window == marker));
        }
        let backup_connection = Connection::open(&backup).unwrap();
        key_connection(&backup_connection, &key).unwrap();
        let backed_up: Vec<u8> = backup_connection.query_row(
            "SELECT value FROM records WHERE namespace = 'private' AND id = 'secret'",
            [], |row| row.get(0),
        ).unwrap();
        assert_eq!(backed_up, marker);
        assert!(MetadataDatabase::open(&state, &root, "fixture", &[8u8; 32]).is_err());
        assert_eq!(MetadataDatabase::open(&state, &root, "fixture", &key)
            .unwrap().get("private", "secret").unwrap().unwrap(), marker);
        fs::remove_file(state.join("key-check")).unwrap();
        assert!(MetadataDatabase::open(&state, &root, "fixture", &key).is_err());
    }

    #[test]
    fn record_revisions_reject_stale_writers_even_after_delete_and_recreate() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("files");
        let state = temp.path().join("state");
        let first = MetadataDatabase::open(&state, &root, "fixture", &[7u8; 32]).unwrap();
        let second = MetadataDatabase::open(&state, &root, "fixture", &[7u8; 32]).unwrap();
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
        let db = MetadataDatabase::open(&state, &root, "fixture-identity", &[7u8; 32]).unwrap();
        db.put("private", "opaque", &[0, 255, 1], 1).unwrap();
        assert_eq!(db.read("opaque", 1, 2).unwrap(), [255, 1]);
        assert!(db.read("opaque", 2, 2).is_err());
        let backup = temp.path().join("backup.sqlite3");
        db.backup(&backup).unwrap();
        assert!(db.backup(&backup).is_err());
        drop(db);
        let db = MetadataDatabase::open(&state, &root, "fixture-identity", &[7u8; 32]).unwrap();
        assert_eq!(db.get("private", "opaque").unwrap().unwrap(), [0, 255, 1]);
        assert!(MetadataDatabase::open(&state, &root, "replacement", &[7u8; 32]).is_err());
        let filename = db.directory.join("metadata.sqlite3");
        drop(db);
        fs::write(&filename, b"corrupt").unwrap();
        assert!(MetadataDatabase::open(&state, &root, "fixture-identity", &[7u8; 32]).is_err());
        fs::remove_file(filename).unwrap();
        assert!(MetadataDatabase::open(&state, &root, "fixture-identity", &[7u8; 32]).is_err());
    }
}
