//! The app's own **Bakery** menu (#77 slice 5): where switching server and signing out live once
//! the server's pages fill the window. Only the words and which entries are live are decided here.

pub const TITLE: &str = "Bakery";
pub const USE_DIFFERENT_SERVER: &str = "Use a different server…";
pub const SIGN_OUT: &str = "Sign out";
pub const QUIT: &str = "Quit";

/// What the menu shows right now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Model {
    /// "Connected to {address}": a label, never an action.
    pub connected: String,
    /// Sign out is live only while someone is signed in.
    pub sign_out_enabled: bool,
    pub update: crate::update::MenuLines,
}

pub fn model(server: &str, signed_in: bool, update: crate::update::MenuLines) -> Model {
    Model {
        connected: format!("Connected to {server}"),
        sign_out_enabled: signed_in,
        update,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn no_updates() -> crate::update::MenuLines {
        crate::update::menu_lines(&crate::update::State::Unavailable, "1.3.0", 0, 0)
    }

    #[test]
    fn the_label_names_the_server_and_sign_out_follows_the_sign_in() {
        let m = model("https://bakery.acme.example", true, no_updates());
        assert_eq!(m.connected, "Connected to https://bakery.acme.example");
        assert!(m.sign_out_enabled);
        assert!(!model("https://bakery.acme.example", false, no_updates()).sign_out_enabled);
    }

    #[test]
    fn the_menu_names_the_version_under_the_server() {
        let m = model("https://bakery.acme.example", true, no_updates());
        assert_eq!(m.update.version, "Version 1.3.0");
    }

    #[test]
    fn the_words_avoid_the_terms_the_design_bans() {
        let words = [TITLE, USE_DIFFERENT_SERVER, SIGN_OUT, QUIT];
        for word in words {
            for banned in ["URL", "origin", "host", "endpoint", "protocol"] {
                assert!(!word.contains(banned), "{word}");
            }
        }
    }
}
