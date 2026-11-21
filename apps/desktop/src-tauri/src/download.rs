//! What happens when a page of the connected server offers a file (#77 slice 5, builder question 5).
//! The webview would save it silently into whatever folder the app was started from; instead the
//! person is asked where to save it, in the system's own dialog starting in their Downloads folder.
//! Cancelling the dialog cancels the download and nothing else happens.

use crate::shell::Shell;
use bakery_desktop_core::csp::server_origins;
use serde_json::json;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::webview::DownloadEvent;
use tauri::{Manager, Webview, Wry};

/// The handler for the main window. `server` is the connected server's address: only a file from
/// that server is saved.
pub fn handler(server: String) -> impl Fn(Webview<Wry>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
    move |webview, event| {
        let shell = webview.try_state::<Arc<Shell>>();
        let report = |name: &str, data: serde_json::Value| {
            if let Some(shell) = &shell {
                shell.report(name, data);
            }
        };
        match event {
            DownloadEvent::Requested { url, destination } => {
                let own = server_origins(&server).map(|(origin, _)| origin);
                let from = format!(
                    "{}://{}{}",
                    url.scheme(),
                    url.host_str().unwrap_or_default(),
                    url.port().map(|p| format!(":{p}")).unwrap_or_default()
                );
                if own.as_deref() != Some(from.as_str()) {
                    report("download_refused", json!({ "reason": "not from the connected server" }));
                    return false;
                }
                let name = destination
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "download".into());
                // Harness only: save into a folder without the dialog, which a run cannot answer.
                if let Ok(dir) = std::env::var("BAKERY_DESKTOP_DOWNLOAD_TO") {
                    *destination = PathBuf::from(dir).join(&name);
                    report("download_started", json!({ "name": name, "dialog": false }));
                    return true;
                }
                let start = webview.app_handle().path().download_dir().ok();
                let mut dialog = rfd::FileDialog::new().set_file_name(&name);
                if let Some(dir) = start {
                    dialog = dialog.set_directory(dir);
                }
                match dialog.save_file() {
                    Some(chosen) => {
                        *destination = chosen;
                        report("download_started", json!({ "name": name, "dialog": true }));
                        true
                    }
                    None => {
                        report("download_cancelled", json!({ "name": name }));
                        false
                    }
                }
            }
            DownloadEvent::Finished { success, .. } => {
                report("download_finished", json!({ "success": success }));
                true
            }
            _ => true,
        }
    }
}
