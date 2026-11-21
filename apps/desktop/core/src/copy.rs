//! What each window says and offers, as design-ux gives it (#77 slice 3, the v3 table).
//!
//! Every window is one panel with different words: a heading, a line of text, a detail box and
//! buttons. This module is only those words and the button each one maps to; how the panel looks is
//! the web page's. No window says "PKCE", "token", "callback", "loopback" or "credential", and a test
//! holds it to that.

use crate::address::{is_this_computer_address, THIS_COMPUTER};
use crate::session::{
    Availability, Chooser, ChooserProblem, Event, Mismatch, Notice, Refusal, ServerChoice, Window,
};
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
    UseDifferentServer,
    SignOut,
    /// "Continue" in the chooser: the page sends the option and the text with it.
    Continue,
    ChooseDifferent,
    UseItAnyway,
    /// "Try again" where the server is not answering.
    TryServerAgain,
    /// "How to start Bakery": opens the runbook in the browser.
    StartBakeryHelp,
    /// A link dialog's Copy: the page copies the whole link or address.
    CopyLink,
    /// A link dialog's Close or Cancel.
    Close,
    /// "Open in your browser" in the another-server dialog.
    OpenLinkInBrowser,
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
    /// A spinner with words beside it, while the app works with nothing for the person to do.
    Working {
        text: String,
    },
    Warning {
        text: String,
    },
    /// Who is signed in, and where.
    SignedIn {
        name: Option<String>,
        email: Option<String>,
        address: String,
    },
    /// The server box and, under it, when it was last asked. The sentence has a `{time}` slot that
    /// the page fills in on the person's own clock; with no time it is just the retry promise.
    ServerTried {
        address: String,
        text: String,
        at: Option<String>,
    },
    /// The server chooser's two options.
    Chooser(ChooserDetail),
}

/// What the chooser draws: the app decides the words and the state; the page owns the typing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ChooserDetail {
    pub selected: ServerChoice,
    pub this_computer_address: String,
    /// "Answering now" or "Not answering now"; nothing until it has been asked.
    pub this_computer_status: Option<String>,
    pub typed: String,
    pub help: String,
    /// The sentence under the box when the chooser stays open.
    pub problem: Option<String>,
}

/// The person who is signed in, as the server names them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Identity {
    pub name: Option<String>,
    pub email: Option<String>,
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
    /// Whether the panel shows inside the "sign in again" dialog, whose waiting step has its own
    /// sentence: the page behind it comes back as the person left it.
    pub dialog: bool,
    /// The line carried over the sign-in panel or the signed-in window.
    pub notice: Option<&'a Notice>,
    /// Who is signed in, once the server has said.
    pub identity: Option<&'a Identity>,
    /// When the server was last asked (an RFC 3339 time), where it is not answering.
    pub last_tried: Option<&'a str>,
    /// This computer's name, as the server lists the app's sign-in.
    pub computer: Option<&'a str>,
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

fn different_server_button() -> Button {
    button(
        ButtonId::UseDifferentServer,
        "Use a different server",
        false,
    )
}

/// The line over the sign-in panel or the signed-in window, if the app carries one.
fn notice_text(ctx: &Context) -> Option<String> {
    ctx.notice.map(|notice| match notice {
        Notice::Switched { address } => format!("Bakery now uses {address}."),
        Notice::SignInForLink => "Sign in to open the page from your link.".into(),
    })
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
    let sign_in = || Panel {
        notice: notice_text(ctx),
        ..panel(
            "Sign in to Bakery",
            Some("Bakery opens your browser to sign in, then brings you back here."),
            server(ctx),
            vec![sign_in_button(), different_server_button()],
        )
    };
    Some(match window {
        Window::SignIn => sign_in(),
        Window::SignedOut { ended_on_server } => Panel {
            notice: Some(if *ended_on_server {
                "You signed out. The sign-in is ended on the server and removed from this computer.".into()
            } else {
                format!(
                    "You signed out on this computer. The server did not answer, so it may still list \u{201c}Bakery app \u{b7} {}\u{201d}. Revoke it under Account and security on the web.",
                    ctx.computer.unwrap_or("this computer")
                )
            }),
            ..sign_in()
        },
        Window::Waiting => panel(
            "Finish signing in in your browser",
            Some(if ctx.dialog {
                "Confirm the sign-in there. This page comes back as you left it, with what you typed."
            } else {
                "Bakery opened your browser. Confirm the sign-in there. This window continues by itself."
            }),
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
        Window::Finishing => panel(
            "Signing you in",
            None,
            Detail::Working {
                text: "This takes a moment.".into(),
            },
            vec![],
        ),
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
            Refusal::NoKeyringStillListed => panel(
                "Bakery could not save your sign-in",
                Some("You confirmed in the browser, but this computer has no unlocked keyring to keep the sign-in in. Bakery never keeps it in a plain file."),
                Detail::Warning {
                    text: "Unlock or start your keyring, then sign in again. The unused sign-in may still be listed under Account and security on the web. Revoke it there.".into(),
                },
                vec![sign_in_button(), button(ButtonId::SetUpKeyring, "How to set up a keyring", false)],
            ),
        },
        Window::Choose { chooser } => chooser_panel(chooser, ctx),
        Window::Checking { address } => panel(
            "Checking the server",
            Some("This takes a few seconds."),
            Detail::Working { text: format!("Asking {address}") },
            vec![button(ButtonId::Cancel, "Cancel", false)],
        ),
        Window::NotAnswering => {
            let here = is_this_computer_address(ctx.server);
            let (heading, text, buttons) = if here {
                (
                    "Bakery is not running on this computer",
                    "This app is only the window. The Bakery server runs separately and has not answered. Start it, then try again.".to_string(),
                    vec![
                        button(ButtonId::TryServerAgain, "Try again", true),
                        different_server_button(),
                        button(ButtonId::StartBakeryHelp, "How to start Bakery", false),
                    ],
                )
            } else {
                (
                    "Bakery could not reach the server",
                    format!("{} did not answer. Check that it is running and that this address is right.", ctx.server),
                    vec![button(ButtonId::TryServerAgain, "Try again", true), different_server_button()],
                )
            };
            panel(
                heading,
                Some(&text),
                Detail::ServerTried {
                    address: ctx.server.into(),
                    text: if ctx.last_tried.is_some() {
                        "Last tried {time}. Bakery tries again by itself.".into()
                    } else {
                        "Bakery tries again by itself.".into()
                    },
                    at: ctx.last_tried.map(Into::into),
                },
                buttons,
            )
        }
        Window::Incompatible { mismatch, address } => panel(
            match mismatch {
                Mismatch::ServerOlder => "This server is older than this app",
                Mismatch::AppOlder => "This app is older than this server",
            },
            Some(match mismatch {
                Mismatch::ServerOlder => "Some pages may not work until the server is updated. Ask whoever runs it to update Bakery.",
                Mismatch::AppOlder => "Some pages may not work until you update Bakery on this computer.",
            }),
            Detail::Server { address: address.clone() },
            vec![
                button(ButtonId::ChooseDifferent, "Choose a different server", true),
                button(ButtonId::UseItAnyway, "Use it anyway", false),
            ],
        ),
        Window::SigningOut => panel(
            "Signing out",
            None,
            Detail::Working { text: "This takes a moment.".into() },
            vec![],
        ),
        Window::SignInAgain => panel(
            "Sign in again to continue",
            Some("Your sign-in on this computer ended. What you typed on this page is kept."),
            Detail::None,
            vec![sign_in_button(), button(ButtonId::QuitBakery, "Quit Bakery", false)],
        ),
        Window::App => Panel {
            notice: notice_text(ctx),
            ..panel(
                "You are signed in",
                None,
                match ctx.identity {
                    Some(who) if who.name.is_some() || who.email.is_some() => Detail::SignedIn {
                        name: who.name.clone(),
                        email: who.email.clone(),
                        address: ctx.server.into(),
                    },
                    _ => server(ctx),
                },
                // Neither is the next step, so neither is primary; focus goes to the heading.
                vec![different_server_button(), button(ButtonId::SignOut, "Sign out", false)],
            )
        },
    })
}

fn chooser_panel(chooser: &Chooser, ctx: &Context) -> Panel {
    let problem = chooser.problem.map(|p| {
        match p {
            ChooserProblem::Empty => "Enter the server's address.",
            ChooserProblem::NotWebAddress => "Enter a web address, for example https://bakery.example.com.",
            ChooserProblem::HasCredentials => "Remove the name and password from the address.",
            ChooserProblem::PlainHttp => "Use an address that starts with https. Plain http is only for a server on this computer.",
            ChooserProblem::NoAnswer | ChooserProblem::NotBakery => "",
        }
        .to_string()
    });
    let problem = match chooser.problem {
        Some(ChooserProblem::NoAnswer) => Some(format!(
            "{} did not answer. Check the address and that the server is running.",
            typed_address(&chooser.typed)
        )),
        Some(ChooserProblem::NotBakery) => Some(format!(
            "{} answered, but it is not a Bakery server.",
            typed_address(&chooser.typed)
        )),
        _ => problem,
    };
    panel(
        "Choose a server",
        Some(&if chooser.signed_in {
            format!(
                "You stay signed in to {} on this computer, so you can switch back without signing in again.",
                ctx.server
            )
        } else {
            "This app shows one Bakery server at a time.".to_string()
        }),
        Detail::Chooser(ChooserDetail {
            selected: chooser.selected,
            this_computer_address: THIS_COMPUTER.into(),
            this_computer_status: match chooser.this_computer {
                Availability::Unknown => None,
                Availability::Answering => Some("Answering now".into()),
                Availability::NotAnswering => Some("Not answering now".into()),
            },
            typed: chooser.typed.clone(),
            help: "For example https://bakery.example.com".into(),
            problem,
        }),
        vec![
            button(ButtonId::Continue, "Continue", true),
            button(ButtonId::Cancel, "Cancel", false),
        ],
    )
}

/// What the person typed, as the error sentence names it; the box's own words when it is empty.
fn typed_address(typed: &str) -> String {
    let trimmed = typed.trim();
    if trimmed.is_empty() {
        "That address".into()
    } else {
        trimmed.to_string()
    }
}

/// What pressing a button does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Press {
    /// Feed the state machine.
    Event(Event),
    /// The shell does it: copy the address, open the keyring help, quit.
    Shell(ButtonId),
    /// The page sends the chooser's option and text with a separate command.
    Chooser,
}

pub fn press(button: ButtonId) -> Press {
    match button {
        ButtonId::SignIn => Press::Event(Event::SignInPressed),
        ButtonId::OpenBrowserAgain | ButtonId::TryOpenAgain => {
            Press::Event(Event::OpenBrowserAgain)
        }
        ButtonId::Cancel => Press::Event(Event::CancelPressed),
        ButtonId::TryAgain => Press::Event(Event::TryExchangeAgain),
        ButtonId::UseDifferentServer => Press::Event(Event::UseDifferentServer),
        ButtonId::SignOut => Press::Event(Event::SignOutPressed),
        ButtonId::ChooseDifferent => Press::Event(Event::ChooseDifferent),
        ButtonId::UseItAnyway => Press::Event(Event::UseItAnyway),
        ButtonId::TryServerAgain => Press::Event(Event::RetryNow),
        ButtonId::Continue => Press::Chooser,
        ButtonId::CopyAddress
        | ButtonId::SetUpKeyring
        | ButtonId::QuitBakery
        | ButtonId::StartBakeryHelp
        | ButtonId::CopyLink
        | ButtonId::Close
        | ButtonId::OpenLinkInBrowser => Press::Shell(button),
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
            dialog: false,
            notice: None,
            identity: None,
            last_tried: None,
            computer: Some("Ana's laptop"),
        }
    }

    fn chooser(selected: ServerChoice, problem: Option<ChooserProblem>) -> Chooser {
        Chooser {
            selected,
            typed: "https://bakery.acme.example".into(),
            problem,
            this_computer: Availability::Answering,
            signed_in: false,
        }
    }

    fn every_window() -> Vec<Window> {
        let mut all = vec![
            Window::SignIn,
            Window::SignedOut {
                ended_on_server: true,
            },
            Window::SignedOut {
                ended_on_server: false,
            },
            Window::Waiting,
            Window::BrowserDidNotOpen,
            Window::Finishing,
            Window::SignInAgain,
            Window::Choose {
                chooser: chooser(ServerChoice::Another, None),
            },
            Window::Checking {
                address: "https://bakery.acme.example".into(),
            },
            Window::NotAnswering,
            Window::Incompatible {
                mismatch: Mismatch::ServerOlder,
                address: "https://bakery.acme.example".into(),
            },
            Window::Incompatible {
                mismatch: Mismatch::AppOlder,
                address: "https://bakery.acme.example".into(),
            },
            Window::SigningOut,
            Window::App,
        ];
        for r in [
            Refusal::Expired,
            Refusal::Cancelled,
            Refusal::Used,
            Refusal::NotFromThisApp,
            Refusal::CouldNotFinish,
            Refusal::NoKeyring,
            Refusal::NoKeyringStillListed,
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
            let has_cancel = matches!(
                window,
                Window::Waiting
                    | Window::BrowserDidNotOpen
                    | Window::Choose { .. }
                    | Window::Checking { .. }
            );
            let p = panel_for(&window, &ctx()).unwrap();
            assert_eq!(p.cancel().is_some(), has_cancel, "{window:?}");
        }
    }

    #[test]
    fn the_signed_in_window_offers_two_actions_and_neither_is_the_next_step() {
        let p = panel_for(&Window::App, &ctx()).unwrap();
        assert_eq!(p.heading, "You are signed in");
        assert_eq!(
            p.buttons
                .iter()
                .map(|b| b.label.as_str())
                .collect::<Vec<_>>(),
            vec!["Use a different server", "Sign out"]
        );
        assert!(p.primary().is_none(), "focus goes to the heading");
        // Without a name the server box stands alone; with one, who is signed in comes first.
        assert_eq!(
            p.detail,
            Detail::Server {
                address: SERVER.into()
            }
        );
        let who = Identity {
            name: Some("Ana Costa".into()),
            email: Some("ana@acme.example".into()),
        };
        let named = panel_for(
            &Window::App,
            &Context {
                identity: Some(&who),
                ..ctx()
            },
        )
        .unwrap();
        assert_eq!(
            named.detail,
            Detail::SignedIn {
                name: Some("Ana Costa".into()),
                email: Some("ana@acme.example".into()),
                address: SERVER.into()
            }
        );
        // Only one of the two known: shown on its own.
        let email_only = Identity {
            name: None,
            email: Some("ana@acme.example".into()),
        };
        let one = panel_for(
            &Window::App,
            &Context {
                identity: Some(&email_only),
                ..ctx()
            },
        )
        .unwrap();
        assert!(matches!(
            one.detail,
            Detail::SignedIn {
                name: None,
                email: Some(_),
                ..
            }
        ));
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
            "url",
            "origin",
            "host",
            "endpoint",
            "csp",
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
                Detail::Warning { text } | Detail::Working { text } => {
                    shown.push_str(&format!(" {text}"))
                }
                Detail::ServerTried { text, .. } => shown.push_str(&format!(" {text}")),
                Detail::Chooser(c) => shown.push_str(&format!(
                    " {} {} {}",
                    c.help,
                    c.this_computer_status.clone().unwrap_or_default(),
                    c.problem.clone().unwrap_or_default()
                )),
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
        let out = panel_for(
            &Window::SignedOut {
                ended_on_server: true,
            },
            &ctx(),
        )
        .unwrap();
        assert_eq!(plain.notice, None);
        assert_eq!(
            out.notice.as_deref(),
            Some("You signed out. The sign-in is ended on the server and removed from this computer.")
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
        assert!(says(Window::NotAnswering));
        let shows = |w: Window| matches!(panel_for(&w, &ctx()).unwrap().detail, Detail::Server { ref address } if address == SERVER);
        for w in [
            Window::SignIn,
            Window::SignedOut {
                ended_on_server: true,
            },
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
    fn finishing_puts_words_beside_its_spinner() {
        let p = panel_for(&Window::Finishing, &ctx()).unwrap();
        assert_eq!(
            p.detail,
            Detail::Working {
                text: "This takes a moment.".into()
            }
        );
        assert!(p.buttons.is_empty(), "nothing for the person to press");
    }

    #[test]
    fn the_dialogs_waiting_step_has_its_own_sentence_and_the_plain_window_keeps_its_own() {
        let plain = panel_for(&Window::Waiting, &ctx()).unwrap();
        let dialog = panel_for(
            &Window::Waiting,
            &Context {
                dialog: true,
                ..ctx()
            },
        )
        .unwrap();
        assert_eq!(
            plain.text.as_deref(),
            Some("Bakery opened your browser. Confirm the sign-in there. This window continues by itself.")
        );
        assert_eq!(
            dialog.text.as_deref(),
            Some("Confirm the sign-in there. This page comes back as you left it, with what you typed.")
        );
        // Everything else about the step is the same: heading, deadline and buttons.
        assert_eq!(plain.heading, dialog.heading);
        assert_eq!(plain.detail, dialog.detail);
        assert_eq!(plain.buttons, dialog.buttons);
    }

    #[test]
    fn a_refusal_inside_the_dialog_keeps_the_same_headings_and_text() {
        for r in [
            Refusal::Expired,
            Refusal::Cancelled,
            Refusal::Used,
            Refusal::NotFromThisApp,
        ] {
            let w = Window::Refusal { refusal: r };
            assert_eq!(
                panel_for(&w, &ctx()),
                panel_for(
                    &w,
                    &Context {
                        dialog: true,
                        ..ctx()
                    }
                )
            );
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
