use super::*;
use crate::gmail::grants::{GmailGrant, GrantOutcome};
use crate::gmail::platform_auth::{PlatformAuthError, PlatformGrant, TokenlessSecrets};
use crate::gmail::secrets::MemorySecrets;
use crate::testing::platform_auth_fake::ScriptedAuthorizer;

fn grant(scopes: &[&str]) -> PlatformGrant {
    PlatformGrant {
        access_token: "token".into(),
        granted_scopes: scopes.iter().map(|s| s.to_string()).collect(),
        email: None,
        expires_at_epoch_ms: None,
    }
}
fn setup(
    secrets: Arc<dyn Secrets>,
    authorizer: Arc<ScriptedAuthorizer>,
    script: Vec<(&str, u16, &str)>,
) -> (LiveGmailProvider, FakeApi) {
    let (base, api) = FakeApi::start(script);
    let mut provider = LiveGmailProvider::with_platform_authorizer(authorizer, secrets).unwrap();
    provider.endpoints.api = base;
    provider.min_request_interval = Duration::ZERO;
    (provider, api)
}
const PROFILE: &str = r#"{"emailAddress":"synthetic@example.test","historyId":"1"}"#;
const PATH: &str = "/gmail/v1/users/me/profile";

#[test]
fn send_grant_uses_scope_union_or_skips_consent_when_covered() {
    let store = Arc::new(MemorySecrets::new());
    let authorizer = Arc::new(ScriptedAuthorizer::default());
    let (provider, api) = setup(
        store.clone(),
        authorizer.clone(),
        vec![(PATH, 200, PROFILE)],
    );
    let mut bundle = future_token();
    bundle.platform_authorized = true;
    bundle.refresh_token = None;
    bundle.granted_scopes = vec![
        auth::GMAIL_READONLY_SCOPE.into(),
        auth::GMAIL_MODIFY_SCOPE.into(),
    ];
    store.store(&bundle).unwrap();
    let cancel = CancelToken::default();

    assert!(matches!(
        provider.request_grant(GmailGrant::Send, &cancel),
        Ok(GrantOutcome::AlreadyCovered)
    ));
    assert!(authorizer.requests().is_empty());
    assert!(api.requests().is_empty());

    bundle.granted_scopes = vec![auth::GMAIL_READONLY_SCOPE.into()];
    store.store(&bundle).unwrap();
    authorizer.push_authorize(Ok(grant(&[auth::GMAIL_READONLY_SCOPE])));
    assert!(matches!(
        provider.request_grant(GmailGrant::Send, &cancel),
        Err(MailError::PermissionRequired)
    ));
    assert_eq!(store.load().unwrap(), Some(bundle));

    authorizer.push_authorize(Ok(grant(&[
        auth::GMAIL_READONLY_SCOPE,
        auth::GMAIL_SEND_SCOPE,
    ])));
    assert!(matches!(
        provider.request_grant(GmailGrant::Send, &cancel),
        Ok(GrantOutcome::Granted(_))
    ));
    let requests = authorizer.requests();
    assert_eq!(requests.len(), 2);
    for request in requests {
        assert!(request.interactive);
        assert_eq!(request.account.as_deref(), Some("synthetic@example.test"));
        assert_eq!(
            request.scopes,
            [auth::GMAIL_READONLY_SCOPE, auth::GMAIL_SEND_SCOPE]
        );
    }
    assert!(provider.grant_covered(GmailGrant::Send).unwrap());
    assert!(!provider.grant_covered(GmailGrant::Modify).unwrap());
    assert_eq!(api.requests(), [PATH]);
}

#[test]
fn expired_platform_send_is_unknown_without_silent_or_post_replay() {
    let store = Arc::new(MemorySecrets::new());
    let authorizer = Arc::new(ScriptedAuthorizer::default());
    let path = "/gmail/v1/users/me/messages/send";
    let (provider, api) = setup(store.clone(), authorizer.clone(), vec![(path, 401, "{}")]);
    let mut bundle = future_token();
    bundle.platform_authorized = true;
    bundle.refresh_token = None;
    bundle.granted_scopes = vec![
        auth::GMAIL_READONLY_SCOPE.into(),
        auth::GMAIL_SEND_SCOPE.into(),
    ];
    store.store(&bundle).unwrap();
    let frozen = br#"{"raw":"bWltZQ","threadId":null}"#;
    let cancel = CancelToken::default();
    use crate::gmail::types::SendResult;

    assert_eq!(
        provider.send_for_account("other@example.test", frozen, &cancel),
        SendResult::Paused
    );
    assert!(api.requests().is_empty());
    assert_eq!(
        provider.send_for_account("synthetic@example.test", frozen, &cancel),
        SendResult::Unknown
    );
    assert_eq!(api.requests(), [path]);
    assert!(authorizer.requests().is_empty());
    assert_eq!(authorizer.cleared_tokens(), ["synthetic-access"]);
    assert_eq!(
        serde_json::from_str::<Value>(&api.bodies()[0]).unwrap(),
        json!({"raw": "bWltZQ"})
    );
}

#[test]
fn connect_upgrade_reconnect_and_disconnect() {
    let store = Arc::new(MemorySecrets::new());
    let auth = Arc::new(ScriptedAuthorizer::default());
    let (provider, _api) = setup(
        store.clone(),
        auth.clone(),
        vec![
            (PATH, 200, PROFILE),
            (PATH, 200, PROFILE),
            (
                PATH,
                200,
                r#"{"emailAddress":"other@example.test","historyId":"1"}"#,
            ),
        ],
    );
    auth.push_authorize(Ok(grant(&[auth::GMAIL_READONLY_SCOPE])));
    let profile = provider.connect(&CancelToken::default()).unwrap();
    assert_eq!(profile.email_address, "synthetic@example.test");
    let request = &auth.requests()[0];
    assert!(request.interactive && request.account.is_none());
    assert_eq!(request.scopes, vec![auth::GMAIL_READONLY_SCOPE]);
    let bundle = store.load().unwrap().unwrap();
    assert!(bundle.platform_authorized && bundle.refresh_token.is_none());
    auth.push_authorize(Ok(grant(&[auth::GMAIL_READONLY_SCOPE])));
    assert!(matches!(
        provider.request_grant(GmailGrant::Modify, &CancelToken::default()),
        Err(MailError::PermissionRequired)
    ));
    assert_eq!(store.load().unwrap(), Some(bundle));
    auth.push_authorize(Ok(grant(&[
        auth::GMAIL_READONLY_SCOPE,
        auth::GMAIL_MODIFY_SCOPE,
    ])));
    assert!(matches!(
        provider.request_grant(GmailGrant::Modify, &CancelToken::default()),
        Ok(GrantOutcome::Granted(_))
    ));
    let bundle = store.load().unwrap().unwrap();
    let count = auth.requests().len();
    assert!(matches!(
        provider.request_grant(GmailGrant::Modify, &CancelToken::default()),
        Ok(GrantOutcome::AlreadyCovered)
    ));
    assert_eq!(auth.requests().len(), count);
    auth.push_authorize(Ok(grant(&[
        auth::GMAIL_READONLY_SCOPE,
        auth::GMAIL_MODIFY_SCOPE,
    ])));
    assert_eq!(
        provider.connect(&CancelToken::default()).err(),
        Some(MailError::AuthFailed)
    );
    let requests = auth.requests();
    let last = requests.last().unwrap();
    assert_eq!(last.account.as_deref(), Some("synthetic@example.test"));
    assert!(last.scopes.contains(&auth::GMAIL_MODIFY_SCOPE.to_string()));
    assert_eq!(store.load().unwrap(), Some(bundle));
    provider.disconnect().unwrap();
    assert_eq!(auth.cleared_tokens(), vec!["token"]);
    assert!(store.load().unwrap().is_none());
}

#[test]
fn errors_and_silent_refresh_preserve_binding() {
    let store = Arc::new(MemorySecrets::new());
    let auth = Arc::new(ScriptedAuthorizer::default());
    let (provider, _api) = setup(store.clone(), auth.clone(), vec![(PATH, 200, PROFILE)]);
    for (error, expected) in [
        (PlatformAuthError::Cancelled, MailError::AuthCancelled),
        (
            PlatformAuthError::PlayServicesUnavailable,
            MailError::UnsupportedPlatform,
        ),
        (PlatformAuthError::Network, MailError::NetworkUnavailable),
    ] {
        auth.push_authorize(Err(error));
        assert_eq!(
            provider.connect(&CancelToken::default()).err(),
            Some(expected)
        );
    }
    let mut bundle = future_token();
    bundle.platform_authorized = true;
    bundle.refresh_token = None;
    bundle.expires_at_epoch_ms = 0;
    bundle.gmail_modify_granted = true;
    bundle.granted_scopes = vec![
        auth::GMAIL_READONLY_SCOPE.into(),
        auth::GMAIL_MODIFY_SCOPE.into(),
    ];
    store.store(&bundle).unwrap();
    auth.push_authorize(Err(PlatformAuthError::NeedsUserInteraction));
    assert_eq!(
        provider.profile(&CancelToken::default()).err(),
        Some(MailError::AuthRequired)
    );
    assert_eq!(store.load().unwrap(), Some(bundle));
    let request = auth.requests().last().unwrap().clone();
    assert!(!request.interactive);
    assert_eq!(request.account.as_deref(), Some("synthetic@example.test"));
    auth.push_authorize(Ok(grant(&[auth::GMAIL_READONLY_SCOPE, "extra"])));
    provider.profile(&CancelToken::default()).unwrap();
    assert!(!provider.grant_covered(GmailGrant::Modify).unwrap());
    assert_eq!(
        store.load().unwrap().unwrap().granted_scopes,
        vec![auth::GMAIL_READONLY_SCOPE]
    );
    auth.push_authorize(Err(PlatformAuthError::DeveloperError));
    assert_eq!(
        provider.connect(&CancelToken::default()).err(),
        Some(MailError::NotConfigured)
    );
    assert!(!provider.is_configured());
}

#[test]
fn tokenless_connect_persists_no_access_token() {
    let inner = Arc::new(MemorySecrets::new());
    let secrets = Arc::new(TokenlessSecrets::new(inner.clone()));
    let auth = Arc::new(ScriptedAuthorizer::default());
    let (provider, _api) = setup(secrets, auth.clone(), vec![(PATH, 200, PROFILE)]);
    auth.push_authorize(Ok(grant(&[auth::GMAIL_READONLY_SCOPE])));
    provider.connect(&CancelToken::default()).unwrap();
    assert!(inner.load().unwrap().unwrap().access_token.is_empty());
}

#[test]
fn rejected_platform_read_refreshes_once() {
    let store = Arc::new(MemorySecrets::new());
    let auth = Arc::new(ScriptedAuthorizer::default());
    let mut bundle = future_token();
    bundle.platform_authorized = true;
    bundle.refresh_token = None;
    store.store(&bundle).unwrap();
    let (provider, api) = setup(
        store.clone(),
        auth.clone(),
        vec![(PATH, 401, ""), (PATH, 200, PROFILE)],
    );
    let mut fresh = grant(&[auth::GMAIL_READONLY_SCOPE]);
    fresh.access_token = "fresh".into();
    auth.push_authorize(Ok(fresh));
    provider.profile(&CancelToken::default()).unwrap();
    assert_eq!(auth.cleared_tokens(), vec![bundle.access_token]);
    let requests = auth.requests();
    assert_eq!(requests.len(), 1);
    assert!(!requests[0].interactive);
    assert_eq!(
        requests[0].account.as_deref(),
        Some("synthetic@example.test")
    );
    assert_eq!(api.requests().len(), 2);
    assert_eq!(store.load().unwrap().unwrap().access_token, "fresh");
}

#[test]
fn rejected_platform_read_stops_after_retry_or_interaction_required() {
    for interaction in [false, true] {
        let store = Arc::new(MemorySecrets::new());
        let auth = Arc::new(ScriptedAuthorizer::default());
        let mut bundle = future_token();
        bundle.platform_authorized = true;
        bundle.refresh_token = None;
        bundle.granted_scopes = vec![auth::GMAIL_READONLY_SCOPE.into()];
        store.store(&bundle).unwrap();
        let (provider, api) = setup(
            store.clone(),
            auth.clone(),
            vec![(PATH, 401, ""), (PATH, 401, "")],
        );
        if interaction {
            auth.push_authorize(Err(PlatformAuthError::NeedsUserInteraction));
        } else {
            auth.push_authorize(Ok(grant(&[auth::GMAIL_READONLY_SCOPE])));
        }
        assert_eq!(
            provider.profile(&CancelToken::default()).err(),
            Some(MailError::AuthRequired)
        );
        assert_eq!(api.requests().len(), if interaction { 1 } else { 2 });
        let current = store.load().unwrap().unwrap();
        assert_eq!(current.account_id, bundle.account_id);
        assert_eq!(current.granted_scopes, bundle.granted_scopes);
    }
}

#[test]
fn rejected_platform_setter_invalidates_without_retry() {
    let store = Arc::new(MemorySecrets::new());
    let auth = Arc::new(ScriptedAuthorizer::default());
    let mut bundle = future_token();
    bundle.platform_authorized = true;
    bundle.refresh_token = None;
    bundle.gmail_modify_granted = true;
    bundle.granted_scopes = vec![auth::GMAIL_MODIFY_SCOPE.into()];
    store.store(&bundle).unwrap();
    let (provider, api) = setup(
        store.clone(),
        auth.clone(),
        vec![("/gmail/v1/users/me/messages/batchModify", 401, "")],
    );
    assert_eq!(
        provider
            .apply_archive(&["message".into()], true, &CancelToken::default())
            .err(),
        Some(MailError::AuthRequired)
    );
    assert_eq!(api.requests().len(), 1);
    assert_eq!(auth.cleared_tokens(), vec![bundle.access_token]);
    assert_eq!(store.load().unwrap().unwrap().expires_at_epoch_ms, 0);
}
