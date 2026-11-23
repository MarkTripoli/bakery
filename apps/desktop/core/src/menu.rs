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
}

pub fn model(server: &str, signed_in: bool) -> Model {
    Model {
        connected: format!("Connected to {server}"),
        sign_out_enabled: signed_in,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_label_names_the_server_and_sign_out_follows_the_sign_in() {
        let m = model("https://bakery.acme.example", true);
        assert_eq!(m.connected, "Connected to https://bakery.acme.example");
        assert!(m.sign_out_enabled);
        assert!(!model("https://bakery.acme.example", false).sign_out_enabled);
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
