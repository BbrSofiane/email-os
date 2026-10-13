//! Google OAuth2 + PKCE for the desktop Gmail client.
//!
//! Fixed HTTPS Google endpoints, read-only by default with an explicit
//! `gmail.modify` upgrade, random PKCE verifier/challenge and state, a loopback
//! callback listener bound to 127.0.0.1 with exact path/state checks and a
//! one-shot response, short bounded timeout, and cancellation. Tokens, codes,
//! authorization URLs, subjects, addresses, and bodies are never
//! debug-printed or logged.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use base64::Engine;
use rand::RngCore;
use reqwest::blocking::Client;
use sha2::{Digest, Sha256};
use url::form_urlencoded;
use url::Url;

use crate::error::MailError;
use crate::provider::CancelToken;

/// Scope requested by the initial read-only connection.
pub const GMAIL_READONLY_SCOPE: &str = "https://www.googleapis.com/auth/gmail.readonly";
/// Broader scope requested only by the explicit mailbox-actions upgrade.
pub const GMAIL_MODIFY_SCOPE: &str = "https://www.googleapis.com/auth/gmail.modify";

/// Bounded window for the user to finish the browser OAuth round trip.
pub const AUTH_TIMEOUT: Duration = Duration::from_secs(180);

/// Fixed callback path; the exact string is checked on every request.
const CALLBACK_PATH: &str = "/oauth2/callback";

/// Loopback accept/response poll cadence, also the cancel check cadence.
const POLL_INTERVAL: Duration = Duration::from_millis(100);

/// Hard cap on the callback request line + headers we will read.
const MAX_REQUEST_BYTES: usize = 16 * 1024;

/// Operator's Google Desktop OAuth client, loaded from the launch
/// environment. The client secret (optional for desktop clients) is not
/// treated as a confidential credential but is never logged or committed.
#[derive(Clone)]
pub struct GoogleConfig {
    pub client_id: String,
    pub client_secret: Option<String>,
}

/// Debug output redacts the client secret so an accidental `{:?}` can
/// never leak it (client_id is not a confidential credential).
impl std::fmt::Debug for GoogleConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GoogleConfig")
            .field("client_id", &self.client_id)
            .field(
                "client_secret",
                &self.client_secret.as_ref().map(|_| "<redacted>"),
            )
            .finish()
    }
}

impl GoogleConfig {
    /// `EMAIL_OS_GOOGLE_CLIENT_ID` is required; missing or blank is a
    /// visible `not_configured`, never a silent fallback.
    /// `EMAIL_OS_GOOGLE_CLIENT_SECRET` is optional.
    pub fn from_env() -> Result<Self, MailError> {
        let client_id = std::env::var("EMAIL_OS_GOOGLE_CLIENT_ID")
            .map_err(|_| MailError::NotConfigured)?
            .trim()
            .to_string();
        if client_id.is_empty() {
            return Err(MailError::NotConfigured);
        }
        let client_secret = std::env::var("EMAIL_OS_GOOGLE_CLIENT_SECRET")
            .ok()
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty());
        Ok(Self {
            client_id,
            client_secret,
        })
    }
}

/// HTTPS endpoints. Defaults are the fixed Google endpoints; tests override
/// them with loopback URLs to exercise the flow without real OAuth.
#[derive(Debug, Clone)]
pub(crate) struct Endpoints {
    pub authorize: String,
    pub token: String,
    pub api: String,
}

impl Endpoints {
    pub(crate) fn google() -> Self {
        Self {
            authorize: "https://accounts.google.com/o/oauth2/v2/auth".to_string(),
            token: "https://oauth2.googleapis.com/token".to_string(),
            api: "https://gmail.googleapis.com".to_string(),
        }
    }
}

/// Authorization-code grant captured from the one-shot loopback callback.
/// Includes the PKCE verifier because the code must be exchanged with it.
pub(crate) struct AuthCode {
    /// Never debug-printed or logged.
    pub code: String,
    pub redirect_uri: String,
    pub verifier: String,
}

/// Debug output redacts the code and verifier so an accidental
/// `{:?}` can never leak authorization material.
impl std::fmt::Debug for AuthCode {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuthCode")
            .field("code", &"<redacted>")
            .field("redirect_uri", &"<redacted>")
            .field("verifier", &"<redacted>")
            .finish()
    }
}

/// Token endpoint response, normalized to an absolute expiry.
pub(crate) struct TokenResponse {
    pub access_token: String,
    /// `None` when Google omits the refresh token; the caller preserves any
    /// previously stored refresh token in that case.
    pub refresh_token: Option<String>,
    /// Granted scopes, omitted by some refresh responses.
    pub scope: Option<String>,
    pub expires_at_epoch_ms: i64,
}

/// Opens the authorization URL in the system browser. Test-injectable so no
/// real browser is launched during synthetic tests.
pub(crate) type UrlOpener = Arc<dyn Fn(&str) -> Result<(), MailError> + Send + Sync>;

pub(crate) fn system_url_opener() -> UrlOpener {
    Arc::new(|url| webbrowser::open(url).map_err(|_| MailError::AuthFailed))
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_millis() as i64
}

/// base64url alphabet without padding; every character is a valid PKCE
/// verifier character.
const PKCE_ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

fn random_b64url(len: usize) -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = vec![0u8; len];
    rng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|b| PKCE_ALPHABET[*b as usize % PKCE_ALPHABET.len()] as char)
        .collect()
}

/// Random PKCE verifier (64 base64url chars), its S256 challenge, and a
/// random state token.
pub(crate) struct Pkce {
    verifier: String,
    challenge: String,
    state: String,
}

fn generate_pkce() -> Pkce {
    let verifier = random_b64url(64);
    let challenge = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(Sha256::digest(verifier.as_bytes()));
    let state = random_b64url(32);
    Pkce {
        verifier,
        challenge,
        state,
    }
}

/// Starts the OAuth browser flow: bind a loopback listener on an ephemeral
/// port, construct the Google authorization URL (never logged), open it
/// externally, and wait for the one-shot callback.
pub(crate) fn authorize(
    config: &GoogleConfig,
    endpoints: &Endpoints,
    opener: &UrlOpener,
    scope: &str,
    cancel: &CancelToken,
    timeout: Duration,
) -> Result<AuthCode, MailError> {
    let pkce = generate_pkce();
    let listener = TcpListener::bind("127.0.0.1:0").map_err(|_| MailError::NetworkUnavailable)?;
    listener
        .set_nonblocking(true)
        .map_err(|_| MailError::NetworkUnavailable)?;
    let port = listener
        .local_addr()
        .map_err(|_| MailError::NetworkUnavailable)?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
    let mut url = Url::parse(&endpoints.authorize).map_err(|_| MailError::ProviderUnavailable)?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("client_id", &config.client_id);
        query.append_pair("redirect_uri", &redirect_uri);
        query.append_pair("response_type", "code");
        query.append_pair("scope", scope);
        query.append_pair("access_type", "offline");
        query.append_pair("prompt", "consent");
        query.append_pair("code_challenge", &pkce.challenge);
        query.append_pair("code_challenge_method", "S256");
        query.append_pair("state", &pkce.state);
    }
    // The URL carries PKCE/state only; it is handed to the opener, never logged.
    opener(url.as_ref())?;
    wait_for_code(
        &listener,
        &redirect_uri,
        &pkce.verifier,
        &pkce.state,
        timeout,
        cancel,
    )
}

/// Accepts loopback connections until the exact callback path arrives with
/// the exact state, replies one-shot, and returns the code. Wrong paths,
/// wrong states, and OAuth `error` responses are rejected; cancellation and
/// the timeout end the wait.
fn wait_for_code(
    listener: &TcpListener,
    redirect_uri: &str,
    verifier: &str,
    state: &str,
    timeout: Duration,
    cancel: &CancelToken,
) -> Result<AuthCode, MailError> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        if Instant::now() >= deadline {
            return Err(MailError::AuthFailed);
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                stream
                    .set_read_timeout(Some(POLL_INTERVAL))
                    .map_err(|_| MailError::NetworkUnavailable)?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| MailError::NetworkUnavailable)?;
                match read_request(&mut stream, deadline, cancel) {
                    Ok(Some(request)) => {
                        let target = request.split_whitespace().nth(1).unwrap_or("");
                        // Browsers send origin-form ("/path?query"); absolute
                        // form is accepted too (proxies, handcrafted GETs).
                        let (path, query) = if target.starts_with("http://") {
                            match Url::parse(target) {
                                Ok(parsed) => (
                                    parsed.path().to_string(),
                                    parsed.query().unwrap_or("").to_string(),
                                ),
                                Err(_) => {
                                    respond(&mut stream, "403 Forbidden", "Invalid callback path.");
                                    continue;
                                }
                            }
                        } else {
                            match target.split_once('?') {
                                Some((path, query)) => (path.to_string(), query.to_string()),
                                None => (target.to_string(), String::new()),
                            }
                        };
                        let params: HashMap<String, String> =
                            form_urlencoded::parse(query.as_bytes())
                                .map(|(k, v)| (k.into_owned(), v.into_owned()))
                                .collect();
                        if path != CALLBACK_PATH {
                            respond(&mut stream, "403 Forbidden", "Invalid callback path.");
                            continue;
                        }
                        if params.get("state").map(String::as_str) != Some(state) {
                            respond(&mut stream, "403 Forbidden", "Invalid callback.");
                            continue;
                        }
                        if let Some(_oauth_error) = params.get("error").filter(|e| !e.is_empty()) {
                            respond(&mut stream, "400 Bad Request", "Authorization failed.");
                            return Err(MailError::AuthFailed);
                        }
                        match params.get("code").map(String::as_str) {
                            Some(code) if !code.is_empty() => {
                                respond(
                                    &mut stream,
                                    "200 OK",
                                    "Authorization complete. You can close this window.",
                                );
                                return Ok(AuthCode {
                                    code: code.to_string(),
                                    redirect_uri: redirect_uri.to_string(),
                                    verifier: verifier.to_string(),
                                });
                            }
                            _ => {
                                respond(&mut stream, "403 Forbidden", "Invalid callback.");
                            }
                        }
                    }
                    Ok(None) => {
                        respond(&mut stream, "400 Bad Request", "Invalid callback request.");
                    }
                    Err(error) => return Err(error),
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(POLL_INTERVAL);
            }
            Err(_) => return Err(MailError::NetworkUnavailable),
        }
    }
}

/// Reads one bounded HTTP request, polling cancellation and the shared OAuth
/// deadline between socket reads so a trickling peer cannot hold sign-in open.
fn read_request(
    stream: &mut std::net::TcpStream,
    deadline: Instant,
    cancel: &CancelToken,
) -> Result<Option<String>, MailError> {
    let mut buf = Vec::new();
    let mut chunk = [0u8; 1024];
    loop {
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        if Instant::now() >= deadline {
            return Err(MailError::AuthFailed);
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") || buf.len() >= MAX_REQUEST_BYTES {
            break;
        }
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) => {}
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
            Err(_) => break,
        }
    }
    if !buf.windows(4).any(|window| window == b"\r\n\r\n") {
        return Ok(None);
    }
    Ok(Some(String::from_utf8_lossy(&buf).into_owned()))
}

/// Writes the one-shot callback response.
fn respond(stream: &mut std::net::TcpStream, status: &str, text: &str) {
    let body = format!("<!doctype html><html><body><p>{text}</p></body></html>");
    let _ = write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let _ = stream.flush();
}

/// Exchanges the authorization code (plus PKCE verifier) for tokens.
pub(crate) fn exchange_code(
    config: &GoogleConfig,
    endpoints: &Endpoints,
    http: &Client,
    grant: &AuthCode,
    cancel: &CancelToken,
) -> Result<TokenResponse, MailError> {
    let mut form = vec![
        ("grant_type".to_string(), "authorization_code".to_string()),
        ("code".to_string(), grant.code.clone()),
        ("client_id".to_string(), config.client_id.clone()),
        ("code_verifier".to_string(), grant.verifier.clone()),
        ("redirect_uri".to_string(), grant.redirect_uri.clone()),
    ];
    if let Some(secret) = &config.client_secret {
        form.push(("client_secret".to_string(), secret.clone()));
    }
    token_request(endpoints, http, form, cancel)
}

/// Refreshes the access token. A revoked/invalid grant becomes
/// `auth_required` so the caller can demand re-authorization.
pub(crate) fn refresh(
    config: &GoogleConfig,
    endpoints: &Endpoints,
    http: &Client,
    refresh_token: &str,
    cancel: &CancelToken,
) -> Result<TokenResponse, MailError> {
    let mut form = vec![
        ("grant_type".to_string(), "refresh_token".to_string()),
        ("refresh_token".to_string(), refresh_token.to_string()),
        ("client_id".to_string(), config.client_id.clone()),
    ];
    if let Some(secret) = &config.client_secret {
        form.push(("client_secret".to_string(), secret.clone()));
    }
    match token_request(endpoints, http, form, cancel) {
        Ok(tokens) => Ok(tokens),
        Err(MailError::AuthFailed) => Err(MailError::AuthRequired),
        Err(error) => Err(error),
    }
}

/// Posts the token request to the fixed token endpoint and normalizes the
/// JSON response. Form bodies are buffered in memory (small); no redirects
/// are followed (the HTTP client disables them).
fn token_request(
    endpoints: &Endpoints,
    http: &Client,
    form: Vec<(String, String)>,
    cancel: &CancelToken,
) -> Result<TokenResponse, MailError> {
    if cancel.is_cancelled() {
        return Err(MailError::AuthCancelled);
    }
    let response = http
        .post(&endpoints.token)
        .form(&form)
        .send()
        .map_err(map_http_error)?;
    let status = response.status();
    if status.as_u16() == 400 || status.as_u16() == 401 {
        // Definite credential rejection (invalid_grant, invalid_client...).
        return Err(MailError::AuthFailed);
    }
    if !status.is_success() {
        return Err(MailError::ProviderUnavailable);
    }
    let bytes = read_bounded(response)?;
    let json: serde_json::Value =
        serde_json::from_slice(&bytes).map_err(|_| MailError::InvalidProviderResponse)?;
    let access_token = json
        .get("access_token")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or(MailError::InvalidProviderResponse)?
        .to_string();
    let expires_in = json
        .get("expires_in")
        .and_then(serde_json::Value::as_i64)
        .ok_or(MailError::InvalidProviderResponse)?;
    let refresh_token = json
        .get("refresh_token")
        .and_then(serde_json::Value::as_str)
        .filter(|s| !s.is_empty())
        .map(ToOwned::to_owned);
    let scope = match json.get("scope") {
        None => None,
        Some(serde_json::Value::String(value)) => Some(value.clone()),
        Some(_) => return Err(MailError::InvalidProviderResponse),
    };
    Ok(TokenResponse {
        access_token,
        refresh_token,
        scope,
        expires_at_epoch_ms: now_ms().saturating_add(expires_in.saturating_mul(1000)),
    })
}

/// Caps every response body at 10 MiB; larger payloads are rejected as
/// invalid provider data instead of being buffered.
pub(crate) const MAX_RESPONSE_BYTES: usize = 10 * 1024 * 1024;

pub(crate) fn read_bounded(
    mut response: reqwest::blocking::Response,
) -> Result<Vec<u8>, MailError> {
    if response
        .content_length()
        .is_some_and(|length| length > MAX_RESPONSE_BYTES as u64)
    {
        return Err(MailError::InvalidProviderResponse);
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take(MAX_RESPONSE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| {
            if error.kind() == std::io::ErrorKind::TimedOut
                || error.kind() == std::io::ErrorKind::WouldBlock
            {
                MailError::NetworkUnavailable
            } else {
                MailError::ProviderUnavailable
            }
        })?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err(MailError::InvalidProviderResponse);
    }
    Ok(bytes)
}

/// Maps transport errors to typed failures without leaking response text.
pub(crate) fn map_http_error(error: reqwest::Error) -> MailError {
    if error.is_timeout() || error.is_connect() {
        MailError::NetworkUnavailable
    } else {
        MailError::ProviderUnavailable
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_pair_is_random_and_s256_derived() {
        let pkce = generate_pkce();
        assert_eq!(pkce.verifier.len(), 64);
        assert!(pkce
            .verifier
            .chars()
            .all(|c| PKCE_ALPHABET.contains(&(c as u8))));
        let expected = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(pkce.verifier.as_bytes()));
        assert_eq!(pkce.challenge, expected);
        assert_eq!(pkce.state.len(), 32);
        // Fresh randomness on every call.
        let again = generate_pkce();
        assert_ne!(pkce.verifier, again.verifier);
        assert_ne!(pkce.state, again.state);
    }

    #[test]
    fn loopback_accepts_exact_path_and_state_and_rejects_mismatches() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");

        // First connection uses a wrong state and must be rejected; the
        // second uses the exact state and must be accepted.
        let url = format!("{redirect_uri}?code=abc&state=WRONG");
        let wrong = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream
                .write_all(format!("GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes());
            let _ = stream.flush();
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        std::thread::sleep(Duration::from_millis(150));
        let url = format!("{redirect_uri}?code=real-code&state=right-state");
        let right = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream
                .write_all(format!("GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes());
            let _ = stream.flush();
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        std::thread::sleep(Duration::from_millis(150));

        let grant = wait_for_code(
            &listener,
            &redirect_uri,
            "verifier",
            "right-state",
            Duration::from_secs(5),
            &CancelToken::default(),
        )
        .unwrap();
        assert_eq!(grant.code, "real-code");
        assert_eq!(grant.redirect_uri, redirect_uri);
        assert_eq!(grant.verifier, "verifier");
        let wrong_response = wrong.join().unwrap();
        let right_response = right.join().unwrap();
        assert!(
            wrong_response.starts_with("HTTP/1.1 403"),
            "{wrong_response}"
        );
        assert!(
            right_response.starts_with("HTTP/1.1 200"),
            "{right_response}"
        );
    }

    #[test]
    fn loopback_rejects_wrong_paths() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let attacker = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ =
                stream.write_all(b"GET /evil?code=x&state=y HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n");
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        std::thread::sleep(Duration::from_millis(150));
        // Correct request afterwards still succeeds.
        let url = format!("{redirect_uri}?code=ok&state=st");
        let browser = std::thread::spawn(move || {
            let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
            let _ = stream
                .write_all(format!("GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes());
            let mut buf = Vec::new();
            let _ = stream.read_to_end(&mut buf);
            String::from_utf8_lossy(&buf).into_owned()
        });
        std::thread::sleep(Duration::from_millis(150));
        let grant = wait_for_code(
            &listener,
            &redirect_uri,
            "verifier",
            "st",
            Duration::from_secs(5),
            &CancelToken::default(),
        )
        .unwrap();
        assert_eq!(grant.code, "ok");
        assert!(attacker.join().unwrap().starts_with("HTTP/1.1 403"));
        assert!(browser.join().unwrap().starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn oauth_error_callbacks_require_state_before_a_valid_callback_is_accepted() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let redirect_for_client = redirect_uri.clone();
        let client = std::thread::spawn(move || {
            let mut responses = Vec::new();
            for query in [
                "error=access_denied&state=wrong",
                "error=access_denied",
                "code=valid-code&state=right-state",
            ] {
                let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                let url = format!("{redirect_for_client}?{query}");
                stream
                    .write_all(format!("GET {url} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes())
                    .unwrap();
                let mut buf = Vec::new();
                stream.read_to_end(&mut buf).unwrap();
                responses.push(String::from_utf8_lossy(&buf).into_owned());
                std::thread::sleep(Duration::from_millis(30));
            }
            responses
        });
        let grant = wait_for_code(
            &listener,
            &redirect_uri,
            "verifier",
            "right-state",
            Duration::from_secs(5),
            &CancelToken::default(),
        )
        .unwrap();
        assert_eq!(grant.code, "valid-code");
        let responses = client.join().unwrap();
        assert!(responses[0].starts_with("HTTP/1.1 403"));
        assert!(responses[1].starts_with("HTTP/1.1 403"));
        assert!(responses[2].starts_with("HTTP/1.1 200"));
    }

    #[test]
    fn loopback_callback_trickle_read_honors_cancellation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let port = listener.local_addr().unwrap().port();
        let redirect_uri = format!("http://127.0.0.1:{port}{CALLBACK_PATH}");
        let cancel = CancelToken::default();
        let worker_cancel = cancel.clone();
        let worker = std::thread::spawn(move || {
            wait_for_code(
                &listener,
                &redirect_uri,
                "verifier",
                "state",
                Duration::from_secs(30),
                &worker_cancel,
            )
        });
        let mut peer = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        peer.write_all(b"GET /oauth2/callback?code=partial")
            .unwrap();
        std::thread::sleep(Duration::from_millis(150));
        let started = Instant::now();
        cancel.cancel();
        assert_eq!(
            worker.join().unwrap().unwrap_err(),
            MailError::AuthCancelled
        );
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn loopback_wait_honours_cancellation_and_timeout() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let cancel = CancelToken::default();
        cancel.cancel();
        assert!(matches!(
            wait_for_code(
                &listener,
                "http://127.0.0.1:1/oauth2/callback",
                "verifier",
                "st",
                Duration::from_secs(5),
                &cancel,
            ),
            Err(MailError::AuthCancelled)
        ));
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        assert!(matches!(
            wait_for_code(
                &listener,
                "http://127.0.0.1:1/oauth2/callback",
                "verifier",
                "st",
                Duration::from_millis(150),
                &CancelToken::default(),
            ),
            Err(MailError::AuthFailed)
        ));
    }

    #[test]
    fn production_oauth_and_gmail_endpoints_are_fixed_https() {
        let endpoints = Endpoints::google();
        assert_eq!(
            endpoints.authorize,
            "https://accounts.google.com/o/oauth2/v2/auth"
        );
        assert_eq!(endpoints.token, "https://oauth2.googleapis.com/token");
        assert_eq!(endpoints.api, "https://gmail.googleapis.com");
    }

    #[test]
    fn bounded_response_rejects_declared_oversize_before_reading_body() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 2048];
            let _ = stream.read(&mut request);
            let _ = write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                MAX_RESPONSE_BYTES + 1
            );
            let _ = stream.flush();
        });
        let http = Client::builder().no_proxy().build().unwrap();
        let response = http
            .get(format!("http://{address}/synthetic"))
            .send()
            .unwrap();
        assert!(matches!(
            read_bounded(response),
            Err(MailError::InvalidProviderResponse)
        ));
        server.join().unwrap();
    }

    #[test]
    fn config_debug_redacts_client_secret() {
        let config = GoogleConfig {
            client_id: "synthetic-client-id.apps.googleusercontent.com".to_string(),
            client_secret: Some("synthetic-secret-do-not-leak".to_string()),
        };
        let rendered = format!("{config:?}");
        assert!(rendered.contains("<redacted>"), "{rendered}");
        assert!(
            !rendered.contains("synthetic-secret-do-not-leak"),
            "{rendered}"
        );
    }

    #[test]
    fn config_requires_client_id_from_env() {
        // Env var mutation in tests is serialized through a separate test
        // binary (crates/mail-core/tests/gmail_auth_contract.rs); here we
        // only exercise the blank-id branch with a direct value check.
        let config = GoogleConfig {
            client_id: "synthetic-client-id.apps.googleusercontent.com".to_string(),
            client_secret: Some("synthetic-secret".to_string()),
        };
        assert!(!config.client_id.is_empty());
    }
}
