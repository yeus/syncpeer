use serde::de::DeserializeOwned;
use serde_json::json;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_syncpeer_android);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<SyncpeerAndroid<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("dev.syncpeer.plugin.android", "SyncpeerAndroidPlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_syncpeer_android)?;
  Ok(SyncpeerAndroid(handle))
}

/// Access to the syncpeer-android APIs.
pub struct SyncpeerAndroid<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> SyncpeerAndroid<R> {
  pub fn enable_multicast_lock(&self) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin::<serde_json::Value>("enableMulticastLock", json!({}))
      .map(|_| ())
      .map_err(Into::into)
  }

  pub fn open_with_chooser(
    &self,
    path: &str,
    mime_type: Option<&str>,
    chooser_title: Option<&str>,
  ) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin(
        "openWithChooser",
        json!({
          "path": path,
          "mimeType": mime_type,
          "chooserTitle": chooser_title
        }),
      )
      .map_err(Into::into)
  }

  pub fn write_file_to_saf_tree(
    &self,
    tree_uri: &str,
    relative_path: &str,
    bytes: &[u8],
    mime_type: Option<&str>,
  ) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin(
        "writeFileToSafTree",
        json!({
          "treeUri": tree_uri,
          "relativePath": relative_path,
          "bytes": bytes,
          "mimeType": mime_type
        }),
      )
      .map_err(Into::into)
  }

  pub fn open_saf_path_with_chooser(
    &self,
    tree_uri: &str,
    relative_path: &str,
    open_parent: bool,
  ) -> crate::Result<()> {
    self
      .0
      .run_mobile_plugin(
        "openSafPathWithChooser",
        json!({
          "treeUri": tree_uri,
          "relativePath": relative_path,
          "openParent": open_parent
        }),
      )
      .map_err(Into::into)
  }

  pub fn saf_path_exists(&self, tree_uri: &str, relative_path: &str) -> crate::Result<bool> {
    self
      .0
      .run_mobile_plugin(
        "safPathExists",
        json!({
          "treeUri": tree_uri,
          "relativePath": relative_path
        }),
      )
      .map_err(Into::into)
  }

  pub fn delete_saf_path(&self, tree_uri: &str, relative_path: &str) -> crate::Result<bool> {
    self
      .0
      .run_mobile_plugin(
        "deleteSafPath",
        json!({
          "treeUri": tree_uri,
          "relativePath": relative_path
        }),
      )
      .map_err(Into::into)
  }

  pub fn pick_saf_directory(&self) -> crate::Result<String> {
    let value = self
      .0
      .run_mobile_plugin::<serde_json::Value>("pickSafDirectory", json!({}))?;
    value
      .get("treeUri")
      .and_then(|v| v.as_str())
      .map(|v| v.to_string())
      .ok_or_else(|| crate::Error::InvalidResponse("missing treeUri from pickSafDirectory".into()))
  }

  pub fn list_persisted_saf_tree_uris(&self) -> crate::Result<Vec<String>> {
    self
      .0
      .run_mobile_plugin("listPersistedSafTreeUris", json!({}))
      .map_err(Into::into)
  }
}
