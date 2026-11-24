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

pub fn feed_may_be_asked(server: &str) -> bool {
    feed_address_allowed(server, cfg!(debug_assertions))
}

fn feed_address_allowed(server: &str, debug_build: bool) -> bool {
    let Ok(address) = url::Url::parse(server) else {
        return false;
    };
    debug_build
        || address.scheme() == "https"
        || matches!(
            address.host(),
            Some(url::Host::Ipv4(host)) if host.is_loopback()
        )
        || address.host_str() == Some("localhost")
}

pub async fn look(app: &AppHandle, server: &str) -> Looked {
    if !feed_may_be_asked(server) {
        return Looked::Failed;
    }
    let Ok(url) = feed_address(server).parse() else {
        return Looked::Failed;
    };
    let builder = app.updater_builder().endpoints(vec![url]).map(|builder| {
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
            if server_answers_not_found(server).await {
                Looked::NoFeed
            } else {
                Looked::Failed
            }
        }
        Err(_) => Looked::Failed,
    }
}

async fn server_answers_not_found(server: &str) -> bool {
    let target = match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    };
    let url = format!(
        "{}/v1/desktop/update?target={target}&arch={}&current_version=0.0.0",
        server.trim_end_matches('/'),
        std::env::consts::ARCH
    );
    match reqwest::Client::new()
        .get(url)
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

    #[test]
    fn a_release_build_asks_the_feed_only_over_https_or_on_this_computer() {
        assert!(feed_address_allowed("https://bakery.acme.example", false));
        assert!(feed_address_allowed("http://127.0.0.1:8000", false));
        assert!(feed_address_allowed("http://localhost:8000", false));
        assert!(!feed_address_allowed("http://bakery.acme.example", false));
        assert!(!feed_address_allowed("http://10.0.0.5:8000", false));
        assert!(!feed_address_allowed("not an address", false));
        assert!(feed_address_allowed("http://bakery.acme.example", true));
    }

    #[tokio::test]
    async fn the_not_found_check_sends_no_authorization_header() {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let seen = std::thread::spawn(move || {
            use std::io::{Read, Write};
            let (mut stream, _) = listener.accept().unwrap();
            let mut buffer = [0u8; 4096];
            let read = stream.read(&mut buffer).unwrap();
            stream
                .write_all(
                    b"HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .unwrap();
            String::from_utf8_lossy(&buffer[..read]).to_lowercase()
        });
        assert!(server_answers_not_found(&format!("http://{address}")).await);
        let request = seen.join().unwrap();
        assert!(request.contains("/v1/desktop/update"), "{request}");
        assert!(!request.contains("authorization"), "{request}");
    }
}
