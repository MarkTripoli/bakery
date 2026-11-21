//! Whether a server is a Bakery server, and whether it and this app understand each other (#77
//! slice 4). Pure: the shell asks the server for `/health` and hands the body here.

use serde::Deserialize;

/// The API level this app was built against; compared with the server's own `compatibility`.
pub const APP_COMPATIBILITY: u32 = 1;

/// What `/health` says about the server, as far as the app cares.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// It answered, but is not a Bakery server.
    NotBakery,
    /// A Bakery server that this app understands.
    Compatible,
    /// Its level is missing or below the app's: "this server is older than this app".
    ServerOlder,
    /// Its level is above the app's: "this app is older than this server".
    AppOlder,
}

#[derive(Deserialize)]
struct Health {
    service: Option<String>,
    compatibility: Option<u32>,
}

/// Reads a `/health` body. Anything that is not JSON naming `bakery-server` is not a Bakery server.
pub fn read_health(body: &str) -> Kind {
    let Ok(health) = serde_json::from_str::<Health>(body) else {
        return Kind::NotBakery;
    };
    if health.service.as_deref() != Some("bakery-server") {
        return Kind::NotBakery;
    }
    match health.compatibility {
        None => Kind::ServerOlder,
        Some(level) if level < APP_COMPATIBILITY => Kind::ServerOlder,
        Some(level) if level > APP_COMPATIBILITY => Kind::AppOlder,
        Some(_) => Kind::Compatible,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn health(extra: &str) -> String {
        format!(
            r#"{{"service":"bakery-server","state":"ok","version":"dev","dependencies":[]{extra}}}"#
        )
    }

    #[test]
    fn a_server_at_the_apps_level_is_compatible() {
        assert_eq!(
            read_health(&health(r#","compatibility":1"#)),
            Kind::Compatible
        );
    }

    #[test]
    fn a_missing_or_lower_level_is_an_older_server() {
        assert_eq!(read_health(&health("")), Kind::ServerOlder);
        assert_eq!(
            read_health(&health(r#","compatibility":0"#)),
            Kind::ServerOlder
        );
    }

    #[test]
    fn a_higher_level_is_an_older_app() {
        assert_eq!(
            read_health(&health(r#","compatibility":2"#)),
            Kind::AppOlder
        );
    }

    #[test]
    fn anything_that_is_not_a_bakery_health_answer_is_not_bakery() {
        for body in [
            "",
            "<html>It works!</html>",
            r#"{"service":"other-server","compatibility":1}"#,
            r#"{"state":"ok"}"#,
            "null",
            r#"{"service":"bakery-server","compatibility":"1"}"#,
        ] {
            assert_eq!(read_health(body), Kind::NotBakery, "{body}");
        }
        // A degraded Bakery server still answers as Bakery: the body decides, not the status.
        assert_eq!(
            read_health(r#"{"service":"bakery-server","state":"degraded","compatibility":1}"#),
            Kind::Compatible
        );
    }
}
