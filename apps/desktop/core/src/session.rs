//! The app's sign-in as a state machine: which window shows, and what the app must do next.
//!
//! Pure: `step` takes the state and one event and returns the next state and the effects to carry
//! out. It opens no browser, talks to no server and touches no secret store, so every transition is
//! tested here without a window system. The states and their wording are design-ux's (#77 slice 3).

use crate::address::{is_default_server, parse_server_address, AddressProblem, THIS_COMPUTER};
use crate::compat::Kind;
use crate::csp::store_key;
use crate::wire::ExchangeFailure;
use serde::{Deserialize, Serialize};

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
    /// The same, and the unused sign-in the server issued could not be ended either: the person is
    /// told it may still be listed.
    NoKeyringStillListed,
}

/// Which of the chooser's two options is selected.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ServerChoice {
    ThisComputer,
    Another,
}

/// Why the chooser stays open, shown under the address box.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ChooserProblem {
    Empty,
    NotWebAddress,
    HasCredentials,
    PlainHttp,
    /// The address did not answer.
    NoAnswer,
    /// It answered, but is not a Bakery server.
    NotBakery,
}

impl From<AddressProblem> for ChooserProblem {
    fn from(problem: AddressProblem) -> Self {
        match problem {
            AddressProblem::Empty => ChooserProblem::Empty,
            AddressProblem::NotWebAddress => ChooserProblem::NotWebAddress,
            AddressProblem::HasCredentials => ChooserProblem::HasCredentials,
            AddressProblem::PlainHttp => ChooserProblem::PlainHttp,
        }
    }
}

/// Whether the server on this computer answered when the chooser opened.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Availability {
    Unknown,
    Answering,
    NotAnswering,
}

/// What the chooser shows. The typed text is the page's own until Continue, so this holds only what
/// the app decided: where it starts, what it knows about this computer, and why it stays open.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Chooser {
    pub selected: ServerChoice,
    /// The other address, filled in from the last one used or from what was typed.
    pub typed: String,
    pub problem: Option<ChooserProblem>,
    pub this_computer: Availability,
    /// Whether the person is signed in to the current server (the sentence under the heading).
    pub signed_in: bool,
}

/// Why a server and this app may not understand each other.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Mismatch {
    ServerOlder,
    AppOlder,
}

/// A line carried over the sign-in panel or the signed-in window until the person's next action.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Notice {
    /// "Bakery now uses {address}."
    Switched { address: String },
    /// "Sign in to open the page from your link."
    SignInForLink,
}

/// What the person sees.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Window {
    /// First open.
    SignIn,
    /// The same panel, under the notice that the person signed out, and whether the server ended
    /// the sign-in too.
    SignedOut {
        ended_on_server: bool,
    },
    /// Choosing which server the app shows.
    Choose {
        chooser: Chooser,
    },
    /// Asking an address whether it is a Bakery server.
    Checking {
        address: String,
    },
    /// The server did not answer; the app asks again by itself.
    NotAnswering,
    /// The server answered, and its level and the app's do not match.
    Incompatible {
        mismatch: Mismatch,
        address: String,
    },
    /// Ending the sign-in on the server and on this computer.
    SigningOut,
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
    /// The keyring refused it, and the app is ending the unused sign-in on the server.
    Revoking,
    SignedIn,
    /// The chooser is open; `back` is the state to return to, unchanged.
    Choosing {
        back: Box<Session>,
        chooser: Chooser,
    },
    /// An address is being asked whether it is a Bakery server.
    Checking {
        back: Box<Session>,
        chooser: Chooser,
        address: String,
        choice: ServerChoice,
    },
    /// A server whose level does not match the app's.
    Incompatible {
        back: Box<Session>,
        chooser: Chooser,
        address: String,
        mismatch: Mismatch,
    },
    /// The server at `target` did not answer; `back` is the window to return to when it does.
    NotAnswering {
        back: Box<Session>,
        target: String,
        /// Set when the chooser's "this computer" was picked and did not answer.
        chooser: Option<Chooser>,
    },
    /// The sign-in is being ended on the server and on this computer.
    SigningOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Session {
    phase: Phase,
    window: Window,
    /// True once a sign-in that was working has ended, so every window shows inside the dialog and
    /// backing out returns to it.
    resuming: bool,
    /// The server the app shows now, as it keeps it.
    server: String,
    /// A line over the sign-in panel or the signed-in window until the person's next action.
    notice: Option<Notice>,
    /// The last address that was not this computer, which the chooser offers again.
    last_other: String,
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
                server: String::new(),
                notice: None,
                last_other: String::new(),
            }
        } else {
            Session {
                phase: Phase::SignedOut,
                window: Window::SignIn,
                resuming: false,
                server: String::new(),
                notice: None,
                last_other: String::new(),
            }
        }
    }

    /// The same session for a named server, which the chooser compares a new choice with.
    pub fn on_server(mut self, server: &str) -> Session {
        self.server = server.to_string();
        self
    }

    /// The last other address the person used, offered again in the chooser.
    pub fn with_last_other(mut self, address: &str) -> Session {
        self.last_other = address.to_string();
        self
    }

    /// Carries a line over the opening window, such as the notice that the app now uses a server.
    pub fn with_notice(mut self, notice: Notice) -> Session {
        self.notice = Some(notice);
        self
    }

    /// What the app does as it opens: asks the server whether it answers.
    pub fn opened(&self) -> Vec<Effect> {
        vec![Effect::CheckCurrent]
    }

    pub fn notice(&self) -> Option<&Notice> {
        self.notice.as_ref()
    }

    /// The address the window is about: the server the app shows, or the one that did not answer.
    pub fn shown_server(&self) -> &str {
        match &self.phase {
            Phase::NotAnswering { target, .. } => target,
            Phase::Checking { address, .. } | Phase::Incompatible { address, .. } => address,
            _ => &self.server,
        }
    }

    fn out(&self, window: Window) -> Session {
        Session {
            phase: Phase::SignedOut,
            window,
            resuming: self.resuming,
            server: self.server.clone(),
            notice: None,
            last_other: self.last_other.clone(),
        }
    }

    fn with(&self, phase: Phase, window: Window) -> Session {
        Session {
            phase,
            window,
            resuming: self.resuming,
            server: self.server.clone(),
            notice: None,
            last_other: self.last_other.clone(),
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
    /// A `bakery://open` link arrived that names a page. Signed out, the sign-in panel says why it is
    /// waiting; in every other state nothing changes on screen and the link is kept by the app.
    OpenLinkArrived,
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
    /// "Sign out" in the signed-in window.
    SignOutPressed,
    /// The server and this computer have both been asked to end the sign-in.
    SignedOutRemote {
        ended_on_server: bool,
    },
    /// The keyring refused the sign-in and the server was asked to end it.
    UnstoredRevoked {
        ended_on_server: bool,
    },
    /// "Use a different server".
    UseDifferentServer,
    /// The server on this computer answered, or did not, when the chooser opened.
    ThisComputerChecked {
        answering: bool,
    },
    /// "Continue" in the chooser, with the option chosen and what was typed.
    ChooserContinue {
        choice: ServerChoice,
        typed: String,
    },
    /// What an address said when asked.
    ServerChecked {
        address: String,
        answer: ServerAnswer,
    },
    /// "Choose a different server" on the mismatch panel: back to the chooser, what was typed kept.
    ChooseDifferent,
    /// "Use it anyway" on the mismatch panel.
    UseItAnyway,
    /// The server the app shows answered, or did not, when asked.
    CurrentChecked {
        answered: bool,
    },
    /// "Try again" where the server is not answering.
    RetryNow,
    /// Fifteen quiet seconds passed where the server is not answering.
    RetryTick,
}

/// What an address answered when asked whether it is a Bakery server.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServerAnswer {
    NoAnswer,
    Answered(Kind),
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
    /// Ask the server whether it is answering, and remember when.
    CheckCurrent,
    /// Ask this computer's own server whether it answers, for the chooser's first option.
    CheckThisComputer,
    /// Ask an address whether it is a Bakery server.
    CheckServer {
        address: String,
    },
    /// Keep the address, then restart the app on it, in the same place and under the notice.
    SwitchServer {
        address: String,
    },
    /// End the sign-in on the server, then remove it from this computer.
    SignOutRemote,
    /// End a sign-in the keyring refused to keep, then drop it.
    RevokeUnstored,
    /// Ask again after fifteen quiet seconds.
    ScheduleRetry,
}

fn refusal(refusal: Refusal) -> Window {
    Window::Refusal { refusal }
}

/// Back to a state the person came from, unchanged. Where that state is the "not answering"
/// window, the quiet retry starts again, because the timer that ran before was left behind.
fn restore(back: Session) -> (Session, Vec<Effect>) {
    let effects = if matches!(back.phase, Phase::NotAnswering { .. }) {
        vec![Effect::ScheduleRetry]
    } else {
        vec![]
    };
    (back, effects)
}

fn incompatible(
    session: &Session,
    back: Box<Session>,
    chooser: Chooser,
    address: String,
    mismatch: Mismatch,
) -> Session {
    session.with(
        Phase::Incompatible {
            back,
            chooser,
            address: address.clone(),
            mismatch,
        },
        Window::Incompatible { mismatch, address },
    )
}

/// One event. An event that makes no sense in the current state changes nothing and does nothing.
pub fn step(session: Session, event: Event) -> (Session, Vec<Effect>) {
    use Event as E;
    use Phase as P;
    match (session.phase.clone(), event) {
        (P::SignedOut, E::OpenLinkArrived) if session.window == Window::SignIn => {
            (session.with_notice(Notice::SignInForLink), vec![])
        }
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
        (P::Starting, E::RequestFailed) => {
            // The window the person pressed Sign in on is where they return to when it answers.
            let back = Box::new(session.out(session.window.clone()));
            let target = session.server.clone();
            (
                session.with(
                    P::NotAnswering {
                        back,
                        target,
                        chooser: None,
                    },
                    Window::NotAnswering,
                ),
                vec![Effect::ScheduleRetry],
            )
        }
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
                server: session.server.clone(),
                notice: None,
                last_other: session.last_other.clone(),
            },
            vec![],
        ),
        // Bakery never keeps the sign-in in a plain file: with nowhere to save it, it is dropped and
        // the person signs in again once the keyring works.
        (P::Storing, E::StoreFailed) => (
            session.with(P::Revoking, Window::Finishing),
            vec![Effect::RevokeUnstored],
        ),
        (P::Revoking, E::UnstoredRevoked { ended_on_server }) => (
            session.out(refusal(if ended_on_server {
                Refusal::NoKeyring
            } else {
                Refusal::NoKeyringStillListed
            })),
            vec![],
        ),
        (P::SignedIn, E::CredentialRejected) => (
            Session {
                phase: P::SignedOut,
                window: Window::SignInAgain,
                resuming: true,
                server: session.server.clone(),
                notice: None,
                last_other: session.last_other.clone(),
            },
            vec![Effect::ClearCredential],
        ),
        // One action, no question: the sign-in ends on the server and is removed from this computer.
        (P::SignedIn, E::SignOutPressed) => (
            session.with(P::SigningOut, Window::SigningOut),
            vec![Effect::SignOutRemote],
        ),
        (P::SigningOut, E::SignedOutRemote { ended_on_server }) => (
            Session {
                phase: P::SignedOut,
                window: Window::SignedOut { ended_on_server },
                resuming: false,
                server: session.server.clone(),
                notice: None,
                last_other: session.last_other.clone(),
            },
            vec![],
        ),

        // ---- choosing a server ------------------------------------------------------------
        (P::SignedOut | P::SignedIn | P::NotAnswering { .. }, E::UseDifferentServer) => {
            let chooser = Chooser {
                selected: if is_default_server(&session.server) {
                    ServerChoice::ThisComputer
                } else {
                    ServerChoice::Another
                },
                // On another server the box starts with it; on this computer, with the last other one.
                typed: if is_default_server(&session.server) {
                    session.last_other.clone()
                } else {
                    session.server.clone()
                },
                problem: None,
                this_computer: Availability::Unknown,
                signed_in: matches!(session.phase, P::SignedIn),
            };
            (
                session.with(
                    P::Choosing {
                        back: Box::new(session.clone()),
                        chooser: chooser.clone(),
                    },
                    Window::Choose { chooser },
                ),
                vec![Effect::CheckThisComputer],
            )
        }
        (P::Choosing { back, mut chooser }, E::ThisComputerChecked { answering }) => {
            chooser.this_computer = if answering {
                Availability::Answering
            } else {
                Availability::NotAnswering
            };
            (
                session.with(
                    P::Choosing {
                        back,
                        chooser: chooser.clone(),
                    },
                    Window::Choose { chooser },
                ),
                vec![],
            )
        }
        (P::Choosing { back, mut chooser }, E::ChooserContinue { choice, typed }) => {
            let address = match choice {
                ServerChoice::ThisComputer => Ok(THIS_COMPUTER.to_string()),
                ServerChoice::Another => parse_server_address(&typed),
            };
            chooser.selected = choice;
            chooser.typed = typed;
            match address {
                Err(problem) => {
                    chooser.problem = Some(problem.into());
                    (
                        session.with(
                            P::Choosing {
                                back,
                                chooser: chooser.clone(),
                            },
                            Window::Choose { chooser },
                        ),
                        vec![],
                    )
                }
                // The same server as now: back, with no check.
                Ok(address) if store_key(&address) == store_key(&session.server) => restore(*back),
                Ok(address) => {
                    chooser.problem = None;
                    (
                        session.with(
                            P::Checking {
                                back,
                                chooser,
                                address: address.clone(),
                                choice,
                            },
                            Window::Checking {
                                address: address.clone(),
                            },
                        ),
                        vec![Effect::CheckServer { address }],
                    )
                }
            }
        }
        (P::Choosing { back, .. }, E::CancelPressed) => restore(*back),
        (
            P::Checking {
                back, mut chooser, ..
            },
            E::CancelPressed,
        ) => {
            chooser.problem = None;
            (
                session.with(
                    P::Choosing {
                        back,
                        chooser: chooser.clone(),
                    },
                    Window::Choose { chooser },
                ),
                vec![],
            )
        }
        (
            P::Checking {
                back,
                mut chooser,
                address,
                choice,
            },
            E::ServerChecked {
                address: asked,
                answer,
            },
        ) if asked == address => match answer {
            ServerAnswer::Answered(Kind::Compatible) => {
                (session, vec![Effect::SwitchServer { address }])
            }
            ServerAnswer::Answered(Kind::ServerOlder) => (
                incompatible(&session, back, chooser, address, Mismatch::ServerOlder),
                vec![],
            ),
            ServerAnswer::Answered(Kind::AppOlder) => (
                incompatible(&session, back, chooser, address, Mismatch::AppOlder),
                vec![],
            ),
            // This computer's own server not answering is the "not running here" window.
            ServerAnswer::NoAnswer if choice == ServerChoice::ThisComputer => (
                session.with(
                    P::NotAnswering {
                        back,
                        target: address,
                        chooser: Some(chooser),
                    },
                    Window::NotAnswering,
                ),
                vec![Effect::ScheduleRetry],
            ),
            ServerAnswer::NoAnswer | ServerAnswer::Answered(Kind::NotBakery) => {
                chooser.problem = Some(if answer == ServerAnswer::NoAnswer {
                    ChooserProblem::NoAnswer
                } else {
                    ChooserProblem::NotBakery
                });
                (
                    session.with(
                        P::Choosing {
                            back,
                            chooser: chooser.clone(),
                        },
                        Window::Choose { chooser },
                    ),
                    vec![],
                )
            }
        },
        (P::Incompatible { back, chooser, .. }, E::ChooseDifferent) => (
            session.with(
                P::Choosing {
                    back,
                    chooser: chooser.clone(),
                },
                Window::Choose { chooser },
            ),
            vec![],
        ),
        (P::Incompatible { address, .. }, E::UseItAnyway) => {
            (session, vec![Effect::SwitchServer { address }])
        }

        // ---- the server is not answering --------------------------------------------------
        // Asked as the app opens: a server that does not answer is the same window as at sign-in.
        (P::SignedOut | P::SignedIn, E::CurrentChecked { answered: false }) => {
            let target = session.server.clone();
            (
                Session {
                    phase: P::NotAnswering {
                        back: Box::new(session.clone()),
                        target,
                        chooser: None,
                    },
                    window: Window::NotAnswering,
                    resuming: session.resuming,
                    server: session.server.clone(),
                    notice: None,
                    last_other: session.last_other.clone(),
                },
                vec![Effect::ScheduleRetry],
            )
        }
        (
            P::NotAnswering {
                back,
                chooser: None,
                ..
            },
            E::CurrentChecked { answered: true },
        ) => restore(*back),
        (P::NotAnswering { .. }, E::CurrentChecked { answered: false }) => {
            (session, vec![Effect::ScheduleRetry])
        }
        (P::NotAnswering { chooser: None, .. }, E::RetryNow | E::RetryTick) => {
            (session, vec![Effect::CheckCurrent])
        }
        (
            P::NotAnswering {
                target,
                chooser: Some(_),
                ..
            },
            E::RetryNow | E::RetryTick,
        ) => (session, vec![Effect::CheckServer { address: target }]),
        (
            P::NotAnswering {
                back,
                target,
                chooser: Some(chooser),
            },
            E::ServerChecked {
                address: asked,
                answer,
            },
        ) if asked == target => match answer {
            ServerAnswer::NoAnswer => (session, vec![Effect::ScheduleRetry]),
            ServerAnswer::Answered(Kind::Compatible) => {
                (session, vec![Effect::SwitchServer { address: target }])
            }
            ServerAnswer::Answered(Kind::ServerOlder) => (
                incompatible(&session, back, chooser, target, Mismatch::ServerOlder),
                vec![],
            ),
            ServerAnswer::Answered(Kind::AppOlder) => (
                incompatible(&session, back, chooser, target, Mismatch::AppOlder),
                vec![],
            ),
            ServerAnswer::Answered(Kind::NotBakery) => {
                let mut chooser = chooser;
                chooser.problem = Some(ChooserProblem::NotBakery);
                (
                    session.with(
                        P::Choosing {
                            back,
                            chooser: chooser.clone(),
                        },
                        Window::Choose { chooser },
                    ),
                    vec![],
                )
            }
        },
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
    fn a_server_that_cannot_be_reached_to_start_says_so_and_asks_again_by_itself() {
        let (asking, _) = run(Session::start(false), vec![E::SignInPressed]);
        let (s, effects) = step(asking, E::RequestFailed);
        assert_eq!(s.window(), &Window::NotAnswering);
        assert_eq!(effects, vec![Effect::ScheduleRetry]);
        // Try again, or the quiet timer, asks the server; its answer brings the sign-in window back.
        assert_eq!(step(s.clone(), E::RetryNow).1, vec![Effect::CheckCurrent]);
        assert_eq!(step(s.clone(), E::RetryTick).1, vec![Effect::CheckCurrent]);
        let (back, _) = step(s, E::CurrentChecked { answered: true });
        assert_eq!(back.window(), &Window::SignIn);
        assert_eq!(step(back, E::SignInPressed).1, vec![Effect::StartRequest]);
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
        // The only thing it does is end the unused sign-in on the server: nothing is stored anywhere.
        let (revoking, effects) = step(storing(), E::StoreFailed);
        assert_eq!(effects, vec![Effect::RevokeUnstored]);
        let (s, effects) = step(
            revoking,
            E::UnstoredRevoked {
                ended_on_server: true,
            },
        );
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
    fn only_a_signed_in_app_signs_out_and_it_ends_the_sign_in_on_the_server_too() {
        let (going, effects) = step(signed_in(), E::SignOutPressed);
        assert_eq!(going.window(), &Window::SigningOut);
        assert_eq!(effects, vec![Effect::SignOutRemote]);
        for ended in [true, false] {
            let (after, effects) = step(
                going.clone(),
                E::SignedOutRemote {
                    ended_on_server: ended,
                },
            );
            assert_eq!(
                after.window(),
                &Window::SignedOut {
                    ended_on_server: ended
                }
            );
            assert!(
                effects.is_empty(),
                "the shell already removed it from this computer"
            );
            assert!(!after.is_signed_in());
            assert!(!after.in_dialog());
        }
        // Anywhere else the button does not exist, so the event changes nothing.
        for s in [
            Session::start(false),
            waiting(),
            exchanging(),
            stalled(),
            storing(),
        ] {
            let (after, effects) = step(s.clone(), E::SignOutPressed);
            assert_eq!(after, s);
            assert!(effects.is_empty());
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
            E::SignOutPressed,
            E::SignedOutRemote {
                ended_on_server: true,
            },
            E::UnstoredRevoked {
                ended_on_server: false,
            },
            E::UseDifferentServer,
            E::ThisComputerChecked { answering: true },
            E::ChooserContinue {
                choice: ServerChoice::Another,
                typed: "bakery.example.com".into(),
            },
            E::ChooserContinue {
                choice: ServerChoice::ThisComputer,
                typed: String::new(),
            },
            E::ServerChecked {
                address: "https://bakery.example.com".into(),
                answer: ServerAnswer::NoAnswer,
            },
            E::ChooseDifferent,
            E::UseItAnyway,
            E::CurrentChecked { answered: false },
            E::CurrentChecked { answered: true },
            E::RetryNow,
            E::RetryTick,
        ];
        for s in &sessions {
            for e in &events {
                // Every event in every state is handled without a panic.
                let (_, effects) = step(s.clone(), e.clone());
                for effect in effects {
                    match (&effect, e) {
                        (Effect::StoreCredential, E::ExchangeSucceeded) => {}
                        (Effect::ClearCredential, E::CredentialRejected) => {}
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

#[cfg(test)]
mod server_tests {
    //! Choosing a server, asking whether it answers, and ending a sign-in (#77 slice 4). Every row
    //! of design-ux's tables is a test: what shows, what the app does, and what stays untouched.
    use super::*;
    use Event as E;

    const HERE: &str = "http://127.0.0.1:8000";
    const SERVER: &str = "https://bakery.acme.example";
    const OTHER: &str = "https://bakery.example.com";

    fn signed_out() -> Session {
        Session::start(false).on_server(SERVER)
    }

    fn signed_in() -> Session {
        Session::start(true).on_server(SERVER)
    }

    fn run(mut session: Session, events: Vec<Event>) -> (Session, Vec<Effect>) {
        let mut all = vec![];
        for event in events {
            let (next, effects) = step(session, event);
            session = next;
            all.extend(effects);
        }
        (session, all)
    }

    fn chooser_of(session: &Session) -> Chooser {
        match session.window() {
            Window::Choose { chooser } => chooser.clone(),
            other => panic!("not the chooser: {other:?}"),
        }
    }

    fn open_chooser(from: Session) -> Session {
        run(
            from,
            vec![
                E::UseDifferentServer,
                E::ThisComputerChecked { answering: true },
            ],
        )
        .0
    }

    fn continue_with(choice: ServerChoice, typed: &str) -> Event {
        E::ChooserContinue {
            choice,
            typed: typed.into(),
        }
    }

    #[test]
    fn the_chooser_opens_from_every_window_that_offers_it_and_asks_this_computer_once() {
        for from in [signed_out(), signed_in()] {
            let (s, effects) = step(from, E::UseDifferentServer);
            assert_eq!(effects, vec![Effect::CheckThisComputer]);
            assert!(matches!(s.window(), Window::Choose { .. }));
        }
        let down = run(signed_out(), vec![E::SignInPressed, E::RequestFailed]).0;
        let (s, effects) = step(down, E::UseDifferentServer);
        assert_eq!(effects, vec![Effect::CheckThisComputer]);
        assert!(matches!(s.window(), Window::Choose { .. }));
        // Where the app cannot ask (the person is mid sign-in), the button does not exist.
        let waiting = run(signed_out(), vec![E::SignInPressed]).0;
        assert_eq!(step(waiting.clone(), E::UseDifferentServer).0, waiting);
    }

    #[test]
    fn the_option_for_the_current_server_is_selected_and_the_other_box_remembers_its_address() {
        let here = open_chooser(Session::start(false).on_server(HERE));
        assert_eq!(chooser_of(&here).selected, ServerChoice::ThisComputer);
        assert_eq!(chooser_of(&here).typed, "");
        // On this computer the box offers the last other address again.
        // A server on this computer at another port starts under "Another address", showing itself.
        let nearby = open_chooser(Session::start(false).on_server("http://127.0.0.1:46289"));
        assert_eq!(chooser_of(&nearby).selected, ServerChoice::Another);
        assert_eq!(chooser_of(&nearby).typed, "http://127.0.0.1:46289");
        let remembered = open_chooser(Session::start(false).on_server(HERE).with_last_other(OTHER));
        assert_eq!(chooser_of(&remembered).typed, OTHER);
        assert_eq!(chooser_of(&remembered).selected, ServerChoice::ThisComputer);
        let elsewhere = open_chooser(signed_out());
        assert_eq!(chooser_of(&elsewhere).selected, ServerChoice::Another);
        assert_eq!(chooser_of(&elsewhere).typed, SERVER);
        assert!(!chooser_of(&elsewhere).signed_in);
        assert!(chooser_of(&open_chooser(signed_in())).signed_in);
    }

    #[test]
    fn what_this_computer_answered_is_shown_and_either_answer_leaves_the_option_choosable() {
        for (answering, want) in [
            (true, Availability::Answering),
            (false, Availability::NotAnswering),
        ] {
            let s = run(
                signed_out(),
                vec![E::UseDifferentServer, E::ThisComputerChecked { answering }],
            )
            .0;
            assert_eq!(chooser_of(&s).this_computer, want);
        }
        // A late answer after the chooser closed changes nothing.
        let closed = signed_out();
        assert_eq!(
            step(closed.clone(), E::ThisComputerChecked { answering: true }).0,
            closed
        );
    }

    #[test]
    fn cancel_goes_back_to_where_the_person_came_from_and_changes_nothing() {
        for from in [signed_out(), signed_in()] {
            let (back, effects) = step(open_chooser(from.clone()), E::CancelPressed);
            assert_eq!(back, from);
            assert!(effects.is_empty());
        }
    }

    #[test]
    fn each_address_problem_keeps_the_chooser_open_with_what_was_typed() {
        for (typed, want) in [
            ("   ", ChooserProblem::Empty),
            ("ftp://bakery.example.com", ChooserProblem::NotWebAddress),
            (
                "https://ana:secret@bakery.example.com",
                ChooserProblem::HasCredentials,
            ),
            ("http://bakery.example.com", ChooserProblem::PlainHttp),
        ] {
            let (s, effects) = step(
                open_chooser(signed_out()),
                continue_with(ServerChoice::Another, typed),
            );
            assert!(effects.is_empty(), "{typed}: nothing is asked");
            let c = chooser_of(&s);
            assert_eq!(c.problem, Some(want), "{typed}");
            assert_eq!(c.typed, typed);
            assert_eq!(c.selected, ServerChoice::Another);
        }
    }

    #[test]
    fn the_same_server_as_now_goes_back_with_no_check_however_it_is_written() {
        for typed in [
            SERVER,
            "bakery.acme.example",
            "https://BAKERY.acme.example/issues",
            "https://bakery.acme.example/",
        ] {
            let from = signed_out();
            let (back, effects) = step(
                open_chooser(from.clone()),
                continue_with(ServerChoice::Another, typed),
            );
            assert_eq!(back, from, "{typed}");
            assert!(effects.is_empty(), "{typed}");
        }
        let here = Session::start(false).on_server(HERE);
        let (back, effects) = step(
            open_chooser(here.clone()),
            continue_with(ServerChoice::ThisComputer, ""),
        );
        assert_eq!(back, here);
        assert!(effects.is_empty());
    }

    #[test]
    fn a_new_address_is_checked_and_what_was_typed_is_cleaned_before_it_is_asked() {
        let (s, effects) = step(
            open_chooser(signed_out()),
            continue_with(ServerChoice::Another, "bakery.example.com/tasks/42"),
        );
        assert_eq!(
            s.window(),
            &Window::Checking {
                address: OTHER.into()
            }
        );
        assert_eq!(
            effects,
            vec![Effect::CheckServer {
                address: OTHER.into()
            }]
        );
        assert_eq!(s.shown_server(), OTHER);
    }

    #[test]
    fn cancel_while_checking_returns_to_the_chooser_with_what_was_typed() {
        let checking = step(
            open_chooser(signed_out()),
            continue_with(ServerChoice::Another, OTHER),
        )
        .0;
        let (s, effects) = step(checking, E::CancelPressed);
        assert!(effects.is_empty());
        let c = chooser_of(&s);
        assert_eq!(c.typed, OTHER);
        assert_eq!(c.problem, None);
    }

    fn checking_other() -> Session {
        step(
            open_chooser(signed_out()),
            continue_with(ServerChoice::Another, OTHER),
        )
        .0
    }

    #[test]
    fn a_bakery_server_at_the_apps_level_is_switched_to() {
        let (s, effects) = step(
            checking_other(),
            E::ServerChecked {
                address: OTHER.into(),
                answer: ServerAnswer::Answered(Kind::Compatible),
            },
        );
        assert_eq!(
            effects,
            vec![Effect::SwitchServer {
                address: OTHER.into()
            }]
        );
        // Until the app restarts, the window stays the one that says it is checking.
        assert!(matches!(s.window(), Window::Checking { .. }));
    }

    #[test]
    fn an_address_that_does_not_answer_or_is_not_bakery_leaves_the_chooser_open_with_its_sentence()
    {
        for (answer, want) in [
            (ServerAnswer::NoAnswer, ChooserProblem::NoAnswer),
            (
                ServerAnswer::Answered(Kind::NotBakery),
                ChooserProblem::NotBakery,
            ),
        ] {
            let (s, effects) = step(
                checking_other(),
                E::ServerChecked {
                    address: OTHER.into(),
                    answer,
                },
            );
            assert!(effects.is_empty());
            let c = chooser_of(&s);
            assert_eq!(c.problem, Some(want));
            assert_eq!(c.typed, OTHER);
        }
    }

    #[test]
    fn an_answer_for_an_address_that_is_no_longer_asked_is_ignored() {
        let checking = checking_other();
        let (same, effects) = step(
            checking.clone(),
            E::ServerChecked {
                address: "https://stale.example.com".into(),
                answer: ServerAnswer::NoAnswer,
            },
        );
        assert_eq!(same, checking);
        assert!(effects.is_empty());
    }

    #[test]
    fn a_server_older_or_newer_than_the_app_has_its_own_panel_with_two_ways_on() {
        for (kind, mismatch) in [
            (Kind::ServerOlder, Mismatch::ServerOlder),
            (Kind::AppOlder, Mismatch::AppOlder),
        ] {
            let (s, effects) = step(
                checking_other(),
                E::ServerChecked {
                    address: OTHER.into(),
                    answer: ServerAnswer::Answered(kind),
                },
            );
            assert!(effects.is_empty());
            assert_eq!(
                s.window(),
                &Window::Incompatible {
                    mismatch,
                    address: OTHER.into()
                }
            );
            // Use it anyway switches; Choose a different server returns to the chooser, text kept.
            assert_eq!(
                step(s.clone(), E::UseItAnyway).1,
                vec![Effect::SwitchServer {
                    address: OTHER.into()
                }]
            );
            let (back, _) = step(s, E::ChooseDifferent);
            assert_eq!(chooser_of(&back).typed, OTHER);
        }
    }

    #[test]
    fn this_computer_not_answering_is_the_not_running_window_and_it_asks_again_by_itself() {
        let (s, _) = step(
            open_chooser(signed_out()),
            continue_with(ServerChoice::ThisComputer, ""),
        );
        let (down, effects) = step(
            s,
            E::ServerChecked {
                address: HERE.into(),
                answer: ServerAnswer::NoAnswer,
            },
        );
        assert_eq!(down.window(), &Window::NotAnswering);
        assert_eq!(down.shown_server(), HERE);
        assert_eq!(effects, vec![Effect::ScheduleRetry]);
        // The quiet retry asks the server it was about, not the one the app shows now.
        assert_eq!(
            step(down.clone(), E::RetryTick).1,
            vec![Effect::CheckServer {
                address: HERE.into()
            }]
        );
        assert_eq!(
            step(down.clone(), E::RetryNow).1,
            vec![Effect::CheckServer {
                address: HERE.into()
            }]
        );
        // Still silent: the timer is set again.
        let (_, effects) = step(
            down.clone(),
            E::ServerChecked {
                address: HERE.into(),
                answer: ServerAnswer::NoAnswer,
            },
        );
        assert_eq!(effects, vec![Effect::ScheduleRetry]);
        // When it answers, the app moves on by itself.
        let (_, effects) = step(
            down,
            E::ServerChecked {
                address: HERE.into(),
                answer: ServerAnswer::Answered(Kind::Compatible),
            },
        );
        assert_eq!(
            effects,
            vec![Effect::SwitchServer {
                address: HERE.into()
            }]
        );
    }

    #[test]
    fn a_server_that_is_not_answering_as_the_app_opens_is_the_same_window_for_both_openings() {
        for from in [signed_out(), signed_in()] {
            let (down, effects) = step(from.clone(), E::CurrentChecked { answered: false });
            assert_eq!(down.window(), &Window::NotAnswering);
            assert_eq!(effects, vec![Effect::ScheduleRetry]);
            // Silence again keeps asking; an answer returns to the window the app opened on.
            assert_eq!(
                step(down.clone(), E::CurrentChecked { answered: false }).1,
                vec![Effect::ScheduleRetry]
            );
            assert_eq!(step(down, E::CurrentChecked { answered: true }).0, from);
        }
        // An answer while nothing is wrong changes nothing.
        let fine = signed_out();
        assert_eq!(
            step(fine.clone(), E::CurrentChecked { answered: true }).0,
            fine
        );
    }

    #[test]
    fn the_app_asks_the_server_as_it_opens() {
        assert_eq!(signed_out().opened(), vec![Effect::CheckCurrent]);
        assert_eq!(signed_in().opened(), vec![Effect::CheckCurrent]);
    }

    #[test]
    fn the_chooser_opened_from_the_not_answering_window_returns_to_it_and_starts_the_retry_again() {
        let down = step(signed_out(), E::CurrentChecked { answered: false }).0;
        let (chooser, _) = step(down.clone(), E::UseDifferentServer);
        // The timer that ran before is not counted on while the chooser is open: ticks do nothing.
        assert!(step(chooser.clone(), E::RetryTick).1.is_empty());
        let (back, effects) = step(chooser, E::CancelPressed);
        assert_eq!(back, down);
        assert_eq!(effects, vec![Effect::ScheduleRetry]);
    }

    #[test]
    fn a_notice_goes_with_the_next_action_and_stays_through_events_that_change_nothing() {
        let carried = signed_out().with_notice(Notice::Switched {
            address: OTHER.into(),
        });
        assert!(carried.notice().is_some());
        assert!(step(carried.clone(), E::CurrentChecked { answered: true })
            .0
            .notice()
            .is_some());
        assert!(step(carried.clone(), E::SignInPressed).0.notice().is_none());
        assert!(step(carried, E::UseDifferentServer).0.notice().is_none());
    }

    #[test]
    fn a_link_while_signed_out_asks_for_a_sign_in_and_changes_nothing_else() {
        let (after, effects) = step(signed_out(), E::OpenLinkArrived);
        assert_eq!(after.notice(), Some(&Notice::SignInForLink));
        assert_eq!(after.window(), signed_out().window());
        assert!(effects.is_empty());
        // The next action takes the notice with it, like every notice.
        assert!(step(after, E::SignInPressed).0.notice().is_none());
    }

    #[test]
    fn a_link_in_any_other_state_changes_nothing_on_screen() {
        let waiting = run(
            signed_out(),
            vec![
                E::SignInPressed,
                E::RequestStarted {
                    id: "r".into(),
                    confirm_url: "u".into(),
                    expires_at: None,
                },
            ],
        )
        .0;
        for before in [waiting, Session::start(true).on_server(SERVER)] {
            let (after, effects) = step(before.clone(), E::OpenLinkArrived);
            assert_eq!(after, before);
            assert!(effects.is_empty());
        }
    }

    #[test]
    fn a_sign_in_the_keyring_refused_is_ended_on_the_server_before_the_window_says_so() {
        let storing = run(
            signed_out(),
            vec![
                E::SignInPressed,
                E::RequestStarted {
                    id: "r".into(),
                    confirm_url: "u".into(),
                    expires_at: None,
                },
                E::CallbackReceived { code: "c".into() },
                E::ExchangeSucceeded,
            ],
        )
        .0;
        let (revoking, effects) = step(storing, E::StoreFailed);
        assert_eq!(effects, vec![Effect::RevokeUnstored]);
        assert_eq!(
            revoking.window(),
            &Window::Finishing,
            "nothing to press while it is ended"
        );
        for (ended, want) in [
            (true, Refusal::NoKeyring),
            (false, Refusal::NoKeyringStillListed),
        ] {
            let (after, effects) = step(
                revoking.clone(),
                E::UnstoredRevoked {
                    ended_on_server: ended,
                },
            );
            assert_eq!(after.window(), &Window::Refusal { refusal: want });
            assert!(effects.is_empty());
            assert!(!after.is_signed_in());
        }
    }
}
