//! Gmail provider: the synchronous [`crate::gmail::types::GmailReadProvider`] backing the cache/sync
//! lane, with mailbox writes denied until an explicit verified scope upgrade.
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

use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde_json::Value;

use crate::error::MailError;
use crate::gmail::auth::{self, Endpoints, GoogleConfig, UrlOpener};
use crate::gmail::secrets::{Secrets, TokenBundle};
use crate::gmail::types::{GmailHistoryError, GmailProfile, GmailThread, HistoryPage, InboxPage};
use crate::provider::CancelToken;
use crate::storage_log::{storage_err, storage_fault};

/// Bound on pages requested per list/history call.
const MAX_PAGE_RESULTS: usize = 100;

/// Discovery (`threads.list`) page size. Smaller pages bound the thread reads
/// that share one checkpointed page commit, so a rate limit interrupts far
/// fewer fetched threads; the overall 100-conversation cap lives in the sync
/// lane (`DISCOVERY_CAP`) and is unchanged.
const DISCOVERY_PAGE_RESULTS: usize = 25;

/// Safe pacing floor between consecutive Gmail API requests. The first
/// request runs immediately; every later request waits a
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

const MAX_BATCH_MODIFY_MESSAGE_IDS: usize = 1_000;

/// Refresh the access token this long before its stored expiry.
const EXPIRY_SKEW_MS: i64 = 60_000;

#[derive(Default)]
struct CredentialPublicationState {
    revision: u64,
    last_non_refresh_revision: u64,
}

#[derive(Clone, Copy)]
enum CredentialPublicationKind {
    Refresh,
    AccountChange,
}

pub struct GmailProvider {
    config: GoogleConfig,
    secrets: Arc<dyn Secrets>,
    http: Client,
    endpoints: Endpoints,
    opener: UrlOpener,
    /// Serializes token refresh so concurrent calls never race the store.
    refresh_lock: Mutex<()>,
    /// Fences every credential publisher and invalidates work started against
    /// an older bundle, including a disconnect while OAuth is in progress.
    credential_publication: Mutex<CredentialPublicationState>,
    /// Pacing floor between consecutive API requests; tests shorten it.
    min_request_interval: Duration,
    /// Issue time of the most recent paced API request (or the reserved slot of
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
            credential_publication: Mutex::new(CredentialPublicationState::default()),
            min_request_interval: MIN_REQUEST_INTERVAL,
            last_request_slot: Mutex::new(None),
        })
    }

    /// Waits until the minimum interval since the previous API request has
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
            let mut slot = self.last_request_slot.lock().map_err(storage_err())?;
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

    /// Takes a consistent in-process snapshot for credential publication.
    /// The lock is never held during provider I/O or interactive OAuth.
    fn credential_snapshot(&self) -> Result<(Option<TokenBundle>, u64, u64), MailError> {
        let publication = self.credential_publication.lock().map_err(storage_err())?;
        let bundle = self.secrets.load()?;
        Ok((
            bundle,
            publication.revision,
            publication.last_non_refresh_revision,
        ))
    }

    /// Stores a refresh/reauth result only while the bundle it was derived
    /// from is still current. Every publisher uses the same short fence.
    fn publish_bundle_if_current(
        &self,
        expected: &Option<TokenBundle>,
        expected_revision: u64,
        bundle: &TokenBundle,
        kind: CredentialPublicationKind,
    ) -> Result<bool, MailError> {
        let mut publication = self.credential_publication.lock().map_err(storage_err())?;
        if publication.revision != expected_revision || self.secrets.load()? != *expected {
            return Ok(false);
        }
        self.publish_bundle_locked(&mut publication, bundle, kind)?;
        Ok(true)
    }

    fn publish_bundle_locked(
        &self,
        publication: &mut CredentialPublicationState,
        bundle: &TokenBundle,
        kind: CredentialPublicationKind,
    ) -> Result<(), MailError> {
        let next_revision = publication
            .revision
            .checked_add(1)
            .ok_or_else(|| storage_fault("missing_persisted_row"))?;
        self.secrets.store(bundle)?;
        publication.revision = next_revision;
        if matches!(kind, CredentialPublicationKind::AccountChange) {
            publication.last_non_refresh_revision = next_revision;
        }
        Ok(())
    }

    /// Loads the cached token; refreshes through the serialized path when
    /// expired. No credentials means `auth_required`, not a silent retry.
    fn access_token(&self, cancel: &CancelToken) -> Result<String, MailError> {
        self.access_token_with_account(cancel)
            .map(|(token, _)| token)
    }

    /// Like [`Self::access_token`], but returns the published account
    /// identity from the SAME coherent bundle snapshot the returned token was
    /// admitted from. Token and identity are never read from different
    /// publications, so callers can bind dispatch to an expected account
    /// without a check-then-fetch TOCTOU window.
    fn access_token_with_account(
        &self,
        cancel: &CancelToken,
    ) -> Result<(String, Option<String>), MailError> {
        let (bundle, _, _) = self.credential_snapshot()?;
        let bundle = bundle.ok_or(MailError::AuthRequired)?;
        if bundle.expires_at_epoch_ms - EXPIRY_SKEW_MS > now_ms() && !bundle.access_token.is_empty()
        {
            let account = bundle_account_id(&bundle).map(str::to_string);
            return Ok((bundle.access_token, account));
        }
        let _refresh_guard = self.refresh_lock.lock().map_err(storage_err())?;

        loop {
            if cancel.is_cancelled() {
                return Err(MailError::AuthCancelled);
            }
            // Always derive the refresh request and fallback credentials from
            // the current snapshot; a cleared bundle is never resurrected.
            let (latest, revision, _) = self.credential_snapshot()?;
            let latest = latest.ok_or(MailError::AuthRequired)?;
            if latest.expires_at_epoch_ms - EXPIRY_SKEW_MS > now_ms()
                && !latest.access_token.is_empty()
            {
                let account = bundle_account_id(&latest).map(str::to_string);
                return Ok((latest.access_token, account));
            }
            let refresh_token = latest
                .refresh_token
                .clone()
                .ok_or(MailError::AuthRequired)?;
            let tokens = match auth::refresh(
                &self.config,
                &self.endpoints,
                &self.http,
                &refresh_token,
                cancel,
            ) {
                Ok(tokens) => tokens,
                Err(error) => {
                    if matches!(&error, MailError::AuthCancelled) {
                        return Err(error);
                    }
                    let (current, current_revision, _) = self.credential_snapshot()?;
                    if current_revision == revision {
                        return Err(error);
                    }
                    let current = current.ok_or(MailError::AuthRequired)?;
                    if current.expires_at_epoch_ms - EXPIRY_SKEW_MS > now_ms()
                        && !current.access_token.is_empty()
                    {
                        let account = bundle_account_id(&current).map(str::to_string);
                        return Ok((current.access_token, account));
                    }
                    continue;
                }
            };
            let updated = TokenBundle {
                access_token: tokens.access_token,
                expires_at_epoch_ms: tokens.expires_at_epoch_ms,
                refresh_token: tokens.refresh_token.or(latest.refresh_token.clone()),
                account_id: latest.account_id.clone(),
                email: latest.email.clone(),
                // Refresh can preserve or revoke a verified grant, never create
                // one: only the explicit account-bound OAuth upgrade enables it.
                gmail_modify_granted: latest.gmail_modify_granted
                    && tokens
                        .scope
                        .as_deref()
                        .map(scope_grants_modify)
                        .unwrap_or(true),
            };
            if self.publish_bundle_if_current(
                &Some(latest),
                revision,
                &updated,
                CredentialPublicationKind::Refresh,
            )? {
                let account = bundle_account_id(&updated).map(str::to_string);
                return Ok((updated.access_token, account));
            }
            // A connect, upgrade, or disconnect won while the readonly refresh
            // was in flight. Re-read and use its authorized token or refresh it.
        }
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
        let mut response = response;
        if response
            .content_length()
            .is_some_and(|n| n > auth::MAX_RESPONSE_BYTES as u64)
        {
            return Err(MailError::InvalidProviderResponse);
        }
        let mut bytes = Vec::new();
        loop {
            use std::io::Read;
            crate::attachments::check_cancel(cancel)?;
            let mut chunk = [0; 64 * 1024];
            let n = response
                .read(&mut chunk)
                .map_err(|_| MailError::NetworkUnavailable)?;
            if n == 0 {
                break;
            }
            if bytes.len().saturating_add(n) > auth::MAX_RESPONSE_BYTES {
                return Err(MailError::InvalidProviderResponse);
            }
            bytes.extend_from_slice(&chunk[..n]);
        }
        crate::attachments::check_cancel(cancel)?;
        Ok(Some(
            String::from_utf8(bytes).map_err(|_| MailError::InvalidProviderResponse)?,
        ))
    }

    /// Returns one coherent, current credential snapshot only when its
    /// account-bound grant is verified. Refresh and credential publication
    /// remain outside the publication lock; the snapshot after refresh is the
    /// credential that a caller may admit for dispatch.
    fn mutation_bundle(&self, cancel: &CancelToken) -> Result<TokenBundle, MailError> {
        loop {
            if cancel.is_cancelled() {
                return Err(MailError::AuthCancelled);
            }
            let (bundle, _, _) = self.credential_snapshot()?;
            let bundle = bundle.ok_or(MailError::PermissionRequired)?;
            if !bundle.gmail_modify_granted
                || bundle_account_id(&bundle).is_none()
                || (bundle.access_token.is_empty() && bundle.refresh_token.is_none())
            {
                return Err(MailError::PermissionRequired);
            }

            let returned_token = self.access_token(cancel)?;
            let (current, _, _) = self.credential_snapshot()?;
            let current = current.ok_or(MailError::PermissionRequired)?;
            if !current.gmail_modify_granted
                || bundle_account_id(&current).is_none()
                || (current.access_token.is_empty() && current.refresh_token.is_none())
            {
                return Err(MailError::PermissionRequired);
            }
            if current.access_token.is_empty()
                || current.expires_at_epoch_ms - EXPIRY_SKEW_MS <= now_ms()
            {
                // A concurrent credential publication can replace the token
                // after access_token returns; retry against that current
                // bundle. If refresh itself returned an unusable token, fail
                // closed rather than repeatedly refreshing it.
                if current.access_token == returned_token {
                    return Err(MailError::AuthRequired);
                }
                continue;
            }
            return Ok(current);
        }
    }

    /// Account-bound admission for readonly destination reads, mirroring the
    /// setter admission fence: the returned token and its validated identity
    /// come from ONE coherent credential publication naming
    /// `expected_account_id`, so a publication racing between token
    /// derivation and validation can never dispatch a foreign token under a
    /// validated name. A missing bundle is `auth_required`; a published
    /// identity that differs from the expected account (or is unknown) fails
    /// closed. No lock is held across the subsequent network request.
    fn destination_admission_token(
        &self,
        expected_account_id: &str,
        cancel: &CancelToken,
    ) -> Result<String, MailError> {
        let (token, published_account) = self.access_token_with_account(cancel)?;
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        match published_account.as_deref() {
            Some(account) if account == expected_account_id => Ok(token),
            _ => Err(MailError::AuthFailed),
        }
    }

    /// Re-verifies after network work that the current credential publication
    /// still names `expected_account_id`, so data fetched under a token that
    /// raced a disconnect or re-authentication is discarded rather than
    /// returned or persisted. Same fail-closed semantics as admission.
    fn verify_destination_account(
        &self,
        expected_account_id: &str,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let (bundle, _, _) = self.credential_snapshot()?;
        let bundle = bundle.ok_or(MailError::AuthRequired)?;
        match bundle_account_id(&bundle) {
            Some(account) if account == expected_account_id => Ok(()),
            _ => Err(MailError::AuthFailed),
        }
    }

    /// Returns the account identity from the same credential publication
    /// snapshot. It fences a setter from silently switching mailboxes while it
    /// waits for request pacing.
    fn mutation_account_id(&self, cancel: &CancelToken) -> Result<String, MailError> {
        let bundle = self.mutation_bundle(cancel)?;
        bundle_account_id(&bundle)
            .map(str::to_string)
            .ok_or(MailError::PermissionRequired)
    }

    /// Final logical setter admission. This runs after pacing and takes a new
    /// coherent snapshot, so a refresh/re-auth published during the wait
    /// cannot leave dispatch using an obsolete token or grant. No credential
    /// lock is held across the subsequent network request.
    fn setter_admission_token(
        &self,
        cancel: &CancelToken,
        expected_account_id: &str,
    ) -> Result<String, MailError> {
        let bundle = self.mutation_bundle(cancel)?;
        if bundle_account_id(&bundle) != Some(expected_account_id) {
            return Err(MailError::AuthFailed);
        }
        Ok(bundle.access_token)
    }

    fn apply_label_setter(
        &self,
        message_ids: &[String],
        add: bool,
        label: &'static str,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        validate_message_ids(message_ids)?;
        let account_id = self.mutation_account_id(cancel)?;
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        self.pace(cancel)?;
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let labels = [label];
        let body = if add {
            serde_json::json!({"ids": message_ids, "addLabelIds": labels})
        } else {
            serde_json::json!({"ids": message_ids, "removeLabelIds": labels})
        };
        let url = format!(
            "{}/gmail/v1/users/me/messages/batchModify",
            self.endpoints.api
        );
        let token = self.setter_admission_token(cancel, &account_id)?;
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let response = self
            .http
            .post(&url)
            .bearer_auth(token)
            .json(&body)
            .send()
            .map_err(|error| {
                // A connection failure proves the request was not dispatched.
                // Once connected, a transport error cannot establish whether
                // Gmail applied the batch.
                if error.is_connect() {
                    auth::map_http_error(error)
                } else {
                    MailError::OutcomeUnknown
                }
            })?;
        let status = response.status();
        if status.is_success() {
            // batchModify's successful response is empty; its status is the
            // definitive setter result, so no response body is required.
            return Ok(());
        }
        if status == StatusCode::FORBIDDEN {
            let result = auth::read_bounded(response)
                .map(|bytes| classify_mutation_forbidden(&String::from_utf8_lossy(&bytes)));
            return Err(result.unwrap_or(MailError::ProviderRejected));
        }
        if status == StatusCode::UNAUTHORIZED {
            return Err(MailError::AuthRequired);
        }
        if status == StatusCode::TOO_MANY_REQUESTS {
            return Err(MailError::RateLimited);
        }
        if status.is_server_error() {
            return Err(MailError::OutcomeUnknown);
        }
        Err(MailError::ProviderRejected)
    }
}

fn scope_grants_modify(scope: &str) -> bool {
    scope
        .split_ascii_whitespace()
        .any(|granted| granted == auth::GMAIL_MODIFY_SCOPE)
}

fn bundle_account_id(bundle: &TokenBundle) -> Option<&str> {
    bundle
        .account_id
        .as_deref()
        .filter(|account| !account.is_empty())
        .or_else(|| {
            bundle
                .email
                .as_deref()
                .filter(|account| !account.is_empty())
        })
}

fn validate_message_ids(message_ids: &[String]) -> Result<(), MailError> {
    if message_ids.is_empty()
        || message_ids.len() > MAX_BATCH_MODIFY_MESSAGE_IDS
        || message_ids.iter().any(String::is_empty)
    {
        return Err(MailError::InvalidRequest {
            field: "messageIds".to_string(),
        });
    }
    let unique: HashSet<&str> = message_ids.iter().map(String::as_str).collect();
    if unique.len() != message_ids.len() {
        return Err(MailError::InvalidRequest {
            field: "messageIds".to_string(),
        });
    }
    Ok(())
}

fn classify_mutation_forbidden(body: &str) -> MailError {
    const MAX_REASONS_EXAMINED: usize = 10;
    let Ok(json) = serde_json::from_str::<Value>(body) else {
        return MailError::ProviderRejected;
    };
    let error = json.get("error");
    let reasons: Vec<&str> = error
        .and_then(|error| error.get("errors"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| entry.get("reason").and_then(Value::as_str))
        .take(MAX_REASONS_EXAMINED)
        .collect();
    if reasons
        .iter()
        .any(|reason| QUOTA_ERROR_REASONS.contains(reason))
        || error
            .and_then(|error| error.get("status"))
            .and_then(Value::as_str)
            == Some("RESOURCE_EXHAUSTED")
    {
        return MailError::RateLimited;
    }
    if reasons.contains(&"insufficientPermissions")
        || error
            .and_then(|error| error.get("status"))
            .and_then(Value::as_str)
            == Some("PERMISSION_DENIED")
    {
        return MailError::PermissionRequired;
    }
    MailError::ProviderRejected
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

pub(super) use super::parse::parse_thread;
use super::parse::{optional_array, optional_string, parse_history, parse_json, str_field};

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

#[cfg(test)]
#[path = "provider/tests.rs"]
pub(crate) mod tests;

#[path = "provider/api.rs"]
mod api;
