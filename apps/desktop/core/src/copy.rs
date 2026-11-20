//! What each window says and offers, as design-ux gives it (#77 slice 3, the v3 table).
//!
//! Every window is one panel with different words: a heading, a line of text, a detail box and
//! buttons. This module is only those words and the button each one maps to; how the panel looks is
//! the web page's. No window says "PKCE", "token", "callback", "loopback" or "credential", and a test
//! holds it to that.

use crate::session::{Event, Refusal, Window};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ButtonId {
    SignIn,
    OpenBrowserAgain,
    Cancel,
    CopyAddress,
    TryOpenAgain,
    TryAgain,
    SetUpKeyring,
    QuitBakery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Button {
    pub id: ButtonId,
    pub label: String,
    /// At most one button on a window is primary; it takes focus and Enter presses it.
    pub primary: bool,
}

/// The box under the text.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Detail {
    None,
    Server {
        address: String,
    },
    Waiting {
        status: String,
        until: Option<Until>,
    },
    Address {
        address: String,
    },
    Spinner,
    Warning {
        text: String,
    },
}

/// The deadline line. The sentence has a `{time}` slot and `at` is the deadline itself: the page
/// fills the slot with the time on this person's own clock, which only the page knows reliably.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Until {
    pub text: String,
    pub at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Panel {
    /// A line above the heading, only after signing out.
    pub notice: Option<String>,
    pub heading: String,
    pub text: Option<String>,
    pub detail: Detail,
    pub buttons: Vec<Button>,
}

impl Panel {
    pub fn primary(&self) -> Option<&Button> {
        self.buttons.iter().find(|b| b.primary)
    }

    /// The button Escape presses, where there is a Cancel.
    pub fn cancel(&self) -> Option<&Button> {
        self.buttons.iter().find(|b| b.id == ButtonId::Cancel)
    }
}

/// What the words may depend on, all of it given by the app.
pub struct Context<'a> {
    pub server: &'a str,
    /// When the sign-in attempt stops being valid (an RFC 3339 time), if the server gave one.
    pub until: Option<&'a str>,
    /// The address to confirm at, shown when the browser could not be opened.
    pub address: Option<&'a str>,
}

fn button(id: ButtonId, label: &str, primary: bool) -> Button {
    Button {
        id,
        label: label.into(),
        primary,
    }
}

fn sign_in_button() -> Button {
    button(ButtonId::SignIn, "Sign in with your browser", true)
}

fn server(ctx: &Context) -> Detail {
    Detail::Server {
        address: ctx.server.into(),
    }
}

fn panel(heading: &str, text: Option<&str>, detail: Detail, buttons: Vec<Button>) -> Panel {
    Panel {
        notice: None,
        heading: heading.into(),
        text: text.map(Into::into),
        detail,
        buttons,
    }
}

/// The panel for a window, or `None` for the app itself, which is the web app's own pages.
pub fn panel_for(window: &Window, ctx: &Context) -> Option<Panel> {
    let sign_in = || {
        panel(
            "Sign in to Bakery",
            Some("Bakery opens your browser to sign in, then brings you back here."),
            server(ctx),
            vec![sign_in_button()],
        )
    };
    Some(match window {
        Window::SignIn => sign_in(),
        Window::SignedOut => Panel {
            notice: Some("You signed out. Bakery no longer has your sign-in on this computer.".into()),
            ..sign_in()
        },
        Window::Waiting => panel(
            "Finish signing in in your browser",
            Some("Bakery opened your browser. Confirm the sign-in there. This window continues by itself."),
            Detail::Waiting {
                status: "Waiting for your browser".into(),
                until: ctx.until.map(|at| Until {
                    text: "You have until {time} to confirm.".into(),
                    at: at.into(),
                }),
            },
            // No primary: the next step is in the browser.
            vec![button(ButtonId::OpenBrowserAgain, "Open the browser again", false), button(ButtonId::Cancel, "Cancel", false)],
        ),
        Window::BrowserDidNotOpen => panel(
            "Open this address in your browser",
            Some("Bakery could not open your browser. Copy the address and paste it into a browser on this computer."),
            Detail::Address { address: ctx.address.unwrap_or_default().into() },
            vec![
                button(ButtonId::CopyAddress, "Copy the address", true),
                button(ButtonId::TryOpenAgain, "Try to open the browser again", false),
                button(ButtonId::Cancel, "Cancel", false),
            ],
        ),
        Window::Finishing => panel("Signing you in", None, Detail::Spinner, vec![]),
        Window::Refusal { refusal } => match refusal {
            Refusal::Expired => panel(
                "The sign-in ran out of time",
                Some("A sign-in has to be confirmed in the browser within 10 minutes. Nothing was saved."),
                server(ctx),
                vec![sign_in_button()],
            ),
            Refusal::Cancelled => panel(
                "Sign-in was cancelled",
                Some("You pressed Cancel in the browser. Nothing was saved."),
                server(ctx),
                vec![sign_in_button()],
            ),
            Refusal::Used => panel(
                "This sign-in was already used",
                Some("Start again from here. If you did not sign in, open Account and security on the web and revoke the Bakery app."),
                server(ctx),
                vec![sign_in_button()],
            ),
            Refusal::NotFromThisApp => panel(
                "That sign-in did not come from this app",
                Some("Bakery ignored it and nothing was saved. Start again from here."),
                server(ctx),
                vec![sign_in_button()],
            ),
            Refusal::CouldNotFinish => panel(
                "Bakery could not finish signing in",
                Some(&format!("{} did not answer. Your browser step is done, so try again.", ctx.server)),
                server(ctx),
                vec![button(ButtonId::TryAgain, "Try again", true), button(ButtonId::SignIn, "Sign in with your browser", false)],
            ),
            Refusal::NoKeyring => panel(
                "Bakery could not save your sign-in",
                Some("You confirmed in the browser, but this computer has no unlocked keyring to keep the sign-in in. Bakery never keeps it in a plain file."),
                Detail::Warning { text: "Unlock or start your keyring, then sign in again.".into() },
                vec![sign_in_button(), button(ButtonId::SetUpKeyring, "How to set up a keyring", false)],
            ),
            // Not in the design's table; the first design's wording, until slice 4 owns server problems.
            Refusal::CannotStart => panel(
                &format!("Bakery could not reach {}", ctx.server),
                Some("Check that the server is running and that the address is right."),
                server(ctx),
                vec![button(ButtonId::SignIn, "Try again", true)],
            ),
        },
        Window::SignInAgain => panel(
            "Sign in again to continue",
            Some("Your sign-in on this computer ended. What you typed on this page is kept."),
            Detail::None,
            vec![sign_in_button(), button(ButtonId::QuitBakery, "Quit Bakery", false)],
        ),
        Window::App => return None,
    })
}

/// What pressing a button does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Press {
    /// Feed the state machine.
    Event(Event),
    /// The shell does it: copy the address, open the keyring help, quit.
    Shell(ButtonId),
}

pub fn press(button: ButtonId) -> Press {
    match button {
        ButtonId::SignIn => Press::Event(Event::SignInPressed),
        ButtonId::OpenBrowserAgain | ButtonId::TryOpenAgain => {
            Press::Event(Event::OpenBrowserAgain)
        }
        ButtonId::Cancel => Press::Event(Event::CancelPressed),
        ButtonId::TryAgain => Press::Event(Event::TryExchangeAgain),
        ButtonId::CopyAddress | ButtonId::SetUpKeyring | ButtonId::QuitBakery => {
            Press::Shell(button)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://bakery.example.com";
    const URL: &str = "https://bakery.example.com/api/desktop/sign-in?request=r1";

    fn ctx() -> Context<'static> {
        Context {
            server: SERVER,
            until: Some("2026-11-20T14:32:00Z"),
            address: Some(URL),
        }
    }

    fn every_window() -> Vec<Window> {
        let mut all = vec![
            Window::SignIn,
            Window::SignedOut,
            Window::Waiting,
            Window::BrowserDidNotOpen,
            Window::Finishing,
            Window::SignInAgain,
        ];
        for r in [
            Refusal::Expired,
            Refusal::Cancelled,
            Refusal::Used,
            Refusal::NotFromThisApp,
            Refusal::CouldNotFinish,
            Refusal::NoKeyring,
            Refusal::CannotStart,
        ] {
            all.push(Window::Refusal { refusal: r });
        }
        all
    }

    #[test]
    fn every_window_has_a_heading_and_at_most_one_primary_button() {
        for window in every_window() {
            let p = panel_for(&window, &ctx()).expect("a window with words");
            assert!(!p.heading.trim().is_empty(), "{window:?}");
            assert!(
                p.buttons.iter().filter(|b| b.primary).count() <= 1,
                "{window:?}"
            );
        }
    }

    #[test]
    fn the_windows_that_ask_for_a_decision_have_a_primary_button_and_the_others_have_none() {
        let primary = |w: Window| {
            panel_for(&w, &ctx())
                .unwrap()
                .primary()
                .map(|b| b.label.clone())
        };
        // Waiting has none: the next step is in the browser. Finishing has no buttons at all.
        assert_eq!(primary(Window::Waiting), None);
        assert_eq!(primary(Window::Finishing), None);
        assert_eq!(
            primary(Window::SignIn).as_deref(),
            Some("Sign in with your browser")
        );
        assert_eq!(
            primary(Window::BrowserDidNotOpen).as_deref(),
            Some("Copy the address")
        );
        assert!(panel_for(&Window::Finishing, &ctx())
            .unwrap()
            .buttons
            .is_empty());
        for r in [
            Refusal::Expired,
            Refusal::Cancelled,
            Refusal::Used,
            Refusal::NotFromThisApp,
            Refusal::NoKeyring,
        ] {
            assert_eq!(
                primary(Window::Refusal { refusal: r }).as_deref(),
                Some("Sign in with your browser")
            );
        }
        assert_eq!(
            primary(Window::Refusal {
                refusal: Refusal::CouldNotFinish
            })
            .as_deref(),
            Some("Try again")
        );
    }

    #[test]
    fn escape_reaches_cancel_only_where_the_design_has_one() {
        for window in every_window() {
            let has_cancel = matches!(window, Window::Waiting | Window::BrowserDidNotOpen);
            let p = panel_for(&window, &ctx()).unwrap();
            assert_eq!(p.cancel().is_some(), has_cancel, "{window:?}");
        }
    }

    #[test]
    fn the_app_itself_has_no_panel() {
        assert_eq!(panel_for(&Window::App, &ctx()), None);
    }

    #[test]
    fn no_window_says_a_word_the_design_bans() {
        let banned = [
            "pkce",
            "token",
            "callback",
            "loopback",
            "credential",
            "verifier",
            "bearer",
            "bkd_",
        ];
        for window in every_window() {
            let p = panel_for(&window, &ctx()).unwrap();
            let mut shown = format!(
                "{} {} {}",
                p.notice.clone().unwrap_or_default(),
                p.heading,
                p.text.clone().unwrap_or_default()
            );
            for b in &p.buttons {
                shown.push(' ');
                shown.push_str(&b.label);
            }
            match &p.detail {
                Detail::Waiting { status, until } => shown.push_str(&format!(
                    " {status} {}",
                    until.as_ref().map(|u| u.text.clone()).unwrap_or_default()
                )),
                Detail::Warning { text } => shown.push_str(&format!(" {text}")),
                _ => {}
            }
            let shown = shown.to_lowercase();
            for word in banned {
                assert!(!shown.contains(word), "{window:?} says {word:?}: {shown}");
            }
        }
    }

    #[test]
    fn the_signed_out_window_is_the_sign_in_panel_under_one_notice() {
        let plain = panel_for(&Window::SignIn, &ctx()).unwrap();
        let out = panel_for(&Window::SignedOut, &ctx()).unwrap();
        assert_eq!(plain.notice, None);
        assert_eq!(
            out.notice.as_deref(),
            Some("You signed out. Bakery no longer has your sign-in on this computer.")
        );
        assert_eq!(
            Panel {
                notice: None,
                ..out
            },
            plain
        );
    }

    #[test]
    fn waiting_names_the_deadline_only_when_the_server_gave_one() {
        let with = panel_for(&Window::Waiting, &ctx()).unwrap();
        assert_eq!(
            with.detail,
            Detail::Waiting {
                status: "Waiting for your browser".into(),
                until: Some(Until {
                    text: "You have until {time} to confirm.".into(),
                    at: "2026-11-20T14:32:00Z".into()
                })
            }
        );
        let none = panel_for(
            &Window::Waiting,
            &Context {
                until: None,
                ..ctx()
            },
        )
        .unwrap();
        assert_eq!(
            none.detail,
            Detail::Waiting {
                status: "Waiting for your browser".into(),
                until: None
            }
        );
    }

    #[test]
    fn the_server_is_named_where_the_design_names_it() {
        let says = |w: Window| {
            let p = panel_for(&w, &ctx()).unwrap();
            format!("{} {}", p.heading, p.text.unwrap_or_default()).contains(SERVER)
        };
        assert!(says(Window::Refusal {
            refusal: Refusal::CouldNotFinish
        }));
        assert!(says(Window::Refusal {
            refusal: Refusal::CannotStart
        }));
        let shows = |w: Window| matches!(panel_for(&w, &ctx()).unwrap().detail, Detail::Server { ref address } if address == SERVER);
        for w in [
            Window::SignIn,
            Window::SignedOut,
            Window::Refusal {
                refusal: Refusal::Expired,
            },
            Window::Refusal {
                refusal: Refusal::Used,
            },
        ] {
            assert!(shows(w.clone()), "{w:?}");
        }
    }

    #[test]
    fn the_address_is_shown_when_the_browser_could_not_open() {
        let p = panel_for(&Window::BrowserDidNotOpen, &ctx()).unwrap();
        assert_eq!(
            p.detail,
            Detail::Address {
                address: URL.into()
            }
        );
        assert_eq!(p.buttons.len(), 3);
    }

    #[test]
    fn the_no_keyring_window_warns_and_offers_help_without_offering_a_plain_file() {
        let p = panel_for(
            &Window::Refusal {
                refusal: Refusal::NoKeyring,
            },
            &ctx(),
        )
        .unwrap();
        assert!(p
            .text
            .as_deref()
            .unwrap()
            .contains("never keeps it in a plain file"));
        assert_eq!(
            p.detail,
            Detail::Warning {
                text: "Unlock or start your keyring, then sign in again.".into()
            }
        );
        assert!(p.buttons.iter().any(|b| b.id == ButtonId::SetUpKeyring));
    }

    #[test]
    fn each_button_does_what_its_label_says() {
        assert_eq!(press(ButtonId::SignIn), Press::Event(Event::SignInPressed));
        assert_eq!(
            press(ButtonId::OpenBrowserAgain),
            Press::Event(Event::OpenBrowserAgain)
        );
        assert_eq!(
            press(ButtonId::TryOpenAgain),
            Press::Event(Event::OpenBrowserAgain)
        );
        assert_eq!(press(ButtonId::Cancel), Press::Event(Event::CancelPressed));
        assert_eq!(
            press(ButtonId::TryAgain),
            Press::Event(Event::TryExchangeAgain)
        );
        for b in [
            ButtonId::CopyAddress,
            ButtonId::SetUpKeyring,
            ButtonId::QuitBakery,
        ] {
            assert_eq!(press(b), Press::Shell(b));
        }
    }

    #[test]
    fn the_id_the_page_sends_back_is_the_id_the_core_sent() {
        for window in every_window() {
            for b in panel_for(&window, &ctx()).unwrap().buttons {
                let sent = serde_json::to_string(&b.id).unwrap();
                let back: ButtonId = serde_json::from_str(&sent).unwrap();
                assert_eq!(back, b.id, "{sent}");
            }
        }
        assert_eq!(
            serde_json::from_str::<ButtonId>("\"copy_address\"").unwrap(),
            ButtonId::CopyAddress
        );
        assert!(serde_json::from_str::<ButtonId>("\"nonsense\"").is_err());
    }

    #[test]
    fn every_button_on_every_window_can_be_pressed() {
        for window in every_window() {
            for b in panel_for(&window, &ctx()).unwrap().buttons {
                let _ = press(b.id);
            }
        }
    }
}
