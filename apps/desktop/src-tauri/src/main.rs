//! The Bakery desktop app: the Tauri shell around `bakery-desktop-core` (#77, slice 3).

mod download;
mod menu;
mod net;
mod shell;
mod store;

use bakery_desktop_core::copy::{press, ButtonId, Press};
use bakery_desktop_core::csp;
use bakery_desktop_core::link_dialog::LinkDialog;
use bakery_desktop_core::links::{navigation, open_link, page_url, Navigation};
use bakery_desktop_core::platform::accept_callback;
use bakery_desktop_core::session::{Event, ServerChoice};
use bakery_desktop_core::settings::{resolve_server, Handoff, Settings};
use bakery_desktop_core::view::View;
use serde_json::json;
use shell::{Shell, Startup};
use std::path::PathBuf;
use std::sync::Arc;
use tauri::{Manager, State};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

#[tauri::command]
fn get_view(shell: State<Arc<Shell>>) -> View {
    shell.current_view()
}

#[tauri::command]
async fn press_button(
    app: tauri::AppHandle,
    shell: State<'_, Arc<Shell>>,
    button: ButtonId,
) -> Result<(), ()> {
    match press(button) {
        Press::Event(event) => shell.inner().dispatch(event).await,
        // Copying the address is the page's; opening the help and quitting are the shell's.
        Press::Shell(ButtonId::SetUpKeyring) => {
            let _ = app.opener().open_url(shell::KEYRING_HELP_URL, None::<&str>);
        }
        Press::Shell(ButtonId::StartBakeryHelp) => {
            let _ = app
                .opener()
                .open_url(shell::START_BAKERY_HELP_URL, None::<&str>);
        }
        Press::Shell(ButtonId::QuitBakery) => app.exit(0),
        Press::Shell(ButtonId::Close) => shell.close_link_dialog(),
        Press::Shell(ButtonId::OpenLinkInBrowser) => {
            if let Some(target) = shell.link_dialog_target() {
                if app.opener().open_url(&target, None::<&str>).is_ok() {
                    shell.close_link_dialog();
                } else {
                    shell.show_link_dialog(LinkDialog::BrowserDidNotOpen { address: target });
                }
            }
        }
        // The chooser's Continue sends the option and the text with `choose_server`.
        Press::Chooser | Press::Shell(_) => {}
    }
    Ok(())
}

/// "Continue" in the chooser: what the person picked and typed.
#[tauri::command]
async fn choose_server(
    shell: State<'_, Arc<Shell>>,
    choice: ServerChoice,
    typed: String,
) -> Result<(), ()> {
    shell
        .inner()
        .dispatch(Event::ChooserContinue { choice, typed })
        .await;
    Ok(())
}

/// Where the app keeps its small files: the server the person chose and the handoff a server change
/// leaves for the next start. Nothing in them is secret.
fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("BAKERY_DESKTOP_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let home = || std::env::var("HOME").map(PathBuf::from).unwrap_or_default();
    #[cfg(target_os = "windows")]
    let base = std::env::var("APPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home());
    #[cfg(target_os = "macos")]
    let base = home().join("Library").join("Application Support");
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let base = std::env::var("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| home().join(".config"));
    base.join("bakery-desktop")
}

/// The handoff the last run left, read once and removed, so it never shows twice.
fn take_handoff(dir: &std::path::Path) -> Option<Handoff> {
    let path = dir.join(shell::HANDOFF_FILE);
    let text = std::fs::read_to_string(&path).ok()?;
    let _ = std::fs::remove_file(&path);
    Handoff::parse(&text)
}

/// What the page found out when it tried things the policy must refuse. Only written to the report
/// the test harness asks for; it does nothing otherwise.
#[tauri::command]
fn probe_result(shell: State<Arc<Shell>>, result: serde_json::Value) {
    shell.report("probe", result);
}

/// For the stills and the policy test: size the window as asked and, when asked, try the things the
/// policy must refuse. Neither is reachable unless the harness sets its environment variable.
fn test_hooks(app: &tauri::App, shell: &Arc<Shell>, server: &str) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if let Ok(size) = std::env::var("BAKERY_DESKTOP_SIZE") {
        if let Some((w, h)) = size
            .split_once('x')
            .and_then(|(w, h)| Some((w.parse::<f64>().ok()?, h.parse::<f64>().ok()?)))
        {
            let _ = window.set_size(tauri::LogicalSize::new(w, h));
        }
    }
    if let Ok(dir) = std::env::var("BAKERY_DESKTOP_COMMANDS") {
        shell.watch_commands(std::path::PathBuf::from(dir));
    }
    if std::env::var("BAKERY_DESKTOP_CSP_PROBE").is_ok() {
        let script = include_str!("probe.js").replace("__SERVER__", server);
        let window = window.clone();
        let shell = Arc::clone(shell);
        tauri::async_runtime::spawn(async move {
            // Let the page load and show its window first.
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            if window.eval(&script).is_err() {
                shell.report("probe", json!({ "error": "could not run the probe" }));
            }
        });
    }
}

/// A `bakery://` address the operating system handed over: a sign-in answer, or a page to open.
fn handle_link(shell: &Arc<Shell>, raw: &str) {
    shell.report("link", json!({ "received": true }));
    shell.bring_to_front();
    if let Ok(code) = accept_callback(raw) {
        let shell = Arc::clone(shell);
        tauri::async_runtime::spawn(async move {
            shell.dispatch(Event::CallbackReceived { code }).await;
        });
        return;
    }
    match open_link(raw) {
        Ok(link) => match link.server {
            Some(other) if !shell.is_connected_to(&other) => {
                match page_url(&other, &link.path) {
                    Some(address) => shell.show_link_dialog(LinkDialog::OtherServer {
                        server: other,
                        link: address,
                    }),
                    None => shell.show_link_dialog(LinkDialog::CantOpen { link: raw.into() }),
                }
            }
            _ => {
                let shell = Arc::clone(shell);
                tauri::async_runtime::spawn(async move { shell.open_link(link.path).await });
            }
        },
        Err(reason) => {
            shell.report("link_refused", json!({ "reason": reason }));
            shell.show_link_dialog(LinkDialog::CantOpen { link: raw.into() });
        }
    }
}

/// Every link the window is about to follow: the connected server's pages and the app's own stay,
/// another web address goes to the system browser, and nothing else is followed.
fn links_plugin(server: String) -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::<tauri::Wry>::new("links")
        .on_navigation(move |webview, url| {
            let shell = webview.try_state::<Arc<Shell>>();
            match navigation(&server, url.as_str()) {
                Navigation::Stay => true,
                Navigation::Browser => {
                    let opened = webview
                        .app_handle()
                        .opener()
                        .open_url(url.as_str(), None::<&str>)
                        .is_ok();
                    if let Some(shell) = shell {
                        shell.report("link_to_browser", json!({ "opened": opened }));
                        if !opened {
                            shell.show_link_dialog(LinkDialog::BrowserDidNotOpen {
                                address: url.to_string(),
                            });
                        }
                    }
                    false
                }
                Navigation::System => {
                    let opened = webview
                        .app_handle()
                        .opener()
                        .open_url(url.as_str(), None::<&str>)
                        .is_ok();
                    if let Some(shell) = shell {
                        shell.report("link_to_system", json!({ "opened": opened }));
                    }
                    false
                }
                Navigation::Refuse { scheme, reason } => {
                    if let Some(shell) = shell {
                        shell.report("link_refused", json!({ "reason": reason }));
                        let link = url.to_string();
                        shell.show_link_dialog(if scheme.is_empty() || scheme.starts_with("http") {
                            LinkDialog::CantOpen { link }
                        } else {
                            LinkDialog::NotWeb { scheme, link }
                        });
                    }
                    false
                }
            }
        })
        .on_page_load(|webview, payload| {
            if !matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                return;
            }
            let url = payload.url();
            if let Some(shell) = webview.try_state::<Arc<Shell>>() {
                // Where the window is, never the query: a one-use code travels in it.
                shell.report(
                    "page_loaded",
                    json!({ "host": url.host_str(), "path": url.path() }),
                );
            }
        })
        .build()
}

fn main() {
    // For the harness: print the named states the stills are taken of, and stop.
    if std::env::var("BAKERY_DESKTOP_LIST_PREVIEWS").is_ok() {
        for name in bakery_desktop_core::view::PREVIEWS {
            println!("{name}");
        }
        return;
    }
    let config_dir = config_dir();
    let settings = std::fs::read_to_string(config_dir.join("settings.json"))
        .map(|text| Settings::parse(&text))
        .unwrap_or_default();
    let handoff = take_handoff(&config_dir);
    // What the person chose in the app wins; `BAKERY_SERVER` is the setting before they choose.
    let server = resolve_server(
        settings.server.as_deref(),
        std::env::var("BAKERY_SERVER").ok().as_deref(),
    );
    let startup = Startup {
        config_dir,
        settings,
        handoff,
    };
    let mut context = tauri::generate_context!();
    // The window may connect only to itself and to the one server configured, over HTTP and
    // WebSocket. The server is known only now, so the policy is built from it here.
    if let Some(policy) = csp::policy(&server) {
        context.config_mut().app.security.csp = Some(tauri::utils::config::Csp::Policy(policy));
    }

    tauri::Builder::default()
        // The plugin's `deep-link` feature forwards a second launch's address to `on_open_url`
        // below: handling it here as well delivered every answer twice (found in the #77 spike).
        .plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(links_plugin(server.clone()))
        .on_menu_event(|app, event| {
            let Some(shell) = app.try_state::<Arc<Shell>>() else {
                return;
            };
            let shell = Arc::clone(&shell);
            match event.id().as_ref() {
                "use_different_server" => {
                    tauri::async_runtime::spawn(async move {
                        shell.dispatch(Event::UseDifferentServer).await
                    });
                }
                "sign_out" => {
                    tauri::async_runtime::spawn(async move {
                        shell.dispatch(Event::SignOutPressed).await
                    });
                }
                "quit" => app.exit(0),
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_view,
            press_button,
            choose_server,
            probe_result
        ])
        .setup(move |app| {
            // The window is made here, not by the configuration, so that a file a page offers can be
            // saved where the person chooses.
            let window_config = app
                .config()
                .app
                .windows
                .first()
                .cloned()
                .expect("a window in the configuration");
            tauri::WebviewWindowBuilder::from_config(app.handle(), &window_config)?
                .on_download(download::handler(server.clone()))
                .build()?;
            // After a server change the window comes back where it was.
            let restored = startup.handoff.as_ref().and_then(|h| h.place);
            if let (Some(place), Some(window)) = (restored, app.get_webview_window("main")) {
                let _ = window.set_size(tauri::PhysicalSize::new(place.width, place.height));
                let _ = window.set_position(tauri::PhysicalPosition::new(place.x, place.y));
            }
            let shell = Shell::new(
                app.handle().clone(),
                server.clone(),
                Arc::new(store::Keyring),
                startup,
            );
            app.manage(Arc::clone(&shell));
            shell.install_menu();
            test_hooks(app, &shell, &server);
            if let Some(place) = restored {
                shell.report(
                    "place_restored",
                    json!({ "width": place.width, "height": place.height }),
                );
            }
            shell.report(
                "app_started",
                json!({ "os": std::env::consts::OS, "arch": std::env::consts::ARCH }),
            );
            // `register` exists only on these two; macOS declares the scheme in the app bundle.
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            {
                let registered = app.deep_link().register("bakery").is_ok();
                shell.report("deep_link_registered", json!({ "ok": registered }));
            }
            // A launch that a bakery:// address itself started, and any address that arrives later.
            if let Ok(Some(urls)) = app.deep_link().get_current() {
                for url in urls {
                    handle_link(&shell, url.as_str());
                }
            }
            let for_links = Arc::clone(&shell);
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    handle_link(&for_links, url.as_str());
                }
            });
            tauri::async_runtime::spawn(async move { shell.start().await });
            Ok(())
        })
        .run(context)
        .expect("the Bakery desktop app failed to start");
}
