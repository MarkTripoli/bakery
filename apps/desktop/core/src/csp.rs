//! The content security policy of the app's windows.
//!
//! Strict by construction: pages and scripts and styles come from the app itself, nothing is inline,
//! nothing is evaluated, and the window may connect only to itself, to the app's own channel to the
//! shell, and to the one Bakery server the person configured, over HTTP and over WebSocket. The
//! server is known only at run time, so the shell builds the policy from it when it starts.

use url::Url;

/// What the window may connect to when there is no server to name yet.
const BASE_CONNECT: &str = "'self' ipc: http://ipc.localhost";

/// `http(s)://host[:port]` and its WebSocket twin for a server address, or `None` if it is not a
/// plain Bakery server address (a web address with no path, query, login or fragment).
pub fn server_origins(server: &str) -> Option<(String, String)> {
    let url = Url::parse(server).ok()?;
    let ws_scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return None,
    };
    let clean = url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && matches!(url.path(), "" | "/");
    let host = url.host_str().filter(|_| clean)?;
    // `host_str` already brackets an IPv6 address.
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Some((
        format!("{}://{host}{port}", url.scheme()),
        format!("{ws_scheme}://{host}{port}"),
    ))
}

/// The name a server's sign-in is kept under in the keyring: its normalized origin, so
/// `https://x`, `https://x/` and `HTTPS://X` are one server and one sign-in. An address that is not
/// a plain origin cannot be signed in to, but still gets a stable name (trailing slashes trimmed).
pub fn store_key(server: &str) -> String {
    server_origins(server)
        .map(|(origin, _)| origin)
        .unwrap_or_else(|| server.trim_end_matches('/').to_string())
}

fn policy_with(connect: &str) -> String {
    [
        "default-src 'self'".to_string(),
        "script-src 'self'".to_string(),
        "style-src 'self'".to_string(),
        "img-src 'self' data:".to_string(),
        "font-src 'self'".to_string(),
        format!("connect-src {connect}"),
        "object-src 'none'".to_string(),
        "base-uri 'none'".to_string(),
        "form-action 'none'".to_string(),
        "frame-ancestors 'none'".to_string(),
    ]
    .join("; ")
}

/// The policy with no server named: the one the app starts with.
pub fn baseline() -> String {
    policy_with(BASE_CONNECT)
}

/// The policy for a configured server, or `None` if the address is not one.
pub fn policy(server: &str) -> Option<String> {
    let (http, ws) = server_origins(server)?;
    Some(policy_with(&format!("{BASE_CONNECT} {http} {ws}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn directive<'a>(policy: &'a str, name: &str) -> &'a str {
        policy
            .split("; ")
            .find(|d| d.starts_with(&format!("{name} ")))
            .unwrap_or_else(|| panic!("no {name} in {policy}"))
    }

    #[test]
    fn one_server_is_one_keyring_name_however_its_address_is_written() {
        let one = store_key("https://bakery.example.com");
        assert_eq!(one, "https://bakery.example.com");
        for same in [
            "https://bakery.example.com/",
            "HTTPS://Bakery.Example.COM",
            "https://bakery.example.com:443",
            "https://bakery.example.com:443/",
        ] {
            assert_eq!(store_key(same), one, "{same}");
        }
        // A different port, scheme or host is a different server and a different sign-in.
        assert_ne!(store_key("https://bakery.example.com:8443"), one);
        assert_ne!(store_key("http://bakery.example.com"), one);
        assert_ne!(store_key("https://other.example.com"), one);
        assert_eq!(store_key("http://[::1]:8000/"), "http://[::1]:8000");
    }

    #[test]
    fn an_address_that_is_not_an_origin_still_gets_a_stable_name() {
        assert_eq!(store_key("not a url//"), store_key("not a url/"));
    }

    #[test]
    fn the_policy_names_the_server_over_http_and_websocket_and_nothing_else() {
        let p = policy("https://bakery.example.com").unwrap();
        assert_eq!(
            directive(&p, "connect-src"),
            "connect-src 'self' ipc: http://ipc.localhost https://bakery.example.com wss://bakery.example.com"
        );
        let local = policy("http://127.0.0.1:8000").unwrap();
        assert!(
            directive(&local, "connect-src").ends_with("http://127.0.0.1:8000 ws://127.0.0.1:8000")
        );
        let v6 = policy("http://[::1]:8000/").unwrap();
        assert!(directive(&v6, "connect-src").ends_with("http://[::1]:8000 ws://[::1]:8000"));
    }

    #[test]
    fn nothing_is_inline_nothing_is_evaluated_and_scripts_come_only_from_the_app() {
        for p in [baseline(), policy("https://bakery.example.com").unwrap()] {
            assert!(!p.contains("unsafe-inline"), "{p}");
            assert!(!p.contains("unsafe-eval"), "{p}");
            assert!(!p.contains('*'), "{p}");
            assert_eq!(directive(&p, "default-src"), "default-src 'self'");
            assert_eq!(directive(&p, "script-src"), "script-src 'self'");
            assert_eq!(directive(&p, "style-src"), "style-src 'self'");
            assert_eq!(directive(&p, "object-src"), "object-src 'none'");
            assert_eq!(directive(&p, "frame-ancestors"), "frame-ancestors 'none'");
        }
    }

    #[test]
    fn the_baseline_names_no_server() {
        assert_eq!(
            directive(&baseline(), "connect-src"),
            "connect-src 'self' ipc: http://ipc.localhost"
        );
    }

    #[test]
    fn only_a_plain_web_address_is_a_server() {
        for bad in [
            "bakery.example.com",
            "ftp://bakery.example.com",
            "file:///etc/passwd",
            "https://user:pw@bakery.example.com",
            "https://bakery.example.com/path",
            "https://bakery.example.com/?q=1",
            "https://bakery.example.com/#x",
            "javascript:alert(1)",
            "",
        ] {
            assert_eq!(policy(bad), None, "{bad:?}");
        }
    }

    #[test]
    fn a_server_cannot_smuggle_extra_sources_into_the_policy() {
        for sneaky in [
            "https://a.example.com https://evil.example",
            "https://a.example.com;script-src *",
        ] {
            let p = policy(sneaky);
            if let Some(p) = p {
                assert!(!p.contains("evil.example"), "{p}");
                assert!(!p.contains("script-src *"), "{p}");
            }
        }
    }
}
