//! The app's calls to the Bakery server: start a sign-in, trade the answer for a credential, and
//! ask whether a kept credential is still good. What the server says is read by the core.

use bakery_desktop_core::pkce::Pkce;
use bakery_desktop_core::platform::{APP_LINK, CLIENT_ID};
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
    Good,
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
        match sent.map(|r| r.status().as_u16()) {
            Ok(200) => Standing::Good,
            Ok(401) => Standing::Ended,
            _ => Standing::Unknown,
        }
    }
}
