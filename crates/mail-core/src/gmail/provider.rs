//! Read-only Gmail provider: the synchronous [`GmailReadProvider`] backing
//! the Slice 02 cache/sync lane.
//!
//! Fixed HTTPS Google endpoints (tests override with loopback URLs), no
//! redirects, bounded response sizes, typed errors only (no raw HTTP/token
//! provider text crosses the boundary). Threads use the official
//! `threads.get?format=full` shape: Gmail payload trees are walked to the
//! first literal `text/plain` part (bounded recursion), MIME-parsed with
//! `mailparse` and strictly decoded through its declared charset; HTML,
//! attachments, and remote resources are never used and are disclosed via
//! `unsupported_reason`.
//! Access-token refresh is serialized and preserves the stored refresh token
//! when Google omits it.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use base64::Engine;
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde_json::Value;

use crate::dto::{Address, Conversation, ConversationRef, Message};
use crate::error::MailError;
use crate::gmail::auth::{self, Endpoints, GoogleConfig, UrlOpener};
use crate::gmail::secrets::{Secrets, TokenBundle};
use crate::gmail::types::{
    GmailHistoryError, GmailProfile, GmailReadProvider, GmailThread, HistoryPage, InboxPage,
};
use crate::provider::CancelToken;

/// Bound on one decoded MIME part body we will parse; larger bodies are
/// disclosed as unsupported instead of being parsed.
const MAX_PART_BODY_BYTES: usize = 1024 * 1024;

/// Bound on one decoded text body, in characters.
const MAX_MESSAGE_TEXT_CHARS: usize = 256 * 1024;

/// Recursion bound on Gmail payload trees (hostile/deep structures).
const MAX_PAYLOAD_DEPTH: usize = 10;

/// Bound on pages requested per list/history call.
const MAX_PAGE_RESULTS: usize = 100;

/// Discovery (`threads.list`) page size. Smaller pages bound the thread reads
/// that share one checkpointed page commit, so a rate limit interrupts far
/// fewer fetched threads; the overall 100-conversation cap lives in the sync
/// lane (`DISCOVERY_CAP`) and is unchanged.
const DISCOVERY_PAGE_RESULTS: usize = 25;

/// Safe pacing floor between consecutive Gmail API reads (read-only per-user
/// quota). The first request runs immediately; every later request waits a
/// cancellation-aware interval since the previous one was issued.
const MIN_REQUEST_INTERVAL: Duration = Duration::from_millis(100);

/// Poll granularity of the cancellation-aware pacing wait: cancellation is
/// observed promptly without busy-spinning.
const PACING_POLL_INTERVAL: Duration = Duration::from_millis(20);

/// Google API error reasons that identify a genuine read-quota rejection.
/// Any other HTTP 403 reason (permission denial, policy, unknown) must not be
/// mislabeled as rate limited.
const QUOTA_ERROR_REASONS: [&str; 5] = [
    "rateLimitExceeded",
    "userRateLimitExceeded",
    "dailyLimitExceeded",
    "quotaExceeded",
    "resourceExhausted",
];

/// Bound on work retained from one nested Gmail history response.
const MAX_HISTORY_RECORDS: usize = 10_000;
const MAX_CHANGED_THREAD_IDS: usize = 1_000;
const MAX_DELETED_MESSAGE_IDS: usize = 5_000;

/// Refresh the access token this long before its stored expiry.
const EXPIRY_SKEW_MS: i64 = 60_000;

pub struct GmailProvider {
    config: GoogleConfig,
    secrets: Arc<dyn Secrets>,
    http: Client,
    endpoints: Endpoints,
    opener: UrlOpener,
    /// Serializes token refresh so concurrent calls never race the store.
    refresh_lock: Mutex<()>,
    /// Pacing floor between consecutive API reads; tests shorten it.
    min_request_interval: Duration,
    /// Issue time of the most recent paced API read (or the reserved slot of
    /// an in-flight one) so overlapping callers pace against each other.
    last_request_slot: Mutex<Option<Instant>>,
}

impl GmailProvider {
    /// Builds the provider. A blank client id is a visible `not_configured`.
    pub fn new(config: GoogleConfig, secrets: Arc<dyn Secrets>) -> Result<Self, MailError> {
        if config.client_id.trim().is_empty() {
            return Err(MailError::NotConfigured);
        }
        Self::build(config, secrets)
    }

    /// Builds a provider from launch configuration while preserving a usable
    /// provider object when the client id is absent. Core can inspect
    /// `is_configured()` and report `not_configured` without panicking or
    /// silently selecting fixture mode.
    pub fn from_env(secrets: Arc<dyn Secrets>) -> Result<Self, MailError> {
        let config = match GoogleConfig::from_env() {
            Ok(config) => config,
            Err(MailError::NotConfigured) => GoogleConfig {
                client_id: String::new(),
                client_secret: None,
            },
            Err(error) => return Err(error),
        };
        Self::build(config, secrets)
    }

    fn build(config: GoogleConfig, secrets: Arc<dyn Secrets>) -> Result<Self, MailError> {
        let http = Client::builder()
            .use_rustls_tls()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| MailError::ProviderUnavailable)?;
        Ok(Self {
            config,
            secrets,
            http,
            endpoints: Endpoints::google(),
            opener: auth::system_url_opener(),
            refresh_lock: Mutex::new(()),
            min_request_interval: MIN_REQUEST_INTERVAL,
            last_request_slot: Mutex::new(None),
        })
    }

    /// Waits until the minimum interval since the previous API read has
    /// elapsed, aborting promptly with `auth_cancelled` when cancelled. The
    /// request's slot is reserved before waiting so overlapping callers
    /// cannot burst; the sync worker is serial in practice. An overdue
    /// previous slot (idle gap, slow response) rebases to the current time
    /// so elapsed gaps never grant burst credit.
    fn pace(&self, cancel: &CancelToken) -> Result<(), MailError> {
        if self.min_request_interval.is_zero() {
            return Ok(());
        }
        let due = {
            let mut slot = self
                .last_request_slot
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?;
            let now = Instant::now();
            let due = match *slot {
                Some(previous) => (previous + self.min_request_interval).max(now),
                None => now,
            };
            *slot = Some(due);
            due
        };
        loop {
            if cancel.is_cancelled() {
                return Err(MailError::AuthCancelled);
            }
            let remaining = due.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Ok(());
            }
            std::thread::sleep(remaining.min(PACING_POLL_INTERVAL));
        }
    }

    /// Loads the cached token; refreshes through the serialized path when
    /// expired. No credentials means `auth_required`, not a silent retry.
    fn access_token(&self, cancel: &CancelToken) -> Result<String, MailError> {
        let bundle = self.secrets.load()?.ok_or(MailError::AuthRequired)?;
        if bundle.expires_at_epoch_ms - EXPIRY_SKEW_MS > now_ms() && !bundle.access_token.is_empty()
        {
            return Ok(bundle.access_token);
        }
        let refresh_token = bundle
            .refresh_token
            .clone()
            .ok_or(MailError::AuthRequired)?;
        let _guard = self
            .refresh_lock
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        // Double-check after acquiring the lock: another caller may have
        // refreshed while this one waited.
        let latest = self.secrets.load()?.unwrap_or(bundle);
        if latest.expires_at_epoch_ms - EXPIRY_SKEW_MS > now_ms() && !latest.access_token.is_empty()
        {
            return Ok(latest.access_token);
        }
        let tokens = auth::refresh(
            &self.config,
            &self.endpoints,
            &self.http,
            &refresh_token,
            cancel,
        )?;
        let updated = TokenBundle {
            access_token: tokens.access_token,
            expires_at_epoch_ms: tokens.expires_at_epoch_ms,
            refresh_token: tokens.refresh_token.or(Some(refresh_token)),
            account_id: latest.account_id.clone(),
            email: latest.email.clone(),
        };
        self.secrets.store(&updated)?;
        Ok(updated.access_token)
    }

    /// The cached account id (stable, scoped: the email for this single
    /// account). Missing credentials mean `auth_required`.
    fn cached_account_id(&self) -> Result<String, MailError> {
        let bundle = self.secrets.load()?.ok_or(MailError::AuthRequired)?;
        bundle
            .account_id
            .or(bundle.email)
            .filter(|id| !id.is_empty())
            .ok_or(MailError::AuthRequired)
    }

    /// GET the profile document and normalize it into a [`GmailProfile`].
    fn fetch_profile(&self, token: &str, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        let body = self
            .api_get("/gmail/v1/users/me/profile", "", token, cancel)?
            .ok_or(MailError::InvalidProviderResponse)?;
        let json: Value = parse_json(&body)?;
        let email = str_field(&json, "emailAddress")?;
        let history_id = str_field(&json, "historyId")?;
        Ok(GmailProfile {
            account_id: email.clone(),
            email_address: email,
            history_id,
        })
    }

    /// GET one API path with the bearer token. `Ok(None)` maps to HTTP 404
    /// (used for deleted thread/history-expiry semantics by callers). Body
    /// sizes are bounded; every other non-success is a typed error.
    fn api_get(
        &self,
        path: &str,
        query: &str,
        token: &str,
        cancel: &CancelToken,
    ) -> Result<Option<String>, MailError> {
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        self.pace(cancel)?;
        let url = if query.is_empty() {
            format!("{}{path}", self.endpoints.api)
        } else {
            format!("{}{path}?{query}", self.endpoints.api)
        };
        let response = self
            .http
            .get(&url)
            .bearer_auth(token)
            .send()
            .map_err(auth::map_http_error)?;
        let status = response.status();
        if status == StatusCode::NOT_FOUND {
            return Ok(None);
        }
        if !status.is_success() {
            if status == StatusCode::FORBIDDEN {
                // 403 conflates genuine quota rejections with permission
                // denials. Classify by bounded structured reasons only; the
                // body itself never crosses this boundary and is never
                // logged. An unreadable body cannot be classified, so it
                // keeps the generic provider failure.
                let classified = auth::read_bounded(response)
                    .map(|bytes| classify_forbidden(&String::from_utf8_lossy(&bytes)));
                return Err(classified.unwrap_or(MailError::ProviderUnavailable));
            }
            return Err(map_status(status));
        }
        let bytes = auth::read_bounded(response)?;
        Ok(Some(
            String::from_utf8(bytes).map_err(|_| MailError::InvalidProviderResponse)?,
        ))
    }
}

/// Bounded, structured classification of an HTTP 403 body: inspects only the
/// documented `error.errors[].reason` fields (capped count) and the
/// canonical `error.status` code. Never exposes the body — callers receive a
/// typed error only.
fn classify_forbidden(body: &str) -> MailError {
    const MAX_REASONS_EXAMINED: usize = 10;
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return MailError::ProviderUnavailable;
    };
    let error = json.get("error");
    let reason_is_quota = error
        .and_then(|error| error.get("errors"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("reason").and_then(Value::as_str))
        .take(MAX_REASONS_EXAMINED)
        .any(|reason| QUOTA_ERROR_REASONS.contains(&reason));
    if reason_is_quota
        || error
            .and_then(|error| error.get("status"))
            .and_then(Value::as_str)
            == Some("RESOURCE_EXHAUSTED")
    {
        return MailError::RateLimited;
    }
    MailError::ProviderUnavailable
}

impl GmailReadProvider for GmailProvider {
    fn is_configured(&self) -> bool {
        !self.config.client_id.trim().is_empty()
    }

    fn has_credentials(&self) -> Result<bool, MailError> {
        Ok(self.secrets.load()?.is_some())
    }

    fn connect(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        if !self.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let grant = auth::authorize(
            &self.config,
            &self.endpoints,
            &self.opener,
            cancel,
            auth::AUTH_TIMEOUT,
        )?;
        let tokens =
            auth::exchange_code(&self.config, &self.endpoints, &self.http, &grant, cancel)?;
        // Preserve a stored refresh token when the grant response omits it.
        let previous = self.secrets.load()?;
        let bundle = TokenBundle {
            access_token: tokens.access_token,
            expires_at_epoch_ms: tokens.expires_at_epoch_ms,
            refresh_token: tokens
                .refresh_token
                .or_else(|| previous.as_ref().and_then(|p| p.refresh_token.clone())),
            account_id: previous.as_ref().and_then(|p| p.account_id.clone()),
            email: previous.as_ref().and_then(|p| p.email.clone()),
        };
        let profile = self.fetch_profile(&bundle.access_token, cancel)?;
        // Account binding: credentials are single-profile. Re-authenticating
        // as a different account must fail closed and leave the previous
        // bundle untouched until an explicit disconnect clears it.
        if let Some(previous) = &previous {
            let bound_account = previous
                .account_id
                .as_ref()
                .or(previous.email.as_ref())
                .filter(|account| !account.is_empty());
            if let Some(bound_account) = bound_account {
                if *bound_account != profile.account_id {
                    return Err(MailError::AuthFailed);
                }
            }
        }
        let bundle = TokenBundle {
            account_id: Some(profile.account_id.clone()),
            email: Some(profile.email_address.clone()),
            ..bundle
        };
        self.secrets.store(&bundle)?;
        Ok(profile)
    }

    fn disconnect(&self) -> Result<(), MailError> {
        self.secrets.clear()
    }

    fn profile(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        let token = self.access_token(cancel)?;
        self.fetch_profile(&token, cancel)
    }

    fn list_inbox(
        &self,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<InboxPage, MailError> {
        let token = self.access_token(cancel)?;
        let mut query = format!("labelIds=INBOX&maxResults={DISCOVERY_PAGE_RESULTS}");
        if let Some(page_token) = page_token {
            query.push_str(&format!("&pageToken={}", url_encode(page_token)));
        }
        let body = self
            .api_get("/gmail/v1/users/me/threads", &query, &token, cancel)?
            .ok_or(MailError::InvalidProviderResponse)?;
        let json: Value = parse_json(&body)?;
        let mut thread_ids = Vec::new();
        if let Some(threads) = optional_array(&json, "threads")? {
            for thread in threads {
                thread_ids.push(str_field(thread, "id")?);
            }
        }
        let next_page_token = optional_string(&json, "nextPageToken")?;
        Ok(InboxPage {
            thread_ids,
            next_page_token,
        })
    }

    fn get_thread(
        &self,
        thread_id: &str,
        cancel: &CancelToken,
    ) -> Result<Option<GmailThread>, MailError> {
        let token = self.access_token(cancel)?;
        let account_id = self.cached_account_id()?;
        let path = format!("/gmail/v1/users/me/threads/{}", url_encode(thread_id));
        match self.api_get(&path, "format=full", &token, cancel)? {
            // Deleted threads are `None`, not an error.
            None => Ok(None),
            Some(body) => parse_thread(&account_id, thread_id, &body).map(Some),
        }
    }

    fn history(
        &self,
        start_history_id: &str,
        page_token: Option<&str>,
        cancel: &CancelToken,
    ) -> Result<HistoryPage, GmailHistoryError> {
        let token = self.access_token(cancel).map_err(GmailHistoryError::Mail)?;
        let mut query = format!(
            "startHistoryId={}&maxResults={MAX_PAGE_RESULTS}",
            url_encode(start_history_id)
        );
        if let Some(page_token) = page_token {
            query.push_str(&format!("&pageToken={}", url_encode(page_token)));
        }
        let body = self
            .api_get("/gmail/v1/users/me/history", &query, &token, cancel)
            .map_err(GmailHistoryError::Mail)?
            // The stored history cursor expired: bounded rediscovery is the
            // sync lane's job, not silent skipping.
            .ok_or(GmailHistoryError::Expired)?;
        parse_history(&body).map_err(GmailHistoryError::Mail)
    }
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock before epoch")
        .as_millis() as i64
}

/// percent-encode one opaque cursor/id value for query strings.
fn url_encode(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

fn parse_json(body: &str) -> Result<Value, MailError> {
    let value: Value =
        serde_json::from_str(body).map_err(|_| MailError::InvalidProviderResponse)?;
    if !value.is_object() {
        return Err(MailError::InvalidProviderResponse);
    }
    Ok(value)
}

fn str_field(json: &Value, key: &str) -> Result<String, MailError> {
    json.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
        .ok_or(MailError::InvalidProviderResponse)
}

fn optional_string(json: &Value, key: &str) -> Result<Option<String>, MailError> {
    match json.get(key) {
        None => Ok(None),
        Some(Value::String(value)) if !value.is_empty() => Ok(Some(value.clone())),
        Some(_) => Err(MailError::InvalidProviderResponse),
    }
}

fn optional_array<'a>(json: &'a Value, key: &str) -> Result<Option<&'a [Value]>, MailError> {
    match json.get(key) {
        None => Ok(None),
        Some(Value::Array(values)) => Ok(Some(values)),
        Some(_) => Err(MailError::InvalidProviderResponse),
    }
}

fn optional_string_array<'a>(
    json: &'a Value,
    key: &str,
) -> Result<Option<Vec<&'a str>>, MailError> {
    optional_array(json, key)?
        .map(|values| {
            values
                .iter()
                .map(|value| value.as_str().ok_or(MailError::InvalidProviderResponse))
                .collect()
        })
        .transpose()
}

fn map_status(status: StatusCode) -> MailError {
    match status.as_u16() {
        401 => MailError::AuthRequired,
        // Gmail uses 429 for quota errors. HTTP 403 is classified
        // structurally in `api_get` because genuine quota and permission
        // denials share that status code.
        429 => MailError::RateLimited,
        _ => MailError::ProviderUnavailable,
    }
}

/// Decodes Gmail's base64url payload (with or without padding).
fn b64url_decode(input: &str) -> Result<Vec<u8>, MailError> {
    base64::engine::general_purpose::URL_SAFE
        .decode(input)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(input))
        .map_err(|_| MailError::InvalidProviderResponse)
}

/// Normalizes one `threads.get?format=full` response into a
/// [`GmailThread`]. Only literal `text/plain` parts become bodies; messages
/// without a safe plain-text body, oversized bodies, and undecodable content
/// are disclosed via `unsupported_reason` and `context_complete: false`.
/// Attachment presence is disclosed but never read.
fn parse_thread(account_id: &str, thread_id: &str, body: &str) -> Result<GmailThread, MailError> {
    let json: Value = parse_json(body)?;
    let history_id = str_field(&json, "historyId")?;
    let messages = json
        .get("messages")
        .and_then(Value::as_array)
        .ok_or(MailError::InvalidProviderResponse)?;
    if messages.is_empty() {
        return Err(MailError::InvalidProviderResponse);
    }
    let mut parsed: Vec<(Message, String)> = Vec::new();
    let mut inbox_message_ids = Vec::new();
    let mut no_plain_text = 0usize;
    let mut attachments = false;
    let mut omitted_inline_content = false;
    for message in messages {
        let id = str_field(message, "id")?;
        let has_inbox_label = optional_string_array(message, "labelIds")?
            .is_some_and(|labels| labels.contains(&"INBOX"));
        if has_inbox_label {
            inbox_message_ids.push(id.clone());
        }
        let payload = message
            .get("payload")
            .ok_or(MailError::InvalidProviderResponse)?;
        if payload_has_attachment(payload, 0) {
            attachments = true;
        }
        if let Some(plain_part) = find_plain_part(payload, 0) {
            omitted_inline_content |= has_omitted_inline_content(payload, plain_part, 0);
        }
        match parse_message(&id, message) {
            Ok(pair) => parsed.push(pair),
            Err(_) => no_plain_text += 1,
        }
    }
    let subject = messages
        .iter()
        .rev()
        .filter_map(|message| {
            message
                .get("payload")
                .map(|payload| json_header_value(payload, "Subject"))
        })
        .map(|value| decoded_header(&value))
        .find(|value| !value.is_empty())
        .unwrap_or_else(|| pick_subject(&parsed));
    let mut reasons = Vec::new();
    if no_plain_text > 0 {
        reasons.push(format!(
            "{no_plain_text} of {} messages had no safe plain-text body",
            messages.len()
        ));
    }
    if attachments {
        reasons.push("attachments present are not displayed".to_string());
    }
    if omitted_inline_content {
        reasons.push("additional inline MIME content is not displayed".to_string());
    }
    let conversation = Conversation {
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: thread_id.to_string(),
        },
        subject,
        messages: parsed.into_iter().map(|(message, _)| message).collect(),
        is_in_inbox: !inbox_message_ids.is_empty(),
        is_read: None,
        context_complete: Some(no_plain_text == 0 && !attachments && !omitted_inline_content),
        unsupported_reason: (!reasons.is_empty()).then(|| reasons.join("; ")),
        pending_operation_id: None,
    };
    Ok(GmailThread {
        conversation,
        inbox_message_ids,
        message_ids: None,
        unread_message_ids: None,
        history_id,
    })
}

/// Newest non-empty subject wins; Gmail lists messages oldest first.
fn pick_subject(messages: &[(Message, String)]) -> String {
    messages
        .iter()
        .rev()
        .map(|(_, subject)| subject.as_str())
        .find(|subject| !subject.is_empty())
        .map_or_else(String::new, str::to_string)
}

/// Parses one `format=full` message into the wire DTO. Header facts
/// (From/To/Subject) come from the root payload headers (RFC2047-decoded);
/// the body is the first literal `text/plain` part in the payload tree.
/// Gmail's base64url wrapper is removed once, then its declared charset is decoded
/// strictly without replaying the original MIME transfer-encoding header.
fn parse_message(id: &str, message: &Value) -> Result<(Message, String), String> {
    let payload = message
        .get("payload")
        .ok_or_else(|| "message payload missing".to_string())?;
    let subject = decoded_header(&json_header_value(payload, "Subject"));
    let from = parse_addresses(&json_header_value(payload, "From"))
        .into_iter()
        .next()
        .ok_or_else(|| "missing From address".to_string())?;
    let to = parse_addresses(&json_header_value(payload, "To"));
    let sent_at = message
        .get("internalDate")
        .and_then(Value::as_str)
        .and_then(|ms| ms.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .or_else(|| {
            let date = json_header_value(payload, "Date");
            (!date.is_empty())
                .then(|| mailparse::dateparse(&date).ok())
                .flatten()
                .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        })
        .unwrap_or_default();
    let part = find_plain_part(payload, 0).ok_or_else(|| "no plain-text body".to_string())?;
    let data = part
        .get("body")
        .and_then(|body| body.get("data"))
        .and_then(Value::as_str)
        .ok_or_else(|| "missing body data".to_string())?;
    let bytes = b64url_decode(data).map_err(|_| "undecodable body data".to_string())?;
    if bytes.len() > MAX_PART_BODY_BYTES {
        return Err("body too large".to_string());
    }
    let raw = part_raw(part, &bytes);
    let parsed = mailparse::parse_mail(&raw).map_err(|_| "unparseable body".to_string())?;
    let decoded_bytes = parsed
        .get_body_raw()
        .map_err(|_| "undecodable body transfer wrapper".to_string())?;
    let charset = charset::Charset::for_label(parsed.ctype.charset.as_bytes())
        .ok_or_else(|| "unsupported body charset".to_string())?;
    let (decoded, _, had_errors) = charset.decode(&decoded_bytes);
    if had_errors {
        return Err("lossy body charset decoding".to_string());
    }
    let mut body_text = decoded.into_owned();
    // Normalize newlines; hostile markup stays literal data for the UI to escape.
    body_text = body_text.replace("\r\n", "\n").replace('\r', "\n");
    if body_text.chars().count() > MAX_MESSAGE_TEXT_CHARS {
        return Err("body too large".to_string());
    }
    Ok((
        Message {
            id: id.to_string(),
            from,
            to,
            sent_at,
            body_text,
        },
        subject,
    ))
}

/// First header value with the given name on a Gmail payload, sanitized
/// against CR/LF (hostile header values become one line).
fn json_header_value(payload: &Value, name: &str) -> String {
    payload
        .get("headers")
        .and_then(Value::as_array)
        .and_then(|headers| {
            headers.iter().find_map(|header| {
                let matches = header
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.eq_ignore_ascii_case(name))
                    .unwrap_or(false);
                matches.then(|| {
                    header
                        .get("value")
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                })
            })
        })
        .unwrap_or_default()
        .replace(['\r', '\n'], " ")
}

/// RFC2047-decodes one header value via `mailparse`; falls back to the raw
/// value when undecodable.
fn decoded_header(value: &str) -> String {
    let mut raw = String::from("X-Eos: ");
    raw.push_str(value);
    raw.push_str("\r\n");
    match mailparse::parse_header(raw.as_bytes()) {
        Ok((header, _)) => header.get_value(),
        Err(_) => value.to_string(),
    }
}

/// Recursively finds the first literal `text/plain` part in a Gmail payload
/// tree, skipping attachments. HTML-only payloads yield `None`.
fn find_plain_part(payload: &Value, depth: usize) -> Option<&Value> {
    if depth > MAX_PAYLOAD_DEPTH || is_attachment_part(payload) {
        return None;
    }
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mime.eq_ignore_ascii_case("text/plain") {
        return Some(payload);
    }
    if mime.starts_with("multipart/") {
        let parts = payload.get("parts").and_then(Value::as_array)?;
        for part in parts {
            if is_attachment_part(part) {
                continue;
            }
            let part_mime = part
                .get("mimeType")
                .and_then(Value::as_str)
                .unwrap_or_default();
            if part_mime.eq_ignore_ascii_case("text/plain") {
                return Some(part);
            }
            if part_mime.starts_with("multipart/") {
                if let Some(found) = find_plain_part(part, depth + 1) {
                    return Some(found);
                }
            }
        }
    }
    None
}

/// Whether a MIME tree contains inline content that the single-body reader
/// skipped. `multipart/alternative` branches are alternatives, so inspect only
/// the branch that supplied the selected plain-text body.
fn has_omitted_inline_content(payload: &Value, selected: &Value, depth: usize) -> bool {
    if depth > MAX_PAYLOAD_DEPTH {
        return true;
    }
    if std::ptr::eq(payload, selected) || is_attachment_part(payload) {
        return false;
    }
    let mime = payload
        .get("mimeType")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if mime.starts_with("multipart/") {
        let Some(parts) = payload.get("parts").and_then(Value::as_array) else {
            return false;
        };
        if mime.eq_ignore_ascii_case("multipart/alternative") {
            if let Some(part) = parts
                .iter()
                .find(|part| contains_part(part, selected, depth + 1))
            {
                return has_omitted_inline_content(part, selected, depth + 1);
            }
            // An alternative subtree outside the selected body is additional
            // omitted content, not another representation of that body.
        }
        return parts
            .iter()
            .any(|part| has_omitted_inline_content(part, selected, depth + 1));
    }
    payload
        .get("body")
        .and_then(|body| body.get("data"))
        .is_some()
}

fn contains_part(payload: &Value, selected: &Value, depth: usize) -> bool {
    if depth > MAX_PAYLOAD_DEPTH {
        return false;
    }
    if std::ptr::eq(payload, selected) {
        return true;
    }
    payload
        .get("parts")
        .and_then(Value::as_array)
        .is_some_and(|parts| {
            parts
                .iter()
                .any(|part| contains_part(part, selected, depth + 1))
        })
}

/// True when any payload/part in the tree carries a `Content-Disposition:
/// attachment` header (attachment presence is disclosed, never read).
fn payload_has_attachment(payload: &Value, depth: usize) -> bool {
    if depth > MAX_PAYLOAD_DEPTH {
        return false;
    }
    if is_attachment_part(payload) {
        return true;
    }
    payload
        .get("parts")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .any(|part| payload_has_attachment(part, depth + 1))
        })
        .unwrap_or(false)
}

fn is_attachment_part(part: &Value) -> bool {
    let has_filename = part
        .get("filename")
        .and_then(Value::as_str)
        .is_some_and(|filename| !filename.is_empty());
    let has_attachment_body = part
        .get("body")
        .and_then(|body| body.get("attachmentId"))
        .and_then(Value::as_str)
        .is_some();
    let has_attachment_disposition = part
        .get("headers")
        .and_then(Value::as_array)
        .map(|headers| {
            headers.iter().any(|header| {
                let named_disposition = header
                    .get("name")
                    .and_then(Value::as_str)
                    .map(|n| n.eq_ignore_ascii_case("content-disposition"))
                    .unwrap_or(false);
                let is_attachment = header
                    .get("value")
                    .and_then(Value::as_str)
                    .map(|v| v.to_ascii_lowercase().starts_with("attachment"))
                    .unwrap_or(false);
                named_disposition && is_attachment
            })
        })
        .unwrap_or(false);
    has_filename || has_attachment_body || has_attachment_disposition
}

/// Reconstructs a raw RFC822 part (headers + body bytes) for `mailparse`.
/// Header values are sanitized against CR/LF injection.
fn part_raw(part: &Value, body: &[u8]) -> Vec<u8> {
    let mut raw = Vec::new();
    if let Some(headers) = part.get("headers").and_then(Value::as_array) {
        for header in headers {
            let name = header
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let value = header
                .get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .replace(['\r', '\n'], " ");
            // Gmail has already unwrapped its base64url body.data value. The
            // original MIME transfer-encoding header no longer describes the
            // returned bytes and must not be applied a second time.
            if name.eq_ignore_ascii_case("content-transfer-encoding") {
                continue;
            }
            raw.extend_from_slice(name.as_bytes());
            raw.extend_from_slice(b": ");
            raw.extend_from_slice(value.as_bytes());
            raw.extend_from_slice(b"\r\n");
        }
    }
    raw.extend_from_slice(b"\r\n");
    raw.extend_from_slice(body);
    raw
}

/// Flattens a sanitized original address header into wire DTOs; groups are
/// flattened, entries with empty mailboxes are dropped, malformed headers
/// yield an empty list. Parse the address grammar before RFC2047 decoding so
/// encoded commas/colons remain display-name data rather than separators.
fn parse_addresses(value: &str) -> Vec<Address> {
    let mut raw = String::from("From: ");
    raw.push_str(value);
    raw.push_str("\r\n");
    let Ok((header, _)) = mailparse::parse_header(raw.as_bytes()) else {
        return Vec::new();
    };
    let Ok(list) = mailparse::addrparse_header(&header) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for addr in list.iter() {
        match addr {
            mailparse::MailAddr::Single(info) => push_address(&mut out, info),
            mailparse::MailAddr::Group(group) => {
                for info in &group.addrs {
                    push_address(&mut out, info);
                }
            }
        }
    }
    out
}

fn push_address(out: &mut Vec<Address>, info: &mailparse::SingleInfo) {
    if info.addr.is_empty() {
        return;
    }
    out.push(Address {
        display_name: info.display_name.clone(),
        mailbox: info.addr.clone(),
    })
}

/// Normalizes one history page. Semantics kept mechanical for the sync lane:
///
/// - `messagesAdded` / `labelsAdded` -> thread id in `changed_thread_ids`
/// - `messagesDeleted` -> message id in `deleted_message_ids` + thread changed
/// - `labelsRemoved` -> thread id in `changed_thread_ids` (current thread
///   facts reconcile inbox membership; only actual deletions remove messages)
///
/// Adds nested-record work to the per-response parsing budget.
fn count_history_records(count: &mut usize, amount: usize) -> Result<(), MailError> {
    *count = count
        .checked_add(amount)
        .filter(|count| *count <= MAX_HISTORY_RECORDS)
        .ok_or(MailError::InvalidProviderResponse)?;
    Ok(())
}

fn push_unique_limited(
    values: &mut Vec<String>,
    seen: &mut HashSet<String>,
    value: String,
    limit: usize,
) -> Result<(), MailError> {
    if seen.contains(&value) {
        return Ok(());
    }
    if values.len() >= limit {
        return Err(MailError::InvalidProviderResponse);
    }
    seen.insert(value.clone());
    values.push(value);
    Ok(())
}

/// Repeated ids are deduped; nested records and retained unique ids are
/// explicitly bounded, and malformed records are typed errors.
fn parse_history(body: &str) -> Result<HistoryPage, MailError> {
    let json: Value = parse_json(body)?;
    let history_id = str_field(&json, "historyId")?;
    let entries = optional_array(&json, "history")?.unwrap_or(&[]);
    let mut record_count = 0;
    count_history_records(&mut record_count, entries.len())?;
    let mut changed_thread_ids = Vec::new();
    let mut deleted_message_ids = Vec::new();
    let mut changed_ids = HashSet::new();
    let mut deleted_ids = HashSet::new();
    for entry in entries {
        if !entry.is_object() {
            return Err(MailError::InvalidProviderResponse);
        }
        if let Some(records) = optional_array(entry, "messagesAdded")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
        if let Some(records) = optional_array(entry, "messagesDeleted")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                push_unique_limited(
                    &mut deleted_message_ids,
                    &mut deleted_ids,
                    str_field(message, "id")?,
                    MAX_DELETED_MESSAGE_IDS,
                )?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
        if let Some(records) = optional_array(entry, "labelsAdded")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                let _added_labels = optional_string_array(record, "labelIds")?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
        if let Some(records) = optional_array(entry, "labelsRemoved")? {
            count_history_records(&mut record_count, records.len())?;
            for record in records {
                let message = record
                    .get("message")
                    .ok_or(MailError::InvalidProviderResponse)?;
                let _removed_labels = optional_string_array(record, "labelIds")?;
                push_unique_limited(
                    &mut changed_thread_ids,
                    &mut changed_ids,
                    str_field(message, "threadId")?,
                    MAX_CHANGED_THREAD_IDS,
                )?;
            }
        }
    }
    let next_page_token = optional_string(&json, "nextPageToken")?;
    Ok(HistoryPage {
        changed_thread_ids,
        deleted_message_ids,
        next_page_token,
        history_id,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
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
        }
    }

    /// Loopback fake Google API: serves scripted (path-prefix, status, body)
    /// responses, records request targets. No real network beyond localhost.
    struct FakeApi {
        state: Arc<FakeState>,
        _thread: std::thread::JoinHandle<()>,
    }

    struct FakeState {
        script: Mutex<VecDeque<(String, u16, String)>>,
        requests: Mutex<Vec<String>>,
        bodies: Mutex<Vec<String>>,
    }

    impl FakeApi {
        fn start(script: Vec<(&str, u16, &str)>) -> (String, FakeApi) {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let state = Arc::new(FakeState {
                script: Mutex::new(
                    script
                        .into_iter()
                        .map(|(prefix, status, body)| {
                            (prefix.to_string(), status, body.to_string())
                        })
                        .collect(),
                ),
                requests: Mutex::new(Vec::new()),
                bodies: Mutex::new(Vec::new()),
            });
            let thread_state = Arc::clone(&state);
            let thread = std::thread::spawn(move || loop {
                let Ok((mut stream, _)) = listener.accept() else {
                    break;
                };
                let mut buf = [0u8; 8192];
                let len = stream.read(&mut buf).unwrap_or(0);
                let text = String::from_utf8_lossy(&buf[..len]);
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
                let scripted = thread_state.script.lock().unwrap().pop_front();
                match scripted {
                    Some((prefix, status, body)) if target.starts_with(&prefix) => {
                        let _ = stream.write_all(
                            format!(
                                "HTTP/1.1 {status} x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
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

    fn payload_headers(headers: &[(&str, &str)]) -> Vec<Value> {
        headers
            .iter()
            .map(|(name, value)| json!({"name": name, "value": value}))
            .collect()
    }

    fn text_payload(mime_type: &str, headers: &[(&str, &str)], data: Option<&[u8]>) -> Value {
        let body = data
            .map(|bytes| json!({"data": URL_SAFE_NO_PAD.encode(bytes)}))
            .unwrap_or_else(|| json!({}));
        json!({
            "mimeType": mime_type,
            "headers": payload_headers(headers),
            "body": body,
        })
    }

    fn gmail_message(id: &str, label_ids: &[&str], payload: Value) -> Value {
        json!({
            "id": id,
            "labelIds": label_ids,
            "internalDate": "1760349600000",
            "payload": payload,
        })
    }

    fn thread_response(thread_id: &str, history_id: &str, messages: Vec<Value>) -> String {
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
                let _ = stream.write_all(
                    format!("GET {full} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").as_bytes(),
                );
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
        assert!(parsed.query_pairs().any(
            |(k, v)| k == "client_id" && v == "synthetic-client-id.apps.googleusercontent.com"
        ));
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
            &["INBOX"],
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
        let conversation = &thread.conversation;
        assert_eq!(conversation.conversation_ref.conversation_id, "t1");
        assert_eq!(
            conversation.conversation_ref.account_id,
            "synthetic@example.test"
        );
        assert!(conversation.is_in_inbox);
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

        let (base, _api) =
            FakeApi::start(vec![("/gmail/v1/users/me/threads", 200, "not json at all")]);
        let secrets = Arc::new(crate::gmail::secrets::MemorySecrets::new());
        secrets.store(&future_token()).unwrap();
        let provider = test_provider(&base, secrets);
        assert!(matches!(
            provider.list_inbox(None, &CancelToken::default()),
            Err(MailError::InvalidProviderResponse)
        ));
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
    fn encoded_address_display_names_do_not_change_address_grammar() {
        let payload = text_payload(
            "text/plain",
            &[
                ("From", "=?UTF-8?Q?Doe=2C_John?= <john@example.test>"),
                (
                    "To",
                    "=?UTF-8?Q?Ops=3A_Team?= <ops@example.test>, next@example.test",
                ),
                ("Subject", "encoded address punctuation"),
                ("Content-Type", "text/plain; charset=utf-8"),
            ],
            Some(b"safe body"),
        );
        let thread = parse_thread(
            "synthetic@example.test",
            "t-address-encoded",
            &thread_response(
                "t-address-encoded",
                "6",
                vec![gmail_message("m-address", &[], payload)],
            ),
        )
        .unwrap();
        let message = &thread.conversation.messages[0];
        assert_eq!(message.from.display_name.as_deref(), Some("Doe, John"));
        assert_eq!(message.from.mailbox, "john@example.test");
        assert_eq!(message.to[0].display_name.as_deref(), Some("Ops: Team"));
        assert_eq!(message.to[0].mailbox, "ops@example.test");
        assert_eq!(message.to[1].mailbox, "next@example.test");
    }

    #[test]
    fn skipped_inline_mixed_content_is_disclosed_but_alternatives_are_not() {
        let main = text_payload(
            "text/plain",
            &[("Content-Type", "text/plain; charset=utf-8")],
            Some(b"Main body"),
        );
        let additional = text_payload(
            "text/plain",
            &[("Content-Type", "text/plain; charset=utf-8")],
            Some(b"Additional content"),
        );
        let mixed = json!({
            "mimeType": "multipart/mixed",
            "headers": payload_headers(&[("From", "sender@example.test")]),
            "parts": [main.clone(), additional],
        });
        let mixed_thread = parse_thread(
            "synthetic@example.test",
            "t-mixed-inline",
            &thread_response(
                "t-mixed-inline",
                "6",
                vec![gmail_message("m-mixed-inline", &[], mixed)],
            ),
        )
        .unwrap();
        assert_eq!(mixed_thread.conversation.messages[0].body_text, "Main body");
        assert_eq!(mixed_thread.conversation.context_complete, Some(false));
        assert_eq!(
            mixed_thread.conversation.unsupported_reason.as_deref(),
            Some("additional inline MIME content is not displayed")
        );

        let alternative = json!({
            "mimeType": "multipart/alternative",
            "headers": payload_headers(&[("From", "sender@example.test")]),
            "parts": [
                main,
                text_payload("text/html", &[], Some(b"<p>alternative</p>")),
            ],
        });
        let alternative_thread = parse_thread(
            "synthetic@example.test",
            "t-alternative-inline",
            &thread_response(
                "t-alternative-inline",
                "6",
                vec![gmail_message("m-alternative-inline", &[], alternative)],
            ),
        )
        .unwrap();
        assert_eq!(alternative_thread.conversation.context_complete, Some(true));
        assert_eq!(alternative_thread.conversation.unsupported_reason, None);
    }

    #[test]
    fn unselected_alternative_subtree_is_disclosed_as_omitted_inline_content() {
        let payload = json!({
            "mimeType": "multipart/mixed",
            "headers": payload_headers(&[("From", "sender@example.test")]),
            "parts": [
                text_payload("text/plain", &[("Content-Type", "text/plain; charset=utf-8")], Some(b"Main body")),
                {
                    "mimeType": "multipart/alternative",
                    "parts": [
                        text_payload("text/plain", &[], Some(b"Additional content")),
                        text_payload("text/html", &[], Some(b"<p>Additional content</p>")),
                    ],
                },
            ],
        });
        let thread = parse_thread(
            "synthetic@example.test",
            "t-nested-alternative",
            &thread_response(
                "t-nested-alternative",
                "6",
                vec![gmail_message("m-nested-alternative", &["INBOX"], payload)],
            ),
        )
        .unwrap();
        assert_eq!(thread.conversation.messages[0].body_text, "Main body");
        assert_eq!(thread.conversation.context_complete, Some(false));
        assert_eq!(
            thread.conversation.unsupported_reason.as_deref(),
            Some("additional inline MIME content is not displayed")
        );
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
    fn gmail_full_payload_does_not_reapply_base64_transfer_encoding() {
        let payload = text_payload(
            "text/plain",
            &[
                ("From", "sender@example.test"),
                ("Subject", "encoded transport"),
                ("Content-Type", "text/plain; charset=utf-8"),
                ("Content-Transfer-Encoding", "base64"),
            ],
            Some(b"Ordinary text is already decoded by Gmail."),
        );
        let body = thread_response(
            "t-b64",
            "9",
            vec![gmail_message("m-b64", &["INBOX"], payload)],
        );
        let thread = parse_thread("synthetic@example.test", "t-b64", &body).unwrap();
        assert_eq!(
            thread.conversation.messages[0].body_text,
            "Ordinary text is already decoded by Gmail."
        );
        assert_eq!(thread.conversation.context_complete, Some(true));
    }

    #[test]
    fn unsupported_and_lossy_charsets_are_disclosed_as_incomplete() {
        let unknown = text_payload(
            "text/plain",
            &[
                ("From", "sender@example.test"),
                ("Subject", "unknown charset"),
                ("Content-Type", "text/plain; charset=x-no-such-charset"),
            ],
            Some(b"not safely decodable"),
        );
        let invalid_utf8 = text_payload(
            "text/plain",
            &[
                ("From", "sender@example.test"),
                ("Subject", "invalid utf8"),
                ("Content-Type", "text/plain; charset=utf-8"),
            ],
            Some(b"invalid \xff utf8"),
        );
        let body = thread_response(
            "t-charsets",
            "10",
            vec![
                gmail_message("m-unknown", &["INBOX"], unknown),
                gmail_message("m-invalid", &["INBOX"], invalid_utf8),
            ],
        );
        let thread = parse_thread("synthetic@example.test", "t-charsets", &body).unwrap();
        assert!(thread.conversation.messages.is_empty());
        assert_eq!(thread.conversation.context_complete, Some(false));
        assert_eq!(
            thread.conversation.unsupported_reason.as_deref(),
            Some("2 of 2 messages had no safe plain-text body")
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
        let profile = std::env::temp_dir().join(format!(
            "gmail-unsupported-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = GmailStore::open(&profile, Arc::new(SystemClock)).unwrap();
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
        let _ = std::fs::remove_dir_all(profile);
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

        let profile_dir = std::env::temp_dir().join(format!(
            "gmail-restore-store-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let store = GmailStore::open(&profile_dir, Arc::new(SystemClock)).unwrap();
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
        let _ = std::fs::remove_dir_all(profile_dir);
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
    fn history_parser_rejects_nested_record_and_unique_id_budget_overruns() {
        let changed = (0..=MAX_CHANGED_THREAD_IDS)
            .map(|index| json!({"message":{"threadId":format!("t{index}")}}))
            .collect::<Vec<_>>();
        let body = json!({"historyId":"200","history":[{"messagesAdded":changed}]}).to_string();
        assert!(matches!(
            parse_history(&body),
            Err(MailError::InvalidProviderResponse)
        ));

        let deleted = (0..=MAX_DELETED_MESSAGE_IDS)
            .map(|index| json!({"message":{"id":format!("m{index}"),"threadId":"same-thread"}}))
            .collect::<Vec<_>>();
        let body = json!({"historyId":"200","history":[{"messagesDeleted":deleted}]}).to_string();
        assert!(matches!(
            parse_history(&body),
            Err(MailError::InvalidProviderResponse)
        ));

        let too_many_records = vec![json!({}); MAX_HISTORY_RECORDS + 1];
        let body = json!({"historyId":"200","history":too_many_records}).to_string();
        assert!(matches!(
            parse_history(&body),
            Err(MailError::InvalidProviderResponse)
        ));
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
}
