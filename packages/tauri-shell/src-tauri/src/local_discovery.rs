//! Persistent LAN discovery runtime for desktop and Android runtimes.
//!
//! Syncthing broadcasts a standard announcement on UDP 21027 every 30
//! seconds and answers an unknown device immediately. Syncpeer peers answer
//! the probe protocol on UDP 21037. Short scan windows miss most of those
//! packets, so one runtime owns both socket pairs for the whole process
//! lifetime, records every announcement in a small cache, and answers
//! discovery queries from that cache. A query timeout only waits for the
//! first matching candidate.

use super::{
    base32_no_padding, canonical_device_id, now_ms, LOCAL_DISCOVERY_MAGIC, LOCAL_DISCOVERY_PORT,
    SYNCPEER_DISCOVERY_KIND_PROBE, SYNCPEER_DISCOVERY_KIND_REPLY, SYNCPEER_DISCOVERY_MAGIC,
    SYNCPEER_DISCOVERY_PORT, SYNCPEER_SYNC_PORT,
};
use prost::Message;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use socket2::{Domain, Protocol, Socket, Type};
use std::collections::HashMap;
use std::io::ErrorKind;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, UdpSocket};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Condvar, Mutex, MutexGuard, OnceLock,
};
use std::thread;
use std::time::{Duration, Instant};
use url::Url;

/// Syncthing keeps a local discovery cache for three announce intervals.
const LOCAL_DISCOVERY_CACHE_LIFETIME: Duration = Duration::from_secs(120);
/// How often another Syncpeer instance is asked to identify itself.
const SYNCPEER_PROBE_INTERVAL: Duration = Duration::from_secs(3);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryLocalRequest {
    pub(crate) expected_device_id: Option<String>,
    pub(crate) timeout_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryLocalCandidate {
    pub(crate) address: String,
    pub(crate) protocol: String,
    pub(crate) host: Option<String>,
    pub(crate) port: Option<u16>,
    pub(crate) device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryLocalResponse {
    pub(crate) candidates: Vec<DiscoveryLocalCandidate>,
    pub(crate) diagnostics: DiscoveryLocalDiagnostics,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DiscoveryLocalDiagnostics {
    pub(crate) timeout_ms: u64,
    pub(crate) sockets_bound: usize,
    pub(crate) bind_errors: Vec<String>,
    pub(crate) packets_received: u64,
    pub(crate) packets_by_socket_udp4: u64,
    pub(crate) packets_by_socket_udp6: u64,
    pub(crate) packets_magic_mismatch: u64,
    pub(crate) packets_decode_failed: u64,
    pub(crate) packets_missing_id: u64,
    pub(crate) packets_filtered_expected_id: u64,
    pub(crate) announcements_accepted: u64,
    pub(crate) discovered_device_ids: Vec<String>,
    pub(crate) syncthing_lan_available: bool,
    pub(crate) syncpeer_lan_active: bool,
    pub(crate) status_message: String,
}

#[derive(Clone, PartialEq, Message)]
pub(crate) struct LocalDiscoveryAnnounce {
    #[prost(bytes = "vec", tag = "1")]
    pub(crate) id: Vec<u8>,
    #[prost(string, repeated, tag = "2")]
    pub(crate) addresses: Vec<String>,
    #[prost(int64, tag = "3")]
    pub(crate) instance_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncpeerProbePacket {
    pub(crate) version: u8,
    pub(crate) request_id: String,
    /// Older peers omit this field; it lets the sender recognize a probe that
    /// the local host received back instead of answering its own broadcast.
    #[serde(default)]
    pub(crate) origin: Option<String>,
    #[serde(default)]
    pub(crate) device_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SyncpeerReplyPacket {
    pub(crate) version: u8,
    pub(crate) request_id: String,
    pub(crate) device_id: Option<String>,
    pub(crate) port: u16,
}

/// Overridable discovery ports keep tests independent of a running app.
#[derive(Debug, Clone, Copy)]
pub(crate) struct LocalDiscoveryPorts {
    pub(crate) syncthing: u16,
    pub(crate) syncpeer: u16,
}

impl Default for LocalDiscoveryPorts {
    fn default() -> Self {
        Self {
            syncthing: LOCAL_DISCOVERY_PORT,
            syncpeer: SYNCPEER_DISCOVERY_PORT,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
struct DiscoveryCounters {
    packets_received: u64,
    packets_by_socket_udp4: u64,
    packets_by_socket_udp6: u64,
    packets_magic_mismatch: u64,
    packets_decode_failed: u64,
    packets_missing_id: u64,
    packets_filtered_expected_id: u64,
    announcements_accepted: u64,
}

#[derive(Debug, Clone)]
struct CachedCandidate {
    candidate: DiscoveryLocalCandidate,
    last_seen: Instant,
}

#[derive(Default)]
struct LocalDiscoveryState {
    candidates: HashMap<String, CachedCandidate>,
    counters: DiscoveryCounters,
    bind_errors: Vec<String>,
    syncthing_sockets: usize,
    syncpeer_sockets: usize,
    probe_request_id: Option<String>,
    local_device_id: Option<String>,
    sync_port: Option<u16>,
    origin_token: String,
}

type UdpSocketPair = Vec<(&'static str, UdpSocket)>;

pub(crate) struct LocalDiscoveryRuntime {
    state: Mutex<LocalDiscoveryState>,
    updated: Condvar,
    stop: Arc<AtomicBool>,
}

impl LocalDiscoveryRuntime {
    /// Bind both discovery port pairs and keep them open for the process.
    pub(crate) fn start(ports: LocalDiscoveryPorts) -> Arc<Self> {
        Self::start_with_prober(ports, true)
    }

    fn start_with_prober(ports: LocalDiscoveryPorts, probe: bool) -> Arc<Self> {
        let runtime = Arc::new(Self {
            state: Mutex::new(LocalDiscoveryState {
                origin_token: discovery_origin_token(),
                ..LocalDiscoveryState::default()
            }),
            updated: Condvar::new(),
            stop: Arc::new(AtomicBool::new(false)),
        });
        let (syncthing_sockets, mut bind_errors) = bind_socket_pair(ports.syncthing, false, "");
        let (syncpeer_sockets, syncpeer_errors) =
            bind_socket_pair(ports.syncpeer, true, "syncpeer ");
        bind_errors.extend(syncpeer_errors);
        {
            let mut state = runtime.lock_state();
            state.syncthing_sockets = syncthing_sockets.len();
            state.syncpeer_sockets = syncpeer_sockets.len();
            state.bind_errors = bind_errors;
        }
        let syncthing_sockets = Arc::new(syncthing_sockets);
        let syncpeer_sockets = Arc::new(syncpeer_sockets);
        runtime.start_syncthing_receiver(Arc::clone(&syncthing_sockets));
        runtime.start_syncpeer_receiver(Arc::clone(&syncpeer_sockets));
        if probe {
            runtime.start_prober(syncpeer_sockets, ports.syncpeer);
        }
        runtime
    }

    /// Remember the local identity so probe replies can be tagged.
    pub(crate) fn set_local_device_id(&self, device_id: &str) {
        let canonical = canonical_device_id(device_id);
        if canonical.is_empty() {
            return;
        }
        let mut state = self.lock_state();
        if state.local_device_id.is_none() {
            state.local_device_id = Some(canonical);
        }
    }

    pub(crate) fn has_local_device_id(&self) -> bool {
        self.lock_state().local_device_id.is_some()
    }

    /// Remember the bound TLS listener port so probe replies advertise a
    /// dialable address instead of the protocol default.
    pub(crate) fn set_sync_port(&self, port: u16) {
        if port == 0 {
            return;
        }
        self.lock_state().sync_port = Some(port);
    }

    /// Return fresh cached candidates, waiting up to the requested timeout
    /// for the first matching one.
    pub(crate) fn query(&self, request: &DiscoveryLocalRequest) -> DiscoveryLocalResponse {
        let expected = request
            .expected_device_id
            .as_deref()
            .map(canonical_device_id)
            .unwrap_or_default();
        let timeout_ms = request.timeout_ms.unwrap_or(1200).min(30_000);
        let deadline = Instant::now() + Duration::from_millis(timeout_ms);
        let mut state = self.lock_state();
        let candidates = loop {
            let now = Instant::now();
            let fresh = collect_fresh_candidates(&mut state, now, &expected);
            if !fresh.is_empty() || now >= deadline {
                break fresh;
            }
            let remaining = deadline.saturating_duration_since(now);
            state = self
                .updated
                .wait_timeout(state, remaining)
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .0;
        };
        build_response(&state, timeout_ms, candidates)
    }

    fn lock_state(&self) -> MutexGuard<'_, LocalDiscoveryState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record_packet(&self, socket_type: &'static str) -> MutexGuard<'_, LocalDiscoveryState> {
        let mut state = self.lock_state();
        state.counters.packets_received += 1;
        if socket_type == "udp4" {
            state.counters.packets_by_socket_udp4 += 1;
        } else {
            state.counters.packets_by_socket_udp6 += 1;
        }
        state
    }

    fn start_syncthing_receiver(self: &Arc<Self>, sockets: Arc<UdpSocketPair>) {
        let runtime = Arc::clone(self);
        let _ = thread::Builder::new()
            .name("syncpeer-discovery-syncthing".to_string())
            .spawn(move || {
                let mut buffer = vec![0_u8; 65536];
                while !runtime.stop.load(Ordering::Acquire) {
                    for (label, socket) in sockets.iter() {
                        match socket.recv_from(&mut buffer) {
                            Ok((size, source)) => {
                                runtime.handle_announcement(label, &buffer[..size], source);
                            }
                            Err(error) if poll_error(&error) => {}
                            Err(_) => {}
                        }
                    }
                }
            });
    }

    fn start_syncpeer_receiver(self: &Arc<Self>, sockets: Arc<UdpSocketPair>) {
        let runtime = Arc::clone(self);
        let _ = thread::Builder::new()
            .name("syncpeer-discovery-syncpeer".to_string())
            .spawn(move || {
                let mut buffer = vec![0_u8; 65536];
                while !runtime.stop.load(Ordering::Acquire) {
                    for (label, socket) in sockets.iter() {
                        match socket.recv_from(&mut buffer) {
                            Ok((size, source)) => {
                                runtime.handle_syncpeer_packet(
                                    socket,
                                    label,
                                    &buffer[..size],
                                    source,
                                );
                            }
                            Err(error) if poll_error(&error) => {}
                            Err(_) => {}
                        }
                    }
                }
            });
    }

    fn start_prober(self: &Arc<Self>, sockets: Arc<UdpSocketPair>, port: u16) {
        let runtime = Arc::clone(self);
        let _ = thread::Builder::new()
            .name("syncpeer-discovery-probe".to_string())
            .spawn(move || {
                while !runtime.stop.load(Ordering::Acquire) {
                    let request_id = format!("{}-{}", now_ms(), std::process::id());
                    let (origin_token, local_device_id) = {
                        let mut state = runtime.lock_state();
                        state.probe_request_id = Some(request_id.clone());
                        (state.origin_token.clone(), state.local_device_id.clone())
                    };
                    send_syncpeer_probe(
                        &sockets,
                        &request_id,
                        &origin_token,
                        local_device_id.as_deref(),
                        port,
                    );
                    sleep_until_stopped(&runtime.stop, SYNCPEER_PROBE_INTERVAL);
                }
            });
    }

    fn handle_announcement(&self, socket_type: &'static str, packet: &[u8], source: SocketAddr) {
        let mut state = self.record_packet(socket_type);
        let Some(announce) = decode_announcement(packet, &mut state.counters) else {
            return;
        };
        let device_id = canonical_device_id(&base32_no_padding(&announce.id));
        let source_ip = source.ip().to_string();
        let mut stored = false;
        for address in announce.addresses {
            let Some(normalized) = normalize_local_discovery_address(&address, &source_ip) else {
                continue;
            };
            let Some(candidate) = parse_local_discovery_candidate(&normalized, Some(&device_id))
            else {
                continue;
            };
            state.candidates.insert(
                candidate.address.clone(),
                CachedCandidate {
                    candidate,
                    last_seen: Instant::now(),
                },
            );
            stored = true;
        }
        state.counters.announcements_accepted += 1;
        drop(state);
        if stored {
            self.updated.notify_all();
        }
    }

    fn handle_syncpeer_packet(
        &self,
        socket: &UdpSocket,
        socket_type: &'static str,
        packet: &[u8],
        source: SocketAddr,
    ) {
        let mut state = self.record_packet(socket_type);
        let Some((kind, body)) = parse_syncpeer_packet(packet) else {
            state.counters.packets_magic_mismatch += 1;
            return;
        };
        if kind == SYNCPEER_DISCOVERY_KIND_PROBE {
            let reply = match serde_json::from_slice::<SyncpeerProbePacket>(body) {
                Ok(probe) if probe.version == 1 => {
                    if probe.origin.as_deref() == Some(state.origin_token.as_str()) {
                        // The local host received its own broadcast back.
                        state.counters.packets_filtered_expected_id += 1;
                        return;
                    }
                    let sender_id = probe
                        .device_id
                        .as_deref()
                        .map(canonical_device_id)
                        .unwrap_or_default();
                    if !sender_id.is_empty()
                        && state.local_device_id.as_deref() == Some(sender_id.as_str())
                    {
                        // Some systems loop a host's own broadcast back to its sockets.
                        return;
                    }
                    SyncpeerReplyPacket {
                        version: 1,
                        request_id: probe.request_id,
                        device_id: state.local_device_id.clone(),
                        port: state.sync_port.unwrap_or(SYNCPEER_SYNC_PORT),
                    }
                }
                _ => {
                    state.counters.packets_decode_failed += 1;
                    return;
                }
            };
            drop(state);
            if let Ok(body) = serde_json::to_vec(&reply) {
                let packet = make_syncpeer_packet(SYNCPEER_DISCOVERY_KIND_REPLY, &body);
                let _ = socket.send_to(&packet, source);
            }
            return;
        }
        if kind != SYNCPEER_DISCOVERY_KIND_REPLY {
            state.counters.packets_decode_failed += 1;
            return;
        }
        let reply = match serde_json::from_slice::<SyncpeerReplyPacket>(body) {
            Ok(reply) if reply.version == 1 => reply,
            _ => {
                state.counters.packets_decode_failed += 1;
                return;
            }
        };
        if state.probe_request_id.as_deref() != Some(reply.request_id.as_str()) {
            state.counters.packets_filtered_expected_id += 1;
            return;
        }
        let device_id = reply
            .device_id
            .as_deref()
            .map(canonical_device_id)
            .filter(|value| !value.is_empty());
        if device_id.is_some() && device_id == state.local_device_id {
            state.counters.packets_filtered_expected_id += 1;
            return;
        }
        let candidate = DiscoveryLocalCandidate {
            address: format!("tcp://{}:{}", source.ip(), reply.port),
            protocol: "tcp".to_string(),
            host: Some(source.ip().to_string()),
            port: Some(reply.port),
            device_id,
        };
        state.candidates.insert(
            candidate.address.clone(),
            CachedCandidate {
                candidate,
                last_seen: Instant::now(),
            },
        );
        state.counters.announcements_accepted += 1;
        drop(state);
        self.updated.notify_all();
    }
}

/// One process owns the discovery sockets because two runtimes cannot bind
/// the same UDP ports. Both the Tauri commands and the Android service
/// bridge resolve the same instance.
pub(crate) fn shared_local_discovery() -> Arc<LocalDiscoveryRuntime> {
    static RUNTIME: OnceLock<Arc<LocalDiscoveryRuntime>> = OnceLock::new();
    Arc::clone(RUNTIME.get_or_init(|| LocalDiscoveryRuntime::start(LocalDiscoveryPorts::default())))
}

/// A random per-runtime marker so a looped-back probe is recognized without
/// depending on whether the local device identity has loaded yet.
fn discovery_origin_token() -> String {
    let mut bytes = [0_u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    data_encoding::HEXLOWER.encode(&bytes)
}

fn poll_error(error: &std::io::Error) -> bool {
    matches!(
        error.kind(),
        ErrorKind::WouldBlock | ErrorKind::TimedOut | ErrorKind::Interrupted
    )
}

fn sleep_until_stopped(stop: &AtomicBool, duration: Duration) {
    let step = Duration::from_millis(100);
    let mut remaining = duration;
    while !stop.load(Ordering::Acquire) && !remaining.is_zero() {
        let wait = remaining.min(step);
        thread::sleep(wait);
        remaining = remaining.saturating_sub(wait);
    }
}

fn decode_announcement(
    packet: &[u8],
    counters: &mut DiscoveryCounters,
) -> Option<LocalDiscoveryAnnounce> {
    if packet.len() < 5 {
        counters.packets_decode_failed += 1;
        return None;
    }
    let magic = u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]);
    if magic != LOCAL_DISCOVERY_MAGIC {
        counters.packets_magic_mismatch += 1;
        return None;
    }
    let announce = match LocalDiscoveryAnnounce::decode(&packet[4..]) {
        Ok(value) => value,
        Err(_) => {
            counters.packets_decode_failed += 1;
            return None;
        }
    };
    if announce.id.is_empty() {
        counters.packets_missing_id += 1;
        return None;
    }
    Some(announce)
}

fn collect_fresh_candidates(
    state: &mut LocalDiscoveryState,
    now: Instant,
    expected: &str,
) -> Vec<DiscoveryLocalCandidate> {
    state.candidates.retain(|_, cached| {
        now.saturating_duration_since(cached.last_seen) < LOCAL_DISCOVERY_CACHE_LIFETIME
    });
    let mut candidates = state
        .candidates
        .values()
        .filter(|cached| {
            expected.is_empty() || cached.candidate.device_id.as_deref() == Some(expected)
        })
        .map(|cached| cached.candidate.clone())
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| left.address.cmp(&right.address));
    candidates
}

fn build_response(
    state: &LocalDiscoveryState,
    timeout_ms: u64,
    candidates: Vec<DiscoveryLocalCandidate>,
) -> DiscoveryLocalResponse {
    let mut discovered_device_ids = candidates
        .iter()
        .filter_map(|candidate| candidate.device_id.clone())
        .collect::<Vec<_>>();
    discovered_device_ids.sort();
    discovered_device_ids.dedup();
    let syncthing_lan_available = state.syncthing_sockets > 0;
    let syncpeer_lan_active = state.syncpeer_sockets > 0;
    let status_message = if syncthing_lan_available {
        "LAN discovery active".to_string()
    } else if syncpeer_lan_active {
        "LAN discovery active (Syncthing port in use; using SyncPeer discovery)".to_string()
    } else {
        "LAN discovery unavailable".to_string()
    };
    DiscoveryLocalResponse {
        candidates,
        diagnostics: DiscoveryLocalDiagnostics {
            timeout_ms,
            sockets_bound: state.syncthing_sockets,
            bind_errors: state.bind_errors.clone(),
            packets_received: state.counters.packets_received,
            packets_by_socket_udp4: state.counters.packets_by_socket_udp4,
            packets_by_socket_udp6: state.counters.packets_by_socket_udp6,
            packets_magic_mismatch: state.counters.packets_magic_mismatch,
            packets_decode_failed: state.counters.packets_decode_failed,
            packets_missing_id: state.counters.packets_missing_id,
            packets_filtered_expected_id: state.counters.packets_filtered_expected_id,
            announcements_accepted: state.counters.announcements_accepted,
            discovered_device_ids,
            syncthing_lan_available,
            syncpeer_lan_active,
            status_message,
        },
    }
}

fn bind_socket_pair(port: u16, broadcast: bool, prefix: &str) -> (UdpSocketPair, Vec<String>) {
    let mut sockets = UdpSocketPair::new();
    let mut errors = Vec::new();
    match bind_udp4(port) {
        Ok(socket) => {
            if broadcast {
                let _ = socket.set_broadcast(true);
            }
            sockets.push(("udp4", socket));
        }
        Err(error) => errors.push(format!("{prefix}udp4 bind failed: {error}")),
    }
    match bind_udp6(port) {
        Ok(socket) => {
            let _ = socket.join_multicast_v6(&Ipv6Addr::new(0xff12, 0, 0, 0, 0, 0, 0x8384, 0), 0);
            sockets.push(("udp6", socket));
        }
        Err(error) => errors.push(format!("{prefix}udp6 bind failed: {error}")),
    }
    (sockets, errors)
}

/// `IPV6_V6ONLY` must be set before binding. Otherwise the IPv6 wildcard
/// socket is dual-stack and collides with the IPv4 socket on the same port.
fn bind_udp4(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV4, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    socket.bind(&SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), port).into())?;
    Ok(socket.into())
}

fn bind_udp6(port: u16) -> std::io::Result<UdpSocket> {
    let socket = Socket::new(Domain::IPV6, Type::DGRAM, Some(Protocol::UDP))?;
    socket.set_reuse_address(true)?;
    socket.set_only_v6(true)?;
    socket.bind(&SocketAddr::new(IpAddr::V6(Ipv6Addr::UNSPECIFIED), port).into())?;
    Ok(socket.into())
}

fn normalize_local_discovery_address(address: &str, source_ip: &str) -> Option<String> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return None;
    }
    if !trimmed.contains("://") {
        return Some(format!("tcp://{source_ip}:{trimmed}"));
    }
    let parsed = Url::parse(trimmed).ok()?;
    let scheme = parsed.scheme();
    if !matches!(scheme, "tcp" | "tcp4" | "tcp6" | "quic" | "quic4" | "quic6") {
        return Some(trimmed.to_string());
    }
    let port = parsed.port()?;
    let host = parsed.host_str().unwrap_or("");
    let normalized_host = if host == "0.0.0.0" || host == "::" || host.is_empty() {
        source_ip
    } else {
        host
    };
    let formatted_host = if normalized_host.contains(':') {
        format!("[{normalized_host}]")
    } else {
        normalized_host.to_string()
    };
    Some(format!("{scheme}://{formatted_host}:{port}"))
}

fn parse_local_discovery_candidate(
    address: &str,
    device_id: Option<&str>,
) -> Option<DiscoveryLocalCandidate> {
    let trimmed = address.trim();
    if trimmed.is_empty() {
        return None;
    }
    let normalized_device_id = device_id.map(|value| value.to_string());
    if trimmed.starts_with("relay://") {
        let parsed = Url::parse(trimmed).ok()?;
        return Some(DiscoveryLocalCandidate {
            address: trimmed.to_string(),
            protocol: "relay".to_string(),
            host: parsed.host_str().map(|value| value.to_string()),
            port: parsed.port(),
            device_id: normalized_device_id,
        });
    }
    let parsed = Url::parse(trimmed).ok()?;
    let protocol = match parsed.scheme() {
        "tcp" | "tcp4" | "tcp6" => "tcp",
        "quic" | "quic4" | "quic6" => "quic",
        _ => {
            return Some(DiscoveryLocalCandidate {
                address: trimmed.to_string(),
                protocol: "unknown".to_string(),
                host: None,
                port: None,
                device_id: normalized_device_id,
            });
        }
    };
    if parsed.host_str().is_some() && parsed.port().is_some() {
        return Some(DiscoveryLocalCandidate {
            address: trimmed.to_string(),
            protocol: protocol.to_string(),
            host: parsed.host_str().map(|value| value.to_string()),
            port: parsed.port(),
            device_id: normalized_device_id,
        });
    }
    None
}

pub(crate) fn make_syncpeer_packet(kind: u8, body: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(5 + body.len());
    packet.extend_from_slice(&SYNCPEER_DISCOVERY_MAGIC.to_be_bytes());
    packet.push(kind);
    packet.extend_from_slice(body);
    packet
}

pub(crate) fn parse_syncpeer_packet(packet: &[u8]) -> Option<(u8, &[u8])> {
    if packet.len() < 6 {
        return None;
    }
    let magic = u32::from_be_bytes([packet[0], packet[1], packet[2], packet[3]]);
    if magic != SYNCPEER_DISCOVERY_MAGIC {
        return None;
    }
    Some((packet[4], &packet[5..]))
}

fn send_syncpeer_probe(
    sockets: &[(&'static str, UdpSocket)],
    request_id: &str,
    origin_token: &str,
    device_id: Option<&str>,
    port: u16,
) {
    let probe = SyncpeerProbePacket {
        version: 1,
        request_id: request_id.to_string(),
        origin: Some(origin_token.to_string()),
        device_id: device_id.map(str::to_string),
    };
    let Ok(body) = serde_json::to_vec(&probe) else {
        return;
    };
    let packet = make_syncpeer_packet(SYNCPEER_DISCOVERY_KIND_PROBE, &body);
    for (label, socket) in sockets {
        if *label == "udp4" {
            let _ = socket.send_to(&packet, ("255.255.255.255", port));
        } else {
            let _ = socket.send_to(
                &packet,
                (Ipv6Addr::new(0xff12, 0, 0, 0, 0, 0, 0x8384, 0), port),
            );
        }
    }
}

pub(crate) fn local_announce_packet(cert_der: &[u8], port: u16, instance_id: i64) -> Vec<u8> {
    let announce = LocalDiscoveryAnnounce {
        id: Sha256::digest(cert_der).to_vec(),
        addresses: vec![format!("tcp://0.0.0.0:{port}")],
        instance_id,
    };
    let mut packet = LOCAL_DISCOVERY_MAGIC.to_be_bytes().to_vec();
    announce
        .encode(&mut packet)
        .expect("encoding into a byte vector cannot fail");
    packet
}

pub(crate) fn start_local_announce_worker(
    cert_der: Vec<u8>,
    port: u16,
    stop: Arc<AtomicBool>,
) -> Result<(), String> {
    shared_local_discovery().set_sync_port(port);
    thread::Builder::new()
        .name("syncpeer-local-announce".to_string())
        .spawn(move || {
            let packet =
                local_announce_packet(&cert_der, port, now_ms().try_into().unwrap_or(i64::MAX));
            let udp4 = bind_udp4(0).ok();
            if let Some(socket) = &udp4 {
                let _ = socket.set_broadcast(true);
            }
            let udp6 = bind_udp6(0).ok();
            while !stop.load(Ordering::Acquire) {
                if let Some(socket) = &udp4 {
                    let _ = socket.send_to(&packet, (Ipv4Addr::BROADCAST, LOCAL_DISCOVERY_PORT));
                }
                if let Some(socket) = &udp6 {
                    let _ = socket.send_to(
                        &packet,
                        (
                            Ipv6Addr::new(0xff12, 0, 0, 0, 0, 0, 0x8384, 0),
                            LOCAL_DISCOVERY_PORT,
                        ),
                    );
                }
                sleep_until_stopped(&stop, Duration::from_secs(10));
            }
        })
        .map_err(|error| format!("Could not start local discovery announcer: {error}"))?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::AtomicU16;

    static NEXT_TEST_PORT: AtomicU16 = AtomicU16::new(0);

    /// Include the process id so a leaked fixture from an earlier test run
    /// cannot hold the same fixed ports.
    fn test_ports() -> LocalDiscoveryPorts {
        let counter = NEXT_TEST_PORT.fetch_add(4, Ordering::Relaxed);
        let process_offset = (std::process::id() as u16 % 120) * 64;
        let base = 24_000 + process_offset + counter;
        LocalDiscoveryPorts {
            syncthing: base,
            syncpeer: base + 1,
        }
    }

    fn synthetic_device_id(seed: u8) -> String {
        canonical_device_id(&base32_no_padding(&[seed; 32]))
    }

    fn syncthing_announce_packet(device_id_bytes: Vec<u8>, port: u16) -> Vec<u8> {
        let announce = LocalDiscoveryAnnounce {
            id: device_id_bytes,
            addresses: vec![format!("tcp://0.0.0.0:{port}")],
            instance_id: 7,
        };
        let mut packet = LOCAL_DISCOVERY_MAGIC.to_be_bytes().to_vec();
        announce.encode(&mut packet).unwrap();
        packet
    }

    #[test]
    fn local_discovery_keeps_ipv4_and_ipv6_on_the_same_port() {
        let runtime = LocalDiscoveryRuntime::start(test_ports());
        let state = runtime.lock_state();
        assert!(
            !state
                .bind_errors
                .iter()
                .any(|error| error.contains("Address already in use")),
            "dual-stack IPv6 bind must not collide with the IPv4 socket: {:?}",
            state.bind_errors
        );
        assert_eq!(state.syncthing_sockets, 2);
        assert_eq!(state.syncpeer_sockets, 2);
    }

    #[test]
    fn local_discovery_caches_standard_syncthing_announcements() {
        let ports = test_ports();
        let runtime = LocalDiscoveryRuntime::start_with_prober(ports, false);
        let device_id = synthetic_device_id(11);
        let sender = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        sender
            .send_to(
                &syncthing_announce_packet(vec![11_u8; 32], 22_000),
                ("127.0.0.1", ports.syncthing),
            )
            .unwrap();
        let response = runtime.query(&DiscoveryLocalRequest {
            expected_device_id: None,
            timeout_ms: Some(3_000),
        });
        assert_eq!(
            response.candidates,
            vec![DiscoveryLocalCandidate {
                address: "tcp://127.0.0.1:22000".to_string(),
                protocol: "tcp".to_string(),
                host: Some("127.0.0.1".to_string()),
                port: Some(22_000),
                device_id: Some(device_id.clone()),
            }]
        );
        assert!(response.diagnostics.packets_received >= 1);
        assert_eq!(response.diagnostics.discovered_device_ids, vec![device_id]);
    }

    #[test]
    fn local_discovery_does_not_cache_its_own_probe_reply() {
        let ports = test_ports();
        let runtime = LocalDiscoveryRuntime::start(ports);
        runtime.set_local_device_id(&synthetic_device_id(41));
        // Wait past one probe interval so a looped-back probe has time to arrive.
        thread::sleep(Duration::from_millis(3_500));
        let response = runtime.query(&DiscoveryLocalRequest {
            expected_device_id: None,
            timeout_ms: Some(0),
        });
        assert!(
            response.candidates.is_empty(),
            "runtime discovered itself: {:?}",
            response.candidates
        );
    }

    #[test]
    fn local_discovery_caches_matching_probe_replies() {
        let runtime = LocalDiscoveryRuntime::start_with_prober(test_ports(), false);
        let remote_id = synthetic_device_id(61);
        runtime.lock_state().probe_request_id = Some("matched-probe".to_string());
        let reply = SyncpeerReplyPacket {
            version: 1,
            request_id: "matched-probe".to_string(),
            device_id: Some(remote_id.clone()),
            port: 22_999,
        };
        let packet = make_syncpeer_packet(
            SYNCPEER_DISCOVERY_KIND_REPLY,
            &serde_json::to_vec(&reply).unwrap(),
        );
        let socket = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        runtime.handle_syncpeer_packet(
            &socket,
            "udp4",
            &packet,
            "192.0.2.44:21037".parse().unwrap(),
        );
        let response = runtime.query(&DiscoveryLocalRequest {
            expected_device_id: Some(remote_id.clone()),
            timeout_ms: Some(0),
        });
        assert_eq!(
            response.candidates,
            vec![DiscoveryLocalCandidate {
                address: "tcp://192.0.2.44:22999".to_string(),
                protocol: "tcp".to_string(),
                host: Some("192.0.2.44".to_string()),
                port: Some(22_999),
                device_id: Some(remote_id),
            }]
        );
    }

    #[test]
    fn local_discovery_ignores_unmatched_probe_replies() {
        let runtime = LocalDiscoveryRuntime::start_with_prober(test_ports(), false);
        runtime.lock_state().probe_request_id = Some("current-probe".to_string());
        let reply = SyncpeerReplyPacket {
            version: 1,
            request_id: "stale-probe".to_string(),
            device_id: Some(synthetic_device_id(62)),
            port: 22_999,
        };
        let packet = make_syncpeer_packet(
            SYNCPEER_DISCOVERY_KIND_REPLY,
            &serde_json::to_vec(&reply).unwrap(),
        );
        let socket = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        runtime.handle_syncpeer_packet(
            &socket,
            "udp4",
            &packet,
            "192.0.2.45:21037".parse().unwrap(),
        );
        let response = runtime.query(&DiscoveryLocalRequest {
            expected_device_id: None,
            timeout_ms: Some(0),
        });
        assert!(response.candidates.is_empty());
        assert_eq!(response.diagnostics.packets_filtered_expected_id, 1);
    }

    #[test]
    fn local_discovery_ignores_its_own_probe() {
        let ports = test_ports();
        let runtime = LocalDiscoveryRuntime::start_with_prober(ports, false);
        let local_device_id = synthetic_device_id(51);
        runtime.set_local_device_id(&local_device_id);
        let origin_token = runtime.lock_state().origin_token.clone();
        let prober = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        prober
            .set_read_timeout(Some(Duration::from_millis(500)))
            .unwrap();
        for probe in [
            SyncpeerProbePacket {
                version: 1,
                request_id: "self-device-probe".to_string(),
                origin: None,
                device_id: Some(local_device_id),
            },
            SyncpeerProbePacket {
                version: 1,
                request_id: "self-origin-probe".to_string(),
                origin: Some(origin_token),
                device_id: None,
            },
        ] {
            let packet = make_syncpeer_packet(
                SYNCPEER_DISCOVERY_KIND_PROBE,
                &serde_json::to_vec(&probe).unwrap(),
            );
            prober
                .send_to(&packet, ("127.0.0.1", ports.syncpeer))
                .unwrap();
        }
        let mut buffer = [0_u8; 4096];
        assert!(
            prober.recv_from(&mut buffer).is_err(),
            "a self-originated probe must not be answered"
        );
    }

    #[test]
    fn local_discovery_applies_expected_device_filter() {
        let ports = test_ports();
        let runtime = LocalDiscoveryRuntime::start_with_prober(ports, false);
        let sender = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        sender
            .send_to(
                &syncthing_announce_packet(vec![21_u8; 32], 22_000),
                ("127.0.0.1", ports.syncthing),
            )
            .unwrap();
        let response = runtime.query(&DiscoveryLocalRequest {
            expected_device_id: Some(synthetic_device_id(21)),
            timeout_ms: Some(3_000),
        });
        assert_eq!(response.candidates.len(), 1);
        let other = runtime.query(&DiscoveryLocalRequest {
            expected_device_id: Some(synthetic_device_id(22)),
            timeout_ms: Some(0),
        });
        assert!(other.candidates.is_empty());
    }

    #[test]
    fn local_discovery_answers_syncpeer_probes_with_identity() {
        let ports = test_ports();
        let runtime = LocalDiscoveryRuntime::start_with_prober(ports, false);
        let local_device_id = synthetic_device_id(31);
        runtime.set_local_device_id(&local_device_id);
        runtime.set_sync_port(23_456);
        let prober = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        prober
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let probe = SyncpeerProbePacket {
            version: 1,
            request_id: "test-request".to_string(),
            origin: None,
            device_id: None,
        };
        let packet = make_syncpeer_packet(
            SYNCPEER_DISCOVERY_KIND_PROBE,
            &serde_json::to_vec(&probe).unwrap(),
        );
        prober
            .send_to(&packet, ("127.0.0.1", ports.syncpeer))
            .unwrap();
        let mut buffer = [0_u8; 4096];
        let (size, _) = prober.recv_from(&mut buffer).unwrap();
        let (kind, body) = parse_syncpeer_packet(&buffer[..size]).unwrap();
        assert_eq!(kind, SYNCPEER_DISCOVERY_KIND_REPLY);
        let reply: SyncpeerReplyPacket = serde_json::from_slice(body).unwrap();
        assert_eq!(reply.request_id, "test-request");
        assert_eq!(reply.device_id.as_deref(), Some(local_device_id.as_str()));
        assert_eq!(reply.port, 23_456);
    }

    #[test]
    fn syncpeer_packet_roundtrip_probe() {
        let probe = SyncpeerProbePacket {
            version: 1,
            request_id: "test-request".to_string(),
            origin: Some("origin-token".to_string()),
            device_id: None,
        };
        let body = serde_json::to_vec(&probe).expect("probe should serialize");
        let packet = make_syncpeer_packet(SYNCPEER_DISCOVERY_KIND_PROBE, &body);
        let parsed = parse_syncpeer_packet(&packet).expect("packet should parse");
        assert_eq!(parsed.0, SYNCPEER_DISCOVERY_KIND_PROBE);
        let decoded: SyncpeerProbePacket =
            serde_json::from_slice(parsed.1).expect("probe should deserialize");
        assert_eq!(decoded.request_id, "test-request");
        assert_eq!(decoded.origin.as_deref(), Some("origin-token"));
        assert_eq!(decoded.version, 1);
    }

    #[test]
    fn syncpeer_packet_rejects_invalid_magic() {
        let invalid = vec![0_u8, 1, 2, 3, SYNCPEER_DISCOVERY_KIND_REPLY, 1, 2, 3];
        assert!(parse_syncpeer_packet(&invalid).is_none());
    }

    /// Interoperability check against the repository's pinned Syncthing
    /// binary. Skipped unless the test harness supplies
    /// `SYNCPEER_SYNCTHING_BIN`. It never contacts public services and uses
    /// a synthetic fixture identity. The reverse direction cannot run on a
    /// single host because Syncthing owns UDP 21027 exclusively; the
    /// announcement decoder is covered by the synthetic packet tests.
    #[test]
    fn local_discovery_announcements_are_accepted_by_real_syncthing() {
        let Some(binary) = std::env::var_os("SYNCPEER_SYNCTHING_BIN") else {
            return;
        };
        let binary = std::path::PathBuf::from(binary);
        if !binary.is_file() {
            return;
        }
        let ports = test_ports();
        let gui_port = ports.syncpeer + 2;
        let home = tempfile::tempdir().unwrap();
        let generated = std::process::Command::new(&binary)
            .args([
                "generate",
                "--home",
                home.path().to_str().unwrap(),
                "--no-port-probing",
            ])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .unwrap();
        assert!(generated.success(), "Syncthing fixture identity failed");
        let config_path = home.path().join("config.xml");
        let config = fs::read_to_string(&config_path)
            .unwrap()
            .replace(
                "<address>127.0.0.1:8384</address>",
                &format!("<address>127.0.0.1:{gui_port}</address>"),
            )
            .replace(
                "<globalAnnounceEnabled>true</globalAnnounceEnabled>",
                "<globalAnnounceEnabled>false</globalAnnounceEnabled>",
            )
            .replace(
                "<localAnnouncePort>21027</localAnnouncePort>",
                &format!("<localAnnouncePort>{}</localAnnouncePort>", ports.syncthing),
            )
            .replace(
                "<localAnnounceMCAddr>[ff12::8384]:21027</localAnnounceMCAddr>",
                &format!(
                    "<localAnnounceMCAddr>[ff12::8384]:{}</localAnnounceMCAddr>",
                    ports.syncthing
                ),
            )
            .replace(
                "<relaysEnabled>true</relaysEnabled>",
                "<relaysEnabled>false</relaysEnabled>",
            )
            .replace(
                "<natEnabled>true</natEnabled>",
                "<natEnabled>false</natEnabled>",
            );
        let api_key = config
            .split("<apikey>")
            .nth(1)
            .and_then(|rest| rest.split("</apikey>").next())
            .unwrap()
            .to_string();
        fs::write(&config_path, config).unwrap();
        let child = CommandGuard(
            std::process::Command::new(&binary)
                .args([
                    "serve",
                    "--home",
                    home.path().to_str().unwrap(),
                    "--no-browser",
                    "--no-restart",
                    "--no-upgrade",
                ])
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .unwrap(),
        );
        wait_for_tcp_port(gui_port);
        let announcement = local_announce_packet(b"synthetic syncpeer announcement", 22_000, 9);
        let announced_id = Sha256::digest(b"synthetic syncpeer announcement");
        let expected = canonical_device_id(&base32_no_padding(&announced_id));
        let sender = UdpSocket::bind(("127.0.0.1", 0)).unwrap();
        sender
            .send_to(&announcement, ("127.0.0.1", ports.syncthing))
            .unwrap();
        let discovered = poll_syncthing_discovery(&api_key, gui_port, &expected);
        drop(child);
        assert!(
            discovered,
            "Syncthing did not record the Syncpeer announcement in its discovery cache"
        );
    }

    struct CommandGuard(std::process::Child);

    impl Drop for CommandGuard {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn wait_for_tcp_port(port: u16) {
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(200));
        }
        panic!("Syncthing fixture did not start");
    }

    fn poll_syncthing_discovery(api_key: &str, gui_port: u16, expected: &str) -> bool {
        for _ in 0..50 {
            let entries = tauri::async_runtime::block_on(async {
                let response = reqwest::Client::new()
                    .get(format!("http://127.0.0.1:{gui_port}/rest/system/discovery"))
                    .header("X-API-Key", api_key)
                    .send()
                    .await
                    .ok()?;
                let body = response.text().await.ok()?;
                serde_json::from_str::<serde_json::Value>(&body).ok()
            });
            let found = entries
                .as_ref()
                .and_then(|value| value.as_object())
                .map(|entries| {
                    entries
                        .keys()
                        .any(|device_id| canonical_device_id(device_id) == expected)
                })
                .unwrap_or(false);
            if found {
                return true;
            }
            thread::sleep(Duration::from_millis(200));
        }
        false
    }

    #[test]
    fn local_discovery_normalizes_and_parses_quic_addresses() {
        let address = normalize_local_discovery_address("quic4://0.0.0.0:22000", "192.0.2.10")
            .expect("QUIC address should normalize");
        assert_eq!(address, "quic4://192.0.2.10:22000");

        let candidate = parse_local_discovery_candidate(&address, Some("DEVICE"))
            .expect("QUIC candidate should parse");
        assert_eq!(candidate.protocol, "quic");
        assert_eq!(candidate.host.as_deref(), Some("192.0.2.10"));
        assert_eq!(candidate.port, Some(22_000));
    }
}
