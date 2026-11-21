//! What the page is told to show: the window, its panel, and whether it sits inside the dialog.
//! Also the named states the Linux stills are taken of, each one reached by driving the real state
//! machine, so a still cannot show a state the app cannot reach.

use crate::compat::Kind;
use crate::copy::{panel_for, Context, Identity, Panel};
use crate::session::{
    step, Availability, ChooserProblem, Event, Notice, ServerAnswer, ServerChoice, Session, Window,
};
use crate::wire::ExchangeFailure;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub window: Window,
    /// Every window has a panel; the web app's own pages replace the signed-in one later.
    pub panel: Option<Panel>,
    /// True when the panel shows inside the "sign in again" dialog over the kept page.
    pub dialog: bool,
}

/// What the words depend on besides the session: all of it known by the app, never by the page.
#[derive(Debug, Clone, Default)]
pub struct ViewFacts {
    pub identity: Option<Identity>,
    /// When the server was last asked (an RFC 3339 time).
    pub last_tried: Option<String>,
    /// This computer's name, as the server lists the app's sign-in.
    pub computer: Option<String>,
}

pub fn view(session: &Session, facts: &ViewFacts) -> View {
    let ctx = Context {
        server: session.shown_server(),
        until: session.expires_at(),
        address: session.confirm_url(),
        dialog: session.in_dialog(),
        notice: session.notice(),
        identity: facts.identity.as_ref(),
        last_tried: facts.last_tried.as_deref(),
        computer: facts.computer.as_deref(),
    };
    View {
        window: session.window().clone(),
        panel: panel_for(session.window(), &ctx),
        dialog: session.in_dialog(),
    }
}

const URL: &str = "https://bakery.example.com/api/desktop/sign-in?request=preview";
const UNTIL: &str = "2026-11-20T14:32:00Z";
const TRIED: &str = "2026-11-20T14:25:00Z";
/// The server every preview but the local ones talks to.
const SERVER: &str = "https://bakery.acme.example";
const LOCAL: &str = "http://127.0.0.1:8000";
const OTHER: &str = "https://bakery.example.com";

fn run(events: Vec<Event>) -> Session {
    run_on(Session::start(false).on_server(SERVER), events)
}

fn run_on(session: Session, events: Vec<Event>) -> Session {
    events.into_iter().fold(session, |s, e| step(s, e).0)
}

fn started() -> Event {
    Event::RequestStarted {
        id: "preview".into(),
        confirm_url: URL.into(),
        expires_at: Some(UNTIL.into()),
    }
}

fn waiting_events() -> Vec<Event> {
    vec![Event::SignInPressed, started(), Event::BrowserOpened]
}

fn exchanging_events() -> Vec<Event> {
    let mut e = waiting_events();
    e.push(Event::CallbackReceived {
        code: "preview".into(),
    });
    e
}

fn then(mut events: Vec<Event>, more: Vec<Event>) -> Vec<Event> {
    events.extend(more);
    events
}

/// The ended-sign-in dialog, reached the way it is reached: signed in, then the server says no.
fn ended() -> Vec<Event> {
    then(
        exchanging_events(),
        vec![
            Event::ExchangeSucceeded,
            Event::StoreSucceeded,
            Event::CredentialRejected,
        ],
    )
}

/// A state reached by pressing Use a different server and typing nothing yet.
fn chooser_events(this_computer: bool) -> Vec<Event> {
    vec![
        Event::UseDifferentServer,
        Event::ThisComputerChecked {
            answering: this_computer,
        },
    ]
}

fn typed(choice: ServerChoice, text: &str) -> Event {
    Event::ChooserContinue {
        choice,
        typed: text.into(),
    }
}

/// A named state: the session, and what the words need besides it.
pub struct Preview {
    pub session: Session,
    pub facts: ViewFacts,
}

fn plain(session: Session) -> Preview {
    Preview {
        session,
        facts: ViewFacts::default(),
    }
}

fn who() -> Identity {
    Identity {
        name: Some("Ana Costa".into()),
        email: Some("ana@acme.example".into()),
    }
}

/// Every named state, in the design's order.
pub const PREVIEWS: &[&str] = &[
    "sign-in",
    "signed-out",
    "signed-out-unconfirmed",
    "waiting",
    "browser-did-not-open",
    "finishing",
    "expired",
    "cancelled",
    "used",
    "not-from-this-app",
    "could-not-finish",
    "no-keyring",
    "no-keyring-still-listed",
    "sign-in-again",
    "sign-in-again-waiting",
    "sign-in-again-expired",
    "signed-in",
    "signed-in-email-only",
    "signing-out",
    "choose-server",
    "choose-server-this-computer",
    "choose-server-this-computer-down",
    "choose-server-signed-in",
    "choose-server-empty",
    "choose-server-not-web",
    "choose-server-credentials",
    "choose-server-plain-http",
    "choose-server-no-answer",
    "choose-server-signed-in-no-answer",
    "choose-server-not-bakery",
    "checking",
    "switched",
    "switched-signed-in",
    "not-running",
    "cannot-reach",
    "older-server",
    "older-app",
];

/// The named state, or `None` for a name that is not one.
pub fn preview(name: &str) -> Option<Preview> {
    let signed_in_here = || Session::start(true).on_server(SERVER);
    let local = || Session::start(false).on_server(LOCAL);
    let choose =
        |session: Session, this_computer: bool| run_on(session, chooser_events(this_computer));
    Some(match name {
        "sign-in" => plain(run(vec![])),
        "signed-out" => plain(run_on(
            signed_in_here(),
            vec![
                Event::SignOutPressed,
                Event::SignedOutRemote {
                    ended_on_server: true,
                },
            ],
        )),
        "signed-out-unconfirmed" => Preview {
            session: run_on(
                signed_in_here(),
                vec![
                    Event::SignOutPressed,
                    Event::SignedOutRemote {
                        ended_on_server: false,
                    },
                ],
            ),
            facts: ViewFacts {
                computer: Some("Ana's laptop".into()),
                ..Default::default()
            },
        },
        "waiting" => plain(run(waiting_events())),
        "browser-did-not-open" => plain(run(then(
            vec![Event::SignInPressed, started()],
            vec![Event::BrowserOpenFailed],
        ))),
        "finishing" => plain(run(exchanging_events())),
        "expired" => plain(run(then(waiting_events(), vec![Event::TimedOut]))),
        "cancelled" => plain(run(then(
            exchanging_events(),
            vec![Event::ExchangeRefused(ExchangeFailure::Cancelled)],
        ))),
        "used" => plain(run(then(
            exchanging_events(),
            vec![Event::ExchangeRefused(ExchangeFailure::Used)],
        ))),
        "not-from-this-app" => plain(run(then(
            exchanging_events(),
            vec![Event::ExchangeRefused(ExchangeFailure::Mismatch)],
        ))),
        "could-not-finish" => plain(run(then(
            exchanging_events(),
            vec![Event::ExchangeUnreachable],
        ))),
        "no-keyring" => plain(run(then(
            exchanging_events(),
            vec![
                Event::ExchangeSucceeded,
                Event::StoreFailed,
                Event::UnstoredRevoked {
                    ended_on_server: true,
                },
            ],
        ))),
        "no-keyring-still-listed" => plain(run(then(
            exchanging_events(),
            vec![
                Event::ExchangeSucceeded,
                Event::StoreFailed,
                Event::UnstoredRevoked {
                    ended_on_server: false,
                },
            ],
        ))),
        "sign-in-again" => plain(run(ended())),
        "sign-in-again-waiting" => plain(run(then(ended(), waiting_events()))),
        "sign-in-again-expired" => plain(run(then(
            ended(),
            then(waiting_events(), vec![Event::TimedOut]),
        ))),
        "signed-in" => Preview {
            session: signed_in_here(),
            facts: ViewFacts {
                identity: Some(who()),
                ..Default::default()
            },
        },
        "signed-in-email-only" => Preview {
            session: signed_in_here(),
            facts: ViewFacts {
                identity: Some(Identity {
                    name: None,
                    email: Some("ana@acme.example".into()),
                }),
                ..Default::default()
            },
        },
        "signing-out" => plain(run_on(signed_in_here(), vec![Event::SignOutPressed])),
        "choose-server" => plain(choose(run(vec![]), true)),
        "choose-server-this-computer" => plain(choose(local(), true)),
        "choose-server-this-computer-down" => plain(choose(run(vec![]), false)),
        "choose-server-signed-in" => Preview {
            session: choose(signed_in_here(), true),
            facts: ViewFacts {
                identity: Some(who()),
                ..Default::default()
            },
        },
        "choose-server-empty" => plain(run_on(
            choose(run(vec![]), true),
            vec![typed(ServerChoice::Another, "   ")],
        )),
        "choose-server-not-web" => plain(run_on(
            choose(run(vec![]), true),
            vec![typed(ServerChoice::Another, "ftp://bakery.example.com")],
        )),
        "choose-server-credentials" => plain(run_on(
            choose(run(vec![]), true),
            vec![typed(
                ServerChoice::Another,
                "https://ana:secret@bakery.example.com",
            )],
        )),
        "choose-server-plain-http" => plain(run_on(
            choose(run(vec![]), true),
            vec![typed(ServerChoice::Another, "http://bakery.example.com")],
        )),
        "choose-server-no-answer" => plain(run_on(
            choose(run(vec![]), true),
            vec![
                typed(ServerChoice::Another, OTHER),
                Event::ServerChecked {
                    address: OTHER.into(),
                    answer: ServerAnswer::NoAnswer,
                },
            ],
        )),
        "choose-server-signed-in-no-answer" => Preview {
            session: run_on(
                choose(signed_in_here(), true),
                vec![
                    typed(ServerChoice::Another, OTHER),
                    Event::ServerChecked {
                        address: OTHER.into(),
                        answer: ServerAnswer::NoAnswer,
                    },
                ],
            ),
            facts: ViewFacts {
                identity: Some(who()),
                ..Default::default()
            },
        },
        "choose-server-not-bakery" => plain(run_on(
            choose(run(vec![]), true),
            vec![
                typed(ServerChoice::Another, OTHER),
                Event::ServerChecked {
                    address: OTHER.into(),
                    answer: ServerAnswer::Answered(Kind::NotBakery),
                },
            ],
        )),
        "checking" => plain(run_on(
            choose(run(vec![]), true),
            vec![typed(ServerChoice::Another, OTHER)],
        )),
        "switched" => plain(
            Session::start(false)
                .on_server(OTHER)
                .with_notice(Notice::Switched {
                    address: OTHER.into(),
                }),
        ),
        "switched-signed-in" => Preview {
            session: Session::start(true)
                .on_server(OTHER)
                .with_notice(Notice::Switched {
                    address: OTHER.into(),
                }),
            facts: ViewFacts {
                identity: Some(who()),
                ..Default::default()
            },
        },
        "not-running" => Preview {
            session: run_on(local(), vec![Event::CurrentChecked { answered: false }]),
            facts: ViewFacts {
                last_tried: Some(TRIED.into()),
                ..Default::default()
            },
        },
        "cannot-reach" => Preview {
            session: run_on(run(vec![]), vec![Event::CurrentChecked { answered: false }]),
            facts: ViewFacts {
                last_tried: Some(TRIED.into()),
                ..Default::default()
            },
        },
        "older-server" => plain(run_on(
            choose(run(vec![]), true),
            vec![
                typed(ServerChoice::Another, OTHER),
                Event::ServerChecked {
                    address: OTHER.into(),
                    answer: ServerAnswer::Answered(Kind::ServerOlder),
                },
            ],
        )),
        "older-app" => plain(run_on(
            choose(run(vec![]), true),
            vec![
                typed(ServerChoice::Another, OTHER),
                Event::ServerChecked {
                    address: OTHER.into(),
                    answer: ServerAnswer::Answered(Kind::AppOlder),
                },
            ],
        )),
        _ => return None,
    })
}

#[allow(dead_code)]
fn unused(_: Availability, _: ChooserProblem) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::{Mismatch, Refusal};

    fn window(name: &str) -> Window {
        preview(name)
            .unwrap_or_else(|| panic!("{name}"))
            .session
            .window()
            .clone()
    }

    #[test]
    fn every_named_state_exists_and_reaches_the_window_its_name_says() {
        let expect = |name: &str, want: Window, dialog: bool| {
            let p = preview(name).unwrap_or_else(|| panic!("{name}"));
            assert_eq!(p.session.window(), &want, "{name}");
            assert_eq!(p.session.in_dialog(), dialog, "{name}");
        };
        let refusal = |r| Window::Refusal { refusal: r };
        expect("sign-in", Window::SignIn, false);
        expect(
            "signed-out",
            Window::SignedOut {
                ended_on_server: true,
            },
            false,
        );
        expect(
            "signed-out-unconfirmed",
            Window::SignedOut {
                ended_on_server: false,
            },
            false,
        );
        expect("waiting", Window::Waiting, false);
        expect("browser-did-not-open", Window::BrowserDidNotOpen, false);
        expect("finishing", Window::Finishing, false);
        expect("expired", refusal(Refusal::Expired), false);
        expect("cancelled", refusal(Refusal::Cancelled), false);
        expect("used", refusal(Refusal::Used), false);
        expect("not-from-this-app", refusal(Refusal::NotFromThisApp), false);
        expect("could-not-finish", refusal(Refusal::CouldNotFinish), false);
        expect("no-keyring", refusal(Refusal::NoKeyring), false);
        expect(
            "no-keyring-still-listed",
            refusal(Refusal::NoKeyringStillListed),
            false,
        );
        expect("sign-in-again", Window::SignInAgain, true);
        expect("sign-in-again-waiting", Window::Waiting, true);
        expect("sign-in-again-expired", refusal(Refusal::Expired), true);
        expect("signed-in", Window::App, false);
        expect("signing-out", Window::SigningOut, false);
        expect("not-running", Window::NotAnswering, false);
        expect("cannot-reach", Window::NotAnswering, false);
        expect(
            "older-server",
            Window::Incompatible {
                mismatch: Mismatch::ServerOlder,
                address: OTHER.into(),
            },
            false,
        );
        expect(
            "older-app",
            Window::Incompatible {
                mismatch: Mismatch::AppOlder,
                address: OTHER.into(),
            },
            false,
        );
        expect(
            "checking",
            Window::Checking {
                address: OTHER.into(),
            },
            false,
        );
        for choose in [
            "choose-server",
            "choose-server-this-computer",
            "choose-server-this-computer-down",
            "choose-server-signed-in",
            "choose-server-empty",
            "choose-server-not-web",
            "choose-server-credentials",
            "choose-server-plain-http",
            "choose-server-no-answer",
            "choose-server-signed-in-no-answer",
            "choose-server-not-bakery",
        ] {
            assert!(matches!(window(choose), Window::Choose { .. }), "{choose}");
        }
    }

    #[test]
    fn the_list_of_names_is_complete_and_has_no_repeats() {
        for name in PREVIEWS {
            assert!(preview(name).is_some(), "{name}");
        }
        let mut sorted = PREVIEWS.to_vec();
        sorted.sort();
        sorted.dedup();
        assert_eq!(sorted.len(), PREVIEWS.len());
        assert!(preview("nonsense").is_none());
    }

    #[test]
    fn every_preview_has_a_panel_because_every_window_has_one() {
        for name in PREVIEWS {
            let p = preview(name).unwrap();
            assert!(view(&p.session, &p.facts).panel.is_some(), "{name}");
        }
    }

    #[test]
    fn the_waiting_preview_carries_its_deadline_and_the_address_state_carries_the_address() {
        let waiting = preview("waiting").unwrap();
        assert!(format!(
            "{:?}",
            view(&waiting.session, &waiting.facts).panel.unwrap().detail
        )
        .contains(UNTIL));
        let none = preview("browser-did-not-open").unwrap();
        assert!(format!(
            "{:?}",
            view(&none.session, &none.facts).panel.unwrap().detail
        )
        .contains(URL));
    }

    #[test]
    fn the_dialogs_waiting_step_reads_its_own_sentence_through_the_real_view() {
        let plain_waiting = preview("waiting").unwrap();
        let dialog = preview("sign-in-again-waiting").unwrap();
        let text = |p: &Preview| view(&p.session, &p.facts).panel.unwrap().text.unwrap();
        assert!(text(&plain_waiting).contains("This window continues by itself"));
        assert!(text(&dialog).contains("This page comes back as you left it"));
    }

    #[test]
    fn the_not_answering_windows_name_the_server_they_are_about_and_the_local_one_offers_help() {
        let here = preview("not-running").unwrap();
        let v = view(&here.session, &here.facts).panel.unwrap();
        assert_eq!(v.heading, "Bakery is not running on this computer");
        assert!(v.buttons.iter().any(|b| b.label == "How to start Bakery"));
        let other = preview("cannot-reach").unwrap();
        let o = view(&other.session, &other.facts).panel.unwrap();
        assert_eq!(o.heading, "Bakery could not reach the server");
        assert!(o.text.unwrap().starts_with(SERVER));
        assert!(!o.buttons.iter().any(|b| b.label == "How to start Bakery"));
    }

    #[test]
    fn a_switch_carries_its_notice_over_the_sign_in_panel_and_the_signed_in_window() {
        for name in ["switched", "switched-signed-in"] {
            let p = preview(name).unwrap();
            let panel = view(&p.session, &p.facts).panel.unwrap();
            assert_eq!(
                panel.notice.as_deref(),
                Some("Bakery now uses https://bakery.example.com."),
                "{name}"
            );
        }
    }

    #[test]
    fn the_notice_goes_with_the_next_action() {
        let p = preview("switched").unwrap();
        let (next, _) = step(p.session, Event::SignInPressed);
        assert_eq!(view(&next, &p.facts).panel.unwrap().notice, None);
    }
}
