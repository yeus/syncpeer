#[cfg(any(test, target_os = "linux"))]
use std::{
    fs,
    path::{Component, Path},
};
#[cfg(target_os = "linux")]
use tauri::Manager;

fn confirm_reset(confirmation: &str) -> Result<(), String> {
    if confirmation == "RESET LOCAL DATA" {
        Ok(())
    } else {
        Err("Local reset requires the exact confirmation phrase.".into())
    }
}

#[cfg(any(test, target_os = "linux"))]
fn app_owned_path<'a>(path: &'a Path, identifier: &str) -> Result<&'a Path, String> {
    if !path.is_absolute()
        || path.file_name().is_none_or(|name| name != identifier)
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || fs::symlink_metadata(path).is_ok_and(|entry| entry.file_type().is_symlink())
    {
        return Err("Refusing to clear a path outside Syncpeer app storage.".into());
    }
    Ok(path)
}

#[cfg(any(test, target_os = "linux"))]
fn clear_app_directory(path: &Path, identifier: &str) -> Result<(), String> {
    app_owned_path(path, identifier)?;
    if path.exists() {
        fs::remove_dir_all(path)
            .map_err(|_| "Syncpeer app storage could not be cleared.".to_string())?;
    }
    Ok(())
}

#[cfg(any(test, target_os = "linux"))]
fn clear_legacy_identity_directory(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.file_name().is_none_or(|name| name != "cli-node")
        || path.parent().and_then(Path::file_name).is_none_or(|name| name != "syncpeer")
        || path.components().any(|part| matches!(part, Component::ParentDir | Component::CurDir))
        || [path, path.parent().unwrap()].iter().any(|candidate|
            fs::symlink_metadata(candidate).is_ok_and(|entry| entry.file_type().is_symlink()))
    {
        return Err("Refusing to clear a path outside historical Syncpeer identity storage.".into());
    }
    if path.exists() {
        fs::remove_dir_all(path).map_err(|_| "Historical Syncpeer identity could not be cleared.".to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn syncpeer_reset_local_data(
    app: tauri::AppHandle,
    confirmation: String,
) -> Result<(), String> {
    confirm_reset(&confirmation)?;
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_syncpeer_android::SyncpeerAndroidExt;
        app.syncpeer_android()
            .reset_local_data()
            .map_err(|_| "Android could not clear Syncpeer local data.".to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        let identifier = app.config().identifier.as_str();
        let paths = [
            app.path().app_cache_dir(),
            app.path().app_config_dir(),
            app.path().app_data_dir(),
        ]
        .into_iter()
        .map(|result| result.map_err(|_| "Syncpeer app storage path is unavailable.".to_string()))
        .collect::<Result<Vec<_>, _>>()?;
        for path in &paths {
            app_owned_path(path, identifier)?;
        }
        let historical_identity = app.path().config_dir()
            .map_err(|_| "Historical Syncpeer identity path is unavailable.".to_string())?
            .join("syncpeer").join("cli-node");
        // Earlier desktop releases used this fallback outside the app-ID directory.
        crate::vault_secret::ensure_local_reset_credentials_available()?;
        let result = paths.iter().try_for_each(|path| clear_app_directory(path, identifier))
            .and_then(|_| clear_legacy_identity_directory(&historical_identity))
            .and_then(|_| crate::vault_secret::remove_local_reset_credentials());
        let closing = app.clone();
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            closing.exit(0);
        });
        result?;
    }
    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        let _ = app;
        return Err("Local reset is not implemented on this platform.".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reset_rejects_wrong_confirmation_and_non_app_paths() {
        assert!(confirm_reset("reset local data").is_err());
        assert!(confirm_reset("RESET LOCAL DATA").is_ok());
        assert!(app_owned_path(Path::new("/tmp"), "dev.syncpeer.app").is_err());
        assert!(app_owned_path(Path::new("/tmp/dev.syncpeer.app"), "dev.syncpeer.app").is_ok());
        assert!(app_owned_path(
            Path::new("/tmp/dev.syncpeer.app/../other"),
            "dev.syncpeer.app"
        )
        .is_err());
    }

    #[test]
    fn reset_removes_only_the_app_owned_directory() {
        let root = tempfile::tempdir().unwrap();
        let app = root.path().join("dev.syncpeer.app");
        let selected = root.path().join("selected-files");
        fs::create_dir_all(&app).unwrap();
        fs::create_dir_all(&selected).unwrap();
        fs::write(app.join("metadata.sqlite3"), b"synthetic-local-data").unwrap();
        fs::write(selected.join("keep.txt"), b"synthetic-external-data").unwrap();
        clear_app_directory(&app, "dev.syncpeer.app").unwrap();
        assert!(!app.exists());
        assert_eq!(
            fs::read(selected.join("keep.txt")).unwrap(),
            b"synthetic-external-data"
        );
    }

    #[test]
    fn reset_can_clear_only_the_historical_syncpeer_identity_directory() {
        let root = tempfile::tempdir().unwrap();
        let identity = root.path().join("syncpeer").join("cli-node");
        let unrelated = root.path().join("other").join("cli-node");
        fs::create_dir_all(&identity).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        fs::write(identity.join("key.pem"), b"synthetic-key").unwrap();
        fs::write(unrelated.join("key.pem"), b"keep").unwrap();
        assert!(clear_legacy_identity_directory(&unrelated).is_err());
        clear_legacy_identity_directory(&identity).unwrap();
        assert!(!identity.exists());
        assert_eq!(fs::read(unrelated.join("key.pem")).unwrap(), b"keep");
    }
}
