//! The app's sign-in as a state machine: which window shows, and what the app must do next.
//!
//! Pure: `step` takes the state and one event and returns the next state and the effects to carry
//! out. It opens no browser, talks to no server and touches no secret store, so every transition is
//! tested here without a window system.

use crate::wire::ExchangeFailure;
use serde::Serialize;

/// Why a sign-in did not finish, each with its own window.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Refusal {
    /// The answer from the browser did not belong to this attempt.
    NotCompleted,
    Cancelled,
    CannotReach,
    /// The computer's secure storage refused; `reason` is the system's, in plain words.
    StorageRefused {
        reason: String,
    },
    /// Signed in, but as someone with no account on this server.
    NoAccount,
}

/// What the person sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Window {
    SignIn,
    Waiting,
    /// The attempt ran out of time.
    Expired,
    Refusal {
        refusal: Refusal,
    },
    /// The sign-in ended while a page was open: the page stays, dimmed, under this dialog.
    SignInAgain,
    /// Signed in: the web app's own pages.
    App,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum Phase {
    SignedOut,
    /// Asking the server for a sign-in request.
    Starting,
    /// The browser is open; the app is waiting for its answer.
    Waiting {
        id: String,
        confirm_url: String,
    },
    /// The answer came back; the app is trading it for a credential.
    Exchanging {
        id: String,
    },
    /// The credential is issued and is being saved on this computer.
    Storing,
    SignedIn,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    phase: Phase,
    window: Window,
    /// True once a sign-in that was working has ended, so the way back is the dialog, not the
    /// first-open window.
    resuming: bool,
}

impl Session {
    pub fn window(&self) -> &Window {
        &self.window
    }

    /// Whether a callback would be accepted right now: only while the browser is being waited on.
    pub fn is_waiting(&self) -> bool {
        matches!(self.phase, Phase::Waiting { .. })
    }

    pub fn is_signed_in(&self) -> bool {
        matches!(self.phase, Phase::SignedIn)
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

    fn signed_out(&self, window: Window) -> Session {
        Session {
            phase: Phase::SignedOut,
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
    /// "Sign in with your browser", or "Try again".
    SignInPressed,
    RequestStarted {
        id: String,
        confirm_url: String,
    },
    /// The server could not be reached to start a sign-in.
    RequestFailed,
    OpenBrowserAgain,
    CancelPressed,
    /// The operating system handed the app a sign-in answer.
    CallbackReceived {
        code: String,
    },
    ExchangeSucceeded,
    ExchangeRefused(ExchangeFailure),
    ExchangeUnreachable,
    StoreSucceeded,
    StoreFailed {
        reason: String,
    },
    /// Dismisses the "could not save" notice; the person carries on signed in.
    Continue,
    /// Signed in, but the server has no account for this person.
    NoAccount,
    /// The server stopped accepting the saved credential.
    CredentialRejected,
    /// The request's time limit passed while waiting.
    TimedOut,
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

/// One event. An event that makes no sense in the current state changes nothing and does nothing:
/// that is how a replayed or stray answer is ignored.
pub fn step(session: Session, event: Event) -> (Session, Vec<Effect>) {
    use Event as E;
    use Phase as P;
    match (&session.phase, event) {
        (P::SignedOut, E::SignInPressed) => (
            Session {
                phase: P::Starting,
                window: session.window.clone(),
                resuming: session.resuming,
            },
            vec![Effect::StartRequest],
        ),
        (P::Starting, E::RequestStarted { id, confirm_url }) => (
            Session {
                phase: P::Waiting {
                    id,
                    confirm_url: confirm_url.clone(),
                },
                window: Window::Waiting,
                resuming: session.resuming,
            },
            vec![Effect::OpenBrowser { url: confirm_url }],
        ),
        (P::Starting, E::RequestFailed) => {
            let window = refusal(Refusal::CannotReach);
            (session.signed_out(window), vec![])
        }
        (P::Waiting { confirm_url, .. }, E::OpenBrowserAgain) => {
            let url = confirm_url.clone();
            (session, vec![Effect::OpenBrowser { url }])
        }
        (P::Waiting { .. }, E::CancelPressed) => {
            let window = session.home();
            (session.signed_out(window), vec![])
        }
        (P::Waiting { id, .. }, E::CallbackReceived { code }) => {
            let id = id.clone();
            (
                Session {
                    phase: P::Exchanging { id: id.clone() },
                    window: Window::Waiting,
                    resuming: session.resuming,
                },
                vec![Effect::Exchange { id, code }],
            )
        }
        (P::Waiting { .. }, E::TimedOut) => (session.signed_out(Window::Expired), vec![]),
        (P::Exchanging { .. }, E::ExchangeSucceeded) => (
            Session {
                phase: P::Storing,
                window: Window::Waiting,
                resuming: session.resuming,
            },
            vec![Effect::StoreCredential],
        ),
        (P::Exchanging { .. }, E::ExchangeRefused(failure)) => {
            let window = match failure {
                ExchangeFailure::Expired => Window::Expired,
                ExchangeFailure::NotCompleted => refusal(Refusal::NotCompleted),
                ExchangeFailure::Cancelled => refusal(Refusal::Cancelled),
                ExchangeFailure::Unexpected => refusal(Refusal::CannotReach),
            };
            (session.signed_out(window), vec![])
        }
        (P::Exchanging { .. }, E::ExchangeUnreachable) => {
            let window = refusal(Refusal::CannotReach);
            (session.signed_out(window), vec![])
        }
        (P::Storing, E::StoreSucceeded) => (
            Session {
                phase: P::SignedIn,
                window: Window::App,
                resuming: false,
            },
            vec![],
        ),
        // The credential is good for now even though it could not be saved: say so, then carry on.
        (P::Storing, E::StoreFailed { reason }) => (
            Session {
                phase: P::SignedIn,
                window: refusal(Refusal::StorageRefused { reason }),
                resuming: false,
            },
            vec![],
        ),
        (P::SignedIn, E::Continue)
            if matches!(
                session.window,
                Window::Refusal {
                    refusal: Refusal::StorageRefused { .. }
                }
            ) =>
        {
            (
                Session {
                    phase: P::SignedIn,
                    window: Window::App,
                    resuming: false,
                },
                vec![],
            )
        }
        (P::Storing | P::Exchanging { .. }, E::NoAccount) | (P::SignedIn, E::NoAccount) => (
            Session {
                phase: P::SignedOut,
                window: refusal(Refusal::NoAccount),
                resuming: false,
            },
            vec![Effect::ClearCredential],
        ),
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
                window: Window::SignIn,
                resuming: false,
            },
            vec![Effect::ClearCredential],
        ),
        // A refusal, the expired window or the dialog all offer the same button again.
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
        }
    }

    fn waiting() -> Session {
        run(Session::start(false), vec![E::SignInPressed, started()]).0
    }

    fn exchanging() -> Session {
        run(waiting(), vec![E::CallbackReceived { code: "c".into() }]).0
    }

    fn signed_in() -> Session {
        run(exchanging(), vec![E::ExchangeSucceeded, E::StoreSucceeded]).0
    }

    #[test]
    fn the_first_open_shows_the_sign_in_window_and_a_saved_sign_in_goes_straight_to_the_app() {
        assert_eq!(Session::start(false).window(), &Window::SignIn);
        assert!(!Session::start(false).is_signed_in());
        assert_eq!(Session::start(true).window(), &Window::App);
        assert!(Session::start(true).is_signed_in());
    }

    #[test]
    fn a_sign_in_goes_through_the_browser_and_ends_in_the_app() {
        let (s, effects) = step(Session::start(false), E::SignInPressed);
        assert_eq!(effects, vec![Effect::StartRequest]);
        let (s, effects) = step(s, started());
        assert_eq!(effects, vec![Effect::OpenBrowser { url: URL.into() }]);
        assert_eq!(s.window(), &Window::Waiting);
        assert!(s.is_waiting());
        let (s, effects) = step(s, E::CallbackReceived { code: "abc".into() });
        assert_eq!(
            effects,
            vec![Effect::Exchange {
                id: "r1".into(),
                code: "abc".into()
            }]
        );
        assert!(!s.is_waiting());
        let (s, effects) = step(s, E::ExchangeSucceeded);
        assert_eq!(effects, vec![Effect::StoreCredential]);
        let (s, effects) = step(s, E::StoreSucceeded);
        assert!(effects.is_empty());
        assert_eq!(s.window(), &Window::App);
        assert!(s.is_signed_in());
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
    fn an_answer_nobody_asked_for_is_ignored_in_every_other_state() {
        for s in [Session::start(false), Session::start(true), signed_in()] {
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
    fn the_browser_can_be_opened_again_while_waiting_and_only_then() {
        let (s, effects) = step(waiting(), E::OpenBrowserAgain);
        assert_eq!(effects, vec![Effect::OpenBrowser { url: URL.into() }]);
        assert!(s.is_waiting());
        assert!(step(Session::start(false), E::OpenBrowserAgain)
            .1
            .is_empty());
    }

    #[test]
    fn cancelling_returns_to_where_the_person_was() {
        assert_eq!(
            step(waiting(), E::CancelPressed).0.window(),
            &Window::SignIn
        );
        let ended = step(signed_in(), E::CredentialRejected).0;
        let (resumed, _) = run(ended, vec![E::SignInPressed, started(), E::CancelPressed]);
        assert_eq!(resumed.window(), &Window::SignInAgain);
    }

    #[test]
    fn a_server_that_cannot_be_reached_says_so_and_the_button_tries_again() {
        let (s, _) = run(
            Session::start(false),
            vec![E::SignInPressed, E::RequestFailed],
        );
        assert_eq!(
            s.window(),
            &Window::Refusal {
                refusal: Refusal::CannotReach
            }
        );
        let (_, effects) = step(s, E::SignInPressed);
        assert_eq!(effects, vec![Effect::StartRequest]);
    }

    #[test]
    fn an_attempt_that_ran_out_of_time_offers_to_try_again() {
        let (s, _) = step(waiting(), E::TimedOut);
        assert_eq!(s.window(), &Window::Expired);
        assert!(!s.is_waiting());
        assert_eq!(step(s, E::SignInPressed).1, vec![Effect::StartRequest]);
    }

    #[test]
    fn each_refusal_from_the_server_shows_its_own_window_and_saves_nothing() {
        for (failure, expected) in [
            (ExchangeFailure::Expired, Window::Expired),
            (
                ExchangeFailure::NotCompleted,
                Window::Refusal {
                    refusal: Refusal::NotCompleted,
                },
            ),
            (
                ExchangeFailure::Cancelled,
                Window::Refusal {
                    refusal: Refusal::Cancelled,
                },
            ),
            (
                ExchangeFailure::Unexpected,
                Window::Refusal {
                    refusal: Refusal::CannotReach,
                },
            ),
        ] {
            let (s, effects) = step(exchanging(), E::ExchangeRefused(failure));
            assert_eq!(s.window(), &expected, "{failure:?}");
            assert!(
                effects.is_empty(),
                "{failure:?}: nothing is stored or cleared"
            );
            assert!(!s.is_signed_in());
        }
        let (s, _) = step(exchanging(), E::ExchangeUnreachable);
        assert_eq!(
            s.window(),
            &Window::Refusal {
                refusal: Refusal::CannotReach
            }
        );
    }

    #[test]
    fn when_the_computer_will_not_save_the_sign_in_the_person_can_still_carry_on() {
        let (s, effects) = run(
            exchanging(),
            vec![
                E::ExchangeSucceeded,
                E::StoreFailed {
                    reason: "The keyring is locked.".into(),
                },
            ],
        );
        assert_eq!(effects, vec![Effect::StoreCredential]);
        assert!(s.is_signed_in(), "the credential is good for this session");
        assert_eq!(
            s.window(),
            &Window::Refusal {
                refusal: Refusal::StorageRefused {
                    reason: "The keyring is locked.".into()
                }
            }
        );
        let (s, _) = step(s, E::Continue);
        assert_eq!(s.window(), &Window::App);
        // Continue does nothing anywhere else.
        assert_eq!(step(signed_in(), E::Continue).0, signed_in());
    }

    #[test]
    fn a_sign_in_the_server_ends_brings_the_dialog_and_clears_what_was_saved() {
        let (s, effects) = step(signed_in(), E::CredentialRejected);
        assert_eq!(s.window(), &Window::SignInAgain);
        assert_eq!(effects, vec![Effect::ClearCredential]);
        assert!(!s.is_signed_in());
        // Signing in again goes through the browser and returns to the app.
        let (s, _) = run(
            s,
            vec![
                E::SignInPressed,
                started(),
                E::CallbackReceived { code: "c".into() },
            ],
        );
        let (s, _) = run(s, vec![E::ExchangeSucceeded, E::StoreSucceeded]);
        assert_eq!(s.window(), &Window::App);
        // And the next time it ends, it is the dialog again, not the first-open window.
        assert_eq!(
            step(s, E::CredentialRejected).0.window(),
            &Window::SignInAgain
        );
    }

    #[test]
    fn a_person_with_no_account_on_the_server_is_told_and_signed_out() {
        let (s, effects) = step(signed_in(), E::NoAccount);
        assert_eq!(
            s.window(),
            &Window::Refusal {
                refusal: Refusal::NoAccount
            }
        );
        assert_eq!(effects, vec![Effect::ClearCredential]);
        assert!(!s.is_signed_in());
    }

    #[test]
    fn signing_out_always_clears_what_was_saved_and_shows_the_first_window() {
        for s in [
            Session::start(false),
            Session::start(true),
            waiting(),
            exchanging(),
            signed_in(),
        ] {
            let (after, effects) = step(s, E::SignOut);
            assert_eq!(after.window(), &Window::SignIn);
            assert_eq!(effects, vec![Effect::ClearCredential]);
            assert!(!after.is_signed_in());
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
    }

    #[test]
    fn nothing_is_stored_or_cleared_except_on_the_paths_that_mean_to() {
        let sessions = [
            Session::start(false),
            Session::start(true),
            waiting(),
            exchanging(),
            signed_in(),
        ];
        let events = vec![
            E::SignInPressed,
            started(),
            E::RequestFailed,
            E::OpenBrowserAgain,
            E::CancelPressed,
            E::CallbackReceived { code: "c".into() },
            E::ExchangeSucceeded,
            E::ExchangeRefused(ExchangeFailure::Expired),
            E::ExchangeUnreachable,
            E::StoreSucceeded,
            E::StoreFailed { reason: "r".into() },
            E::Continue,
            E::NoAccount,
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
                        (
                            Effect::ClearCredential,
                            E::SignOut | E::NoAccount | E::CredentialRejected,
                        ) => {}
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
