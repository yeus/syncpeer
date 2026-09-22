//! JNI transport used by the Android service-owned TypeScript session.
//!
//! The Android service must not copy the TLS implementation into Kotlin.  This
//! adapter routes the same Rust transport helpers used by the Tauri commands
//! through a bounded JSON request bridge.

use super::*;
use jni::{
    objects::{JObject, JString},
    sys::jstring,
    JNIEnv,
};

struct AndroidNetwork {
    tls_store: SharedTlsStore,
    tls_listener_store: SharedTlsListenerStore,
    quic_store: SharedQuicStore,
}

impl Drop for AndroidNetwork {
    fn drop(&mut self) {
        let sessions = self
            .tls_store
            .lock()
            .map(|mut guard| {
                guard
                    .sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            let (response, _) = mpsc::channel();
            let _ = session.commands.send(TlsCommand::Close { response });
        }
        if let Ok(mut guard) = self.tls_listener_store.lock() {
            for (_, listener) in guard.listeners.drain() {
                listener.stop.store(true, Ordering::Release);
            }
        }
        if let Ok(mut guard) = self.quic_store.lock() {
            for (_, session) in guard.sessions.drain() {
                session.connection.close(0u32.into(), b"closed");
            }
        }
    }
}

fn read_random_bytes(size: usize) -> Result<Vec<u8>, String> {
    if !(1..=131_072).contains(&size) {
        return Err("Random byte request is outside the allowed range.".to_string());
    }
    let mut output = vec![0_u8; size];
    let mut source = fs::File::open("/dev/urandom")
        .map_err(|error| format!("Could not open the platform random source: {error}"))?;
    source
        .read_exact(&mut output)
        .map_err(|error| format!("Could not read platform random bytes: {error}"))?;
    Ok(output)
}

fn execute(
    network: &AndroidNetwork,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let operation = request
        .get("operation")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "Network operation is required.".to_string())?;
    match operation {
        "tlsOpen" => {
            let input: TlsOpenRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS open request: {error}"))?;
            let response = open_tls_session(network.tls_store.clone(), input)?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode TLS response: {error}"))?)
        }
        "tlsListen" => {
            let input: TlsListenRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS listen request: {error}"))?;
            let response = open_tls_listener(network.tls_store.clone(),
                network.tls_listener_store.clone(), input)?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode TLS listener response: {error}"))?)
        }
        "tlsAccept" => {
            let input: TlsAcceptRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS accept request: {error}"))?;
            let response = accept_tls_listener(&network.tls_listener_store, input)?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode TLS accept response: {error}"))?)
        }
        "tlsListenerClose" => {
            let input: TlsListenerCloseRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS listener close request: {error}"))?;
            close_tls_listener(&network.tls_listener_store, input)?;
            Ok(serde_json::Value::Null)
        }
        "relayOpen" => {
            let input: RelayOpenRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid relay open request: {error}"))?;
            let response = open_relay_session(network.tls_store.clone(), input)?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode relay response: {error}"))?)
        }
        "tlsRead" => {
            let input: TlsReadRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS read request: {error}"))?;
            let response = read_tls_session(&network.tls_store, input)?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode TLS response: {error}"))?)
        }
        "tlsWrite" => {
            let input: TlsWriteRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS write request: {error}"))?;
            write_tls_session(&network.tls_store, input)?;
            Ok(serde_json::Value::Null)
        }
        "tlsClose" => {
            let input: TlsCloseRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid TLS close request: {error}"))?;
            close_tls_session(&network.tls_store, input)?;
            Ok(serde_json::Value::Null)
        }
        "quicOpen" => {
            let input: QuicOpenRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid QUIC open request: {error}"))?;
            let response = tauri::async_runtime::block_on(open_quic_session(
                network.quic_store.clone(),
                input,
            ))?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode QUIC response: {error}"))?)
        }
        "quicRead" => {
            let input: TlsReadRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid QUIC read request: {error}"))?;
            let response =
                tauri::async_runtime::block_on(read_quic_session(&network.quic_store, input))?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode QUIC response: {error}"))?)
        }
        "quicWrite" => {
            let input: TlsWriteRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid QUIC write request: {error}"))?;
            tauri::async_runtime::block_on(write_quic_session(&network.quic_store, input))?;
            Ok(serde_json::Value::Null)
        }
        "quicClose" => {
            let input: TlsCloseRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid QUIC close request: {error}"))?;
            close_quic_session(&network.quic_store, input)?;
            Ok(serde_json::Value::Null)
        }
        "sha256" => {
            let bytes: Vec<u8> = serde_json::from_value(
                request
                    .get("bytes")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .map_err(|error| format!("Invalid hash request: {error}"))?;
            Ok(serde_json::to_value(Sha256::digest(bytes).to_vec()).unwrap_or_default())
        }
        "random" => {
            let size = request
                .get("size")
                .and_then(serde_json::Value::as_u64)
                .ok_or_else(|| "Random byte size is required.".to_string())?;
            Ok(serde_json::to_value(read_random_bytes(size as usize)?).unwrap_or_default())
        }
        "discoverLocal" => {
            let input: DiscoveryLocalRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid local discovery request: {error}"))?;
            let response = discover_local_candidates(&input)?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode discovery response: {error}"))?)
        }
        "discoveryFetch" => {
            let input: DiscoveryFetchRequest = serde_json::from_value(request.clone())
                .map_err(|error| format!("Invalid discovery request: {error}"))?;
            let result = if input.pin_server_device_id.is_some() || input.allow_insecure_tls {
                perform_pinned_discovery_request(&input)
            } else {
                perform_ca_validated_discovery_request(&input)
            };
            let response = result?;
            Ok(serde_json::to_value(response)
                .map_err(|error| format!("Could not encode discovery response: {error}"))?)
        }
        _ => Err(format!("Unknown network operation: {operation}")),
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_syncpeer_plugin_android_SessionNetworkTransport_initialize(
    mut env: JNIEnv,
    object: JObject,
) {
    let result = unsafe {
        env.set_rust_field(
            &object,
            "nativeHandle",
            Arc::new(AndroidNetwork {
                tls_store: Arc::new(Mutex::new(TlsSessionStore::default())),
                tls_listener_store: Arc::new(Mutex::new(TlsListenerStore::default())),
                quic_store: Arc::new(Mutex::new(QuicSessionStore::default())),
            }),
        )
    };
    if result.is_err() {
        let _ = env.throw_new(
            "java/lang/IllegalStateException",
            "Network transport unavailable",
        );
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_syncpeer_plugin_android_SessionNetworkTransport_request(
    mut env: JNIEnv,
    object: JObject,
    input: JString,
) -> jstring {
    let result = (|| -> Result<serde_json::Value, String> {
        let json: String = env
            .get_string(&input)
            .map_err(|error| error.to_string())?
            .into();
        if json.len() > 8 * 1024 * 1024 {
            return Err("Oversized network request".to_string());
        }
        let request: serde_json::Value = serde_json::from_str(&json)
            .map_err(|error| format!("Invalid network request: {error}"))?;
        let network = {
            let network =
                unsafe { env.get_rust_field::<_, _, Arc<AndroidNetwork>>(&object, "nativeHandle") }
                    .map_err(|error| error.to_string())?;
            Arc::clone(&network)
        };
        execute(&network, &request)
    })();
    let response = match result {
        Ok(value) => serde_json::json!({ "result": value }),
        Err(error) => serde_json::json!({ "error": error }),
    };
    match env.new_string(response.to_string()) {
        Ok(value) => value.into_raw(),
        Err(_) => {
            let _ = env.throw_new(
                "java/lang/IllegalStateException",
                "Network response unavailable",
            );
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_dev_syncpeer_plugin_android_SessionNetworkTransport_dispose(
    mut env: JNIEnv,
    object: JObject,
) {
    let _ = unsafe { env.take_rust_field::<_, _, Arc<AndroidNetwork>>(&object, "nativeHandle") };
}
