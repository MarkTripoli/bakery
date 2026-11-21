//! What the app keeps between runs apart from the sign-in itself (#77 slice 4): which server it
//! shows, the last other address used, and the small handoff that carries a window across the
//! restart a server change needs. Pure: the shell reads and writes the files and hands the text here.
//!
//! Nothing here is a secret. A file that is missing, damaged or from a future version is the same as
//! no file: the app opens on its default and says nothing alarming.

use crate::address::{parse_server_address, THIS_COMPUTER};
use serde::{Deserialize, Serialize};

/// What the person chose, kept until they choose again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Settings {
    /// The server the app shows. Absent until the person has chosen one in the app.
    #[serde(default)]
    pub server: Option<String>,
    /// The last address that was not this computer, offered again in the chooser.
    #[serde(default)]
    pub last_other: Option<String>,
}

impl Settings {
    pub fn parse(text: &str) -> Settings {
        serde_json::from_str(text).unwrap_or_default()
    }

    pub fn to_text(&self) -> String {
        serde_json::to_string_pretty(self).unwrap_or_else(|_| "{}".into())
    }

    /// The same settings after the app switched to `address`.
    pub fn after_switch(&self, address: &str) -> Settings {
        // Only the chooser's own first option is not remembered as the "other" address.
        let is_local = address == THIS_COMPUTER || crate::address::is_default_server(address);
        Settings {
            server: Some(address.to_string()),
            last_other: if is_local {
                self.last_other.clone()
            } else {
                Some(address.to_string())
            },
        }
    }
}

/// Which server the app uses: the one the person chose in the app, else `BAKERY_SERVER`, else this
/// computer. A value that is not a usable address is skipped, never trusted. What the person chose
/// follows the chooser's rules (plain http only for this computer); `BAKERY_SERVER` is the
/// operator's own setting and is only cleaned up, so a test or lab server on plain http still works.
pub fn resolve_server(saved: Option<&str>, configured: Option<&str>) -> String {
    if let Some(address) = saved.and_then(|s| parse_server_address(s).ok()) {
        return address;
    }
    if let Some(address) =
        configured.and_then(|c| crate::csp::server_origins(c.trim()).map(|(origin, _)| origin))
    {
        return address;
    }
    THIS_COMPUTER.to_string()
}

/// A window's place, kept across the restart a server change needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Place {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// Written just before the app restarts on a new server and read, once, as it opens: the window
/// comes back where it was, and the first window says which server the app now uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Handoff {
    /// The server the app switched to: the notice names it.
    pub switched_to: String,
    #[serde(default)]
    pub place: Option<Place>,
}

impl Handoff {
    pub fn parse(text: &str) -> Option<Handoff> {
        serde_json::from_str(text).ok()
    }

    pub fn to_text(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_server_the_person_chose_beats_the_configured_one_which_beats_this_computer() {
        assert_eq!(
            resolve_server(
                Some("https://bakery.example.com"),
                Some("https://other.example.com")
            ),
            "https://bakery.example.com"
        );
        assert_eq!(
            resolve_server(None, Some("https://other.example.com")),
            "https://other.example.com"
        );
        assert_eq!(resolve_server(None, None), "http://127.0.0.1:8000");
    }

    #[test]
    fn a_value_that_is_not_a_usable_address_is_skipped_never_trusted() {
        // A damaged saved choice falls back to the configured server, not to garbage.
        assert_eq!(
            resolve_server(
                Some("not an address ://"),
                Some("https://other.example.com")
            ),
            "https://other.example.com"
        );
        assert_eq!(
            resolve_server(Some("http://bakery.example.com"), None),
            "http://127.0.0.1:8000"
        );
        assert_eq!(resolve_server(Some(""), Some("")), "http://127.0.0.1:8000");
        assert_eq!(
            resolve_server(None, Some("ftp://lab.example.com")),
            "http://127.0.0.1:8000"
        );
        // What is kept is the address as the app writes it, whatever was typed into the file.
        assert_eq!(
            resolve_server(Some("bakery.example.com/tasks"), None),
            "https://bakery.example.com"
        );
    }

    #[test]
    fn the_operators_own_setting_may_use_plain_http_and_is_only_cleaned_up() {
        assert_eq!(
            resolve_server(None, Some("http://192.168.1.5:8000/")),
            "http://192.168.1.5:8000"
        );
        assert_eq!(
            resolve_server(None, Some("HTTP://Lab.Example.com:8000")),
            "http://lab.example.com:8000"
        );
        // What the person chose in the app still follows the chooser's rule.
        assert_eq!(
            resolve_server(
                Some("http://192.168.1.5:8000"),
                Some("http://lab.example.com:8000")
            ),
            "http://lab.example.com:8000"
        );
    }

    #[test]
    fn settings_survive_a_round_trip_and_a_bad_file_is_no_file() {
        let s = Settings {
            server: Some("https://bakery.example.com".into()),
            last_other: Some("https://bakery.example.com".into()),
        };
        assert_eq!(Settings::parse(&s.to_text()), s);
        for bad in ["", "not json", "[1,2]", "null", r#"{"server": 5}"#] {
            assert_eq!(Settings::parse(bad), Settings::default(), "{bad}");
        }
        // Unknown fields from a newer app are ignored, not refused.
        assert_eq!(
            Settings::parse(r#"{"server":"https://a.example.com","future":true}"#)
                .server
                .as_deref(),
            Some("https://a.example.com")
        );
    }

    #[test]
    fn switching_remembers_the_last_other_address_but_not_this_computer() {
        let start = Settings::default();
        let elsewhere = start.after_switch("https://bakery.example.com");
        assert_eq!(
            elsewhere.server.as_deref(),
            Some("https://bakery.example.com")
        );
        assert_eq!(
            elsewhere.last_other.as_deref(),
            Some("https://bakery.example.com")
        );
        // A server on this computer at another port is another server, and is remembered as such.
        let nearby = Settings::default().after_switch("http://127.0.0.1:46289");
        assert_eq!(nearby.last_other.as_deref(), Some("http://127.0.0.1:46289"));
        let back = elsewhere.after_switch("http://127.0.0.1:8000");
        assert_eq!(back.server.as_deref(), Some("http://127.0.0.1:8000"));
        assert_eq!(
            back.last_other.as_deref(),
            Some("https://bakery.example.com"),
            "kept for the chooser"
        );
    }

    #[test]
    fn the_handoff_carries_the_notice_and_the_place_and_a_damaged_one_is_nothing() {
        let h = Handoff {
            switched_to: "https://bakery.example.com".into(),
            place: Some(Place {
                x: -20,
                y: 40,
                width: 960,
                height: 640,
            }),
        };
        assert_eq!(Handoff::parse(&h.to_text()), Some(h));
        for bad in ["", "{}", "garbage", r#"{"place":null}"#] {
            assert_eq!(Handoff::parse(bad), None, "{bad}");
        }
        assert_eq!(
            Handoff::parse(r#"{"switched_to":"https://a.example.com"}"#)
                .unwrap()
                .place,
            None
        );
    }
}
