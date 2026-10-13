//! Secure credential custody for Gmail OAuth credentials and verified grants.
//!
//! Production storage is the macOS Keychain via the `keyring` crate
//! (apple-native backend), holding one serialized [`TokenBundle`] under a
//! single account-independent profile key so a restart can authenticate
//! before account discovery. Unsupported platforms fail closed with
//! [`MailError::SecretsUnavailable`]; there is no plaintext fallback.

use serde::{Deserialize, Serialize};

use crate::error::MailError;

/// Redacted credential bundle. Serialized as JSON into the secret store;
/// contents are never logged, serialized to IPC, or included in errors.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenBundle {
    pub access_token: String,
    /// Preserved when Google omits it in a refresh response.
    pub refresh_token: Option<String>,
    /// Absolute access-token expiry, epoch milliseconds.
    pub expires_at_epoch_ms: i64,
    /// Stable account id, set after profile discovery.
    pub account_id: Option<String>,
    /// Account email, set after profile discovery.
    pub email: Option<String>,
    /// True only after Google explicitly returned `gmail.modify` for this
    /// bound account. Missing in legacy bundles and therefore denied.
    #[serde(default)]
    pub gmail_modify_granted: bool,
}

impl std::fmt::Debug for TokenBundle {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenBundle")
            .field("access_token", &"<redacted>")
            .field(
                "refresh_token",
                &self.refresh_token.as_ref().map(|_| "<redacted>"),
            )
            .field("expires_at_epoch_ms", &self.expires_at_epoch_ms)
            .field(
                "account_id",
                &self.account_id.as_ref().map(|_| "<redacted>"),
            )
            .field("email", &self.email.as_ref().map(|_| "<redacted>"))
            .field("gmail_modify_granted", &self.gmail_modify_granted)
            .finish()
    }
}

/// Secret store seam. Implementations must be injectable for tests; the
/// production implementation is [`KeychainSecrets`].
pub trait Secrets: Send + Sync {
    /// Loads the stored bundle, or `None` when no credentials exist.
    fn load(&self) -> Result<Option<TokenBundle>, MailError>;
    /// Replaces the stored bundle.
    fn store(&self, bundle: &TokenBundle) -> Result<(), MailError>;
    /// Deletes the stored bundle. Disconnect must remove credentials locally.
    fn clear(&self) -> Result<(), MailError>;
}

/// macOS Keychain credential store. Any Keychain failure fails closed:
/// the caller receives [`MailError::SecretsUnavailable`], never a fallback.
pub struct KeychainSecrets;

#[cfg(target_os = "macos")]
const SECRETS_SERVICE: &str = "mail-core-gmail";
#[cfg(target_os = "macos")]
const SECRETS_USER: &str = "single-profile";

impl KeychainSecrets {
    pub fn new() -> Self {
        Self
    }
}

impl Default for KeychainSecrets {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(target_os = "macos")]
impl Secrets for KeychainSecrets {
    fn load(&self) -> Result<Option<TokenBundle>, MailError> {
        let entry = keyring::Entry::new(SECRETS_SERVICE, SECRETS_USER)
            .map_err(|_| MailError::SecretsUnavailable)?;
        match entry.get_password() {
            Ok(json) => Some(
                serde_json::from_str::<TokenBundle>(&json)
                    .map_err(|_| MailError::SecretsUnavailable),
            )
            .transpose(),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(MailError::SecretsUnavailable),
        }
    }

    fn store(&self, bundle: &TokenBundle) -> Result<(), MailError> {
        let entry = keyring::Entry::new(SECRETS_SERVICE, SECRETS_USER)
            .map_err(|_| MailError::SecretsUnavailable)?;
        let json = serde_json::to_string(bundle).map_err(|_| MailError::SecretsUnavailable)?;
        entry
            .set_password(&json)
            .map_err(|_| MailError::SecretsUnavailable)
    }

    fn clear(&self) -> Result<(), MailError> {
        let entry = keyring::Entry::new(SECRETS_SERVICE, SECRETS_USER)
            .map_err(|_| MailError::SecretsUnavailable)?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(MailError::SecretsUnavailable),
        }
    }
}

#[cfg(not(target_os = "macos"))]
impl Secrets for KeychainSecrets {
    fn load(&self) -> Result<Option<TokenBundle>, MailError> {
        Err(MailError::SecretsUnavailable)
    }

    fn store(&self, _bundle: &TokenBundle) -> Result<(), MailError> {
        Err(MailError::SecretsUnavailable)
    }

    fn clear(&self) -> Result<(), MailError> {
        Err(MailError::SecretsUnavailable)
    }
}

/// In-memory secret store for synthetic tests only. It is deliberately
/// exported so `crates/mail-core/tests/` can inject it, but production code
/// must never select it as a fallback for [`KeychainSecrets`].
#[derive(Clone, Default)]
pub struct MemorySecrets {
    inner: std::sync::Arc<std::sync::Mutex<MemoryState>>,
}

#[derive(Default)]
struct MemoryState {
    bundle: Option<String>,
    /// Test control: when set, every operation fails closed.
    unavailable: bool,
}

impl MemorySecrets {
    pub fn new() -> Self {
        Self::default()
    }

    /// Test-only failure injection simulating a Keychain failure.
    pub fn set_unavailable(&self, unavailable: bool) {
        self.inner
            .lock()
            .expect("memory secrets poisoned")
            .unavailable = unavailable;
    }
}

impl Secrets for MemorySecrets {
    fn load(&self) -> Result<Option<TokenBundle>, MailError> {
        let state = self
            .inner
            .lock()
            .map_err(|_| MailError::SecretsUnavailable)?;
        if state.unavailable {
            return Err(MailError::SecretsUnavailable);
        }
        match &state.bundle {
            None => Ok(None),
            Some(json) => Some(
                serde_json::from_str::<TokenBundle>(json)
                    .map_err(|_| MailError::SecretsUnavailable),
            )
            .transpose(),
        }
    }

    fn store(&self, bundle: &TokenBundle) -> Result<(), MailError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| MailError::SecretsUnavailable)?;
        if state.unavailable {
            return Err(MailError::SecretsUnavailable);
        }
        let json = serde_json::to_string(bundle).map_err(|_| MailError::SecretsUnavailable)?;
        state.bundle = Some(json);
        Ok(())
    }

    fn clear(&self) -> Result<(), MailError> {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| MailError::SecretsUnavailable)?;
        if state.unavailable {
            return Err(MailError::SecretsUnavailable);
        }
        state.bundle = None;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bundle() -> TokenBundle {
        TokenBundle {
            access_token: "synthetic-access-token".to_string(),
            refresh_token: Some("synthetic-refresh-token".to_string()),
            expires_at_epoch_ms: 1,
            account_id: None,
            email: None,
            gmail_modify_granted: false,
        }
    }

    #[test]
    fn token_bundle_debug_redacts_credentials_and_account_identity() {
        let bundle = TokenBundle {
            access_token: "synthetic-access-secret".to_string(),
            refresh_token: Some("synthetic-refresh-secret".to_string()),
            expires_at_epoch_ms: 123,
            account_id: Some("synthetic-account-id".to_string()),
            email: Some("synthetic@example.test".to_string()),
            gmail_modify_granted: true,
        };
        let rendered = format!("{bundle:?}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        for secret in [
            "synthetic-access-secret",
            "synthetic-refresh-secret",
            "synthetic-account-id",
            "synthetic@example.test",
        ] {
            assert!(!rendered.contains(secret), "{rendered}");
        }
    }

    #[test]
    fn memory_secrets_round_trip_and_clear() {
        let secrets = MemorySecrets::new();
        assert_eq!(secrets.load().unwrap(), None);
        secrets.store(&bundle()).unwrap();
        assert_eq!(secrets.load().unwrap(), Some(bundle()));
        secrets.clear().unwrap();
        assert_eq!(secrets.load().unwrap(), None);
        // Clearing an empty store stays idempotent.
        secrets.clear().unwrap();
    }

    #[test]
    fn memory_secrets_fail_closed_when_unavailable() {
        let secrets = MemorySecrets::new();
        secrets.set_unavailable(true);
        assert_eq!(secrets.load(), Err(MailError::SecretsUnavailable));
        assert_eq!(secrets.store(&bundle()), Err(MailError::SecretsUnavailable));
        assert_eq!(secrets.clear(), Err(MailError::SecretsUnavailable));
        secrets.set_unavailable(false);
        assert_eq!(secrets.load().unwrap(), None);
    }

    /// KeychainSecrets exists on every platform but fails closed everywhere
    /// except macOS; this machine is Linux, so the stub must reject.
    #[cfg(not(target_os = "macos"))]
    #[test]
    fn keychain_secrets_fail_closed_off_macos() {
        let secrets = KeychainSecrets::new();
        assert_eq!(secrets.load(), Err(MailError::SecretsUnavailable));
        assert_eq!(secrets.store(&bundle()), Err(MailError::SecretsUnavailable));
        assert_eq!(secrets.clear(), Err(MailError::SecretsUnavailable));
    }
}
