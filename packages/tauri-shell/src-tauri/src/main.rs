#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde::de::DeserializeOwned;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectRequest {
  host: String,
  port: u16,
  discovery_mode: Option<String>,
  discovery_server: Option<String>,
  cert: Option<String>,
  key: Option<String>,
  remote_id: Option<String>,
  device_name: String,
  timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadDirRequest {
  #[serde(flatten)]
  connection: ConnectRequest,
  folder_id: String,
  path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadFileRequest {
  #[serde(flatten)]
  connection: ConnectRequest,
  folder_id: String,
  path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FolderInfo {
  id: String,
  label: String,
  #[serde(rename = "readOnly")]
  read_only: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoteDeviceInfo {
  id: String,
  device_name: String,
  client_name: String,
  client_version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FolderSyncState {
  folder_id: String,
  remote_index_id: String,
  remote_max_sequence: String,
  index_received: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ConnectionOverview {
  folders: Vec<FolderInfo>,
  device: Option<RemoteDeviceInfo>,
  #[serde(default)]
  #[serde(rename = "folderSyncStates")]
  folder_sync_states: Vec<FolderSyncState>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct FileEntry {
  name: String,
  path: String,
  #[serde(rename = "type")]
  entry_type: String,
  size: f64,
  #[serde(rename = "modifiedMs")]
  modified_ms: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct UiErrorLogRequest {
  event: String,
  details: serde_json::Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FavoriteItemRecord {
  key: String,
  folder_id: String,
  path: String,
  name: String,
  kind: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct FavoritesStore {
  favorites: Vec<FavoriteItemRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpsertFavoriteRequest {
  favorite: FavoriteItemRecord,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveFavoriteRequest {
  key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CacheFileRequest {
  folder_id: String,
  path: String,
  name: String,
  bytes: Vec<u8>,
  modified_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFileRecord {
  key: String,
  folder_id: String,
  path: String,
  name: String,
  local_path: String,
  size_bytes: usize,
  cached_at_ms: u64,
  modified_ms: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct CacheIndex {
  files: Vec<CachedFileRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedStatusesRequest {
  folder_id: String,
  paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CachedFileStatus {
  path: String,
  available: bool,
  local_path: Option<String>,
  cached_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenCachedFileRequest {
  folder_id: String,
  path: String,
}

fn now_ms() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|duration| duration.as_millis() as u64)
    .unwrap_or(0)
}

fn normalize_path(value: &str) -> String {
  value.trim_matches('/').to_string()
}

fn cache_key(folder_id: &str, path: &str) -> String {
  format!("{}:{}", folder_id.trim(), normalize_path(path))
}

fn hex_encode(bytes: &[u8]) -> String {
  const HEX: &[u8; 16] = b"0123456789abcdef";
  let mut output = String::with_capacity(bytes.len() * 2);
  for byte in bytes {
    output.push(HEX[(byte >> 4) as usize] as char);
    output.push(HEX[(byte & 0x0f) as usize] as char);
  }
  output
}

fn sanitize_name(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  for ch in value.trim().chars() {
    if ch.is_ascii_alphanumeric() || ch == '.' || ch == '-' || ch == '_' {
      out.push(ch);
    } else {
      out.push('_');
    }
  }
  if out.is_empty() {
    "download.bin".to_string()
  } else {
    out
  }
}

fn app_data_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let root = app
    .path()
    .app_data_dir()
    .map_err(|error| format!("Could not resolve app data dir: {error}"))?;
  Ok(root.join("syncpeer"))
}

fn app_cache_files_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let root = app
    .path()
    .app_cache_dir()
    .map_err(|error| format!("Could not resolve app cache dir: {error}"))?;
  Ok(root.join("syncpeer").join("files"))
}

fn favorites_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app_data_root(app)?.join("favorites.json"))
}

fn cache_index_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app_data_root(app)?.join("cache-index.json"))
}

fn read_json_or_default<T: DeserializeOwned + Default>(path: &Path) -> Result<T, String> {
  if !path.exists() {
    return Ok(T::default());
  }
  let raw = fs::read_to_string(path).map_err(|error| format!("Could not read {}: {error}", path.display()))?;
  serde_json::from_str::<T>(&raw).map_err(|error| format!("Could not parse {}: {error}", path.display()))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
  }
  let content = serde_json::to_vec_pretty(value).map_err(|error| format!("Could not encode JSON: {error}"))?;
  let temp_path = path.with_extension("tmp");
  fs::write(&temp_path, content).map_err(|error| format!("Could not write {}: {error}", temp_path.display()))?;
  fs::rename(&temp_path, path).map_err(|error| format!("Could not rename {}: {error}", path.display()))
}

fn open_file_with_system(path: &Path) -> Result<(), String> {
  #[cfg(target_os = "macos")]
  let mut command = {
    let mut cmd = Command::new("open");
    cmd.arg(path);
    cmd
  };

  #[cfg(target_os = "windows")]
  let mut command = {
    let mut cmd = Command::new("cmd");
    cmd.args(["/C", "start", ""]).arg(path);
    cmd
  };

  #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
  let mut command = {
    let mut cmd = Command::new("xdg-open");
    cmd.arg(path);
    cmd
  };

  #[cfg(target_os = "android")]
  let mut command = {
    let mut cmd = Command::new("am");
    let uri = format!("file://{}", path.display());
    cmd.args(["start", "-a", "android.intent.action.VIEW", "-d", &uri]);
    cmd
  };

  let status = command
    .status()
    .map_err(|error| format!("Could not launch open command: {error}"))?;
  if !status.success() {
    return Err(format!("Open command exited with status: {status}"));
  }
  Ok(())
}

fn resolve_workspace_root() -> Result<PathBuf, String> {
  let manifest_dir = Path::new(env!("CARGO_MANIFEST_DIR"));
  let candidate = manifest_dir.join("../../..");
  candidate
    .canonicalize()
    .map_err(|error| format!("Could not resolve workspace root: {error}"))
}

fn resolve_bridge_script(workspace_root: &Path) -> PathBuf {
  workspace_root.join("packages/tauri-shell/bridge/syncpeer-bridge.mjs")
}

fn tauri_log(message: &str) {
  eprintln!("[syncpeer-tauri] {message}");
}

fn extract_command_error(output: &std::process::Output, streamed_stderr: &str) -> String {
  let stderr = if streamed_stderr.trim().is_empty() {
    String::from_utf8_lossy(&output.stderr).trim().to_string()
  } else {
    streamed_stderr.trim().to_string()
  };
  if !stderr.is_empty() {
    return stderr;
  }
  let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
  if !stdout.is_empty() {
    return stdout;
  }
  "Node bridge process failed without output".to_string()
}

fn run_bridge_command<TPayload: Serialize>(operation: &str, payload: &TPayload) -> Result<String, String> {
  let workspace_root = resolve_workspace_root()?;
  let bridge_script = resolve_bridge_script(&workspace_root);
  if !bridge_script.exists() {
    return Err(format!(
      "Bridge script not found at {}",
      bridge_script.display()
    ));
  }

  let payload_json = serde_json::to_string(payload)
    .map_err(|error| format!("Failed to encode payload: {error}"))?;

  tauri_log(&format!("bridge command start: {operation}"));

  let mut child = Command::new("node")
    .arg(bridge_script)
    .arg(operation)
    .arg(payload_json)
    .current_dir(workspace_root)
    .stdout(Stdio::piped())
    .stderr(Stdio::piped())
    .spawn()
    .map_err(|error| format!("Failed to run Node bridge: {error}"))?;

  let stderr = child
    .stderr
    .take()
    .ok_or_else(|| "Failed to capture bridge stderr".to_string())?;

  let stderr_acc = Arc::new(Mutex::new(String::new()));
  let stderr_acc_reader = Arc::clone(&stderr_acc);
  let stderr_thread = std::thread::spawn(move || {
    let reader = BufReader::new(stderr);
    for line in reader.lines() {
      match line {
        Ok(raw_line) => {
          let trimmed = raw_line.trim();
          if !trimmed.is_empty() {
            tauri_log(trimmed);
            if let Ok(mut collected) = stderr_acc_reader.lock() {
              if !collected.is_empty() {
                collected.push('\n');
              }
              collected.push_str(trimmed);
            }
          }
        }
        Err(_) => break,
      }
    }
  });

  let output = child
    .wait_with_output()
    .map_err(|error| format!("Failed while waiting for Node bridge output: {error}"))?;

  let _ = stderr_thread.join();
  let streamed_stderr = stderr_acc
    .lock()
    .map(|value| value.clone())
    .unwrap_or_default();

  if !output.status.success() {
    return Err(extract_command_error(&output, &streamed_stderr));
  }

  tauri_log(&format!("bridge command success: {operation}"));

  String::from_utf8(output.stdout)
    .map_err(|error| format!("Bridge output is not valid UTF-8: {error}"))
}

fn decode_json_output<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
  serde_json::from_str(raw).map_err(|error| format!("Failed to decode bridge JSON output: {error}"))
}

#[tauri::command]
async fn syncpeer_connect_and_list_folders(request: ConnectRequest) -> Result<Vec<FolderInfo>, String> {
  tauri_log(&format!(
    "command syncpeer_connect_and_list_folders host={} port={} remote_id={}",
    request.host,
    request.port,
    request.remote_id.clone().unwrap_or_else(|| "(none)".to_string())
  ));
  let raw = tauri::async_runtime::spawn_blocking(move || run_bridge_command("connect_and_list_folders", &request))
    .await
    .map_err(|error| format!("Bridge task join error: {error}"))??;
  decode_json_output(&raw)
}

#[tauri::command]
async fn syncpeer_read_remote_dir(request: ReadDirRequest) -> Result<Vec<FileEntry>, String> {
  tauri_log(&format!(
    "command syncpeer_read_remote_dir folder_id={} path={}",
    request.folder_id,
    request.path.clone().unwrap_or_default()
  ));
  let raw = tauri::async_runtime::spawn_blocking(move || run_bridge_command("read_remote_dir", &request))
    .await
    .map_err(|error| format!("Bridge task join error: {error}"))??;
  decode_json_output(&raw)
}

#[tauri::command]
async fn syncpeer_read_remote_file(request: ReadFileRequest) -> Result<Vec<u8>, String> {
  tauri_log(&format!(
    "command syncpeer_read_remote_file folder_id={} path={}",
    request.folder_id,
    request.path
  ));
  let raw = tauri::async_runtime::spawn_blocking(move || run_bridge_command("read_remote_file", &request))
    .await
    .map_err(|error| format!("Bridge task join error: {error}"))??;
  decode_json_output(&raw)
}

#[tauri::command]
async fn syncpeer_connect_and_get_overview(request: ConnectRequest) -> Result<ConnectionOverview, String> {
  tauri_log(&format!(
    "command syncpeer_connect_and_get_overview host={} port={} remote_id={}",
    request.host,
    request.port,
    request.remote_id.clone().unwrap_or_else(|| "(none)".to_string())
  ));
  let raw = tauri::async_runtime::spawn_blocking(move || run_bridge_command("connect_and_get_overview", &request))
    .await
    .map_err(|error| format!("Bridge task join error: {error}"))??;
  decode_json_output(&raw)
}

#[tauri::command]
async fn syncpeer_get_folder_versions(request: ConnectRequest) -> Result<Vec<FolderSyncState>, String> {
  tauri_log(&format!(
    "command syncpeer_get_folder_versions host={} port={} remote_id={}",
    request.host,
    request.port,
    request.remote_id.clone().unwrap_or_else(|| "(none)".to_string())
  ));
  let raw = tauri::async_runtime::spawn_blocking(move || run_bridge_command("connect_and_get_folder_versions", &request))
    .await
    .map_err(|error| format!("Bridge task join error: {error}"))??;
  decode_json_output(&raw)
}

#[tauri::command]
async fn syncpeer_log_ui_error(entry: UiErrorLogRequest) -> Result<(), String> {
  tauri_log(&format!(
    "ui.error event={} details={}",
    entry.event,
    entry.details
  ));
  Ok(())
}

#[tauri::command]
async fn syncpeer_list_favorites(app: tauri::AppHandle) -> Result<Vec<FavoriteItemRecord>, String> {
  let path = favorites_path(&app)?;
  let mut store = read_json_or_default::<FavoritesStore>(&path)?;
  store.favorites.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  Ok(store.favorites)
}

#[tauri::command]
async fn syncpeer_upsert_favorite(
  app: tauri::AppHandle,
  request: UpsertFavoriteRequest,
) -> Result<Vec<FavoriteItemRecord>, String> {
  let path = favorites_path(&app)?;
  let mut store = read_json_or_default::<FavoritesStore>(&path)?;
  let normalized = FavoriteItemRecord {
    key: request.favorite.key.trim().to_string(),
    folder_id: request.favorite.folder_id.trim().to_string(),
    path: normalize_path(&request.favorite.path),
    name: request.favorite.name.trim().to_string(),
    kind: request.favorite.kind.trim().to_string(),
  };
  if normalized.key.is_empty() || normalized.folder_id.is_empty() {
    return Err("favorite key and folderId are required.".to_string());
  }
  store.favorites.retain(|entry| entry.key != normalized.key);
  store.favorites.push(normalized);
  store.favorites.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
  write_json(&path, &store)?;
  Ok(store.favorites)
}

#[tauri::command]
async fn syncpeer_remove_favorite(
  app: tauri::AppHandle,
  request: RemoveFavoriteRequest,
) -> Result<Vec<FavoriteItemRecord>, String> {
  let path = favorites_path(&app)?;
  let mut store = read_json_or_default::<FavoritesStore>(&path)?;
  store.favorites.retain(|entry| entry.key != request.key);
  write_json(&path, &store)?;
  Ok(store.favorites)
}

#[tauri::command]
async fn syncpeer_cache_file(
  app: tauri::AppHandle,
  request: CacheFileRequest,
) -> Result<CachedFileRecord, String> {
  if request.folder_id.trim().is_empty() {
    return Err("folderId is required.".to_string());
  }
  let normalized_path = normalize_path(&request.path);
  if normalized_path.is_empty() {
    return Err("path is required.".to_string());
  }

  let key = cache_key(&request.folder_id, &normalized_path);
  let file_name_seed = format!("{}|{}|{}", request.folder_id.trim(), normalized_path, sanitize_name(&request.name));
  let ext = Path::new(&request.name)
    .extension()
    .and_then(|value| value.to_str())
    .map(|value| value.to_string())
    .unwrap_or_default();
  let base_name = hex_encode(file_name_seed.as_bytes());
  let local_file_name = if ext.is_empty() {
    base_name
  } else {
    format!("{base_name}.{ext}")
  };

  let cache_root = app_cache_files_root(&app)?;
  fs::create_dir_all(&cache_root)
    .map_err(|error| format!("Could not create cache root {}: {error}", cache_root.display()))?;
  let local_path = cache_root.join(local_file_name);
  fs::write(&local_path, &request.bytes)
    .map_err(|error| format!("Could not write cached file {}: {error}", local_path.display()))?;

  let index_path = cache_index_path(&app)?;
  let mut index = read_json_or_default::<CacheIndex>(&index_path)?;
  index.files.retain(|entry| entry.key != key);
  let record = CachedFileRecord {
    key,
    folder_id: request.folder_id.trim().to_string(),
    path: normalized_path,
    name: sanitize_name(&request.name),
    local_path: local_path.to_string_lossy().to_string(),
    size_bytes: request.bytes.len(),
    cached_at_ms: now_ms(),
    modified_ms: request.modified_ms,
  };
  index.files.push(record.clone());
  write_json(&index_path, &index)?;

  Ok(record)
}

#[tauri::command]
async fn syncpeer_get_cached_statuses(
  app: tauri::AppHandle,
  request: CachedStatusesRequest,
) -> Result<Vec<CachedFileStatus>, String> {
  if request.folder_id.trim().is_empty() {
    return Err("folderId is required.".to_string());
  }
  let index_path = cache_index_path(&app)?;
  let index = read_json_or_default::<CacheIndex>(&index_path)?;

  let statuses = request
    .paths
    .into_iter()
    .map(|raw_path| {
      let normalized = normalize_path(&raw_path);
      let key = cache_key(&request.folder_id, &normalized);
      if let Some(record) = index.files.iter().find(|entry| entry.key == key) {
        let local_path = PathBuf::from(&record.local_path);
        if local_path.exists() {
          return CachedFileStatus {
            path: normalized,
            available: true,
            local_path: Some(record.local_path.clone()),
            cached_at_ms: Some(record.cached_at_ms),
          };
        }
      }
      CachedFileStatus {
        path: normalized,
        available: false,
        local_path: None,
        cached_at_ms: None,
      }
    })
    .collect::<Vec<_>>();

  Ok(statuses)
}

#[tauri::command]
async fn syncpeer_open_cached_file(
  app: tauri::AppHandle,
  request: OpenCachedFileRequest,
) -> Result<(), String> {
  if request.folder_id.trim().is_empty() {
    return Err("folderId is required.".to_string());
  }
  let normalized_path = normalize_path(&request.path);
  if normalized_path.is_empty() {
    return Err("path is required.".to_string());
  }
  let index_path = cache_index_path(&app)?;
  let index = read_json_or_default::<CacheIndex>(&index_path)?;
  let key = cache_key(&request.folder_id, &normalized_path);
  let record = index
    .files
    .iter()
    .find(|entry| entry.key == key)
    .ok_or_else(|| "No cached file for this path.".to_string())?;
  let local_path = PathBuf::from(&record.local_path);
  if !local_path.exists() {
    return Err("Cached file is missing on disk.".to_string());
  }
  open_file_with_system(&local_path)
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      syncpeer_connect_and_list_folders,
      syncpeer_read_remote_dir,
      syncpeer_connect_and_get_overview,
      syncpeer_get_folder_versions,
      syncpeer_read_remote_file,
      syncpeer_log_ui_error,
      syncpeer_list_favorites,
      syncpeer_upsert_favorite,
      syncpeer_remove_favorite,
      syncpeer_cache_file,
      syncpeer_get_cached_statuses,
      syncpeer_open_cached_file
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
