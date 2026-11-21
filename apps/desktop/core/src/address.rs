//! What a person types as a server's address, and what the app makes of it (#77 slice 4).
//!
//! The rules are design-ux's: no scheme typed means https; anything after the server's name, such
//! as a pasted page link, is dropped; a name and password in the address are refused; plain http is
//! for this computer only. Pure: nothing here talks to a server.

use url::{Host, Url};

/// The server the app uses when nothing else is set.
pub const THIS_COMPUTER: &str = "http://127.0.0.1:8000";

/// Why an address cannot be used, each with its own sentence under the box.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressProblem {
    /// Nothing was typed.
    Empty,
    /// Not a web address.
    NotWebAddress,
    /// A name and password are in the address.
    HasCredentials,
    /// http for a server that is not this computer.
    PlainHttp,
}

/// A server's address as the app keeps and shows it: scheme, name and port, nothing after.
pub fn parse_server_address(input: &str) -> Result<String, AddressProblem> {
    let typed = input.trim();
    if typed.is_empty() {
        return Err(AddressProblem::Empty);
    }
    // No scheme typed means https. A bare "host:8000" must not be read as a scheme called "host".
    let with_scheme = if typed.contains("://") {
        typed.to_string()
    } else {
        format!("https://{typed}")
    };
    let url = Url::parse(&with_scheme).map_err(|_| AddressProblem::NotWebAddress)?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(AddressProblem::NotWebAddress);
    }
    let Some(host) = url.host() else {
        return Err(AddressProblem::NotWebAddress);
    };
    if !url.username().is_empty() || url.password().is_some() {
        return Err(AddressProblem::HasCredentials);
    }
    if url.scheme() == "http" && !is_this_computer(&host) {
        return Err(AddressProblem::PlainHttp);
    }
    let port = url.port().map(|p| format!(":{p}")).unwrap_or_default();
    Ok(format!("{}://{}{}", url.scheme(), host, port))
}

fn is_this_computer(host: &Host<&str>) -> bool {
    match host {
        Host::Domain(name) => name.eq_ignore_ascii_case("localhost"),
        Host::Ipv4(ip) => ip.is_loopback(),
        Host::Ipv6(ip) => ip.is_loopback(),
    }
}

/// Whether an address is the server the chooser offers as "This computer": plain http on this
/// computer's own address at the usual port. A server on this computer at another port is a server
/// of its own, offered under "Another address" and remembered there.
pub fn is_default_server(address: &str) -> bool {
    Url::parse(address).is_ok_and(|u| {
        u.scheme() == "http"
            && u.port_or_known_default() == Some(8000)
            && u.host().is_some_and(|h| is_this_computer(&h))
    })
}

/// Whether an address is on this computer at all, on any port: the words "not running on this
/// computer" fit every such address.
pub fn is_this_computer_address(address: &str) -> bool {
    Url::parse(address)
        .ok()
        .and_then(|u| u.host().map(|h| is_this_computer(&h)))
        .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(input: &str) -> String {
        parse_server_address(input).unwrap_or_else(|e| panic!("{input:?} refused: {e:?}"))
    }

    #[test]
    fn no_scheme_typed_means_https() {
        assert_eq!(ok("bakery.example.com"), "https://bakery.example.com");
        assert_eq!(
            ok("bakery.example.com:8443"),
            "https://bakery.example.com:8443"
        );
        assert_eq!(
            ok("  https://bakery.example.com  "),
            "https://bakery.example.com"
        );
    }

    #[test]
    fn anything_after_the_servers_name_is_dropped() {
        for pasted in [
            "https://bakery.example.com/",
            "https://bakery.example.com/issues/batches?repository=1#top",
            "bakery.example.com/tasks/42",
        ] {
            assert_eq!(ok(pasted), "https://bakery.example.com", "{pasted}");
        }
        assert_eq!(
            ok("https://bakery.example.com:8443/x"),
            "https://bakery.example.com:8443"
        );
    }

    #[test]
    fn the_name_is_lowercased_and_the_default_port_is_not_kept() {
        assert_eq!(
            ok("HTTPS://Bakery.Example.COM:443"),
            "https://bakery.example.com"
        );
    }

    #[test]
    fn plain_http_is_for_this_computer_only() {
        assert_eq!(ok("http://127.0.0.1:8000"), "http://127.0.0.1:8000");
        assert_eq!(ok("http://localhost:8000/"), "http://localhost:8000");
        assert_eq!(ok("http://[::1]:8000"), "http://[::1]:8000");
        for remote in [
            "http://bakery.example.com",
            "http://192.168.1.20:8000",
            "http://10.0.0.5",
        ] {
            assert_eq!(
                parse_server_address(remote),
                Err(AddressProblem::PlainHttp),
                "{remote}"
            );
        }
        // https is fine anywhere, including this computer.
        assert_eq!(ok("https://localhost:8443"), "https://localhost:8443");
    }

    #[test]
    fn a_name_and_password_are_refused_before_anything_else_is_judged() {
        assert_eq!(
            parse_server_address("https://ana:secret@bakery.example.com"),
            Err(AddressProblem::HasCredentials)
        );
        assert_eq!(
            parse_server_address("https://ana@bakery.example.com"),
            Err(AddressProblem::HasCredentials)
        );
    }

    #[test]
    fn what_is_not_a_web_address_is_told_apart_from_an_empty_box() {
        assert_eq!(parse_server_address(""), Err(AddressProblem::Empty));
        assert_eq!(parse_server_address("   \t"), Err(AddressProblem::Empty));
        for bad in [
            "ftp://bakery.example.com",
            "file:///etc/hosts",
            "https://",
            "https://exa mple.com",
            "javascript://x",
        ] {
            assert_eq!(
                parse_server_address(bad),
                Err(AddressProblem::NotWebAddress),
                "{bad}"
            );
        }
    }

    #[test]
    fn only_the_usual_local_server_is_the_one_the_chooser_calls_this_computer() {
        for yes in [
            "http://127.0.0.1:8000",
            "http://localhost:8000",
            "http://[::1]:8000",
        ] {
            assert!(is_default_server(yes), "{yes}");
        }
        // Local, but another server: it belongs under "Another address".
        for no in [
            "http://127.0.0.1:46289",
            "https://127.0.0.1:8000",
            "http://localhost:3000",
            "https://bakery.example.com",
            "http://192.168.1.2:8000",
            "nonsense",
        ] {
            assert!(!is_default_server(no), "{no}");
        }
        assert!(
            is_this_computer_address("http://127.0.0.1:46289"),
            "still on this computer"
        );
    }

    #[test]
    fn this_computer_is_recognised_in_every_spelling() {
        for yes in [
            "http://127.0.0.1:8000",
            "http://localhost:8000",
            "http://[::1]:8000",
            "https://localhost",
        ] {
            assert!(is_this_computer_address(yes), "{yes}");
        }
        for no in [
            "https://bakery.example.com",
            "http://192.168.1.2:8000",
            "not a url",
        ] {
            assert!(!is_this_computer_address(no), "{no}");
        }
    }
}
