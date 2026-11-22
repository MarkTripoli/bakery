//! PKCE (RFC 7636), method S256: the proof that the app that started a sign-in is the one finishing it.

use base64::{engine::general_purpose::URL_SAFE_NO_PAD as B64, Engine};
use rand::RngCore;
use sha2::{Digest, Sha256};

/// The secret the app keeps (`verifier`) and the one-way value it sends first (`challenge`).
#[derive(Clone, PartialEq, Eq)]
pub struct Pkce {
    pub verifier: String,
    pub challenge: String,
}

// A verifier is a secret: it never prints, even by accident in a log line.
impl std::fmt::Debug for Pkce {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Pkce")
            .field("verifier", &"<secret>")
            .field("challenge", &self.challenge)
            .finish()
    }
}

/// The S256 challenge for a verifier: base64url, no padding, of its SHA-256.
pub fn challenge_for(verifier: &str) -> String {
    B64.encode(Sha256::digest(verifier.as_bytes()))
}

/// A fresh pair. 48 random bytes make a 64-character verifier, inside RFC 7636's 43 to 128.
pub fn generate() -> Pkce {
    let mut raw = [0u8; 48];
    rand::thread_rng().fill_bytes(&mut raw);
    let verifier = B64.encode(raw);
    let challenge = challenge_for(&verifier);
    Pkce {
        verifier,
        challenge,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_rfc_7636_appendix_b_vector() {
        assert_eq!(
            challenge_for("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn a_generated_pair_is_consistent_and_within_the_rfc_bounds() {
        let pair = generate();
        assert_eq!(pair.challenge, challenge_for(&pair.verifier));
        assert!(
            (43..=128).contains(&pair.verifier.len()),
            "{}",
            pair.verifier.len()
        );
        assert!(pair
            .verifier
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_'));
        // The server's own check for a challenge: exactly 43 base64url characters.
        assert_eq!(pair.challenge.len(), 43);
    }

    #[test]
    fn two_pairs_never_match() {
        let (a, b) = (generate(), generate());
        assert_ne!(a.verifier, b.verifier);
        assert_ne!(a.challenge, b.challenge);
    }

    #[test]
    fn the_verifier_never_prints() {
        let pair = generate();
        let shown = format!("{pair:?}");
        assert!(!shown.contains(&pair.verifier));
        assert!(shown.contains("<secret>"));
    }
}
