//! The **Bakery** menu as the window system draws it: the words and which entries are live come

use bakery_desktop_core::menu::{self, Model};
use std::sync::Mutex;
use tauri::menu::{Menu, MenuBuilder, MenuItem, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::Wry;

pub const UPDATE_ACTION: &str = "update_action";

/// The entries that change while the app runs.
pub struct BakeryMenu {
    submenu: Submenu<Wry>,
    connected: MenuItem<Wry>,
    version: MenuItem<Wry>,
    status: MenuItem<Wry>,
    action: MenuItem<Wry>,
    sign_out: MenuItem<Wry>,
    drawn: Mutex<(bool, bool)>,
}

impl BakeryMenu {
    pub fn install(app: &tauri::AppHandle, model: &Model) -> tauri::Result<Self> {
        let connected = MenuItemBuilder::with_id("connected", &model.connected)
            .enabled(false)
            .build(app)?;
        let version = MenuItemBuilder::with_id("version", &model.update.version)
            .enabled(false)
            .build(app)?;
        let status = MenuItemBuilder::with_id("update_status", "")
            .enabled(false)
            .build(app)?;
        let action = MenuItemBuilder::with_id(UPDATE_ACTION, "").build(app)?;
        let different =
            MenuItemBuilder::with_id("use_different_server", menu::USE_DIFFERENT_SERVER)
                .build(app)?;
        let sign_out = MenuItemBuilder::with_id("sign_out", menu::SIGN_OUT)
            .enabled(model.sign_out_enabled)
            .build(app)?;
        let quit = MenuItemBuilder::with_id("quit", menu::QUIT).build(app)?;
        let submenu = SubmenuBuilder::new(app, menu::TITLE)
            .item(&connected)
            .item(&version)
            .separator()
            .item(&different)
            .item(&sign_out)
            .separator()
            .item(&quit)
            .build()?;
        let menu: Menu<Wry> = MenuBuilder::new(app).item(&submenu).build()?;
        app.set_menu(menu)?;
        let installed = Self {
            submenu,
            connected,
            version,
            status,
            action,
            sign_out,
            drawn: Mutex::new((false, false)),
        };
        installed.update(model);
        Ok(installed)
    }

    pub fn update(&self, model: &Model) {
        let _ = self.connected.set_text(&model.connected);
        let _ = self.sign_out.set_enabled(model.sign_out_enabled);
        let _ = self.version.set_text(&model.update.version);
        let mut drawn = self.drawn.lock().unwrap();
        if drawn.0 {
            let _ = self.submenu.remove(&self.status);
        }
        if drawn.1 {
            let _ = self.submenu.remove(&self.action);
        }
        let mut position = 2;
        *drawn = (false, false);
        if let Some(text) = &model.update.status {
            let _ = self.status.set_text(text);
            drawn.0 = self.submenu.insert(&self.status, position).is_ok();
            position += 1;
        }
        if let Some((label, action)) = &model.update.action {
            let _ = self.action.set_text(label);
            let _ = self.action.set_enabled(action.is_some());
            drawn.1 = self.submenu.insert(&self.action, position).is_ok();
        }
    }
}
