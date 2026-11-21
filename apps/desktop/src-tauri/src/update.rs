//! Update verification (#77 slice 6). The app accepts an update only when its signature verifies
//! against the public key compiled into the app. The release key is held by the owner and is not in
//! the repository, so the committed key is a placeholder that verifies nothing: an update fails
//! closed until a real key is built in. This module has no window and shows nothing; what a person
//! sees about an update is a design question for design-ux.

use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

/// What asking an update address and downloading what it offers came to, for the test report. The
/// download is the step that checks the signature, so a verified update is one that downloaded.
pub async fn check_and_verify(app: &AppHandle, endpoint: &str) -> Value {
    let Ok(url) = endpoint.parse() else {
        return json!({ "outcome": "bad_endpoint" });
    };
    let updater = match app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| builder.build())
    {
        Ok(updater) => updater,
        Err(_) => return json!({ "outcome": "not_configured" }),
    };
    let update = match updater.check().await {
        Ok(Some(update)) => update,
        Ok(None) => return json!({ "outcome": "up_to_date" }),
        Err(_) => return json!({ "outcome": "check_failed" }),
    };
    let version = update.version.clone();
    match update.download(|_, _| {}, || {}).await {
        Ok(bytes) => json!({ "outcome": "verified", "version": version, "bytes": bytes.len() }),
        Err(tauri_plugin_updater::Error::Minisign(_)) | Err(tauri_plugin_updater::Error::Base64(_)) => {
            json!({ "outcome": "rejected", "version": version })
        }
        Err(_) => json!({ "outcome": "download_failed", "version": version }),
    }
}
