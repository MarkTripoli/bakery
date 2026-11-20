//! What the page is told to show: the window, its panel, and whether it sits inside the dialog.
//! Also the named states the Linux stills are taken of, each one reached by driving the real state
//! machine, so a still cannot show a state the app cannot reach.

use crate::copy::{panel_for, Context, Panel};
use crate::session::{step, Event, Session, Window};
use crate::wire::ExchangeFailure;
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct View {
    pub window: Window,
    /// `None` for the app itself, which is the web app's own pages.
    pub panel: Option<Panel>,
    /// True when the panel shows inside the "sign in again" dialog over the kept page.
    pub dialog: bool,
}

pub fn view(session: &Session, server: &str) -> View {
    let ctx = Context {
        server,
        until: session.expires_at(),
        address: session.confirm_url(),
        dialog: session.in_dialog(),
    };
    View {
        window: session.window().clone(),
        panel: panel_for(session.window(), &ctx),
        dialog: session.in_dialog(),
    }
}

const URL: &str = "https://bakery.example.com/api/desktop/sign-in?request=preview";
const UNTIL: &str = "2026-11-20T14:32:00Z";

fn run(events: Vec<Event>) -> Session {
    events
        .into_iter()
        .fold(Session::start(false), |s, e| step(s, e).0)
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

/// Every named state, in the design's order.
pub const PREVIEWS: &[&str] = &[
    "sign-in",
    "signed-out",
    "waiting",
    "browser-did-not-open",
    "finishing",
    "expired",
    "cancelled",
    "used",
    "not-from-this-app",
    "could-not-finish",
    "no-keyring",
    "cannot-start",
    "sign-in-again",
    "sign-in-again-waiting",
    "sign-in-again-expired",
];

/// The session for a named state, or `None` for a name that is not one.
pub fn preview(name: &str) -> Option<Session> {
    Some(match name {
        "sign-in" => Session::start(false),
        "signed-out" => step(Session::start(true), Event::SignOut).0,
        "waiting" => run(waiting_events()),
        "browser-did-not-open" => run(then(
            vec![Event::SignInPressed, started()],
            vec![Event::BrowserOpenFailed],
        )),
        "finishing" => run(exchanging_events()),
        "expired" => run(then(waiting_events(), vec![Event::TimedOut])),
        "cancelled" => run(then(
            exchanging_events(),
            vec![Event::ExchangeRefused(ExchangeFailure::Cancelled)],
        )),
        "used" => run(then(
            exchanging_events(),
            vec![Event::ExchangeRefused(ExchangeFailure::Used)],
        )),
        "not-from-this-app" => run(then(
            exchanging_events(),
            vec![Event::ExchangeRefused(ExchangeFailure::Mismatch)],
        )),
        "could-not-finish" => run(then(exchanging_events(), vec![Event::ExchangeUnreachable])),
        "no-keyring" => run(then(
            exchanging_events(),
            vec![Event::ExchangeSucceeded, Event::StoreFailed],
        )),
        "cannot-start" => run(vec![Event::SignInPressed, Event::RequestFailed]),
        "sign-in-again" => run(ended()),
        "sign-in-again-waiting" => run(then(ended(), waiting_events())),
        "sign-in-again-expired" => {
            run(then(ended(), then(waiting_events(), vec![Event::TimedOut])))
        }
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::Refusal;

    #[test]
    fn every_named_state_exists_and_reaches_the_window_its_name_says() {
        let expect = |name: &str, window: Window, dialog: bool| {
            let s = preview(name).unwrap_or_else(|| panic!("{name}"));
            assert_eq!(s.window(), &window, "{name}");
            assert_eq!(s.in_dialog(), dialog, "{name}");
        };
        let refusal = |r| Window::Refusal { refusal: r };
        expect("sign-in", Window::SignIn, false);
        expect("signed-out", Window::SignedOut, false);
        expect("waiting", Window::Waiting, false);
        expect("browser-did-not-open", Window::BrowserDidNotOpen, false);
        expect("finishing", Window::Finishing, false);
        expect("expired", refusal(Refusal::Expired), false);
        expect("cancelled", refusal(Refusal::Cancelled), false);
        expect("used", refusal(Refusal::Used), false);
        expect("not-from-this-app", refusal(Refusal::NotFromThisApp), false);
        expect("could-not-finish", refusal(Refusal::CouldNotFinish), false);
        expect("no-keyring", refusal(Refusal::NoKeyring), false);
        expect("cannot-start", refusal(Refusal::CannotStart), false);
        expect("sign-in-again", Window::SignInAgain, true);
        expect("sign-in-again-waiting", Window::Waiting, true);
        expect("sign-in-again-expired", refusal(Refusal::Expired), true);
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
    fn every_preview_has_a_panel_because_none_of_them_is_the_app() {
        for name in PREVIEWS {
            let v = view(&preview(name).unwrap(), "https://bakery.example.com");
            assert!(v.panel.is_some(), "{name}");
        }
    }

    #[test]
    fn the_waiting_preview_carries_its_deadline_and_the_address_state_carries_the_address() {
        let waiting = view(&preview("waiting").unwrap(), "https://bakery.example.com");
        assert!(format!("{:?}", waiting.panel.unwrap().detail).contains(UNTIL));
        let none = view(
            &preview("browser-did-not-open").unwrap(),
            "https://bakery.example.com",
        );
        assert!(format!("{:?}", none.panel.unwrap().detail).contains(URL));
    }

    #[test]
    fn the_dialogs_waiting_step_reads_its_own_sentence_through_the_real_view() {
        let plain = view(&preview("waiting").unwrap(), "https://bakery.example.com");
        let dialog = view(
            &preview("sign-in-again-waiting").unwrap(),
            "https://bakery.example.com",
        );
        assert!(plain
            .panel
            .unwrap()
            .text
            .unwrap()
            .contains("This window continues by itself"));
        assert!(dialog
            .panel
            .unwrap()
            .text
            .unwrap()
            .contains("This page comes back as you left it"));
    }

    #[test]
    fn the_app_has_no_panel() {
        let v = view(&Session::start(true), "https://bakery.example.com");
        assert_eq!(v.window, Window::App);
        assert_eq!(v.panel, None);
    }
}
