//! The words on each window, as the design gives them (#77, design revisions 1 and 2).
//!
//! Layouts are design-ux's and arrive separately; this is only what each window says. The server's
//! name is the one thing filled in. No window says "PKCE", "token", "callback", "loopback" or
//! "bearer": the design bans them, and a test holds it to that.

use crate::session::{Refusal, Window};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Copy {
    pub title: String,
    pub body: String,
    /// The one button that takes focus when the window appears.
    pub primary: String,
    pub secondary: Vec<String>,
    /// Whether the window names the server it will connect to, as its own line.
    pub shows_server: bool,
    /// A status line shown while the app waits.
    pub status: Option<String>,
}

fn copy(title: &str, body: &str, primary: &str) -> Copy {
    Copy {
        title: title.into(),
        body: body.into(),
        primary: primary.into(),
        secondary: vec![],
        shows_server: false,
        status: None,
    }
}

/// The words for a window, or `None` for the app itself, which is the web app's own pages.
pub fn copy_for(window: &Window, server: &str) -> Option<Copy> {
    Some(match window {
        Window::SignIn => Copy {
            secondary: vec!["Use a different server".into()],
            shows_server: true,
            ..copy(
                "Sign in to Bakery",
                "Bakery opens your browser to sign in, then brings you back here.",
                "Sign in with your browser",
            )
        },
        Window::Waiting => Copy {
            secondary: vec!["Cancel".into()],
            status: Some("Waiting for your browser…".into()),
            ..copy(
                "Finish signing in in your browser",
                &format!("A browser tab opened at {server}. Sign in there and this window continues by itself."),
                "Open the browser again",
            )
        },
        Window::Expired => copy("That sign-in attempt ran out of time.", "Nothing was saved.", "Try again"),
        Window::Refusal { refusal } => match refusal {
            Refusal::NotCompleted => copy(
                "Sign-in was not completed",
                "The answer from the browser did not match this sign-in attempt, so it was ignored. Nothing was saved. Try again.",
                "Try again",
            ),
            Refusal::Cancelled => copy("Sign-in was cancelled", "Nothing was saved.", "Sign in with your browser"),
            Refusal::CannotReach => copy(
                &format!("Bakery could not reach {server}"),
                "Check that the server is running and that the address is right.",
                "Try again",
            ),
            // The button is not in the design, which gives each refusal one of two buttons and
            // none for this case, where the person is already signed in. Raised with design-ux.
            Refusal::StorageRefused { reason } => copy(
                "Bakery could not save your sign-in on this computer",
                &format!("{reason} You can still use Bakery now; you will have to sign in again next time."),
                "Continue",
            ),
            Refusal::NoAccount => copy(
                &format!("You do not have an account on {server}"),
                "Ask an administrator for an invitation.",
                "Sign in with your browser",
            ),
        },
        Window::SignInAgain => Copy {
            secondary: vec!["Quit Bakery".into()],
            ..copy(
                "Sign in again to continue",
                "Your sign-in on this computer ended. What you typed on this page is kept.",
                "Sign in with your browser",
            )
        },
        Window::App => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn every_window() -> Vec<Window> {
        let mut all = vec![
            Window::SignIn,
            Window::Waiting,
            Window::Expired,
            Window::SignInAgain,
        ];
        for r in [
            Refusal::NotCompleted,
            Refusal::Cancelled,
            Refusal::CannotReach,
            Refusal::StorageRefused {
                reason: "The keyring is locked.".into(),
            },
            Refusal::NoAccount,
        ] {
            all.push(Window::Refusal { refusal: r });
        }
        all
    }

    #[test]
    fn every_window_has_a_heading_and_one_primary_button() {
        for window in every_window() {
            let words =
                copy_for(&window, "https://bakery.example.com").expect("a window with words");
            assert!(!words.title.trim().is_empty(), "{window:?}");
            assert!(!words.primary.trim().is_empty(), "{window:?}");
        }
    }

    #[test]
    fn the_app_itself_has_no_words_of_its_own() {
        assert_eq!(copy_for(&Window::App, "s"), None);
    }

    #[test]
    fn no_window_says_a_word_the_design_bans() {
        let banned = [
            "pkce",
            "token",
            "callback",
            "loopback",
            "bearer",
            "credential",
            "verifier",
            "bkd_",
        ];
        for window in every_window() {
            let words = copy_for(&window, "https://bakery.example.com").unwrap();
            let shown = format!(
                "{} {} {} {} {}",
                words.title,
                words.body,
                words.primary,
                words.secondary.join(" "),
                words.status.unwrap_or_default()
            )
            .to_lowercase();
            for word in banned {
                assert!(!shown.contains(word), "{window:?} says {word:?}: {shown}");
            }
        }
    }

    #[test]
    fn the_server_is_named_where_the_design_names_it() {
        let server = "https://bakery.example.com";
        let named = |w: Window| {
            let c = copy_for(&w, server).unwrap();
            format!("{} {}", c.title, c.body).contains(server)
        };
        assert!(named(Window::Waiting));
        assert!(named(Window::Refusal {
            refusal: Refusal::CannotReach
        }));
        assert!(named(Window::Refusal {
            refusal: Refusal::NoAccount
        }));
        // The first window shows it as its own line instead.
        assert!(copy_for(&Window::SignIn, server).unwrap().shows_server);
    }

    #[test]
    fn a_refusal_says_that_nothing_was_saved_or_what_to_do_next() {
        for refusal in [Refusal::NotCompleted, Refusal::Cancelled] {
            let c = copy_for(&Window::Refusal { refusal }, "s").unwrap();
            assert!(c.body.contains("Nothing was saved"), "{}", c.body);
        }
        let c = copy_for(
            &Window::Refusal {
                refusal: Refusal::CannotReach,
            },
            "s",
        )
        .unwrap();
        assert!(c.body.starts_with("Check that"), "{}", c.body);
    }

    #[test]
    fn the_storage_notice_carries_the_systems_reason_and_says_the_person_can_carry_on() {
        let w = Window::Refusal {
            refusal: Refusal::StorageRefused {
                reason: "The keyring is locked.".into(),
            },
        };
        let c = copy_for(&w, "s").unwrap();
        assert!(c.body.starts_with("The keyring is locked."));
        assert!(c.body.contains("You can still use Bakery now"));
    }
}
