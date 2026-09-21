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
        crate::vault_secret::ensure_local_reset_credentials_available()?;
        let result = paths.iter().try_for_each(|path| clear_app_directory(path, identifier))
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

}
