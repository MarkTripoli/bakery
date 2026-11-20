//! Where the sign-in is kept: the computer's own secret store, never a file.

/// Keeps one sign-in per server. A trait so the shell's logic can be tried without a real keyring.
pub trait SecretStore: Send + Sync {
    /// `Ok(None)` when nothing is kept; `Err` when the store itself cannot be used.
    fn load(&self, server: &str) -> Result<Option<String>, String>;
    fn save(&self, server: &str, secret: &str) -> Result<(), String>;
    fn clear(&self, server: &str) -> Result<(), String>;
}

const SERVICE: &str = "bakery-desktop";

/// The operating system's secret store: Secret Service on Linux, the Keychain on macOS and the
/// Credential Manager on Windows.
pub struct Keyring;

fn entry(server: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(SERVICE, server).map_err(|e| e.to_string())
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
}
