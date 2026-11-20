//! Carries out what the core decides. The core says what to do and what window to show; this runs
//! the effects (ask the server, open the browser, use the secret store) and feeds each result back
//! to the core as an event. No secret is ever written to a report line.

use crate::net::{Client, Exchange, Standing};
use crate::store::SecretStore;
use bakery_desktop_core::pkce::{self, Pkce};
use bakery_desktop_core::session::{step, Effect, Event, Session};
use bakery_desktop_core::view::{preview, view, View};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tauri_plugin_opener::OpenerExt;

/// How long the server keeps a sign-in request open, and so how long the app waits for the answer.
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// Where "How to set up a keyring" goes: the runbook, which says it for each Linux desktop.
pub const KEYRING_HELP_URL: &str =
    "https://github.com/MarkTripoli/bakery/blob/main/docs/runbooks/desktop-keyring.md";

struct State {
    session: Session,
    pkce: Option<Pkce>,
    credential: Option<String>,
    /// Counts started attempts, so a timer from an old attempt cannot end a newer one.
    serial: u64,
}

pub struct Shell {
    app: AppHandle,
    pub server: String,
    client: Client,
    store: Arc<dyn SecretStore>,
    state: Mutex<State>,
    /// A fixed state shown for design review and the stills: nothing is sent anywhere.
    previewing: bool,
    report_to: Option<PathBuf>,
}

fn computer_name() -> String {
    let name = std::env::var("COMPUTERNAME")
        .or_else(|_| std::env::var("HOSTNAME"))
        .ok()
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| "This computer".into());
    name.chars().take(64).collect()
}

impl Shell {
    pub fn new(app: AppHandle, server: String, store: Arc<dyn SecretStore>) -> Arc<Shell> {
        let preview_name = std::env::var("BAKERY_DESKTOP_PREVIEW").ok();
        let preview_session = preview_name.as_deref().and_then(preview);
        let previewing = preview_session.is_some();
        let session = preview_session.unwrap_or_else(|| Session::start(false));
        Arc::new(Shell {
            app,
            client: Client::new(&server),
            server,
            store,
            state: Mutex::new(State {
                session,
                pkce: None,
                credential: None,
                serial: 0,
            }),
            previewing,
            report_to: std::env::var("BAKERY_DESKTOP_REPORT")
                .ok()
                .map(PathBuf::from),
        })
    }

    /// A line in the report file, if one is set. Names and states only: never a secret.
    pub fn report(&self, event: &str, data: Value) {
        let Some(path) = &self.report_to else { return };
        let line = format!("{}\n", json!({ "event": event, "data": data }));
        if let Ok(mut f) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = f.write_all(line.as_bytes());
        }
    }

    pub fn current_view(&self) -> View {
        view(&self.state.lock().unwrap().session, &self.server)
    }

    fn push(&self) {
        let v = self.current_view();
        self.report("view", json!({ "window": v.window, "dialog": v.dialog }));
        let _ = self.app.emit("view", v);
    }

    /// At start: restore a kept sign-in and check it is still good, or show the first window.
    pub async fn start(self: &Arc<Self>) {
        if self.previewing {
            self.push();
            return;
        }
        match self.store.load(&self.server) {
            Ok(Some(credential)) => {
                {
                    let mut st = self.state.lock().unwrap();
                    st.session = Session::start(true);
                    st.credential = Some(credential.clone());
                }
                self.push();
                if let Standing::Ended = self.client.standing(&credential).await {
                    self.dispatch(Event::CredentialRejected).await;
                }
            }
            Ok(None) | Err(_) => self.push(),
        }
    }

    /// Feeds one event to the core and carries out everything it asks for, including what those
    /// results ask for in turn.
    pub async fn dispatch(self: &Arc<Self>, event: Event) {
        if self.previewing {
            return;
        }
        let mut queue = VecDeque::from([event]);
        while let Some(event) = queue.pop_front() {
            let effects = {
                let mut st = self.state.lock().unwrap();
                let (next, effects) = step(st.session.clone(), event);
                st.session = next;
                effects
            };
            self.push();
            for effect in effects {
                if let Some(follow_up) = self.run(effect).await {
                    queue.push_back(follow_up);
                }
            }
        }
    }

    async fn run(self: &Arc<Self>, effect: Effect) -> Option<Event> {
        match effect {
            Effect::StartRequest => {
                let pair = pkce::generate();
                let started = self.client.start(&pair, &computer_name()).await;
                let mut st = self.state.lock().unwrap();
                st.pkce = Some(pair);
                st.serial += 1;
                let serial = st.serial;
                drop(st);
                match started {
                    Some(s) => {
                        self.report("effect", json!({ "name": "started" }));
                        self.watch_deadline(serial);
                        Some(Event::RequestStarted {
                            id: s.id,
                            confirm_url: s.confirm_url,
                            expires_at: s.expires_at,
                        })
                    }
                    None => Some(Event::RequestFailed),
                }
            }
            Effect::OpenBrowser { url } => {
                let opened = self.app.opener().open_url(&url, None::<&str>).is_ok();
                self.report("effect", json!({ "name": "open_browser", "ok": opened }));
                Some(if opened {
                    Event::BrowserOpened
                } else {
                    Event::BrowserOpenFailed
                })
            }
            Effect::Exchange { id, code } => {
                let verifier = self
                    .state
                    .lock()
                    .unwrap()
                    .pkce
                    .as_ref()
                    .map(|p| p.verifier.clone());
                let Some(verifier) = verifier else {
                    return Some(Event::ExchangeUnreachable);
                };
                match self.client.exchange(&id, &code, &verifier).await {
                    Exchange::Issued(credential) => {
                        self.state.lock().unwrap().credential = Some(credential);
                        Some(Event::ExchangeSucceeded)
                    }
                    Exchange::Refused(failure) => Some(Event::ExchangeRefused(failure)),
                    Exchange::Unreachable => Some(Event::ExchangeUnreachable),
                }
            }
            Effect::StoreCredential => {
                let credential = self.state.lock().unwrap().credential.clone()?;
                let saved = self.store.save(&self.server, &credential).is_ok();
                self.report("effect", json!({ "name": "store", "ok": saved }));
                if !saved {
                    // Bakery never keeps the sign-in anywhere else: it is dropped.
                    self.state.lock().unwrap().credential = None;
                }
                Some(if saved {
                    Event::StoreSucceeded
                } else {
                    Event::StoreFailed
                })
            }
            Effect::ClearCredential => {
                let _ = self.store.clear(&self.server);
                let mut st = self.state.lock().unwrap();
                st.credential = None;
                st.pkce = None;
                None
            }
        }
    }

    /// Ends the wait when the request's time is up, unless a newer attempt has begun.
    fn watch_deadline(self: &Arc<Self>, serial: u64) {
        let shell = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(ATTEMPT_LIFETIME).await;
            if shell.state.lock().unwrap().serial == serial {
                shell.dispatch(Event::TimedOut).await;
            }
        });
    }
}
