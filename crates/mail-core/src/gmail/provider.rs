//! Gmail provider: the synchronous [`GmailReadProvider`] backing the cache/sync
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

use base64::Engine;
use reqwest::blocking::Client;
use reqwest::StatusCode;
use serde_json::Value;

use crate::drafts::types::{
    ReplyContext, MAX_REPLY_HEADER_BYTES, MAX_REPLY_REFERENCES, MAX_REPLY_TO_RECIPIENTS,
};
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

/// Bound on work retained from one nested Gmail history response.
const MAX_HISTORY_RECORDS: usize = 10_000;
const MAX_CHANGED_THREAD_IDS: usize = 1_000;
const MAX_DELETED_MESSAGE_IDS: usize = 5_000;
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

    /// Takes a consistent in-process snapshot for credential publication.
    /// The lock is never held during provider I/O or interactive OAuth.
    fn credential_snapshot(&self) -> Result<(Option<TokenBundle>, u64, u64), MailError> {
        let publication = self
            .credential_publication
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
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
        let mut publication = self
            .credential_publication
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
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
            .ok_or(MailError::StorageUnavailable)?;
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
        let (bundle, _, _) = self.credential_snapshot()?;
        let bundle = bundle.ok_or(MailError::AuthRequired)?;
        if bundle.expires_at_epoch_ms - EXPIRY_SKEW_MS > now_ms() && !bundle.access_token.is_empty()
        {
            return Ok(bundle.access_token);
        }
        let _refresh_guard = self
            .refresh_lock
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;

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
                return Ok(latest.access_token);
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
                        return Ok(current.access_token);
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
                return Ok(updated.access_token);
            }
            // A connect, upgrade, or disconnect won while the readonly refresh
            // was in flight. Re-read and use its authorized token or refresh it.
        }
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

#[cfg(test)]
#[path = "reply_context_tests.rs"]
mod reply_context_tests;

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

impl GmailReadProvider for GmailProvider {
    fn mutation_access(&self) -> Result<bool, MailError> {
        let Some(bundle) = self.secrets.load()? else {
            return Ok(false);
        };
        let bound = bundle
            .account_id
            .as_ref()
            .or(bundle.email.as_ref())
            .is_some_and(|account| !account.is_empty());
        Ok(bundle.gmail_modify_granted
            && bound
            && (!bundle.access_token.is_empty() || bundle.refresh_token.is_some()))
    }

    fn enable_mutations(&self, cancel: &CancelToken) -> Result<GmailProfile, MailError> {
        if !self.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let (previous, publication_revision, previous_non_refresh_revision) =
            self.credential_snapshot()?;
        let previous = previous.ok_or(MailError::AuthRequired)?;
        let bound_account = previous
            .account_id
            .as_ref()
            .or(previous.email.as_ref())
            .filter(|account| !account.is_empty())
            .ok_or(MailError::AuthRequired)?
            .clone();
        if previous.access_token.is_empty() && previous.refresh_token.is_none() {
            return Err(MailError::AuthRequired);
        }
        let grant = auth::authorize(
            &self.config,
            &self.endpoints,
            &self.opener,
            auth::GMAIL_MODIFY_SCOPE,
            cancel,
            auth::AUTH_TIMEOUT,
        )?;
        let tokens =
            auth::exchange_code(&self.config, &self.endpoints, &self.http, &grant, cancel)?;
        if !tokens.scope.as_deref().is_some_and(scope_grants_modify) {
            return Err(MailError::PermissionRequired);
        }
        let profile = self.fetch_profile(&tokens.access_token, cancel)?;
        if profile.account_id != bound_account {
            return Err(MailError::AuthFailed);
        }
        // Cancellation remains effective through the final pre-commit point.
        // Once this store succeeds, a late cancel is merely completion.
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let mut publication = self
            .credential_publication
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        if cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let current = self.secrets.load()?;
        if publication.revision == publication_revision && current.as_ref() == Some(&previous) {
            let bundle = TokenBundle {
                access_token: tokens.access_token,
                expires_at_epoch_ms: tokens.expires_at_epoch_ms,
                refresh_token: tokens.refresh_token.or(previous.refresh_token),
                account_id: Some(profile.account_id.clone()),
                email: Some(profile.email_address.clone()),
                gmail_modify_granted: true,
            };
            self.publish_bundle_locked(
                &mut publication,
                &bundle,
                CredentialPublicationKind::AccountChange,
            )?;
            return Ok(profile);
        }

        // Rebase across refreshes only. A concurrent connect, upgrade, or
        // disconnect invalidates the interactive result rather than allowing
        // an older OAuth exchange to replace that newer publication.
        let current = current.ok_or(MailError::AuthRequired)?;
        if bundle_account_id(&current) != Some(profile.account_id.as_str()) {
            return Err(MailError::AuthFailed);
        }
        if publication.last_non_refresh_revision != previous_non_refresh_revision {
            if current.gmail_modify_granted {
                return Ok(profile);
            }
            if previous.gmail_modify_granted {
                return Err(MailError::PermissionRequired);
            }
            return Err(MailError::Busy);
        }
        if current.gmail_modify_granted {
            return Ok(profile);
        }
        if previous.gmail_modify_granted {
            return Err(MailError::PermissionRequired);
        }
        let bundle = TokenBundle {
            access_token: tokens.access_token,
            expires_at_epoch_ms: tokens.expires_at_epoch_ms,
            refresh_token: tokens.refresh_token.or(current.refresh_token),
            account_id: Some(profile.account_id.clone()),
            email: Some(profile.email_address.clone()),
            gmail_modify_granted: true,
        };
        self.publish_bundle_locked(
            &mut publication,
            &bundle,
            CredentialPublicationKind::AccountChange,
        )?;
        Ok(profile)
    }

    fn apply_archive(
        &self,
        message_ids: &[String],
        archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply_label_setter(message_ids, !archived, "INBOX", cancel)
    }

    fn apply_read(
        &self,
        message_ids: &[String],
        read: bool,
        cancel: &CancelToken,
    ) -> Result<(), MailError> {
        self.apply_label_setter(message_ids, !read, "UNREAD", cancel)
    }

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
        let (previous, publication_revision, previous_non_refresh_revision) =
            self.credential_snapshot()?;
        let prior_modify_grant = previous
            .as_ref()
            .is_some_and(|bundle| bundle.gmail_modify_granted);
        let requested_scope = if prior_modify_grant {
            auth::GMAIL_MODIFY_SCOPE
        } else {
            auth::GMAIL_READONLY_SCOPE
        };
        let grant = auth::authorize(
            &self.config,
            &self.endpoints,
            &self.opener,
            requested_scope,
            cancel,
            auth::AUTH_TIMEOUT,
        )?;
        let tokens =
            auth::exchange_code(&self.config, &self.endpoints, &self.http, &grant, cancel)?;
        let returned_scope = tokens.scope.clone();
        let returned_refresh_token = tokens.refresh_token.clone();
        // Preserve a stored refresh token when the grant response omits it.
        let bundle = TokenBundle {
            access_token: tokens.access_token,
            expires_at_epoch_ms: tokens.expires_at_epoch_ms,
            refresh_token: tokens
                .refresh_token
                .or_else(|| previous.as_ref().and_then(|p| p.refresh_token.clone())),
            account_id: previous.as_ref().and_then(|p| p.account_id.clone()),
            email: previous.as_ref().and_then(|p| p.email.clone()),
            // Requested scope alone is never evidence of a grant. Existing
            // explicit access survives an omitted scope response; a present
            // response is authoritative and can revoke it.
            gmail_modify_granted: prior_modify_grant
                && returned_scope
                    .as_deref()
                    .map(scope_grants_modify)
                    .unwrap_or(true),
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
        let mut publication = self
            .credential_publication
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let current = self.secrets.load()?;
        if publication.revision == publication_revision && current == previous {
            self.publish_bundle_locked(
                &mut publication,
                &bundle,
                CredentialPublicationKind::AccountChange,
            )?;
            return Ok(profile);
        }

        // A refreshed token may replace the original snapshot while interactive
        // OAuth is open. Rebase only over refresh-only publications, preserving
        // the current fallback credential and the authoritative returned scope.
        let current = current.ok_or(MailError::AuthRequired)?;
        if bundle_account_id(&current) != Some(profile.account_id.as_str()) {
            return Err(MailError::AuthFailed);
        }
        if publication.last_non_refresh_revision != previous_non_refresh_revision {
            return Err(MailError::Busy);
        }
        let rebased = TokenBundle {
            access_token: bundle.access_token,
            expires_at_epoch_ms: bundle.expires_at_epoch_ms,
            refresh_token: returned_refresh_token.or(current.refresh_token),
            account_id: Some(profile.account_id.clone()),
            email: Some(profile.email_address.clone()),
            // An omitted scope cannot restore a grant revoked by an
            // intervening refresh; a present scope remains authoritative.
            gmail_modify_granted: prior_modify_grant
                && returned_scope
                    .as_deref()
                    .map(scope_grants_modify)
                    .unwrap_or(current.gmail_modify_granted),
        };
        self.publish_bundle_locked(
            &mut publication,
            &rebased,
            CredentialPublicationKind::AccountChange,
        )?;
        Ok(profile)
    }

    fn disconnect(&self) -> Result<(), MailError> {
        let mut publication = self
            .credential_publication
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let next_revision = publication
            .revision
            .checked_add(1)
            .ok_or(MailError::StorageUnavailable)?;
        self.secrets.clear()?;
        publication.revision = next_revision;
        publication.last_non_refresh_revision = next_revision;
        Ok(())
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
    let mut message_ids = Vec::with_capacity(messages.len());
    let mut unread_message_ids = Vec::new();
    let mut no_plain_text = 0usize;
    let mut attachments = false;
    let mut omitted_inline_content = false;
    let mut latest_payload: Option<&Value> = None;
    let mut latest_key: Option<(String, String)> = None;
    for message in messages {
        let id = str_field(message, "id")?;
        let key = (message_sent_at(message), id.clone());
        if latest_key.as_ref().is_none_or(|current| key > *current) {
            latest_key = Some(key);
            latest_payload = Some(message);
        }
        let labels = optional_string_array(message, "labelIds")?.unwrap_or_default();
        if labels.contains(&"INBOX") {
            inbox_message_ids.push(id.clone());
        }
        if labels.contains(&"UNREAD") {
            unread_message_ids.push(id.clone());
        }
        message_ids.push(id.clone());
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
    let reply_context = latest_payload.and_then(|message| {
        let source_message_id = message.get("id")?.as_str()?;
        let payload = message.get("payload")?;
        parse_reply_context(payload, source_message_id)
    });
    let conversation = Conversation {
        conversation_ref: ConversationRef {
            account_id: account_id.to_string(),
            conversation_id: thread_id.to_string(),
        },
        subject,
        messages: parsed.into_iter().map(|(message, _)| message).collect(),
        is_in_inbox: !inbox_message_ids.is_empty(),
        is_read: Some(unread_message_ids.is_empty()),
        context_complete: Some(no_plain_text == 0 && !attachments && !omitted_inline_content),
        unsupported_reason: (!reasons.is_empty()).then(|| reasons.join("; ")),
        retained_snapshot_at: None,
        reply_context,
        pending_operation_id: None,
    };
    Ok(GmailThread {
        conversation,
        inbox_message_ids,
        message_ids: Some(message_ids),
        unread_message_ids: Some(unread_message_ids),
        history_id,
    })
}

fn message_sent_at(message: &Value) -> String {
    message
        .get("internalDate")
        .and_then(Value::as_str)
        .and_then(|ms| ms.parse::<i64>().ok())
        .and_then(chrono::DateTime::from_timestamp_millis)
        .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        .or_else(|| {
            let date = message
                .get("payload")
                .map(|payload| json_header_value(payload, "Date"))
                .unwrap_or_default();
            (!date.is_empty())
                .then(|| mailparse::dateparse(&date).ok())
                .flatten()
                .and_then(|timestamp| chrono::DateTime::from_timestamp(timestamp, 0))
                .map(|dt| dt.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))
        })
        .unwrap_or_default()
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
    let sent_at = message_sent_at(message);
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

/// Header values are left raw for strict metadata parsing; callers decide
/// whether malformed controls invalidate metadata or are flattened for display.
fn raw_header_values<'a>(payload: &'a Value, name: &str) -> Vec<Option<&'a str>> {
    payload
        .get("headers")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter(|header| {
            header
                .get("name")
                .and_then(Value::as_str)
                .is_some_and(|n| n.eq_ignore_ascii_case(name))
        })
        .map(|header| header.get("value").and_then(Value::as_str))
        .collect()
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

/// Derives safe, plain mailbox and RFC threading metadata from one full Gmail
/// payload. Any ambiguity or malformed header makes only reply preparation
/// unavailable; ordinary reading remains independent of this result.
fn parse_reply_context(payload: &Value, source_message_id: &str) -> Option<ReplyContext> {
    let from = parse_single_mailbox_header(payload, "From")?;
    let reply_to_headers = raw_header_values(payload, "Reply-To");
    let reply_to_mailboxes = match reply_to_headers.as_slice() {
        [] => None,
        [Some(value)] => Some(parse_mailbox_list(value, true)?),
        _ => return None,
    };
    let message_id = single_message_id(payload, "Message-ID")?;
    let reference_headers = raw_header_values(payload, "References");
    let mut references = match reference_headers.as_slice() {
        [Some(value)] => parse_message_id_list(value)?,
        [] => {
            let in_reply_to = raw_header_values(payload, "In-Reply-To");
            match in_reply_to.as_slice() {
                [] => Vec::new(),
                [Some(value)] => vec![parse_single_message_id(value)?],
                _ => return None,
            }
        }
        _ => return None,
    };
    references.retain(|id| id != &message_id);
    references.push(message_id.clone());
    let total_bytes = references.iter().try_fold(0usize, |total, id| {
        total
            .checked_add(id.len())?
            .checked_add(usize::from(total > 0))
    })?;
    if references.len() > MAX_REPLY_REFERENCES || total_bytes > MAX_REPLY_HEADER_BYTES {
        return None;
    }
    Some(ReplyContext {
        source_message_id: source_message_id.to_string(),
        from_mailbox: from,
        reply_to_mailboxes,
        message_id,
        references,
    })
}

fn parse_single_mailbox_header(payload: &Value, name: &str) -> Option<String> {
    let headers = raw_header_values(payload, name);
    let [Some(value)] = headers.as_slice() else {
        return None;
    };
    let mailboxes = parse_mailbox_list(value, false)?;
    (mailboxes.len() == 1).then(|| mailboxes.into_iter().next().unwrap())
}

/// Parses the original mailbox grammar before any RFC2047 display-name decode.
/// Groups are rejected for reply metadata even though reader display flattens them.
fn parse_mailbox_list(value: &str, allow_multiple: bool) -> Option<Vec<String>> {
    if value.len() > MAX_REPLY_HEADER_BYTES
        || value.chars().any(char::is_control)
        || value.trim_end().ends_with(',')
        || has_unquoted_semicolon(value)
        || has_addr_spec_in_unquoted_phrase(value)
    {
        return None;
    }
    let mut raw = String::from("From: ");
    raw.push_str(value);
    raw.push_str("\r\n");
    let (header, _) = mailparse::parse_header(raw.as_bytes()).ok()?;
    let list = mailparse::addrparse_header(&header).ok()?;
    let mut mailboxes = Vec::new();
    for address in list.iter() {
        let mailparse::MailAddr::Single(info) = address else {
            return None;
        };
        let mailbox = info.addr.as_str();
        if !valid_mailbox(mailbox) {
            return None;
        }
        mailboxes.push(mailbox.to_string());
        if mailboxes.len() > MAX_REPLY_TO_RECIPIENTS {
            return None;
        }
    }
    if mailboxes.is_empty() || (!allow_multiple && mailboxes.len() != 1) {
        return None;
    }
    Some(mailboxes)
}

fn has_addr_spec_in_unquoted_phrase(value: &str) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    let mut comment_depth = 0usize;
    let mut in_angle_address = false;
    let mut phrase_has_at = false;

    for character in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if character == '\\' && (quoted || comment_depth > 0) {
            escaped = true;
            continue;
        }
        if comment_depth > 0 {
            match character {
                '(' => comment_depth += 1,
                ')' => comment_depth -= 1,
                _ => {}
            }
            continue;
        }
        if quoted {
            if character == '"' {
                quoted = false;
            }
            continue;
        }
        match character {
            '"' => quoted = true,
            '(' => comment_depth = 1,
            '<' if !in_angle_address => {
                if phrase_has_at {
                    return true;
                }
                in_angle_address = true;
            }
            '>' if in_angle_address => in_angle_address = false,
            ',' if !in_angle_address => phrase_has_at = false,
            '@' if !in_angle_address => phrase_has_at = true,
            _ => {}
        }
    }
    false
}

fn has_unquoted_semicolon(value: &str) -> bool {
    let mut quoted = false;
    let mut escaped = false;
    for character in value.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        match character {
            '\\' if quoted => escaped = true,
            '"' => quoted = !quoted,
            ';' if !quoted => return true,
            _ => {}
        }
    }
    false
}

fn valid_mailbox(mailbox: &str) -> bool {
    if mailbox.is_empty()
        || mailbox.len() > 254
        || mailbox.chars().any(char::is_control)
        || mailbox.chars().any(char::is_whitespace)
    {
        return false;
    }
    let Some((local, domain)) = mailbox.split_once('@') else {
        return false;
    };
    !local.is_empty()
        && !domain.is_empty()
        && !domain.contains('@')
        && local.is_ascii()
        && domain.is_ascii()
}

fn single_message_id(payload: &Value, name: &str) -> Option<String> {
    let headers = raw_header_values(payload, name);
    let [Some(value)] = headers.as_slice() else {
        return None;
    };
    parse_single_message_id(value)
}

fn parse_single_message_id(value: &str) -> Option<String> {
    if value.len() > MAX_REPLY_HEADER_BYTES
        || !value.is_ascii()
        || value
            .chars()
            .any(|ch| ch.is_control() || ch.is_whitespace())
        || !value.starts_with('<')
        || !value.ends_with('>')
    {
        return None;
    }
    let inner = &value[1..value.len().checked_sub(1)?];
    let (left, right) = inner.split_once('@')?;
    if right.contains('@') || !valid_dot_atom(left, false) || !valid_dot_atom(right, true) {
        return None;
    }
    Some(value.to_string())
}

fn valid_dot_atom(value: &str, domain: bool) -> bool {
    if value.is_empty() {
        return false;
    }
    value.split('.').all(|atom| {
        !atom.is_empty()
            && atom.bytes().all(|byte| {
                byte.is_ascii_alphanumeric()
                    || (domain && byte == b'-')
                    || (!domain && b"!#$%&'*+-/=?^_`{|}~".contains(&byte))
            })
            && (!domain
                || (atom
                    .as_bytes()
                    .first()
                    .is_some_and(|byte| byte.is_ascii_alphanumeric())
                    && atom
                        .as_bytes()
                        .last()
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())))
    })
}

fn parse_message_id_list(value: &str) -> Option<Vec<String>> {
    if value.len() > MAX_REPLY_HEADER_BYTES
        || !value.is_ascii()
        || value.chars().any(char::is_control)
    {
        return None;
    }
    if value.trim().is_empty() {
        return None;
    }
    let mut ids = Vec::new();
    for token in value.split_ascii_whitespace() {
        ids.push(parse_single_message_id(token)?);
        if ids.len() > MAX_REPLY_REFERENCES {
            return None;
        }
    }
    Some(ids)
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
                        .map(|(prefix, status, body)| {
                            (prefix.to_string(), status, body.to_string())
                        })
                        .collect(),
                ),
                requests: Mutex::new(Vec::new()),
                bodies: Mutex::new(Vec::new()),
                authorization_headers: Mutex::new(Vec::new()),
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

        let bodies: Vec<Value> = api
            .bodies()
            .iter()
            .map(|body| serde_json::from_str(body).unwrap())
            .collect();
        assert_eq!(bodies.len(), 4);
        for body in &bodies {
            assert_eq!(body["ids"], json!(ids));
        }
        assert_eq!(bodies[0], json!({"ids": ids, "removeLabelIds": ["INBOX"]}));
        assert_eq!(bodies[1], json!({"ids": ids, "addLabelIds": ["INBOX"]}));
        assert_eq!(bodies[2], json!({"ids": ids, "removeLabelIds": ["UNREAD"]}));
        assert_eq!(bodies[3], json!({"ids": ids, "addLabelIds": ["UNREAD"]}));
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
        let old_refresh =
            std::thread::spawn(move || refresh_provider.profile(&CancelToken::default()));
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
        let stale_reauth =
            std::thread::spawn(move || stale_provider.connect(&CancelToken::default()));
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
        let old_refresh =
            std::thread::spawn(move || refresh_provider.profile(&CancelToken::default()));
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
}
