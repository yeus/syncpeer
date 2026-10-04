use super::{canonical_device_id, compute_device_id_from_der, relay_identity, NoCertificateVerification};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::watch;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoveryFetchRequest {
    pub request_id: u64,
    pub url: String,
    pub method: String,
    pub headers: HashMap<String, String>,
    pub body: Option<String>,
    pub cert_pem: Option<String>,
    pub key_pem: Option<String>,
    pub pin_server_device_id: Option<String>,
    #[serde(default)]
    pub allow_insecure_tls: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct DiscoveryFetchResponse {
    pub headers: HashMap<String, String>,
    pub status: u16,
    pub body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct DiscoveryCancelRequest { pub request_id: u64 }

#[derive(Default)]
pub(super) struct DiscoveryRequests {
    next_id: u64,
    pending: HashMap<u64, watch::Sender<bool>>,
}

pub(super) type SharedDiscoveryRequests = Arc<Mutex<DiscoveryRequests>>;

pub(super) fn prepare(store: &SharedDiscoveryRequests) -> Result<u64, String> {
    let mut state = store.lock().map_err(|_| "Discovery request lock poisoned")?;
    if state.pending.len() >= 128 { return Err("Too many pending discovery requests".into()); }
    state.next_id = state.next_id.checked_add(1).ok_or("Discovery request IDs exhausted")?;
    let id = state.next_id;
    state.pending.insert(id, watch::channel(false).0);
    Ok(id)
}

pub(super) fn cancel(store: &SharedDiscoveryRequests, id: u64) -> Result<(), String> {
    let mut state = store.lock().map_err(|_| "Discovery request lock poisoned")?;
    if let Some(sender) = state.pending.remove(&id) { sender.send_replace(true); }
    Ok(())
}

#[cfg(any(test, target_os = "android"))]
pub(super) fn cancel_all(store: &SharedDiscoveryRequests) {
    if let Ok(mut state) = store.lock() {
        for (_, sender) in state.pending.drain() { sender.send_replace(true); }
    }
}

struct DiscoveryRequestLease { store: SharedDiscoveryRequests, id: u64 }

impl Drop for DiscoveryRequestLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.store.lock() { state.pending.remove(&self.id); }
    }
}

pub(super) async fn fetch(store: &SharedDiscoveryRequests, request: DiscoveryFetchRequest)
    -> Result<DiscoveryFetchResponse, String> {
    let mut cancelled = store.lock().map_err(|_| "Discovery request lock poisoned")?
        .pending.get(&request.request_id).ok_or("Discovery request cancelled or unavailable")?.subscribe();
    let _lease = DiscoveryRequestLease { store: store.clone(), id: request.request_id };
    let result = if *cancelled.borrow() {
        Err("Discovery request cancelled".into())
    } else {
        tokio::select! {
            biased;
            _ = cancelled.changed() => Err("Discovery request cancelled".into()),
            result = perform(&request) => result,
        }
    };
    result
}

#[derive(Debug)]
struct DiscoveryCertificateVerification { expected_id: Option<String> }

impl ServerCertVerifier for DiscoveryCertificateVerification {
    fn verify_server_cert(&self, cert: &CertificateDer<'_>, _: &[CertificateDer<'_>],
        _: &ServerName<'_>, _: &[u8], _: UnixTime) -> Result<ServerCertVerified, rustls::Error> {
        if self.expected_id.as_ref().is_some_and(|expected|
            canonical_device_id(&compute_device_id_from_der(cert.as_ref())) != canonical_device_id(expected)) {
            return Err(rustls::Error::General("Discovery server certificate ID mismatch".into()));
        }
        Ok(ServerCertVerified::assertion())
    }
    fn verify_tls12_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct)
        -> Result<HandshakeSignatureValid, rustls::Error> {
        NoCertificateVerification.verify_tls12_signature(message, cert, dss)
    }
    fn verify_tls13_signature(&self, message: &[u8], cert: &CertificateDer<'_>, dss: &DigitallySignedStruct)
        -> Result<HandshakeSignatureValid, rustls::Error> {
        NoCertificateVerification.verify_tls13_signature(message, cert, dss)
    }
    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        NoCertificateVerification.supported_verify_schemes()
    }
}

fn client(request: &DiscoveryFetchRequest) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder().use_rustls_tls().https_only(true)
        .timeout(Duration::from_secs(15));
    if request.pin_server_device_id.is_some() || request.allow_insecure_tls {
        let tls = ClientConfig::builder().dangerous().with_custom_certificate_verifier(
            Arc::new(DiscoveryCertificateVerification { expected_id:
                if request.allow_insecure_tls { None } else { request.pin_server_device_id.clone() } }));
        let tls = match (&request.cert_pem, &request.key_pem) {
            (Some(cert), Some(key)) => {
                let (certs, key) = relay_identity(cert, key)?;
                tls.with_client_auth_cert(certs, key).map_err(|error| error.to_string())?
            }
            (None, None) => tls.with_no_client_auth(),
            _ => return Err("Discovery client certificate and key must be supplied together".into()),
        };
        builder = builder.use_preconfigured_tls(tls).redirect(reqwest::redirect::Policy::none());
    } else {
        match (&request.cert_pem, &request.key_pem) {
            (Some(cert), Some(key)) => builder = builder.identity(reqwest::Identity::from_pem(
                format!("{cert}\n{key}").as_bytes()).map_err(|error| error.to_string())?),
            (None, None) => {},
            _ => return Err("Discovery client certificate and key must be supplied together".into()),
        }
    }
    builder.build().map_err(|error| format!("Could not build discovery HTTP client: {error}"))
}

async fn perform(request: &DiscoveryFetchRequest) -> Result<DiscoveryFetchResponse, String> {
    let method = if request.method.trim().is_empty() { reqwest::Method::GET } else {
        reqwest::Method::from_bytes(request.method.trim().as_bytes()).map_err(|error| error.to_string())?
    };
    let mut builder = client(request)?.request(method, &request.url);
    for (name, value) in &request.headers { builder = builder.header(name, value); }
    if let Some(body) = &request.body { builder = builder.body(body.clone()); }
    let response = builder.send().await.map_err(|error| format!("Discovery fetch failed: {error:#}"))?;
    let status = response.status().as_u16();
    let headers = response.headers().iter().filter_map(|(key, value)|
        value.to_str().ok().map(|value| (key.as_str().to_string(), value.to_string()))).collect();
    let body = response.text().await.map_err(|error| format!("Could not read discovery body: {error}"))?;
    Ok(DiscoveryFetchResponse { status, headers, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::net::TcpListener;
    use std::thread;

    fn request(id: u64, url: String, pinned: bool) -> DiscoveryFetchRequest {
        DiscoveryFetchRequest { request_id: id, url, method: "GET".into(), headers: HashMap::new(),
            body: None, cert_pem: None, key_pem: None,
            pin_server_device_id: pinned.then(|| "SYNTHETIC".into()), allow_insecure_tls: false }
    }

    #[test]
    fn native_discovery_cancels_stalled_connections_and_releases_the_socket() {
        for (pinned, abort_task) in [(false, false), (true, false), (true, true)] {
            let tcp = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = tcp.local_addr().unwrap().port();
            let (connected, ready) = tokio::sync::oneshot::channel();
            let worker = thread::spawn(move || {
                let (mut socket, _) = tcp.accept().unwrap();
                socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
                connected.send(()).unwrap();
                loop {
                    let mut bytes = [0; 4096];
                    match socket.read(&mut bytes) {
                        Ok(0) => return,
                        Ok(_) => {},
                        Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => return,
                        Err(error) => panic!("Cancelled discovery socket stayed open: {error}"),
                    }
                }
            });
            let store = Arc::new(Mutex::new(DiscoveryRequests::default()));
            let id = prepare(&store).unwrap();
            tauri::async_runtime::block_on(async {
                let fetching = tokio::spawn({
                    let store = store.clone();
                    async move { fetch(&store, request(id, format!("https://127.0.0.1:{port}/v2/"), pinned)).await }
                });
                tokio::time::timeout(Duration::from_secs(2), ready).await.unwrap().unwrap();
                if abort_task {
                    fetching.abort();
                    assert!(tokio::time::timeout(Duration::from_secs(1), fetching).await.unwrap()
                        .unwrap_err().is_cancelled());
                } else {
                    cancel(&store, id).unwrap();
                    let error = tokio::time::timeout(Duration::from_secs(1), fetching).await.unwrap()
                        .unwrap().unwrap_err();
                    assert!(error.contains("cancelled"));
                }
            });
            worker.join().unwrap();
            assert!(store.lock().unwrap().pending.is_empty());
        }
    }

    #[test]
    fn native_discovery_remembers_cancellation_before_fetch_starts() {
        let store = Arc::new(Mutex::new(DiscoveryRequests::default()));
        let id = prepare(&store).unwrap();
        cancel(&store, id).unwrap();
        assert!(store.lock().unwrap().pending.is_empty());
        let error = tauri::async_runtime::block_on(fetch(&store,
            request(id, "not-a-url".into(), true))).unwrap_err();
        assert!(error.contains("cancelled"));
        assert!(store.lock().unwrap().pending.is_empty());
        cancel(&store, id).unwrap();
    }

    #[test]
    fn native_discovery_verifies_certificate_pins() {
        let certificate = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let der = CertificateDer::from(certificate.serialize_der().unwrap());
        let verifier = DiscoveryCertificateVerification { expected_id: Some("SYNTHETIC-WRONG-PIN".into()) };
        assert!(verifier.verify_server_cert(&der, &[], &ServerName::try_from("localhost").unwrap(),
            &[], UnixTime::now()).is_err());
        let verifier = DiscoveryCertificateVerification { expected_id: Some(compute_device_id_from_der(der.as_ref())) };
        assert!(verifier.verify_server_cert(&der, &[], &ServerName::try_from("localhost").unwrap(),
            &[], UnixTime::now()).is_ok());
        assert_eq!(verifier.supported_verify_schemes(), NoCertificateVerification.supported_verify_schemes());
    }
}
