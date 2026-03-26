use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, ClientConnection, DigitallySignedStruct, SignatureScheme, StreamOwned};
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::{ErrorKind, Read, Write};
use std::net::IpAddr;
use std::net::{Shutdown, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use url::Url;
use x509_parser::extensions::ParsedExtension;
use x509_parser::prelude::parse_x509_certificate;

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
struct RelayOpenRequest {
    relay_address: String,
    expected_device_id: String,
    cert_pem: String,
    key_pem: String,
    ca_pem: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TlsOpenResponse {
    session_id: u64,
    peer_certificate_der: Vec<u8>,
    connected_via: Option<String>,
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
struct IdentityRecoveryExportResponse {
    device_id: String,
    recovery_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityRecoveryRestoreRequest {
    recovery_secret: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityRecoveryPayload {
    version: u8,
    device_id: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFetchRequest {
    url: String,
    method: String,
    headers: HashMap<String, String>,
    pin_server_device_id: Option<String>,
    allow_insecure_tls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DiscoveryFetchResponse {
    status: u16,
    body: String,
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

const RELAY_MAGIC: u32 = 0x9E79_BC40;
const RELAY_MESSAGE_TYPE_JOIN_SESSION_REQUEST: u32 = 3;
const RELAY_MESSAGE_TYPE_RESPONSE: u32 = 4;
const RELAY_MESSAGE_TYPE_CONNECT_REQUEST: u32 = 5;
const RELAY_MESSAGE_TYPE_SESSION_INVITATION: u32 = 6;

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

fn mask_pem_summary(label: &str, pem: &str) -> String {
    format!("{}Chars={}", label, pem.chars().count())
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

fn dns_name_matches(host: &str, pattern: &str) -> bool {
    let normalized_host = host.trim().trim_end_matches('.').to_ascii_lowercase();
    let normalized_pattern = pattern.trim().trim_end_matches('.').to_ascii_lowercase();
    if normalized_host.is_empty() || normalized_pattern.is_empty() {
        return false;
    }
    if let Some(suffix) = normalized_pattern.strip_prefix("*.") {
        if suffix.is_empty() || suffix.contains('*') {
            return false;
        }
        let expected_suffix = format!(".{suffix}");
        if !normalized_host.ends_with(&expected_suffix) {
            return false;
        }
        let prefix_len = normalized_host.len().saturating_sub(expected_suffix.len());
        let prefix = &normalized_host[..prefix_len];
        return !prefix.is_empty() && !prefix.contains('.');
    }
    normalized_host == normalized_pattern
}

fn strip_ipv6_brackets(host: &str) -> &str {
    if host.starts_with('[') && host.ends_with(']') && host.len() > 2 {
        &host[1..host.len() - 1]
    } else {
        host
    }
}

fn resolve_tls_hostname(host: &str) -> String {
    let normalized = strip_ipv6_brackets(host.trim());
    if normalized.parse::<IpAddr>().is_ok() {
        // Syncthing peers commonly present certs for "syncthing" rather than raw IP SANs.
        // Keep strict hostname verification by validating against this stable cert name.
        "syncthing".to_string()
    } else {
        normalized.to_string()
    }
}

fn ip_san_matches(host_ip: &IpAddr, ip_san: &[u8]) -> bool {
    match host_ip {
        IpAddr::V4(ipv4) => ip_san == ipv4.octets().as_slice(),
        IpAddr::V6(ipv6) => ip_san == ipv6.octets().as_slice(),
    }
}

fn verify_hostname_against_cert(cert_der: &[u8], host: &str) -> Result<(), String> {
    let normalized_host = strip_ipv6_brackets(host.trim()).trim_end_matches('.');
    if normalized_host.is_empty() {
        return Err("x509: missing TLS hostname".to_string());
    }

    let (_, cert) = parse_x509_certificate(cert_der)
        .map_err(|error| format!("x509: could not parse peer certificate: {error}"))?;
    let host_ip = normalized_host.parse::<IpAddr>().ok();

    let mut has_san = false;
    let mut dns_sans: Vec<String> = Vec::new();
    let mut ip_sans: Vec<Vec<u8>> = Vec::new();

    for extension in cert.extensions() {
        if let ParsedExtension::SubjectAlternativeName(san) = extension.parsed_extension() {
            has_san = true;
            for entry in &san.general_names {
                match entry {
                    x509_parser::extensions::GeneralName::DNSName(name) => {
                        let text = name.trim();
                        if !text.is_empty() {
                            dns_sans.push(text.to_string());
                        }
                    }
                    x509_parser::extensions::GeneralName::IPAddress(bytes) => {
                        ip_sans.push(bytes.to_vec());
                    }
                    _ => {}
                }
            }
        }
    }

    if let Some(ip) = host_ip {
        if ip_sans.iter().any(|candidate| ip_san_matches(&ip, candidate)) {
            return Ok(());
        }
        return Err(format!(
            "x509: certificate is not valid for IP {}",
            normalized_host
        ));
    }

    if dns_sans.iter().any(|candidate| dns_name_matches(normalized_host, candidate)) {
        return Ok(());
    }
    if has_san {
        let names = if dns_sans.is_empty() {
            "<no dns SAN entries>".to_string()
        } else {
            dns_sans.join(", ")
        };
        return Err(format!(
            "x509: certificate is valid for {}, not {}",
            names, normalized_host
        ));
    }

    let common_names: Vec<String> = cert
        .subject()
        .iter_common_name()
        .filter_map(|attribute| attribute.as_str().ok().map(|value| value.to_string()))
        .collect();
    if common_names
        .iter()
        .any(|candidate| dns_name_matches(normalized_host, candidate))
    {
        return Ok(());
    }
    if common_names.is_empty() {
        return Err(format!(
            "x509: certificate has no subjectAltName or commonName for {}",
            normalized_host
        ));
    }
    Err(format!(
        "x509: certificate is valid for {}, not {}",
        common_names.join(", "),
        normalized_host
    ))
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
    let raw = fs::read_to_string(path)
        .map_err(|error| format!("Could not read {}: {error}", path.display()))?;
    serde_json::from_str::<T>(&raw)
        .map_err(|error| format!("Could not parse {}: {error}", path.display()))
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Could not create {}: {error}", parent.display()))?;
    }
    let content = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Could not encode JSON: {error}"))?;
    let temp_path = path.with_extension("tmp");
    fs::write(&temp_path, content)
        .map_err(|error| format!("Could not write {}: {error}", temp_path.display()))?;
    fs::rename(&temp_path, path)
        .map_err(|error| format!("Could not rename {}: {error}", path.display()))
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

fn get_tls_session(
    store: &tauri::State<SharedTlsStore>,
    session_id: u64,
) -> Result<Arc<Mutex<TlsSession>>, String> {
    let guard = store
        .lock()
        .map_err(|_| "TLS session store lock poisoned".to_string())?;
    guard
        .sessions
        .get(&session_id)
        .cloned()
        .ok_or_else(|| format!("Unknown TLS session: {session_id}"))
}

fn load_identity_from_dir(cli_node_dir: &Path) -> Result<Option<CliNodeIdentityResponse>, String> {
    let cert_path = cli_node_dir.join("cert.pem");
    let key_path = cli_node_dir.join("key.pem");
    if !cert_path.exists() || !key_path.exists() {
        return Ok(None);
    }
    let cert_pem = fs::read_to_string(&cert_path)
        .map_err(|error| format!("Could not read {}: {error}", cert_path.display()))?;
    let key_pem = fs::read_to_string(&key_path)
        .map_err(|error| format!("Could not read {}: {error}", key_path.display()))?;
    if cert_pem.trim().is_empty() || key_pem.trim().is_empty() {
        return Ok(None);
    }
    Ok(Some(CliNodeIdentityResponse {
        cert_path: cert_path.to_string_lossy().to_string(),
        key_path: key_path.to_string_lossy().to_string(),
        cert_pem,
        key_pem,
    }))
}

fn create_identity_in_dir(cli_node_dir: &Path) -> Result<CliNodeIdentityResponse, String> {
    fs::create_dir_all(cli_node_dir)
        .map_err(|error| format!("Could not create {}: {error}", cli_node_dir.display()))?;
    let cert_path = cli_node_dir.join("cert.pem");
    let key_path = cli_node_dir.join("key.pem");

    let cert = rcgen::generate_simple_self_signed(vec![
        "syncpeer.local".to_string(),
        "localhost".to_string(),
        "syncthing".to_string(),
    ])
    .map_err(|error| format!("Could not generate self-signed certificate: {error}"))?;
    let cert_pem = cert
        .serialize_pem()
        .map_err(|error| format!("Could not serialize certificate PEM: {error}"))?;
    let key_pem = cert.serialize_private_key_pem();

    fs::write(&cert_path, &cert_pem)
        .map_err(|error| format!("Could not write {}: {error}", cert_path.display()))?;
    fs::write(&key_path, &key_pem)
        .map_err(|error| format!("Could not write {}: {error}", key_path.display()))?;

    Ok(CliNodeIdentityResponse {
        cert_path: cert_path.to_string_lossy().to_string(),
        key_path: key_path.to_string_lossy().to_string(),
        cert_pem,
        key_pem,
    })
}

fn resolve_default_identity_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if let Ok(path) = app.path().app_data_dir() {
        return Ok(path.join("syncpeer").join("cli-node"));
    }
    if let Ok(path) = app.path().app_config_dir() {
        return Ok(path.join("syncpeer").join("cli-node"));
    }
    if let Ok(path) = app.path().config_dir() {
        return Ok(path.join("syncpeer").join("cli-node"));
    }
    Err("Could not resolve a writable identity directory".to_string())
}

fn normalize_device_id(value: &str) -> String {
    value
        .chars()
        .filter(|ch| ch.is_ascii_uppercase() || ('2'..='7').contains(ch) || ch.is_ascii_lowercase())
        .map(|ch| ch.to_ascii_uppercase())
        .filter(|ch| ch.is_ascii_uppercase() || ('2'..='7').contains(ch))
        .collect()
}

fn canonical_device_id(value: &str) -> String {
    let normalized = normalize_device_id(value);
    if normalized.len() != 56 {
        return normalized;
    }
    let mut out = String::new();
    for (index, ch) in normalized.chars().enumerate() {
        let pos = index + 1;
        if pos % 14 == 0 {
            continue;
        }
        out.push(ch);
    }
    out
}

fn base32_no_padding(bytes: &[u8]) -> String {
    data_encoding::BASE32_NOPAD.encode(bytes)
}

fn compute_device_id_from_der(cert_der: &[u8]) -> String {
    let digest = Sha256::digest(cert_der);
    base32_no_padding(digest.as_slice())
}

fn parse_first_certificate_der(cert_pem: &str) -> Result<Vec<u8>, String> {
    let mut cert_reader = std::io::BufReader::new(cert_pem.as_bytes());
    let certs = rustls_pemfile::certs(&mut cert_reader)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Invalid certificate PEM: {error}"))?;
    let first = certs
        .first()
        .ok_or_else(|| "Certificate PEM did not contain any certificates".to_string())?;
    Ok(first.as_ref().to_vec())
}

fn decode_device_id_bytes(value: &str) -> Result<Vec<u8>, String> {
    let normalized = canonical_device_id(value);
    data_encoding::BASE32_NOPAD
        .decode(normalized.as_bytes())
        .map_err(|error| format!("Invalid device ID '{value}': {error}"))
}

fn xdr_pad_len(length: usize) -> usize {
    (4 - (length % 4)) % 4
}

fn xdr_write_opaque(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + bytes.len() + xdr_pad_len(bytes.len()));
    out.extend_from_slice(&(bytes.len() as u32).to_be_bytes());
    out.extend_from_slice(bytes);
    let pad = xdr_pad_len(bytes.len());
    if pad > 0 {
        out.extend_from_slice(&vec![0u8; pad]);
    }
    out
}

fn xdr_read_u32(payload: &[u8], offset: &mut usize) -> Result<u32, String> {
    if *offset + 4 > payload.len() {
        return Err("Relay message payload ended unexpectedly".to_string());
    }
    let value = u32::from_be_bytes([
        payload[*offset],
        payload[*offset + 1],
        payload[*offset + 2],
        payload[*offset + 3],
    ]);
    *offset += 4;
    Ok(value)
}

fn xdr_read_opaque(payload: &[u8], offset: &mut usize) -> Result<Vec<u8>, String> {
    let length = xdr_read_u32(payload, offset)? as usize;
    if *offset + length > payload.len() {
        return Err("Relay opaque field exceeded payload size".to_string());
    }
    let value = payload[*offset..*offset + length].to_vec();
    *offset += length;
    let pad = xdr_pad_len(length);
    if *offset + pad > payload.len() {
        return Err("Relay opaque field padding exceeded payload size".to_string());
    }
    *offset += pad;
    Ok(value)
}

fn relay_write_message<W: Write>(
    writer: &mut W,
    message_type: u32,
    payload: &[u8],
) -> Result<(), String> {
    let mut header = [0u8; 12];
    header[0..4].copy_from_slice(&RELAY_MAGIC.to_be_bytes());
    header[4..8].copy_from_slice(&message_type.to_be_bytes());
    header[8..12].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    writer
        .write_all(&header)
        .map_err(|error| format!("Relay write header failed: {error}"))?;
    writer
        .write_all(payload)
        .map_err(|error| format!("Relay write payload failed: {error}"))?;
    writer
        .flush()
        .map_err(|error| format!("Relay flush failed: {error}"))?;
    Ok(())
}

fn relay_read_message<R: Read>(reader: &mut R) -> Result<(u32, Vec<u8>), String> {
    let mut header = [0u8; 12];
    reader
        .read_exact(&mut header)
        .map_err(|error| format!("Relay read header failed: {error}"))?;
    let magic = u32::from_be_bytes([header[0], header[1], header[2], header[3]]);
    if magic != RELAY_MAGIC {
        return Err(format!("Unexpected relay magic 0x{magic:08X}"));
    }
    let message_type = u32::from_be_bytes([header[4], header[5], header[6], header[7]]);
    let length = u32::from_be_bytes([header[8], header[9], header[10], header[11]]) as usize;
    let mut payload = vec![0u8; length];
    if length > 0 {
        reader
            .read_exact(&mut payload)
            .map_err(|error| format!("Relay read payload failed: {error}"))?;
    }
    Ok((message_type, payload))
}

fn relay_parse_response(payload: &[u8]) -> Result<(u32, String), String> {
    let mut offset = 0usize;
    let code = xdr_read_u32(payload, &mut offset)?;
    let message_raw = xdr_read_opaque(payload, &mut offset)?;
    let message = String::from_utf8_lossy(&message_raw).to_string();
    Ok((code, message))
}

fn parse_ip_from_relay_address(address: &[u8]) -> Option<String> {
    if address.is_empty() || address.iter().all(|value| *value == 0) {
        return None;
    }
    if address.len() == 4 {
        return Some(format!(
            "{}.{}.{}.{}",
            address[0], address[1], address[2], address[3]
        ));
    }
    if address.len() == 16 {
        let mut octets = [0u8; 16];
        octets.copy_from_slice(address);
        return Some(std::net::Ipv6Addr::from(octets).to_string());
    }
    let text = String::from_utf8_lossy(address).trim().to_string();
    if text.is_empty() { None } else { Some(text) }
}

fn build_discovery_http_request(url: &Url, method: &str, headers: &HashMap<String, String>) -> String {
    let mut path = url.path().to_string();
    if path.is_empty() {
        path.push('/');
    }
    if let Some(query) = url.query() {
        path.push('?');
        path.push_str(query);
    }
    let mut lines = vec![
        format!("{method} {path} HTTP/1.1"),
        format!("Host: {}", url.host_str().unwrap_or_default()),
        "Accept: application/json".to_string(),
        "Connection: close".to_string(),
    ];
    for (key, value) in headers {
        lines.push(format!("{key}: {value}"));
    }
    lines.push(String::new());
    lines.push(String::new());
    lines.join("\r\n")
}

fn decode_chunked_body(body: &[u8]) -> Result<Vec<u8>, String> {
    let mut offset = 0usize;
    let mut out = Vec::new();
    while offset < body.len() {
        let remaining = &body[offset..];
        let Some(line_end) = remaining.windows(2).position(|window| window == b"\r\n") else {
            break;
        };
        let size_line = std::str::from_utf8(&remaining[..line_end])
            .map_err(|error| format!("Invalid chunk size line: {error}"))?;
        let size_hex = size_line.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|error| format!("Invalid chunk size '{size_hex}': {error}"))?;
        offset += line_end + 2;
        if size == 0 {
            break;
        }
        if offset + size > body.len() {
            return Err("Chunk body exceeds response size".to_string());
        }
        out.extend_from_slice(&body[offset..offset + size]);
        offset += size + 2;
    }
    Ok(out)
}

fn parse_http_response(raw: &[u8]) -> Result<DiscoveryFetchResponse, String> {
    let Some(header_end) = raw.windows(4).position(|window| window == b"\r\n\r\n") else {
        return Err("Malformed HTTP response from discovery server".to_string());
    };
    let header_text = std::str::from_utf8(&raw[..header_end])
        .map_err(|error| format!("Invalid HTTP response headers: {error}"))?;
    let mut lines = header_text.split("\r\n");
    let status_line = lines.next().unwrap_or("");
    let mut status_parts = status_line.split_whitespace();
    let _http_version = status_parts.next().unwrap_or("");
    let status = status_parts
        .next()
        .ok_or_else(|| format!("Malformed HTTP status line: {status_line}"))?
        .parse::<u16>()
        .map_err(|error| format!("Malformed HTTP status code: {error}"))?;
    let mut transfer_encoding = String::new();
    for line in lines {
        if let Some((key, value)) = line.split_once(':') {
            if key.trim().eq_ignore_ascii_case("transfer-encoding") {
                transfer_encoding = value.trim().to_ascii_lowercase();
            }
        }
    }
    let mut body = raw[header_end + 4..].to_vec();
    if transfer_encoding.contains("chunked") {
        body = decode_chunked_body(&body)?;
    }
    let body = String::from_utf8(body)
        .map_err(|error| format!("Discovery response body is not valid UTF-8: {error}"))?;
    Ok(DiscoveryFetchResponse { status, body })
}

fn read_all_from_stream(stream: &mut StreamOwned<ClientConnection, TcpStream>) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    loop {
        let mut buf = [0u8; 8192];
        match stream.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => bytes.extend_from_slice(&buf[..n]),
            Err(error) if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut => continue,
            Err(error) => return Err(format!("Discovery read failed: {error}")),
        }
    }
    Ok(bytes)
}

fn perform_pinned_discovery_request(request: &DiscoveryFetchRequest) -> Result<DiscoveryFetchResponse, String> {
    let url = Url::parse(&request.url).map_err(|error| format!("Invalid discovery URL: {error}"))?;
    let host = url
        .host_str()
        .ok_or_else(|| "Discovery URL missing host".to_string())?
        .to_string();
    let port = url.port_or_known_default().ok_or_else(|| "Discovery URL missing port".to_string())?;
    let address = format!("{host}:{port}");
    let tcp = TcpStream::connect(&address)
        .map_err(|error| format!("TCP connect to {address} failed: {error}"))?;
    tcp.set_read_timeout(Some(Duration::from_secs(15)))
        .map_err(|error| format!("Could not set read timeout: {error}"))?;
    let config = ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
        .with_no_client_auth();
    let server_name = ServerName::try_from(host.clone())
        .map_err(|error| format!("Invalid TLS host '{host}': {error}"))?;
    let connection = ClientConnection::new(Arc::new(config), server_name)
        .map_err(|error| format!("Could not create TLS client: {error}"))?;
    let mut stream = StreamOwned::new(connection, tcp);
    {
        let (conn, sock) = (&mut stream.conn, &mut stream.sock);
        conn.complete_io(sock)
            .map_err(|error| format!("Pinned discovery TLS connect failed: {error}"))?;
    }

    if let Some(expected_server_id) = request.pin_server_device_id.as_ref() {
        let peer_der = stream
            .conn
            .peer_certificates()
            .and_then(|certs| certs.first())
            .map(|cert| cert.as_ref().to_vec())
            .ok_or_else(|| "Discovery server certificate missing".to_string())?;
        let got = canonical_device_id(&compute_device_id_from_der(&peer_der));
        let want = canonical_device_id(expected_server_id);
        if got != want {
            return Err(format!(
                "Discovery server certificate ID mismatch: expected {expected_server_id}, got {got}"
            ));
        }
    }

    let request_text = build_discovery_http_request(
        &url,
        if request.method.trim().is_empty() { "GET" } else { &request.method },
        &request.headers,
    );
    stream
        .write_all(request_text.as_bytes())
        .map_err(|error| format!("Discovery write failed: {error}"))?;
    stream
        .flush()
        .map_err(|error| format!("Discovery flush failed: {error}"))?;
    let raw = read_all_from_stream(&mut stream)?;
    parse_http_response(&raw)
}

fn perform_ca_validated_discovery_request(
    request: &DiscoveryFetchRequest,
) -> Result<DiscoveryFetchResponse, String> {
    let method = if request.method.trim().is_empty() {
        reqwest::Method::GET
    } else {
        reqwest::Method::from_bytes(request.method.trim().as_bytes())
            .map_err(|error| format!("Invalid discovery HTTP method '{}': {error}", request.method))?
    };

    let client = reqwest::blocking::Client::builder()
        .use_rustls_tls()
        .https_only(true)
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|error| format!("Could not build discovery HTTP client: {error}"))?;

    let mut builder = client.request(method, &request.url);
    for (key, value) in &request.headers {
        builder = builder.header(key, value);
    }

    let response = builder
        .send()
        .map_err(|error| format!("CA-validated discovery fetch failed: {error}"))?;
    let status = response.status().as_u16();
    let body = response
        .text()
        .map_err(|error| format!("Could not read discovery response body: {error}"))?;

    Ok(DiscoveryFetchResponse { status, body })
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
    let mut existing_candidate_dirs: Vec<PathBuf> = Vec::new();
    if let Ok(path) = app.path().config_dir() {
        existing_candidate_dirs.push(path.join("syncpeer").join("cli-node"));
    }
    if let Ok(path) = app.path().app_config_dir() {
        existing_candidate_dirs.push(path.join("syncpeer").join("cli-node"));
    }
    if let Ok(path) = app.path().app_data_dir() {
        existing_candidate_dirs.push(path.join("syncpeer").join("cli-node"));
    }
    existing_candidate_dirs.dedup();

    for cli_node_dir in existing_candidate_dirs.iter() {
        if let Some(identity) = load_identity_from_dir(cli_node_dir)? {
            return Ok(identity);
        }
    }

    let mut create_targets: Vec<PathBuf> = Vec::new();
    if let Ok(path) = app.path().app_data_dir() {
        create_targets.push(path.join("syncpeer").join("cli-node"));
    }
    if let Ok(path) = app.path().app_config_dir() {
        create_targets.push(path.join("syncpeer").join("cli-node"));
    }
    if let Ok(path) = app.path().config_dir() {
        create_targets.push(path.join("syncpeer").join("cli-node"));
    }
    create_targets.dedup();

    for cli_node_dir in create_targets.iter() {
        match create_identity_in_dir(cli_node_dir) {
            Ok(identity) => return Ok(identity),
            Err(error) => {
                tauri_log(&format!(
                    "identity.auto_create.failed dir={} error={}",
                    cli_node_dir.display(),
                    error
                ));
            }
        }
    }

    let searched = existing_candidate_dirs
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    let attempted = create_targets
        .iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");

    Err(format!(
        "Missing cert/key and auto-create failed. Looked in: {searched}. Create attempts: {attempted}"
    ))
}

#[tauri::command]
async fn syncpeer_export_identity_recovery(
    app: tauri::AppHandle,
) -> Result<IdentityRecoveryExportResponse, String> {
    let identity = syncpeer_read_default_cli_identity(app).await?;
    let cert_der = parse_first_certificate_der(&identity.cert_pem)?;
    let device_id = canonical_device_id(&compute_device_id_from_der(&cert_der));
    let payload = IdentityRecoveryPayload {
        version: 1,
        device_id: device_id.clone(),
        cert_pem: identity.cert_pem,
        key_pem: identity.key_pem,
    };
    let json = serde_json::to_vec(&payload)
        .map_err(|error| format!("Could not encode recovery payload: {error}"))?;
    Ok(IdentityRecoveryExportResponse {
        device_id,
        recovery_secret: data_encoding::BASE64.encode(&json),
    })
}

#[tauri::command]
async fn syncpeer_restore_identity_recovery(
    app: tauri::AppHandle,
    request: IdentityRecoveryRestoreRequest,
) -> Result<CliNodeIdentityResponse, String> {
    let raw = request.recovery_secret.trim();
    if raw.is_empty() {
        return Err("Recovery secret is empty.".to_string());
    }
    let bytes = data_encoding::BASE64
        .decode(raw.as_bytes())
        .map_err(|error| format!("Recovery secret is not valid base64: {error}"))?;
    let payload: IdentityRecoveryPayload = serde_json::from_slice(&bytes)
        .map_err(|error| format!("Recovery secret payload is invalid JSON: {error}"))?;
    if payload.version != 1 {
        return Err(format!(
            "Unsupported recovery payload version: {}",
            payload.version
        ));
    }
    let cert_der = parse_first_certificate_der(&payload.cert_pem)?;
    let computed_device_id = canonical_device_id(&compute_device_id_from_der(&cert_der));
    let expected_device_id = canonical_device_id(&payload.device_id);
    if computed_device_id != expected_device_id {
        return Err(format!(
            "Recovery payload device ID mismatch: payload={}, cert={}",
            expected_device_id, computed_device_id
        ));
    }

    let identity_dir = resolve_default_identity_dir(&app)?;
    fs::create_dir_all(&identity_dir)
        .map_err(|error| format!("Could not create {}: {error}", identity_dir.display()))?;
    let cert_path = identity_dir.join("cert.pem");
    let key_path = identity_dir.join("key.pem");
    fs::write(&cert_path, &payload.cert_pem)
        .map_err(|error| format!("Could not write {}: {error}", cert_path.display()))?;
    fs::write(&key_path, &payload.key_pem)
        .map_err(|error| format!("Could not write {}: {error}", key_path.display()))?;

    Ok(CliNodeIdentityResponse {
        cert_path: cert_path.display().to_string(),
        key_path: key_path.display().to_string(),
        cert_pem: payload.cert_pem,
        key_pem: payload.key_pem,
    })
}

#[tauri::command]
async fn syncpeer_discovery_fetch(
    request: DiscoveryFetchRequest,
) -> Result<DiscoveryFetchResponse, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if request.pin_server_device_id.is_some() || request.allow_insecure_tls {
            return perform_pinned_discovery_request(&request);
        }
        perform_ca_validated_discovery_request(&request)
    })
    .await
    .map_err(|error| format!("Discovery fetch task join error: {error}"))?
}

#[tauri::command]
async fn syncpeer_tls_open(
    store: tauri::State<'_, SharedTlsStore>,
    request: TlsOpenRequest,
) -> Result<TlsOpenResponse, String> {
    let shared_store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let address = format!("{}:{}", request.host, request.port);
        let tls_host = resolve_tls_hostname(&request.host);
        tauri_log(&format!(
            "tls.open.start address={} tlsHost={} {} {}",
            address,
            tls_host,
            mask_pem_summary("cert", &request.cert_pem),
            mask_pem_summary("key", &request.key_pem)
        ));

        let mut cert_reader = std::io::BufReader::new(request.cert_pem.as_bytes());
        let cert_chain = rustls_pemfile::certs(&mut cert_reader)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Invalid client certificate PEM: {error}"))?;
        if cert_chain.is_empty() {
            return Err("Client certificate PEM did not contain any certificate".to_string());
        }
        tauri_log(&format!(
            "tls.open.cert_parsed address={} certChainLen={}",
            address,
            cert_chain.len()
        ));

        let mut key_reader = std::io::BufReader::new(request.key_pem.as_bytes());
        let private_key = rustls_pemfile::private_key(&mut key_reader)
            .map_err(|error| format!("Invalid client private key PEM: {error}"))?
            .ok_or_else(|| "Client key PEM did not contain a private key".to_string())?;
        tauri_log(&format!("tls.open.key_parsed address={}", address));

        let config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
            .with_client_auth_cert(cert_chain, private_key)
            .map_err(|error| format!("Invalid client cert/key pair: {error}"))?;
        let config = Arc::new(config);

        tauri_log(&format!("tls.open.tcp_connect.start address={}", address));
        let tcp = TcpStream::connect(&address)
            .map_err(|error| format!("TCP connect to {address} failed: {error}"))?;
        tcp.set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("Could not set TLS read timeout: {error}"))?;
        tcp.set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("Could not set TLS write timeout: {error}"))?;
        tauri_log(&format!("tls.open.tcp_connect.done address={}", address));

        let server_name = ServerName::try_from(tls_host.clone())
            .map_err(|error| format!("Invalid TLS host '{}': {error}", tls_host))?;
        let connection = ClientConnection::new(config, server_name)
            .map_err(|error| format!("Could not create TLS client: {error}"))?;
        let mut stream = StreamOwned::new(connection, tcp);
        tauri_log(&format!("tls.open.handshake.start address={}", address));
        {
            let (conn, sock) = (&mut stream.conn, &mut stream.sock);
            conn.complete_io(sock)
                .map_err(|error| format!("TLS connect to {address} failed: {error}"))?;
        }
        tauri_log(&format!("tls.open.handshake.done address={}", address));
        let peer_certificate_der = stream
            .conn
            .peer_certificates()
            .and_then(|certs| certs.first())
            .map(|cert| cert.as_ref().to_vec())
            .ok_or_else(|| "Peer certificate missing".to_string())?;
        verify_hostname_against_cert(&peer_certificate_der, &tls_host)?;
        let peer_device_id = canonical_device_id(&compute_device_id_from_der(&peer_certificate_der));
        tauri_log(&format!(
            "tls.open.peer_cert address={} peerCertBytes={} peerDeviceId={}",
            address,
            peer_certificate_der.len(),
            peer_device_id
        ));

        let mut guard = shared_store
            .lock()
            .map_err(|_| "TLS session store lock poisoned".to_string())?;
        let next_id = guard.next_id.saturating_add(1).max(1);
        guard.next_id = next_id;
        guard
            .sessions
            .insert(next_id, Arc::new(Mutex::new(TlsSession { stream })));
        tauri_log(&format!("tls.open.ready address={} sessionId={}", address, next_id));
        Ok(TlsOpenResponse {
            session_id: next_id,
            peer_certificate_der,
            connected_via: None,
        })
    })
    .await
    .map_err(|error| format!("TLS open task join error: {error}"))?
}

#[tauri::command]
async fn syncpeer_relay_open(
    store: tauri::State<'_, SharedTlsStore>,
    request: RelayOpenRequest,
) -> Result<TlsOpenResponse, String> {
    let shared_store = store.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let relay_url = Url::parse(&request.relay_address)
            .map_err(|error| format!("Invalid relay address '{}': {error}", request.relay_address))?;
        if relay_url.scheme() != "relay" {
            return Err(format!(
                "Relay address must use relay:// scheme, got {}",
                relay_url.scheme()
            ));
        }
        let relay_host = relay_url
            .host_str()
            .ok_or_else(|| "Relay address is missing host".to_string())?
            .to_string();
        let relay_port = relay_url.port().unwrap_or(22067);
        let relay_server_id = relay_url
            .query_pairs()
            .find(|(key, _)| key == "id")
            .map(|(_, value)| value.to_string());

        tauri_log(&format!(
            "relay.open.start relay={} expectedDeviceId={}",
            request.relay_address, request.expected_device_id
        ));

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

        let mut relay_config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
            .with_client_auth_cert(cert_chain.clone(), private_key.clone_key())
            .map_err(|error| format!("Invalid client cert/key pair: {error}"))?;
        relay_config.alpn_protocols = vec![b"bep-relay".to_vec()];
        let relay_config = Arc::new(relay_config);

        let relay_address = format!("{relay_host}:{relay_port}");
        let relay_tcp = TcpStream::connect(&relay_address)
            .map_err(|error| format!("Relay TCP connect to {relay_address} failed: {error}"))?;
        relay_tcp
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("Could not set relay read timeout: {error}"))?;
        relay_tcp
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("Could not set relay write timeout: {error}"))?;
        let relay_server_name = ServerName::try_from(relay_host.clone())
            .or_else(|_| ServerName::try_from("relay.local".to_string()))
            .map_err(|error| format!("Invalid relay TLS host '{relay_host}': {error}"))?;
        let relay_connection = ClientConnection::new(relay_config, relay_server_name)
            .map_err(|error| format!("Could not create relay TLS client: {error}"))?;
        let mut relay_stream = StreamOwned::new(relay_connection, relay_tcp);
        {
            let (conn, sock) = (&mut relay_stream.conn, &mut relay_stream.sock);
            conn.complete_io(sock)
                .map_err(|error| format!("Relay TLS handshake failed: {error}"))?;
        }

        if let Some(expected_relay_id) = relay_server_id.as_deref() {
            let relay_peer_der = relay_stream
                .conn
                .peer_certificates()
                .and_then(|certs| certs.first())
                .map(|cert| cert.as_ref().to_vec())
                .ok_or_else(|| "Relay certificate missing".to_string())?;
            let got = canonical_device_id(&compute_device_id_from_der(&relay_peer_der));
            let want = canonical_device_id(expected_relay_id);
            if got != want {
                return Err(format!(
                    "Relay certificate ID mismatch: expected {expected_relay_id}, got {got}"
                ));
            }
        }

        let target_device_id = decode_device_id_bytes(&request.expected_device_id)?;
        relay_write_message(
            &mut relay_stream,
            RELAY_MESSAGE_TYPE_CONNECT_REQUEST,
            &xdr_write_opaque(&target_device_id),
        )?;
        let (message_type, payload) = relay_read_message(&mut relay_stream)?;
        if message_type == RELAY_MESSAGE_TYPE_RESPONSE {
            let (code, message) = relay_parse_response(&payload)?;
            return Err(format!(
                "Relay connect request failed (code {code}): {}",
                if message.is_empty() {
                    "no message".to_string()
                } else {
                    message
                }
            ));
        }
        if message_type != RELAY_MESSAGE_TYPE_SESSION_INVITATION {
            return Err(format!(
                "Unexpected relay response type {message_type}, expected SessionInvitation"
            ));
        }

        let mut invitation_offset = 0usize;
        let _from = xdr_read_opaque(&payload, &mut invitation_offset)?;
        let session_key = xdr_read_opaque(&payload, &mut invitation_offset)?;
        let relay_session_address = xdr_read_opaque(&payload, &mut invitation_offset)?;
        let session_port = xdr_read_u32(&payload, &mut invitation_offset)? as u16;
        let server_socket = xdr_read_u32(&payload, &mut invitation_offset)?;
        if server_socket != 0 {
            return Err(
                "Relay invitation requested server-socket mode, which is not implemented yet"
                    .to_string(),
            );
        }

        let session_host = parse_ip_from_relay_address(&relay_session_address).unwrap_or(relay_host);
        let session_port = if session_port == 0 { relay_port } else { session_port };
        let relay_session_endpoint = format!("{session_host}:{session_port}");
        tauri_log(&format!(
            "relay.open.session endpoint={} keyLen={}",
            relay_session_endpoint,
            session_key.len()
        ));

        let session_tcp = TcpStream::connect(&relay_session_endpoint).map_err(|error| {
            format!("Relay session TCP connect to {relay_session_endpoint} failed: {error}")
        })?;
        session_tcp
            .set_read_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("Could not set relay session read timeout: {error}"))?;
        session_tcp
            .set_write_timeout(Some(Duration::from_secs(10)))
            .map_err(|error| format!("Could not set relay session write timeout: {error}"))?;

        let mut relay_session_socket = session_tcp;
        relay_write_message(
            &mut relay_session_socket,
            RELAY_MESSAGE_TYPE_JOIN_SESSION_REQUEST,
            &xdr_write_opaque(&session_key),
        )?;
        let (join_type, join_payload) = relay_read_message(&mut relay_session_socket)?;
        if join_type != RELAY_MESSAGE_TYPE_RESPONSE {
            return Err(format!(
                "Unexpected relay session response type {join_type}, expected Response"
            ));
        }
        let (join_code, join_message) = relay_parse_response(&join_payload)?;
        if join_code != 0 {
            return Err(format!(
                "Relay join session failed (code {join_code}): {}",
                if join_message.is_empty() {
                    "no message".to_string()
                } else {
                    join_message
                }
            ));
        }

        let mut bep_config = ClientConfig::builder()
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(NoCertificateVerification))
            .with_client_auth_cert(cert_chain, private_key)
            .map_err(|error| format!("Invalid BEP client cert/key pair: {error}"))?;
        bep_config.alpn_protocols = vec![b"bep/1.0".to_vec()];
        let bep_config = Arc::new(bep_config);
        let bep_server_name = ServerName::try_from(session_host.clone())
            .or_else(|_| ServerName::try_from("peer.local".to_string()))
            .map_err(|error| format!("Invalid relay peer TLS host '{session_host}': {error}"))?;
        let bep_connection = ClientConnection::new(bep_config, bep_server_name)
            .map_err(|error| format!("Could not create relay BEP TLS client: {error}"))?;
        let mut bep_stream = StreamOwned::new(bep_connection, relay_session_socket);
        {
            let (conn, sock) = (&mut bep_stream.conn, &mut bep_stream.sock);
            conn.complete_io(sock)
                .map_err(|error| format!("Relay BEP TLS handshake failed: {error}"))?;
        }
        let peer_certificate_der = bep_stream
            .conn
            .peer_certificates()
            .and_then(|certs| certs.first())
            .map(|cert| cert.as_ref().to_vec())
            .ok_or_else(|| "Relay BEP peer certificate missing".to_string())?;
        let peer_device_id = canonical_device_id(&compute_device_id_from_der(&peer_certificate_der));
        tauri_log(&format!(
            "relay.open.peer_cert endpoint={} peerDeviceId={}",
            relay_session_endpoint, peer_device_id
        ));

        let mut guard = shared_store
            .lock()
            .map_err(|_| "TLS session store lock poisoned".to_string())?;
        let next_id = guard.next_id.saturating_add(1).max(1);
        guard.next_id = next_id;
        guard.sessions.insert(
            next_id,
            Arc::new(Mutex::new(TlsSession { stream: bep_stream })),
        );
        Ok(TlsOpenResponse {
            session_id: next_id,
            peer_certificate_der,
            connected_via: Some(format!(
                "relay://{}:{} -> {}",
                relay_url.host_str().unwrap_or(""),
                relay_port,
                relay_session_endpoint
            )),
        })
    })
    .await
    .map_err(|error| format!("Relay open task join error: {error}"))?
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
            Err(error)
                if error.kind() == ErrorKind::WouldBlock || error.kind() == ErrorKind::TimedOut =>
            {
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
        entry.event, entry.details
    ));
    Ok(())
}

#[tauri::command]
async fn syncpeer_list_favorites(app: tauri::AppHandle) -> Result<Vec<FavoriteItemRecord>, String> {
    let path = favorites_path(&app)?;
    let mut store = read_json_or_default::<FavoritesStore>(&path)?;
    store
        .favorites
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
    store
        .favorites
        .sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
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
    let file_name_seed = format!(
        "{}|{}|{}",
        request.folder_id.trim(),
        normalized_path,
        sanitize_name(&request.name)
    );
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
    fs::create_dir_all(&cache_root).map_err(|error| {
        format!(
            "Could not create cache root {}: {error}",
            cache_root.display()
        )
    })?;
    let local_path = cache_root.join(local_file_name);
    fs::write(&local_path, &request.bytes).map_err(|error| {
        format!(
            "Could not write cached file {}: {error}",
            local_path.display()
        )
    })?;

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
async fn syncpeer_list_cached_files(
    app: tauri::AppHandle,
) -> Result<Vec<CachedFileRecord>, String> {
    let path = cache_index_path(&app)?;
    let mut index = read_json_or_default::<CacheIndex>(&path)?;
    index.files.sort_by(|a, b| {
        b.cached_at_ms
            .cmp(&a.cached_at_ms)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
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
            syncpeer_export_identity_recovery,
            syncpeer_restore_identity_recovery,
            syncpeer_discovery_fetch,
            syncpeer_tls_open,
            syncpeer_relay_open,
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
