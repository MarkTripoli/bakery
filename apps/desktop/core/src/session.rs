//! The app's sign-in as a state machine: which window shows, and what the app must do next.
//!
//! Pure: `step` takes the state and one event and returns the next state and the effects to carry
//! out. It opens no browser, talks to no server and touches no secret store, so every transition is
//! tested here without a window system. The states and their wording are design-ux's (#77 slice 3).

use crate::wire::ExchangeFailure;
use serde::Serialize;

/// Why a sign-in did not finish, each with its own window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    /// The request outlived its ten minutes.
    Expired,
    /// The person pressed Cancel in the browser.
    Cancelled,
    /// The answer was already spent.
    Used,
    /// The answer did not come from this app: it did not match, or nobody asked for it.
    NotFromThisApp,
    /// The browser step is done but the server did not answer the exchange.
    CouldNotFinish,
    /// The computer has no unlocked keyring to keep the sign-in in.
    NoKeyring,
    /// The server could not be reached to start a sign-in. Not in the design's table: it is the
    /// "could not reach the server" window, kept until slice 4 owns server problems.
    CannotStart,
}

/// What the person sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Window {
    /// First open.
    SignIn,
    /// The same panel, under the notice that the person signed out.
    SignedOut,
    Waiting,
    /// The browser could not be opened: the address is shown to copy.
    BrowserDidNotOpen,
    /// The answer is back and the app is trading it for a sign-in.
    Finishing,
    Refusal {
        refusal: Refusal,
    },
    /// The sign-in ended while a page was open: the page stays, dimmed, under this dialog.
    SignInAgain,
    /// Signed in: the web app's own pages.
    App,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct Attempt {
    id: String,
    confirm_url: String,
    expires_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    SignedOut,
    /// Asking the server for a sign-in request.
    Starting,
    /// The browser is open (or could not be); the app is waiting for its answer.
    Waiting(Attempt),
    /// The answer came back and is being traded for a credential.
    Exchanging {
        attempt: Attempt,
        code: String,
    },
    /// The server did not answer the trade. The code is kept so Try again can send it once more.
    Stalled {
        attempt: Attempt,
        code: String,
    },
    /// The credential is issued and is being saved on this computer.
    Storing,
    SignedIn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    phase: Phase,
    window: Window,
    /// True once a sign-in that was working has ended, so every window shows inside the dialog and
    /// backing out returns to it.
    resuming: bool,
}

impl Session {
    pub fn window(&self) -> &Window {
        &self.window
    }

    /// Whether the windows show inside the "sign in again" dialog over the kept page.
    pub fn in_dialog(&self) -> bool {
        self.resuming
    }

    pub fn is_signed_in(&self) -> bool {
        matches!(self.phase, Phase::SignedIn)
    }

    /// When the waiting attempt stops being valid, as the server gave it.
    pub fn expires_at(&self) -> Option<&str> {
        match &self.phase {
            Phase::Waiting(a)
            | Phase::Exchanging { attempt: a, .. }
            | Phase::Stalled { attempt: a, .. } => a.expires_at.as_deref(),
            _ => None,
        }
    }

    /// The address the person confirms at, while there is an attempt to confirm.
    pub fn confirm_url(&self) -> Option<&str> {
        match &self.phase {
            Phase::Waiting(a)
            | Phase::Exchanging { attempt: a, .. }
            | Phase::Stalled { attempt: a, .. } => Some(a.confirm_url.as_str()),
            _ => None,
        }
    }

    /// The app has just started.
    pub fn start(has_stored_credential: bool) -> Session {
        if has_stored_credential {
            Session {
                phase: Phase::SignedIn,
                window: Window::App,
                resuming: false,
            }
        } else {
            Session {
                phase: Phase::SignedOut,
                window: Window::SignIn,
                resuming: false,
            }
        }
    }

    fn out(&self, window: Window) -> Session {
        Session {
            phase: Phase::SignedOut,
            window,
            resuming: self.resuming,
        }
    }

    fn with(&self, phase: Phase, window: Window) -> Session {
        Session {
            phase,
            window,
            resuming: self.resuming,
        }
    }

    /// The window the person returns to when they back out of a sign-in.
    fn home(&self) -> Window {
        if self.resuming {
            Window::SignInAgain
        } else {
            Window::SignIn
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Event {
    /// "Sign in with your browser".
    SignInPressed,
    RequestStarted {
        id: String,
        confirm_url: String,
        expires_at: Option<String>,
    },
    /// The server could not be reached to start a sign-in.
    RequestFailed,
    /// The browser opened.
    BrowserOpened,
    /// The browser could not be opened.
    BrowserOpenFailed,
    /// "Open the browser again" or "Try to open the browser again".
    OpenBrowserAgain,
    CancelPressed,
    /// The operating system handed the app a sign-in answer.
    CallbackReceived {
        code: String,
    },
    ExchangeSucceeded,
    ExchangeRefused(ExchangeFailure),
    /// The server did not answer the trade.
    ExchangeUnreachable,
    /// "Try again" after the server did not answer.
    TryExchangeAgain,
    StoreSucceeded,
    StoreFailed,
    /// The keyring could not be written to, found out before the answer was traded for a
    /// credential, so no credential exists to be left behind.
    KeyringUnavailable,
    /// The server stopped accepting the saved credential.
    CredentialRejected,
    /// The request's time limit passed while waiting.
    TimedOut,
    /// The person chose to sign out.
    SignOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Ask the server for a sign-in request, holding a fresh secret for the exchange.
    StartRequest,
    OpenBrowser {
        url: String,
    },
    Exchange {
        id: String,
        code: String,
    },
    StoreCredential,
    ClearCredential,
}

fn refusal(refusal: Refusal) -> Window {
    Window::Refusal { refusal }
}

/// One event. An event that makes no sense in the current state changes nothing and does nothing.
pub fn step(session: Session, event: Event) -> (Session, Vec<Effect>) {
    use Event as E;
    use Phase as P;
    match (session.phase.clone(), event) {
        (P::SignedOut, E::SignInPressed) => (
            session.with(P::Starting, session.window.clone()),
            vec![Effect::StartRequest],
        ),
        (
            P::Starting,
            E::RequestStarted {
                id,
                confirm_url,
                expires_at,
            },
        ) => {
            let url = confirm_url.clone();
            (
                session.with(
                    P::Waiting(Attempt {
                        id,
                        confirm_url,
                        expires_at,
                    }),
                    Window::Waiting,
                ),
                vec![Effect::OpenBrowser { url }],
            )
        }
        (P::Starting, E::RequestFailed) => (session.out(refusal(Refusal::CannotStart)), vec![]),
        (P::Waiting(a), E::BrowserOpened) => (session.with(P::Waiting(a), Window::Waiting), vec![]),
        (P::Waiting(a), E::BrowserOpenFailed) => (
            session.with(P::Waiting(a), Window::BrowserDidNotOpen),
            vec![],
        ),
        (P::Waiting(a), E::OpenBrowserAgain) => {
            let url = a.confirm_url.clone();
            (
                session.with(P::Waiting(a), Window::Waiting),
                vec![Effect::OpenBrowser { url }],
            )
        }
        (P::Waiting(_), E::CancelPressed) => {
            let window = session.home();
            (session.out(window), vec![])
        }
        (P::Waiting(a), E::CallbackReceived { code }) => {
            let (id, c) = (a.id.clone(), code.clone());
            (
                session.with(P::Exchanging { attempt: a, code }, Window::Finishing),
                vec![Effect::Exchange { id, code: c }],
            )
        }
        (P::Waiting(_), E::TimedOut) => (session.out(refusal(Refusal::Expired)), vec![]),
        // An answer nobody asked for, such as a late one after Cancel: say it did not come from here.
        (P::SignedOut, E::CallbackReceived { .. }) => {
            (session.out(refusal(Refusal::NotFromThisApp)), vec![])
        }
        // The keyring is checked before the code is traded, so a computer with no keyring never
        // makes the server issue a sign-in nobody can hold. The unspent code simply expires.
        (P::Exchanging { .. }, E::KeyringUnavailable) => {
            (session.out(refusal(Refusal::NoKeyring)), vec![])
        }
        (P::Exchanging { .. }, E::ExchangeSucceeded) => (
            session.with(P::Storing, Window::Finishing),
            vec![Effect::StoreCredential],
        ),
        (P::Exchanging { attempt, code }, E::ExchangeRefused(failure)) => match failure {
            // Not confirmed yet: never shown, the app keeps waiting.
            ExchangeFailure::Pending => {
                (session.with(P::Waiting(attempt), Window::Waiting), vec![])
            }
            ExchangeFailure::Expired => (session.out(refusal(Refusal::Expired)), vec![]),
            ExchangeFailure::Cancelled => (session.out(refusal(Refusal::Cancelled)), vec![]),
            ExchangeFailure::Used => (session.out(refusal(Refusal::Used)), vec![]),
            ExchangeFailure::Mismatch => (session.out(refusal(Refusal::NotFromThisApp)), vec![]),
            ExchangeFailure::Unexpected => (
                session.with(
                    P::Stalled { attempt, code },
                    refusal(Refusal::CouldNotFinish),
                ),
                vec![],
            ),
        },
        (P::Exchanging { attempt, code }, E::ExchangeUnreachable) => (
            session.with(
                P::Stalled { attempt, code },
                refusal(Refusal::CouldNotFinish),
            ),
            vec![],
        ),
        // Try again sends the very same exchange once more; if the answer is "used", that shows.
        (P::Stalled { attempt, code }, E::TryExchangeAgain) => {
            let (id, c) = (attempt.id.clone(), code.clone());
            (
                session.with(P::Exchanging { attempt, code }, Window::Finishing),
                vec![Effect::Exchange { id, code: c }],
            )
        }
        (P::Stalled { .. }, E::SignInPressed) => (
            session.with(P::Starting, session.window.clone()),
            vec![Effect::StartRequest],
        ),
        (P::Storing, E::StoreSucceeded) => (
            Session {
                phase: P::SignedIn,
                window: Window::App,
                resuming: false,
            },
            vec![],
        ),
        // Bakery never keeps the sign-in in a plain file: with nowhere to save it, it is dropped and
        // the person signs in again once the keyring works.
        (P::Storing, E::StoreFailed) => (session.out(refusal(Refusal::NoKeyring)), vec![]),
        (P::SignedIn, E::CredentialRejected) => (
            Session {
                phase: P::SignedOut,
                window: Window::SignInAgain,
                resuming: true,
            },
            vec![Effect::ClearCredential],
        ),
        (_, E::SignOut) => (
            Session {
                phase: P::SignedOut,
                window: Window::SignedOut,
                resuming: false,
            },
            vec![Effect::ClearCredential],
        ),
        // Anything else makes no sense here, including a callback while signed in: ignored, no window.
        (_, _) => (session, vec![]),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use Event as E;

    const URL: &str = "http://127.0.0.1:8000/api/desktop/sign-in?request=r1";

    fn run(mut session: Session, events: Vec<Event>) -> (Session, Vec<Effect>) {
        let mut all = vec![];
        for event in events {
            let (next, effects) = step(session, event);
            session = next;
            all.extend(effects);
        }
        (session, all)
    }

    fn started() -> Event {
        E::RequestStarted {
            id: "r1".into(),
            confirm_url: URL.into(),
            expires_at: Some("2026-11-20T14:32:00Z".into()),
        }
    }

    fn waiting() -> Session {
        run(
            Session::start(false),
            vec![E::SignInPressed, started(), E::BrowserOpened],
        )
        .0
    }

    fn exchanging() -> Session {
        run(waiting(), vec![E::CallbackReceived { code: "c".into() }]).0
    }

    fn stalled() -> Session {
        step(exchanging(), E::ExchangeUnreachable).0
    }

    fn storing() -> Session {
        step(exchanging(), E::ExchangeSucceeded).0
    }

    fn signed_in() -> Session {
        step(storing(), E::StoreSucceeded).0
    }

    fn refused(r: Refusal) -> Window {
        Window::Refusal { refusal: r }
    }

    #[test]
    fn the_first_open_shows_the_sign_in_window_and_a_saved_sign_in_goes_straight_to_the_app() {
        assert_eq!(Session::start(false).window(), &Window::SignIn);
        assert_eq!(Session::start(true).window(), &Window::App);
        assert!(Session::start(true).is_signed_in());
        assert!(!Session::start(false).is_signed_in());
    }

    #[test]
    fn a_sign_in_goes_through_the_browser_and_ends_in_the_app() {
        let (s, effects) = step(Session::start(false), E::SignInPressed);
        assert_eq!(effects, vec![Effect::StartRequest]);
        let (s, effects) = step(s, started());
        assert_eq!(effects, vec![Effect::OpenBrowser { url: URL.into() }]);
        assert_eq!(s.window(), &Window::Waiting);
        assert_eq!(s.expires_at(), Some("2026-11-20T14:32:00Z"));
        assert_eq!(s.confirm_url(), Some(URL));
        let (s, effects) = step(s, E::CallbackReceived { code: "abc".into() });
        assert_eq!(
            effects,
            vec![Effect::Exchange {
                id: "r1".into(),
                code: "abc".into()
            }]
        );
        assert_eq!(s.window(), &Window::Finishing);
        let (s, effects) = step(s, E::ExchangeSucceeded);
        assert_eq!(effects, vec![Effect::StoreCredential]);
        let (s, effects) = step(s, E::StoreSucceeded);
        assert!(effects.is_empty());
        assert_eq!(s.window(), &Window::App);
        assert!(s.is_signed_in());
    }

    #[test]
    fn the_browser_that_will_not_open_shows_the_address_and_can_try_again() {
        let (s, _) = run(
            Session::start(false),
            vec![E::SignInPressed, started(), E::BrowserOpenFailed],
        );
        assert_eq!(s.window(), &Window::BrowserDidNotOpen);
        assert_eq!(s.confirm_url(), Some(URL));
        let (s, effects) = step(s, E::OpenBrowserAgain);
        assert_eq!(effects, vec![Effect::OpenBrowser { url: URL.into() }]);
        assert_eq!(s.window(), &Window::Waiting);
        // The browser is not opened again from anywhere else.
        assert!(step(Session::start(false), E::OpenBrowserAgain)
            .1
            .is_empty());
        // The answer can still come while the address is showing.
        let (s, _) = run(
            waiting(),
            vec![
                E::BrowserOpenFailed,
                E::CallbackReceived { code: "c".into() },
            ],
        );
        assert_eq!(s.window(), &Window::Finishing);
    }

    #[test]
    fn a_second_answer_for_the_same_attempt_is_ignored() {
        let (s, _) = step(
            waiting(),
            E::CallbackReceived {
                code: "first".into(),
            },
        );
        let (after, effects) = step(
            s.clone(),
            E::CallbackReceived {
                code: "replay".into(),
            },
        );
        assert!(
            effects.is_empty(),
            "a replay must not start a second exchange"
        );
        assert_eq!(after, s);
    }

    #[test]
    fn an_answer_while_signed_in_is_ignored_with_no_window() {
        for s in [Session::start(true), signed_in()] {
            let (after, effects) = step(
                s.clone(),
                E::CallbackReceived {
                    code: "stray".into(),
                },
            );
            assert!(effects.is_empty());
            assert_eq!(after, s);
        }
    }

    #[test]
    fn an_answer_nobody_asked_for_says_it_did_not_come_from_this_app() {
        let (s, effects) = step(
            Session::start(false),
            E::CallbackReceived {
                code: "stray".into(),
            },
        );
        assert!(effects.is_empty(), "nothing is exchanged");
        assert_eq!(s.window(), &refused(Refusal::NotFromThisApp));
        assert!(!s.is_signed_in());
    }

    #[test]
    fn cancelling_returns_to_sign_in_and_a_late_answer_is_then_not_from_this_app() {
        let (s, _) = step(waiting(), E::CancelPressed);
        assert_eq!(s.window(), &Window::SignIn);
        let (s, effects) = step(
            s,
            E::CallbackReceived {
                code: "late".into(),
            },
        );
        assert!(effects.is_empty());
        assert_eq!(s.window(), &refused(Refusal::NotFromThisApp));
        // Cancel is also there while the address shows.
        let (s, _) = run(waiting(), vec![E::BrowserOpenFailed, E::CancelPressed]);
        assert_eq!(s.window(), &Window::SignIn);
    }

    #[test]
    fn a_server_that_cannot_be_reached_to_start_says_so_and_the_button_tries_again() {
        let (s, _) = run(
            Session::start(false),
            vec![E::SignInPressed, E::RequestFailed],
        );
        assert_eq!(s.window(), &refused(Refusal::CannotStart));
        assert_eq!(step(s, E::SignInPressed).1, vec![Effect::StartRequest]);
    }

    #[test]
    fn an_attempt_that_ran_out_of_time_offers_a_fresh_start() {
        let (s, _) = step(waiting(), E::TimedOut);
        assert_eq!(s.window(), &refused(Refusal::Expired));
        assert_eq!(step(s, E::SignInPressed).1, vec![Effect::StartRequest]);
    }

    #[test]
    fn each_refusal_from_the_server_shows_its_own_window_and_saves_nothing() {
        for (failure, expected) in [
            (ExchangeFailure::Expired, refused(Refusal::Expired)),
            (ExchangeFailure::Cancelled, refused(Refusal::Cancelled)),
            (ExchangeFailure::Used, refused(Refusal::Used)),
            (ExchangeFailure::Mismatch, refused(Refusal::NotFromThisApp)),
        ] {
            let (s, effects) = step(exchanging(), E::ExchangeRefused(failure));
            assert_eq!(s.window(), &expected, "{failure:?}");
            assert!(
                effects.is_empty(),
                "{failure:?}: nothing is stored or cleared"
            );
            assert!(!s.is_signed_in());
        }
    }

    #[test]
    fn a_sign_in_the_person_has_not_confirmed_yet_is_never_shown_and_the_wait_goes_on() {
        let (s, effects) = step(exchanging(), E::ExchangeRefused(ExchangeFailure::Pending));
        assert!(effects.is_empty());
        assert_eq!(s.window(), &Window::Waiting);
        assert_eq!(s.confirm_url(), Some(URL), "the same attempt, still open");
        // And the answer that does come next is exchanged.
        assert_eq!(
            step(
                s,
                E::CallbackReceived {
                    code: "real".into()
                }
            )
            .1,
            vec![Effect::Exchange {
                id: "r1".into(),
                code: "real".into()
            }]
        );
    }

    #[test]
    fn a_server_that_does_not_answer_the_exchange_can_be_asked_again_with_the_same_answer() {
        for failure in [
            E::ExchangeUnreachable,
            E::ExchangeRefused(ExchangeFailure::Unexpected),
        ] {
            let (s, _) = step(exchanging(), failure);
            assert_eq!(s.window(), &refused(Refusal::CouldNotFinish));
            let (s, effects) = step(s, E::TryExchangeAgain);
            assert_eq!(
                effects,
                vec![Effect::Exchange {
                    id: "r1".into(),
                    code: "c".into()
                }]
            );
            assert_eq!(s.window(), &Window::Finishing);
        }
        // If the second answer says it was already used, that is what shows.
        let (s, _) = step(stalled(), E::TryExchangeAgain);
        let (s, _) = step(s, E::ExchangeRefused(ExchangeFailure::Used));
        assert_eq!(s.window(), &refused(Refusal::Used));
        // Or the person starts over from the browser.
        assert_eq!(
            step(stalled(), E::SignInPressed).1,
            vec![Effect::StartRequest]
        );
        // Trying again does nothing anywhere else.
        assert!(step(Session::start(false), E::TryExchangeAgain)
            .1
            .is_empty());
    }

    #[test]
    fn when_the_computer_has_no_keyring_the_sign_in_is_dropped_not_kept_in_a_file() {
        let (s, effects) = step(storing(), E::StoreFailed);
        assert!(effects.is_empty(), "nothing is stored anywhere else");
        assert_eq!(s.window(), &refused(Refusal::NoKeyring));
        assert!(
            !s.is_signed_in(),
            "without somewhere to keep it, the person signs in again"
        );
        assert_eq!(step(s, E::SignInPressed).1, vec![Effect::StartRequest]);
    }

    #[test]
    fn a_keyring_found_broken_before_the_trade_asks_the_server_for_nothing() {
        let (s, effects) = step(exchanging(), E::KeyringUnavailable);
        assert!(
            effects.is_empty(),
            "no exchange is sent, so the server issues no sign-in"
        );
        assert_eq!(s.window(), &refused(Refusal::NoKeyring));
        assert!(!s.is_signed_in());
        // It is the same window as a failed save, and pressing Sign in starts over.
        assert_eq!(step(s, E::SignInPressed).1, vec![Effect::StartRequest]);
        // Only a trade that is under way can find this out; elsewhere it changes nothing.
        for other in [waiting(), storing(), stalled(), signed_in()] {
            let before = other.window().clone();
            let (after, effects) = step(other, E::KeyringUnavailable);
            assert_eq!(after.window(), &before);
            assert!(effects.is_empty());
        }
    }

    #[test]
    fn a_sign_in_the_server_ends_brings_the_dialog_and_clears_what_was_saved() {
        let (s, effects) = step(signed_in(), E::CredentialRejected);
        assert_eq!(s.window(), &Window::SignInAgain);
        assert!(s.in_dialog());
        assert_eq!(effects, vec![Effect::ClearCredential]);
        assert!(!s.is_signed_in());
    }

    #[test]
    fn signing_in_again_stays_in_the_dialog_and_backing_out_returns_to_it() {
        let ended = step(signed_in(), E::CredentialRejected).0;
        let (s, _) = run(
            ended.clone(),
            vec![E::SignInPressed, started(), E::BrowserOpened],
        );
        assert_eq!(s.window(), &Window::Waiting);
        assert!(s.in_dialog(), "the waiting step shows inside the dialog");
        let (back, _) = step(s, E::CancelPressed);
        assert_eq!(back.window(), &Window::SignInAgain);
        // A refusal shows inside the dialog too.
        let (r, _) = run(
            ended.clone(),
            vec![E::SignInPressed, started(), E::TimedOut],
        );
        assert_eq!(r.window(), &refused(Refusal::Expired));
        assert!(r.in_dialog());
        // Signing in as before leaves the dialog and returns to the app.
        let (done, _) = run(
            ended,
            vec![
                E::SignInPressed,
                started(),
                E::CallbackReceived { code: "c".into() },
                E::ExchangeSucceeded,
                E::StoreSucceeded,
            ],
        );
        assert_eq!(done.window(), &Window::App);
        assert!(!done.in_dialog());
        // The next time it ends, it is the dialog again, not the first-open window.
        assert_eq!(
            step(done, E::CredentialRejected).0.window(),
            &Window::SignInAgain
        );
    }

    #[test]
    fn signing_out_clears_what_was_saved_and_shows_the_signed_out_window() {
        for s in [
            Session::start(false),
            Session::start(true),
            waiting(),
            exchanging(),
            stalled(),
            storing(),
            signed_in(),
        ] {
            let (after, effects) = step(s, E::SignOut);
            assert_eq!(after.window(), &Window::SignedOut);
            assert_eq!(effects, vec![Effect::ClearCredential]);
            assert!(!after.is_signed_in());
            assert!(!after.in_dialog());
        }
    }

    #[test]
    fn events_that_make_no_sense_change_nothing() {
        assert_eq!(step(waiting(), E::ExchangeSucceeded).0, waiting());
        assert_eq!(
            step(Session::start(false), E::StoreSucceeded).0,
            Session::start(false)
        );
        assert_eq!(step(signed_in(), E::SignInPressed).0, signed_in());
        assert_eq!(
            step(Session::start(false), E::CredentialRejected).0,
            Session::start(false)
        );
        assert_eq!(
            step(Session::start(false), E::TimedOut).0,
            Session::start(false)
        );
    }

    #[test]
    fn nothing_is_stored_or_cleared_except_on_the_paths_that_mean_to() {
        let sessions = [
            Session::start(false),
            Session::start(true),
            waiting(),
            exchanging(),
            stalled(),
            storing(),
            signed_in(),
        ];
        let events = vec![
            E::SignInPressed,
            started(),
            E::RequestFailed,
            E::BrowserOpened,
            E::BrowserOpenFailed,
            E::OpenBrowserAgain,
            E::CancelPressed,
            E::CallbackReceived { code: "c".into() },
            E::ExchangeSucceeded,
            E::ExchangeRefused(ExchangeFailure::Expired),
            E::ExchangeRefused(ExchangeFailure::Pending),
            E::ExchangeUnreachable,
            E::TryExchangeAgain,
            E::StoreSucceeded,
            E::StoreFailed,
            E::KeyringUnavailable,
            E::CredentialRejected,
            E::TimedOut,
            E::SignOut,
        ];
        for s in &sessions {
            for e in &events {
                // Every event in every state is handled without a panic.
                let (_, effects) = step(s.clone(), e.clone());
                for effect in effects {
                    match (&effect, e) {
                        (Effect::StoreCredential, E::ExchangeSucceeded) => {}
                        (Effect::ClearCredential, E::SignOut | E::CredentialRejected) => {}
                        (Effect::StoreCredential | Effect::ClearCredential, _) => {
                            panic!("{effect:?} on {e:?} in {s:?}")
                        }
                        _ => {}
                    }
                }
            }
        }
    }
}
