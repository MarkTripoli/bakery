//! The app's calls to the Bakery server: start a sign-in, trade the answer for a credential, and
//! ask whether a kept credential is still good. What the server says is read by the core.

use bakery_desktop_core::compat::{read_health, Kind};
use bakery_desktop_core::copy::Identity;
use bakery_desktop_core::pkce::Pkce;
use bakery_desktop_core::platform::{APP_LINK, CLIENT_ID};
use bakery_desktop_core::session::ServerAnswer;
use bakery_desktop_core::wire::{
    exchange_failure, issued_credential, started_request, ExchangeFailure, StartedRequest,
};
use serde_json::json;
use std::time::Duration;

pub struct Client {
    http: reqwest::Client,
    server: String,
}

pub enum Exchange {
    Issued(String),
    Refused(ExchangeFailure),
    Unreachable,
}

pub enum Standing {
    /// Still accepted, and who it is for, as far as the server says.
    Good(Identity),
    /// The server no longer accepts it.
    Ended,
    /// Could not tell: the server did not answer, or answered something else.
    Unknown,
}

impl Client {
    pub fn new(server: &str) -> Client {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .build()
            .expect("an HTTP client");
        Client {
            http,
            server: server.trim_end_matches('/').to_string(),
        }
    }

    /// Starts a sign-in, or `None` if the server could not be reached or refused.
    pub async fn start(&self, pkce: &Pkce, computer_name: &str) -> Option<StartedRequest> {
        let response = self
            .http
            .post(format!("{}/v1/desktop-sign-ins", self.server))
            .json(&json!({
                "clientId": CLIENT_ID,
                "codeChallenge": pkce.challenge,
                "codeChallengeMethod": "S256",
                "redirectUri": APP_LINK,
                "computerName": computer_name,
            }))
            .send()
            .await
            .ok()?;
        if response.status().as_u16() != 201 {
            return None;
        }
        started_request(&response.text().await.ok()?)
    }

    /// Trades the browser's answer for a credential, proving this app started the sign-in.
    pub async fn exchange(&self, id: &str, code: &str, verifier: &str) -> Exchange {
        let sent = self
            .http
            .post(format!(
                "{}/v1/desktop-sign-ins/{id}/credential",
                self.server
            ))
            .json(&json!({ "clientId": CLIENT_ID, "code": code, "codeVerifier": verifier }))
            .send()
            .await;
        let Ok(response) = sent else {
            return Exchange::Unreachable;
        };
        let status = response.status().as_u16();
        let Ok(body) = response.text().await else {
            return Exchange::Unreachable;
        };
        if status == 201 {
            return match issued_credential(&body) {
                Some(credential) => Exchange::Issued(credential),
                None => Exchange::Refused(ExchangeFailure::Unexpected),
            };
        }
        Exchange::Refused(exchange_failure(status, &body))
    }

    pub async fn standing(&self, credential: &str) -> Standing {
        let sent = self
            .http
            .get(format!("{}/v1/me", self.server))
            .bearer_auth(credential)
            .send()
            .await;
        let Ok(response) = sent else {
            return Standing::Unknown;
        };
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        match status {
            200 => Standing::Good(identity_of(&body)),
            401 => Standing::Ended,
            _ => Standing::Unknown,
        }
    }

    /// Ends the app's own sign-in on the server. "Already ended" counts as done: the server answers
    /// 401 to a sign-in it no longer knows, and the person wanted it gone. Anything else, including
    /// no answer within five seconds, means the server may still list it.
    pub async fn revoke_current(&self, credential: &str) -> bool {
        let sent = self
            .http
            .post(format!("{}/v1/me/sessions/revoke-current", self.server))
            .timeout(Duration::from_secs(5))
            .bearer_auth(credential)
            .json(&json!({}))
            .send()
            .await;
        matches!(sent.map(|r| r.status().as_u16()), Ok(200) | Ok(401))
    }
}

/// The most of a health answer that is read: a real one is a few hundred bytes.
const HEALTH_LIMIT: usize = 64 * 1024;

/// Asks an address whether it is a Bakery server, at most ten seconds. Any answer is read, whatever
/// its status: a degraded Bakery still says what it is.
pub async fn probe(address: &str) -> ServerAnswer {
    let Ok(http) = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
    else {
        return ServerAnswer::NoAnswer;
    };
    let Ok(mut response) = http
        .get(format!("{}/health", address.trim_end_matches('/')))
        .send()
        .await
    else {
        return ServerAnswer::NoAnswer;
    };
    let mut body = Vec::new();
    while let Ok(Some(chunk)) = response.chunk().await {
        body.extend_from_slice(&chunk);
        if body.len() > HEALTH_LIMIT {
            return ServerAnswer::Answered(Kind::NotBakery);
        }
    }
    ServerAnswer::Answered(read_health(&String::from_utf8_lossy(&body)))
}

/// Name and email from the server's own words about the signed-in person; either may be missing.
fn identity_of(body: &str) -> Identity {
    let value: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    let field = |name: &str| {
        value
            .get(name)
            .and_then(|v| v.as_str())
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
    };
    Identity {
        name: field("displayName"),
        email: field("email"),
    }
}
