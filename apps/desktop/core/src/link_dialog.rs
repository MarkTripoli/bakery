//! The four dialogs a link can bring up (#77 slice 5): one that cannot be opened, one that is not a
//! web link, one for another server, and one for a browser that did not open. Words are the
//! design's (issue #77, section 3 of the slice 5 design); the page only draws them.

use crate::copy::{Button, ButtonId};
use serde::Serialize;

/// The link box shows at most this many characters, then an ellipsis. Copy copies all of it.
const SHOWN: usize = 200;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LinkDialog {
    /// A `bakery://open` link that names no page the app opens, or is malformed.
    CantOpen { link: String },
    /// A link in a page that is not a web link.
    NotWeb { scheme: String, link: String },
    /// A link for a Bakery server other than the connected one. `link` is the web address of the
    /// page on that server, which the browser opens.
    OtherServer { server: String, link: String },
    /// The system browser could not be opened.
    BrowserDidNotOpen { address: String },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct LinkDialogView {
    pub kind: &'static str,
    pub title: String,
    pub text: Vec<String>,
    /// The small label above the box, where the dialog has one.
    pub box_label: Option<String>,
    /// What the box shows: the link cut to a readable length.
    pub shown: String,
    /// All of the link or address, for Copy.
    pub full: String,
    pub buttons: Vec<Button>,
}

impl LinkDialog {
    /// What Copy puts on the clipboard, and what "Open in your browser" opens: the whole text.
    pub fn full(&self) -> &str {
        match self {
            Self::CantOpen { link } | Self::NotWeb { link, .. } | Self::OtherServer { link, .. } => {
                link
            }
            Self::BrowserDidNotOpen { address } => address,
        }
    }
}

fn cut(text: &str) -> String {
    if text.chars().count() <= SHOWN {
        text.to_string()
    } else {
        let head: String = text.chars().take(SHOWN).collect();
        format!("{head}…")
    }
}

fn button(id: ButtonId, label: &str, primary: bool) -> Button {
    Button {
        id,
        label: label.to_string(),
        primary,
    }
}

/// The dialog as the page draws it. `server` is the connected server, named in "another server".
pub fn view(dialog: &LinkDialog, server: &str) -> LinkDialogView {
    let shown = cut(dialog.full());
    let full = dialog.full().to_string();
    let page_kept = "The page you had open has not changed.";
    match dialog {
        LinkDialog::CantOpen { .. } => LinkDialogView {
            kind: "cant_open",
            title: "Bakery can't open this link".into(),
            text: vec![
                format!("It does not name a page in Bakery, so nothing was opened. {page_kept}"),
                "If someone sent it to you, ask them for a new link.".into(),
            ],
            box_label: None,
            shown,
            full,
            buttons: vec![
                button(ButtonId::CopyLink, "Copy the link", false),
                button(ButtonId::Close, "Close", true),
            ],
        },
        LinkDialog::NotWeb { scheme, .. } => LinkDialogView {
            kind: "not_web",
            title: "Bakery did not open that link".into(),
            text: vec![format!(
                "Only web links open from Bakery. This one starts with “{scheme}:”. {page_kept}"
            )],
            box_label: None,
            shown,
            full,
            buttons: vec![
                button(ButtonId::CopyLink, "Copy the link", false),
                button(ButtonId::Close, "Close", true),
            ],
        },
        LinkDialog::OtherServer { server: other, .. } => LinkDialogView {
            kind: "other_server",
            title: "This link is for another server".into(),
            text: vec![format!(
                "This app is connected to {server}. Your browser can open the link."
            )],
            box_label: Some("The link is for:".into()),
            shown: cut(other),
            full,
            buttons: vec![
                button(ButtonId::Close, "Cancel", false),
                button(ButtonId::OpenLinkInBrowser, "Open in your browser", true),
            ],
        },
        LinkDialog::BrowserDidNotOpen { .. } => LinkDialogView {
            kind: "browser_did_not_open",
            title: "Bakery could not open your browser".into(),
            text: vec!["Copy the address and paste it into a browser on this computer.".into()],
            box_label: None,
            shown,
            full,
            buttons: vec![
                button(ButtonId::Close, "Close", false),
                button(ButtonId::CopyLink, "Copy the address", true),
            ],
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://bakery.acme.example";

    fn labels(v: &LinkDialogView) -> Vec<&str> {
        v.buttons.iter().map(|b| b.label.as_str()).collect()
    }

    #[test]
    fn each_dialog_has_the_designs_title_and_buttons() {
        let cant = view(&LinkDialog::CantOpen { link: "bakery://open".into() }, SERVER);
        assert_eq!(cant.title, "Bakery can't open this link");
        assert_eq!(labels(&cant), ["Copy the link", "Close"]);
        let not_web = view(
            &LinkDialog::NotWeb { scheme: "file".into(), link: "file:///x".into() },
            SERVER,
        );
        assert_eq!(not_web.title, "Bakery did not open that link");
        assert_eq!(
            not_web.text,
            ["Only web links open from Bakery. This one starts with “file:”. The page you had open has not changed."]
        );
        let other = view(
            &LinkDialog::OtherServer { server: "https://other.example".into(), link: "https://other.example/tasks/7".into() },
            SERVER,
        );
        assert_eq!(other.title, "This link is for another server");
        assert_eq!(other.box_label.as_deref(), Some("The link is for:"));
        assert_eq!(other.shown, "https://other.example");
        assert_eq!(labels(&other), ["Cancel", "Open in your browser"]);
        let browser = view(&LinkDialog::BrowserDidNotOpen { address: "https://x.example".into() }, SERVER);
        assert_eq!(browser.title, "Bakery could not open your browser");
        assert_eq!(labels(&browser), ["Close", "Copy the address"]);
    }

    #[test]
    fn exactly_one_button_is_primary_and_it_is_the_designs_bold_one() {
        for (dialog, bold) in [
            (LinkDialog::CantOpen { link: "a".into() }, "Close"),
            (LinkDialog::NotWeb { scheme: "x".into(), link: "a".into() }, "Close"),
            (LinkDialog::OtherServer { server: "s".into(), link: "a".into() }, "Open in your browser"),
            (LinkDialog::BrowserDidNotOpen { address: "a".into() }, "Copy the address"),
        ] {
            let v = view(&dialog, SERVER);
            let primary: Vec<_> = v.buttons.iter().filter(|b| b.primary).collect();
            assert_eq!(primary.len(), 1);
            assert_eq!(primary[0].label, bold);
        }
    }

    #[test]
    fn the_box_shows_two_hundred_characters_and_copy_keeps_them_all() {
        let long = format!("bakery://open?path={}", "a".repeat(300));
        let dialog = LinkDialog::CantOpen { link: long.clone() };
        let v = view(&dialog, SERVER);
        assert_eq!(v.shown.chars().count(), 201);
        assert!(v.shown.ends_with('…'));
        assert_eq!(dialog.full(), long);
        let short = view(&LinkDialog::CantOpen { link: "bakery://open".into() }, SERVER);
        assert_eq!(short.shown, "bakery://open");
    }

    #[test]
    fn the_words_avoid_the_terms_the_design_bans() {
        let server = "https://bakery.acme.example";
        for dialog in [
            LinkDialog::CantOpen { link: "a".into() },
            LinkDialog::NotWeb { scheme: "file".into(), link: "a".into() },
            LinkDialog::OtherServer { server: "s".into(), link: "a".into() },
            LinkDialog::BrowserDidNotOpen { address: "a".into() },
        ] {
            let v = view(&dialog, server);
            let words = format!(
                "{} {} {} {}",
                v.title,
                v.text.join(" "),
                v.box_label.unwrap_or_default(),
                v.buttons.iter().map(|b| b.label.clone()).collect::<Vec<_>>().join(" ")
            );
            for banned in ["URL", "origin", "host", "deep link", "protocol", "navigation", "endpoint"] {
                assert!(!words.contains(banned), "{banned} in {words}");
            }
        }
    }
}
