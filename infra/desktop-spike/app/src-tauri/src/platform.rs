//! The decisions in the sign-in that differ by platform or that decide what to accept, kept free of
//! the Tauri runtime so they run in unit tests on any host. This is how the macOS and Windows code
//! paths are covered without a macOS or Windows machine: the logic is proven here, the OS itself
//! (registering the scheme, delivering the link) is not.

pub const APP_LINK: &str = "bakery://auth/callback";
pub const CLIENT_ID: &str = "bakery-desktop";

/// Where the web view's pages are served from. The server answers cross-origin calls only from these.
pub const ORIGIN_UNIX: &str = "tauri://localhost";
pub const ORIGIN_WINDOWS: &str = "http://tauri.localhost";

/// Linux and Windows register the `bakery://` scheme when the app runs; macOS declares it in the app
/// bundle's Info.plist at build time and cannot register it at run time.
pub fn registers_scheme_at_runtime(os: &str) -> bool {
    matches!(os, "linux" | "windows")
}

/// The origin the web view reports for its own pages on each OS.
pub fn web_view_origin(os: &str) -> &'static str {
    if os == "windows" { ORIGIN_WINDOWS } else { ORIGIN_UNIX }
}

/// The redirect for the loopback mode: this machine only, on the port the app is listening on.
pub fn loopback_redirect(port: u16) -> String {
    format!("http://127.0.0.1:{port}/callback")
}

/// What a returning address is, and why it is refused. Only the app link and a loopback address with
/// path `/callback` are accepted, and a code is required; anything else never reaches the exchange.
pub fn accept_callback(raw: &str) -> Result<String, &'static str> {
    let Ok(url) = url::Url::parse(raw) else {
        return Err("not a url");
    };
    let app_link =
        url.scheme() == "bakery" && url.host_str() == Some("auth") && url.path() == "/callback";
    let loopback = url.scheme() == "http"
        && matches!(url.host_str(), Some("127.0.0.1") | Some("[::1]"))
        && url.path() == "/callback";
    if !(app_link || loopback) {
        return Err("not a callback address");
    }
    match url.query_pairs().find(|(k, _)| k == "code") {
        Some((_, v)) if !v.is_empty() => Ok(v.to_string()),
        _ => Err("no code"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_the_app_link_and_loopback_with_a_code() {
        assert_eq!(accept_callback("bakery://auth/callback?code=abc"), Ok("abc".into()));
        assert_eq!(accept_callback("http://127.0.0.1:43921/callback?code=abc&state=x"), Ok("abc".into()));
        assert_eq!(accept_callback("http://[::1]:43921/callback?code=abc"), Ok("abc".into()));
    }

    #[test]
    fn refuses_every_other_address() {
        for raw in [
            "https://auth/callback?code=abc",
            "bakery://evil/callback?code=abc",
            "bakery://auth/other?code=abc",
            "bakery://auth/callback/extra?code=abc",
            "http://evil.example/callback?code=abc",
            "http://127.0.0.1.evil.example/callback?code=abc",
            "http://127.0.0.1@evil.example/callback?code=abc",
            "http://localhost/callback?code=abc",
            "https://127.0.0.1/callback?code=abc",
            "http://127.0.0.1/other?code=abc",
            "javascript:alert(1)",
            "file:///etc/passwd",
        ] {
            assert_eq!(accept_callback(raw), Err("not a callback address"), "{raw}");
        }
    }

    #[test]
    fn refuses_what_is_not_an_address_and_what_has_no_code() {
        assert_eq!(accept_callback("not a url"), Err("not a url"));
        assert_eq!(accept_callback(""), Err("not a url"));
        assert_eq!(accept_callback("bakery://auth/callback"), Err("no code"));
        assert_eq!(accept_callback("bakery://auth/callback?code="), Err("no code"));
        assert_eq!(accept_callback("bakery://auth/callback?state=x"), Err("no code"));
    }

    #[test]
    fn the_scheme_is_registered_at_run_time_only_where_the_os_allows_it() {
        assert!(registers_scheme_at_runtime("linux"));
        assert!(registers_scheme_at_runtime("windows"));
        assert!(!registers_scheme_at_runtime("macos"));
        assert!(!registers_scheme_at_runtime("freebsd"));
    }

    #[test]
    fn the_registration_rule_matches_the_build_on_this_host() {
        let compiled = cfg!(any(target_os = "linux", target_os = "windows"));
        assert_eq!(registers_scheme_at_runtime(std::env::consts::OS), compiled);
    }

    #[test]
    fn the_web_view_origin_is_per_os() {
        assert_eq!(web_view_origin("windows"), "http://tauri.localhost");
        assert_eq!(web_view_origin("macos"), "tauri://localhost");
        assert_eq!(web_view_origin("linux"), "tauri://localhost");
    }

    #[test]
    fn the_loopback_redirect_is_this_machine_only() {
        let redirect = loopback_redirect(43921);
        assert_eq!(redirect, "http://127.0.0.1:43921/callback");
        assert_eq!(accept_callback(&format!("{redirect}?code=c")), Ok("c".into()));
    }

    #[test]
    fn the_app_link_is_itself_acceptable() {
        assert_eq!(accept_callback(&format!("{APP_LINK}?code=c")), Ok("c".into()));
    }
}
