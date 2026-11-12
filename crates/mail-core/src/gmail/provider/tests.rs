use super::*;
use crate::gmail::parse::MAX_PART_BODY_BYTES;
use crate::gmail::types::GmailReadProvider;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use serde_json::{json, Value};
use std::collections::VecDeque;
use std::io::{Read, Write};
use std::net::TcpListener;

fn test_config() -> GoogleConfig {
    GoogleConfig {
        client_id: "synthetic-client-id.apps.googleusercontent.com".to_string(),
        client_secret: None,
    }
}

fn future_token() -> TokenBundle {
    TokenBundle {
        access_token: "synthetic-access".to_string(),
        refresh_token: Some("synthetic-refresh".to_string()),
        expires_at_epoch_ms: now_ms() + 3_600_000,
        account_id: Some("synthetic@example.test".to_string()),
        email: Some("synthetic@example.test".to_string()),
        gmail_modify_granted: false,
    }
}

/// Loopback fake Google API: serves scripted (path-prefix, status, body)
/// responses, records request targets. No real network beyond localhost.
struct FakeApi {
    state: Arc<FakeState>,
    _thread: std::thread::JoinHandle<()>,
}

type RequestHook = Arc<dyn Fn(&str) + Send + Sync>;

struct FakeState {
    script: Mutex<VecDeque<(String, u16, String)>>,
    requests: Mutex<Vec<String>>,
    bodies: Mutex<Vec<String>>,
    authorization_headers: Mutex<Vec<Option<String>>>,
    request_heads: Mutex<Vec<String>>,
    on_request: Option<RequestHook>,
}

impl FakeApi {
    fn start(script: Vec<(&str, u16, &str)>) -> (String, FakeApi) {
        Self::start_with_request_hook(script, None)
    }

    fn start_with_request_hook(
        script: Vec<(&str, u16, &str)>,
        on_request: Option<RequestHook>,
    ) -> (String, FakeApi) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let state = Arc::new(FakeState {
            script: Mutex::new(
                script
                    .into_iter()
                    .map(|(prefix, status, body)| (prefix.to_string(), status, body.to_string()))
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
            bodies: Mutex::new(Vec::new()),
            authorization_headers: Mutex::new(Vec::new()),
            request_heads: Mutex::new(Vec::new()),
            on_request,
        });
        let thread_state = Arc::clone(&state);
        let thread = std::thread::spawn(move || loop {
            let Ok((mut stream, _)) = listener.accept() else {
                break;
            };
            let mut buf = [0u8; 8192];
            let len = stream.read(&mut buf).unwrap_or(0);
            let text = String::from_utf8_lossy(&buf[..len]);
            thread_state
                .request_heads
                .lock()
                .unwrap()
                .push(text.split("\r\n\r\n").next().unwrap_or("").to_string());
            let target = text
                .lines()
                .next()
                .and_then(|line| line.split_whitespace().nth(1))
                .unwrap_or("")
                .to_string();
            thread_state.requests.lock().unwrap().push(target.clone());
            thread_state
                .bodies
                .lock()
                .unwrap()
                .push(text.split("\r\n\r\n").nth(1).unwrap_or("").to_string());
            thread_state
                .authorization_headers
                .lock()
                .unwrap()
                .push(text.lines().find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("authorization")
                        .then(|| value.trim().to_string())
                }));
            if let Some(on_request) = &thread_state.on_request {
                on_request(&target);
            }
            let scripted = thread_state.script.lock().unwrap().pop_front();
            match scripted {
                Some((prefix, status, body)) if target.starts_with(&prefix) => {
                    let location = if status == 302 {
                        format!("Location: http://127.0.0.1:{port}/redirect-target\r\n")
                    } else {
                        String::new()
                    };
                    let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 {status} x\r\n{location}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                                body.len()
                            )
                            .as_bytes(),
                        );
                }
                _ => {
                    let _ = stream.write_all(
                        b"HTTP/1.1 500 x\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
            }
            let _ = stream.flush();
            drop(stream);
        });
        (
            format!("http://127.0.0.1:{port}"),
            FakeApi {
                state,
                _thread: thread,
            },
        )
    }

    fn requests(&self) -> Vec<String> {
        self.state.requests.lock().unwrap().clone()
    }

    fn bodies(&self) -> Vec<String> {
        self.state.bodies.lock().unwrap().clone()
    }

    fn authorization_headers(&self) -> Vec<Option<String>> {
        self.state.authorization_headers.lock().unwrap().clone()
    }
}

/// Provider with loopback endpoints and a no-op opener (no browser).
/// Request pacing is disabled here; the pacing tests below opt back in
/// with short intervals so no test performs a long real sleep.
fn test_provider(api_base: &str, secrets: Arc<dyn Secrets>) -> GmailProvider {
    let mut provider = GmailProvider::new(test_config(), secrets).unwrap();
    provider.min_request_interval = Duration::ZERO;
    provider.endpoints = Endpoints {
        authorize: format!("{api_base}/synthetic-authorize"),
        token: format!("{api_base}/synthetic-token"),
        api: api_base.to_string(),
    };
    provider.opener = Arc::new(|_| Ok(()));
    provider
}

fn completing_oauth_opener(captured_url: Arc<Mutex<Option<String>>>) -> UrlOpener {
    Arc::new(move |url| {
        *captured_url.lock().unwrap() = Some(url.to_string());
        let parsed = url::Url::parse(url).unwrap();
        let redirect_uri = parsed
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| value.to_string())
            .unwrap();
        let state = parsed
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .unwrap();
        let callback = format!("{redirect_uri}?code=synthetic-code&state={state}");
        std::thread::spawn(move || {
            let port = redirect_uri
                .rsplit(':')
                .next()
                .and_then(|part| part.split('/').next())
                .unwrap()
                .parse::<u16>()
                .unwrap();
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream.write_all(
                format!("GET {callback} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes(),
            );
            let mut response = Vec::new();
            let _ = stream.read_to_end(&mut response);
        });
        Ok(())
    })
}

pub(in crate::gmail) fn payload_headers(headers: &[(&str, &str)]) -> Vec<Value> {
    headers
        .iter()
        .map(|(name, value)| json!({"name": name, "value": value}))
        .collect()
}

pub(in crate::gmail) fn text_payload(
    mime_type: &str,
    headers: &[(&str, &str)],
    data: Option<&[u8]>,
) -> Value {
    let body = data
        .map(|bytes| json!({"data": URL_SAFE_NO_PAD.encode(bytes)}))
        .unwrap_or_else(|| json!({}));
    json!({
        "mimeType": mime_type,
        "headers": payload_headers(headers),
        "body": body,
    })
}

pub(in crate::gmail) fn gmail_message(id: &str, label_ids: &[&str], payload: Value) -> Value {
    json!({
        "id": id,
        "labelIds": label_ids,
        "internalDate": "1760349600000",
        "payload": payload,
    })
}

pub(in crate::gmail) fn thread_response(
    thread_id: &str,
    history_id: &str,
    messages: Vec<Value>,
) -> String {
    json!({"id": thread_id, "historyId": history_id, "messages": messages}).to_string()
}

#[test]
fn connect_runs_oauth_stores_credentials_and_returns_profile() {
    let (api_base, api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/profile",
        200,
        r#"{"emailAddress":"synthetic@example.test","historyId":"1234"}"#,
    )]);
    let (token_base, token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-connect","refresh_token":"rt-connect","expires_in":3600}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    // The opener simulates the browser: it parses the constructed
    // authorization URL and completes the loopback callback round trip.
    let opener_url: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let opener_url_for_opener = Arc::clone(&opener_url);
    provider.opener = Arc::new(move |url| {
        *opener_url_for_opener.lock().unwrap() = Some(url.to_string());
        let parsed = url::Url::parse(url).unwrap();
        let redirect_uri = parsed
            .query_pairs()
            .find(|(k, _)| k == "redirect_uri")
            .map(|(_, v)| v.to_string())
            .unwrap();
        let state = parsed
            .query_pairs()
            .find(|(k, _)| k == "state")
            .map(|(_, v)| v.to_string())
            .unwrap();
        let full = format!("{redirect_uri}?code=synthetic-code&state={state}");
        std::thread::spawn(move || {
            // The redirect URI is http://127.0.0.1:<port>/oauth2/callback.
            let port: u16 = redirect_uri
                .rsplit(':')
                .next()
                .and_then(|p| p.split('/').next())
                .unwrap()
                .parse()
                .unwrap();
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream
                .write_all(format!("GET {full} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes());
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
        });
        Ok(())
    });

    let profile = provider.connect(&CancelToken::default()).unwrap();
    assert_eq!(profile.email_address, "synthetic@example.test");
    assert_eq!(profile.history_id, "1234");
    assert_eq!(profile.account_id, "synthetic@example.test");

    let stored = secrets.load().unwrap().expect("credentials stored");
    assert_eq!(stored.access_token, "at-connect");
    assert_eq!(stored.refresh_token.as_deref(), Some("rt-connect"));
    assert_eq!(stored.email.as_deref(), Some("synthetic@example.test"));

    // The authorization URL was https Google auth with PKCE + state;
    // the token endpoint got the code exchange; the profile endpoint got
    // the bearer call.
    let auth_url = opener_url.lock().unwrap().clone().unwrap();
    let parsed = url::Url::parse(&auth_url).unwrap();
    // Production endpoints are the fixed HTTPS Google constants; the
    // synthetic test endpoint is loopback http. Assert the redirect
    // stays loopback and the Google client id is carried.
    assert!(parsed
        .query_pairs()
        .find(|(k, _)| k == "redirect_uri")
        .map(|(_, v)| v.to_string())
        .unwrap()
        .starts_with("http://127.0.0.1:"));
    assert!(parsed
        .query_pairs()
        .any(|(k, v)| k == "client_id" && v == "synthetic-client-id.apps.googleusercontent.com"));
    assert!(parsed.path().contains("auth"));
    let params: Vec<(String, String)> = parsed
        .query_pairs()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
    assert!(params
        .iter()
        .any(|(k, v)| k == "code_challenge_method" && v == "S256"));
    assert!(params
        .iter()
        .any(|(k, v)| k == "scope" && v == auth::GMAIL_READONLY_SCOPE));
    assert!(params.iter().any(|(k, v)| k == "state" && !v.is_empty()));
    let exchange_bodies = token.bodies();
    let exchange_body = exchange_bodies.first().expect("code exchange happened");
    assert!(exchange_body.contains("grant_type=authorization_code"));
    assert!(exchange_body.contains("code=synthetic-code"));
    // PKCE verifier was sent with the code (random, so just presence).
    assert!(exchange_body.contains("code_verifier="));
    assert!(api
        .requests()
        .iter()
        .any(|r| r.contains("/gmail/v1/users/me/profile")));
}

#[test]
fn connect_rejects_account_switch_before_storing_tokens() {
    let (api_base, _api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/profile",
        200,
        r#"{"emailAddress":"other@example.test","historyId":"456"}"#,
    )]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"new-account-access","refresh_token":"new-account-refresh","expires_in":3600}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let previous = future_token();
    secrets.store(&previous).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    provider.opener = Arc::new(|url| {
        let parsed = url::Url::parse(url).unwrap();
        let redirect_uri = parsed
            .query_pairs()
            .find(|(key, _)| key == "redirect_uri")
            .map(|(_, value)| value.to_string())
            .unwrap();
        let state = parsed
            .query_pairs()
            .find(|(key, _)| key == "state")
            .map(|(_, value)| value.to_string())
            .unwrap();
        let callback = format!("{redirect_uri}?code=synthetic-code&state={state}");
        std::thread::spawn(move || {
            let port = redirect_uri
                .rsplit(':')
                .next()
                .and_then(|part| part.split('/').next())
                .unwrap()
                .parse::<u16>()
                .unwrap();
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream.write_all(
                format!("GET {callback} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes(),
            );
            let mut response = Vec::new();
            let _ = stream.read_to_end(&mut response);
        });
        Ok(())
    });

    assert!(matches!(
        provider.connect(&CancelToken::default()),
        Err(MailError::AuthFailed)
    ));
    assert_eq!(secrets.load().unwrap(), Some(previous));
}

#[test]
fn explicit_upgrade_requests_and_verifies_modify_scope_for_bound_account() {
    let (api_base, _api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/profile",
        200,
        r#"{"emailAddress":"synthetic@example.test","historyId":"1234"}"#,
    )]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-upgraded","refresh_token":"rt-upgraded","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let previous = future_token();
    secrets.store(&previous).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    let auth_url = Arc::new(Mutex::new(None));
    provider.opener = completing_oauth_opener(auth_url.clone());

    let profile = provider.enable_mutations(&CancelToken::default()).unwrap();
    assert_eq!(profile.account_id, "synthetic@example.test");
    assert!(provider.mutation_access().unwrap());
    let stored = secrets.load().unwrap().unwrap();
    assert_eq!(stored.access_token, "at-upgraded");
    assert!(stored.gmail_modify_granted);
    let query: Vec<(String, String)> =
        url::Url::parse(auth_url.lock().unwrap().as_deref().unwrap())
            .unwrap()
            .query_pairs()
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
    assert!(query
        .iter()
        .any(|(key, value)| { key == "scope" && value == auth::GMAIL_MODIFY_SCOPE }));
}

#[test]
fn upgrade_without_returned_modify_scope_preserves_old_bundle() {
    let (_api_base, api) = FakeApi::start(vec![]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-denied","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let previous = future_token();
    secrets.store(&previous).unwrap();
    let mut provider = test_provider("http://127.0.0.1:9", secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    provider.opener = completing_oauth_opener(Arc::new(Mutex::new(None)));

    assert!(matches!(
        provider.enable_mutations(&CancelToken::default()),
        Err(MailError::PermissionRequired)
    ));
    assert_eq!(secrets.load().unwrap(), Some(previous));
    assert!(!provider.mutation_access().unwrap());
    assert!(
        api.requests().is_empty(),
        "profile must not be fetched after denial"
    );
}

#[test]
fn upgrade_with_omitted_scope_is_denied_without_replacing_credentials() {
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-unverified","expires_in":3600}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let previous = future_token();
    secrets.store(&previous).unwrap();
    let mut provider = test_provider("http://127.0.0.1:9", secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    provider.opener = completing_oauth_opener(Arc::new(Mutex::new(None)));

    assert!(matches!(
        provider.enable_mutations(&CancelToken::default()),
        Err(MailError::PermissionRequired)
    ));
    assert_eq!(secrets.load().unwrap(), Some(previous));
    assert!(!provider.mutation_access().unwrap());
}

#[test]
fn upgrade_account_swap_preserves_old_credentials() {
    let (api_base, _api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/profile",
        200,
        r#"{"emailAddress":"other@example.test","historyId":"5"}"#,
    )]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-other","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.modify"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let previous = future_token();
    secrets.store(&previous).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    provider.opener = completing_oauth_opener(Arc::new(Mutex::new(None)));

    assert!(matches!(
        provider.enable_mutations(&CancelToken::default()),
        Err(MailError::AuthFailed)
    ));
    assert_eq!(secrets.load().unwrap(), Some(previous));
    assert!(!provider.mutation_access().unwrap());
}

#[test]
fn cancelled_upgrade_after_profile_keeps_old_bundle_before_store() {
    let cancel = CancelToken::default();
    let cancel_on_profile = cancel.clone();
    let (api_base, _api) = FakeApi::start_with_request_hook(
        vec![(
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"6"}"#,
        )],
        Some(Arc::new(move |target| {
            if target.starts_with("/gmail/v1/users/me/profile") {
                cancel_on_profile.cancel();
            }
        })),
    );
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-cancelled","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.modify"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let previous = future_token();
    secrets.store(&previous).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    provider.opener = completing_oauth_opener(Arc::new(Mutex::new(None)));

    assert!(matches!(
        provider.enable_mutations(&cancel),
        Err(MailError::AuthCancelled)
    ));
    assert_eq!(secrets.load().unwrap(), Some(previous));
    assert!(!provider.mutation_access().unwrap());
}

#[test]
fn connect_rejects_when_cancelled_before_start() {
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let provider = test_provider("http://127.0.0.1:9", secrets);
    let cancel = CancelToken::default();
    cancel.cancel();
    assert!(matches!(
        provider.connect(&cancel),
        Err(MailError::AuthCancelled)
    ));
}

#[test]
fn expired_token_refreshes_and_preserves_refresh_token() {
    let (base, api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/profile",
        200,
        r#"{"emailAddress":"synthetic@example.test","historyId":"77"}"#,
    )]);
    let (token_base, token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-refreshed","expires_in":3600}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            expires_at_epoch_ms: now_ms() - 1_000,
            ..future_token()
        })
        .unwrap();
    let mut provider = test_provider(&base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");

    let profile = provider.profile(&CancelToken::default()).unwrap();
    assert_eq!(profile.history_id, "77");

    // Google omitted refresh_token in the response; the stored one is kept.
    let stored = secrets.load().unwrap().unwrap();
    assert_eq!(stored.access_token, "at-refreshed");
    assert_eq!(stored.refresh_token.as_deref(), Some("synthetic-refresh"));
    let refresh_bodies = token.bodies();
    let refresh_body = refresh_bodies.first().expect("refresh request happened");
    assert!(refresh_body.contains("grant_type=refresh_token"));
    assert!(refresh_body.contains("refresh_token=synthetic-refresh"));
    assert!(api
        .requests()
        .iter()
        .any(|r| r.contains("/gmail/v1/users/me/profile")));
}

#[test]
fn refresh_failures_after_preliminary_profile_never_dispatch_setter() {
    for (status, body, expected) in [
        (
            503,
            "synthetic token outage",
            MailError::ProviderUnavailable,
        ),
        (200, "not json", MailError::InvalidProviderResponse),
    ] {
        let (api_base, api) = FakeApi::start_with_request_hook(
            vec![(
                "/gmail/v1/users/me/profile",
                200,
                r#"{"emailAddress":"synthetic@example.test","historyId":"77"}"#,
            )],
            Some(Arc::new(|target| {
                if target.starts_with("/gmail/v1/users/me/profile") {
                    // The access token is fresh at profile dispatch, then
                    // crosses EXPIRY_SKEW_MS before the setter asks for it.
                    std::thread::sleep(Duration::from_millis(1_100));
                }
            })),
        );
        let (token_base, token) = FakeApi::start(vec![("/synthetic-token", status, body)]);
        let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
        let granted = TokenBundle {
            gmail_modify_granted: true,
            expires_at_epoch_ms: now_ms() + EXPIRY_SKEW_MS + 1_000,
            ..future_token()
        };
        secrets.store(&granted).unwrap();
        let mut provider = test_provider(&api_base, secrets.clone());
        provider.endpoints.token = format!("{token_base}/synthetic-token");

        let profile = provider.profile(&CancelToken::default()).unwrap();
        assert_eq!(profile.history_id, "77", "preliminary profile succeeds");
        assert!(
            secrets.load().unwrap().unwrap().expires_at_epoch_ms - EXPIRY_SKEW_MS <= now_ms(),
            "token crosses the refresh threshold after profile returns"
        );
        assert_eq!(
            provider.apply_archive(&["snapshot-id".to_string()], true, &CancelToken::default()),
            Err(expected)
        );
        assert_eq!(token.requests().len(), 1, "setter attempted token refresh");
        assert_eq!(
            api.requests(),
            vec!["/gmail/v1/users/me/profile".to_string()],
            "refresh failure occurs before any batchModify request"
        );
    }
}

#[test]
fn paced_setter_rechecks_grant_after_concurrent_refresh_downgrade() {
    let (api_base, api) = FakeApi::start(vec![]);
    let (token_base, token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-downgraded-during-pacing","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let expiry = now_ms() + EXPIRY_SKEW_MS + 150;
    let granted = TokenBundle {
        gmail_modify_granted: true,
        expires_at_epoch_ms: expiry,
        ..future_token()
    };
    secrets.store(&granted).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    provider.min_request_interval = Duration::from_millis(800);
    let seeded = Instant::now();
    *provider.last_request_slot.lock().unwrap() = Some(seeded);
    let provider = Arc::new(provider);

    let (setter_tx, setter_rx) = std::sync::mpsc::channel();
    let setter_provider = Arc::clone(&provider);
    std::thread::spawn(move || {
        let result = setter_provider.apply_archive(
            &["paced-message".to_string()],
            true,
            &CancelToken::default(),
        );
        let _ = setter_tx.send(result);
    });
    assert!(
        until_provider_slot(&provider, seeded),
        "setter did not reserve its pace slot"
    );

    // Wait until the original token crosses the production refresh skew,
    // then exercise the real readonly get_thread refresh while the setter
    // remains in its production pacing wait.
    let until_refresh = expiry - EXPIRY_SKEW_MS - now_ms() + 5;
    if until_refresh > 0 {
        std::thread::sleep(Duration::from_millis(until_refresh as u64));
    }
    let read_cancel = CancelToken::default();
    let (read_tx, read_rx) = std::sync::mpsc::channel();
    let read_provider = Arc::clone(&provider);
    let read_cancel_thread = read_cancel.clone();
    std::thread::spawn(move || {
        let result = read_provider.get_thread("synthetic-thread", &read_cancel_thread);
        let _ = read_tx.send(result);
    });
    let refresh_deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if secrets
            .load()
            .unwrap()
            .is_some_and(|bundle| bundle.access_token == "at-downgraded-during-pacing")
        {
            break;
        }
        assert!(
            Instant::now() < refresh_deadline,
            "readonly refresh did not publish"
        );
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!secrets.load().unwrap().unwrap().gmail_modify_granted);
    read_cancel.cancel();
    assert!(matches!(
        read_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(MailError::AuthCancelled)
    ));
    assert_eq!(
        setter_rx.recv_timeout(Duration::from_secs(3)).unwrap(),
        Err(MailError::PermissionRequired)
    );
    assert_eq!(
        token.requests().len(),
        1,
        "the real refresh endpoint was used"
    );
    assert!(
        api.requests().is_empty(),
        "revoked grant must prevent batchModify"
    );
}

#[test]
fn paced_setter_uses_current_same_account_credential_after_replacement() {
    let (api_base, api) =
        FakeApi::start(vec![("/gmail/v1/users/me/messages/batchModify", 200, "")]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let original = TokenBundle {
        gmail_modify_granted: true,
        ..future_token()
    };
    secrets.store(&original).unwrap();
    let mut provider = test_provider(&api_base, secrets);
    provider.min_request_interval = Duration::from_millis(150);
    let seeded = Instant::now();
    *provider.last_request_slot.lock().unwrap() = Some(seeded);
    let provider = Arc::new(provider);

    let (setter_tx, setter_rx) = std::sync::mpsc::channel();
    let setter_provider = Arc::clone(&provider);
    std::thread::spawn(move || {
        let result = setter_provider.apply_archive(
            &["paced-message".to_string()],
            true,
            &CancelToken::default(),
        );
        let _ = setter_tx.send(result);
    });
    assert!(
        until_provider_slot(&provider, seeded),
        "setter did not reserve its pace slot"
    );

    let replacement = TokenBundle {
        access_token: "synthetic-replacement-access".to_string(),
        ..original
    };
    let mut publication = provider.credential_publication.lock().unwrap();
    provider
        .publish_bundle_locked(
            &mut publication,
            &replacement,
            CredentialPublicationKind::AccountChange,
        )
        .unwrap();
    drop(publication);

    setter_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("paced setter completes")
        .unwrap();
    assert_eq!(
        api.authorization_headers(),
        vec![Some("Bearer synthetic-replacement-access".to_string())],
        "the POST uses the current token, not its pre-pacing credential"
    );
    assert_eq!(api.requests().len(), 1);
}

#[test]
fn paced_setter_cancellation_prevents_dispatch() {
    let (api_base, api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            gmail_modify_granted: true,
            ..future_token()
        })
        .unwrap();
    let mut provider = test_provider(&api_base, secrets);
    provider.min_request_interval = Duration::from_secs(3600);
    let seeded = Instant::now();
    *provider.last_request_slot.lock().unwrap() = Some(seeded);
    let provider = Arc::new(provider);
    let cancel = CancelToken::default();
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let setter_provider = Arc::clone(&provider);
    let setter_cancel = cancel.clone();
    std::thread::spawn(move || {
        let result =
            setter_provider.apply_read(&["paced-message".to_string()], true, &setter_cancel);
        let _ = done_tx.send(result);
    });
    assert!(
        until_provider_slot(&provider, seeded),
        "setter did not reserve its pace slot"
    );
    cancel.cancel();
    assert_eq!(
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(MailError::AuthCancelled)
    );
    assert!(api.requests().is_empty());
}

#[test]
fn refresh_scope_downgrade_disables_write_before_setter_dispatch() {
    let (api_base, api) = FakeApi::start(vec![]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-downgraded","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let granted = TokenBundle {
        gmail_modify_granted: true,
        expires_at_epoch_ms: now_ms() - 1_000,
        ..future_token()
    };
    secrets.store(&granted).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");

    assert!(matches!(
        provider.apply_archive(&["m-snapshot".to_string()], true, &CancelToken::default()),
        Err(MailError::PermissionRequired)
    ));
    assert!(!secrets.load().unwrap().unwrap().gmail_modify_granted);
    assert!(
        api.requests().is_empty(),
        "downgraded grant must block POST"
    );
}

#[test]
fn refresh_scope_cannot_promote_an_unverified_bundle() {
    let (api_base, api) = FakeApi::start(vec![]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-unverified-refresh","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.modify"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let unverified = TokenBundle {
        expires_at_epoch_ms: now_ms() - 1_000,
        ..future_token()
    };
    secrets.store(&unverified).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");

    assert!(matches!(
        provider.apply_archive(&["snapshot-id".to_string()], true, &CancelToken::default()),
        Err(MailError::PermissionRequired)
    ));
    assert!(!secrets.load().unwrap().unwrap().gmail_modify_granted);
    assert!(api.requests().is_empty());
}

#[test]
fn refresh_without_scope_preserves_verified_write_grant() {
    let (api_base, api) =
        FakeApi::start(vec![("/gmail/v1/users/me/messages/batchModify", 200, "")]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"at-refreshed-grant","expires_in":3600}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let granted = TokenBundle {
        gmail_modify_granted: true,
        expires_at_epoch_ms: now_ms() - 1_000,
        ..future_token()
    };
    secrets.store(&granted).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");

    provider
        .apply_archive(&["m-snapshot".to_string()], true, &CancelToken::default())
        .unwrap();
    assert!(secrets.load().unwrap().unwrap().gmail_modify_granted);
    assert!(api.requests()[0].ends_with("/gmail/v1/users/me/messages/batchModify"));
}

#[test]
fn revoked_refresh_token_becomes_auth_required() {
    let (base, _api) = FakeApi::start(vec![]);
    let (token_base, token) = FakeApi::start(vec![(
        "/synthetic-token",
        400,
        r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            expires_at_epoch_ms: now_ms() - 1_000,
            ..future_token()
        })
        .unwrap();
    let mut provider = test_provider(&base, secrets);
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    assert!(matches!(
        provider.profile(&CancelToken::default()),
        Err(MailError::AuthRequired)
    ));
    assert_eq!(token.requests().len(), 1);
}

#[test]
fn missing_credentials_require_auth() {
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let provider = test_provider("http://127.0.0.1:9", secrets);
    assert!(!provider.has_credentials().unwrap());
    assert!(matches!(
        provider.list_inbox(None, &CancelToken::default()),
        Err(MailError::AuthRequired)
    ));
    assert!(matches!(
        provider.get_thread("t1", &CancelToken::default()),
        Err(MailError::AuthRequired)
    ));
    assert!(matches!(
        provider.history("5", None, &CancelToken::default()),
        Err(GmailHistoryError::Mail(MailError::AuthRequired))
    ));
}

#[test]
fn destination_catalog_and_queries_are_bounded_reads() {
    let mut responses = vec![(
        "/gmail/v1/users/me/labels",
        200,
        r#"{"labels":[{"id":"INBOX","name":"INBOX","type":"system"},{"id":"Label_7","name":"<img src=x>","type":"user"}]}"#,
    )];
    for _ in 0..6 {
        responses.push((
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[],"nextPageToken":"next"}"#,
        ));
    }
    let (base, api) = FakeApi::start(responses);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let account = "synthetic@example.test";
    let catalog = provider
        .list_destinations_for_account(account, &CancelToken::default())
        .unwrap();
    assert_eq!(catalog.len(), 6);
    assert_eq!(catalog[1].name, "Provider Drafts");
    assert_eq!(catalog[5].name, "<img src=x>");
    for id in ["SENT", "DRAFT", "ALL_MAIL", "SPAM", "TRASH", "Label_7"] {
        provider
            .list_destination_for_account(
                account,
                id,
                Some("opaque token"),
                &CancelToken::default(),
            )
            .unwrap();
    }
    let requests = api.requests();
    assert_eq!(requests.len(), 7);
    for request in &requests[1..] {
        assert!(request.contains("maxResults=25"));
        let url = url::Url::parse(&format!("http://fixture{request}")).unwrap();
        assert!(url
            .query_pairs()
            .any(|(key, value)| key == "pageToken" && value == "opaque token"));
    }
    assert!(requests[1].contains("labelIds=SENT"));
    assert!(requests[2].contains("labelIds=DRAFT"));
    assert!(requests[3].contains("q=-in%3Aspam%20-in%3Atrash"));
    assert!(requests[4].contains("includeSpamTrash=true&labelIds=SPAM"));
    assert!(requests[5].contains("labelIds=TRASH"));
    assert!(requests[6].contains("labelIds=Label_7"));
}

#[test]
fn destination_reads_fail_closed_for_a_foreign_expected_account() {
    let (base, api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/labels",
            200,
            r#"{"labels":[{"id":"Label_7","name":"B","type":"user"}]}"#,
        ),
        ("/gmail/v1/users/me/threads", 200, r#"{"threads":[]}"#),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    // Published credentials belong to account A.
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let cancel = CancelToken::default();

    // The admission check runs before any dispatch: a request naming a
    // different expected account must never reach the network, so B's
    // catalog or (even empty) pages can never be fetched under A's name.
    assert_eq!(
        provider.list_destinations_for_account("other@example.test", &cancel),
        Err(MailError::AuthFailed)
    );
    assert!(matches!(
        provider.list_destination_for_account("other@example.test", "SENT", None, &cancel),
        Err(MailError::AuthFailed)
    ));
    assert!(api.requests().is_empty());

    // The bound account still reads normally.
    assert_eq!(
        provider
            .list_destinations_for_account("synthetic@example.test", &cancel)
            .unwrap()
            .len(),
        6
    );
}

#[test]
fn destination_reads_discard_data_when_credentials_switch_mid_read() {
    enum BoundRead {
        Catalog,
        Page,
    }
    let cases = [
        (
            BoundRead::Catalog,
            "/gmail/v1/users/me/labels",
            r#"{"labels":[{"id":"Label_7","name":"B","type":"user"}]}"#,
        ),
        // An empty page has no thread stamps to expose the switch; the
        // post-fetch identity verification must still discard it.
        (
            BoundRead::Page,
            "/gmail/v1/users/me/threads",
            r#"{"threads":[]}"#,
        ),
    ];
    for (read, path, body) in cases {
        let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
        secrets.store(&future_token()).unwrap();
        let swap = Arc::clone(&secrets);
        let hook: RequestHook = Arc::new(move |_target| {
            // Reconnect as a different account publishes B's credentials
            // while the read is in flight.
            let mut bundle = future_token();
            bundle.account_id = Some("other@example.test".to_string());
            bundle.email = Some("other@example.test".to_string());
            swap.store(&bundle).unwrap();
        });
        let (base, api) = FakeApi::start_with_request_hook(vec![(path, 200, body)], Some(hook));
        let provider = test_provider(&base, secrets);
        let cancel = CancelToken::default();
        let result = match read {
            BoundRead::Catalog => provider
                .list_destinations_for_account("synthetic@example.test", &cancel)
                .map(|_| ()),
            BoundRead::Page => provider
                .list_destination_for_account("synthetic@example.test", "SENT", None, &cancel)
                .map(|_| ()),
        };
        assert_eq!(result, Err(MailError::AuthFailed));
        // Exactly one network dispatch: the read fetched and was
        // discarded post-fetch.
        assert_eq!(api.requests().len(), 1);
        // Token/identity coherence: the data fetch dispatched the token
        // from the SAME validated account-A publication, so any content
        // the server returned was account-A data, discarded only because
        // the publication raced mid-read.
        assert_eq!(
            api.authorization_headers()[0].as_deref(),
            Some("Bearer synthetic-access")
        );
    }
}

#[test]
fn destination_thread_gets_are_bound_and_token_coherent() {
    let headers = [
        ("From", "Sender Name <sender@example.test>"),
        ("To", "rcpt@example.test"),
        ("Subject", "Hello world"),
        ("Date", "Mon, 13 Oct 2025 10:00:00 +0000"),
        ("Content-Type", "text/plain; charset=utf-8"),
    ];
    let plain = gmail_message(
        "m1",
        &["INBOX"],
        text_payload("text/plain", &headers, Some(b"Line one.")),
    );
    let body = thread_response("t1", "99", vec![plain]);
    let cancel = CancelToken::default();

    // Admitted account: the thread GET dispatches the validated token and
    // the parsed thread carries exactly that identity.
    let (base, api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t1", 200, &body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let thread = provider
        .get_thread_for_account("synthetic@example.test", "t1", &cancel)
        .unwrap()
        .expect("thread exists");
    assert_eq!(
        thread.conversation.conversation_ref.account_id,
        "synthetic@example.test"
    );
    assert!(api.requests()[0].contains("format=full"));
    assert_eq!(
        api.authorization_headers()[0].as_deref(),
        Some("Bearer synthetic-access")
    );

    // Foreign expected account: fail closed before any dispatch.
    let (base, api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t1", 200, &body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    assert!(matches!(
        provider.get_thread_for_account("other@example.test", "t1", &cancel),
        Err(MailError::AuthFailed)
    ));
    assert!(api.requests().is_empty());

    // Credential publication switches mid-read: the fetched thread is
    // discarded post-fetch even though the dispatch itself used the
    // validated account-A token.
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let swap = Arc::clone(&secrets);
    let hook: RequestHook = Arc::new(move |_target| {
        let mut bundle = future_token();
        bundle.account_id = Some("other@example.test".to_string());
        bundle.email = Some("other@example.test".to_string());
        swap.store(&bundle).unwrap();
    });
    let (base, api) = FakeApi::start_with_request_hook(
        vec![("/gmail/v1/users/me/threads/t1", 200, &body)],
        Some(hook),
    );
    let provider = test_provider(&base, secrets);
    assert!(matches!(
        provider.get_thread_for_account("synthetic@example.test", "t1", &cancel),
        Err(MailError::AuthFailed)
    ));
    assert_eq!(api.requests().len(), 1);
    assert_eq!(
        api.authorization_headers()[0].as_deref(),
        Some("Bearer synthetic-access")
    );
}

#[test]
fn destination_reads_require_credentials() {
    let (base, _api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let provider = test_provider(&base, secrets);
    let cancel = CancelToken::default();
    assert!(matches!(
        provider.list_destinations_for_account("synthetic@example.test", &cancel),
        Err(MailError::AuthRequired)
    ));
    assert!(matches!(
        provider.list_destination_for_account("synthetic@example.test", "SENT", None, &cancel),
        Err(MailError::AuthRequired)
    ));
}

#[test]
fn list_inbox_maps_threads_and_pagination() {
    let (base, api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[{"id":"t1"},{"id":"t2"}],"nextPageToken":"cursor-2"}"#,
        ),
        (
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[{"id":"t3"}]}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);

    let first = provider.list_inbox(None, &CancelToken::default()).unwrap();
    assert_eq!(first.thread_ids, vec!["t1", "t2"]);
    assert_eq!(first.next_page_token.as_deref(), Some("cursor-2"));

    let second = provider
        .list_inbox(Some("cursor-2"), &CancelToken::default())
        .unwrap();
    assert_eq!(second.thread_ids, vec!["t3"]);
    assert_eq!(second.next_page_token, None);

    let requests = api.requests();
    assert!(requests[0].contains("labelIds=INBOX"));
    assert!(requests[1].contains("pageToken=cursor-2"));
}

#[test]
fn stars_include_unsupported_bodies_and_preserve_missing_label_unknowns() {
    let payload = || {
        text_payload(
            "text/html",
            &[("From", "s@example.test")],
            Some(b"<b>not rendered</b>"),
        )
    };
    let known_star = gmail_message("star", &["STARRED"], payload());
    let known_false = gmail_message("false", &[], payload());
    let mut unknown = gmail_message("unknown", &[], payload());
    unknown.as_object_mut().unwrap().remove("labelIds");
    let body = thread_response("t", "h", vec![known_star, known_false, unknown]);
    let thread = parse_thread("a", "t", &body).unwrap();
    let facts = thread.star_facts.unwrap();
    assert_eq!(facts.get("star"), Some(&true));
    assert_eq!(facts.get("false"), Some(&false));
    assert!(!facts.contains_key("unknown"));
    assert!(thread.conversation.messages.is_empty());
    assert_eq!(thread.message_ids.unwrap().len(), 3);
}

#[test]
fn search_pages_are_paced_bounded_and_not_inbox_filtered() {
    let (base, api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/threads",
        200,
        r#"{"threads":[{"id":"old"}],"nextPageToken":"older"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let page = provider
        .search_threads(Some("previous"), &CancelToken::default())
        .unwrap();
    assert_eq!(page.thread_ids, vec!["old"]);
    assert_eq!(page.next_page_token.as_deref(), Some("older"));
    let requests = api.requests();
    assert!(requests[0].contains("maxResults=20"));
    assert!(requests[0].contains("includeSpamTrash=false"));
    assert!(requests[0].contains("pageToken=previous"));
    assert!(!requests[0].contains("labelIds=INBOX"));
}

#[test]
fn attachment_get_validates_handle_separately_from_message_id() {
    use crate::attachments::MAX_ATTACHMENT_ID_BYTES;
    let handles: Vec<_> = [257, 404, MAX_ATTACHMENT_ID_BYTES]
        .into_iter()
        .map(|len| "aB0_-".repeat(len.div_ceil(5))[..len].to_string())
        .collect();
    let message_id = "m".repeat(256);
    let paths: Vec<_> = handles
        .iter()
        .map(|id| format!("/gmail/v1/users/me/messages/{message_id}/attachments/{id}"))
        .collect();
    let (base, api) = FakeApi::start(
        paths
            .iter()
            .map(|path| (path.as_str(), 200, r#"{"size":9,"data":"JVBERi0xLjcK"}"#))
            .collect(),
    );
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    for handle in &handles {
        assert_eq!(
            provider
                .fetch_attachment(
                    "synthetic@example.test",
                    &message_id,
                    handle,
                    &CancelToken::default()
                )
                .unwrap(),
            b"%PDF-1.7\n"
        );
    }
    for handle in [
        "",
        ".",
        "..",
        "../a",
        "a/b",
        "a\\b",
        "%2e%2e",
        "a?x",
        "a#x",
        "a:b",
        "a@b",
        "a=b",
        "a+b",
        "a b",
        "a\0",
        "a\r\n",
        "a\u{7f}",
        "é",
        "Ａ",
        &"a".repeat(MAX_ATTACHMENT_ID_BYTES + 1),
    ] {
        assert_eq!(
            provider.fetch_attachment(
                "synthetic@example.test",
                "m1",
                handle,
                &CancelToken::default()
            ),
            Err(crate::attachments::invalid("attachmentId"))
        );
    }
    assert_eq!(
        provider.fetch_attachment(
            "synthetic@example.test",
            &"m".repeat(257),
            &handles[1],
            &CancelToken::default()
        ),
        Err(crate::attachments::invalid("attachmentId"))
    );
    assert_eq!(
        api.requests(),
        paths,
        "invalid IDs must not issue any HTTP request"
    );
    assert!(api
        .state
        .request_heads
        .lock()
        .unwrap()
        .iter()
        .all(|head| head.starts_with("GET ")));
}

#[test]
fn long_attachment_handle_survives_full_thread_cache_reopen_and_authenticated_get() {
    use crate::attachments::{save_download, test_directory, AttachmentDescriptor};
    use crate::clock::SystemClock;
    use crate::gmail::store::{GmailStore, ThreadFetch};

    // Synthetic base64url-shaped handle, matching the 404-byte production
    // example's length, not copied from any real mailbox.
    let handle = format!("ANGjdJ{}", "aB0_-Zx9".repeat(50));
    let handle = &handle[..404];
    let account = "synthetic@example.test";
    let message_id = "18e0abc123def456";
    let thread_id = "18e0abc123def450";
    let bytes = b"%PDF-1.7\n";
    let body = thread_response(
        thread_id,
        "99",
        vec![gmail_message(
            message_id,
            &["INBOX", "UNREAD"],
            json!({
                "mimeType": "multipart/mixed",
                "headers": payload_headers(&[("From", "sender@example.test"), ("Subject", "Synthetic file")]),
                "parts": [
                    text_payload("text/plain", &[], Some(b"A synthetic attachment.")),
                    {"mimeType":"application/pdf", "filename":"report.pdf",
                     "body":{"size":bytes.len(),"attachmentId":handle}}
                ]
            }),
        )],
    );
    let thread_path = format!("/gmail/v1/users/me/threads/{thread_id}");
    let attachment_path = format!("/gmail/v1/users/me/messages/{message_id}/attachments/{handle}");
    let (base, api) = FakeApi::start(vec![
        (&thread_path, 200, &body),
        (&attachment_path, 200, r#"{"size":9,"data":"JVBERi0xLjcK"}"#),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let token = future_token();
    secrets.store(&token).unwrap();
    let provider = test_provider(&base, secrets.clone());
    assert!(!provider.mutation_access().unwrap());
    let thread = provider
        .get_thread(thread_id, &CancelToken::default())
        .unwrap()
        .unwrap();
    let expected = AttachmentDescriptor {
        message_id: message_id.into(),
        attachment_id: handle.into(),
        filename: "report.pdf".into(),
        mime_type: "application/pdf".into(),
        size: 9,
    };
    assert_eq!(thread.attachments, vec![expected.clone()]);
    let target = thread.conversation.conversation_ref.clone();
    let profile = test_directory();
    let store = GmailStore::open(profile.path(), Arc::new(SystemClock)).unwrap();
    store
        .begin_account(
            &GmailProfile {
                account_id: account.into(),
                email_address: account.into(),
                history_id: "99".into(),
            },
            0,
        )
        .unwrap();
    store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(thread))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let before = store.get_conversation(&target).unwrap();
    let snapshot = store.list_snapshot().unwrap();
    let generation = store.generation().unwrap();
    assert_eq!(before.is_read, Some(false));
    assert_eq!(store.claimable_operation_count().unwrap(), 0);
    drop(store);

    let store = GmailStore::open(profile.path(), Arc::new(SystemClock)).unwrap();
    assert!(store
        .list_attachments(&crate::dto::ConversationRef {
            account_id: "foreign".into(),
            ..target.clone()
        })
        .is_err());
    let descriptors = store.list_attachments(&target).unwrap();
    assert_eq!(descriptors, vec![expected]);
    let descriptor = &descriptors[0];
    assert_eq!(descriptor.attachment_id.len(), 404);
    assert_eq!(
        provider.fetch_attachment(
            "foreign",
            &descriptor.message_id,
            &descriptor.attachment_id,
            &CancelToken::default()
        ),
        Err(MailError::AuthRequired)
    );
    let fetched = provider
        .fetch_attachment(
            &target.account_id,
            &descriptor.message_id,
            &descriptor.attachment_id,
            &CancelToken::default(),
        )
        .unwrap();
    assert_eq!(fetched, bytes);
    let downloads = test_directory();
    let saved = save_download(
        downloads.path(),
        descriptor,
        &fetched,
        &CancelToken::default(),
    )
    .unwrap();
    assert!(saved.filename.ends_with(".pdf.download"));
    assert_eq!(
        std::fs::read(downloads.path().join(saved.filename)).unwrap(),
        bytes
    );
    assert_eq!(std::fs::read_dir(downloads.path()).unwrap().count(), 1);
    assert_eq!(store.get_conversation(&target).unwrap(), before);
    assert_eq!(store.list_snapshot().unwrap(), snapshot);
    assert_eq!(store.generation().unwrap(), generation);
    assert_eq!(store.claimable_operation_count().unwrap(), 0);
    assert_eq!(secrets.load().unwrap(), Some(token));
    assert_eq!(
        api.requests(),
        vec![format!("{thread_path}?format=full"), attachment_path]
    );
    assert_eq!(
        api.authorization_headers(),
        vec![Some("Bearer synthetic-access".into()); 2]
    );
    assert_eq!(api.bodies(), vec!["", ""]);
    let authority = url::Url::parse(&base).unwrap().authority().to_string();
    for head in api.state.request_heads.lock().unwrap().iter() {
        assert!(head.starts_with("GET "));
        assert!(head
            .lines()
            .any(|line| line.eq_ignore_ascii_case(&format!("host: {authority}"))));
    }
    assert!(api.state.script.lock().unwrap().is_empty());
}

#[test]
fn attachment_fetch_is_authenticated_bounded_readonly_and_cancellable() {
    let body = r#"{"size":9,"data":"JVBERi0xLjcK"}"#;
    let (base, api) = FakeApi::start(vec![
        ("/gmail/v1/users/me/messages/m1/attachments/a1", 200, body),
        (
            "/gmail/v1/users/me/messages/m1/attachments/missing",
            404,
            "",
        ),
        (
            "/gmail/v1/users/me/messages/m1/attachments/corrupt",
            200,
            r#"{"size":9,"data":"!"}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    assert_eq!(
        provider.fetch_attachment("foreign", "m1", "a1", &CancelToken::default()),
        Err(MailError::AuthRequired)
    );
    assert_eq!(
        provider
            .fetch_attachment(
                "synthetic@example.test",
                "m1",
                "a1",
                &CancelToken::default()
            )
            .unwrap(),
        b"%PDF-1.7\n"
    );
    assert_eq!(
        provider.fetch_attachment(
            "synthetic@example.test",
            "m1",
            "missing",
            &CancelToken::default()
        ),
        Err(MailError::NotFound)
    );
    assert!(provider
        .fetch_attachment(
            "synthetic@example.test",
            "m1",
            "corrupt",
            &CancelToken::default()
        )
        .is_err());
    let cancel = CancelToken::default();
    cancel.cancel();
    assert_eq!(
        provider.fetch_attachment("synthetic@example.test", "m1", "a1", &cancel),
        Err(MailError::AuthCancelled)
    );
    assert!(provider
        .fetch_attachment(
            "synthetic@example.test",
            "../m1",
            "a1",
            &CancelToken::default()
        )
        .is_err());
    assert_eq!(api.requests().len(), 3);
    assert!(api
        .state
        .authorization_headers
        .lock()
        .unwrap()
        .iter()
        .all(|h| h.as_deref() == Some("Bearer synthetic-access")));
}

#[test]
fn get_thread_parses_plain_text_and_discloses_unsupported() {
    let headers = [
        ("From", "Sender Name <sender@example.test>"),
        ("To", "rcpt@example.test"),
        ("Subject", "Hello world"),
        ("Date", "Mon, 13 Oct 2025 10:00:00 +0000"),
        ("Content-Type", "text/plain; charset=utf-8"),
    ];
    let plain = gmail_message(
        "m1",
        &["INBOX"],
        text_payload(
            "text/plain",
            &headers,
            Some(b"Line one.\r\nHostile <b>markup</b> is literal data."),
        ),
    );
    let html_only = gmail_message(
        "m2",
        &["INBOX", "UNREAD"],
        text_payload(
            "text/html",
            &[("From", "h@example.test"), ("Subject", "html only")],
            Some(b"<html><body>no plain text here</body></html>"),
        ),
    );
    let body = thread_response("t1", "99", vec![plain, html_only]);
    let (base, api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t1", 200, &body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);

    let thread = provider
        .get_thread("t1", &CancelToken::default())
        .unwrap()
        .expect("thread exists");
    assert_eq!(thread.history_id, "99");
    assert_eq!(thread.inbox_message_ids, vec!["m1", "m2"]);
    assert_eq!(
        thread.message_ids.as_ref().unwrap(),
        &vec!["m1".to_string(), "m2".to_string()]
    );
    assert_eq!(
        thread.unread_message_ids.as_ref().unwrap(),
        &vec!["m2".to_string()]
    );
    let conversation = &thread.conversation;
    assert_eq!(conversation.conversation_ref.conversation_id, "t1");
    assert_eq!(
        conversation.conversation_ref.account_id,
        "synthetic@example.test"
    );
    assert!(conversation.is_in_inbox);
    assert_eq!(conversation.is_read, Some(false));
    assert_eq!(conversation.messages.len(), 1);
    let message = &conversation.messages[0];
    assert_eq!(message.id, "m1");
    assert_eq!(message.from.display_name.as_deref(), Some("Sender Name"));
    assert_eq!(message.from.mailbox, "sender@example.test");
    assert_eq!(
        message
            .to
            .iter()
            .map(|a| a.mailbox.as_str())
            .collect::<Vec<_>>(),
        vec!["rcpt@example.test"]
    );
    assert_eq!(message.sent_at, "2025-10-13T10:00:00Z");
    assert!(message
        .body_text
        .contains("Hostile <b>markup</b> is literal data."));
    // Hostile markup stays literal data, never rendered or stripped.
    assert!(!message.body_text.contains('\u{0}'));
    assert_eq!(
        conversation.context_complete,
        Some(false),
        "the html-only message discloses incompleteness"
    );
    assert_eq!(
        conversation.unsupported_reason.as_deref(),
        Some("1 of 2 messages had no safe plain-text body")
    );
    assert!(api.requests().iter().any(|r| r.contains("format=full")));
}

#[test]
fn get_thread_maps_deleted_threads_to_none() {
    let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t-gone", 404, "{}")]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    assert!(provider
        .get_thread("t-gone", &CancelToken::default())
        .unwrap()
        .is_none());
    assert!(_api.requests()[0].contains("format=full"));
}

#[test]
fn history_maps_added_deleted_and_label_changes() {
    let body = r#"{
            "historyId": "200",
            "nextPageToken": "next-cursor",
            "history": [
                {"messagesAdded":[{"message":{"id":"m5","threadId":"t9","labelIds":["INBOX"]}}]},
                {"messagesDeleted":[{"message":{"id":"m2","threadId":"t1","labelIds":["INBOX"]}}]},
                {"labelsAdded":[{"message":{"id":"m6","threadId":"t2","labelIds":["INBOX"]},"labelIds":["INBOX"]}]},
                {"labelsRemoved":[{"message":{"id":"m3","threadId":"t1","labelIds":["INBOX"]},"labelIds":["INBOX"]}]},
                {"labelsRemoved":[{"message":{"id":"m7","threadId":"t4","labelIds":["IMPORTANT"]},"labelIds":["IMPORTANT"]}]}
            ]
        }"#;
    let (base, api) = FakeApi::start(vec![("/gmail/v1/users/me/history", 200, body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);

    let page = provider
        .history("150", None, &CancelToken::default())
        .unwrap();
    assert_eq!(page.history_id, "200");
    assert_eq!(page.changed_thread_ids, vec!["t9", "t1", "t2", "t4"]);
    // Only m2 was actually deleted. INBOX label removals trigger current
    // thread reconciliation and must not delete restored messages.
    assert_eq!(page.deleted_message_ids, vec!["m2"]);
    assert_eq!(page.next_page_token.as_deref(), Some("next-cursor"));
    let request = &api.requests()[0];
    assert!(request.contains("startHistoryId=150"));
}

#[test]
fn history_cursor_expiry_maps_to_expired() {
    let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/history", 404, "{}")]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    assert!(matches!(
        provider.history("150", None, &CancelToken::default()),
        Err(GmailHistoryError::Expired)
    ));
}

#[test]
fn http_errors_map_to_typed_failures() {
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let (base, _api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/threads",
        429,
        r#"{"error":{"code":429,"message":"Rate limit exceeded"}}"#,
    )]);
    let provider = test_provider(&base, secrets);
    assert!(matches!(
        provider.list_inbox(None, &CancelToken::default()),
        Err(MailError::RateLimited)
    ));

    let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads", 200, "not json at all")]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    assert!(matches!(
        provider.list_inbox(None, &CancelToken::default()),
        Err(MailError::InvalidProviderResponse)
    ));
}

#[test]
fn paced_setter_rejects_a_replacement_for_a_different_account() {
    let (api_base, api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let original = TokenBundle {
        gmail_modify_granted: true,
        ..future_token()
    };
    secrets.store(&original).unwrap();
    let mut provider = test_provider(&api_base, secrets);
    provider.min_request_interval = Duration::from_millis(100);
    let seeded = Instant::now();
    *provider.last_request_slot.lock().unwrap() = Some(seeded);
    let provider = Arc::new(provider);

    let (setter_tx, setter_rx) = std::sync::mpsc::channel();
    let setter_provider = Arc::clone(&provider);
    std::thread::spawn(move || {
        let result = setter_provider.apply_archive(
            &["paced-message".to_string()],
            true,
            &CancelToken::default(),
        );
        let _ = setter_tx.send(result);
    });
    assert!(
        until_provider_slot(&provider, seeded),
        "setter did not reserve its pace slot"
    );

    let replacement = TokenBundle {
        account_id: Some("other@example.test".to_string()),
        email: Some("other@example.test".to_string()),
        ..original
    };
    let mut publication = provider.credential_publication.lock().unwrap();
    provider
        .publish_bundle_locked(
            &mut publication,
            &replacement,
            CredentialPublicationKind::AccountChange,
        )
        .unwrap();
    drop(publication);

    assert_eq!(
        setter_rx.recv_timeout(Duration::from_secs(2)).unwrap(),
        Err(MailError::AuthFailed)
    );
    assert!(
        api.requests().is_empty(),
        "account change must not dispatch"
    );
}

#[test]
fn mailbox_setters_post_only_exact_snapshot_ids_and_closed_label_changes() {
    let (base, api) = FakeApi::start(vec![
        ("/gmail/v1/users/me/messages/batchModify", 200, ""),
        ("/gmail/v1/users/me/messages/batchModify", 200, ""),
        ("/gmail/v1/users/me/messages/batchModify", 200, ""),
        ("/gmail/v1/users/me/messages/batchModify", 200, ""),
        ("/gmail/v1/users/me/messages/batchModify", 200, ""),
        ("/gmail/v1/users/me/messages/batchModify", 200, ""),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let granted = TokenBundle {
        gmail_modify_granted: true,
        ..future_token()
    };
    secrets.store(&granted).unwrap();
    let mut provider = test_provider(&base, secrets);
    provider.min_request_interval = Duration::from_millis(30);
    let ids = vec![
        "unsupported-message".to_string(),
        "snapshot-message-2".to_string(),
    ];
    let started = Instant::now();

    provider
        .apply_archive(&ids, true, &CancelToken::default())
        .unwrap();
    provider
        .apply_archive(&ids, false, &CancelToken::default())
        .unwrap();
    provider
        .apply_read(&ids, true, &CancelToken::default())
        .unwrap();
    provider
        .apply_read(&ids, false, &CancelToken::default())
        .unwrap();

    provider
        .apply_star(&ids, true, &CancelToken::default())
        .unwrap();
    provider
        .apply_star(&ids, false, &CancelToken::default())
        .unwrap();
    let bodies: Vec<Value> = api
        .bodies()
        .iter()
        .map(|body| serde_json::from_str(body).unwrap())
        .collect();
    assert_eq!(bodies.len(), 6);
    for body in &bodies {
        assert_eq!(body["ids"], json!(ids));
    }
    assert_eq!(bodies[0], json!({"ids": ids, "removeLabelIds": ["INBOX"]}));
    assert_eq!(bodies[1], json!({"ids": ids, "addLabelIds": ["INBOX"]}));
    assert_eq!(bodies[2], json!({"ids": ids, "removeLabelIds": ["UNREAD"]}));
    assert_eq!(bodies[3], json!({"ids": ids, "addLabelIds": ["UNREAD"]}));
    assert_eq!(bodies[4], json!({"ids": ids, "addLabelIds": ["STARRED"]}));
    assert_eq!(
        bodies[5],
        json!({"ids": ids, "removeLabelIds": ["STARRED"]})
    );
    assert!(api
        .requests()
        .iter()
        .all(|path| { path == "/gmail/v1/users/me/messages/batchModify" }));
    assert!(
        started.elapsed() >= Duration::from_millis(75),
        "authorized archive/read setters honor production pacing: {:?}",
        started.elapsed()
    );
}

#[test]
fn setter_rejects_empty_duplicate_and_oversized_target_sets_without_dispatch() {
    let (base, api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            gmail_modify_granted: true,
            ..future_token()
        })
        .unwrap();
    let provider = test_provider(&base, secrets);
    let cancel = CancelToken::default();
    for ids in [
        Vec::new(),
        vec![String::new()],
        vec!["duplicate".to_string(), "duplicate".to_string()],
        (0..=MAX_BATCH_MODIFY_MESSAGE_IDS)
            .map(|index| format!("m{index}"))
            .collect(),
    ] {
        assert!(matches!(
            provider.apply_read(&ids, true, &cancel),
            Err(MailError::InvalidRequest { .. })
        ));
    }
    assert!(api.requests().is_empty());
}

#[test]
fn setter_distinguishes_quota_permission_rejection_and_unknown_outcome() {
    let run = |status, body: &'static str| {
        let (base, _api) = FakeApi::start(vec![(
            "/gmail/v1/users/me/messages/batchModify",
            status,
            body,
        )]);
        let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
        secrets
            .store(&TokenBundle {
                gmail_modify_granted: true,
                ..future_token()
            })
            .unwrap();
        let provider = test_provider(&base, secrets);
        provider.apply_archive(&["snapshot-id".to_string()], true, &CancelToken::default())
    };
    assert_eq!(
        run(
            403,
            r#"{"error":{"errors":[{"reason":"userRateLimitExceeded"}]}}"#
        ),
        Err(MailError::RateLimited)
    );
    assert_eq!(
        run(
            403,
            r#"{"error":{"errors":[{"reason":"insufficientPermissions"}],"status":"PERMISSION_DENIED"}}"#
        ),
        Err(MailError::PermissionRequired)
    );
    assert_eq!(
        run(403, r#"{"error":{"errors":[{"reason":"domainPolicy"}]}}"#),
        Err(MailError::ProviderRejected)
    );
    assert_eq!(
        run(503, "synthetic internal text"),
        Err(MailError::OutcomeUnknown)
    );
    assert_eq!(run(302, ""), Err(MailError::ProviderRejected));
}

#[test]
fn setter_does_not_follow_redirects_and_cancelled_pre_dispatch_is_definite() {
    let (base, api) = FakeApi::start(vec![
        ("/gmail/v1/users/me/messages/batchModify", 302, ""),
        ("/redirect-target", 200, ""),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            gmail_modify_granted: true,
            ..future_token()
        })
        .unwrap();
    let provider = test_provider(&base, secrets);
    assert_eq!(
        provider.apply_archive(&["snapshot-id".to_string()], true, &CancelToken::default()),
        Err(MailError::ProviderRejected)
    );
    assert_eq!(
        api.requests().len(),
        1,
        "redirect target must not be requested"
    );

    let (base, api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            gmail_modify_granted: true,
            ..future_token()
        })
        .unwrap();
    let provider = test_provider(&base, secrets);
    let cancel = CancelToken::default();
    cancel.cancel();
    assert_eq!(
        provider.apply_archive(&["snapshot-id".to_string()], true, &cancel),
        Err(MailError::AuthCancelled)
    );
    assert!(api.requests().is_empty());

    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets
        .store(&TokenBundle {
            gmail_modify_granted: true,
            ..future_token()
        })
        .unwrap();
    let unavailable = test_provider("http://127.0.0.1:9", secrets);
    assert_eq!(
        unavailable.apply_archive(&["snapshot-id".to_string()], true, &CancelToken::default()),
        Err(MailError::NetworkUnavailable)
    );
}

#[test]
fn discovery_list_requests_a_bounded_smaller_page() {
    let (base, api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/threads",
        200,
        r#"{"threads":[{"id":"t1"}]}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);

    provider
        .list_inbox(None, &CancelToken::default())
        .expect("list inbox");
    let request = &api.requests()[0];
    assert!(request.contains("labelIds=INBOX"));
    // Discovery pages are smaller than the history page bound so a
    // rate-limited page loses less checked work; the overall cap lives
    // in the sync lane.
    assert!(request.contains(&format!("maxResults={DISCOVERY_PAGE_RESULTS}")));
    assert!(!request.contains("maxResults=100"));
}

#[test]
fn forbidden_quota_reasons_map_to_rate_limited_and_permissions_do_not() {
    let script_and_assert = |body: &str, expected: MailError| {
        let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads", 403, body)]);
        let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
        secrets.store(&future_token()).unwrap();
        let provider = test_provider(&base, secrets);
        match provider.list_inbox(None, &CancelToken::default()) {
            Err(error) => assert_eq!(error, expected, "classification for body {body}"),
            Ok(_) => panic!("expected a typed error for body {body}"),
        }
    };

    // Genuine quota rejection: structured reason maps to rate_limited.
    script_and_assert(
        r#"{"error":{"code":403,"message":"synthetic quota text","errors":[{"domain":"usageLimits","reason":"rateLimitExceeded"}],"status":"PERMISSION_DENIED"}}"#,
        MailError::RateLimited,
    );
    script_and_assert(
        r#"{"error":{"code":403,"errors":[{"reason":"userRateLimitExceeded"}]}}"#,
        MailError::RateLimited,
    );
    script_and_assert(
        r#"{"error":{"code":403,"errors":[{"reason":"dailyLimitExceeded"}]}}"#,
        MailError::RateLimited,
    );
    script_and_assert(
        r#"{"error":{"code":403,"status":"RESOURCE_EXHAUSTED"}}"#,
        MailError::RateLimited,
    );

    // Unrelated 403s are NOT mislabeled as rate limited.
    script_and_assert(
        r#"{"error":{"code":403,"errors":[{"reason":"insufficientPermissions"}],"status":"PERMISSION_DENIED"}}"#,
        MailError::ProviderUnavailable,
    );
    script_and_assert(
        r#"{"error":{"code":403,"errors":[{"reason":"domainPolicy"}]}}"#,
        MailError::ProviderUnavailable,
    );
    // Unstructured body: cannot classify, stays generic.
    script_and_assert("not json at all", MailError::ProviderUnavailable);
}

#[test]
fn read_requests_are_paced_without_long_real_sleeps() {
    let (base, _api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[{"id":"t1"}],"nextPageToken":"c2"}"#,
        ),
        (
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[{"id":"t2"}]}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let mut provider = test_provider(&base, secrets);
    provider.min_request_interval = Duration::from_millis(30);

    let start = Instant::now();
    provider
        .list_inbox(None, &CancelToken::default())
        .expect("first page");
    provider
        .list_inbox(Some("c2"), &CancelToken::default())
        .expect("second page");
    let elapsed = start.elapsed();
    assert!(
        elapsed >= Duration::from_millis(30),
        "consecutive reads are paced: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "pacing stays bounded in tests: {elapsed:?}"
    );
}

#[test]
fn overdue_slots_rebase_to_now_instead_of_granting_burst_credit() {
    let (base, _api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[{"id":"t1"}]}"#,
        ),
        (
            "/gmail/v1/users/me/threads",
            200,
            r#"{"threads":[{"id":"t2"}]}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let mut provider = test_provider(&base, secrets);
    provider.min_request_interval = Duration::from_millis(150);
    // Simulate an idle/backoff gap: the reserved slot is far overdue.
    // Both reads must be paced from now (rebased), not run immediately
    // against the stale slot.
    let previous = Instant::now()
        .checked_sub(Duration::from_secs(3600))
        .expect("monotonic clock covers the simulated gap");
    *provider.last_request_slot.lock().unwrap() = Some(previous);

    let start = Instant::now();
    provider
        .list_inbox(None, &CancelToken::default())
        .expect("first read after the gap");
    provider
        .list_inbox(None, &CancelToken::default())
        .expect("second read after the gap");
    let elapsed = start.elapsed();
    // Rebased pacing reserves `now` for the first read and paces the
    // second a full interval after it; burst credit from the overdue
    // slot would let both through in well under one interval.
    assert!(
        elapsed >= Duration::from_millis(150),
        "overdue slot must not grant burst credit: {elapsed:?}"
    );
    assert!(
        elapsed < Duration::from_secs(2),
        "pacing stays bounded in tests: {elapsed:?}"
    );
}

#[test]
fn pacing_waits_abort_promptly_on_cancellation() {
    let (base, api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let mut provider = test_provider(&base, secrets);
    // A large pacing interval must not become a long real sleep.
    provider.min_request_interval = Duration::from_secs(3600);
    // Seed a previous slot so the request reserves a slot one hour out
    // and genuinely waits inside `pace()` when cancelled.
    let seeded = Instant::now();
    *provider.last_request_slot.lock().unwrap() = Some(seeded);
    let cancel = CancelToken::default();
    let provider = Arc::new(provider);

    let (done_tx, done_rx) = std::sync::mpsc::channel();
    let spawn_cancel = cancel.clone();
    let spawn_provider = Arc::clone(&provider);
    std::thread::spawn(move || {
        let _ = done_tx.send(spawn_provider.list_inbox(None, &spawn_cancel));
    });
    // Synchronize on the reservation: `pace()` stored a slot one hour
    // out before entering its wait loop.
    let reserved = until_provider_slot(&provider, seeded);
    assert!(reserved, "paced request never reserved its slot");
    cancel.cancel();

    let start = Instant::now();
    let result = done_rx
        .recv_timeout(Duration::from_secs(2))
        .expect("cancelled pacing wait returns promptly even on regression");
    assert!(matches!(result, Err(MailError::AuthCancelled)));
    assert!(
        start.elapsed() < Duration::from_secs(2),
        "cancelled pacing wait returns promptly: {:?}",
        start.elapsed()
    );
    assert!(api.requests().is_empty());
}

/// Bounded wait for the spawned request to reserve its pace slot (a slot
/// later than the seeded one); false if it never happens.
fn until_provider_slot(provider: &GmailProvider, seeded: Instant) -> bool {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let reserved = *provider.last_request_slot.lock().unwrap() > Some(seeded);
        if reserved || Instant::now() >= deadline {
            return reserved;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn api_does_not_follow_redirects() {
    let (base, api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/threads",
        302,
        r#"{"redirect":"must not be followed"}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);

    assert!(matches!(
        provider.list_inbox(None, &CancelToken::default()),
        Err(MailError::ProviderUnavailable)
    ));
    assert_eq!(api.requests().len(), 1);
}

#[test]
fn disconnect_clears_local_credentials() {
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider("http://127.0.0.1:9", secrets.clone());
    assert!(provider.has_credentials().unwrap());
    provider.disconnect().unwrap();
    assert!(!provider.has_credentials().unwrap());
    assert_eq!(secrets.load().unwrap(), None);
}

#[test]
fn mime_with_quoted_printable_and_rfc2047_headers_decode() {
    let payload = text_payload(
        "text/plain",
        &[
            ("From", "=?utf-8?B?SsO2cmc=?= <joerg@example.test>"),
            (
                "Subject",
                "=?utf-8?Q?Caf=C3=A9_?= =?utf-8?Q?gr=C3=BC=C3=9Fe?=",
            ),
            ("Date", "Tue, 14 Oct 2025 09:30:00 +0000"),
            ("Content-Type", "text/plain; charset=iso-8859-1"),
            ("Content-Transfer-Encoding", "quoted-printable"),
        ],
        // Gmail body.data contains the MIME-decoded octets wrapped in
        // base64url; the retained quoted-printable header is descriptive.
        Some(b"Gr\xfc\xdfe aus K\xf6ln; literal =FC remains"),
    );
    let body = thread_response("t-q", "5", vec![gmail_message("mq", &["INBOX"], payload)]);
    let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t-q", 200, &body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let thread = provider
        .get_thread("t-q", &CancelToken::default())
        .unwrap()
        .unwrap();
    assert_eq!(thread.conversation.subject, "Café grüße");
    let message = &thread.conversation.messages[0];
    assert_eq!(message.from.mailbox, "joerg@example.test");
    assert_eq!(message.from.display_name.as_deref(), Some("Jörg"));
    assert_eq!(message.body_text, "Grüße aus Köln; literal =FC remains");
    assert_eq!(thread.conversation.context_complete, Some(true));
    assert_eq!(thread.conversation.unsupported_reason, None);
}

#[test]
fn multipart_prefers_text_plain_and_skips_attachments() {
    let root_headers = [
        ("From", "m@example.test"),
        ("Subject", "multipart"),
        ("Date", "Wed, 15 Oct 2025 08:00:00 +0000"),
        ("Content-Type", "multipart/alternative"),
    ];
    let mut attachment = text_payload(
        "text/plain",
        &[
            ("Content-Type", "text/plain; name=evil.txt"),
            ("Content-Disposition", "attachment; filename=evil.txt"),
        ],
        Some(b"Attachment contents must never be loaded."),
    );
    attachment["filename"] = json!("evil.txt");
    attachment["body"]["attachmentId"] = json!("synthetic-attachment-id");
    let payload = json!({
        "mimeType": "multipart/alternative",
        "headers": payload_headers(&root_headers),
        "parts": [
            text_payload(
                "text/html",
                &[("Content-Type", "text/html; charset=utf-8")],
                Some(b"<p>html body</p>"),
            ),
            text_payload(
                "text/plain",
                &[("Content-Type", "text/plain; charset=utf-8")],
                Some(b"Plain body wins."),
            ),
            attachment,
        ],
    });
    let body = thread_response("t-m", "6", vec![gmail_message("mm", &["INBOX"], payload)]);
    let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t-m", 200, &body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let thread = provider
        .get_thread("t-m", &CancelToken::default())
        .unwrap()
        .unwrap();
    assert_eq!(
        thread.conversation.messages[0].body_text,
        "Plain body wins."
    );
    assert_eq!(thread.conversation.context_complete, Some(false));
    assert_eq!(
        thread.conversation.unsupported_reason.as_deref(),
        Some("attachments present are not displayed")
    );
}

#[test]
fn unsupported_inbox_membership_survives_provider_to_store() {
    use crate::clock::SystemClock;
    use crate::gmail::store::{GmailStore, ThreadFetch};
    use crate::gmail::types::GmailProfile;

    let unsupported = |id: &str, subject: &str| {
        gmail_message(
            id,
            &["INBOX"],
            text_payload(
                "text/html",
                &[("From", "sender@example.test"), ("Subject", subject)],
                Some(b"<p>HTML only</p>"),
            ),
        )
    };
    let only = parse_thread(
        "synthetic@example.test",
        "t-only-unsupported",
        &thread_response(
            "t-only-unsupported",
            "11",
            vec![unsupported("m-only", "Only HTML")],
        ),
    )
    .unwrap();
    let mixed_supported = gmail_message(
        "m-archived-plain",
        &[],
        text_payload(
            "text/plain",
            &[
                ("From", "sender@example.test"),
                ("Subject", "Mixed subject"),
                ("Content-Type", "text/plain; charset=utf-8"),
            ],
            Some(b"Cached plain context"),
        ),
    );
    let mixed = parse_thread(
        "synthetic@example.test",
        "t-mixed",
        &thread_response(
            "t-mixed",
            "11",
            vec![
                mixed_supported,
                unsupported("m-inbox-html", "Mixed subject"),
            ],
        ),
    )
    .unwrap();
    let profile = tempfile::tempdir().unwrap();
    let store = GmailStore::open(profile.path(), Arc::new(SystemClock)).unwrap();
    store
        .begin_account(
            &GmailProfile {
                account_id: "synthetic@example.test".to_string(),
                email_address: "synthetic@example.test".to_string(),
                history_id: "11".to_string(),
            },
            0,
        )
        .unwrap();
    store
        .apply_discovery_page(
            &[
                ThreadFetch::Cached(Box::new(only)),
                ThreadFetch::Cached(Box::new(mixed)),
            ],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    let snapshot = store.list_snapshot().unwrap();
    assert_eq!(snapshot.conversations.len(), 2);
    assert!(snapshot
        .conversations
        .iter()
        .any(|summary| summary.subject == "Only HTML"));
    assert!(snapshot
        .conversations
        .iter()
        .any(|summary| summary.subject == "Mixed subject"));
    let only = store
        .get_conversation(&crate::dto::ConversationRef {
            account_id: "synthetic@example.test".to_string(),
            conversation_id: "t-only-unsupported".to_string(),
        })
        .unwrap();
    assert!(only.messages.is_empty());
    assert_eq!(only.context_complete, Some(false));
    assert!(only.unsupported_reason.is_some());
    let mixed = store
        .get_conversation(&crate::dto::ConversationRef {
            account_id: "synthetic@example.test".to_string(),
            conversation_id: "t-mixed".to_string(),
        })
        .unwrap();
    assert_eq!(mixed.messages.len(), 1);
    assert_eq!(mixed.messages[0].body_text, "Cached plain context");
    assert_eq!(mixed.context_complete, Some(false));
}

#[test]
fn archive_restore_history_uses_current_thread_facts_without_deleting_message() {
    use crate::clock::SystemClock;
    use crate::gmail::store::{GmailStore, ThreadFetch};
    use crate::gmail::types::GmailProfile;

    let headers = [
        ("From", "sender@example.test"),
        ("Subject", "restored thread"),
        ("Content-Type", "text/plain; charset=utf-8"),
    ];
    let current = parse_thread(
        "synthetic@example.test",
        "t-restore",
        &thread_response(
            "t-restore",
            "12",
            vec![gmail_message(
                "m-restore",
                &["INBOX"],
                text_payload("text/plain", &headers, Some(b"restored body")),
            )],
        ),
    )
    .unwrap();
    let history = parse_history(
            r#"{"historyId":"12","history":[
                {"labelsRemoved":[{"message":{"id":"m-restore","threadId":"t-restore"},"labelIds":["INBOX"]}]},
                {"labelsAdded":[{"message":{"id":"m-restore","threadId":"t-restore"},"labelIds":["INBOX"]}]}
            ]}"#,
        )
        .unwrap();
    assert_eq!(history.changed_thread_ids, vec!["t-restore"]);
    assert!(history.deleted_message_ids.is_empty());

    let profile_dir = tempfile::tempdir().unwrap();
    let store = GmailStore::open(profile_dir.path(), Arc::new(SystemClock)).unwrap();
    store
        .begin_account(
            &GmailProfile {
                account_id: "synthetic@example.test".to_string(),
                email_address: "synthetic@example.test".to_string(),
                history_id: "11".to_string(),
            },
            0,
        )
        .unwrap();
    let previous = current.clone();
    store
        .apply_discovery_page(
            &[ThreadFetch::Cached(Box::new(previous))],
            None,
            true,
            false,
            0,
        )
        .unwrap();
    store
        .apply_history_page(&history, &[ThreadFetch::Cached(Box::new(current))], "11", 0)
        .unwrap();
    let snapshot = store.list_snapshot().unwrap();
    assert_eq!(snapshot.conversations.len(), 1);
    let cached = store
        .get_conversation(&crate::dto::ConversationRef {
            account_id: "synthetic@example.test".to_string(),
            conversation_id: "t-restore".to_string(),
        })
        .unwrap();
    assert!(cached.is_in_inbox);
    assert_eq!(cached.messages[0].body_text, "restored body");
}

#[test]
fn provider_json_must_be_an_object_and_empty_inbox_object_is_valid() {
    for body in ["null", "[]", "42", "\"unexpected\""] {
        assert!(matches!(
            parse_json(body),
            Err(MailError::InvalidProviderResponse)
        ));
    }
    assert!(parse_json(r#"{"resultSizeEstimate":0}"#).is_ok());

    let (base, _api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/threads",
        200,
        r#"{"resultSizeEstimate":0}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let page = provider.list_inbox(None, &CancelToken::default()).unwrap();
    assert!(page.thread_ids.is_empty());
    assert!(page.next_page_token.is_none());
}

#[test]
fn malformed_present_provider_arrays_are_rejected() {
    assert!(matches!(
        parse_history(r#"{"historyId":"200","history":"malformed"}"#),
        Err(MailError::InvalidProviderResponse)
    ));
    assert!(matches!(
        parse_history(r#"{"historyId":"200","history":[{"messagesAdded":"bad"}]}"#),
        Err(MailError::InvalidProviderResponse)
    ));
    assert!(matches!(
        parse_history(r#"{"historyId":"200","nextPageToken":7,"history":[]}"#),
        Err(MailError::InvalidProviderResponse)
    ));
    for body in [
        r#"{"threads":"bad"}"#,
        r#"{"threads":[],"nextPageToken":7}"#,
    ] {
        let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads", 200, body)]);
        let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
        secrets.store(&future_token()).unwrap();
        let provider = test_provider(&base, secrets);
        assert!(matches!(
            provider.list_inbox(None, &CancelToken::default()),
            Err(MailError::InvalidProviderResponse)
        ));
    }
}

#[test]
fn oversized_and_malformed_payloads_disclose_unsupported_without_panicking() {
    let root_headers = [
        ("From", "a@example.test"),
        ("Subject", "safe text"),
        ("Content-Type", "text/plain; charset=utf-8"),
    ];
    let good = text_payload("text/plain", &root_headers, Some(b"fine"));
    let oversized_bytes = vec![b'x'; MAX_PART_BODY_BYTES + 1];
    let oversized = text_payload("text/plain", &root_headers, Some(&oversized_bytes));
    let malformed_data = json!({
        "mimeType": "text/plain",
        "headers": payload_headers(&root_headers),
        "body": {"data": "%%%"},
    });
    let missing_data = text_payload("text/plain", &root_headers, None);
    let body = thread_response(
        "t-x",
        "8",
        vec![
            gmail_message("x1", &["INBOX"], good),
            gmail_message("x2", &["INBOX"], oversized),
            gmail_message("x3", &["INBOX"], malformed_data),
            gmail_message("x4", &["INBOX"], missing_data),
        ],
    );
    let (base, _api) = FakeApi::start(vec![("/gmail/v1/users/me/threads/t-x", 200, &body)]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let provider = test_provider(&base, secrets);
    let thread = provider
        .get_thread("t-x", &CancelToken::default())
        .unwrap()
        .unwrap();
    assert_eq!(thread.conversation.messages.len(), 1);
    assert_eq!(thread.conversation.messages[0].body_text, "fine");
    assert_eq!(thread.conversation.context_complete, Some(false));
    assert_eq!(
        thread.conversation.unsupported_reason.as_deref(),
        Some("3 of 4 messages had no safe plain-text body")
    );
}

/// Loopback OAuth token endpoint that pauses refresh responses while still
/// accepting a concurrent interactive OAuth exchange.
struct PausedRefreshEndpoint {
    base: String,
    refresh_received: Arc<std::sync::Barrier>,
    release_refresh: Arc<std::sync::Barrier>,
    server: std::thread::JoinHandle<()>,
}

impl PausedRefreshEndpoint {
    fn start(requests: usize) -> Self {
        Self::start_with_oauth_response(
            requests,
            r#"{"access_token":"upgrade-access","refresh_token":"upgrade-refresh","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.modify"}"#,
        )
    }

    fn start_with_oauth_response(requests: usize, oauth_response: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let refresh_received = Arc::new(std::sync::Barrier::new(2));
        let release_refresh = Arc::new(std::sync::Barrier::new(2));
        let server_received = Arc::clone(&refresh_received);
        let server_release = Arc::clone(&release_refresh);
        let server = std::thread::spawn(move || {
            let mut workers = Vec::with_capacity(requests);
            for _ in 0..requests {
                let (stream, _) = listener.accept().unwrap();
                let received = Arc::clone(&server_received);
                let release = Arc::clone(&server_release);
                workers.push(std::thread::spawn(move || {
                        let mut stream = stream;
                        let request = read_loopback_request(&mut stream);
                        let body = request
                            .split_once("\r\n\r\n")
                            .map(|(_, body)| body)
                            .unwrap_or("");
                        let (status, response) = if body.contains("grant_type=refresh_token") {
                            received.wait();
                            release.wait();
                            (
                                200,
                                r#"{"access_token":"readonly-refresh-access","refresh_token":"readonly-refresh-replacement","expires_in":3600}"#,
                            )
                        } else {
                            (200, oauth_response)
                        };
                        let wire = format!(
                            "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                            response.len()
                        );
                        stream.write_all(wire.as_bytes()).unwrap();
                        stream.flush().unwrap();
                    }));
            }
            for worker in workers {
                worker.join().unwrap();
            }
        });
        Self {
            base,
            refresh_received,
            release_refresh,
            server,
        }
    }

    fn wait_until_refresh_paused(&self) {
        self.refresh_received.wait();
    }

    fn release_refresh(&self) {
        self.release_refresh.wait();
    }

    fn join(self) {
        self.server.join().unwrap();
    }
}

fn read_loopback_request(stream: &mut std::net::TcpStream) -> String {
    stream
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    let mut bytes = Vec::new();
    loop {
        let header_end = bytes.windows(4).position(|window| window == b"\r\n\r\n");
        if let Some(header_end) = header_end {
            let headers = String::from_utf8_lossy(&bytes[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    let (name, value) = line.split_once(':')?;
                    name.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            if bytes.len() >= header_end + 4 + content_length {
                break;
            }
        }
        let mut chunk = [0u8; 2048];
        let read = stream.read(&mut chunk).unwrap();
        if read == 0 {
            break;
        }
        bytes.extend_from_slice(&chunk[..read]);
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

fn expired_bundle() -> TokenBundle {
    TokenBundle {
        expires_at_epoch_ms: now_ms() - 1_000,
        ..future_token()
    }
}

#[test]
fn credential_publication_old_refresh_cannot_overwrite_verified_upgrade() {
    let endpoint = PausedRefreshEndpoint::start(2);
    let (api_base, _api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"1"}"#,
        ),
        (
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"2"}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&expired_bundle()).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{}/synthetic-token", endpoint.base);
    provider.opener = completing_oauth_opener(Arc::new(Mutex::new(None)));
    let provider = Arc::new(provider);

    let refresh_provider = Arc::clone(&provider);
    let old_refresh = std::thread::spawn(move || refresh_provider.profile(&CancelToken::default()));
    endpoint.wait_until_refresh_paused();

    provider.enable_mutations(&CancelToken::default()).unwrap();
    endpoint.release_refresh();
    assert!(old_refresh.join().unwrap().is_ok());
    endpoint.join();

    let stored = secrets.load().unwrap().unwrap();
    assert!(
        stored.access_token == "upgrade-access",
        "upgrade access survives stale refresh"
    );
    assert!(
        stored.refresh_token.as_deref() == Some("upgrade-refresh"),
        "upgrade refresh credential survives stale refresh"
    );
    assert!(
        stored.gmail_modify_granted,
        "verified modify grant survives stale refresh"
    );
    assert!(provider.mutation_access().unwrap());
}

#[test]
fn credential_publication_connect_rebases_after_refresh_and_applies_readonly_scope() {
    let endpoint = PausedRefreshEndpoint::start_with_oauth_response(
        2,
        r#"{"access_token":"reauth-access","refresh_token":"reauth-refresh","expires_in":3600,"scope":"https://www.googleapis.com/auth/gmail.readonly"}"#,
    );
    let (api_base, _api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"1"}"#,
        ),
        (
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"2"}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    let mut previous = expired_bundle();
    previous.gmail_modify_granted = true;
    secrets.store(&previous).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{}/synthetic-token", endpoint.base);
    let oauth_entered = Arc::new(std::sync::Barrier::new(2));
    let release_oauth = Arc::new(std::sync::Barrier::new(2));
    let entered_opener = Arc::clone(&oauth_entered);
    let release_opener = Arc::clone(&release_oauth);
    let finish_oauth = completing_oauth_opener(Arc::new(Mutex::new(None)));
    provider.opener = Arc::new(move |url| {
        entered_opener.wait();
        release_opener.wait();
        finish_oauth(url)
    });
    let provider = Arc::new(provider);

    let reauth_provider = Arc::clone(&provider);
    let reauth = std::thread::spawn(move || reauth_provider.connect(&CancelToken::default()));
    oauth_entered.wait();

    let refresh_provider = Arc::clone(&provider);
    let refresh = std::thread::spawn(move || refresh_provider.profile(&CancelToken::default()));
    endpoint.wait_until_refresh_paused();
    endpoint.release_refresh();
    assert!(refresh.join().unwrap().is_ok());
    let refreshed = secrets.load().unwrap().unwrap();
    assert!(
        refreshed.access_token == "readonly-refresh-access",
        "ordinary refresh published while reauth was awaiting OAuth"
    );

    release_oauth.wait();
    assert!(reauth.join().unwrap().is_ok());
    endpoint.join();

    let stored = secrets.load().unwrap().unwrap();
    assert!(
        stored.access_token == "reauth-access",
        "reauth access token is published"
    );
    assert!(
        stored.refresh_token.as_deref() == Some("reauth-refresh"),
        "reauth refresh token replaces the refresh-only snapshot"
    );
    assert!(
        !stored.gmail_modify_granted,
        "present readonly reauth scope revokes modify grant"
    );
    assert!(!provider.mutation_access().unwrap());
}

#[test]
fn credential_publication_connect_rejects_superseded_same_account_oauth() {
    let (api_base, _api) = FakeApi::start(vec![
        (
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"1"}"#,
        ),
        (
            "/gmail/v1/users/me/profile",
            200,
            r#"{"emailAddress":"synthetic@example.test","historyId":"2"}"#,
        ),
    ]);
    let (token_base, _token) = FakeApi::start(vec![
        (
            "/synthetic-token",
            200,
            r#"{"access_token":"newer-access","refresh_token":"newer-refresh","expires_in":3600}"#,
        ),
        (
            "/synthetic-token",
            200,
            r#"{"access_token":"stale-access","refresh_token":"stale-refresh","expires_in":3600}"#,
        ),
    ]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    let oauth_entered = Arc::new(std::sync::Barrier::new(2));
    let release_oauth = Arc::new(std::sync::Barrier::new(2));
    let opener_calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let entered_opener = Arc::clone(&oauth_entered);
    let release_opener = Arc::clone(&release_oauth);
    let opener_calls_for_callback = Arc::clone(&opener_calls);
    let finish_oauth = completing_oauth_opener(Arc::new(Mutex::new(None)));
    provider.opener = Arc::new(move |url| {
        if opener_calls_for_callback.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
            entered_opener.wait();
            release_opener.wait();
        }
        finish_oauth(url)
    });
    let provider = Arc::new(provider);

    let stale_provider = Arc::clone(&provider);
    let stale_reauth = std::thread::spawn(move || stale_provider.connect(&CancelToken::default()));
    oauth_entered.wait();

    assert!(provider.connect(&CancelToken::default()).is_ok());
    release_oauth.wait();
    assert!(matches!(stale_reauth.join().unwrap(), Err(MailError::Busy)));

    let stored = secrets.load().unwrap().unwrap();
    assert!(
        stored.access_token == "newer-access",
        "newer same-account reauth remains published"
    );
    assert!(
        stored.refresh_token.as_deref() == Some("newer-refresh"),
        "stale OAuth cannot replace the newer refresh credential"
    );
}

#[test]
fn credential_publication_connect_cannot_resurrect_after_disconnect() {
    let (api_base, _api) = FakeApi::start(vec![(
        "/gmail/v1/users/me/profile",
        200,
        r#"{"emailAddress":"synthetic@example.test","historyId":"1"}"#,
    )]);
    let (token_base, _token) = FakeApi::start(vec![(
        "/synthetic-token",
        200,
        r#"{"access_token":"reauth-access","refresh_token":"reauth-refresh","expires_in":3600}"#,
    )]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&future_token()).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{token_base}/synthetic-token");
    let oauth_entered = Arc::new(std::sync::Barrier::new(2));
    let release_oauth = Arc::new(std::sync::Barrier::new(2));
    let entered_opener = Arc::clone(&oauth_entered);
    let release_opener = Arc::clone(&release_oauth);
    let finish_oauth = completing_oauth_opener(Arc::new(Mutex::new(None)));
    provider.opener = Arc::new(move |url| {
        entered_opener.wait();
        release_opener.wait();
        finish_oauth(url)
    });
    let provider = Arc::new(provider);

    let reauth_provider = Arc::clone(&provider);
    let reauth = std::thread::spawn(move || reauth_provider.connect(&CancelToken::default()));
    oauth_entered.wait();
    provider.disconnect().unwrap();
    release_oauth.wait();

    assert!(matches!(
        reauth.join().unwrap(),
        Err(MailError::AuthRequired)
    ));
    assert!(secrets.load().unwrap().is_none());
}

#[test]
fn credential_publication_stale_refresh_does_not_resurrect_disconnected_credentials() {
    let endpoint = PausedRefreshEndpoint::start(1);
    let (api_base, _api) = FakeApi::start(vec![]);
    let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
    secrets.store(&expired_bundle()).unwrap();
    let mut provider = test_provider(&api_base, secrets.clone());
    provider.endpoints.token = format!("{}/synthetic-token", endpoint.base);
    let provider = Arc::new(provider);

    let refresh_provider = Arc::clone(&provider);
    let old_refresh = std::thread::spawn(move || refresh_provider.profile(&CancelToken::default()));
    endpoint.wait_until_refresh_paused();

    provider.disconnect().unwrap();
    endpoint.release_refresh();
    assert!(matches!(
        old_refresh.join().unwrap(),
        Err(MailError::AuthRequired)
    ));
    endpoint.join();
    assert!(secrets.load().unwrap().is_none());
}
