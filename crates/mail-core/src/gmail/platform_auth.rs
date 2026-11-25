//! Platform authorization and process-local access token custody.
use super::secrets::{Secrets, TokenBundle};
use crate::{cancel::CancelToken, error::MailError};
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

/// Authorization supplied by the platform.
pub trait PlatformAuthorizer: Send + Sync {
    /// Requests a platform grant.
    fn authorize(
        &self,
        request: &PlatformAuthRequest,
        cancel: &CancelToken,
    ) -> Result<PlatformGrant, PlatformAuthError>;
    /// Clears a cached platform token.
    fn clear_token(&self, token: &str) -> Result<(), PlatformAuthError>;
}
/// Requested scopes and optional account binding.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformAuthRequest {
    /// Scopes to request.
    pub scopes: Vec<String>,
    /// Previously bound account.
    pub account: Option<String>,
    /// Whether user interaction is permitted.
    pub interactive: bool,
}
impl std::fmt::Debug for PlatformAuthRequest {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlatformAuthRequest")
            .field("scopes", &self.scopes)
            .field("account", &self.account.as_ref().map(|_| "<redacted>"))
            .field("interactive", &self.interactive)
            .finish()
    }
}
/// A platform-issued access grant.
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformGrant {
    /// Short-lived access token.
    pub access_token: String,
    /// Scopes actually granted.
    pub granted_scopes: Vec<String>,
    /// Account address, if provided.
    pub email: Option<String>,
    /// Expiration time, if provided.
    pub expires_at_epoch_ms: Option<i64>,
}
impl std::fmt::Debug for PlatformGrant {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("PlatformGrant")
            .field("access_token", &"<redacted>")
            .field("granted_scopes", &self.granted_scopes)
            .field("email", &self.email.as_ref().map(|_| "<redacted>"))
            .field("expires_at_epoch_ms", &self.expires_at_epoch_ms)
            .finish()
    }
}
/// Platform authorization failure categories.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PlatformAuthError {
    /// User or caller cancelled.
    Cancelled,
    /// Consent or account selection is needed.
    NeedsUserInteraction,
    /// Application configuration is invalid.
    DeveloperError,
    /// Play services is unavailable.
    PlayServicesUnavailable,
    /// The operation is unsupported.
    Unsupported,
    /// Network access failed.
    Network,
    /// Authorization failed.
    Failed,
}
impl From<PlatformAuthError> for MailError {
    fn from(value: PlatformAuthError) -> Self {
        match value {
            PlatformAuthError::Cancelled => Self::AuthCancelled,
            PlatformAuthError::NeedsUserInteraction => Self::AuthRequired,
            PlatformAuthError::DeveloperError => Self::NotConfigured,
            PlatformAuthError::PlayServicesUnavailable => Self::UnsupportedPlatform,
            PlatformAuthError::Network => Self::NetworkUnavailable,
            PlatformAuthError::Unsupported | PlatformAuthError::Failed => Self::AuthFailed,
        }
    }
}
/// Android token store: the persistent inner store is Keystore-backed (stage 3),
/// and the access token lives only in process memory.
pub struct TokenlessSecrets {
    inner: Arc<dyn Secrets>,
    memory: Mutex<Option<TokenBundle>>,
}
impl TokenlessSecrets {
    /// Wraps a persistent binding store.
    pub fn new(inner: Arc<dyn Secrets>) -> Self {
        Self {
            inner,
            memory: Mutex::new(None),
        }
    }
}
impl Secrets for TokenlessSecrets {
    fn load(&self) -> Result<Option<TokenBundle>, MailError> {
        let memory = self
            .memory
            .lock()
            .map_err(|_| MailError::SecretsUnavailable)?;
        if memory.is_some() {
            return Ok(memory.clone());
        }
        self.inner.load()
    }
    fn store(&self, bundle: &TokenBundle) -> Result<(), MailError> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| MailError::SecretsUnavailable)?;
        let mut persisted = bundle.clone();
        persisted.access_token.clear();
        persisted.refresh_token = None;
        persisted.expires_at_epoch_ms = 0;
        self.inner.store(&persisted)?;
        *memory = Some(bundle.clone());
        Ok(())
    }
    fn clear(&self) -> Result<(), MailError> {
        let mut memory = self
            .memory
            .lock()
            .map_err(|_| MailError::SecretsUnavailable)?;
        let result = self.inner.clear();
        *memory = None;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::gmail::secrets::MemorySecrets;

    fn bundle() -> TokenBundle {
        TokenBundle {
            access_token: "secret-token".into(),
            refresh_token: None,
            expires_at_epoch_ms: 42,
            account_id: Some("account".into()),
            email: Some("a@b.test".into()),
            gmail_modify_granted: false,
            granted_scopes: vec!["scope".into()],
            platform_authorized: true,
        }
    }
    #[test]
    fn mappings_and_wire_format_are_stable_and_redacted() {
        for (error, expected) in [
            (PlatformAuthError::Cancelled, MailError::AuthCancelled),
            (
                PlatformAuthError::NeedsUserInteraction,
                MailError::AuthRequired,
            ),
            (PlatformAuthError::DeveloperError, MailError::NotConfigured),
            (
                PlatformAuthError::PlayServicesUnavailable,
                MailError::UnsupportedPlatform,
            ),
            (PlatformAuthError::Unsupported, MailError::AuthFailed),
            (PlatformAuthError::Network, MailError::NetworkUnavailable),
            (PlatformAuthError::Failed, MailError::AuthFailed),
        ] {
            assert_eq!(MailError::from(error), expected);
        }
        assert_eq!(
            serde_json::from_str::<PlatformAuthError>("\"needsUserInteraction\"").unwrap(),
            PlatformAuthError::NeedsUserInteraction
        );
        let grant: PlatformGrant = serde_json::from_str(r#"{"accessToken":"secret-token","grantedScopes":["scope"],"email":"a@b.test","expiresAtEpochMs":1}"#).unwrap();
        assert_eq!(grant.expires_at_epoch_ms, Some(1));
        let request = PlatformAuthRequest {
            scopes: vec!["scope".into()],
            account: Some("a@b.test".into()),
            interactive: true,
        };
        assert_eq!(
            serde_json::to_value(&request).unwrap(),
            serde_json::json!({"scopes":["scope"],"account":"a@b.test","interactive":true})
        );
        for value in [format!("{grant:?}"), format!("{request:?}")] {
            assert!(!value.contains("secret-token"));
            assert!(!value.contains("a@b.test"));
        }
    }
    #[test]
    fn tokenless_store_preserves_binding_and_handles_failure() {
        let inner = Arc::new(MemorySecrets::new());
        let store = TokenlessSecrets::new(inner.clone());
        let full = bundle();
        store.store(&full).unwrap();
        let persisted = inner.load().unwrap().unwrap();
        assert!(persisted.access_token.is_empty());
        assert_eq!(persisted.expires_at_epoch_ms, 0);
        assert_eq!(store.load().unwrap(), Some(full.clone()));
        assert_eq!(
            TokenlessSecrets::new(inner.clone()).load().unwrap(),
            Some(persisted.clone())
        );
        assert_eq!(persisted.email, full.email);
        assert_eq!(persisted.account_id, full.account_id);
        assert_eq!(persisted.granted_scopes, full.granted_scopes);
        assert!(persisted.has_token_source());
        store.clear().unwrap();
        assert_eq!(inner.load().unwrap(), None);
        assert_eq!(store.load().unwrap(), None);
        inner.set_unavailable(true);
        assert_eq!(store.store(&full), Err(MailError::SecretsUnavailable));
        assert_eq!(store.load(), Err(MailError::SecretsUnavailable));
        assert_eq!(store.clear(), Err(MailError::SecretsUnavailable));
        inner.set_unavailable(false);
        store.store(&full).unwrap();
        inner.set_unavailable(true);
        // A cached token remains usable until cleared, even if persistence fails.
        assert_eq!(store.load().unwrap(), Some(full));
        assert_eq!(store.clear(), Err(MailError::SecretsUnavailable));
        assert_eq!(store.load(), Err(MailError::SecretsUnavailable));
    }
    #[test]
    fn legacy_bundle_defaults_platform_authorized_to_false() {
        let mut json = serde_json::to_value(bundle()).unwrap();
        json.as_object_mut().unwrap().remove("platformAuthorized");
        assert!(
            !serde_json::from_value::<TokenBundle>(json)
                .unwrap()
                .platform_authorized
        );
    }
}
