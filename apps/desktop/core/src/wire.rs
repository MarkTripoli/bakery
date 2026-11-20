//! What the server answers to the app's sign-in calls, read into the few outcomes the app acts on.
//! Pure: it reads text it is given and talks to nothing.

use serde::Deserialize;

/// Why the server refused to finish a sign-in, in the app's terms. The server names five reasons;
/// the app has a window for four and keeps waiting on the fifth.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExchangeFailure {
    /// The request outlived its time limit.
    Expired,
    /// The person cancelled in the browser.
    Cancelled,
    /// The answer was already spent.
    Used,
    /// The answer did not belong to this attempt.
    Mismatch,
    /// The person has not confirmed yet: never shown, the app keeps waiting.
    Pending,
    /// Anything else: the server answered, but not with a reason the app can show on its own.
    Unexpected,
}

#[derive(Deserialize)]
struct Problem {
    code: Option<String>,
    reason: Option<String>,
}

/// Reads a refused exchange: a 409 `STATE_CONFLICT` carrying one of the five reasons.
pub fn exchange_failure(status: u16, body: &str) -> ExchangeFailure {
    if status != 409 {
        return ExchangeFailure::Unexpected;
    }
    let Ok(problem) = serde_json::from_str::<Problem>(body) else {
        return ExchangeFailure::Unexpected;
    };
    if problem.code.as_deref() != Some("STATE_CONFLICT") {
        return ExchangeFailure::Unexpected;
    }
    match problem.reason.as_deref() {
        Some("desktop_sign_in_expired") => ExchangeFailure::Expired,
        Some("desktop_sign_in_cancelled") => ExchangeFailure::Cancelled,
        Some("desktop_sign_in_used") => ExchangeFailure::Used,
        Some("desktop_sign_in_mismatch") => ExchangeFailure::Mismatch,
        Some("desktop_sign_in_pending") => ExchangeFailure::Pending,
        _ => ExchangeFailure::Unexpected,
    }
}

/// The answer to starting a sign-in: where to send the person, and which attempt this is.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartedRequest {
    pub id: String,
    pub confirm_url: String,
    /// When the request stops being valid (an RFC 3339 time), as the server gives it.
    pub expires_at: Option<String>,
}

pub fn started_request(body: &str) -> Option<StartedRequest> {
    let started: StartedRequest = serde_json::from_str(body).ok()?;
    // Only a real web address is ever opened in the browser.
    let url = url::Url::parse(&started.confirm_url).ok()?;
    matches!(url.scheme(), "http" | "https").then_some(started)
}

#[derive(Deserialize)]
struct Issued {
    credential: String,
}

/// The credential a completed exchange issues, if it looks like one.
pub fn issued_credential(body: &str) -> Option<String> {
    let issued: Issued = serde_json::from_str(body).ok()?;
    issued
        .credential
        .starts_with("bkd_")
        .then_some(issued.credential)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn refusal(reason: &str) -> String {
        format!(r#"{{"code":"STATE_CONFLICT","reason":"{reason}","status":409}}"#)
    }

    #[test]
    fn each_server_reason_maps_to_the_app_outcome() {
        for (reason, expected) in [
            ("desktop_sign_in_expired", ExchangeFailure::Expired),
            ("desktop_sign_in_cancelled", ExchangeFailure::Cancelled),
            ("desktop_sign_in_used", ExchangeFailure::Used),
            ("desktop_sign_in_mismatch", ExchangeFailure::Mismatch),
            ("desktop_sign_in_pending", ExchangeFailure::Pending),
        ] {
            assert_eq!(
                exchange_failure(409, &refusal(reason)),
                expected,
                "{reason}"
            );
        }
    }

    #[test]
    fn anything_else_is_unexpected_and_never_guessed_at() {
        assert_eq!(
            exchange_failure(409, &refusal("something_new")),
            ExchangeFailure::Unexpected
        );
        assert_eq!(
            exchange_failure(
                409,
                r#"{"code":"OTHER","reason":"desktop_sign_in_expired"}"#
            ),
            ExchangeFailure::Unexpected
        );
        assert_eq!(
            exchange_failure(409, r#"{"code":"STATE_CONFLICT"}"#),
            ExchangeFailure::Unexpected
        );
        assert_eq!(
            exchange_failure(429, &refusal("desktop_sign_in_expired")),
            ExchangeFailure::Unexpected
        );
        assert_eq!(
            exchange_failure(500, "not json"),
            ExchangeFailure::Unexpected
        );
        assert_eq!(exchange_failure(409, ""), ExchangeFailure::Unexpected);
    }

    #[test]
    fn a_started_request_gives_an_attempt_and_a_web_address_to_open() {
        let body = r#"{"id":"b0f","confirmUrl":"http://127.0.0.1:8000/api/desktop/sign-in?request=b0f","expiresAt":"2026-11-20T10:10:00Z"}"#;
        let started = started_request(body).expect("a started request");
        assert_eq!(started.id, "b0f");
        assert_eq!(started.expires_at.as_deref(), Some("2026-11-20T10:10:00Z"));
        assert!(started.confirm_url.starts_with("http://127.0.0.1:8000/"));
    }

    #[test]
    fn only_a_web_address_is_ever_opened() {
        for bad in [
            "file:///etc/passwd",
            "javascript:alert(1)",
            "bakery://auth/callback",
            "not a url",
        ] {
            let body = format!(r#"{{"id":"x","confirmUrl":"{bad}"}}"#);
            assert_eq!(started_request(&body), None, "{bad}");
        }
        assert_eq!(started_request("{}"), None);
    }

    #[test]
    fn an_issued_credential_must_look_like_one() {
        assert_eq!(
            issued_credential(r#"{"credential":"bkd_abc","expiresAt":"x"}"#),
            Some("bkd_abc".into())
        );
        assert_eq!(issued_credential(r#"{"credential":"bky_abc"}"#), None);
        assert_eq!(issued_credential(r#"{"credential":""}"#), None);
        assert_eq!(issued_credential("{}"), None);
    }
}
