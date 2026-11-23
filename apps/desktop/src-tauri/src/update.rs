//! Update verification (#77 slice 6). The app accepts an update only when its signature verifies
//! against the public key compiled into the app. The release key is held by the owner and is not in
//! the repository, so the committed key is a placeholder that verifies nothing: an update fails
//! closed until a real key is built in. This module has no window and shows nothing; what a person
//! sees about an update is a design question for design-ux.

use bakery_desktop_core::update as words;
use serde_json::{json, Value};
use tauri::AppHandle;
use tauri_plugin_updater::{Update, UpdaterExt};

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
        Err(tauri_plugin_updater::Error::Minisign(_))
        | Err(tauri_plugin_updater::Error::Base64(_)) => {
            json!({ "outcome": "rejected", "version": version })
        }
        Err(_) => json!({ "outcome": "download_failed", "version": version }),
    }
}

pub fn feed_address(server: &str) -> String {
    format!(
        "{}/v1/desktop/update?target={{{{target}}}}&arch={{{{arch}}}}&current_version={{{{current_version}}}}",
        server.trim_end_matches('/')
    )
}

pub fn has_release_key(app: &AppHandle) -> bool {
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("pubkey"))
        .and_then(Value::as_str)
        .is_some_and(|key| !key.is_empty() && !key.starts_with("UNSET"))
}

pub enum Looked {
    Current,
    Offered(Box<Update>),
    NoFeed,
    Failed,
}

pub async fn look(app: &AppHandle, server: &str, bearer: Option<&str>) -> Looked {
    let Ok(url) = feed_address(server).parse() else {
        return Looked::Failed;
    };
    let builder = app
        .updater_builder()
        .endpoints(vec![url])
        .and_then(|builder| match bearer {
            Some(bearer) => builder.header("Authorization", format!("Bearer {bearer}")),
            None => Ok(builder),
        })
        .map(|builder| {
            builder
                .timeout(std::time::Duration::from_secs(30))
                .version_comparator(|current, remote| {
                    words::is_newer(&remote.version.to_string(), &current.to_string())
                })
        });
    let updater = match builder.and_then(|builder| builder.build()) {
        Ok(updater) => updater,
        Err(_) => return Looked::Failed,
    };
    match updater.check().await {
        Ok(Some(mut update)) => {
            update.headers.clear();
            if update.download_url.scheme() != "https" && !cfg!(debug_assertions) {
                return Looked::Failed;
            }
            Looked::Offered(Box::new(update))
        }
        Ok(None) => Looked::Current,
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => {
            if server_answers_not_found(server, bearer).await {
                Looked::NoFeed
            } else {
                Looked::Failed
            }
        }
        Err(_) => Looked::Failed,
    }
}

async fn server_answers_not_found(server: &str, bearer: Option<&str>) -> bool {
    let target = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let url = format!(
        "{}/v1/desktop/update?target={target}&arch={}&current_version=0.0.0",
        server.trim_end_matches('/'),
        std::env::consts::ARCH
    );
    let request = reqwest::Client::new().get(url);
    let request = match bearer {
        Some(bearer) => request.bearer_auth(bearer),
        None => request,
    };
    match request
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(response) => response.status() == reqwest::StatusCode::NOT_FOUND,
        Err(_) => false,
    }
}

pub enum Got {
    Verified(Vec<u8>),
    NotVerified,
    Stopped,
}

pub async fn fetch(update: &Update, mut progress: impl FnMut(Option<u8>)) -> Got {
    let mut received: u64 = 0;
    let result = update
        .download(
            |chunk, total| {
                received += chunk as u64;
                progress(
                    total
                        .filter(|t| *t > 0)
                        .map(|t| ((received * 100) / t).min(100) as u8),
                );
            },
            || {},
        )
        .await;
    match result {
        Ok(bytes) => Got::Verified(bytes),
        Err(tauri_plugin_updater::Error::Minisign(_))
        | Err(tauri_plugin_updater::Error::Base64(_))
        | Err(tauri_plugin_updater::Error::SignatureUtf8(_)) => Got::NotVerified,
        Err(_) => Got::Stopped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_feed_address_is_the_servers_own_with_the_plugins_placeholders() {
        assert_eq!(
            feed_address("https://bakery.acme.example/"),
            "https://bakery.acme.example/v1/desktop/update?target={{target}}&arch={{arch}}&current_version={{current_version}}"
        );
    }
}
