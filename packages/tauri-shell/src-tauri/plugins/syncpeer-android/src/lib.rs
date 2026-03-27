use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod error;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::SyncpeerAndroid;
#[cfg(mobile)]
use mobile::SyncpeerAndroid;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the syncpeer-android APIs.
pub trait SyncpeerAndroidExt<R: Runtime> {
  fn syncpeer_android(&self) -> &SyncpeerAndroid<R>;
}

impl<R: Runtime, T: Manager<R>> crate::SyncpeerAndroidExt<R> for T {
  fn syncpeer_android(&self) -> &SyncpeerAndroid<R> {
    self.state::<SyncpeerAndroid<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("syncpeer-android")
    .setup(|app, api| {
      #[cfg(mobile)]
      let syncpeer_android = mobile::init(app, api)?;
      #[cfg(desktop)]
      let syncpeer_android = desktop::init(app, api)?;
      app.manage(syncpeer_android);
      Ok(())
    })
    .build()
}
