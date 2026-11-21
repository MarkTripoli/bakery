//! What happens when a page of the connected server offers a file (#77 slice 5, builder question 5).
//! The webview would save it silently into whatever folder the app was started from. Instead the file
//! comes in to a private folder of the app's own, and only when it has arrived is the person asked where
//! to keep it, in the system's own dialog starting in their Downloads folder. Cancelling the dialog
//! deletes it and nothing else happens: nothing is ever written anywhere the person did not choose.

use crate::shell::Shell;
use bakery_desktop_core::csp::server_origins;
use serde_json::json;
use std::sync::Arc;
use tauri::webview::DownloadEvent;
use tauri::{Manager, Webview, Wry};

/// The app's private folder for files on their way in.
fn incoming_dir() -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("bakery-incoming-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700));
    }
    dir
}

/// The handler for the main window. `server` is the connected server's address: only a file from
/// that server is saved.
pub fn handler(
    server: String,
) -> impl Fn(Webview<Wry>, DownloadEvent<'_>) -> bool + Send + Sync + 'static {
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
                    report(
                        "download_refused",
                        json!({ "reason": "not from the connected server" }),
                    );
                    return false;
                }
                let name = destination
                    .file_name()
                    .map(|n| n.to_string_lossy().to_string())
                    .unwrap_or_else(|| "download".into());
                let Some(shell) = &shell else { return false };
                let temp = incoming_dir().join(format!("{}-{}", shell.next_id(), name));
                *destination = temp.clone();
                report("download_started", json!({ "name": name }));
                shell.download_started(url.as_str(), &name, temp);
                true
            }
            DownloadEvent::Finished { url, success, .. } => {
                report("download_finished", json!({ "success": success }));
                if let Some(shell) = &shell {
                    shell.download_finished(url.as_str(), success);
                }
                true
            }
            _ => true,
        }
    }
}
