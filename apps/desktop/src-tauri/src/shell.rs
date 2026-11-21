//! Carries out what the core decides. The core says what to do and what window to show; this runs
//! the effects (ask the server, open the browser, use the secret store) and feeds each result back
//! to the core as an event. No secret is ever written to a report line.

use crate::net::{probe, Client, Exchange, Standing};
use crate::store::SecretStore;
use bakery_desktop_core::address::THIS_COMPUTER;
use bakery_desktop_core::clock::rfc3339_utc;
use bakery_desktop_core::pkce::{self, Pkce};
use bakery_desktop_core::session::{step, Effect, Event, Notice, ServerAnswer, Session};
use bakery_desktop_core::settings::{Handoff, Place, Settings};
use bakery_desktop_core::view::{preview, view, View, ViewFacts};
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_opener::OpenerExt;

use crate::menu::BakeryMenu;
use bakery_desktop_core::link_dialog::LinkDialog;

/// How long the server keeps a sign-in request open, and so how long the app waits for the answer.
const ATTEMPT_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// How long the app waits before it asks a silent server again. Quiet: nothing on screen changes
/// until the server answers.
const RETRY_AFTER: Duration = Duration::from_secs(15);

/// Where "How to start Bakery" goes: the runbook, which says it for each Linux desktop.
pub const START_BAKERY_HELP_URL: &str =
    "https://github.com/MarkTripoli/bakery/blob/main/docs/runbooks/desktop-start-bakery.md";

/// What the app was started with besides the server: where its small files live, what the person
/// chose before, and what the last run left for this one.
pub struct Startup {
    pub config_dir: PathBuf,
    pub settings: Settings,
    pub handoff: Option<Handoff>,
}

/// Where "How to set up a keyring" goes: the runbook, which says it for each Linux desktop.
pub const KEYRING_HELP_URL: &str =
    "https://github.com/MarkTripoli/bakery/blob/main/docs/runbooks/desktop-keyring.md";

struct State {
    session: Session,
    /// What the words need besides the session: who is signed in, when the server was last asked.
    facts: ViewFacts,
    pkce: Option<Pkce>,
    credential: Option<String>,
    /// True while a quiet retry is waiting, so a second one is never started beside it.
    retrying: bool,
    /// Counts started attempts, so a timer from an old attempt cannot end a newer one.
    serial: u64,
}

pub struct Shell {
    app: AppHandle,
    pub server: String,
    client: Client,
    store: Arc<dyn SecretStore>,
    state: Mutex<State>,
    /// The last view sent to the page: a view that changed nothing is not announced again, so the
    /// page does not redraw and lose the person's keyboard focus for no reason.
    last_view: Mutex<Option<View>>,
    /// A fixed state shown for design review and the stills: nothing is sent anywhere.
    previewing: bool,
    report_to: Option<PathBuf>,
    config_dir: PathBuf,
    settings: Settings,
    /// The notice a restart on a new server carries over its first window.
    handoff: Option<Handoff>,
    /// How long a silent server is left before it is asked again.
    retry_after: Duration,
    /// A page of the server a `bakery://open` link asked for, kept until the window can show the
    /// server's pages (the desktop session handoff, #77 slice 5).
    pending_open: Mutex<Option<String>>,
    /// The Bakery menu, kept in step with the view.
    menu: Mutex<Option<BakeryMenu>>,
    /// What the window shows: the server's pages, or the app's own panels. `tried` is set once a
    /// handoff has been attempted for this sign-in, so a refusal is not asked again in a loop.
    window_page: Mutex<WindowPage>,
}

#[derive(Default)]
struct WindowPage {
    on_server: bool,
    tried: bool,
}

const SETTINGS_FILE: &str = "settings.json";
pub const HANDOFF_FILE: &str = "handoff.json";

/// The session the app opens on: for this server, with the last other address to offer, and under
/// the notice a restart on a new server left.
fn fresh(server: &str, startup: &Startup, signed_in: bool) -> Session {
    let mut session = Session::start(signed_in).on_server(server);
    if let Some(other) = &startup.settings.last_other {
        session = session.with_last_other(other);
    }
    match &startup.handoff {
        Some(handoff) if handoff.switched_to == server => session.with_notice(Notice::Switched {
            address: server.to_string(),
        }),
        _ => session,
    }
}

fn place_of(window: &tauri::WebviewWindow) -> Option<Place> {
    let position = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Place {
        x: position.x,
        y: position.y,
        width: size.width,
        height: size.height,
    })
}

/// Writes a file by writing a sibling and renaming it over, so a crash never leaves half of it.
fn write_replacing(path: &std::path::Path, text: &str) -> bool {
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, text).is_ok() && std::fs::rename(&tmp, path).is_ok()
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
    pub fn new(
        app: AppHandle,
        server: String,
        store: Arc<dyn SecretStore>,
        startup: Startup,
    ) -> Arc<Shell> {
        let preview_name = std::env::var("BAKERY_DESKTOP_PREVIEW").ok();
        let named = preview_name.as_deref().and_then(preview);
        let previewing = named.is_some();
        let (session, mut facts) = match named {
            Some(p) => (p.session, p.facts),
            None => (fresh(&server, &startup, false), ViewFacts::default()),
        };
        facts.computer.get_or_insert_with(computer_name);
        let retry_after = std::env::var("BAKERY_DESKTOP_RETRY_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(RETRY_AFTER);
        Arc::new(Shell {
            app,
            client: Client::new(&server),
            server,
            store,
            state: Mutex::new(State {
                session,
                facts,
                pkce: None,
                credential: None,
                retrying: false,
                serial: 0,
            }),
            last_view: Mutex::new(None),
            previewing,
            report_to: std::env::var("BAKERY_DESKTOP_REPORT")
                .ok()
                .map(PathBuf::from),
            config_dir: startup.config_dir,
            settings: startup.settings,
            handoff: startup.handoff,
            retry_after,
            pending_open: Mutex::new(None),
            menu: Mutex::new(None),
            window_page: Mutex::new(WindowPage::default()),
        })
    }

    /// A page of the server a `bakery://open` link named, already checked. It is kept, and the last
    /// one wins, until the window can show the server's pages.
    /// Show a link's dialog over whatever the window shows. A newer one replaces an older one.
    pub fn show_link_dialog(&self, dialog: LinkDialog) {
        self.state.lock().unwrap().facts.link_dialog = Some(dialog);
        self.push();
    }

    pub fn close_link_dialog(&self) {
        self.state.lock().unwrap().facts.link_dialog = None;
        self.push();
    }

    /// What the open dialog's "Open in your browser" opens.
    pub fn link_dialog_target(&self) -> Option<String> {
        let st = self.state.lock().unwrap();
        st.facts.link_dialog.as_ref().map(|d| d.full().to_string())
    }

    /// Whether an address, already a plain origin, is the server the app is connected to.
    pub fn is_connected_to(&self, origin: &str) -> bool {
        bakery_desktop_core::csp::server_origins(&self.server)
            .is_some_and(|(own, _)| own == origin)
    }

    pub fn request_open(&self, path: String) {
        self.report("link_open_requested", json!({ "path": path }));
        *self.pending_open.lock().unwrap() = Some(path);
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
        let st = self.state.lock().unwrap();
        view(&st.session, &st.facts)
    }

    /// Install the Bakery menu and keep it in step from now on.
    pub fn install_menu(&self) {
        let model = self.menu_model();
        match BakeryMenu::install(&self.app, &model) {
            Ok(menu) => *self.menu.lock().unwrap() = Some(menu),
            Err(_) => self.report("menu_failed", json!({})),
        }
    }

    fn menu_model(&self) -> bakery_desktop_core::menu::Model {
        let st = self.state.lock().unwrap();
        bakery_desktop_core::menu::model(st.session.shown_server(), st.session.is_signed_in())
    }

    fn push(&self) {
        if let Some(menu) = &*self.menu.lock().unwrap() {
            menu.update(&self.menu_model());
        }
        let v = self.current_view();
        {
            let mut last = self.last_view.lock().unwrap();
            if last.as_ref() == Some(&v) {
                return;
            }
            *last = Some(v.clone());
        }
        // The notice is words and an address, never a secret, so a run can check what the window carried.
        self.report(
            "view",
            json!({
                "window": v.window,
                "dialog": v.dialog,
                "notice": v.panel.as_ref().and_then(|p| p.notice.clone()),
                "link_dialog": v.link_dialog.as_ref().map(|d| d.kind),
            }),
        );
        let _ = self.app.emit("view", v);
    }

    /// At start: restore a kept sign-in, show the first window, ask whether the server answers, and
    /// check a kept sign-in is still good.
    pub async fn start(self: &Arc<Self>) {
        if self.previewing {
            self.push();
            return;
        }
        let kept = match self.store.load(&self.server) {
            Ok(Some(credential)) => Some(credential),
            Ok(None) | Err(_) => None,
        };
        {
            let mut st = self.state.lock().unwrap();
            st.session = fresh(&self.server, &self.startup_view(), kept.is_some());
            st.credential = kept.clone();
        }
        self.push();
        // Whether the server answers is asked as the app opens, with or without a kept sign-in.
        let opening = self.state.lock().unwrap().session.opened();
        for effect in opening {
            if let Some(follow_up) = self.run(effect).await {
                self.dispatch(follow_up).await;
            }
        }
        if let Some(credential) = kept {
            match self.client.standing(&credential).await {
                Standing::Good(identity) => {
                    self.state.lock().unwrap().facts.identity = Some(identity);
                    self.push();
                }
                Standing::Ended => self.dispatch(Event::CredentialRejected).await,
                Standing::Unknown => {}
            }
        }
        self.sync_window().await;
    }

    /// What `fresh` needs from startup, rebuilt from the fields kept for it.
    fn startup_view(&self) -> Startup {
        Startup {
            config_dir: self.config_dir.clone(),
            settings: self.settings.clone(),
            handoff: self.handoff.clone(),
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
        self.sync_window().await;
    }

    /// Keeps the window on the right page: the server's pages while someone is signed in, the app's
    /// own panels at every other time. The sign-in's one-use code is asked for here and used at once.
    pub async fn sync_window(self: &Arc<Self>) {
        if self.previewing {
            return;
        }
        let (signed_in, credential) = {
            let st = self.state.lock().unwrap();
            (st.session.is_signed_in(), st.credential.clone())
        };
        let (on_server, tried) = {
            let page = self.window_page.lock().unwrap();
            (page.on_server, page.tried)
        };
        if signed_in && !on_server && !tried {
            self.window_page.lock().unwrap().tried = true;
            let Some(credential) = credential else { return };
            let path = self.pending_open.lock().unwrap().take().unwrap_or_else(|| "/".into());
            match self.client.create_handoff(&credential, &path).await {
                Some(code) => {
                    let url = format!("{}/api/desktop/handoff?code={code}", self.server.trim_end_matches('/'));
                    if self.navigate(&url) {
                        self.window_page.lock().unwrap().on_server = true;
                        self.report("server_page_opened", json!({ "path": path }));
                        let shell = Arc::clone(self);
                        std::thread::spawn(move || shell.watch_server_page());
                    }
                }
                None => {
                    // The signed-in panel stays; the page is asked for again at the next sign-in.
                    self.report("handoff_failed", json!({}));
                }
            }
        } else if !signed_in {
            let was_on_server = {
                let mut page = self.window_page.lock().unwrap();
                page.tried = false;
                std::mem::replace(&mut page.on_server, false)
            };
            if was_on_server {
                let origin = bakery_desktop_core::platform::web_view_origin(std::env::consts::OS);
                self.navigate(&format!("{origin}/"));
                self.report("panels_shown", json!({}));
            }
        }
    }

    /// While the server's pages are in the window, watches which page it is on. The web's own Sign
    /// out, or a sign-in page after a good page was shown, means the person signed out of the web:
    /// the app ends its own sign-in the same way slice 4's Sign out does. The pages cannot talk to
    /// the app, and a route change inside the page is not a navigation, so the address is read.
    fn watch_server_page(self: Arc<Self>) {
        let mut shown_a_page = false;
        loop {
            std::thread::sleep(Duration::from_millis(700));
            if !self.window_page.lock().unwrap().on_server {
                return;
            }
            let Some(window) = self.app.get_webview_window("main") else { return };
            let Ok(url) = window.url() else { continue };
            let path = url.path();
            let sign_in_or_out = path == "/sign-in" || path.starts_with("/sign-in/") || path == "/sign-out";
            if !sign_in_or_out {
                shown_a_page = true;
            } else if shown_a_page {
                self.report("web_sign_out_seen", json!({}));
                tauri::async_runtime::block_on(self.dispatch(Event::SignOutPressed));
                return;
            }
        }
    }

    fn navigate(&self, url: &str) -> bool {
        let Some(window) = self.app.get_webview_window("main") else { return false };
        match url.parse() {
            Ok(parsed) => window.navigate(parsed).is_ok(),
            Err(_) => false,
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
                // The address is what the browser is meant to open: it names the request, never a secret.
                self.report(
                    "effect",
                    json!({ "name": "open_browser", "ok": opened, "url": url }),
                );
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
                // Prove the keyring works before the server is asked for a sign-in: one it issues
                // to an app that cannot keep it would stay live with nobody holding it.
                if self.store.probe(&self.server).is_err() {
                    self.report("effect", json!({ "name": "keyring_probe", "ok": false }));
                    return Some(Event::KeyringUnavailable);
                }
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
                // A sign-in that could not be kept stays in memory only long enough to be ended on
                // the server; it is never written anywhere else.
                Some(if saved {
                    Event::StoreSucceeded
                } else {
                    Event::StoreFailed
                })
            }
            Effect::RevokeUnstored => {
                let credential = self.state.lock().unwrap().credential.take();
                let ended = match credential {
                    Some(credential) => self.client.revoke_current(&credential).await,
                    None => false,
                };
                self.report(
                    "effect",
                    json!({ "name": "revoke_unstored", "ended": ended }),
                );
                Some(Event::UnstoredRevoked {
                    ended_on_server: ended,
                })
            }
            Effect::SignOutRemote => {
                let credential = self.state.lock().unwrap().credential.clone();
                // Ended on the server first, with five seconds to answer; removed here whatever it says.
                let ended = match &credential {
                    Some(credential) => self.client.revoke_current(credential).await,
                    None => false,
                };
                let _ = self.store.clear(&self.server);
                {
                    let mut st = self.state.lock().unwrap();
                    st.credential = None;
                    st.pkce = None;
                    st.facts.identity = None;
                }
                self.report("effect", json!({ "name": "sign_out", "ended": ended }));
                Some(Event::SignedOutRemote {
                    ended_on_server: ended,
                })
            }
            Effect::CheckCurrent => {
                let answer = probe(&self.server).await;
                self.note_tried();
                let answered = !matches!(answer, ServerAnswer::NoAnswer);
                self.report(
                    "effect",
                    json!({ "name": "check_current", "answered": answered }),
                );
                Some(Event::CurrentChecked { answered })
            }
            Effect::CheckThisComputer => {
                let answering = !matches!(probe(THIS_COMPUTER).await, ServerAnswer::NoAnswer);
                self.report(
                    "effect",
                    json!({ "name": "check_this_computer", "answering": answering }),
                );
                Some(Event::ThisComputerChecked { answering })
            }
            Effect::CheckServer { address } => {
                let answer = probe(&address).await;
                self.note_tried();
                self.report(
                    "effect",
                    json!({ "name": "check_server", "address": address, "answered": answer != ServerAnswer::NoAnswer }),
                );
                Some(Event::ServerChecked { address, answer })
            }
            Effect::SwitchServer { address } => {
                self.switch_server(&address);
                None
            }
            Effect::ScheduleRetry => {
                self.schedule_retry();
                None
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

    /// Remembers when the server was last asked, for the "last tried" line.
    fn note_tried(&self) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        self.state.lock().unwrap().facts.last_tried = Some(rfc3339_utc(now));
        self.push();
    }

    /// Asks a silent server again after a quiet wait. One timer at a time; the core ignores a tick
    /// that comes when the window is no longer the silent-server one.
    fn schedule_retry(self: &Arc<Self>) {
        {
            let mut st = self.state.lock().unwrap();
            if st.retrying {
                return;
            }
            st.retrying = true;
        }
        let shell = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            tokio::time::sleep(shell.retry_after).await;
            shell.state.lock().unwrap().retrying = false;
            shell.dispatch(Event::RetryTick).await;
        });
    }

    /// Keeps the new server and the window's place, then restarts on it. The restart is needed
    /// because the window's connection rule is fixed when the app starts. The window comes back in
    /// the same place, under the notice that the app now uses the server.
    fn switch_server(&self, address: &str) {
        let settings = self.settings.after_switch(address);
        let place = self
            .app
            .get_webview_window("main")
            .and_then(|w| place_of(&w));
        let handoff = Handoff {
            switched_to: address.to_string(),
            place,
        };
        let kept = std::fs::create_dir_all(&self.config_dir).is_ok()
            && write_replacing(&self.config_dir.join(SETTINGS_FILE), &settings.to_text())
            && write_replacing(&self.config_dir.join(HANDOFF_FILE), &handoff.to_text());
        self.report(
            "effect",
            json!({ "name": "switch_server", "address": address, "kept": kept, "place": place }),
        );
        if kept {
            self.app.restart();
        }
    }

    /// For the end-to-end harness only: presses a button when a file named `press-<button>` appears
    /// in `dir`, so a run can drive the windows without a person. Set up only when the harness asks.
    pub fn watch_commands(self: &Arc<Self>, dir: PathBuf) {
        let shell = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_millis(200)).await;
                let Ok(entries) = std::fs::read_dir(&dir) else {
                    continue;
                };
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    // `choose-this_computer` or `choose-another`; the file's text is what was typed.
                    if let Some(which) = name.strip_prefix("choose-") {
                        let typed = std::fs::read_to_string(entry.path()).unwrap_or_default();
                        let _ = std::fs::remove_file(entry.path());
                        if let Ok(choice) = serde_json::from_str::<
                            bakery_desktop_core::session::ServerChoice,
                        >(&format!("\"{which}\""))
                        {
                            shell.report("command", json!({ "choose": which }));
                            shell
                                .dispatch(Event::ChooserContinue {
                                    choice,
                                    typed: typed.trim().to_string(),
                                })
                                .await;
                        }
                        continue;
                    }
                    // `eval-<anything>`: the file's text runs in the window, as a person's click would
                    // act in a page. Harness only.
                    if name.starts_with("eval-") {
                        let script = std::fs::read_to_string(entry.path()).unwrap_or_default();
                        let _ = std::fs::remove_file(entry.path());
                        let ran = shell
                            .app
                            .get_webview_window("main")
                            .is_some_and(|w| w.eval(&script).is_ok());
                        shell.report("command", json!({ "eval": ran }));
                        continue;
                    }
                    let Some(id) = name.strip_prefix("press-") else {
                        continue;
                    };
                    let _ = std::fs::remove_file(entry.path());
                    let Ok(button) = serde_json::from_str::<bakery_desktop_core::copy::ButtonId>(
                        &format!("\"{id}\""),
                    ) else {
                        continue;
                    };
                    shell.report("command", json!({ "press": id }));
                    if let bakery_desktop_core::copy::Press::Event(event) =
                        bakery_desktop_core::copy::press(button)
                    {
                        shell.dispatch(event).await;
                    }
                }
            }
        });
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
