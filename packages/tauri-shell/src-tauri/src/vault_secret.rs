use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultSecretRequest {
    profile_id: String,
    operation: String,
    secret: Option<String>,
}

fn validate(request: &VaultSecretRequest) -> Result<(), String> {
    if request.profile_id.is_empty()
        || request.profile_id.len() > 128
        || !request.profile_id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || !["save", "load", "remove", "isDeviceUnlocked"].contains(&request.operation.as_str())
    {
        return Err("Invalid protected credential request.".into());
    }
    if request.operation == "save"
        && !request.secret.as_ref().is_some_and(|s| !s.is_empty() && s.len() <= 16384)
    {
        return Err("Invalid unlock secret.".into());
    }
    Ok(())
}

fn protected_metadata_exists(metadata_root: &std::path::Path) -> Result<bool, String> {
    if metadata_root.join("key-check").exists() {
        return Ok(true);
    }
    let folders = metadata_root.join("folders");
    if !folders.is_dir() {
        return Ok(false);
    }
    for item in std::fs::read_dir(folders)
        .map_err(|_| "Metadata state could not be inspected.".to_string())? {
        let item = item.map_err(|_| "Metadata state could not be inspected.".to_string())?;
        if item.path().is_dir() && std::fs::read_dir(item.path())
            .map_err(|_| "Metadata state could not be inspected.".to_string())?
            .next().is_some() {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "linux")]
fn desktop_secret(request: VaultSecretRequest) -> Result<Value, String> {
    use secret_service::{blocking::SecretService, EncryptionType};
    // Never prompt to unlock a locked collection during automatic startup.
    let result = (|| -> Result<Value, Box<dyn std::error::Error>> {
        let service = SecretService::connect(EncryptionType::Dh)?;
        let collection = service.get_default_collection()?;
        let locked = collection.is_locked()?;
        if request.operation == "isDeviceUnlocked" { return Ok(json!(!locked)); }
        if locked { return Err(std::io::Error::other("locked").into()); }
        let attributes = std::collections::HashMap::from([
            ("application", "dev.syncpeer.vault"), ("profile", request.profile_id.as_str()),
        ]);
        if request.operation == "save" {
            collection.create_item("Syncpeer unlock secret", attributes,
                request.secret.as_deref().unwrap_or_default().as_bytes(), true, "text/plain; charset=utf-8")?;
            return Ok(Value::Null);
        }
        let items = collection.search_items(attributes)?;
        if request.operation == "remove" {
            for item in items { item.delete()?; }
            return Ok(Value::Null);
        }
        if items.len() > 1 { return Err(std::io::Error::other("ambiguous credential").into()); }
        match items.first() {
            None => Ok(Value::Null),
            Some(item) => {
                if item.is_locked()? { return Err(std::io::Error::other("locked").into()); }
                let bytes = item.get_secret()?;
                if bytes.len() > 16384 { return Err(std::io::Error::other("oversized credential").into()); }
                Ok(json!(String::from_utf8(bytes)?))
            }
        }
    })();
    // Some credential errors contain raw secret bytes. Never expose their text.
    result.map_err(|_| "Protected credential operation failed; use manual unlock.".into())
}

#[cfg(target_os = "linux")]
pub fn load_or_create_protected_key(profile_id: &str, metadata_root: &std::path::Path) -> Result<[u8; 32], String> {
    let request = |operation: &str, secret: Option<String>| VaultSecretRequest {
        profile_id: profile_id.into(), operation: operation.into(), secret,
    };
    let stored = desktop_secret(request("load", None))?;
    if let Some(encoded) = stored.as_str() {
        let bytes = data_encoding::HEXLOWER.decode(encoded.as_bytes())
            .map_err(|_| "Protected metadata key is invalid; recovery or local reset is required.".to_string())?;
        return bytes.try_into().map_err(|_| "Protected metadata key is invalid; recovery or local reset is required.".to_string());
    }
    if protected_metadata_exists(metadata_root)? {
        return Err("Existing metadata requires its protected key or a confirmed local reset.".into());
    }
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|_| "Protected metadata key could not be generated.".to_string())?;
    let encoded = data_encoding::HEXLOWER.encode(&key);
    desktop_secret(request("save", Some(encoded.clone())))?;
    if desktop_secret(request("load", None))?.as_str() != Some(encoded.as_str()) {
        key.fill(0);
        return Err("Protected metadata key verification failed.".into());
    }
    Ok(key)
}

#[cfg(target_os = "linux")]
pub fn load_or_create_metadata_key(metadata_root: &std::path::Path) -> Result<[u8; 32], String> {
    load_or_create_protected_key("metadata", metadata_root)
}

#[cfg(target_os = "android")]
pub fn load_or_create_protected_key(app: &tauri::AppHandle, profile_id: &str,
    metadata_root: &std::path::Path) -> Result<[u8; 32], String> {
    use tauri_plugin_syncpeer_android::SyncpeerAndroidExt;
    let request = |operation: &str, secret: Option<String>| VaultSecretRequest {
        profile_id: profile_id.into(), operation: operation.into(), secret,
    };
    let execute = |request: VaultSecretRequest| app.syncpeer_android().vault_secret(json!(request))
        .map_err(|error| crate::preserve_private_storage_failure(
            error,
            "Protected metadata key operation failed.",
        ));
    let stored = execute(request("load", None))?;
    if let Some(encoded) = stored.as_str() {
        let bytes = data_encoding::HEXLOWER.decode(encoded.as_bytes())
            .map_err(|_| "Protected metadata key is invalid; recovery or local reset is required.".to_string())?;
        return bytes.try_into().map_err(|_| "Protected metadata key is invalid; recovery or local reset is required.".to_string());
    }
    if protected_metadata_exists(metadata_root)? {
        return Err("Existing metadata requires its protected key or a confirmed local reset.".into());
    }
    let mut key = [0u8; 32];
    getrandom::getrandom(&mut key).map_err(|_| "Protected metadata key could not be generated.".to_string())?;
    let encoded = data_encoding::HEXLOWER.encode(&key);
    execute(request("save", Some(encoded.clone())))?;
    if execute(request("load", None))?.as_str() != Some(encoded.as_str()) {
        key.fill(0);
        return Err("Protected metadata key verification failed.".into());
    }
    Ok(key)
}

#[cfg(target_os = "linux")]
pub fn ensure_local_reset_credentials_available() -> Result<(), String> {
    for profile_id in ["metadata", "native-cache-metadata", "documents", "identity"] {
        desktop_secret(VaultSecretRequest {
            profile_id: profile_id.into(), operation: "load".into(), secret: None,
        })?;
    }
    Ok(())
}

#[cfg(target_os = "linux")]
pub fn remove_local_reset_credentials() -> Result<(), String> {
    for profile_id in ["metadata", "native-cache-metadata", "documents", "identity"] {
        desktop_secret(VaultSecretRequest {
            profile_id: profile_id.into(), operation: "remove".into(), secret: None,
        })?;
    }
    Ok(())
}

pub fn identity_record(app: &tauri::AppHandle, operation: &str,
    secret: Option<String>) -> Result<Option<String>, String> {
    let request = VaultSecretRequest { profile_id: "identity".into(), operation: operation.into(), secret };
    validate(&request)?;
    #[cfg(target_os = "android")]
    let result = {
        use tauri_plugin_syncpeer_android::SyncpeerAndroidExt;
        app.syncpeer_android().vault_secret(json!(request))
            .map_err(|error| crate::preserve_private_storage_failure(
                error,
                "Protected identity storage is unavailable.",
            ))?
    };
    #[cfg(target_os = "linux")]
    let result = { let _ = app; desktop_secret(request)? };
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    let result: Value = { let _ = (app, request); return Err("Protected identity storage is unavailable.".into()); };
    result.as_str().map(str::to_owned).map(Some).or_else(|| if result.is_null() { Some(None) } else { None })
        .ok_or_else(|| "Protected identity record is invalid.".to_string())
}

#[tauri::command]
pub async fn syncpeer_vault_secret(
    app: tauri::AppHandle,
    state: tauri::State<'_, Arc<Mutex<()>>>,
    request: VaultSecretRequest,
) -> Result<Value, String> {
    validate(&request)?;
    let lock = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = lock.lock().map_err(|_| "Protected credential store is unavailable.".to_string())?;
        #[cfg(target_os = "android")]
        {
            use tauri_plugin_syncpeer_android::SyncpeerAndroidExt;
            app.syncpeer_android().vault_secret(json!(request))
                .map_err(|error| crate::preserve_private_storage_failure(
                    error,
                    "Protected credential operation failed; use manual unlock.",
                ))
        }
        #[cfg(target_os = "linux")]
        { let _ = app; desktop_secret(request) }
        #[cfg(not(any(target_os = "linux", target_os = "android")))]
        { let _ = app; Err("Protected credential storage is unavailable; use manual unlock.".into()) }
    }).await.map_err(|_| "Protected credential worker failed.".to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restricts_credential_namespace_and_bounds_secrets() {
        for profile_id in ["", "../outside", "personal/user", "profile.name"] {
            assert!(validate(&VaultSecretRequest { profile_id: profile_id.into(), operation: "load".into(), secret: None }).is_err());
        }
        assert!(validate(&VaultSecretRequest { profile_id: "synthetic-profile".into(), operation: "save".into(), secret: Some("synthetic-secret".into()) }).is_ok());
        assert!(validate(&VaultSecretRequest { profile_id: "synthetic-profile".into(), operation: "save".into(), secret: Some("x".repeat(16385)) }).is_err());
    }

    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "requires the repository-managed private Secret Service fixture"]
    fn private_secret_service_round_trip() {
        assert_eq!(std::env::var("SYNCPEER_PRIVATE_KEYRING_TEST").as_deref(), Ok("1"));
        let request = |operation: &str, secret: Option<&str>| VaultSecretRequest {
            profile_id: "synthetic-profile".into(), operation: operation.into(), secret: secret.map(str::to_owned),
        };
        assert_eq!(desktop_secret(request("isDeviceUnlocked", None)).unwrap(), json!(true));
        desktop_secret(request("save", Some("synthetic-master-password"))).unwrap();
        assert_eq!(desktop_secret(request("load", None)).unwrap(), json!("synthetic-master-password"));
        desktop_secret(request("remove", None)).unwrap();
        assert_eq!(desktop_secret(request("load", None)).unwrap(), Value::Null);
        let service = secret_service::blocking::SecretService::connect(secret_service::EncryptionType::Dh).unwrap();
        service.get_default_collection().unwrap().lock().unwrap();
        assert_eq!(desktop_secret(request("isDeviceUnlocked", None)).unwrap(), json!(false));
        assert!(desktop_secret(request("load", None)).is_err());
    }
}
