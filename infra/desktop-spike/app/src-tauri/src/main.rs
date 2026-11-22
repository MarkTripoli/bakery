//! Compatibility spike for the Bakery desktop client (#77, slice 0). Not product code.
//!
//! Proves, on a real webview, the behavior the desktop design depends on: browser
//! sign-in with PKCE (app-link and loopback callbacks), a credential kept in the OS
//! secret store, a bearer-authenticated REST call, and a live-update socket that carries
//! the credential as a subprotocol. Every observation is appended to a JSON-lines
//! report; the credential itself is never written there.

mod platform;

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use platform::{APP_LINK, CLIENT_ID};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

const KEYRING_SERVICE: &str = "com.bakery.desktop.spike";

struct Pending {
    id: String,
    verifier: String,
}

struct AppState {
    server: String,
    out: PathBuf,
    redirect_mode: String,
    pending: Mutex<Option<Pending>>,
    credential: Mutex<Option<String>>,
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

fn report(out: &PathBuf, event: &str, data: Value) {
    let _ = std::fs::create_dir_all(out);
    // One append of the whole line: several small writes interleave when two reporters race.
    let line = format!("{}\n", json!({ "t": now_ms(), "event": event, "data": data }));
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(out.join("report.jsonl"))
    {
        let _ = f.write_all(line.as_bytes());
    }
}

/// What a report may say about a credential: its visible prefix and length, never the value.
fn shape(credential: &str) -> Value {
    json!({ "prefix": credential.chars().take(4).collect::<String>(), "length": credential.len() })
}

#[tauri::command]
fn report_from_web(state: State<AppState>, event: String, data: Value) {
    report(&state.out, &format!("web:{event}"), data);
}

#[tauri::command]
fn server_origin(state: State<AppState>) -> String {
    state.server.clone()
}

/// The bearer value the web view needs for its own REST calls and socket, held in memory only.
#[tauri::command]
fn socket_credential(state: State<AppState>) -> Option<String> {
    state.credential.lock().unwrap().clone()
}

fn keyring_entry(server: &str) -> Result<keyring::Entry, keyring::Error> {
    keyring::Entry::new(KEYRING_SERVICE, server)
}

async fn http_json(
    method: reqwest::Method,
    url: &str,
    bearer: Option<&str>,
    body: Option<Value>,
) -> Result<(u16, Value), String> {
    let client = reqwest::Client::new();
    let mut req = client.request(method, url);
    if let Some(b) = bearer {
        req = req.bearer_auth(b);
    }
    if let Some(b) = body {
        req = req.json(&b);
    }
    let res = req.send().await.map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let value = res.json::<Value>().await.unwrap_or(Value::Null);
    Ok((status, value))
}

async fn start_sign_in(app: AppHandle) {
    let state = app.state::<AppState>();
    let out = state.out.clone();
    let mut raw = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = B64.encode(raw);
    let challenge = B64.encode(Sha256::digest(verifier.as_bytes()));

    // The redirect: the OS-registered app link, or a loopback listener on a free port.
    let (redirect, listener) = if state.redirect_mode == "loopback" {
        let l = TcpListener::bind("127.0.0.1:0").expect("bind loopback");
        let port = l.local_addr().unwrap().port();
        (platform::loopback_redirect(port), Some(l))
    } else {
        (APP_LINK.to_string(), None)
    };

    let body = json!({
        "clientId": CLIENT_ID,
        "codeChallenge": challenge,
        "codeChallengeMethod": "S256",
        "redirectUri": redirect,
        "computerName": std::env::var("SPIKE_COMPUTER_NAME").unwrap_or_else(|_| "Spike Linux".into()),
    });
    let started = http_json(
        reqwest::Method::POST,
        &format!("{}/v1/desktop-sign-ins", state.server),
        None,
        Some(body),
    )
    .await;
    let (status, value) = match started {
        Ok(v) => v,
        Err(e) => {
            report(&out, "start_failed", json!({ "error": e }));
            return;
        }
    };
    let (Some(id), Some(confirm)) = (value["id"].as_str(), value["confirmUrl"].as_str()) else {
        report(&out, "start_refused", json!({ "status": status, "body": value }));
        return;
    };
    *state.pending.lock().unwrap() = Some(Pending { id: id.into(), verifier });
    report(
        &out,
        "sign_in_started",
        json!({ "status": status, "id": id, "redirect": redirect, "confirmUrl": confirm,
                "challengeLength": challenge.len() }),
    );
    // The system browser. A headless container has none: the outcome is part of the evidence.
    let opened = app.opener().open_url(confirm, None::<&str>);
    report(&out, "browser_open_called", json!({ "ok": opened.is_ok(),
        "error": opened.err().map(|e| e.to_string()) }));

    if let Some(l) = listener {
        let app2 = app.clone();
        std::thread::spawn(move || {
            if let Ok((mut stream, _)) = l.accept() {
                let mut buf = [0u8; 4096];
                let n = stream.read(&mut buf).unwrap_or(0);
                let head = String::from_utf8_lossy(&buf[..n]).to_string();
                let target = head.split_whitespace().nth(1).unwrap_or("/").to_string();
                let _ = stream.write_all(
                    b"HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\nconnection: close\r\n\r\nYou can close this tab.",
                );
                let url = format!("{}{}", redirect.trim_end_matches("/callback"), target);
                tauri::async_runtime::spawn(handle_callback(app2, url));
            }
        });
    }
}

async fn handle_callback(app: AppHandle, raw: String) {
    let state = app.state::<AppState>();
    let out = state.out.clone();
    let code = match platform::accept_callback(&raw) {
        Ok(code) => code,
        Err(reason) => {
            report(&out, "callback_rejected", json!({ "reason": reason }));
            return;
        }
    };
    // One sign-in at a time, one callback per sign-in: a second delivery finds nothing pending.
    let Some(pending) = state.pending.lock().unwrap().take() else {
        report(&out, "callback_rejected", json!({ "reason": "no pending sign-in (replay or stray)" }));
        return;
    };
    let (status, value) = match http_json(
        reqwest::Method::POST,
        &format!("{}/v1/desktop-sign-ins/{}/credential", state.server, pending.id),
        None,
        Some(json!({ "clientId": CLIENT_ID, "code": code, "codeVerifier": pending.verifier })),
    )
    .await
    {
        Ok(v) => v,
        Err(e) => {
            report(&out, "exchange_failed", json!({ "error": e }));
            return;
        }
    };
    let Some(credential) = value["credential"].as_str() else {
        report(&out, "exchange_refused", json!({ "status": status, "body": value }));
        return;
    };
    report(&out, "exchanged", json!({ "status": status, "credential": shape(credential),
        "expiresAt": value["expiresAt"] }));
    match keyring_entry(&state.server).and_then(|e| e.set_password(credential)) {
        Ok(()) => report(&out, "credential_stored", json!({ "store": "secret-service" })),
        Err(e) => report(&out, "credential_store_failed", json!({ "error": e.to_string() })),
    }
    *state.credential.lock().unwrap() = Some(credential.to_string());
    announce_signed_in(&app).await;
}

/// Checks the held credential with one bearer call, then tells the web view to go live.
async fn announce_signed_in(app: &AppHandle) {
    let state = app.state::<AppState>();
    let cred = state.credential.lock().unwrap().clone();
    let Some(cred) = cred else { return };
    match http_json(reqwest::Method::GET, &format!("{}/v1/me", state.server), Some(&cred), None).await {
        Ok((200, me)) => {
            report(&state.out, "bearer_ok", json!({ "status": 200,
                "signedInAs": me.get("email").or(me.get("name")).cloned().unwrap_or(Value::Null) }));
            let _ = app.emit("signed-in", json!({}));
        }
        Ok((401, _)) | Ok((403, _)) => {
            report(&state.out, "bearer_rejected", json!({ "note": "stored sign-in no longer valid" }));
            let _ = keyring_entry(&state.server).and_then(|e| e.delete_credential());
            *state.credential.lock().unwrap() = None;
        }
        Ok((s, _)) => report(&state.out, "bearer_unexpected", json!({ "status": s })),
        Err(e) => report(&state.out, "bearer_unreachable", json!({ "error": e })),
    }
}

fn main() {
    let server = std::env::var("BAKERY_SERVER").unwrap_or_else(|_| "http://127.0.0.1:8787".into());
    let out = PathBuf::from(std::env::var("SPIKE_OUT").unwrap_or_else(|_| "/out".into()));
    let redirect_mode = std::env::var("SPIKE_REDIRECT").unwrap_or_else(|_| "applink".into());

    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            // A second launch (the OS opening bakery://...) lands here, in the first instance.
            // The plugin's `deep-link` feature forwards the URL to `on_open_url` below: handling
            // the argument here as well delivered every callback twice.
            let out = app.state::<AppState>().out.clone();
            report(&out, "second_instance", json!({ "argc": argv.len() }));
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            server,
            out,
            redirect_mode,
            pending: Mutex::new(None),
            credential: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![report_from_web, server_origin, socket_credential])
        .setup(|app| {
            let handle = app.handle().clone();
            let st = app.state::<AppState>();
            report(&st.out, "app_started", json!({
                "server": st.server, "redirectMode": st.redirect_mode,
                "os": std::env::consts::OS, "arch": std::env::consts::ARCH }));
            // `register` exists only on these two: the call is compiled out elsewhere, and a test in
            // platform.rs keeps `registers_scheme_at_runtime` in step with this condition.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let r = app.deep_link().register("bakery");
                report(&st.out, "deep_link_registered", json!({ "ok": r.is_ok(),
                    "error": r.err().map(|e| e.to_string()) }));
            }
            // A launch that was itself started by a bakery:// link (cold start).
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for u in urls {
                    tauri::async_runtime::spawn(handle_callback(handle.clone(), u.to_string()));
                }
            }
            let h2 = handle.clone();
            app.deep_link().on_open_url(move |event| {
                for u in event.urls() {
                    tauri::async_runtime::spawn(handle_callback(h2.clone(), u.to_string()));
                }
            });
            // Signed in before? Restore from the secret store and verify, else start a sign-in.
            tauri::async_runtime::spawn(async move {
                let st = handle.state::<AppState>();
                match keyring_entry(&st.server).and_then(|e| e.get_password()) {
                    Ok(cred) => {
                        report(&st.out, "credential_restored", json!({ "credential": shape(&cred) }));
                        *st.credential.lock().unwrap() = Some(cred);
                        announce_signed_in(&handle).await;
                    }
                    Err(e) => {
                        report(&st.out, "no_stored_credential", json!({ "error": e.to_string() }));
                        if std::env::var("SPIKE_AUTOSTART").ok().as_deref() != Some("0") {
                            start_sign_in(handle.clone()).await;
                        }
                    }
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the spike app");
}
