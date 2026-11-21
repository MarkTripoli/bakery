//! Where the sign-in is kept: the computer's own secret store, never a file.

use bakery_desktop_core::csp::store_key;

/// Keeps one sign-in per server. A trait so the shell's logic can be tried without a real keyring.
pub trait SecretStore: Send + Sync {
    /// `Ok(None)` when nothing is kept; `Err` when the store itself cannot be used.
    fn load(&self, server: &str) -> Result<Option<String>, String>;
    fn save(&self, server: &str, secret: &str) -> Result<(), String>;
    fn clear(&self, server: &str) -> Result<(), String>;
    /// Whether a secret can be written and removed right now, tried on a name of its own that
    /// holds no sign-in. Asked before a sign-in is traded for a credential, so a server is never
    /// made to issue one that cannot be kept.
    fn probe(&self, server: &str) -> Result<(), String>;
}

const SERVICE: &str = "bakery-desktop";

/// The operating system's secret store: Secret Service on Linux, the Keychain on macOS and the
/// Credential Manager on Windows.
pub struct Keyring;

/// One sign-in per server, whatever way its address was written: the key is the normalized origin.
fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &store_key(server)).map_err(|e| e.to_string())
}

fn probe_entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, &format!("{}#probe", store_key(server))).map_err(|e| e.to_string())
}

impl SecretStore for Keyring {
    fn load(&self, server: &str) -> Result<Option<String>, String> {
        match entry(server)?.get_password() {
            Ok(secret) => Ok(Some(secret)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn save(&self, server: &str, secret: &str) -> Result<(), String> {
        entry(server)?
            .set_password(secret)
            .map_err(|e| e.to_string())
    }

    fn clear(&self, server: &str) -> Result<(), String> {
        match entry(server)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn probe(&self, server: &str) -> Result<(), String> {
        let probe = probe_entry(server)?;
        probe.set_password("probe").map_err(|e| e.to_string())?;
        match probe.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}
