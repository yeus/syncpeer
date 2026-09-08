use cap_std::fs::{Dir, File, Metadata, OpenOptions};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Default)]
pub struct ReplicaRoots {
    next: u64,
    roots: HashMap<u64, Dir>,
    guards: HashMap<u64, ReplicaRootGuard>,
    locks: HashMap<u64, std::fs::File>,
    writers: HashMap<u64, ReplicaWriter>,
}

impl Drop for ReplicaRoots {
    fn drop(&mut self) {
        for id in self.roots.keys().copied().collect::<Vec<_>>() {
            let _ = self.release(id);
        }
    }
}

struct ReplicaRootGuard {
    path: PathBuf,
    identity: String,
    marker: Option<String>,
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
    match root.symlink_metadata(".syncpeer-folder-marker") {
        Ok(metadata) if metadata.is_file() && !metadata.is_symlink() => {
            Ok(Some(file_identity(&metadata)?))
        }
        Ok(_) => Err(invalid("Invalid replica folder marker")),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
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
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplicaEntry {
    name: String,
    kind: &'static str,
    size: u64,
    modified_ms: u64,
    revision: String,
}

fn invalid(message: &str) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidInput, message)
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
    pub fn register(&mut self, path: &Path) -> io::Result<u64> {
        if !path.is_absolute() || std::fs::symlink_metadata(path)?.is_symlink() {
            return Err(invalid(
                "Selected folder must be an absolute directory without a root symlink",
            ));
        }
        let root = Dir::open_ambient_dir(path, cap_std::ambient_authority())?;
        self.next = self
            .next
            .checked_add(1)
            .ok_or_else(|| invalid("Folder handle limit reached"))?;
        self.guards.insert(
            self.next,
            ReplicaRootGuard {
                path: path.to_path_buf(),
                identity: file_identity(&root.dir_metadata()?)?,
                marker: marker_identity(&root)?,
            },
        );
        self.roots.insert(self.next, root);
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
        let marker = marker_identity(root)?;
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
        let root = self.root(id)?;
        let path = ".syncpeer-replica.lock";
        check_relative(root, path)?;
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true);
        #[cfg(unix)]
        {
            use cap_std::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let file = root.open_with(path, &options)?.into_std();
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
            if let Some(marker) = marker_identity(root)? {
                self.guards.get_mut(&id).unwrap().marker = Some(marker);
                return Ok(());
            }
            // Initialization is explicit and only safe for an otherwise empty root.
            for entry in root.entries()? {
                if entry?.file_name() != ".syncpeer-replica.lock" {
                    return Err(invalid("Replica initialization requires an empty folder"));
                }
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            root.open_with(".syncpeer-folder-marker", &options)?
                .sync_all()?;
            flush_parents(root, ".syncpeer-folder-marker")?;
            let marker = marker_identity(root)?;
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
        Ok(result)
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
        let original = current_revision(root, path)?;
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
        let file = root.open_with(&temporary, &options)?;
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
        if bytes.len() > 131072 || end > writer.size {
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
        if directory {
            root.remove_dir(path)?;
        } else {
            root.remove_file(path)?;
        }
        flush_parents(root, path)
    }

    fn flush(&self, id: u64, paths: &[String]) -> io::Result<()> {
        let root = self.root(id)?;
        for path in paths {
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
        let root = self.root(id)?;
        let before =
            current_revision(root, source)?.ok_or_else(|| invalid("Copy source missing"))?;
        if current_revision(root, target)?.is_some() {
            return Err(invalid("Archive already exists"));
        }
        let mut input = root.open(source)?;
        let metadata = input.metadata()?;
        let modified_ms = metadata
            .modified()?
            .into_std()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| invalid("File time out of range"))?
            .as_millis();
        let writer = self.begin(id, target, metadata.len())?;
        let result = (|| {
            let mut buffer = vec![0; 131072];
            let mut offset = 0;
            loop {
                let count = input.read(&mut buffer)?;
                if count == 0 {
                    break;
                }
                self.write(writer, offset, &buffer[..count])?;
                offset += count as u64;
            }
            if current_revision(self.root(id)?, source)?.as_ref() != Some(&before)
                || revision(&input.metadata()?) != before
            {
                return Err(invalid("Copy source changed"));
            }
            self.commit(
                writer,
                Some(u64::try_from(modified_ms).map_err(|_| invalid("File time out of range"))?),
                true,
            )
        })();
        if result.is_err() {
            self.abort(writer)?;
        }
        result
    }

    fn abort(&mut self, id: u64) -> io::Result<()> {
        if let Some(mut writer) = self.writers.remove(&id) {
            drop(writer.file.take());
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
}

pub fn dispatch(
    roots: &mut ReplicaRoots,
    request: ReplicaStorageRequest,
) -> Result<serde_json::Value, String> {
    let result = match request {
        ReplicaStorageRequest::Register { root_path } => serde_json::json!(roots
            .register(Path::new(&root_path))
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
    };
    Ok(result)
}

#[tauri::command]
pub async fn syncpeer_replica_storage(
    state: tauri::State<'_, Arc<Mutex<ReplicaRoots>>>,
    request: ReplicaStorageRequest,
) -> Result<serde_json::Value, String> {
    let state = Arc::clone(state.inner());
    tauri::async_runtime::spawn_blocking(move || {
        let mut roots = state
            .lock()
            .map_err(|_| "Folder handle store unavailable".to_string())?;
        dispatch(&mut roots, request)
    })
    .await
    .map_err(|error| format!("Folder storage worker failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replica_locks_exclude_other_handles_and_release_on_close() {
        let temp = tempfile::tempdir().unwrap();
        let mut roots = ReplicaRoots::default();
        let first = roots.register(temp.path()).unwrap();
        let second = roots.register(temp.path()).unwrap();
        roots.initialize_replica(first).unwrap();
        roots.initialize_replica(second).unwrap();
        roots.acquire(first).unwrap();
        assert!(roots.acquire(first).is_err());
        assert!(roots.acquire(second).is_err());
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
        let mut roots = ReplicaRoots::default();
        let id = roots.register(&path).unwrap();
        assert!(roots.check_health(id).is_err());
        roots.initialize_replica(id).unwrap();
        roots.check_health(id).unwrap();
        std::fs::remove_file(path.join(".syncpeer-folder-marker")).unwrap();
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
        let mut roots = ReplicaRoots::default();
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
        let mut roots = ReplicaRoots::default();
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
        let mut roots = ReplicaRoots::default();
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
        let mut roots = ReplicaRoots::default();
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
        let mut roots = ReplicaRoots::default();
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
        let mut roots = ReplicaRoots::default();
        let id = roots.register(temp.path()).unwrap();
        assert_eq!(roots.list(id, "").unwrap()[0].kind, "symlink");
        assert!(roots.read(id, "link/private", 0, 1).is_err());
        assert!(roots.list(id, "link").is_err());
        assert!(roots.begin(id, "link/private", 1).is_err());
    }
}
