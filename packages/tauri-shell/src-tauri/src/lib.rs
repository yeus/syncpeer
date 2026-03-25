use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RemoveCachedFileRequest {
  folder_id: String,
  path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadTextFileRequest {
  path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsOpenRequest {
  host: String,
  port: u16,
  cert_pem: String,
  key_pem: String,
  ca_pem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsOpenResponse {
  session_id: u64,
  peer_certificate_der: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CliNodeIdentityResponse {
  cert_path: String,
  key_path: String,
  cert_pem: String,
  key_pem: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsReadRequest {
  session_id: u64,
  max_bytes: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsReadResponse {
  bytes: Vec<u8>,
  eof: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsWriteRequest {
  session_id: u64,
  bytes: Vec<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsCloseRequest {
  session_id: u64,
}

struct TlsSession {
  stream: StreamOwned<ClientConnection, TcpStream>,
}

#[derive(Default)]
struct TlsSessionStore {
  next_id: u64,
  sessions: HashMap<u64, Arc<Mutex<TlsSession>>>,
}

type SharedTlsStore = Arc<Mutex<TlsSessionStore>>;

#[derive(Debug)]
struct NoCertificateVerification;

impl ServerCertVerifier for NoCertificateVerification {
  fn verify_server_cert(
    &self,
    _end_entity: &CertificateDer<'_>,
    _intermediates: &[CertificateDer<'_>],
    _server_name: &ServerName<'_>,
    _ocsp_response: &[u8],
    _now: UnixTime,
  ) -> Result<ServerCertVerified, rustls::Error> {
    Ok(ServerCertVerified::assertion())
  }

  fn verify_tls12_signature(
    &self,
    _message: &[u8],
    _cert: &CertificateDer<'_>,
    _dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    Ok(HandshakeSignatureValid::assertion())
  }

  fn verify_tls13_signature(
    &self,
    _message: &[u8],
    _cert: &CertificateDer<'_>,
    _dss: &DigitallySignedStruct,
  ) -> Result<HandshakeSignatureValid, rustls::Error> {
    Ok(HandshakeSignatureValid::assertion())
  }

  fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
    vec![
      SignatureScheme::ECDSA_NISTP256_SHA256,
      SignatureScheme::ECDSA_NISTP384_SHA384,
      SignatureScheme::ED25519,
      SignatureScheme::RSA_PSS_SHA256,
      SignatureScheme::RSA_PSS_SHA384,
      SignatureScheme::RSA_PSS_SHA512,
      SignatureScheme::RSA_PKCS1_SHA256,
      SignatureScheme::RSA_PKCS1_SHA384,
      SignatureScheme::RSA_PKCS1_SHA512,
    ]
  }
}

fn tauri_log(message: &str) {
  eprintln!("[syncpeer-tauri] {message}");
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
    let mut cmd = std::process::Command::new("open");
    cmd.arg(path);
    cmd
  };

  #[cfg(target_os = "windows")]
  let mut command = {
    let mut cmd = std::process::Command::new("cmd");
    cmd.args(["/C", "start", ""]).arg(path);
    cmd
  };

  #[cfg(all(unix, not(target_os = "macos"), not(target_os = "android")))]
  let mut command = {
    let mut cmd = std::process::Command::new("xdg-open");
    cmd.arg(path);
    cmd
  };

  #[cfg(target_os = "android")]
  let mut command = {
    let mut cmd = std::process::Command::new("am");
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

fn get_tls_session(store: &tauri::State<SharedTlsStore>, session_id: u64) -> Result<Arc<Mutex<TlsSession>>, String> {
  let guard = store
    .lock()
    .map_err(|_| "TLS session store lock poisoned".to_string())?;
  guard
    .sessions
    .get(&session_id)
    .cloned()
    .ok_or_else(|| format!("Unknown TLS session: {session_id}"))
}

#[tauri::command]
async fn syncpeer_read_text_file(request: ReadTextFileRequest) -> Result<String, String> {
  let path = PathBuf::from(request.path);
  fs::read_to_string(&path).map_err(|error| format!("Could not read {}: {error}", path.display()))
}

#[tauri::command]
async fn syncpeer_read_default_cli_identity(
  app: tauri::AppHandle,
) -> Result<CliNodeIdentityResponse, String> {
  let config_dir = app
    .path()
    .config_dir()
    .map_err(|error| format!("Could not resolve config dir: {error}"))?;
  let cli_node_dir = config_dir.join("syncpeer").join("cli-node");
  let cert_path = cli_node_dir.join("cert.pem");
  let key_path = cli_node_dir.join("key.pem");

  if !cert_path.exists() || !key_path.exists() {
    return Err(format!(
      "Missing cert/key. Provide PEM text, file paths, or create persisted identity at {}.",
      cli_node_dir.display()
    ));
  }

  let cert_pem = fs::read_to_string(&cert_path)
    .map_err(|error| format!("Could not read {}: {error}", cert_path.display()))?;
  let key_pem = fs::read_to_string(&key_path)
    .map_err(|error| format!("Could not read {}: {error}", key_path.display()))?;

  Ok(CliNodeIdentityResponse {
    cert_path: cert_path.to_string_lossy().to_string(),
    key_path: key_path.to_string_lossy().to_string(),
    cert_pem,
    key_pem,
  })
}

#[tauri::command]
async fn syncpeer_tls_open(
  store: tauri::State<'_, SharedTlsStore>,
  request: TlsOpenRequest,
) -> Result<TlsOpenResponse, String> {
  let shared_store = store.inner().clone();
  tauri::async_runtime::spawn_blocking(move || {
    let mut cert_reader = std::io::BufReader::new(request.cert_pem.as_bytes());
    let cert_chain = rustls_pemfile::certs(&mut cert_reader)
      .collect::<Result<Vec<_>, _>>()
      .map_err(|error| format!("Invalid client certificate PEM: {error}"))?;
    if cert_chain.is_empty() {
      return Err("Client certificate PEM did not contain any certificate".to_string());
    }

    let mut key_reader = std::io::BufReader::new(request.key_pem.as_bytes());
    let private_key = rustls_pemfile::private_key(&mut key_reader)
      .map_err(|error| format!("Invalid client private key PEM: {error}"))?
      .ok_or_else(|| "Client key PEM did not contain a private key".to_string())?;

    if let Some(ca_pem) = request.ca_pem.as_ref() {
      let mut ca_reader = std::io::BufReader::new(ca_pem.as_bytes());
      let ca_chain = rustls_pemfile::certs(&mut ca_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid CA PEM: {error}"))?;
      if ca_chain.is_empty() {
        return Err("CA PEM did not contain any certificate".to_string());
      }
    }

    let config = ClientConfig::builder()
      .dangerous()
      .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
      .with_client_auth_cert(cert_chain, private_key)
      .map_err(|error| format!("Invalid client cert/key pair: {error}"))?;
    let config = Arc::new(config);

    let address = format!("{}:{}", request.host, request.port);
    let tcp = TcpStream::connect(&address).map_err(|error| format!("TCP connect to {address} failed: {error}"))?;
    let server_name = ServerName::try_from(request.host.clone())
      .map_err(|error| format!("Invalid TLS host '{}': {error}", request.host))?;
    let connection =
      ClientConnection::new(config, server_name).map_err(|error| format!("Could not create TLS client: {error}"))?;
    let mut stream = StreamOwned::new(connection, tcp);
    {
      let (conn, sock) = (&mut stream.conn, &mut stream.sock);
      conn
        .complete_io(sock)
        .map_err(|error| format!("TLS connect to {address} failed: {error}"))?;
    }
    let peer_certificate_der = stream
      .conn
      .peer_certificates()
      .and_then(|certs| certs.first())
      .map(|cert| cert.as_ref().to_vec())
      .ok_or_else(|| "Peer certificate missing".to_string())?;

    let mut guard = shared_store
      .lock()
      .map_err(|_| "TLS session store lock poisoned".to_string())?;
    let next_id = guard.next_id.saturating_add(1).max(1);
    guard.next_id = next_id;
    guard.sessions.insert(
      next_id,
      Arc::new(Mutex::new(TlsSession {
        stream,
      })),
    );
    Ok(TlsOpenResponse {
      session_id: next_id,
      peer_certificate_der,
    })
  })
  .await
  .map_err(|error| format!("TLS open task join error: {error}"))?
}

#[tauri::command]
async fn syncpeer_tls_read(
  store: tauri::State<'_, SharedTlsStore>,
  request: TlsReadRequest,
) -> Result<TlsReadResponse, String> {
  let session = get_tls_session(&store, request.session_id)?;
  tauri::async_runtime::spawn_blocking(move || {
    let mut guard = session
      .lock()
      .map_err(|_| "TLS session lock poisoned".to_string())?;
    let max_bytes = request.max_bytes.unwrap_or(64 * 1024).clamp(1, 1024 * 1024);
    guard
      .stream
      .get_ref()
      .set_read_timeout(Some(Duration::from_millis(250)))
      .map_err(|error| format!("Could not set TLS read timeout: {error}"))?;
    let mut buf = vec![0u8; max_bytes];
    match guard.stream.read(&mut buf) {
      Ok(0) => Ok(TlsReadResponse {
        bytes: Vec::new(),
        eof: true,
      }),
      Ok(read) => {
        buf.truncate(read);
        Ok(TlsReadResponse {
          bytes: buf,
          eof: false,
        })
      }
      Err(error) if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => {
        Ok(TlsReadResponse {
          bytes: Vec::new(),
          eof: false,
        })
      }
      Err(error) => Err(format!("TLS read failed: {error}")),
    }
  })
  .await
  .map_err(|error| format!("TLS read task join error: {error}"))?
}

#[tauri::command]
async fn syncpeer_tls_write(
  store: tauri::State<'_, SharedTlsStore>,
  request: TlsWriteRequest,
) -> Result<(), String> {
  let session = get_tls_session(&store, request.session_id)?;
  tauri::async_runtime::spawn_blocking(move || {
    let mut guard = session
      .lock()
      .map_err(|_| "TLS session lock poisoned".to_string())?;
    guard
      .stream
      .write_all(&request.bytes)
      .map_err(|error| format!("TLS write failed: {error}"))?;
    guard
      .stream
      .flush()
      .map_err(|error| format!("TLS flush failed: {error}"))?;
    Ok(())
  })
  .await
  .map_err(|error| format!("TLS write task join error: {error}"))?
}

#[tauri::command]
async fn syncpeer_tls_close(
  store: tauri::State<'_, SharedTlsStore>,
  request: TlsCloseRequest,
) -> Result<(), String> {
  let removed = {
    let mut guard = store
      .lock()
      .map_err(|_| "TLS session store lock poisoned".to_string())?;
    guard.sessions.remove(&request.session_id)
  };
  if let Some(session) = removed {
    tauri::async_runtime::spawn_blocking(move || {
      if let Ok(mut guard) = session.lock() {
        let _ = guard.stream.get_mut().shutdown(Shutdown::Both);
      }
      Ok::<(), String>(())
    })
    .await
    .map_err(|error| format!("TLS close task join error: {error}"))??;
  }
  Ok(())
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
async fn syncpeer_list_cached_files(app: tauri::AppHandle) -> Result<Vec<CachedFileRecord>, String> {
  let path = cache_index_path(&app)?;
  let mut index = read_json_or_default::<CacheIndex>(&path)?;
  index
    .files
    .sort_by(|a, b| b.cached_at_ms.cmp(&a.cached_at_ms).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())));
  Ok(index.files)
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

#[tauri::command]
async fn syncpeer_remove_cached_file(
  app: tauri::AppHandle,
  request: RemoveCachedFileRequest,
) -> Result<bool, String> {
  if request.folder_id.trim().is_empty() {
    return Err("folderId is required.".to_string());
  }
  let normalized_path = normalize_path(&request.path);
  if normalized_path.is_empty() {
    return Err("path is required.".to_string());
  }

  let index_path = cache_index_path(&app)?;
  let mut index = read_json_or_default::<CacheIndex>(&index_path)?;
  let key = cache_key(&request.folder_id, &normalized_path);
  let Some(record_index) = index.files.iter().position(|entry| entry.key == key) else {
    return Ok(false);
  };

  let record = index.files.remove(record_index);
  write_json(&index_path, &index)?;

  let local_path = PathBuf::from(record.local_path);
  if local_path.exists() {
    fs::remove_file(&local_path)
      .map_err(|error| format!("Could not remove {}: {error}", local_path.display()))?;
  }

  Ok(true)
}

#[tauri::command]
async fn syncpeer_clear_cache(app: tauri::AppHandle) -> Result<(), String> {
  let files_root = app_cache_files_root(&app)?;
  if files_root.exists() {
    fs::remove_dir_all(&files_root)
      .map_err(|error| format!("Could not remove {}: {error}", files_root.display()))?;
  }

  let index_path = cache_index_path(&app)?;
  if index_path.exists() {
    fs::remove_file(&index_path)
      .map_err(|error| format!("Could not remove {}: {error}", index_path.display()))?;
  }

  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .manage(Arc::new(Mutex::new(TlsSessionStore::default())))
    .invoke_handler(tauri::generate_handler![
      syncpeer_read_text_file,
      syncpeer_read_default_cli_identity,
      syncpeer_tls_open,
      syncpeer_tls_read,
      syncpeer_tls_write,
      syncpeer_tls_close,
      syncpeer_log_ui_error,
      syncpeer_list_favorites,
      syncpeer_upsert_favorite,
      syncpeer_remove_favorite,
      syncpeer_cache_file,
      syncpeer_list_cached_files,
      syncpeer_get_cached_statuses,
      syncpeer_open_cached_file,
      syncpeer_remove_cached_file,
      syncpeer_clear_cache
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
