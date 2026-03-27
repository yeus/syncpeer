use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<SyncpeerAndroid<R>> {
  Ok(SyncpeerAndroid(app.clone()))
}

/// Access to the syncpeer-android APIs.
pub struct SyncpeerAndroid<R: Runtime>(AppHandle<R>);

impl<R: Runtime> SyncpeerAndroid<R> {
  pub fn open_with_chooser(
    &self,
    _path: &str,
    _mime_type: Option<&str>,
    _chooser_title: Option<&str>,
  ) -> crate::Result<()> {
    Err(crate::Error::UnsupportedPlatform("open_with_chooser".into()))
  }

  pub fn write_file_to_saf_tree(
    &self,
    _tree_uri: &str,
    _relative_path: &str,
    _bytes: &[u8],
    _mime_type: Option<&str>,
  ) -> crate::Result<()> {
    Err(crate::Error::UnsupportedPlatform("write_file_to_saf_tree".into()))
  }

  pub fn open_saf_path_with_chooser(
    &self,
    _tree_uri: &str,
    _relative_path: &str,
    _open_parent: bool,
  ) -> crate::Result<()> {
    Err(crate::Error::UnsupportedPlatform(
      "open_saf_path_with_chooser".into(),
    ))
  }

  pub fn saf_path_exists(&self, _tree_uri: &str, _relative_path: &str) -> crate::Result<bool> {
    Err(crate::Error::UnsupportedPlatform("saf_path_exists".into()))
  }

  pub fn delete_saf_path(&self, _tree_uri: &str, _relative_path: &str) -> crate::Result<bool> {
    Err(crate::Error::UnsupportedPlatform("delete_saf_path".into()))
  }

  pub fn pick_saf_directory(&self) -> crate::Result<String> {
    Err(crate::Error::UnsupportedPlatform("pick_saf_directory".into()))
  }

  pub fn list_persisted_saf_tree_uris(&self) -> crate::Result<Vec<String>> {
    Err(crate::Error::UnsupportedPlatform(
      "list_persisted_saf_tree_uris".into(),
    ))
  }
}
