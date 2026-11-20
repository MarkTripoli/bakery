//! The Bakery desktop app: the Tauri shell around `bakery-desktop-core` (#77, slice 3).

mod net;
mod shell;
mod store;

use bakery_desktop_core::copy::{press, ButtonId, Press};
use bakery_desktop_core::csp;
use bakery_desktop_core::platform::accept_callback;
use bakery_desktop_core::session::Event;
use bakery_desktop_core::view::View;
use serde_json::json;
use shell::Shell;
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
        Press::Shell(ButtonId::QuitBakery) => app.exit(0),
        Press::Shell(_) => {}
    }
    Ok(())
}

/// A `bakery://` address the operating system handed over. Only a sign-in answer is acted on.
fn handle_link(shell: &Arc<Shell>, raw: &str) {
    shell.report("link", json!({ "received": true }));
    if let Ok(code) = accept_callback(raw) {
        let shell = Arc::clone(shell);
        tauri::async_runtime::spawn(async move {
            shell.dispatch(Event::CallbackReceived { code }).await;
        });
    }
}

fn main() {
    let server = std::env::var("BAKERY_SERVER").unwrap_or_else(|_| "http://127.0.0.1:8000".into());
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
        .invoke_handler(tauri::generate_handler![get_view, press_button])
        .setup(move |app| {
            let shell = Shell::new(
                app.handle().clone(),
                server.clone(),
                Arc::new(store::Keyring),
            );
            app.manage(Arc::clone(&shell));
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
