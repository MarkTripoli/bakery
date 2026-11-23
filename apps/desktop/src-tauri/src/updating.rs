use super::*;
use bakery_desktop_core::update::{self as words, Action, Say, State as UpdateState};

pub(super) const UPDATE_TOAST: u64 = u64::MAX - 7;

pub(super) struct ReadyUpdate {
    update: Box<tauri_plugin_updater::Update>,
    bytes: Vec<u8>,
    saved: Option<PathBuf>,
}

pub(super) struct Updating {
    pub state: UpdateState,
    pub last_check: Option<i64>,
    pub ready: Option<ReadyUpdate>,
    pub busy: bool,
    pub first_page: bool,
    pub page_loads: u64,
    pub updated_to: Option<String>,
    pub on_older_app_panel: bool,
}

impl Default for Updating {
    fn default() -> Self {
        Updating {
            state: UpdateState::Unavailable,
            last_check: None,
            ready: None,
            busy: false,
            first_page: false,
            page_loads: 0,
            updated_to: None,
            on_older_app_panel: false,
        }
    }
}

const AFTER_UPDATE_FILE: &str = "after-update.json";

fn now_seconds() -> i64 {
    chrono::Utc::now().timestamp()
}

fn offset_minutes() -> i32 {
    use chrono::Offset;
    chrono::Local::now().offset().fix().local_minus_utc() / 60
}

fn installs_itself() -> bool {
    !cfg!(target_os = "linux") || std::env::var("APPIMAGE").is_ok()
}

fn tone(tone: words::Tone) -> Tone {
    match tone {
        words::Tone::Information => Tone::Information,
        words::Tone::Success => Tone::Success,
        words::Tone::Error => Tone::Error,
    }
}

fn button_action(button: words::Button) -> &'static str {
    match button {
        words::Button::RestartToUpdate => "restart",
        words::Button::Later => "later",
        words::Button::ShowInFolder => "show",
        words::Button::TryAgain => "retry",
    }
}

impl Shell {
    pub(super) fn updating_state(&self) -> Option<UpdateState> {
        match self.updating.lock().unwrap().state.clone() {
            UpdateState::Unavailable => None,
            state => Some(state),
        }
    }

    pub(super) fn app_version(&self) -> String {
        self.app.package_info().version.to_string()
    }

    pub(super) fn update_menu_lines(&self) -> words::MenuLines {
        let state = self.updating.lock().unwrap().state.clone();
        words::menu_lines(&state, &self.app_version(), now_seconds(), offset_minutes())
    }

    pub fn start_updating(self: &Arc<Self>) {
        if self.previewing {
            return;
        }
        {
            let mut updating = self.updating.lock().unwrap();
            updating.state = if crate::update::has_release_key(&self.app) {
                UpdateState::Never
            } else {
                UpdateState::Unavailable
            };
            if let Ok(text) = std::fs::read_to_string(self.config_dir.join(AFTER_UPDATE_FILE)) {
                let _ = std::fs::remove_file(self.config_dir.join(AFTER_UPDATE_FILE));
                if let Ok(left) = serde_json::from_str::<serde_json::Value>(&text) {
                    updating.updated_to = left.get("to").and_then(|v| v.as_str()).map(String::from);
                    if let Some(path) = left.get("path").and_then(|v| v.as_str()) {
                        *self.pending_open.lock().unwrap() = Some(path.to_string());
                    }
                }
            }
        }
        self.push();
        let tick = std::env::var("BAKERY_DESKTOP_UPDATE_TICK_MS")
            .ok()
            .and_then(|ms| ms.parse().ok())
            .map(Duration::from_millis)
            .unwrap_or(Duration::from_secs(60));
        let shell = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            loop {
                tokio::time::sleep(tick).await;
                shell.look_if_due().await;
            }
        });
    }

    pub fn arrived_on_older_app_panel(self: &Arc<Self>) {
        let on_panel = matches!(
            self.state.lock().unwrap().session.window(),
            bakery_desktop_core::session::Window::Incompatible {
                mismatch: bakery_desktop_core::session::Mismatch::AppOlder,
                ..
            }
        );
        let start = {
            let mut updating = self.updating.lock().unwrap();
            let arrived = on_panel && !updating.on_older_app_panel;
            updating.on_older_app_panel = on_panel;
            arrived
                && !updating.busy
                && !matches!(
                    updating.state,
                    UpdateState::Unavailable
                        | UpdateState::Ready { .. }
                        | UpdateState::Downloading { .. }
                )
        };
        if start {
            let shell = Arc::clone(self);
            tauri::async_runtime::spawn(async move { shell.check_now(false).await });
        }
    }

    pub fn page_finished(self: &Arc<Self>) {
        let say_updated = {
            let mut updating = self.updating.lock().unwrap();
            updating.first_page = true;
            updating.page_loads += 1;
            if self.window_page.lock().unwrap().on_server {
                updating.updated_to.take()
            } else {
                None
            }
        };
        if let Some(version) = say_updated {
            self.say_update(&Say::Updated { version });
        }
    }

    async fn look_if_due(self: &Arc<Self>) {
        let due = {
            let updating = self.updating.lock().unwrap();
            !updating.busy
                && matches!(
                    updating.state,
                    UpdateState::Never
                        | UpdateState::UpToDate { .. }
                        | UpdateState::NoFeed { .. }
                        | UpdateState::Failed { .. }
                        | UpdateState::NotVerified { .. }
                )
                && words::check_due(now_seconds(), updating.last_check, updating.first_page)
        };
        if due {
            self.check_now(false).await;
        }
    }

    fn set_update_state(&self, state: UpdateState) {
        self.updating.lock().unwrap().state = state;
        self.push();
    }

    fn say_update(self: &Arc<Self>, say: &Say) {
        if !self.window_page.lock().unwrap().on_server {
            self.push();
            return;
        }
        let notice = words::notice(say);
        let close_only = notice.buttons.is_empty() && notice.goes_after.is_none();
        let toast = Toast {
            id: UPDATE_TOAST,
            tone: tone(notice.tone),
            text: notice.first,
            detail: notice.second,
            tooltip: None,
            actions: notice
                .buttons
                .iter()
                .map(|b| (b.label().to_string(), button_action(*b)))
                .collect(),
            goes_after: notice.goes_after,
            dismissable: close_only,
        };
        self.show_toast(toast);
    }

    fn close_update_notice(&self) {
        let script =
            format!("document.querySelector('[data-bakery-toast=\"{UPDATE_TOAST}\"]')?.remove();");
        if let Some(window) = self.app.get_webview_window("main") {
            let _ = window.eval(&script);
        }
    }

    pub async fn check_now(self: &Arc<Self>, asked: bool) {
        {
            let mut updating = self.updating.lock().unwrap();
            if updating.busy || matches!(updating.state, UpdateState::Unavailable) {
                return;
            }
            if let UpdateState::Ready { .. } = updating.state {
                drop(updating);
                if asked {
                    self.say_ready();
                }
                return;
            }
            updating.busy = true;
            updating.state = UpdateState::Looking;
        }
        self.push();
        let have = self.app_version();
        let credential = self.state.lock().unwrap().credential.clone();
        let looked = crate::update::look(&self.app, &self.server, credential.as_deref()).await;
        let now = now_seconds();
        match looked {
            crate::update::Looked::Current => {
                {
                    let mut updating = self.updating.lock().unwrap();
                    updating.last_check = Some(now);
                    updating.state = UpdateState::UpToDate { checked: now };
                }
                if asked {
                    self.say_update(&Say::UpToDateAsked { have });
                }
            }
            crate::update::Looked::NoFeed => {
                {
                    let mut updating = self.updating.lock().unwrap();
                    updating.last_check = Some(now);
                    updating.state = UpdateState::NoFeed { checked: now };
                }
                if asked {
                    self.say_update(&Say::NoFeedAsked { have });
                }
            }
            crate::update::Looked::Failed => {
                {
                    let mut updating = self.updating.lock().unwrap();
                    updating.last_check = Some(now);
                    updating.state = UpdateState::Failed { tried: now };
                }
                if asked {
                    self.say_update(&Say::CheckFailedAsked {
                        server: self.server.clone(),
                        have,
                    });
                }
            }
            crate::update::Looked::Offered(update) => {
                self.updating.lock().unwrap().last_check = Some(now);
                self.fetch_update(*update, asked).await;
            }
        }
        self.updating.lock().unwrap().busy = false;
        self.push();
        self.report("update_state", json!({ "state": self.update_state_name() }));
    }

    fn update_state_name(&self) -> &'static str {
        match self.updating.lock().unwrap().state {
            UpdateState::Unavailable => "unavailable",
            UpdateState::Never => "never",
            UpdateState::Looking => "looking",
            UpdateState::UpToDate { .. } => "up_to_date",
            UpdateState::Downloading { .. } => "downloading",
            UpdateState::Ready { .. } => "ready",
            UpdateState::Failed { .. } => "failed",
            UpdateState::NoFeed { .. } => "no_feed",
            UpdateState::NotVerified { .. } => "not_verified",
        }
    }

    async fn fetch_update(self: &Arc<Self>, update: tauri_plugin_updater::Update, asked: bool) {
        let version = update.version.clone();
        let have = self.app_version();
        self.set_update_state(UpdateState::Downloading {
            version: version.clone(),
            percent: None,
        });
        let mut last_percent: Option<u8> = None;
        let shell = Arc::clone(self);
        let progress_version = version.clone();
        let got = crate::update::fetch(&update, |percent| {
            if percent != last_percent {
                last_percent = percent;
                shell.set_update_state(UpdateState::Downloading {
                    version: progress_version.clone(),
                    percent,
                });
                if asked {
                    shell.say_update(&Say::DownloadingAsked {
                        version: progress_version.clone(),
                        percent,
                    });
                }
            }
        })
        .await;
        match got {
            crate::update::Got::Verified(bytes) => {
                let package = !installs_itself();
                let saved = if package {
                    self.save_update_file(&update, &bytes)
                } else {
                    None
                };
                let folder = saved
                    .as_ref()
                    .and_then(|path| path.parent())
                    .map(|folder| saved_file::folder_name(&folder.to_string_lossy()));
                {
                    let mut updating = self.updating.lock().unwrap();
                    updating.ready = Some(ReadyUpdate {
                        update: Box::new(update),
                        bytes,
                        saved,
                    });
                    updating.state = UpdateState::Ready {
                        version,
                        package,
                        folder,
                    };
                }
                self.say_ready();
            }
            crate::update::Got::NotVerified => {
                self.set_update_state(UpdateState::NotVerified {
                    tried: now_seconds(),
                });
                self.say_update(&Say::NotVerified { have });
            }
            crate::update::Got::Stopped => {
                self.set_update_state(UpdateState::Failed {
                    tried: now_seconds(),
                });
                if asked {
                    self.say_update(&Say::DownloadStopped { have });
                } else {
                    self.close_update_notice();
                }
            }
        }
    }

    fn save_update_file(
        &self,
        update: &tauri_plugin_updater::Update,
        bytes: &[u8],
    ) -> Option<PathBuf> {
        let folder = self.app.path().download_dir().ok()?.join("Bakery updates");
        std::fs::create_dir_all(&folder).ok()?;
        let name: String = update
            .download_url
            .path_segments()
            .and_then(|mut parts| parts.next_back())
            .unwrap_or("bakery-update")
            .chars()
            .filter(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'))
            .collect();
        let path = folder.join(if name.is_empty() {
            "bakery-update".into()
        } else {
            name
        });
        std::fs::write(&path, bytes).ok()?;
        Some(path)
    }

    fn say_ready(self: &Arc<Self>) {
        let state = self.updating.lock().unwrap().state.clone();
        if let UpdateState::Ready {
            version,
            package,
            folder,
        } = state
        {
            if package {
                self.say_update(&Say::ReadyPackage {
                    version,
                    folder: folder.unwrap_or_default(),
                });
            } else {
                self.say_update(&Say::Ready { version });
            }
        }
    }

    pub fn update_action(self: &Arc<Self>) {
        let state = self.updating.lock().unwrap().state.clone();
        let shell = Arc::clone(self);
        let action = words::menu_lines(&state, "", 0, 0)
            .action
            .and_then(|(_, action)| action);
        match action {
            Some(Action::CheckForUpdates) => {
                tauri::async_runtime::spawn(async move { shell.check_now(true).await });
            }
            Some(Action::RestartToUpdate) => {
                tauri::async_runtime::spawn(async move { shell.restart_to_update().await });
            }
            Some(Action::ShowUpdateInFolder) => self.show_update_in_folder(),
            None => {}
        }
    }

    pub fn show_update_in_folder(&self) {
        let saved = self
            .updating
            .lock()
            .unwrap()
            .ready
            .as_ref()
            .and_then(|ready| ready.saved.clone());
        if let Some(path) = saved {
            let _ = self.app.opener().reveal_item_in_dir(path);
        }
    }

    pub fn update_toast_action(self: &Arc<Self>, action: &str) {
        let shell = Arc::clone(self);
        match action {
            "restart" => {
                tauri::async_runtime::spawn(async move { shell.restart_to_update().await });
            }
            "later" => self.close_update_notice(),
            "show" => self.show_update_in_folder(),
            "retry" => {
                tauri::async_runtime::spawn(async move { shell.check_now(true).await });
            }
            _ => {}
        }
        self.report("toast_action", json!({ "action": action }));
    }

    pub async fn restart_to_update(self: &Arc<Self>) {
        let (update, bytes, version) = {
            let updating = self.updating.lock().unwrap();
            match (&updating.ready, &updating.state) {
                (
                    Some(ready),
                    UpdateState::Ready {
                        version,
                        package: false,
                        ..
                    },
                ) => (ready.update.clone(), ready.bytes.clone(), version.clone()),
                _ => return,
            }
        };
        let mut path = None;
        if self.window_page.lock().unwrap().on_server {
            if let Some(window) = self.app.get_webview_window("main") {
                if let Ok(url) = window.url() {
                    path = Some(match url.query() {
                        Some(query) => format!("{}?{query}", url.path()),
                        None => url.path().to_string(),
                    });
                    let before = self.updating.lock().unwrap().page_loads;
                    let _ = window.navigate(url);
                    let mut stayed = true;
                    for _ in 0..80 {
                        tokio::time::sleep(Duration::from_millis(250)).await;
                        if self.updating.lock().unwrap().page_loads > before {
                            stayed = false;
                            break;
                        }
                    }
                    if stayed {
                        self.report("update_restart_declined", json!({}));
                        return;
                    }
                }
            }
        }
        let left = json!({ "to": version, "path": path });
        let _ = std::fs::write(self.config_dir.join(AFTER_UPDATE_FILE), left.to_string());
        self.report("update_installing", json!({}));
        if update.install(&bytes).is_err() {
            let _ = std::fs::remove_file(self.config_dir.join(AFTER_UPDATE_FILE));
            self.set_update_state(UpdateState::Failed {
                tried: now_seconds(),
            });
            self.say_update(&Say::DownloadStopped {
                have: self.app_version(),
            });
            return;
        }
        self.app.restart();
    }
}
