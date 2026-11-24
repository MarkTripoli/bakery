//! Which links the app follows, and where (#77 slice 5). Pure decisions with no window system, so
//! every case runs in a unit test on any host.
//!
//! Two questions: what to do with a link the window is about to follow (stay in the window, hand it
//! to the system browser, or refuse it), and whether a `bakery://open` address from the operating
//! system names a page of the connected server that the window may show.

use crate::address::parse_server_address;
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
    /// `mailto:` and `tel:`: handed to the system, as a browser does.
    System,
    /// Not followed at all. The scheme is what the "not a web link" dialog names; it is empty when
    /// the text is not an address at all.
    Refuse {
        scheme: String,
        reason: &'static str,
    },
}

/// Paths the server answers itself or that start or end a sign-in. The web router serves every
/// other path, and a link may only open a page: never an API call, a health check, a sign-in or a
/// sign-out.
const SERVER_OWNED: [&str; 9] = [
    "/v1",
    "/api",
    "/auth",
    "/health",
    "/mcp",
    "/_bakery",
    "/.well-known",
    "/desktop",
    "/oauth",
];
const SIGN_IN_OUT: [&str; 2] = ["/sign-in", "/sign-out"];

fn owns(path: &str, prefix: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower == prefix || lower.starts_with(&format!("{prefix}/"))
}

/// The scheme a notice's buttons navigate to when they ask the app for something. The app answers it
/// itself and never loads it.
pub const ACTION_SCHEME: &str = "bakery-action";

/// What a notice's button asks for, as `(action, notice id)`, when the address is exactly
/// `bakery-action://<nonce>/<action>/<id>` and the nonce is this run's. The nonce is made when the app
/// starts and lives in the buttons the app draws, which means in the server page they are drawn in: it
/// stops any other sender, or an address without it, from asking for anything, and does not hide it from
/// that page.
pub fn toast_action(raw: &str, nonce: &str) -> Option<(String, u64)> {
    if nonce.is_empty() {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != ACTION_SCHEME
        || url.host_str() != Some(nonce)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return None;
    }
    let mut parts = url.path().trim_start_matches('/').split('/');
    let action = parts
        .next()
        .filter(|a| matches!(*a, "show" | "retry" | "restart" | "later"))?;
    let id = parts.next()?.parse().ok()?;
    parts.next().is_none().then(|| (action.to_string(), id))
}

/// The scheme a page's own script uses to hand the app a link the web view would otherwise drop: a link
/// that asks for a new tab, or one to a local file. The app judges the link like any other.
pub const LINK_SCHEME: &str = "bakery-link";

/// The link a page handed over, as `bakery-link://<nonce>/?l=<the link, percent-encoded>`, when the nonce is
/// this run's. Anything else, or a link over 4096 characters, hands over nothing.
pub fn page_link(raw: &str, nonce: &str) -> Option<String> {
    if nonce.is_empty() {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    if url.scheme() != LINK_SCHEME
        || url.host_str() != Some(nonce)
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return None;
    }
    let mut pairs = url.query_pairs();
    let (key, value) = pairs.next()?;
    if key != "l" || pairs.next().is_some() || value.is_empty() || value.len() > 4096 {
        return None;
    }
    Some(value.into_owned())
}

/// The longest page address an `open` link may carry.
const MAX_PATH: usize = 2048;

/// Decide a navigation. `server` is the connected server's address as configured.
pub fn navigation(server: &str, target: &str) -> Navigation {
    let refuse = |scheme: &str, reason| Navigation::Refuse {
        scheme: scheme.to_string(),
        reason,
    };
    let Ok(url) = Url::parse(target) else {
        return refuse("", "not a url");
    };
    if matches!(url.scheme(), "https" | "http")
        && (!url.username().is_empty() || url.password().is_some())
    {
        return refuse(url.scheme(), "carries a login");
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
        "mailto" | "tel" => Navigation::System,
        scheme => refuse(scheme, "not a web address"),
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

/// What a `bakery://open` link asks for.
#[derive(Debug, PartialEq, Eq)]
pub struct OpenLink {
    /// The page: a path with its query, on the connected server.
    pub path: String,
    /// The server the link says it is for, as a plain origin, when it names one.
    pub server: Option<String>,
}

/// The page an `open` link names, as a path with its query, or the reason it is refused. The form is
/// `bakery://open?path=%2Fsome%2Fpage`, with an optional `server=https%3A%2F%2Fbakery.example.com`.
/// Only a path on a server is accepted: it starts with one slash, names no other host, climbs no
/// directory, carries no control character and is a page of the web app, never an API or a sign-in.
pub fn open_link(raw: &str) -> Result<OpenLink, &'static str> {
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
    let mut servers = url.query_pairs().filter(|(k, _)| k == "server");
    let server = match (servers.next(), servers.next()) {
        (None, _) => None,
        // What slice 4's chooser would accept: no login in it, and plain http only for this computer.
        (Some((_, address)), None) => Some(
            parse_server_address(&address)
                .ok()
                .and_then(|accepted| server_origins(&accepted))
                .map(|(origin, _)| origin)
                .ok_or("server is not an address the app accepts")?,
        ),
        _ => return Err("needs at most one server"),
    };
    Ok(OpenLink {
        path: page_path(&path)?.to_string(),
        server,
    })
}

/// The page an `open` link names: `open_link` without the server.
pub fn open_target(raw: &str) -> Result<String, &'static str> {
    open_link(raw).map(|link| link.path)
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
    if SERVER_OWNED
        .iter()
        .chain(SIGN_IN_OUT.iter())
        .any(|p| owns(before_query, p))
    {
        return Err("not a page of the web app");
    }
    // The path as a server or the web view would read it: every spelling of a dot is a dot, however its
    // percent-escapes are cased or nested, so a list of spellings is never enough.
    let Some(read) = read_as_a_server(before_query) else {
        return Err("path holds a forbidden character");
    };
    if read.chars().any(|c| c.is_control() || c == '\\') {
        return Err("path holds a forbidden character");
    }
    if read
        .split('/')
        .any(|segment| segment == "." || segment == "..")
    {
        return Err("path climbs a directory");
    }
    if SERVER_OWNED
        .iter()
        .chain(SIGN_IN_OUT.iter())
        .any(|p| owns(&read, p))
    {
        return Err("not a page of the web app");
    }
    Ok(path)
}

/// The path with its percent-escapes undone (again and again, since an escaped escape is still an escape
/// to some readers) and in lower case. `None` when it is still changing after four rounds.
fn read_as_a_server(path: &str) -> Option<String> {
    let mut current = path.to_string();
    for _ in 0..4 {
        let decoded = percent_decode_once(&current);
        if decoded == current {
            return Some(current.to_ascii_lowercase());
        }
        current = decoded;
    }
    None
}

fn percent_decode_once(text: &str) -> String {
    let bytes = text.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && bytes.len() >= i + 3 {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
        assert_eq!(
            navigation(SERVER, "tauri://localhost/index.html"),
            Navigation::Stay
        );
        assert_eq!(
            navigation(SERVER, "http://tauri.localhost/"),
            Navigation::Stay
        );
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
            Navigation::Refuse {
                scheme: "https".into(),
                reason: "carries a login"
            }
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
            assert!(
                matches!(navigation(SERVER, odd), Navigation::Refuse { .. }),
                "{odd}"
            );
        }
    }

    #[test]
    fn mail_and_phone_links_go_to_the_system() {
        assert_eq!(
            navigation(SERVER, "mailto:ana@example.com"),
            Navigation::System
        );
        assert_eq!(navigation(SERVER, "tel:+15550100"), Navigation::System);
    }

    #[test]
    fn a_refusal_names_the_scheme_the_dialog_shows() {
        assert_eq!(
            navigation(SERVER, "javascript:alert(1)"),
            Navigation::Refuse {
                scheme: "javascript".into(),
                reason: "not a web address"
            }
        );
        assert_eq!(
            navigation(SERVER, "file:///etc/passwd"),
            Navigation::Refuse {
                scheme: "file".into(),
                reason: "not a web address"
            }
        );
        assert_eq!(
            navigation(SERVER, "nonsense"),
            Navigation::Refuse {
                scheme: String::new(),
                reason: "not a url"
            }
        );
    }

    #[test]
    fn an_open_link_never_reaches_an_api_a_health_check_or_a_sign_in() {
        for path in [
            "/v1/tasks",
            "/v1",
            "/api/x",
            "/auth/callback",
            "/health/ready",
            "/health",
            "/mcp",
            "/_bakery/preview/exchange",
            "/.well-known/x",
            "/desktop/handoff",
            "/oauth/authorize",
            "/sign-in",
            "/sign-out",
            "/sign-in/two-factor",
            "/V1/tasks",
            "/Sign-Out",
            "/v1?x=1",
            "/sign-out#x",
        ] {
            let raw = format!(
                "bakery://open?path={}",
                path.replace('/', "%2F")
                    .replace('?', "%3F")
                    .replace('#', "%23")
            );
            assert_eq!(
                open_target(&raw),
                Err("not a page of the web app"),
                "{path}"
            );
        }
    }

    #[test]
    fn pages_that_merely_start_like_a_reserved_path_open() {
        for path in [
            "/v10/x",
            "/healthy",
            "/authors",
            "/tasks/v1",
            "/settings/auth",
        ] {
            let raw = format!("bakery://open?path={}", path.replace('/', "%2F"));
            assert_eq!(open_target(&raw), Ok(path.to_string()), "{path}");
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
            (
                "bakery://open?path=%2F%2Fevil.test",
                "not a path on this server",
            ),
            (
                "bakery://open?path=https%3A%2F%2Fevil.test",
                "not a path on this server",
            ),
            (
                "bakery://open?path=%2Fa%2F..%2Fb",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2F%2e%2e%2Fb",
                "path climbs a directory",
            ),
            ("bakery://open?path=%5Cevil", "not a path on this server"),
            // Every spelling of a dot segment is refused, whatever the case or the nesting of its escapes
            // (a reviewer found %2E%2e, .%2E and %2E. getting through).
            (
                "bakery://open?path=%2Fx%2F%2E%2e%2Fsign-out",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2Fx%2F%2e%2E%2Fsign-out",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2Fx%2F.%2E%2Fsign-out",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2Fx%2F%2E.%2Fsign-out",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2Fx%2F%252E%252e%2Fsign-out",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2Fx%2F%25252e%25252e%2Fv1%2Ftasks",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2F.%2Fsign-out",
                "path climbs a directory",
            ),
            (
                "bakery://open?path=%2F%2e%2Fsign-out",
                "path climbs a directory",
            ),
            // An escaped letter is still the letter: the reserved pages are refused by their decoded name.
            (
                "bakery://open?path=%2F%2573ign-out",
                "not a page of the web app",
            ),
            (
                "bakery://open?path=%2F%2576%2531%2Ftasks",
                "not a page of the web app",
            ),
            ("bakery://open?path=%2Fv%2531", "not a page of the web app"),
            (
                "bakery://open?path=%2Fa%5Cb",
                "path holds a forbidden character",
            ),
            (
                "bakery://open?path=%2Fa%0Ab",
                "path holds a forbidden character",
            ),
            (
                "bakery://open?path=%2Fa&path=%2Fb",
                "needs exactly one path",
            ),
            ("bakery://open/extra?path=%2Fa", "not an open link"),
            ("bakery://auth/callback?path=%2Fa", "not an open link"),
            ("https://open?path=%2Fa", "not an open link"),
            ("nonsense", "not a url"),
        ] {
            assert_eq!(open_target(raw), Err(why), "{raw}");
        }
    }

    #[test]
    fn an_open_link_may_name_the_server_it_is_for() {
        let link =
            open_link("bakery://open?path=%2Ftasks%2F7&server=HTTPS%3A%2F%2FBakery.Example.com%2F")
                .unwrap();
        assert_eq!(link.path, "/tasks/7");
        assert_eq!(link.server.as_deref(), Some("https://bakery.example.com"));
        assert_eq!(open_link("bakery://open?path=%2F").unwrap().server, None);
    }

    #[test]
    fn a_server_the_chooser_would_refuse_refuses_the_link() {
        for bad in [
            "javascript%3Aalert(1)",
            "",
            "https%3A%2F%2Fana%3Asecret%40a.example",
            "http%3A%2F%2Fa.example",
            "ftp%3A%2F%2Fa.example",
        ] {
            let raw = format!("bakery://open?path=%2F&server={bad}");
            assert_eq!(
                open_link(&raw),
                Err("server is not an address the app accepts"),
                "{bad}"
            );
        }
        assert_eq!(
            open_link("bakery://open?path=%2F&server=https%3A%2F%2Fa.example&server=https%3A%2F%2Fb.example"),
            Err("needs at most one server")
        );
    }

    #[test]
    fn a_server_the_chooser_would_accept_is_compared_by_its_origin() {
        for (typed, origin) in [
            ("https%3A%2F%2Fa.example%2Fsome%2Fpage", "https://a.example"),
            ("A.Example", "https://a.example"),
            ("https%3A%2F%2Fa.example%3A443%2F", "https://a.example"),
            ("http%3A%2F%2F127.0.0.1%3A8000", "http://127.0.0.1:8000"),
        ] {
            let raw = format!("bakery://open?path=%2F&server={typed}");
            assert_eq!(
                open_link(&raw).unwrap().server.as_deref(),
                Some(origin),
                "{typed}"
            );
        }
    }

    #[test]
    fn a_notice_button_with_this_runs_nonce_asks_for_its_action() {
        assert_eq!(
            toast_action("bakery-action://a1b2/show/7", "a1b2"),
            Some(("show".into(), 7))
        );
        assert_eq!(
            toast_action("bakery-action://a1b2/retry/12", "a1b2"),
            Some(("retry".into(), 12))
        );
    }

    #[test]
    fn an_action_without_the_nonce_or_from_anywhere_else_asks_for_nothing() {
        for raw in [
            "bakery-action://wrong/show/7",
            "bakery-action:///show/7",
            "bakery-action://A1B2.evil.test/show/7",
            "bakery-action://a1b2@evil.test/show/7",
            "bakery-action://a1b2:80/show/7",
            "https://a1b2/show/7",
            "https://bakery.example.com/bakery-action/a1b2/show/7",
            "bakery-action://a1b2/open/7",
            "bakery-action://a1b2/show/x",
            "bakery-action://a1b2/show/7/extra",
            "bakery-action://a1b2/show/7?x=1",
            "bakery-action://a1b2/show/7#x",
            "bakery-action://a1b2/show",
            "javascript:alert(1)",
            "not a url",
        ] {
            assert_eq!(toast_action(raw, "a1b2"), None, "{raw}");
        }
        // A run with no nonce answers nothing at all.
        assert_eq!(toast_action("bakery-action:///show/7", ""), None);
    }

    #[test]
    fn a_page_hands_over_a_link_with_this_runs_nonce() {
        assert_eq!(
            page_link(
                "bakery-link://a1b2/?l=file%3A%2F%2F%2Fetc%2Fhostname",
                "a1b2"
            ),
            Some("file:///etc/hostname".to_string())
        );
        assert_eq!(
            page_link(
                "bakery-link://a1b2?l=https%3A%2F%2Fexample.org%2Fa%3Fb%3D1",
                "a1b2"
            ),
            Some("https://example.org/a?b=1".to_string())
        );
    }

    #[test]
    fn a_link_handed_over_without_the_nonce_or_in_another_shape_is_ignored() {
        for raw in [
            "bakery-link://wrong/?l=file%3A%2F%2F%2Fx",
            "bakery-link:///?l=x",
            "bakery-link://a1b2@evil.test/?l=x",
            "bakery-link://a1b2:80/?l=x",
            "bakery-link://a1b2/extra?l=x",
            "bakery-link://a1b2/?l=",
            "bakery-link://a1b2/?l=x&l=y",
            "bakery-link://a1b2/?m=x",
            "bakery-link://a1b2/?l=x#frag",
            "bakery-link://a1b2/",
            "https://a1b2/?l=x",
            "not a url",
        ] {
            assert_eq!(page_link(raw, "a1b2"), None, "{raw}");
        }
        assert_eq!(page_link("bakery-link:///?l=x", ""), None);
        let long = format!("bakery-link://a1b2/?l={}", "a".repeat(4097));
        assert_eq!(page_link(&long, "a1b2"), None);
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
