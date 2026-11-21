//! Which links the app follows, and where (#77 slice 5). Pure decisions with no window system, so
//! every case runs in a unit test on any host.
//!
//! Two questions: what to do with a link the window is about to follow (stay in the window, hand it
//! to the system browser, or refuse it), and whether a `bakery://open` address from the operating
//! system names a page of the connected server that the window may show.

use crate::csp::server_origins;
use crate::platform::{ORIGIN_UNIX, ORIGIN_WINDOWS};
use url::Url;

/// What the window does with a link it is about to follow.
#[derive(Debug, PartialEq, Eq)]
pub enum Navigation {
    /// The link is one of the app's own pages or a page of the connected server.
    Stay,
    /// A web address elsewhere: the system browser opens it, the window stays where it is.
    Browser,
    /// Not followed at all, with the reason kept for the log.
    Refuse(&'static str),
}

/// The longest page address an `open` link may carry.
const MAX_PATH: usize = 2048;

/// Decide a navigation. `server` is the connected server's address as configured.
pub fn navigation(server: &str, target: &str) -> Navigation {
    let Ok(url) = Url::parse(target) else {
        return Navigation::Refuse("not a url");
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Navigation::Refuse("carries a login");
    }
    match url.scheme() {
        "https" | "http" => {
            if is_own_origin(server, &url) {
                Navigation::Stay
            } else {
                Navigation::Browser
            }
        }
        // The app's own pages, in the form the web view reports them.
        "tauri" if origin_of(&url) == ORIGIN_UNIX => Navigation::Stay,
        _ => Navigation::Refuse("not a web address"),
    }
}

fn origin_of(url: &Url) -> String {
    let host = url.host_str().unwrap_or_default();
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    format!("{}://{host}{port}", url.scheme())
}

fn is_own_origin(server: &str, url: &Url) -> bool {
    let own = origin_of(url);
    own == ORIGIN_WINDOWS || server_origins(server).is_some_and(|(origin, _)| origin == own)
}

/// The page an `open` link names, as a path with its query, or the reason it is refused. The form is
/// `bakery://open?path=%2Fsome%2Fpage`. Only a path on the connected server is accepted: it starts
/// with one slash, names no other host, climbs no directory and carries no control character.
pub fn open_target(raw: &str) -> Result<String, &'static str> {
    let Ok(url) = Url::parse(raw) else {
        return Err("not a url");
    };
    if url.scheme() != "bakery" || url.host_str() != Some("open") || !matches!(url.path(), "" | "/")
    {
        return Err("not an open link");
    }
    let mut paths = url.query_pairs().filter(|(k, _)| k == "path");
    let (Some((_, path)), None) = (paths.next(), paths.next()) else {
        return Err("needs exactly one path");
    };
    page_path(&path).map(str::to_string)
}

fn page_path(path: &str) -> Result<&str, &'static str> {
    if path.len() > MAX_PATH {
        return Err("path too long");
    }
    if !path.starts_with('/') || path.starts_with("//") {
        return Err("not a path on this server");
    }
    if path.chars().any(|c| c.is_control() || c == '\\') {
        return Err("path holds a forbidden character");
    }
    let before_query = path.split(['?', '#']).next().unwrap_or_default();
    if before_query
        .split('/')
        .any(|segment| matches!(segment, ".." | "%2e%2e" | "%2E%2E" | ".%2e" | "%2e."))
    {
        return Err("path climbs a directory");
    }
    Ok(path)
}

/// The address the window loads for an accepted path on a server, or `None` when the server is not a
/// plain Bakery address.
pub fn page_url(server: &str, path: &str) -> Option<String> {
    let (origin, _) = server_origins(server)?;
    Some(format!("{origin}{path}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SERVER: &str = "https://bakery.example.com";

    #[test]
    fn a_page_of_the_connected_server_stays_in_the_window() {
        assert_eq!(
            navigation(SERVER, "https://bakery.example.com/tasks/7?x=1"),
            Navigation::Stay
        );
        assert_eq!(
            navigation("HTTPS://Bakery.Example.com/", "https://bakery.example.com/"),
            Navigation::Stay
        );
    }

    #[test]
    fn the_apps_own_pages_stay_in_the_window() {
        assert_eq!(navigation(SERVER, "tauri://localhost/index.html"), Navigation::Stay);
        assert_eq!(navigation(SERVER, "http://tauri.localhost/"), Navigation::Stay);
    }

    #[test]
    fn another_web_address_goes_to_the_system_browser() {
        for other in [
            "https://example.org/",
            "http://bakery.example.com/",
            "https://bakery.example.com:8443/",
            "https://bakery.example.com.evil.test/",
            "https://evil.test/https://bakery.example.com/",
        ] {
            assert_eq!(navigation(SERVER, other), Navigation::Browser, "{other}");
        }
    }

    #[test]
    fn an_address_with_a_login_is_never_followed() {
        assert_eq!(
            navigation(SERVER, "https://bakery.example.com@evil.test/"),
            Navigation::Refuse("carries a login")
        );
    }

    #[test]
    fn schemes_that_are_not_web_addresses_are_refused() {
        for odd in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,hi",
            "bakery://auth/callback?code=x",
            "tauri://evil/",
            "ftp://bakery.example.com/",
            "not a url",
        ] {
            assert!(matches!(navigation(SERVER, odd), Navigation::Refuse(_)), "{odd}");
        }
    }

    #[test]
    fn an_open_link_names_a_page_of_the_server() {
        assert_eq!(
            open_target("bakery://open?path=%2Ftasks%2F7%3Ftab%3Dfiles"),
            Ok("/tasks/7?tab=files".to_string())
        );
        assert_eq!(open_target("bakery://open/?path=%2F"), Ok("/".to_string()));
    }

    #[test]
    fn an_open_link_that_is_not_a_plain_path_is_refused() {
        for (raw, why) in [
            ("bakery://open", "needs exactly one path"),
            ("bakery://open?path=", "not a path on this server"),
            ("bakery://open?path=tasks", "not a path on this server"),
            ("bakery://open?path=%2F%2Fevil.test", "not a path on this server"),
            ("bakery://open?path=https%3A%2F%2Fevil.test", "not a path on this server"),
            ("bakery://open?path=%2Fa%2F..%2Fb", "path climbs a directory"),
            ("bakery://open?path=%2F%2e%2e%2Fb", "path climbs a directory"),
            ("bakery://open?path=%5Cevil", "not a path on this server"),
            ("bakery://open?path=%2Fa%5Cb", "path holds a forbidden character"),
            ("bakery://open?path=%2Fa%0Ab", "path holds a forbidden character"),
            ("bakery://open?path=%2Fa&path=%2Fb", "needs exactly one path"),
            ("bakery://open/extra?path=%2Fa", "not an open link"),
            ("bakery://auth/callback?path=%2Fa", "not an open link"),
            ("https://open?path=%2Fa", "not an open link"),
            ("nonsense", "not a url"),
        ] {
            assert_eq!(open_target(raw), Err(why), "{raw}");
        }
    }

    #[test]
    fn a_long_path_is_refused() {
        let long = format!("bakery://open?path=%2F{}", "a".repeat(MAX_PATH));
        assert_eq!(open_target(&long), Err("path too long"));
    }

    #[test]
    fn a_page_url_joins_the_servers_origin_and_the_path() {
        assert_eq!(
            page_url("https://bakery.example.com/", "/tasks/7?x=1"),
            Some("https://bakery.example.com/tasks/7?x=1".to_string())
        );
        assert_eq!(page_url("bakery.example.com", "/"), None);
        assert_eq!(page_url("https://bakery.example.com/app", "/"), None);
    }
}
