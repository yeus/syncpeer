use crate::metadata_sqlite::MetadataDatabase;
use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::Manager;
#[derive(Default)]
pub struct ReplicaRoots {
    next: u64,
    roots: HashMap<u64, Dir>,
    guards: HashMap<u64, ReplicaRootGuard>,
    locks: HashMap<u64, std::fs::File>,
    writers: HashMap<u64, ReplicaWriter>,
    metadata_root: PathBuf,
    metadata_key: Option<[u8; 32]>,
    metadata: HashMap<u64, MetadataDatabase>,
    metadata_prefixes: HashMap<u64, Vec<String>>,
}

impl Drop for ReplicaRoots {
    fn drop(&mut self) {
        for id in self.roots.keys().copied().collect::<Vec<_>>() {
            let _ = self.release(id);
        }
        if let Some(key) = self.metadata_key.as_mut() {
            key.fill(0);
        }
    }
}

struct ReplicaRootGuard {
    path: PathBuf,
    identity: String,
    marker: Option<String>,
    app_private_profile: bool,
}

fn file_identity(metadata: &Metadata) -> io::Result<String> {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        Ok(format!("{}:{}", metadata.dev(), metadata.ino()))
    }
    #[cfg(not(unix))]
    {
        Ok(format!("{:?}", metadata.created()?))
    }
}

fn marker_identity(root: &Dir) -> io::Result<Option<String>> {
    match root.symlink_metadata(".stfolder") {
        Ok(metadata) if (metadata.is_file() || metadata.is_dir()) && !metadata.is_symlink() => {
            Ok(Some(file_identity(&metadata)?))
        }
        Ok(_) => Err(invalid("Invalid replica folder marker")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

const PROFILE_MARKER_PATH: &str = ".stfolder/.syncpeer-profile-id";

/// App-private profiles use a random persistent marker rather than filesystem
/// inode numbers. Inodes change on legitimate directory copies and restores.
/// Other (user-selected) replica folders retain their strict inode checks.
fn profile_marker_identity(root: &Dir) -> io::Result<Option<String>> {
    if marker_identity(root)?.is_none() {
        return Ok(None);
    }
    match root.symlink_metadata(PROFILE_MARKER_PATH) {
        Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => {
            let token = root.read(PROFILE_MARKER_PATH)?;
            if token.len() != 32 {
                return Err(invalid("Invalid app-private profile marker"));
            }
            Ok(Some(format!(
                "profile-v1:{}",
                token
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect::<String>()
            )))
        }
        Ok(_) => Err(invalid("Invalid app-private profile marker")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn registered_marker_identity(root: &Dir, app_private_profile: bool) -> io::Result<Option<String>> {
    if app_private_profile {
        profile_marker_identity(root)
    } else {
        marker_identity(root)
    }
}

fn check_root_path(guard: &ReplicaRootGuard) -> io::Result<()> {
    if std::fs::symlink_metadata(&guard.path)?.is_symlink() {
        return Err(invalid("Selected folder was replaced"));
    }
    let current = Dir::open_ambient_dir(&guard.path, cap_std::ambient_authority())?;
    if file_identity(&current.dir_metadata()?)? != guard.identity {
        return Err(invalid("Selected folder was replaced"));
    }
    Ok(())
}

struct ReplicaWriter {
    root_id: u64,
    path: String,
    temporary: String,
    original: Option<String>,
    file: Option<File>,
    size: u64,
    written: Vec<(u64, u64)>,
    metadata: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaEntry {
    pub(crate) name: String,
    pub(crate) kind: &'static str,
    pub(crate) size: u64,
    pub(crate) modified_ms: u64,
    pub(crate) revision: String,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
}

/// JNI reports only fixed error categories; never Rust's raw filesystem,
/// database, path or encryption error text. Also testable on the host.
pub(crate) fn storage_failure_category(message: &str) -> &'static str {
    if message.contains("metadata key does not match this installation") {
        "metadata-key-mismatch"
    } else if message.contains("metadata key check is missing") {
        "metadata-key-check-missing"
    } else if message.contains("Invalid app-private profile marker") {
        "profile-marker-invalid"
    } else if message.contains("Replica folder marker unavailable or replaced") {
        "replica-marker-mismatch"
    } else if message.contains("selected folder identity changed")
        || message.contains("Selected folder was replaced")
    {
        "root-identity-mismatch"
    } else if message.contains("root identity missing") {
        "root-identity-missing"
    } else if message.contains("missing or unsupported schema") {
        "metadata-schema-unsupported"
    } else if message.contains("missing; restore a backup") {
        "metadata-database-missing"
    } else if message.contains("integrity validation failed") {
        "metadata-integrity"
    } else if message.contains("Replica root is busy") || message.contains("already locked") {
        "replica-lock"
    } else if message.contains("Metadata database:") {
        "metadata-database"
    } else if message.contains("Permission denied") || message.contains("permission denied") {
        "permission"
    } else if message.contains("No such file or directory") {
        "missing-file"
    } else {
        "other"
    }
}

fn check_relative(root: &Dir, relative: &str) -> io::Result<()> {
    if relative.contains('\\')
        || relative.contains('\0')
        || relative.split('/').any(|part| part == "." || part == "..")
    {
        return Err(invalid("Invalid relative folder path"));
    }
    let mut path = PathBuf::new();
    for component in Path::new(relative).components() {
        if !matches!(component, Component::Normal(_)) {
            return Err(invalid("Invalid relative folder path"));
        }
        path.push(component);
        match root.symlink_metadata(&path) {
            Ok(metadata) if metadata.is_symlink() => {
                return Err(invalid("Folder paths cannot traverse symlinks"))
            }
            Ok(_) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

fn revision(metadata: &Metadata) -> String {
    #[cfg(unix)]
    {
        use cap_std::fs::MetadataExt;
        format!(
            "{}:{}:{}:{}:{}:{}:{}",
            metadata.dev(),
            metadata.ino(),
            metadata.len(),
            metadata.mtime(),
            metadata.mtime_nsec(),
            metadata.ctime(),
            metadata.ctime_nsec()
        )
    }
    #[cfg(not(unix))]
    {
        format!(
            "{}:{:?}:{:?}",
            metadata.len(),
            metadata.modified(),
            metadata.created()
        )
    }
}

impl ReplicaRoots {
    #[cfg(any(test, target_os = "android"))]
    pub fn new(metadata_root: PathBuf, metadata_key: [u8; 32]) -> Self {
        let mut roots = Self::default();
        roots.metadata_root = metadata_root;
        roots.metadata_key = Some(metadata_key);
        roots
    }

    fn is_metadata(&self, id: u64, path: &str) -> bool {
        !path.contains('/')
            && self
                .metadata_prefixes
                .get(&id)
                .is_some_and(|prefixes| prefixes.iter().any(|prefix| path.starts_with(prefix)))
    }

    fn metadata_revision(&self, id: u64, path: &str) -> io::Result<Option<String>> {
        Ok(self
            .metadata
            .get(&id)
            .ok_or_else(|| invalid("Metadata unavailable"))?
            .entry(path)?
            .map(|entry| entry.revision))
    }

    pub fn register_metadata(&mut self, path: &Path, prefixes: Vec<String>) -> io::Result<u64> {
        if prefixes.iter().any(|prefix| {
            prefix.is_empty()
                || prefix.contains('/')
                || prefix.contains('\\')
                || prefix.contains('\0')
        }) {
            return Err(invalid("Invalid metadata prefix"));
        }
        let id = self.register(path)?;
        self.metadata_prefixes.insert(id, prefixes);
        Ok(id)
    }

    pub fn register(&mut self, path: &Path) -> io::Result<u64> {
        if !path.is_absolute() || std::fs::symlink_metadata(path)?.is_symlink() {
            return Err(invalid(
                "Selected folder must be an absolute directory without a root symlink",
            ));
        }
        let root = Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
        if self.metadata_root.as_os_str().is_empty() {
            return Err(invalid("Metadata root is not configured"));
        }
        // A private profile is bound to the protected SQLCipher database and
        // a durable random marker, not the inode of its parent directory.
        // App data copied to new storage must not strand the peer roster.
        let app_profile = self
            .metadata_root
            .parent()
            .and_then(|private| private.join("documents/profile").canonicalize().ok());
        let app_private_profile = app_profile.as_deref() == Some(path);
        let root_identity = if app_private_profile {
            "syncpeer-private-profile-v1".to_owned()
        } else {
            file_identity(&root.dir_metadata()?)?
        };
        let db = MetadataDatabase::open(
            &self.metadata_root,
            path,
            &root_identity,
            self.metadata_key
                .as_ref()
                .ok_or_else(|| invalid("Protected metadata key is unavailable"))?,
        )?;
        let expected = db.get("marker", "identity")?;
        let marker = registered_marker_identity(&root, app_private_profile)?;
        if let Some(expected) = expected {
            if marker.as_ref().map(|value| value.as_bytes()) != Some(expected.as_slice()) {
                return Err(invalid("Replica folder marker unavailable or replaced"));
            }
        } else if let Some(marker) = &marker {
            db.put("marker", "identity", marker.as_bytes(), 0)?;
        }
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| invalid("Folder handle limit reached"))?;
        self.guards.insert(
            self.next,
            ReplicaRootGuard {
                path: path.to_path_buf(),
                identity: file_identity(&root.dir_metadata()?)?,
                marker,
                app_private_profile,
            },
        );
        self.roots.insert(self.next, root);
        self.metadata.insert(self.next, db);
        Ok(self.next)
    }

    pub fn release(&mut self, id: u64) -> io::Result<()> {
        let writers: Vec<u64> = self
            .writers
            .iter()
            .filter(|(_, writer)| writer.root_id == id)
            .map(|(id, _)| *id)
            .collect();
        let mut cleanup_error = None;
        for writer in writers {
            if let Err(error) = self.abort(writer) {
                cleanup_error.get_or_insert(error);
            }
        }
        self.roots.remove(&id);
        self.guards.remove(&id);
        self.locks.remove(&id);
        self.metadata.remove(&id);
        self.metadata_prefixes.remove(&id);
        cleanup_error.map_or(Ok(()), Err)
    }

    fn root(&self, id: u64) -> io::Result<&Dir> {
        let guard = self
            .guards
            .get(&id)
            .ok_or_else(|| invalid("Selected folder guard is unavailable"))?;
        check_root_path(guard)?;
        self.roots
            .get(&id)
            .ok_or_else(|| invalid("Selected folder handle is no longer available"))
    }

    fn check_health(&self, id: u64) -> io::Result<()> {
        let root = self.root(id)?;
        let app_private_profile = self
            .guards
            .get(&id)
            .is_some_and(|guard| guard.app_private_profile);
        let marker = registered_marker_identity(root, app_private_profile)?;
        if marker.is_none() || marker != self.guards.get(&id).and_then(|guard| guard.marker.clone())
        {
            return Err(invalid("Replica folder marker unavailable or replaced"));
        }
        Ok(())
    }

    fn acquire(&mut self, id: u64) -> io::Result<()> {
        if self.locks.contains_key(&id) {
            return Err(invalid("Replica root already locked"));
        }
        self.root(id)?;
        let db = self
            .metadata
            .get(&id)
            .ok_or_else(|| invalid("Metadata unavailable"))?;
        let mut options = std::fs::OpenOptions::new();
        // The file is persistent metadata. The OS lock, rather than file
        // creation, owns exclusion so a crash cannot leave a permanently busy
        // replica and unlock cannot race a newly opened lock file.
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(db.directory.join("operation.lock"))?;
        write!(file, "{}", std::process::id())?;
        #[cfg(any(target_os = "linux", target_os = "android"))]
        rustix::fs::flock(&file, rustix::fs::FlockOperation::NonBlockingLockExclusive).map_err(
            |error| {
                if error == rustix::io::Errno::WOULDBLOCK {
                    io::Error::new(io::ErrorKind::WouldBlock, "Replica root is busy")
                } else {
                    io::Error::from(error)
                }
            },
        )?;
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        file.try_lock().map_err(|error| match error {
            std::fs::TryLockError::WouldBlock => {
                io::Error::new(io::ErrorKind::WouldBlock, "Replica root is busy")
            }
            std::fs::TryLockError::Error(error) => error,
        })?;
        self.locks.insert(id, file);
        Ok(())
    }

    fn unlock(&mut self, id: u64) -> io::Result<()> {
        if !self.locks.contains_key(&id) {
            return Ok(());
        }
        if let Some(file) = self.locks.get(&id) {
            #[cfg(any(target_os = "linux", target_os = "android"))]
            rustix::fs::flock(file, rustix::fs::FlockOperation::Unlock)?;
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            file.unlock()?;
        }
        self.locks.remove(&id);
        Ok(())
    }

    fn initialize_replica(&mut self, id: u64) -> io::Result<()> {
        if self
            .guards
            .get(&id)
            .and_then(|guard| guard.marker.as_ref())
            .is_some()
        {
            return self.check_health(id);
        }
        self.acquire(id)?;
        let result = (|| {
            let root = self.root(id)?;
            let app_private_profile = self
                .guards
                .get(&id)
                .is_some_and(|guard| guard.app_private_profile);
            if let Some(marker) = registered_marker_identity(root, app_private_profile)? {
                self.guards.get_mut(&id).unwrap().marker = Some(marker);
                return Ok(());
            }
            // No silent replacement of a previously initialized profile.
            if self
                .metadata
                .get(&id)
                .ok_or_else(|| invalid("Metadata unavailable"))?
                .get("marker", "identity")?
                .is_some()
            {
                return Err(invalid("Protected profile marker is missing"));
            }
            // Allow an interrupted first-ever profile initialization to finish
            // after .stfolder was created but before the random token was saved.
            let mut has_marker_directory = false;
            for entry in root.entries()? {
                if app_private_profile && entry?.file_name() == ".stfolder" {
                    has_marker_directory = true;
                    continue;
                }
                return Err(invalid("Replica initialization requires an empty folder"));
            }
            if has_marker_directory {
                if root.read_dir(".stfolder")?.next().is_some() {
                    return Err(invalid("Incomplete profile marker has unexpected files"));
                }
            } else {
                root.create_dir(".stfolder")?;
            }
            if app_private_profile {
                let mut token = [0u8; 32];
                getrandom::getrandom(&mut token)
                    .map_err(|_| invalid("Could not create protected profile marker"))?;
                let mut options = OpenOptions::new();
                options.write(true).create_new(true);
                let result = (|| {
                    let mut file = root.open_with(PROFILE_MARKER_PATH, &options)?;
                    file.write_all(&token)?;
                    file.sync_all()
                })();
                token.fill(0);
                result?;
            }
            root.open(".stfolder")?.sync_all()?;
            flush_parents(root, ".stfolder")?;
            let marker = registered_marker_identity(root, app_private_profile)?;
            self.metadata
                .get(&id)
                .ok_or_else(|| invalid("Metadata unavailable"))?
                .put("marker", "identity", marker.as_ref().unwrap().as_bytes(), 0)?;
            self.guards.get_mut(&id).unwrap().marker = marker;
            Ok(())
        })();
        self.unlock(id)?;
        result
    }

    pub fn read(&self, id: u64, path: &str, offset: u64, size: usize) -> io::Result<Vec<u8>> {
        if size == 0 || size > 131072 || offset.checked_add(size as u64).is_none() {
            return Err(invalid("Invalid folder read range"));
        }
        let root = self.root(id)?;
        check_relative(root, path)?;
        if self.is_metadata(id, path) {
            return self.metadata.get(&id).unwrap().read(path, offset, size);
        }
        let mut file = root.open(path)?;
        if !file.metadata()?.is_file() {
            return Err(invalid("Folder entry is not a regular file"));
        }
        file.seek(SeekFrom::Start(offset))?;
        let mut bytes = vec![0; size];
        file.read_exact(&mut bytes)?;
        Ok(bytes)
    }

    pub fn list(&self, id: u64, path: &str) -> io::Result<Vec<ReplicaEntry>> {
        let root = self.root(id)?;
        check_relative(root, path)?;
        let mut result = Vec::new();
        for entry in root.read_dir(if path.is_empty() { "." } else { path })? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            let kind = if metadata.is_symlink() {
                "symlink"
            } else if metadata.is_dir() {
                "directory"
            } else if metadata.is_file() {
                "file"
            } else {
                "other"
            };
            let modified = metadata
                .modified()?
                .into_std()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| invalid("Unsupported file modification time"))?;
            result.push(ReplicaEntry {
                name: entry
                    .file_name()
                    .into_string()
                    .map_err(|_| invalid("Folder name is not valid UTF-8"))?,
                kind,
                size: if kind == "file" { metadata.len() } else { 0 },
                modified_ms: u64::try_from(modified.as_millis())
                    .map_err(|_| invalid("File time out of range"))?,
                revision: revision(&metadata),
            });
        }
        result.sort_by(|a, b| a.name.cmp(&b.name));
        if path.is_empty() {
            result.retain(|entry| !self.is_metadata(id, &entry.name));
            result.extend(
                self.metadata
                    .get(&id)
                    .ok_or_else(|| invalid("Metadata unavailable"))?
                    .entries()?,
            );
            result.sort_by(|a, b| a.name.cmp(&b.name));
        }
        Ok(result)
    }

    fn stat(&self, id: u64, path: &str) -> io::Result<Option<ReplicaEntry>> {
        let root = self.root(id)?;
        check_relative(root, path)?;
        if self.is_metadata(id, path) {
            return self.metadata.get(&id).unwrap().entry(path);
        }
        let metadata = match root.symlink_metadata(path) {
            Ok(value) => value,
            Err(error)
                if error.kind() == io::ErrorKind::NotFound
                    || error.kind() == io::ErrorKind::NotADirectory =>
            {
                return Ok(None)
            }
            Err(error) => return Err(error),
        };
        if metadata.is_symlink() {
            return Err(invalid("Symlink metadata is unsupported"));
        }
        let kind = if metadata.is_file() {
            "file"
        } else if metadata.is_dir() {
            "directory"
        } else {
            return Err(invalid("Unsupported file kind"));
        };
        let modified_ms = metadata
            .modified()?
            .into_std()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| invalid("Unsupported modification time"))?
            .as_millis() as u64;
        Ok(Some(ReplicaEntry {
            name: Path::new(path)
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or_else(|| invalid("Invalid file name"))?
                .into(),
            kind,
            size: if kind == "file" { metadata.len() } else { 0 },
            modified_ms,
            revision: revision(&metadata),
        }))
    }
}

fn current_revision(root: &Dir, path: &str) -> io::Result<Option<String>> {
    check_relative(root, path)?;
    match root.symlink_metadata(path) {
        Ok(metadata) if metadata.is_file() => Ok(Some(revision(&metadata))),
        Ok(_) => Err(invalid("Replacement target is not a regular file")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    }
}

fn flush_parents(root: &Dir, path: &str) -> io::Result<()> {
    let mut parent = Path::new(path).parent();
    while let Some(directory) = parent {
        // Capability directory handles may be O_PATH, which cannot be fsynced.
        root.open(if directory.as_os_str().is_empty() {
            Path::new(".")
        } else {
            directory
        })?
        .sync_all()?;
        parent = directory.parent();
    }
    Ok(())
}

fn publish_exclusive(root: &Dir, temporary: &str, target: &str) -> io::Result<()> {
    check_relative(root, temporary)?;
    check_relative(root, target)?;
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        // Android app storage can forbid hard links. NOREPLACE keeps publication
        // atomic without weakening the no-overwrite guarantee. Resolve parents
        // through the capability API before passing only basenames to rustix.
        let source = Path::new(temporary);
        let target = Path::new(target);
        let open_parent = |path: &Path| {
            let parent = path.parent().filter(|p| !p.as_os_str().is_empty());
            root.open_dir(parent.unwrap_or(Path::new(".")))
        };
        let source_parent = open_parent(source)?;
        let target_parent = open_parent(target)?;
        rustix::fs::renameat_with(
            &source_parent,
            source
                .file_name()
                .ok_or_else(|| invalid("Missing source name"))?,
            &target_parent,
            target
                .file_name()
                .ok_or_else(|| invalid("Missing target name"))?,
            rustix::fs::RenameFlags::NOREPLACE,
        )?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        root.hard_link(temporary, root, target)?;
        root.remove_file(temporary)?;
    }
    Ok(())
}

impl ReplicaRoots {
    fn begin(&mut self, root_id: u64, path: &str, size: u64) -> io::Result<u64> {
        if path.is_empty() {
            return Err(invalid("Replacement path is empty"));
        }
        if self
            .writers
            .values()
            .any(|writer| writer.root_id == root_id && writer.path == path)
        {
            return Err(invalid("Replacement already active for this path"));
        }
        let id = self
            .next
            .checked_add(1)
            .ok_or_else(|| invalid("Folder handle limit reached"))?;
        let root = self.root(root_id)?;
        let metadata = self.is_metadata(root_id, path);
        if metadata && size > 64 * 1024 * 1024 {
            return Err(invalid("Metadata record too large"));
        }
        let original = if metadata {
            self.metadata_revision(root_id, path)?
        } else {
            current_revision(root, path)?
        };
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| invalid("Clock unavailable"))?
            .as_nanos();
        let temporary = format!(".syncpeer-stage-{id}-{stamp}");
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        options.read(true);
        let file = if metadata {
            Dir::open_ambient_dir(
                &self.metadata.get(&root_id).unwrap().directory,
                cap_std::ambient_authority(),
            )?
            .open_with(&temporary, &options)?
        } else {
            root.open_with(&temporary, &options)?
        };
        self.writers.insert(
            id,
            ReplicaWriter {
                root_id,
                path: path.to_string(),
                temporary,
                original,
                file: Some(file),
                size,
                written: Vec::new(),
                metadata,
            },
        );
        self.next = id;
        Ok(id)
    }

    fn write(&mut self, id: u64, offset: u64, bytes: &[u8]) -> io::Result<()> {
        let writer = self
            .writers
            .get_mut(&id)
            .ok_or_else(|| invalid("Writer unavailable"))?;
        let end = offset
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| invalid("Invalid write range"))?;
        if bytes.len() > 1024 * 1024 || end > writer.size {
            return Err(invalid("Write range exceeds file bounds"));
        }
        let file = writer
            .file
            .as_mut()
            .ok_or_else(|| invalid("Writer already closed"))?;
        file.seek(SeekFrom::Start(offset))?;
        file.write_all(bytes)?;
        if !bytes.is_empty() {
            writer.written.push((offset, end));
        }
        Ok(())
    }

    fn commit(&mut self, id: u64, modified_ms: Option<u64>, exclusive: bool) -> io::Result<()> {
        let writer = self
            .writers
            .get_mut(&id)
            .ok_or_else(|| invalid("Writer unavailable"))?;
        writer.written.sort_unstable();
        let mut covered = 0;
        for &(start, end) in &writer.written {
            if start > covered {
                return Err(invalid("Replacement has unwritten ranges"));
            }
            covered = covered.max(end);
        }
        if covered != writer.size {
            return Err(invalid("Replacement is incomplete"));
        }
        if writer.metadata {
            check_root_path(
                self.guards
                    .get(&writer.root_id)
                    .ok_or_else(|| invalid("Folder guard unavailable"))?,
            )?;
            let db = self
                .metadata
                .get(&writer.root_id)
                .ok_or_else(|| invalid("Metadata unavailable"))?;
            let current = db.entry(&writer.path)?.map(|entry| entry.revision);
            if current != writer.original || (exclusive && current.is_some()) {
                return Err(invalid("Metadata changed during replacement"));
            }
            let file = writer
                .file
                .as_mut()
                .ok_or_else(|| invalid("Writer closed"))?;
            file.seek(SeekFrom::Start(0))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| invalid("Clock unavailable"))?
                .as_millis() as u64;
            db.replace_record(
                &writer.path,
                &bytes,
                modified_ms.unwrap_or(now),
                writer.original.as_deref(),
                exclusive,
            )?;
            let temporary = db.directory.join(&writer.temporary);
            drop(writer.file.take());
            std::fs::remove_file(temporary)?;
            self.writers.remove(&id);
            return Ok(());
        }
        let root = self
            .roots
            .get(&writer.root_id)
            .ok_or_else(|| invalid("Selected folder unavailable"))?;
        if current_revision(root, &writer.path)? != writer.original {
            return Err(invalid("Local file changed during replacement"));
        }
        let file = writer
            .file
            .take()
            .ok_or_else(|| invalid("Writer already closed"))?;
        let file = file.into_std();
        if let Some(ms) = modified_ms {
            let modified = std::time::UNIX_EPOCH
                .checked_add(std::time::Duration::from_millis(ms))
                .ok_or_else(|| invalid("File time out of range"))?;
            file.set_times(std::fs::FileTimes::new().set_modified(modified))?;
        }
        file.sync_all()?;
        drop(file);
        if let Some(parent) = Path::new(&writer.path).parent() {
            if !parent.as_os_str().is_empty() {
                root.create_dir_all(parent)?;
            }
        }
        if current_revision(root, &writer.path)? != writer.original {
            return Err(invalid("Local file changed during replacement"));
        }
        check_root_path(
            self.guards
                .get(&writer.root_id)
                .ok_or_else(|| invalid("Folder guard unavailable"))?,
        )?;
        if exclusive {
            publish_exclusive(root, &writer.temporary, &writer.path)?;
        } else {
            root.rename(&writer.temporary, root, &writer.path)?;
        }
        flush_parents(root, &writer.path)?;
        self.writers.remove(&id);
        Ok(())
    }

    fn make_directory(&self, id: u64, path: &str) -> io::Result<()> {
        if path.is_empty() {
            return Err(invalid("Directory path is empty"));
        }
        let root = self.root(id)?;
        check_relative(root, path)?;
        root.create_dir_all(path)?;
        root.open(path)?.sync_all()?;
        flush_parents(root, path)
    }

    fn remove(&self, id: u64, path: &str, directory: bool) -> io::Result<()> {
        if path.is_empty() {
            return Err(invalid("Removal path is empty"));
        }
        let root = self.root(id)?;
        check_relative(root, path)?;
        if self.is_metadata(id, path) {
            if directory {
                return Err(invalid("Metadata record is not a directory"));
            }
            return self.metadata.get(&id).unwrap().remove(path);
        }
        if directory {
            root.remove_dir(path)?;
        } else {
            root.remove_file(path)?;
        }
        flush_parents(root, path)
    }

    fn remove_files(&self, id: u64, paths: &[String]) -> io::Result<()> {
        if paths.is_empty() || paths.len() > 4096 {
            return Err(invalid("Invalid removal batch"));
        }
        let root = self.root(id)?;
        let mut seen = HashSet::with_capacity(paths.len());
        let mut parent_representatives: HashMap<PathBuf, &str> = HashMap::new();
        for path in paths {
            if path.is_empty() || !seen.insert(path.as_str()) {
                return Err(invalid("Invalid removal batch path"));
            }
            check_relative(root, path)?;
            if self.is_metadata(id, path) {
                return Err(invalid("Metadata records cannot be batch-removed"));
            }
            let parent = Path::new(path)
                .parent()
                .unwrap_or_else(|| Path::new(""))
                .to_path_buf();
            parent_representatives.entry(parent).or_insert(path);
        }
        for path in paths {
            root.remove_file(path)?;
        }
        for representative in parent_representatives.values() {
            flush_parents(root, representative)?;
        }
        Ok(())
    }

    fn flush(&self, id: u64, paths: &[String]) -> io::Result<()> {
        let root = self.root(id)?;
        for path in paths {
            if self.is_metadata(id, path) {
                continue;
            } // SQLite commit already durably flushed the record.
            check_relative(root, path)?;
            match root.open(path) {
                Ok(file) => file.sync_all()?,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
            flush_parents(root, path)?;
        }
        Ok(())
    }

    fn copy(&mut self, id: u64, source: &str, target: &str) -> io::Result<()> {
        let before = self
            .stat(id, source)?
            .ok_or_else(|| invalid("Copy source missing"))?;
        if before.kind != "file" {
            return Err(invalid("Copy source must be a regular file"));
        }
        if self.stat(id, target)?.is_some() {
            return Err(invalid("Archive already exists"));
        }
        let writer = self.begin(id, target, before.size)?;
        let result = (|| {
            let mut offset = 0;
            while offset < before.size {
                let count = (before.size - offset).min(131072) as usize;
                let buffer = self.read(id, source, offset, count)?;
                self.write(writer, offset, &buffer)?;
                offset += count as u64;
            }
            if self.stat(id, source)?.map(|entry| entry.revision) != Some(before.revision) {
                return Err(invalid("Copy source changed"));
            }
            self.commit(writer, Some(before.modified_ms), true)
        })();
        if result.is_err() {
            self.abort(writer)?;
        }
        result
    }

    fn abort(&mut self, id: u64) -> io::Result<()> {
        if let Some(mut writer) = self.writers.remove(&id) {
            drop(writer.file.take());
            if writer.metadata {
                let db = self
                    .metadata
                    .get(&writer.root_id)
                    .ok_or_else(|| invalid("Metadata unavailable"))?;
                match std::fs::remove_file(db.directory.join(&writer.temporary)) {
                    Ok(()) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                    Err(error) => return Err(error),
                }
                return Ok(());
            }
            // Cleanup uses the original capability even when the selected path changed.
            let root = self
                .roots
                .get(&writer.root_id)
                .ok_or_else(|| invalid("Folder handle unavailable"))?;
            match root.remove_file(&writer.temporary) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }
}

#[derive(Deserialize)]
#[serde(
    tag = "operation",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReplicaStorageRequest {
    Register {
        root_path: String,
        metadata_prefixes: Vec<String>,
    },
    Release {
        root_id: u64,
    },
    InitializeReplica {
        root_id: u64,
    },
    CheckHealth {
        root_id: u64,
    },
    BackupMetadata {
        root_id: u64,
    },
    Acquire {
        root_id: u64,
    },
    Unlock {
        root_id: u64,
    },
    List {
        root_id: u64,
        path: String,
    },
    Stat {
        root_id: u64,
        path: String,
    },
    Read {
        root_id: u64,
        path: String,
        offset: u64,
        size: usize,
    },
    Begin {
        root_id: u64,
        path: String,
        size: u64,
    },
    Write {
        writer_id: u64,
        offset: u64,
        bytes: Vec<u8>,
    },
    Commit {
        writer_id: u64,
        modified_ms: Option<u64>,
    },
    Abort {
        writer_id: u64,
    },
    MakeDirectory {
        root_id: u64,
        path: String,
    },
    Remove {
        root_id: u64,
        path: String,
        directory: bool,
    },
    Copy {
        root_id: u64,
        source: String,
        target: String,
    },
    Flush {
        root_id: u64,
        paths: Vec<String>,
    },
    RemoveFiles {
        root_id: u64,
        paths: Vec<String>,
    },
}
pub fn dispatch(
    roots: &mut ReplicaRoots,
    request: ReplicaStorageRequest,
) -> Result<serde_json::Value, String> {
    let result = match request {
        ReplicaStorageRequest::Register {
            root_path,
            metadata_prefixes,
        } => serde_json::json!(roots
            .register_metadata(Path::new(&root_path), metadata_prefixes)
            .map_err(|e| e.to_string())?),
        ReplicaStorageRequest::Release { root_id } => {
            roots.release(root_id).map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::InitializeReplica { root_id } => {
            roots
                .initialize_replica(root_id)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::CheckHealth { root_id } => {
            roots.check_health(root_id).map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::BackupMetadata { root_id } => {
            roots.check_health(root_id).map_err(|e| e.to_string())?;
            serde_json::json!(roots
                .metadata
                .get(&root_id)
                .ok_or("Metadata unavailable")?
                .create_backup()
                .map_err(|e| e.to_string())?)
        }
        ReplicaStorageRequest::Acquire { root_id } => {
            roots.acquire(root_id).map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::Unlock { root_id } => {
            roots.unlock(root_id).map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::List { root_id, path } => {
            serde_json::json!(roots.list(root_id, &path).map_err(|e| e.to_string())?)
        }
        ReplicaStorageRequest::Stat { root_id, path } => {
            serde_json::json!(roots.stat(root_id, &path).map_err(|e| e.to_string())?)
        }
        ReplicaStorageRequest::Read {
            root_id,
            path,
            offset,
            size,
        } => serde_json::json!(roots
            .read(root_id, &path, offset, size)
            .map_err(|e| e.to_string())?),
        ReplicaStorageRequest::Begin {
            root_id,
            path,
            size,
        } => serde_json::json!(roots
            .begin(root_id, &path, size)
            .map_err(|e| e.to_string())?),
        ReplicaStorageRequest::Write {
            writer_id,
            offset,
            bytes,
        } => {
            roots
                .write(writer_id, offset, &bytes)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::Commit {
            writer_id,
            modified_ms,
        } => {
            roots
                .commit(writer_id, modified_ms, false)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::Abort { writer_id } => {
            roots.abort(writer_id).map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::MakeDirectory { root_id, path } => {
            roots
                .make_directory(root_id, &path)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::Remove {
            root_id,
            path,
            directory,
        } => {
            roots
                .remove(root_id, &path, directory)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::Copy {
            root_id,
            source,
            target,
        } => {
            roots
                .copy(root_id, &source, &target)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::Flush { root_id, paths } => {
            roots.flush(root_id, &paths).map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
        ReplicaStorageRequest::RemoveFiles { root_id, paths } => {
            roots
                .remove_files(root_id, &paths)
                .map_err(|e| e.to_string())?;
            serde_json::Value::Null
        }
    };
    Ok(result)
}
#[tauri::command]
pub async fn syncpeer_replica_storage(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: ReplicaStorageRequest,
) -> Result<serde_json::Value, String> {
    let state = Arc::clone(state.inner());
    let metadata_root = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("App storage unavailable: {error}"))?
        .join("metadata");
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        if roots.metadata_root.as_os_str().is_empty() {
            roots.metadata_root = metadata_root;
        }
        if roots.metadata_key.is_none() {
            #[cfg(target_os = "linux")]
            {
                let (key, _recovered) =
                    crate::vault_secret::load_or_create_metadata_key(&roots.metadata_root)?;
                roots.metadata_key = Some(key);
            }
            #[cfg(target_os = "android")]
            {
                let (key, _recovered) = crate::vault_secret::load_or_create_protected_key(
                    &app,
                    "metadata",
                    &roots.metadata_root,
                    crate::vault_secret::MetadataKeyPolicy::Preserve,
                )?;
                roots.metadata_key = Some(key);
            }
            #[cfg(not(any(target_os = "linux", target_os = "android")))]
            {
                return Err("Protected metadata key is unavailable.".into());
            }
        }
        dispatch(&mut roots, request)
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))?
}
fn raw_request<'a>(request: &'a tauri::ipc::Request<'a>) -> Result<&'a [u8], String> {
    match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes) => Ok(bytes),
        _ => Err("Binary folder storage requires a raw IPC body".into()),
    }
}

fn raw_u64(bytes: &[u8], offset: usize) -> Result<u64, String> {
    let value = bytes
        .get(offset..offset + 8)
        .ok_or_else(|| "Invalid binary folder storage request".to_string())?;
    Ok(u64::from_le_bytes(value.try_into().unwrap()))
}

fn raw_u32(bytes: &[u8], offset: usize) -> Result<u32, String> {
    let value = bytes
        .get(offset..offset + 4)
        .ok_or_else(|| "Invalid binary folder storage request".to_string())?;
    Ok(u32::from_le_bytes(value.try_into().unwrap()))
}

#[tauri::command]
pub async fn syncpeer_replica_storage_read_binary(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_request(&request)?;
    let root_id = raw_u64(body, 0)?;
    let offset = raw_u64(body, 8)?;
    let size = raw_u32(body, 16)? as usize;
    let path_len = raw_u32(body, 20)? as usize;
    if size == 0 || size > 131072 || path_len > 4096 || body.len() != 24 + path_len {
        return Err("Invalid binary folder read request".into());
    }
    let path = std::str::from_utf8(&body[24..])
        .map_err(|_| "Invalid binary folder path".to_string())?
        .to_string();
    let state = Arc::clone(state.inner());
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        let roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        roots
            .read(root_id, &path, offset, size)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn syncpeer_replica_storage_write_binary(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let body = raw_request(&request)?;
    if body.len() < 16 || body.len() > 16 + 1024 * 1024 {
        return Err("Invalid binary folder write request".into());
    }
    let writer_id = raw_u64(body, 0)?;
    let offset = raw_u64(body, 8)?;
    let payload = body[16..].to_vec();
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        roots
            .write(writer_id, offset, &payload)
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))?
}

#[tauri::command]
pub async fn syncpeer_replica_storage_read_file_binary(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_request(&request)?;
    let root_id = raw_u64(body, 0)?;
    let max_size = raw_u32(body, 8)? as usize;
    let path_len = raw_u32(body, 12)? as usize;
    if max_size > 2 * 1024 * 1024 || path_len > 4096 || body.len() != 16 + path_len {
        return Err("Invalid binary whole-file read request".into());
    }
    let path = std::str::from_utf8(&body[16..])
        .map_err(|_| "Invalid binary folder path".to_string())?
        .to_string();
    let state = Arc::clone(state.inner());
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        let entry = roots
            .stat(root_id, &path)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "Folder entry unavailable".to_string())?;
        if entry.kind != "file" {
            return Err("Folder entry is not a regular file".into());
        }
        let size =
            usize::try_from(entry.size).map_err(|_| "Folder entry is too large".to_string())?;
        if size > max_size {
            return Err("Folder entry exceeds whole-file read limit".into());
        }
        let mut result = Vec::with_capacity(size);
        let mut offset = 0usize;
        while offset < size {
            let count = (size - offset).min(131072);
            result.extend_from_slice(
                &roots
                    .read(root_id, &path, offset as u64, count)
                    .map_err(|error| error.to_string())?,
            );
            offset += count;
        }
        Ok(result)
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
pub async fn syncpeer_replica_storage_write_file_binary(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let body = raw_request(&request)?;
    if body.len() < 12 {
        return Err("Invalid binary whole-file write request".into());
    }
    let root_id = raw_u64(body, 0)?;
    let path_len = raw_u32(body, 8)? as usize;
    if path_len > 4096 || body.len() < 12 + path_len || body.len() - 12 - path_len > 2 * 1024 * 1024
    {
        return Err("Invalid binary whole-file write request".into());
    }
    let path = std::str::from_utf8(&body[12..12 + path_len])
        .map_err(|_| "Invalid binary folder path".to_string())?
        .to_string();
    let payload = body[12 + path_len..].to_vec();
    let size = payload.len();
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        let writer = roots
            .begin(root_id, &path, size as u64)
            .map_err(|error| error.to_string())?;
        let result = (|| -> io::Result<()> {
            for (index, chunk) in payload.chunks(131072).enumerate() {
                roots.write(writer, (index * 131072) as u64, chunk)?;
            }
            roots.commit(writer, None, false)
        })();
        if let Err(error) = result {
            let cleanup = roots.abort(writer);
            return Err(match cleanup {
                Ok(()) => error.to_string(),
                Err(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
            });
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))?
}

#[tauri::command]
pub async fn syncpeer_replica_storage_read_files_binary(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: tauri::ipc::Request<'_>,
) -> Result<tauri::ipc::Response, String> {
    let body = raw_request(&request)?;
    if body.len() < 16 {
        return Err("Invalid binary whole-file read batch".into());
    }
    let root_id = raw_u64(body, 0)?;
    let max_total_size = raw_u32(body, 8)? as usize;
    let count = raw_u32(body, 12)? as usize;
    if count == 0 || count > 8 || max_total_size > 2 * 1024 * 1024 {
        return Err("Invalid binary whole-file read batch".into());
    }
    let mut cursor = 16usize;
    let mut paths = Vec::with_capacity(count);
    for _ in 0..count {
        let path_len = raw_u32(body, cursor)? as usize;
        cursor = cursor
            .checked_add(4)
            .ok_or_else(|| "Invalid binary read batch".to_string())?;
        if path_len > 4096
            || cursor.checked_add(path_len).is_none()
            || cursor + path_len > body.len()
        {
            return Err("Invalid binary whole-file read batch".into());
        }
        let path = std::str::from_utf8(&body[cursor..cursor + path_len])
            .map_err(|_| "Invalid binary folder path".to_string())?
            .to_string();
        paths.push(path);
        cursor += path_len;
    }
    if cursor != body.len() {
        return Err("Invalid binary whole-file read batch".into());
    }
    let state = Arc::clone(state.inner());
    let response = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        let mut output = Vec::with_capacity(4 + count * 4 + max_total_size);
        output.extend_from_slice(&(count as u32).to_le_bytes());
        let mut total = 0usize;
        for path in paths {
            let entry = roots
                .stat(root_id, &path)
                .map_err(|error| error.to_string())?
                .ok_or_else(|| "Folder entry unavailable".to_string())?;
            if entry.kind != "file" {
                return Err("Folder entry is not a regular file".into());
            }
            let size =
                usize::try_from(entry.size).map_err(|_| "Folder entry is too large".to_string())?;
            total = total
                .checked_add(size)
                .ok_or_else(|| "Folder read batch is too large".to_string())?;
            if total > max_total_size || size > u32::MAX as usize {
                return Err("Folder read batch exceeds its limit".into());
            }
            output.extend_from_slice(&(size as u32).to_le_bytes());
            let mut offset = 0usize;
            while offset < size {
                let chunk_size = (size - offset).min(131072);
                output.extend_from_slice(
                    &roots
                        .read(root_id, &path, offset as u64, chunk_size)
                        .map_err(|error| error.to_string())?,
                );
                offset += chunk_size;
            }
        }
        Ok(output)
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))??;
    Ok(tauri::ipc::Response::new(response))
}

#[tauri::command]
pub async fn syncpeer_replica_storage_write_files_binary(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: tauri::ipc::Request<'_>,
) -> Result<(), String> {
    let body = raw_request(&request)?;
    if body.len() < 12 {
        return Err("Invalid binary whole-file write batch".into());
    }
    let root_id = raw_u64(body, 0)?;
    let count = raw_u32(body, 8)? as usize;
    if count == 0 || count > 8 {
        return Err("Invalid binary whole-file write batch".into());
    }
    let mut cursor = 12usize;
    let mut total = 0usize;
    let mut files = Vec::with_capacity(count);
    for _ in 0..count {
        let path_len = raw_u32(body, cursor)? as usize;
        let size = raw_u32(body, cursor + 4)? as usize;
        cursor = cursor
            .checked_add(8)
            .ok_or_else(|| "Invalid binary write batch".to_string())?;
        if path_len > 4096
            || size > 2 * 1024 * 1024
            || cursor
                .checked_add(path_len)
                .and_then(|value| value.checked_add(size))
                .is_none()
            || cursor + path_len + size > body.len()
        {
            return Err("Invalid binary whole-file write batch".into());
        }
        total = total
            .checked_add(size)
            .ok_or_else(|| "Folder write batch is too large".to_string())?;
        if total > 2 * 1024 * 1024 {
            return Err("Folder write batch exceeds its limit".into());
        }
        let path = std::str::from_utf8(&body[cursor..cursor + path_len])
            .map_err(|_| "Invalid binary folder path".to_string())?
            .to_string();
        cursor += path_len;
        let payload = body[cursor..cursor + size].to_vec();
        cursor += size;
        files.push((path, payload));
    }
    if cursor != body.len() {
        return Err("Invalid binary whole-file write batch".into());
    }
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || -> Result<(), String> {
        let mut roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        for (path, payload) in files {
            let writer = roots
                .begin(root_id, &path, payload.len() as u64)
                .map_err(|error| error.to_string())?;
            let result = (|| -> io::Result<()> {
                for (index, chunk) in payload.chunks(1024 * 1024).enumerate() {
                    roots.write(writer, (index * 1024 * 1024) as u64, chunk)?;
                }
                roots.commit(writer, None, false)
            })();
            if let Err(error) = result {
                let cleanup = roots.abort(writer);
                return Err(match cleanup {
                    Ok(()) => error.to_string(),
                    Err(cleanup_error) => format!("{error}; cleanup failed: {cleanup_error}"),
                });
            }
        }
        Ok(())
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))?
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn storage_failure_categories_never_echo_private_error_text() {
        assert_eq!(
            storage_failure_category(
                "Metadata database: metadata key does not match this installation"
            ),
            "metadata-key-mismatch"
        );
        assert_eq!(
            storage_failure_category("Metadata database: selected folder identity changed"),
            "root-identity-mismatch"
        );
        assert_eq!(
            storage_failure_category(
                "Metadata database: disk image malformed /data/user/0/private"
            ),
            "metadata-database"
        );
        assert_eq!(
            storage_failure_category("Replica root is busy"),
            "replica-lock"
        );
        assert_eq!(
            storage_failure_category("secret /data/user/0/foo key=abc"),
            "other"
        );
    }

    #[test]
    fn copies_use_the_same_storage_for_private_records_and_files() {
        let temp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("source"), [1, 2, 3]).unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots
            .register_metadata(temp.path(), vec![".syncpeer-test-".into()])
            .unwrap();
        roots.copy(id, "source", ".syncpeer-test-copy").unwrap();
        roots
            .copy(id, ".syncpeer-test-copy", "destination")
            .unwrap();
        assert_eq!(roots.read(id, "destination", 0, 3).unwrap(), [1, 2, 3]);
        assert!(!temp.path().join(".syncpeer-test-copy").exists());
        assert!(roots.copy(id, "source", ".syncpeer-test-copy").is_err());
    }

    #[test]
    fn sqlite_private_records_persist_and_failed_replacements_keep_old_bytes() {
        let temp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots
            .register_metadata(temp.path(), vec![".syncpeer-test-".into()])
            .unwrap();
        roots.initialize_replica(id).unwrap();
        roots
            .metadata
            .get(&id)
            .unwrap()
            .put("private", ".syncpeer-test-record", &[1, 2, 3], 0)
            .unwrap();
        assert!(!temp.path().join(".syncpeer-test-record").exists());
        assert!(temp.path().join(".stfolder").exists());
        assert_eq!(
            roots.read(id, ".syncpeer-test-record", 0, 3).unwrap(),
            [1, 2, 3]
        );
        let writer = roots.begin(id, ".syncpeer-test-record", 3).unwrap();
        roots.write(writer, 0, &[4]).unwrap();
        assert!(roots.commit(writer, None, false).is_err());
        roots.abort(writer).unwrap();
        assert_eq!(
            roots.read(id, ".syncpeer-test-record", 0, 3).unwrap(),
            [1, 2, 3]
        );
        roots.release(id).unwrap();
        drop(roots);
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots
            .register_metadata(temp.path(), vec![".syncpeer-test-".into()])
            .unwrap();
        assert_eq!(
            roots.read(id, ".syncpeer-test-record", 0, 3).unwrap(),
            [1, 2, 3]
        );
        let writer = roots.begin(id, ".syncpeer-test-record", 3).unwrap();
        roots.write(writer, 0, &[4, 5, 6]).unwrap();
        roots.commit(writer, None, false).unwrap();
        assert_eq!(
            roots.read(id, ".syncpeer-test-record", 0, 3).unwrap(),
            [4, 5, 6]
        );
    }

    #[test]
    fn old_inode_bound_profile_is_rejected_without_migration_or_data_loss() {
        let private = tempfile::tempdir().unwrap();
        let metadata = private.path().join("metadata");
        let profile = private.path().join("documents/profile");
        std::fs::create_dir_all(profile.join(".stfolder")).unwrap();
        let root = Dir::open_ambient_dir(&profile, cap_std::ambient_authority()).unwrap();
        let old_root = file_identity(&root.dir_metadata().unwrap()).unwrap();
        let old_marker = marker_identity(&root).unwrap().unwrap();
        let key = [7u8; 32];
        {
            let db = MetadataDatabase::open(&metadata, &profile, &old_root, &key).unwrap();
            db.put("marker", "identity", old_marker.as_bytes(), 0)
                .unwrap();
            db.put("private", ".syncpeer-ui-state", b"keep-record", 0)
                .unwrap();
        }
        assert!(ReplicaRoots::new(metadata.clone(), key)
            .register_metadata(&profile, vec![".syncpeer-".into()])
            .is_err());
        assert!(!profile.join(PROFILE_MARKER_PATH).exists());
        let db = MetadataDatabase::open(&metadata, &profile, &old_root, &key).unwrap();
        assert_eq!(
            db.get("private", ".syncpeer-ui-state").unwrap().unwrap(),
            b"keep-record"
        );
        assert_eq!(
            db.get("system", "root").unwrap().unwrap(),
            old_root.as_bytes()
        );
    }

    #[test]
    fn app_private_profile_configuration_survives_new_directory_inodes() {
        let private = tempfile::tempdir().unwrap();
        let metadata = private.path().join("metadata");
        let profile = private.path().join("documents/profile");
        std::fs::create_dir_all(&profile).unwrap();
        let key = [7u8; 32];
        let mut roots = ReplicaRoots::new(metadata.clone(), key);
        let id = roots
            .register_metadata(&profile, vec![".syncpeer-".into()])
            .unwrap();
        roots.initialize_replica(id).unwrap();
        roots
            .metadata
            .get(&id)
            .unwrap()
            .put(
                "private",
                ".syncpeer-ui-state",
                b"new-peers-must-persist",
                0,
            )
            .unwrap();
        let original_token = std::fs::read(profile.join(PROFILE_MARKER_PATH)).unwrap();
        drop(roots);

        // A filesystem copy changes both root and .stfolder inodes. Only
        // the durable marker content, not those inode numbers, is significant.
        let old = private.path().join("old");
        std::fs::rename(&profile, &old).unwrap();
        std::fs::create_dir(&profile).unwrap();
        std::fs::create_dir(profile.join(".stfolder")).unwrap();
        std::fs::copy(
            old.join(PROFILE_MARKER_PATH),
            profile.join(PROFILE_MARKER_PATH),
        )
        .unwrap();
        assert_eq!(
            std::fs::read(profile.join(PROFILE_MARKER_PATH)).unwrap(),
            original_token
        );
        let mut reopened = ReplicaRoots::new(metadata.clone(), key);
        let id = reopened
            .register_metadata(&profile, vec![".syncpeer-".into()])
            .unwrap();
        reopened.check_health(id).unwrap();
        assert_eq!(
            reopened
                .metadata
                .get(&id)
                .unwrap()
                .get("private", ".syncpeer-ui-state")
                .unwrap()
                .unwrap(),
            b"new-peers-must-persist"
        );
        drop(reopened);

        let mut again = ReplicaRoots::new(metadata, key);
        again
            .register_metadata(&profile, vec![".syncpeer-".into()])
            .unwrap();
    }

    #[test]
    fn missing_or_modified_profile_marker_never_replaces_existing_configuration() {
        let private = tempfile::tempdir().unwrap();
        let metadata = private.path().join("metadata");
        let profile = private.path().join("documents/profile");
        std::fs::create_dir_all(&profile).unwrap();
        let mut roots = ReplicaRoots::new(metadata.clone(), [7u8; 32]);
        let id = roots.register_metadata(&profile, vec![]).unwrap();
        roots.initialize_replica(id).unwrap();
        roots
            .metadata
            .get(&id)
            .unwrap()
            .put("private", "roster", b"preserve", 0)
            .unwrap();
        drop(roots);
        let original = std::fs::read(profile.join(PROFILE_MARKER_PATH)).unwrap();
        std::fs::write(profile.join(PROFILE_MARKER_PATH), [9u8; 32]).unwrap();
        let mut reopening = ReplicaRoots::new(metadata.clone(), [7u8; 32]);
        assert!(reopening.register_metadata(&profile, vec![]).is_err());
        std::fs::remove_file(profile.join(PROFILE_MARKER_PATH)).unwrap();
        assert!(reopening.register_metadata(&profile, vec![]).is_err());
        // No automatic reinitialization or removal of existing encrypted data.
        std::fs::write(profile.join(PROFILE_MARKER_PATH), original).unwrap();
        let id = reopening.register_metadata(&profile, vec![]).unwrap();
        assert_eq!(
            reopening
                .metadata
                .get(&id)
                .unwrap()
                .get("private", "roster")
                .unwrap()
                .unwrap(),
            b"preserve"
        );
    }

    #[test]
    fn interrupted_first_profile_init_completes_without_migration() {
        let private = tempfile::tempdir().unwrap();
        let metadata = private.path().join("metadata");
        let profile = private.path().join("documents/profile");
        std::fs::create_dir_all(profile.join(".stfolder")).unwrap();
        let mut roots = ReplicaRoots::new(metadata, [7u8; 32]);
        let id = roots.register_metadata(&profile, vec![]).unwrap();
        roots.initialize_replica(id).unwrap();
        assert_eq!(
            std::fs::read(profile.join(PROFILE_MARKER_PATH))
                .unwrap()
                .len(),
            32
        );
    }

    #[test]
    fn replica_locks_exclude_other_handles_and_release_on_close() {
        let temp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let first = roots.register(temp.path()).unwrap();
        let second = roots.register(temp.path()).unwrap();
        roots.initialize_replica(first).unwrap();
        roots.initialize_replica(second).unwrap();
        roots.acquire(first).unwrap();
        assert!(roots.acquire(first).is_err());
        let competing = roots.acquire(second).unwrap_err();
        assert_eq!(competing.kind(), io::ErrorKind::WouldBlock);
        assert_eq!(competing.to_string(), "Replica root is busy");
        roots.release(first).unwrap();
        roots.acquire(second).unwrap();
        roots.unlock(second).unwrap();
        roots.acquire(second).unwrap();
    }

    #[test]
    fn replica_health_rejects_missing_markers_and_replaced_roots() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("root");
        std::fs::create_dir(&path).unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(&path).unwrap();
        assert!(roots.check_health(id).is_err());
        roots.initialize_replica(id).unwrap();
        roots.check_health(id).unwrap();
        std::fs::remove_dir(path.join(".stfolder")).unwrap();
        assert!(roots.check_health(id).is_err());
        assert!(roots.initialize_replica(id).is_err());
        let writer = roots.begin(id, "file", 1).unwrap();
        roots.write(writer, 0, &[1]).unwrap();
        std::fs::rename(&path, temp.path().join("old")).unwrap();
        std::fs::create_dir(&path).unwrap();
        assert!(roots.list(id, "").is_err());
        assert!(roots.acquire(id).is_err());
        assert!(roots.commit(writer, None, false).is_err());
        roots.release(id).unwrap();
        assert!(!temp.path().join("old/file").exists());
    }

    #[test]
    fn exclusive_publication_never_overwrites_an_existing_archive() {
        let temp = tempfile::tempdir().unwrap();
        let root = Dir::open_ambient_dir(temp.path(), cap_std::ambient_authority()).unwrap();
        root.write("stage", [1, 2, 3]).unwrap();
        root.create_dir("versions").unwrap();
        root.write("versions/file", [4, 5, 6]).unwrap();
        assert!(publish_exclusive(&root, "stage", "versions/file").is_err());
        assert_eq!(root.read("stage").unwrap(), [1, 2, 3]);
        assert_eq!(root.read("versions/file").unwrap(), [4, 5, 6]);
        publish_exclusive(&root, "stage", "versions/new").unwrap();
        assert_eq!(root.read("versions/new").unwrap(), [1, 2, 3]);
        assert!(!root.exists("stage"));
    }

    #[test]
    fn timestamps_archives_and_nonrecursive_removal_preserve_data() {
        let temp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(temp.path()).unwrap();
        roots.make_directory(id, "nested").unwrap();
        let writer = roots.begin(id, "nested/file", 3).unwrap();
        roots.write(writer, 0, &[1, 2, 3]).unwrap();
        roots.commit(writer, Some(1234000), false).unwrap();
        assert_eq!(roots.list(id, "nested").unwrap()[0].modified_ms, 1234000);
        roots
            .copy(id, "nested/file", ".stversions/synthetic-backup")
            .unwrap();
        assert!(roots
            .copy(id, "nested/file", ".stversions/synthetic-backup")
            .is_err());
        assert!(roots.remove(id, "nested", true).is_err());
        roots.remove(id, "nested/file", false).unwrap();
        roots.remove(id, "nested", true).unwrap();
        assert_eq!(
            roots
                .read(id, ".stversions/synthetic-backup", 0, 3)
                .unwrap(),
            [1, 2, 3]
        );
    }

    #[test]
    fn staged_writes_commit_atomically_and_cancellation_preserves_original() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("file"), [1, 2, 3]).unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(temp.path()).unwrap();
        let writer = roots.begin(id, "file", 3).unwrap();
        roots.write(writer, 0, &[4, 5, 6]).unwrap();
        assert_eq!(roots.read(id, "file", 0, 3).unwrap(), [1, 2, 3]);
        roots.abort(writer).unwrap();
        assert_eq!(roots.read(id, "file", 0, 3).unwrap(), [1, 2, 3]);
        let writer = roots.begin(id, "file", 3).unwrap();
        roots.write(writer, 1, &[5, 6]).unwrap();
        roots.write(writer, 0, &[4]).unwrap();
        assert!(roots.write(writer, 3, &[7]).is_err());
        roots.commit(writer, None, false).unwrap();
        assert_eq!(roots.read(id, "file", 0, 3).unwrap(), [4, 5, 6]);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn intervening_edits_block_replacement_and_releasing_root_cleans_writers() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("file"), [1]).unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(temp.path()).unwrap();
        let writer = roots.begin(id, "file", 1).unwrap();
        roots.write(writer, 0, &[2]).unwrap();
        std::fs::write(temp.path().join("file"), [3, 4]).unwrap();
        assert!(roots.commit(writer, None, false).is_err());
        roots.release(id).unwrap();
        assert_eq!(std::fs::read(temp.path().join("file")).unwrap(), [3, 4]);
        assert_eq!(std::fs::read_dir(temp.path()).unwrap().count(), 1);
    }

    #[test]
    fn incomplete_replacements_are_rejected_and_nested_empty_files_work() {
        let temp = tempfile::tempdir().unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(temp.path()).unwrap();
        let writer = roots.begin(id, "nested/file", 3).unwrap();
        roots.write(writer, 2, &[3]).unwrap();
        assert!(roots.commit(writer, None, false).is_err());
        assert!(!temp.path().join("nested/file").exists());
        roots.write(writer, 0, &[1, 2]).unwrap();
        roots.commit(writer, None, false).unwrap();
        assert_eq!(roots.read(id, "nested/file", 0, 3).unwrap(), [1, 2, 3]);
        let empty = roots.begin(id, "other/empty", 0).unwrap();
        roots.commit(empty, None, false).unwrap();
        assert_eq!(
            std::fs::metadata(temp.path().join("other/empty"))
                .unwrap()
                .len(),
            0
        );
    }

    #[test]
    fn selected_root_reads_are_bounded_and_handles_can_be_released() {
        let temp = tempfile::tempdir().unwrap();
        std::fs::write(temp.path().join("file"), [1, 2, 3, 4]).unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(temp.path()).unwrap();
        assert_eq!(roots.read(id, "file", 1, 2).unwrap(), [2, 3]);
        assert!(roots.read(id, "file", 0, 131073).is_err());
        assert!(roots.read(id, "file", 3, 2).is_err());
        assert!(roots.read(id, "../file", 0, 1).is_err());
        let entries = roots.list(id, "").unwrap();
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].name, "file");
        assert_eq!(entries[0].size, 4);
        let revision = entries[0].revision.clone();
        roots.read(id, "file", 0, 1).unwrap();
        assert_eq!(roots.list(id, "").unwrap()[0].revision, revision);
        roots.release(id).unwrap();
        assert!(roots.read(id, "file", 0, 1).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_cannot_escape_the_selected_root() {
        let temp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::fs::write(outside.path().join("private"), [9]).unwrap();
        std::os::unix::fs::symlink(outside.path(), temp.path().join("link")).unwrap();
        let state = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::new(state.path().to_path_buf(), [7u8; 32]);
        let id = roots.register(temp.path()).unwrap();
        assert_eq!(roots.list(id, "").unwrap()[0].kind, "symlink");
        assert!(roots.read(id, "link/private", 0, 1).is_err());
        assert!(roots.list(id, "link").is_err());
        assert!(roots.begin(id, "link/private", 1).is_err());
    }
}
