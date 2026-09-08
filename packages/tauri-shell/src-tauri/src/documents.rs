#[tauri::command]
pub async fn syncpeer_document_command(
    app: tauri::AppHandle,
    request: serde_json::Value,
) -> Result<serde_json::Value, String> {
    #[cfg(target_os = "android")]
    {
        use tauri_plugin_syncpeer_android::SyncpeerAndroidExt;
        tauri::async_runtime::spawn_blocking(move || {
            app.syncpeer_android()
                .document_command(request)
                .map_err(|_| {
                    "Document operation failed. Check the vault and Android System WebView."
                        .to_string()
                })
        })
        .await
        .map_err(|_| "Document worker failed.".to_string())?
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, request);
        Err("Android document access is unavailable on this platform.".into())
    }
}
