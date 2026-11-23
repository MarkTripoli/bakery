//! The **Bakery** menu as the window system draws it: the words and which entries are live come
//! from `bakery_desktop_core::menu`.

use bakery_desktop_core::menu::{self, Model};
use tauri::menu::{MenuBuilder, MenuItem, MenuItemBuilder, SubmenuBuilder};
use tauri::Wry;

/// The entries that change while the app runs.
pub struct BakeryMenu {
    connected: MenuItem<Wry>,
    sign_out: MenuItem<Wry>,
}

impl BakeryMenu {
    pub fn install(app: &tauri::AppHandle, model: &Model) -> tauri::Result<Self> {
        let connected = MenuItemBuilder::with_id("connected", &model.connected)
            .enabled(false)
            .build(app)?;
        let different =
            MenuItemBuilder::with_id("use_different_server", menu::USE_DIFFERENT_SERVER)
                .build(app)?;
        let sign_out = MenuItemBuilder::with_id("sign_out", menu::SIGN_OUT)
            .enabled(model.sign_out_enabled)
            .build(app)?;
        let quit = MenuItemBuilder::with_id("quit", menu::QUIT).build(app)?;
        let submenu = SubmenuBuilder::new(app, menu::TITLE)
            .item(&connected)
            .separator()
            .item(&different)
            .item(&sign_out)
            .separator()
            .item(&quit)
            .build()?;
        app.set_menu(MenuBuilder::new(app).item(&submenu).build()?)?;
        Ok(Self {
            connected,
            sign_out,
        })
    }

    pub fn update(&self, model: &Model) {
        let _ = self.connected.set_text(&model.connected);
        let _ = self.sign_out.set_enabled(model.sign_out_enabled);
    }
}
