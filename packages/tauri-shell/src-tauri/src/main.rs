#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConnectRequest {
  host: String,
  port: u16,
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
struct FolderInfo {
  id: String,
  label: String,
  #[serde(rename = "readOnly")]
  read_only: bool,
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

fn emit_bridge_stderr(output: &std::process::Output) {
  let stderr = String::from_utf8_lossy(&output.stderr);
  for line in stderr.lines() {
    if !line.trim().is_empty() {
      tauri_log(line);
    }
  }
}

fn extract_command_error(output: &std::process::Output) -> String {
  let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
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

  let output = Command::new("node")
    .arg(bridge_script)
    .arg(operation)
    .arg(payload_json)
    .current_dir(workspace_root)
    .output()
    .map_err(|error| format!("Failed to run Node bridge: {error}"))?;

  emit_bridge_stderr(&output);

  if !output.status.success() {
    return Err(extract_command_error(&output));
  }

  tauri_log(&format!("bridge command success: {operation}"));

  String::from_utf8(output.stdout)
    .map_err(|error| format!("Bridge output is not valid UTF-8: {error}"))
}

fn decode_json_output<T: for<'de> Deserialize<'de>>(raw: &str) -> Result<T, String> {
  serde_json::from_str(raw).map_err(|error| format!("Failed to decode bridge JSON output: {error}"))
}

#[tauri::command]
fn syncpeer_connect_and_list_folders(request: ConnectRequest) -> Result<Vec<FolderInfo>, String> {
  tauri_log(&format!(
    "command syncpeer_connect_and_list_folders host={} port={} remote_id={}",
    request.host,
    request.port,
    request.remote_id.clone().unwrap_or_else(|| "(none)".to_string())
  ));
  let raw = run_bridge_command("connect_and_list_folders", &request)?;
  decode_json_output(&raw)
}

#[tauri::command]
fn syncpeer_read_remote_dir(request: ReadDirRequest) -> Result<Vec<FileEntry>, String> {
  tauri_log(&format!(
    "command syncpeer_read_remote_dir folder_id={} path={}",
    request.folder_id,
    request.path.clone().unwrap_or_default()
  ));
  let raw = run_bridge_command("read_remote_dir", &request)?;
  decode_json_output(&raw)
}

fn main() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      syncpeer_connect_and_list_folders,
      syncpeer_read_remote_dir
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
