//! Public-API contract tests for the Slice 02 auth/credential seam
//! (docs/vertical-slice-02.md): environment configuration, secret storage
//! behavior, and provider construction validation. No network beyond
//! nothing at all — no OAuth, no accounts, no real credentials.

use std::sync::{Arc, Mutex, OnceLock};

use mail_core::error::MailError;
use mail_core::gmail::auth::GoogleConfig;
use mail_core::gmail::provider::GmailProvider;
// `KeychainSecrets` is only referenced by the fail-closed test compiled off
// macOS; on macOS the import would be unused and fail `clippy -D warnings`.
#[cfg(not(target_os = "macos"))]
use mail_core::gmail::secrets::KeychainSecrets;
use mail_core::gmail::secrets::{MemorySecrets, Secrets, TokenBundle};
use mail_core::gmail::types::GmailReadProvider;
use mail_core::provider::CancelToken;

/// `GoogleConfig::from_env` reads the launch environment; mutating process
/// env from parallel tests races, so all env-touching tests serialize here.
fn env_lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
}

#[test]
fn google_config_reads_client_id_and_optional_secret() {
    let _env = env_lock();
    std::env::remove_var("EMAIL_OS_GOOGLE_CLIENT_ID");
    std::env::remove_var("EMAIL_OS_GOOGLE_CLIENT_SECRET");
    assert!(matches!(
        GoogleConfig::from_env(),
        Err(MailError::NotConfigured)
    ));

    std::env::set_var("EMAIL_OS_GOOGLE_CLIENT_ID", "");
    assert!(matches!(
        GoogleConfig::from_env(),
        Err(MailError::NotConfigured)
    ));

    std::env::set_var(
        "EMAIL_OS_GOOGLE_CLIENT_ID",
        "synthetic-client-id.apps.googleusercontent.com",
    );
    std::env::set_var("EMAIL_OS_GOOGLE_CLIENT_SECRET", "synthetic-secret");
    let config = GoogleConfig::from_env().unwrap();
    assert_eq!(
        config.client_id,
        "synthetic-client-id.apps.googleusercontent.com"
    );
    assert_eq!(config.client_secret.as_deref(), Some("synthetic-secret"));

    std::env::remove_var("EMAIL_OS_GOOGLE_CLIENT_SECRET");
    let config = GoogleConfig::from_env().unwrap();
    assert_eq!(
        config.client_id,
        "synthetic-client-id.apps.googleusercontent.com"
    );
    assert_eq!(config.client_secret, None);

    std::env::remove_var("EMAIL_OS_GOOGLE_CLIENT_ID");
}

fn synthetic_bundle() -> TokenBundle {
    TokenBundle {
        access_token: "synthetic-access-token".to_string(),
        refresh_token: Some("synthetic-refresh-token".to_string()),
        expires_at_epoch_ms: i64::MAX,
        account_id: Some("synthetic@example.test".to_string()),
        email: Some("synthetic@example.test".to_string()),
    }
}

#[test]
fn memory_secrets_round_trip_store_load_clear() {
    let secrets = MemorySecrets::new();
    assert_eq!(secrets.load().unwrap(), None);
    secrets.store(&synthetic_bundle()).unwrap();
    assert_eq!(secrets.load().unwrap(), Some(synthetic_bundle()));
    secrets.clear().unwrap();
    assert_eq!(secrets.load().unwrap(), None);
}

/// `KeychainSecrets` exists on every platform but must fail closed with a
/// typed error everywhere except macOS — no plaintext fallback.
#[cfg(not(target_os = "macos"))]
#[test]
fn keychain_secrets_fail_closed_off_macos() {
    let secrets = KeychainSecrets::new();
    assert_eq!(secrets.load(), Err(MailError::SecretsUnavailable));
    assert_eq!(
        secrets.store(&synthetic_bundle()),
        Err(MailError::SecretsUnavailable)
    );
    assert_eq!(secrets.clear(), Err(MailError::SecretsUnavailable));
}

fn test_config() -> GoogleConfig {
    GoogleConfig {
        client_id: "synthetic-client-id.apps.googleusercontent.com".to_string(),
        client_secret: None,
    }
}

#[test]
fn provider_requires_client_id_and_is_object_safe_over_the_trait() {
    let secrets = Arc::new(MemorySecrets::new());
    let blank = GmailProvider::new(
        GoogleConfig {
            client_id: "  ".to_string(),
            client_secret: None,
        },
        secrets,
    );
    assert!(matches!(blank, Err(MailError::NotConfigured)));

    let provider = GmailProvider::new(test_config(), Arc::new(MemorySecrets::new())).unwrap();
    assert!(provider.is_configured());

    // The frozen sync-lane seam accepts this provider as a trait object.
    let provider: Arc<dyn GmailReadProvider> = Arc::new(provider);
    assert!(provider.is_configured());
}

#[test]
fn provider_from_env_exposes_missing_configuration_state() {
    let _env = env_lock();
    std::env::remove_var("EMAIL_OS_GOOGLE_CLIENT_ID");
    std::env::remove_var("EMAIL_OS_GOOGLE_CLIENT_SECRET");

    let provider = GmailProvider::from_env(Arc::new(MemorySecrets::new())).unwrap();
    assert!(!provider.is_configured());
    assert!(matches!(provider.has_credentials(), Ok(false)));
    assert!(matches!(
        provider.connect(&CancelToken::default()),
        Err(MailError::NotConfigured)
    ));
}

#[test]
fn has_credentials_and_disconnect_reflect_the_secret_store() {
    let secrets = Arc::new(MemorySecrets::new());
    let provider: Arc<dyn GmailReadProvider> =
        Arc::new(GmailProvider::new(test_config(), secrets.clone()).unwrap());
    assert!(matches!(provider.has_credentials(), Ok(false)));
    secrets.store(&synthetic_bundle()).unwrap();
    assert!(matches!(provider.has_credentials(), Ok(true)));
    // Disconnect deletes credentials locally; repeated disconnects stay ok.
    provider.disconnect().unwrap();
    assert!(matches!(provider.has_credentials(), Ok(false)));
    provider.disconnect().unwrap();

    // Storage failures surface typed, not swallowed.
    secrets.set_unavailable(true);
    assert!(matches!(
        provider.has_credentials(),
        Err(MailError::SecretsUnavailable)
    ));
    assert!(matches!(
        provider.disconnect(),
        Err(MailError::SecretsUnavailable)
    ));
}

#[test]
fn auth_required_without_credentials_on_the_trait_surface() {
    let provider: Arc<dyn GmailReadProvider> =
        Arc::new(GmailProvider::new(test_config(), Arc::new(MemorySecrets::new())).unwrap());
    let cancel = CancelToken::default();
    assert!(matches!(
        provider.list_inbox(None, &cancel),
        Err(MailError::AuthRequired)
    ));
    assert!(matches!(
        provider.get_thread("t1", &cancel),
        Err(MailError::AuthRequired)
    ));
    assert!(matches!(
        provider.profile(&cancel),
        Err(MailError::AuthRequired)
    ));
}
