//! Gmail cache, sync, and mailbox-action facade (`GmailCore`) plus its single
//! serial background worker (docs/vertical-slice-03.md). Sync
//! starts independently of any UI lifecycle; provider calls run on the
//! worker thread strictly outside SQLite locks; all checkpointed writes are
//! transactional and drop any result that raced a disconnect. No mail
//! content, addresses, or credentials are ever logged.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use crate::clock::{Clock, SystemClock};
use crate::dto::{
    Address, Conversation, ConversationRef, InboxSnapshot, Message, OperationReceipt,
    RetryOperation, SetArchived, SetRead, UndoOperation, UndoReceipt,
};
use crate::error::MailError;
use crate::gmail::store::{
    Commit, DiscoveryProgress, GmailStore, HistoryProgress, ThreadFetch, DISCOVERY_CAP,
};
use crate::gmail::types::{
    AccountStatus, ConnectionState, GmailProvider, GmailThread, MailMode, MutationAccess, SyncInfo,
    SyncState,
};
use crate::lock::ProfileGuard;
use crate::storage_log::storage_err;
use crate::CancelToken;

/// Disclosed discovery cap (`SyncInfo.coverageLimit`).
pub const COVERAGE_LIMIT: usize = DISCOVERY_CAP;

/// Periodic catch-up interval between sync passes when idle.
const PERIODIC_INTERVAL: Duration = Duration::from_secs(60);

/// Backoff ceiling after failed passes; requests always wake immediately.
const MAX_BACKOFF_INTERVAL: Duration = Duration::from_secs(600);

/// Generous shutdown/disconnect budget. A paused fake provider is cancelled
/// long before this expires; if the join still times out the thread detaches
/// while holding its own profile-lock reference, so storage stays exclusively
/// owned and interrupted work stays durable for the next launch.
const STOP_JOIN_TIMEOUT: Duration = Duration::from_secs(5);
const DISCONNECT_IDLE_TIMEOUT: Duration = Duration::from_secs(5);

/// Bound on cursor-expiry rediscovery restarts within one pass.
const MAX_REDISCOVERY_RESTARTS: u32 = 3;
/// A pass yields after this many pages; every successful page remains durable.
const MAX_PAGES_PER_STAGE: usize = 100;
/// Bounds the provider's inbox thread ids per discovery page (the real API
/// is requested to return 25).
const MAX_DISCOVERY_IDS_PER_PAGE: usize = 100;
/// Bounds work for nested history records, which can name multiple threads.
const MAX_HISTORY_IDS_PER_PAGE: usize = 1_000;
/// Bound the aggregate live thread DTOs retained before a page is committed.
const MAX_RETAINED_THREAD_BYTES_PER_PAGE: usize = 16 * 1024 * 1024;

/// Cloneable, thread-safe facade over one Gmail profile. Cheap to hold from a
/// thin async Tauri shell; blocking store calls stay inside these methods so
/// the shell can wrap them in a blocking boundary.
pub struct GmailCore {
    inner: Arc<GmailInner>,
}

struct GmailInner {
    search_cancel: Mutex<Option<CancelToken>>,
    store: Arc<GmailStore>,
    provider: Arc<dyn GmailProvider>,
    /// Profile lock is owned for the full core lifetime and additionally
    /// shared with the worker thread: a running or detached worker can never
    /// outlive the lock (a second writer is rejected instead of two
    /// processes corrupting the database).
    #[allow(dead_code)] // retention is the point; the guard is never read
    profile: Arc<ProfileGuard>,
    ctrl: Arc<Ctrl>,
    hub: Arc<GmailHub>,
    next_listener_id: AtomicU64,
    /// Serializes concurrent `disconnect_account` calls.
    disconnect_lock: Mutex<()>,
    worker: Mutex<Option<JoinHandle<()>>>,
    next_enrichment_id: AtomicU64,
}

/// Worker/control state. The worker thread is the only writer of `connection`
/// and `error` besides the disconnect path, which owns them while a
/// disconnect completes.
struct Ctrl {
    state: Mutex<CtrlState>,
    wake: Condvar,
    #[cfg(test)]
    after_mutation_count: Mutex<Option<MutationCountHook>>,
}

#[cfg(test)]
type MutationCountHook = Box<dyn FnOnce(bool) + Send>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AuthKind {
    /// User-initiated connect: run the provider's full auth flow.
    Connect,
    /// Startup restore: detect existing credentials and read the profile.
    Restore,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PassAction {
    Auth(AuthKind),
    Sync,
    MutationUpgrade,
    Mutations,
}

impl PassAction {
    fn is_auth(self) -> bool {
        matches!(self, PassAction::Auth(_))
    }
}

struct CtrlState {
    stop: bool,
    /// Persistence failure halted the worker thread; commands report typed
    /// errors until the app restarts.
    halted: bool,
    auth_requested: bool,
    auth_kind: AuthKind,
    auth_auto_retry: bool,
    sync_requested: bool,
    reminder_work: bool,
    operations_requested: bool,
    upgrade_requested: bool,
    upgrade_in_flight: bool,
    active_action: Option<PassAction>,
    pass_in_flight: bool,
    disconnecting: bool,
    pass_cancel: CancelToken,
    reply_enrichments: HashMap<u64, CancelToken>,
    /// Cancel token of the single admitted live destination/catalog read.
    /// `None` means no live destination job is active; overlaps are typed
    /// `Busy` instead of accumulating unbounded provider reads.
    destination_read: Option<CancelToken>,
    reminder_read: Option<CancelToken>,
    connection: ConnectionState,
    error: Option<MailError>,
    backoff: u32,
    #[cfg(test)]
    wait_divisor: u32,
    #[cfg(test)]
    test_wait_cycles: usize,
    #[cfg(test)]
    test_sync_deadline: Option<Instant>,
    #[cfg(test)]
    test_reminder_deadline: Option<Instant>,
    #[cfg(test)]
    test_tick_due: bool,
    #[cfg(any(test, feature = "test-support"))]
    operations_paused: bool,
}

#[inline]
fn test_operations_paused(state: &CtrlState) -> bool {
    #[cfg(any(test, feature = "test-support"))]
    {
        state.operations_paused
    }
    #[cfg(not(any(test, feature = "test-support")))]
    {
        let _ = state;
        false
    }
}

fn cancel_independent_reads(st: &mut CtrlState) {
    for cancel in st.reply_enrichments.values() {
        cancel.cancel();
    }
    if let Some(cancel) = &st.destination_read {
        cancel.cancel();
    }
    if let Some(cancel) = &st.reminder_read {
        cancel.cancel();
    }
}

/// Registration for one independent readonly reply-metadata provider call.
/// Its token is not tied to the reusable background-worker pass token.
struct ReplyEnrichment {
    ctrl: Arc<Ctrl>,
    id: u64,
    cancel: CancelToken,
}

impl Drop for ReplyEnrichment {
    fn drop(&mut self) {
        let mut st = self.ctrl.state.lock().expect("gmail ctrl poisoned");
        st.reply_enrichments.remove(&self.id);
        self.ctrl.wake.notify_all();
    }
}

/// Admission for one live destination/catalog read. At most one such job is
/// active at a time; an overlapping request is typed `Busy` instead of
/// accumulating abandoned navigation jobs that each consume provider reads.
/// The guard releases admission — and wakes disconnect/shutdown waiters — on
/// success, provider error, cancellation and shutdown alike.
struct DestinationRead {
    ctrl: Arc<Ctrl>,
    cancel: CancelToken,
}

impl DestinationRead {
    fn begin(ctrl: &Arc<Ctrl>) -> Result<Self, MailError> {
        let mut st = ctrl.state.lock().map_err(storage_err())?;
        if st.stop || st.halted {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        if st.destination_read.is_some() {
            return Err(MailError::Busy);
        }
        let cancel = CancelToken::default();
        st.destination_read = Some(cancel.clone());
        Ok(Self {
            ctrl: Arc::clone(ctrl),
            cancel,
        })
    }
}

impl Drop for DestinationRead {
    fn drop(&mut self) {
        // Admission is exclusive: the slot can only hold this guard's token
        // while the guard is alive, so clearing unconditionally is exact.
        let mut st = self.ctrl.state.lock().expect("gmail ctrl poisoned");
        st.destination_read = None;
        self.ctrl.wake.notify_all();
    }
}

/// Latches persistence failures found before a mutation reaches its durable
/// acceptance transaction, so already-queued work cannot run after recovery.
fn latch_admission_storage_error(st: &mut CtrlState, ctrl: &Ctrl, error: &MailError) -> bool {
    if *error != MailError::StorageUnavailable {
        return false;
    }
    st.halted = true;
    st.error = Some(error.clone());
    st.pass_cancel.cancel();
    cancel_independent_reads(st);
    ctrl.wake.notify_all();
    true
}

/// Outcome of one worker pass.
enum PassOutcome {
    /// Stages ran (or auth completed and stages ran): clear the error slot.
    Complete,
    /// Nothing runnable; state untouched (keeps stale errors visible).
    Idle,
    /// The auth attempt itself failed; the caller maps the connection state.
    AuthError { error: MailError },
    /// A sync stage failed after auth was fine.
    SyncError(MailError),
    /// Persistence failure: the worker halts and the error stays visible.
    Halt(MailError),
    /// Shutdown/disconnect cancellation; disconnect owns the state.
    Cancelled,
}

enum StageOutcome {
    Complete,
    ExpiredRestart,
    SyncError(MailError),
    Halt(MailError),
    Cancelled,
}

impl GmailCore {
    /// Opens (or creates) the Gmail profile storage under `profile_dir`,
    /// acquires the profile lock for the full core lifetime, detects startup
    /// credentials, and starts the serial background worker (independent of
    /// any UI lifecycle). The provider is injected by the caller; production
    /// wires the auth component's Gmail provider, tests inject fakes.
    pub fn open(
        profile_dir: impl AsRef<Path>,
        provider: Arc<dyn GmailProvider>,
    ) -> Result<GmailCore, MailError> {
        Self::open_with_clock(profile_dir, provider, Arc::new(SystemClock))
    }

    /// Like [`Self::open`] with an injectable clock; tests inject
    /// [`crate::clock::FakeClock`] for deterministic undo-window behavior.
    pub fn open_with_clock(
        profile_dir: impl AsRef<Path>,
        provider: Arc<dyn GmailProvider>,
        clock: Arc<dyn Clock>,
    ) -> Result<GmailCore, MailError> {
        Self::open_with_clock_config(profile_dir, provider, clock, false)
    }

    /// Test seam that keeps queued mailbox mutations durable until explicitly
    /// released. Authentication, synchronization, reminders, and storage use
    /// the same worker and stores as the normal constructor.
    #[cfg(any(test, feature = "test-support"))]
    pub fn open_with_clock_and_operations_paused(
        profile_dir: impl AsRef<Path>,
        provider: Arc<dyn GmailProvider>,
        clock: Arc<dyn Clock>,
    ) -> Result<GmailCore, MailError> {
        Self::open_with_clock_config(profile_dir, provider, clock, true)
    }

    fn open_with_clock_config(
        profile_dir: impl AsRef<Path>,
        provider: Arc<dyn GmailProvider>,
        clock: Arc<dyn Clock>,
        operations_paused: bool,
    ) -> Result<GmailCore, MailError> {
        #[cfg(not(any(test, feature = "test-support")))]
        let _ = operations_paused;
        let profile_dir = profile_dir.as_ref();
        let profile = Arc::new(ProfileGuard::acquire(profile_dir)?);
        let store = Arc::new(GmailStore::open(profile_dir, clock)?);

        // Startup credential detection; sync starts independently of Vue.
        let (connection, error, restore) = if !provider.is_configured() {
            (ConnectionState::NotConfigured, None, false)
        } else {
            match provider.has_credentials() {
                Ok(true) => {
                    // Even a cached account must validate restored credentials
                    // with the provider before any sync pass can run.
                    (ConnectionState::Authenticating, None, true)
                }
                Ok(false) => (credentialless_connection(store.has_account()?), None, false),
                Err(error) => (
                    credentialless_connection(store.has_account()?),
                    Some(error),
                    false,
                ),
            }
        };

        let ctrl = Arc::new(Ctrl {
            state: Mutex::new(CtrlState {
                stop: false,
                halted: false,
                auth_requested: restore,
                auth_kind: AuthKind::Restore,
                auth_auto_retry: false,
                sync_requested: false,
                reminder_work: false,
                operations_requested: true,
                upgrade_requested: false,
                upgrade_in_flight: false,
                active_action: None,
                pass_in_flight: false,
                disconnecting: false,
                pass_cancel: CancelToken::default(),
                reply_enrichments: HashMap::new(),
                destination_read: None,
                reminder_read: None,
                connection,
                error,
                backoff: 0,
                #[cfg(test)]
                wait_divisor: 1,
                #[cfg(test)]
                test_wait_cycles: 0,
                #[cfg(test)]
                test_sync_deadline: None,
                #[cfg(test)]
                test_reminder_deadline: None,
                #[cfg(test)]
                test_tick_due: false,
                #[cfg(any(test, feature = "test-support"))]
                operations_paused,
            }),
            wake: Condvar::new(),
            #[cfg(test)]
            after_mutation_count: Mutex::new(None),
        });
        let hub = Arc::new(GmailHub {
            listeners: Mutex::new(HashMap::new()),
        });
        let handle = spawn_worker(
            Arc::clone(&store),
            Arc::clone(&provider),
            Arc::clone(&ctrl),
            Arc::clone(&hub),
            Arc::clone(&profile),
        )?;
        Ok(GmailCore {
            inner: Arc::new(GmailInner {
                search_cancel: Mutex::new(None),
                store,
                provider,
                profile,
                ctrl,
                hub,
                next_listener_id: AtomicU64::new(1),
                disconnect_lock: Mutex::new(()),
                worker: Mutex::new(Some(handle)),
                next_enrichment_id: AtomicU64::new(1),
            }),
        })
    }

    /// Release queued mutation work in deterministic integration tests.
    #[cfg(any(test, feature = "test-support"))]
    pub fn release_test_operations(&self) {
        let mut state = self.inner.ctrl.state.lock().expect("gmail ctrl poisoned");
        state.operations_paused = false;
        drop(state);
        self.inner.ctrl.wake.notify_all();
    }

    /// Pause future claims and drain a currently running pass before assertions.
    #[cfg(any(test, feature = "test-support"))]
    pub fn pause_test_operations(&self, timeout: Duration) -> Result<(), MailError> {
        self.inner
            .ctrl
            .state
            .lock()
            .expect("gmail ctrl poisoned")
            .operations_paused = true;
        self.inner.ctrl.wait_until_idle(timeout)
    }

    /// Wait for both accepted worker requests and active reads to drain.
    #[cfg(any(test, feature = "test-support"))]
    pub fn wait_for_test_idle(&self, timeout: Duration) -> Result<(), MailError> {
        let deadline = Instant::now() + timeout;
        let mut st = self.inner.ctrl.state.lock().expect("gmail ctrl poisoned");
        loop {
            let requested = st.auth_requested
                || (st.connection == ConnectionState::Connected
                    && (st.sync_requested
                        || st.upgrade_requested
                        || (st.operations_requested && !st.operations_paused)));
            if !requested
                && !st.pass_in_flight
                && st.reply_enrichments.is_empty()
                && st.destination_read.is_none()
                && st.reminder_read.is_none()
            {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(MailError::Busy);
            }
            st = self
                .inner
                .ctrl
                .wake
                .wait_timeout(st, remaining)
                .expect("gmail ctrl poisoned")
                .0;
        }
    }

    /// Effective inbox plus (empty) activity, served entirely from the local
    /// cache: cached reads survive offline and authentication errors.
    pub fn list_conversations(&self) -> Result<InboxSnapshot, MailError> {
        self.inner.store.list_snapshot()
    }

    pub fn list_reminders(&self) -> Result<Vec<crate::reminders::Reminder>, MailError> {
        self.inner.store.list_reminders()
    }

    pub fn put_reminder(
        &self,
        command: &crate::reminders::PutReminder,
    ) -> Result<crate::reminders::Reminder, MailError> {
        let mut state = self.inner.ctrl.state.lock().map_err(storage_err())?;
        if state.stop || state.halted {
            return Err(MailError::StorageUnavailable);
        }
        if state.disconnecting {
            return Err(MailError::Busy);
        }
        let result = self.inner.store.put_reminder(command);
        if let Err(error) = &result {
            latch_admission_storage_error(&mut state, &self.inner.ctrl, error);
        } else {
            state.reminder_work = true;
        }
        drop(state);
        self.inner.ctrl.wake.notify_all();
        self.inner.hub.dispatch();
        result
    }

    pub fn cancel_reminder(
        &self,
        command: &crate::reminders::CancelReminder,
    ) -> Result<crate::reminders::Reminder, MailError> {
        let mut state = self.inner.ctrl.state.lock().map_err(storage_err())?;
        if state.stop || state.halted {
            return Err(MailError::StorageUnavailable);
        }
        if state.disconnecting {
            return Err(MailError::Busy);
        }
        let result = self.inner.store.cancel_reminder(command);
        if let Err(error) = &result {
            latch_admission_storage_error(&mut state, &self.inner.ctrl, error);
        } else {
            state.reminder_work = true;
        }
        drop(state);
        self.inner.ctrl.wake.notify_all();
        self.inner.hub.dispatch();
        result
    }

    pub fn list_cached_starred(
        &self,
        request: &crate::dto::CachedDoneRequest,
    ) -> Result<crate::dto::CachedDoneSnapshot, MailError> {
        self.inner.store.list_cached_starred(request)
    }

    pub fn get_saved_split(
        &self,
        account: &str,
    ) -> Result<Option<crate::splits::SavedSplit>, MailError> {
        self.inner.store.get_saved_split(account)
    }

    pub fn save_saved_split(
        &self,
        account: &str,
        split: &crate::splits::SavedSplit,
    ) -> Result<crate::splits::SavedSplit, MailError> {
        let saved = self.inner.store.save_saved_split(account, split)?;
        self.inner.hub.dispatch();
        Ok(saved)
    }

    pub fn cancel_search_mail(&self) {
        if let Ok(mut slot) = self.inner.search_cancel.lock() {
            if let Some(cancel) = slot.take() {
                cancel.cancel();
            }
        }
    }

    pub fn search_mail(
        &self,
        request: &crate::search::SearchRequest,
    ) -> Result<crate::search::SearchPage, MailError> {
        let query = crate::search::parse(&request.query)?;
        let generation = self.inner.store.generation()?;
        if self.inner.store.account()?.as_ref().map(|a| &a.account_id) != Some(&request.account_id)
        {
            return Err(MailError::NotFound);
        }
        let status = self.account_status()?;
        if !request.cached_only
            && (status.connection == ConnectionState::AuthRequired
                || matches!(
                    status.sync.error,
                    Some(
                        MailError::AuthRequired
                            | MailError::AuthFailed
                            | MailError::SecretsUnavailable
                    )
                ))
        {
            return Err(MailError::AuthRequired);
        }
        if request.cached_only
            || status.connection != ConnectionState::Connected
            || matches!(status.sync.error, Some(MailError::NetworkUnavailable))
        {
            return self.inner.store.search_mail(request);
        }
        let page_token = match &request.cursor {
            None => None,
            Some(cursor) => {
                let (account, q, token): (String, String, String) = serde_json::from_str(cursor)
                    .map_err(|_| MailError::InvalidRequest {
                        field: "searchCursor".into(),
                    })?;
                if account != request.account_id || q != request.query || cursor.len() > 8192 {
                    return Err(MailError::InvalidRequest {
                        field: "searchCursor".into(),
                    });
                }
                Some(token)
            }
        };
        let work = self.begin_reply_enrichment()?;
        {
            let mut slot = self.inner.search_cancel.lock().map_err(storage_err())?;
            if let Some(old) = slot.replace(work.cancel.clone()) {
                old.cancel();
            }
        }
        let revision = self.inner.store.observation_revision()?;
        let page = self
            .inner
            .provider
            .search_threads(page_token.as_deref(), &work.cancel)?;
        if page.thread_ids.len() > 20
            || page
                .next_page_token
                .as_ref()
                .is_some_and(|p| Some(p) == page_token.as_ref())
        {
            return Err(MailError::InvalidProviderResponse);
        }
        // Reuse sync's identity checks, deduplication and 16 MiB aggregate
        // retained-data budget; search must not bypass provider read bounds.
        let threads: Vec<_> =
            fetch_changed_threads(self.inner.provider.as_ref(), &page.thread_ids, &work.cancel)?
                .into_iter()
                .filter_map(|fetch| match fetch {
                    ThreadFetch::Cached(thread) => Some(*thread),
                    ThreadFetch::Missing(_) => None,
                })
                .collect();
        if work.cancel.is_cancelled() {
            return Err(MailError::NotFound);
        }
        self.inner
            .store
            .save_search(&threads, generation, revision, &request.account_id)?;
        let mut conversations = Vec::new();
        for thread in threads {
            let c = self
                .inner
                .store
                .get_conversation(&thread.conversation.conversation_ref)?;
            if query.matches(&c) {
                conversations.push(crate::search::summary(c));
            }
        }
        Ok(crate::search::SearchPage {
            conversations,
            next_cursor: page
                .next_page_token
                .map(|p| serde_json::to_string(&(&request.account_id, &request.query, p)).unwrap()),
            coverage: crate::search::SearchCoverage::ProviderCandidates,
        })
    }

    pub fn list_cached_trash(
        &self,
        request: &crate::dto::CachedTrashRequest,
    ) -> Result<crate::dto::CachedTrashSnapshot, MailError> {
        self.inner.store.list_cached_trash(request)
    }

    pub fn list_cached_done(
        &self,
        request: &crate::dto::CachedDoneRequest,
    ) -> Result<crate::dto::CachedDoneSnapshot, MailError> {
        self.inner.store.list_cached_done(request)
    }

    /// Cached reader view of one conversation, scoped by the connected account.
    pub fn get_conversation(&self, r#ref: &ConversationRef) -> Result<Conversation, MailError> {
        self.inner.store.get_conversation(r#ref)
    }

    /// Explicit search-result load only. Ordinary cached reads never import
    /// arbitrary historical/deleted rows as a side effect of a cache miss.
    pub fn load_search_conversation(
        &self,
        r#ref: &ConversationRef,
    ) -> Result<Conversation, MailError> {
        match self.inner.store.get_conversation(r#ref) {
            Err(MailError::NotFound) => {
                let generation = self.inner.store.generation()?;
                if self.inner.store.account()?.as_ref().map(|a| &a.account_id)
                    != Some(&r#ref.account_id)
                {
                    return Err(MailError::NotFound);
                }
                if self.account_status()?.connection != ConnectionState::Connected {
                    return Err(MailError::NotFound);
                }
                let work = self.begin_reply_enrichment()?;
                let revision = self.inner.store.observation_revision()?;
                let thread = self
                    .inner
                    .provider
                    .get_thread(&r#ref.conversation_id, &work.cancel)?
                    .ok_or(MailError::NotFound)?;
                if thread.conversation.conversation_ref != *r#ref || work.cancel.is_cancelled() {
                    return Err(MailError::NotFound);
                }
                self.inner
                    .store
                    .save_search(&[thread], generation, revision, &r#ref.account_id)?;
                self.inner.store.get_conversation(r#ref)
            }
            result => result,
        }
    }

    /// Explicit saved catalog read (network-free, stays available offline),
    /// or one live catalog read admitted against the expected authenticated
    /// account. Live reads are bounded to one active job; overlaps are typed
    /// `Busy` instead of accumulating abandoned navigation jobs.
    pub fn list_provider_destinations(
        &self,
        account_id: &str,
        cached: bool,
    ) -> Result<super::browsing::DestinationCatalog, MailError> {
        use super::browsing::*;
        if cached {
            let saved = self.inner.store.destination_snapshot(account_id, "")?;
            return serde_json::from_str(&saved.ok_or(MailError::NotFound)?).map_err(storage_err());
        }
        let job = DestinationRead::begin(&self.inner.ctrl)?;
        let generation = self.inner.store.generation()?;
        // Stored-account preflight: no provider dispatch for a missing or
        // mismatched stored account, even if credentials name the caller.
        self.inner.store.require_destination_account(account_id)?;
        let destinations = self
            .inner
            .provider
            .list_destinations_for_account(account_id, &job.cancel)?;
        validate_catalog(&destinations)?;
        let result = DestinationCatalog {
            account_id: account_id.into(),
            destinations,
            fetched_at: chrono::Utc::now().to_rfc3339(),
        };
        if job.cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let json = serde_json::to_string(&result).map_err(storage_err())?;
        self.inner
            .store
            .save_destination_snapshot(account_id, "", &json, generation)?;
        Ok(result)
    }

    /// Explicit saved page read (network-free, stays available offline), or
    /// one live page read admitted against the expected authenticated
    /// account. Live reads are bounded to one active job; overlaps are typed
    /// `Busy` instead of accumulating abandoned navigation jobs. The SQLite
    /// and control locks are never held across provider network work.
    pub fn browse_provider_destination(
        &self,
        request: &super::browsing::DestinationRequest,
    ) -> Result<super::browsing::DestinationPage, MailError> {
        use super::browsing::*;
        if !valid_id(&request.destination_id)
            || request
                .cursor
                .as_ref()
                .is_some_and(|c| c.is_empty() || c.len() > 8192)
        {
            return Err(invalid());
        }
        if request.cached {
            if request.cursor.is_some() {
                return Err(invalid());
            }
            let json = self
                .inner
                .store
                .destination_snapshot(&request.account_id, &request.destination_id)?
                .ok_or(MailError::NotFound)?;
            let page: DestinationPage = serde_json::from_str(&json).map_err(storage_err())?;
            if page.account_id != request.account_id
                || page.destination_id != request.destination_id
            {
                return Err(invalid());
            }
            return Ok(page);
        }
        let job = DestinationRead::begin(&self.inner.ctrl)?;
        let generation = self.inner.store.generation()?;
        let catalog: DestinationCatalog = serde_json::from_str(
            &self
                .inner
                .store
                .destination_snapshot(&request.account_id, "")?
                .ok_or(MailError::NotFound)?,
        )
        .map_err(storage_err())?;
        if catalog.account_id != request.account_id
            || !catalog
                .destinations
                .iter()
                .any(|d| d.id == request.destination_id)
        {
            return Err(invalid());
        }
        let provider_cursor = request
            .cursor
            .as_ref()
            .map(|cursor| {
                let parts: (String, String, String) =
                    serde_json::from_str(cursor).map_err(|_| invalid())?;
                if parts.0 != request.account_id
                    || parts.1 != request.destination_id
                    || parts.2.is_empty()
                    || parts.2.len() > 4096
                {
                    return Err(invalid());
                }
                Ok(parts.2)
            })
            .transpose()?;
        let page = self.inner.provider.list_destination_for_account(
            &request.account_id,
            &request.destination_id,
            provider_cursor.as_deref(),
            &job.cancel,
        )?;
        if page.thread_ids.len() > 25
            || page.next_page_token.as_ref().is_some_and(|c| {
                c.is_empty() || c.len() > 4096 || Some(c) == provider_cursor.as_ref()
            })
        {
            return Err(MailError::InvalidProviderResponse);
        }
        let mut conversations = vec![];
        let mut seen = HashSet::new();
        let mut bytes = 0usize;
        for id in page.thread_ids {
            if !valid_id(&id) || !seen.insert(id.clone()) {
                return Err(MailError::InvalidProviderResponse);
            }
            if let Some(thread) =
                self.inner
                    .provider
                    .get_thread_for_account(&request.account_id, &id, &job.cancel)?
            {
                if thread.conversation.conversation_ref.account_id != request.account_id
                    || thread.conversation.conversation_ref.conversation_id != id
                {
                    return Err(MailError::InvalidProviderResponse);
                }
                bytes = bytes.saturating_add(
                    serde_json::to_vec(&thread.conversation)
                        .map_err(|_| MailError::InvalidProviderResponse)?
                        .len(),
                );
                if bytes > MAX_RETAINED_THREAD_BYTES_PER_PAGE {
                    return Err(MailError::InvalidProviderResponse);
                }
                conversations.push(thread.conversation);
            }
        }
        if job.cancel.is_cancelled() {
            return Err(MailError::AuthCancelled);
        }
        let result = DestinationPage {
            account_id: request.account_id.clone(),
            destination_id: request.destination_id.clone(),
            conversations,
            next_cursor: page
                .next_page_token
                .map(|token| {
                    serde_json::to_string(&(&request.account_id, &request.destination_id, token))
                })
                .transpose()
                .map_err(storage_err())?,
            fetched_at: chrono::Utc::now().to_rfc3339(),
        };
        let json = serde_json::to_string(&result).map_err(storage_err())?;
        self.inner.store.save_destination_snapshot(
            &request.account_id,
            &request.destination_id,
            &json,
            generation,
        )?;
        Ok(result)
    }

    pub fn list_attachments(
        &self,
        target: &ConversationRef,
    ) -> Result<Vec<crate::attachments::AttachmentDescriptor>, MailError> {
        self.inner.store.list_attachments(target)
    }

    /// Independent readonly fetch registered with the same disconnect/stop barrier
    /// as reply metadata. Its bytes never cross IPC.
    pub fn download_attachment(
        &self,
        request: &crate::attachments::SaveAttachment,
        cancel: &CancelToken,
        directory: &Path,
    ) -> Result<crate::attachments::AttachmentSaved, MailError> {
        let generation = self.inner.store.generation()?;
        let descriptor = self
            .list_attachments(&request.conversation)?
            .into_iter()
            .find(|d| {
                d.message_id == request.message_id && d.attachment_id == request.attachment_id
            })
            .ok_or(MailError::NotFound)?;
        if descriptor.size as usize > crate::attachments::MAX_ATTACHMENT_BYTES {
            return Err(crate::attachments::invalid("attachmentSize"));
        }
        let registration = self.begin_read_transfer(cancel.clone())?;
        crate::attachments::check_cancel(cancel)?;
        if self.inner.store.generation()? != generation {
            return Err(MailError::NotFound);
        }
        // User cancellation is checked by the provider as well as before publication.
        let bytes = self.inner.provider.fetch_attachment(
            &request.conversation.account_id,
            &request.message_id,
            &request.attachment_id,
            cancel,
        )?;
        crate::attachments::check_cancel(&registration.cancel)?;
        crate::attachments::check_cancel(cancel)?;
        // Hold control across the short local save so disconnect cannot complete
        // between generation validation and publication.
        let st = self.inner.ctrl.state.lock().map_err(storage_err())?;
        if st.disconnecting
            || st.stop
            || self.inner.store.generation()? != generation
            || !self
                .list_attachments(&request.conversation)?
                .contains(&descriptor)
        {
            return Err(MailError::NotFound);
        }
        let result = crate::attachments::save_download(directory, &descriptor, &bytes, cancel);
        drop(st);
        result
    }

    fn begin_reply_enrichment(&self) -> Result<ReplyEnrichment, MailError> {
        self.begin_read_transfer(CancelToken::default())
    }

    fn begin_read_transfer(&self, cancel: CancelToken) -> Result<ReplyEnrichment, MailError> {
        let mut st = self.inner.ctrl.state.lock().map_err(storage_err())?;
        if st.stop || st.halted {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        let mut id = self.inner.next_enrichment_id.fetch_add(1, Ordering::SeqCst);
        while st.reply_enrichments.contains_key(&id) {
            id = self.inner.next_enrichment_id.fetch_add(1, Ordering::SeqCst);
        }
        st.reply_enrichments.insert(id, cancel.clone());
        Ok(ReplyEnrichment {
            ctrl: Arc::clone(&self.inner.ctrl),
            id,
            cancel,
        })
    }

    /// Loads reply headers for the explicitly displayed latest cached message.
    /// Ready cache results are network-free; a legacy cache miss performs one
    /// readonly thread read outside control and SQLite locks.
    pub fn load_reply_context(
        &self,
        r#ref: &ConversationRef,
        source_message_id: &str,
    ) -> Result<Conversation, MailError> {
        let generation = self.inner.store.generation()?;
        let cached = self.inner.store.get_conversation(r#ref)?;
        if cached.retained_snapshot_at.is_some()
            || cached.context_complete != Some(true)
            || cached.messages.last().map(|message| message.id.as_str()) != Some(source_message_id)
        {
            return Err(MailError::ReplyUnavailable);
        }
        if let Some(reply_context) = cached.reply_context.as_ref() {
            return if reply_context.source_message_id == source_message_id {
                Ok(cached)
            } else {
                Err(MailError::ReplyUnavailable)
            };
        }

        let _enrichment = self.begin_reply_enrichment()?;
        // The initial cache inspection intentionally precedes admission so
        // ordinary cache hits remain available during lifecycle barriers. If
        // a disconnect completed in that gap, its generation change prevents
        // this stale request from starting a credential-refreshing provider call.
        if self.inner.store.generation()? != generation {
            return Err(MailError::ReplyUnavailable);
        }
        let thread = self
            .inner
            .provider
            .get_thread(&r#ref.conversation_id, &_enrichment.cancel)?
            .ok_or(MailError::ReplyUnavailable)?;
        let fetched = &thread.conversation;
        if fetched.conversation_ref != *r#ref
            || fetched.retained_snapshot_at.is_some()
            || fetched.context_complete != Some(true)
            || fetched.messages.last().map(|message| message.id.as_str()) != Some(source_message_id)
        {
            return Err(MailError::ReplyUnavailable);
        }
        let reply_context = fetched
            .reply_context
            .as_ref()
            .filter(|context| context.source_message_id == source_message_id)
            .ok_or(MailError::ReplyUnavailable)?;
        self.inner
            .store
            .save_reply_context(r#ref, source_message_id, reply_context, generation)?;
        let enriched = match self.inner.store.get_conversation(r#ref) {
            Ok(conversation) => conversation,
            Err(MailError::NotFound) => return Err(MailError::ReplyUnavailable),
            Err(error) => return Err(error),
        };
        if enriched.retained_snapshot_at.is_some()
            || enriched.context_complete != Some(true)
            || enriched.messages.last().map(|message| message.id.as_str())
                != Some(source_message_id)
            || enriched
                .reply_context
                .as_ref()
                .is_none_or(|context| context.source_message_id != source_message_id)
        {
            return Err(MailError::ReplyUnavailable);
        }
        Ok(enriched)
    }

    /// Wire-facing mode/connection/sync status. Typed errors surface storage
    /// failures; connection and sync error hints come from worker outcomes.
    pub fn account_status(&self) -> Result<AccountStatus, MailError> {
        let (connection, mut error, pass_in_flight, upgrading) = {
            let st = self.inner.ctrl.state.lock().map_err(storage_err())?;
            (
                st.connection,
                st.error.clone(),
                st.pass_in_flight,
                st.upgrade_requested || st.upgrade_in_flight,
            )
        };
        let mutation_access = if upgrading {
            MutationAccess::Upgrading
        } else {
            match self.inner.provider.mutation_access() {
                Ok(true) => MutationAccess::Enabled,
                Ok(false) => MutationAccess::ReadOnly,
                Err(capability_error) => {
                    if error.is_none() {
                        error = Some(capability_error);
                    }
                    MutationAccess::ReadOnly
                }
            }
        };
        Ok(AccountStatus {
            mode: MailMode::Gmail,
            mutation_access: Some(mutation_access),
            connection,
            account: self.inner.store.account()?,
            sync: SyncInfo {
                state: if pass_in_flight {
                    SyncState::Syncing
                } else if error.is_some() {
                    SyncState::Error
                } else {
                    SyncState::Idle
                },
                last_synced_at: self.inner.store.last_synced_at()?,
                error,
                cached_conversations: self.inner.store.cached_count()?,
                initial_sync_complete: self.inner.store.discovery_done()?,
                coverage_limit: COVERAGE_LIMIT,
            },
        })
    }

    /// Queues the explicit Gmail permission upgrade. The grant itself runs on
    /// the serial worker and is reflected through `account_status`.
    pub fn enable_mutations(&self) -> Result<(), MailError> {
        let inner = &*self.inner;
        if !inner.provider.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
        if st.halted || st.stop {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        if st.connection != ConnectionState::Connected {
            return Err(MailError::AuthRequired);
        }
        match inner.store.account() {
            Ok(Some(_)) => {}
            Ok(None) => return Err(MailError::AuthRequired),
            Err(error) => {
                if latch_admission_storage_error(&mut st, &inner.ctrl, &error) {
                    drop(st);
                    inner.hub.dispatch();
                }
                return Err(error);
            }
        }
        let mutation_access = match inner.provider.mutation_access() {
            Ok(access) => access,
            Err(error) => {
                if latch_admission_storage_error(&mut st, &inner.ctrl, &error) {
                    drop(st);
                    inner.hub.dispatch();
                }
                return Err(error);
            }
        };
        if mutation_access || st.upgrade_requested || st.upgrade_in_flight {
            return Ok(());
        }
        st.upgrade_requested = true;
        inner.ctrl.wake.notify_all();
        drop(st);
        inner.hub.dispatch();
        Ok(())
    }

    /// Cancels only a queued or active permission-upgrade pass. It does not
    /// revoke a completed grant or cancel sync, restore, or mutation work.
    pub fn cancel_mutation_upgrade(&self) -> Result<(), MailError> {
        let inner = &*self.inner;
        let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
        if st.upgrade_requested {
            st.upgrade_requested = false;
            inner.ctrl.wake.notify_all();
            drop(st);
            inner.hub.dispatch();
            return Ok(());
        }
        if st.upgrade_in_flight && st.active_action == Some(PassAction::MutationUpgrade) {
            st.pass_cancel.cancel();
            inner.ctrl.wake.notify_all();
        }
        Ok(())
    }

    pub fn set_archived(&self, command: &SetArchived) -> Result<OperationReceipt, MailError> {
        self.accept_action(
            &command.conversation.account_id,
            &command.request_id,
            std::slice::from_ref(&command.conversation),
            |store, observation| store.accept_archived_observed(command, observation),
        )
    }

    pub fn set_starred(
        &self,
        command: &crate::stars::SetStarred,
    ) -> Result<OperationReceipt, MailError> {
        self.accept_operation(|store| store.accept_starred(command))
    }
    pub fn set_starred_group(
        &self,
        command: &crate::stars::SetStarredGroup,
    ) -> Result<crate::groups::OperationGroupReceipt, MailError> {
        self.accept_operation(|store| store.accept_starred_group(command))
    }
    pub fn set_read(&self, command: &SetRead) -> Result<OperationReceipt, MailError> {
        self.accept_action(
            &command.conversation.account_id,
            &command.request_id,
            std::slice::from_ref(&command.conversation),
            |store, observation| store.accept_read_observed(command, observation),
        )
    }

    /// Group setters pass the same admission gates as singles (verified
    /// mutation access, connected account, healthy lifecycle) before the
    /// store's atomic group acceptance.
    pub fn set_archived_group(
        &self,
        command: &crate::groups::SetArchivedGroup,
    ) -> Result<crate::groups::OperationGroupReceipt, MailError> {
        self.accept_action(
            &command.account_id,
            &command.request_id,
            &command.members,
            |store, observation| store.accept_archived_group_observed(command, observation),
        )
    }

    pub fn set_read_group(
        &self,
        command: &crate::groups::SetReadGroup,
    ) -> Result<crate::groups::OperationGroupReceipt, MailError> {
        self.accept_action(
            &command.account_id,
            &command.request_id,
            &command.members,
            |store, observation| store.accept_read_group_observed(command, observation),
        )
    }

    /// Cached group lookup by original acceptance request ID; served from
    /// local evidence like the other cached reads.
    pub fn get_operation_group(
        &self,
        request: &crate::groups::GetOperationGroupRequest,
    ) -> Result<Option<crate::groups::OperationGroupStatus>, MailError> {
        self.inner.store.get_operation_group(request)
    }

    /// Cached recent-group page, served from local evidence.
    pub fn list_operation_groups(
        &self,
        request: &crate::groups::ListOperationGroupsRequest,
    ) -> Result<crate::groups::OperationGroupPage, MailError> {
        self.inner.store.list_operation_groups(request)
    }

    pub fn retry_operation(&self, command: &RetryOperation) -> Result<OperationReceipt, MailError> {
        self.accept_operation(|store| store.accept_retry(command))
    }

    /// Undo of the single latest accepted non-compensating operation
    /// (docs/ux-04-trustworthy-undo.md §3.2/§3.3). Eligibility is store-owned;
    /// this admission only guards lifecycle (halted/stopping/disconnecting)
    /// and the active account. Cancelling a still-queued operation is purely
    /// local; compensating operations recheck capability in the unchanged
    /// executor, so no mutation-access gate is applied here.
    pub fn undo_operation(&self, command: &UndoOperation) -> Result<UndoReceipt, MailError> {
        let inner = &*self.inner;
        let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
        if st.halted || st.stop {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        match inner.store.account() {
            Ok(Some(_)) => {}
            Ok(None) => return Err(MailError::AuthRequired),
            Err(error) => {
                if latch_admission_storage_error(&mut st, &inner.ctrl, &error) {
                    drop(st);
                    inner.hub.dispatch();
                }
                return Err(error);
            }
        }
        let receipt = match inner.store.undo_operation(command) {
            Ok(receipt) => receipt,
            Err(error) => {
                if error == MailError::StorageUnavailable {
                    st.halted = true;
                    st.error = Some(error.clone());
                    st.pass_cancel.cancel();
                    cancel_independent_reads(&mut st);
                    inner.ctrl.wake.notify_all();
                }
                return Err(error);
            }
        };
        // Compensation work must dispatch immediately; a cancelled operation
        // needs no worker pass but the wake is harmless.
        st.operations_requested = true;
        inner.ctrl.wake.notify_all();
        drop(st);
        inner.hub.dispatch();
        Ok(receipt)
    }

    /// One partial group Undo attempt (docs/ux-05-safe-bulk-processing.md §5).
    /// Same admission as the single undo: lifecycle guard and active account;
    /// whole-group eligibility is store-owned. Compensation work dispatches
    /// immediately after the single acceptance commit.
    pub fn undo_operation_group(
        &self,
        command: &crate::groups::UndoOperationGroup,
    ) -> Result<crate::groups::GroupUndoReceipt, MailError> {
        let inner = &*self.inner;
        let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
        if st.halted || st.stop {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        match inner.store.account() {
            Ok(Some(_)) => {}
            Ok(None) => return Err(MailError::AuthRequired),
            Err(error) => {
                if latch_admission_storage_error(&mut st, &inner.ctrl, &error) {
                    drop(st);
                    inner.hub.dispatch();
                }
                return Err(error);
            }
        }
        let receipt = match inner.store.undo_operation_group(command) {
            Ok(receipt) => receipt,
            Err(error) => {
                if error == MailError::StorageUnavailable {
                    st.halted = true;
                    st.error = Some(error.clone());
                    st.pass_cancel.cancel();
                    cancel_independent_reads(&mut st);
                    inner.ctrl.wake.notify_all();
                }
                return Err(error);
            }
        };
        // Compensation work must dispatch immediately; cancelled members
        // need no worker pass but the wake is harmless.
        st.operations_requested = true;
        inner.ctrl.wake.notify_all();
        drop(st);
        inner.hub.dispatch();
        Ok(receipt)
    }

    /// Cached acceptance keeps its single capability check. Only missing exact
    /// references leave the locks for a provider read and then repeat admission.
    fn accept_action<T>(
        &self,
        account: &str,
        request: &str,
        members: &[ConversationRef],
        accept: impl Fn(&GmailStore, Option<&super::store::SearchObservation>) -> Result<T, MailError>,
    ) -> Result<T, MailError> {
        crate::groups::validate_group_request_id(request)?;
        crate::groups::validate_group_members(account, members)?;
        let (ready, missing, generation) = self.accept_operation(|store| {
            let generation = store.generation()?;
            let observation = super::store::SearchObservation::Cached {
                generation,
                members: members.to_vec(),
            };
            let missing = store.missing_action_context(account, request, members)?;
            if missing.is_empty() {
                // Fence concurrent eviction between the context check and the
                // acceptance transaction, even when no provider read is needed.
                Ok((
                    Some(accept(store, Some(&observation))?),
                    missing,
                    generation,
                ))
            } else {
                Ok((None, missing, generation))
            }
        })?;
        if let Some(receipt) = ready {
            return Ok(receipt);
        }
        // Keep offline and per-member missing semantics; no inferred targets.
        if self
            .inner
            .ctrl
            .state
            .lock()
            .map_err(storage_err())?
            .connection
            != ConnectionState::Connected
        {
            // Missing members must keep their ordinary per-member rejection,
            // but the deferred command still belongs to its original lifecycle.
            let observation = super::store::SearchObservation::Cached {
                generation,
                members: vec![],
            };
            return self.accept_operation(|store| accept(store, Some(&observation)));
        }
        let work = self.begin_reply_enrichment()?;
        // Register lifecycle cancellation before checking the ORIGINAL generation:
        // a disconnect in the preflight/registration gap must not revive this setter.
        if self.inner.store.generation()? != generation || work.cancel.is_cancelled() {
            return Err(MailError::NotFound);
        }
        let revision = self.inner.store.observation_revision()?;
        let threads = fetch_changed_threads(self.inner.provider.as_ref(), &missing, &work.cancel)?
            .into_iter()
            .filter_map(|fetch| match fetch {
                ThreadFetch::Cached(thread) => Some(*thread),
                ThreadFetch::Missing(_) => None,
            })
            .collect();
        if work.cancel.is_cancelled() {
            return Err(MailError::NotFound);
        }
        let observation = super::store::SearchObservation::Fetched {
            generation,
            revision,
            threads,
        };
        self.accept_operation(|store| accept(store, Some(&observation)))
    }

    fn accept_operation<T>(
        &self,
        accept: impl FnOnce(&GmailStore) -> Result<T, MailError>,
    ) -> Result<T, MailError> {
        let inner = &*self.inner;
        let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
        if st.halted || st.stop {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        let mutation_access = match inner.provider.mutation_access() {
            Ok(access) => access,
            Err(error) => {
                if latch_admission_storage_error(&mut st, &inner.ctrl, &error) {
                    drop(st);
                    inner.hub.dispatch();
                }
                return Err(error);
            }
        };
        if !mutation_access {
            return Err(MailError::PermissionRequired);
        }
        match inner.store.account() {
            Ok(Some(_)) => {}
            Ok(None) => return Err(MailError::AuthRequired),
            Err(error) => {
                if latch_admission_storage_error(&mut st, &inner.ctrl, &error) {
                    drop(st);
                    inner.hub.dispatch();
                }
                return Err(error);
            }
        }
        let receipt = match accept(&inner.store) {
            Ok(receipt) => receipt,
            Err(error) => {
                if error == MailError::StorageUnavailable {
                    st.halted = true;
                    st.error = Some(error.clone());
                    st.pass_cancel.cancel();
                    cancel_independent_reads(&mut st);
                    inner.ctrl.wake.notify_all();
                }
                return Err(error);
            }
        };
        st.operations_requested = true;
        inner.ctrl.wake.notify_all();
        drop(st);
        inner.hub.dispatch();
        Ok(receipt)
    }

    /// Enqueues a connect attempt and returns void acceptance immediately;
    /// OAuth/sync success is observed through [`Self::account_status`]
    /// (`authenticating`, then `connected` or an error hint). A missing
    /// client configuration is a typed, visible rejection.
    pub fn connect_account(&self) -> Result<(), MailError> {
        let inner = &*self.inner;
        if !inner.provider.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
        if st.halted || st.stop {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        if st.pass_in_flight {
            return Err(MailError::Busy);
        }
        st.auth_requested = true;
        st.auth_kind = AuthKind::Connect;
        st.auth_auto_retry = false;
        st.connection = ConnectionState::Authenticating;
        inner.ctrl.wake.notify_all();
        drop(st);
        inner.hub.dispatch();
        Ok(())
    }

    /// Cancels in-flight auth/sync, securely deletes credentials via the
    /// provider, and clears the account/cache before returning. Stale
    /// in-flight results lose the race by generation guard and can never
    /// repopulate the cache. Failures are typed and visible; nothing is
    /// cleared unless credential deletion succeeded.
    pub fn disconnect_account(&self) -> Result<(), MailError> {
        let inner = &*self.inner;
        let _serial = inner.disconnect_lock.lock().map_err(storage_err())?;
        // Publish an admission barrier and cancellation together. The worker
        // cannot activate another pass until credentials and cache are cleared.
        {
            let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
            st.disconnecting = true;
            st.auth_requested = false;
            st.auth_auto_retry = false;
            st.sync_requested = false;
            st.operations_requested = false;
            st.upgrade_requested = false;
            st.pass_cancel.cancel();
            cancel_independent_reads(&mut st);
            inner.ctrl.wake.notify_all();
        }
        let cleanup = (|| {
            // Stale-guard first: any result from a pass that raced this
            // disconnect is discarded by the store's generation check.
            inner.store.advance_generation()?;
            inner.ctrl.wait_until_idle(DISCONNECT_IDLE_TIMEOUT)?;
            // Local secure credential deletion; fail closed without clearing.
            inner.provider.disconnect()?;
            inner.store.clear_account()
        })();
        // If cleanup failed, the account/operation rows remain. Any setter
        // whose completion raced the generation advance must be reconciled,
        // never left permanently applying or replayed as a POST.
        let interrupted = if cleanup.is_err() {
            inner.store.recover_interrupted_operations()
        } else {
            Ok(false)
        };
        {
            let mut st = inner.ctrl.state.lock().map_err(storage_err())?;
            st.disconnecting = false;
            st.upgrade_in_flight = false;
            st.active_action = None;
            match &cleanup {
                Ok(()) => {
                    st.connection = ConnectionState::Disconnected;
                    st.error = None;
                    st.backoff = 0;
                }
                Err(error) => {
                    st.error = Some(error.clone());
                    match interrupted {
                        Ok(true) => st.operations_requested = true,
                        Ok(false) => {}
                        Err(storage_error) => {
                            st.halted = true;
                            st.error = Some(storage_error.clone());
                            st.pass_cancel.cancel();
                            cancel_independent_reads(&mut st);
                        }
                    }
                }
            }
            inner.ctrl.wake.notify_all();
        }
        inner.hub.dispatch();
        cleanup
    }

    /// Enqueues one catch-up pass. Repeated requests coalesce; a request
    /// while a pass is in flight is rejected typed as `busy` so there is
    /// never a concurrent cursor writer.
    pub fn request_sync(&self) -> Result<(), MailError> {
        let mut st = self.inner.ctrl.state.lock().map_err(storage_err())?;
        if st.halted || st.stop {
            return Err(MailError::StorageUnavailable);
        }
        if st.disconnecting {
            return Err(MailError::Busy);
        }
        if st.pass_in_flight {
            return Err(MailError::Busy);
        }
        match st.connection {
            ConnectionState::NotConfigured => Err(MailError::NotConfigured),
            ConnectionState::Authenticating => Err(MailError::Busy),
            ConnectionState::Disconnected | ConnectionState::AuthRequired => {
                Err(MailError::AuthRequired)
            }
            ConnectionState::Connected => {
                st.sync_requested = true;
                self.inner.ctrl.wake.notify_all();
                Ok(())
            }
        }
    }

    /// Registers a change listener and returns an unsubscribe handle. The
    /// listener is a change hint, not a payload; guard lifetime matches the
    /// fixture slice (fires until unsubscribed or dropped).
    pub fn subscribe(&self, listener: impl Fn() + Send + Sync + 'static) -> GmailUnsubscribe {
        let id = self.inner.next_listener_id.fetch_add(1, Ordering::SeqCst);
        self.inner
            .hub
            .listeners
            .lock()
            .expect("gmail listener hub poisoned")
            .insert(id, Arc::new(listener));
        GmailUnsubscribe {
            id,
            hub: Arc::clone(&self.inner.hub),
        }
    }

    /// Requests worker shutdown, cancels any in-flight provider call, and
    /// joins the worker thread with a bounded wait. Interrupted discovery or
    /// history work stays durable and resumes at the next launch.
    pub fn stop(&self) {
        self.inner.shutdown();
    }
}

impl Clone for GmailCore {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

/// Removes the listener when unsubscribed or dropped.
#[must_use = "retain this guard for as long as change notifications are needed"]
pub struct GmailUnsubscribe {
    id: u64,
    hub: Arc<GmailHub>,
}

impl GmailUnsubscribe {
    pub fn unsubscribe(self) {
        // Removal happens in Drop.
    }
}

impl Drop for GmailUnsubscribe {
    fn drop(&mut self) {
        self.hub
            .listeners
            .lock()
            .expect("gmail listener hub poisoned")
            .remove(&self.id);
    }
}

type GmailListener = Arc<dyn Fn() + Send + Sync>;

struct GmailHub {
    listeners: Mutex<HashMap<u64, GmailListener>>,
}

impl GmailHub {
    fn dispatch(&self) {
        let listeners: Vec<GmailListener> = {
            let map = self.listeners.lock().expect("gmail listener hub poisoned");
            map.values().cloned().collect()
        };
        for listener in listeners {
            listener();
        }
    }
}

impl Ctrl {
    fn request_stop(&self) {
        let mut st = self.state.lock().expect("gmail ctrl poisoned");
        st.stop = true;
        st.pass_cancel.cancel();
        cancel_independent_reads(&mut st);
        self.wake.notify_all();
    }

    /// Cancels the in-flight pass (if any) without affecting later passes.
    fn cancel_current_pass(&self) {
        self.state
            .lock()
            .expect("gmail ctrl poisoned")
            .pass_cancel
            .cancel();
    }

    /// Blocks until no pass or independent read (reply enrichment, live
    /// destination read) is in flight, or the timeout elapses (`busy`).
    fn wait_until_idle(&self, timeout: Duration) -> Result<(), MailError> {
        let deadline = Instant::now() + timeout;
        let mut st = self.state.lock().expect("gmail ctrl poisoned");
        while st.pass_in_flight
            || !st.reply_enrichments.is_empty()
            || st.destination_read.is_some()
            || st.reminder_read.is_some()
        {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(MailError::Busy);
            }
            let (guard, _) = self
                .wake
                .wait_timeout(st, remaining)
                .expect("gmail ctrl poisoned");
            st = guard;
        }
        Ok(())
    }
}

impl GmailInner {
    /// RAII shutdown: cancel the provider call, request stop, join the
    /// worker. Runs both from explicit [`GmailCore::stop`] and from `Drop` so
    /// dropping the core never leaves a worker running.
    fn shutdown(&self) {
        self.ctrl.cancel_current_pass();
        self.ctrl.request_stop();
        let deadline = Instant::now() + STOP_JOIN_TIMEOUT;
        let handle = self.worker.lock().ok().and_then(|mut slot| slot.take());
        let _ = self
            .ctrl
            .wait_until_idle(deadline.saturating_duration_since(Instant::now()));
        if let Some(handle) = handle {
            while !handle.is_finished() {
                if Instant::now() >= deadline {
                    // Detach; the cancelled operation stays durable and the
                    // worker keeps holding the profile lock until it exits.
                    return;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            let _ = handle.join();
        }
    }
}

impl Drop for GmailInner {
    fn drop(&mut self) {
        self.shutdown();
    }
}

fn credentialless_connection(has_account: bool) -> ConnectionState {
    if has_account {
        ConnectionState::AuthRequired
    } else {
        ConnectionState::Disconnected
    }
}

fn is_auth_failure(error: &MailError) -> bool {
    matches!(
        error,
        MailError::AuthRequired | MailError::AuthFailed | MailError::SecretsUnavailable
    )
}

fn is_retryable_network(error: &MailError) -> bool {
    matches!(
        error,
        MailError::NetworkUnavailable
            | MailError::RateLimited
            | MailError::ProviderUnavailable
            | MailError::InvalidProviderResponse
    )
}

/// Connection state after a failed auth attempt. Network-type failures for a
/// user-initiated connect map to `disconnected` (no silent auto-retry of the
/// browser flow); the typed error stays visible in the status.
fn auth_failure_connection(error: &MailError) -> ConnectionState {
    match error {
        MailError::NotConfigured => ConnectionState::NotConfigured,
        MailError::AuthRequired | MailError::AuthFailed | MailError::SecretsUnavailable => {
            ConnectionState::AuthRequired
        }
        _ => ConnectionState::Disconnected,
    }
}

fn backoff_delay(backoff: u32) -> Duration {
    let factor = 2u32.saturating_pow(backoff.min(8));
    PERIODIC_INTERVAL
        .checked_mul(factor)
        .map(|delay| delay.min(MAX_BACKOFF_INTERVAL))
        .unwrap_or(MAX_BACKOFF_INTERVAL)
}

// Per-worker time compression for lifecycle tests; production uses real durations.
fn worker_wait(_state: &CtrlState, wait: Duration) -> Duration {
    #[cfg(test)]
    {
        wait / _state.wait_divisor
    }
    #[cfg(not(test))]
    {
        wait
    }
}

// ------------------------------------------------------------------- worker

fn spawn_worker(
    store: Arc<GmailStore>,
    provider: Arc<dyn GmailProvider>,
    ctrl: Arc<Ctrl>,
    hub: Arc<GmailHub>,
    profile: Arc<ProfileGuard>,
) -> Result<JoinHandle<()>, MailError> {
    std::thread::Builder::new()
        .name("gmail-sync-worker".to_string())
        .spawn(move || run(store, provider, ctrl, hub, profile))
        .map_err(storage_err())
}

fn run(
    store: Arc<GmailStore>,
    provider: Arc<dyn GmailProvider>,
    ctrl: Arc<Ctrl>,
    hub: Arc<GmailHub>,
    // Held for the whole thread: a running or detached worker can never
    // outlive the profile lock.
    _profile: Arc<ProfileGuard>,
) {
    let mut sync_deadline = Instant::now();
    loop {
        {
            let state = ctrl.state.lock().expect("gmail ctrl poisoned");
            if state.stop || state.halted {
                return;
            }
        }
        if let Err(error) = process_due_reminders(&store, provider.as_ref(), &ctrl, &hub) {
            let mut st = ctrl.state.lock().expect("gmail ctrl poisoned");
            if latch_admission_storage_error(&mut st, &ctrl, &error) {
                drop(st);
                hub.dispatch();
                return;
            }
        }
        // Select the next action: request-driven work runs immediately,
        // tick-driven catch-up waits for the periodic/backoff interval.
        let (action, pass_cancel) = {
            let mut st = ctrl.state.lock().expect("gmail ctrl poisoned");
            while st.disconnecting && !st.stop {
                st = ctrl.wake.wait(st).expect("gmail ctrl poisoned");
            }
            if st.stop || st.halted {
                return;
            }
            #[cfg(test)]
            {
                if st.test_tick_due {
                    sync_deadline = Instant::now();
                    st.test_tick_due = false;
                }
                st.test_sync_deadline = Some(sync_deadline);
                st.test_wait_cycles += 1;
                ctrl.wake.notify_all();
            }
            let mut tick_due = Instant::now() >= sync_deadline;
            let runnable_request = |st: &CtrlState| {
                st.auth_requested
                    || (st.connection == ConnectionState::Connected
                        && (st.upgrade_requested
                            || st.sync_requested
                            || (st.operations_requested && !test_operations_paused(st))))
            };
            if !runnable_request(&st) && !st.reminder_work && !tick_due {
                // No runnable request pending: wait for one or the periodic
                // catch-up/backoff deadline.
                let reminder_wait = match store.reminder_wait() {
                    Ok(value) => value,
                    Err(error) => {
                        if latch_admission_storage_error(&mut st, &ctrl, &error) {
                            drop(st);
                            hub.dispatch();
                            return;
                        }
                        None
                    }
                };
                let reminder_deadline = reminder_wait.map(|wait| {
                    Instant::now() + worker_wait(&st, wait.max(Duration::from_secs(1)))
                });
                #[cfg(test)]
                {
                    st.test_reminder_deadline = reminder_deadline;
                    ctrl.wake.notify_all();
                }
                let deadline = reminder_deadline.map_or(sync_deadline, |d| d.min(sync_deadline));
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        let now = Instant::now();
                        tick_due = now >= sync_deadline;
                        if reminder_deadline.is_some_and(|d| now >= d) {
                            st.reminder_work = true;
                        }
                        break;
                    }
                    let (guard, _) = ctrl
                        .wake
                        .wait_timeout(st, remaining)
                        .expect("gmail ctrl poisoned");
                    st = guard;
                    if st.stop || st.halted {
                        return;
                    }
                    #[cfg(test)]
                    if st.test_tick_due {
                        sync_deadline = Instant::now();
                        st.test_tick_due = false;
                        break;
                    }
                    if st.disconnecting || st.reminder_work || runnable_request(&st) {
                        break;
                    }
                }
            }
            if st.halted {
                return;
            }
            if st.disconnecting {
                drop(st);
                continue;
            }
            tick_due |= Instant::now() >= sync_deadline;
            st.reminder_work = false;
            let action = if st.auth_requested {
                st.auth_requested = false;
                PassAction::Auth(st.auth_kind)
            } else if st.connection == ConnectionState::Authenticating
                && st.auth_auto_retry
                && tick_due
            {
                PassAction::Auth(AuthKind::Restore)
            } else if st.connection == ConnectionState::Connected && st.upgrade_requested {
                st.upgrade_requested = false;
                st.upgrade_in_flight = true;
                PassAction::MutationUpgrade
            } else if st.connection == ConnectionState::Connected && st.sync_requested {
                st.sync_requested = false;
                PassAction::Sync
            } else if st.connection == ConnectionState::Connected
                && st.operations_requested
                && !test_operations_paused(&st)
            {
                st.operations_requested = false;
                PassAction::Mutations
            } else if st.connection == ConnectionState::Connected && tick_due {
                PassAction::Sync
            } else {
                if tick_due {
                    sync_deadline = Instant::now() + worker_wait(&st, backoff_delay(st.backoff));
                }
                // Nothing runnable (not configured / disconnected / auth
                // required): go back to waiting without running a pass.
                drop(st);
                continue;
            };
            // Publish cancellation and activation in one control-state
            // transition so disconnect/stop always cancels this pass token.
            let pass_cancel = CancelToken::default();
            st.pass_cancel = pass_cancel.clone();
            st.pass_in_flight = true;
            st.active_action = Some(action);
            (action, pass_cancel)
        };

        // Status subscribers must observe the active pass before its first
        // potentially blocking provider call.
        hub.dispatch();
        // The pass runs network calls strictly outside the ctrl lock and
        // outside any SQLite lock.
        let mut outcome = run_pass(&store, provider.as_ref(), &pass_cancel, action, &hub);
        let mut more_claimable_mutations = false;
        if action == PassAction::Mutations && matches!(&outcome, PassOutcome::Complete) {
            match store.claimable_operation_count() {
                Ok(count) => more_claimable_mutations = count > 0,
                Err(error) => outcome = PassOutcome::Halt(error),
            }
            #[cfg(test)]
            let callback = ctrl
                .after_mutation_count
                .lock()
                .expect("test mutation-count hook poisoned")
                .take();
            #[cfg(test)]
            if let Some(callback) = callback {
                callback(more_claimable_mutations);
            }
        }

        let mut halted = false;
        {
            let mut st = ctrl.state.lock().expect("gmail ctrl poisoned");
            st.pass_in_flight = false;
            st.active_action = None;
            if action == PassAction::MutationUpgrade {
                st.upgrade_in_flight = false;
            }
            let reschedule = !matches!(outcome, PassOutcome::Idle | PassOutcome::Cancelled);
            if st.halted {
                halted = true;
            } else {
                match outcome {
                    PassOutcome::Complete => {
                        st.error = None;
                        st.backoff = 0;
                        if action.is_auth() || st.connection == ConnectionState::Authenticating {
                            st.connection = ConnectionState::Connected;
                        }
                        if action.is_auth()
                            || action == PassAction::Sync
                            || action == PassAction::MutationUpgrade
                        {
                            st.operations_requested = true;
                        } else if action == PassAction::Mutations {
                            // Preserve acceptances published after the count above.
                            st.operations_requested |= more_claimable_mutations;
                        }
                    }
                    PassOutcome::Idle => {}
                    PassOutcome::AuthError { error } => {
                        st.error = Some(error.clone());
                        st.backoff = st.backoff.saturating_add(1);
                        match action {
                            PassAction::Auth(AuthKind::Connect) => {
                                st.auth_auto_retry = false;
                                st.connection = auth_failure_connection(&error);
                            }
                            PassAction::Auth(AuthKind::Restore) => {
                                if is_retryable_network(&error) {
                                    // Stay `authenticating`; retry on the next
                                    // backoff tick until the account is known.
                                    st.auth_auto_retry = true;
                                } else {
                                    st.auth_auto_retry = false;
                                    st.connection = auth_failure_connection(&error);
                                }
                            }
                            PassAction::Sync
                            | PassAction::MutationUpgrade
                            | PassAction::Mutations => {}
                        }
                    }
                    PassOutcome::SyncError(error) => {
                        st.error = Some(error.clone());
                        st.backoff = st.backoff.saturating_add(1);
                        if is_auth_failure(&error) && action != PassAction::MutationUpgrade {
                            st.connection = ConnectionState::AuthRequired;
                        } else if action.is_auth() {
                            // Auth succeeded earlier in this pass; the failure is
                            // a sync problem, not a connection problem.
                            st.connection = ConnectionState::Connected;
                        }
                    }
                    PassOutcome::Halt(error) => {
                        st.error = Some(error);
                        st.halted = true;
                        cancel_independent_reads(&mut st);
                        halted = true;
                    }
                    PassOutcome::Cancelled => {
                        // Disconnect owns the state; ordinary upgrade cancellation
                        // resolves only that grant attempt without touching sync.
                        if action == PassAction::MutationUpgrade && !st.disconnecting {
                            st.error = None;
                        }
                    }
                }
            }
            if reschedule {
                sync_deadline = Instant::now() + worker_wait(&st, backoff_delay(st.backoff));
            }
            ctrl.wake.notify_all();
        }
        hub.dispatch();
        if halted {
            return;
        }
    }
}

/// Process local deadlines from the serial worker. A conditional reminder is
/// decided only after a complete fresh thread read; an error or partial thread
/// stays pending and remains visible through its due marker.
fn process_due_reminders(
    store: &GmailStore,
    provider: &dyn GmailProvider,
    ctrl: &Arc<Ctrl>,
    hub: &GmailHub,
) -> Result<(), MailError> {
    let due = store.due_reminders()?;
    for (reminder, baseline) in due {
        let replied = if reminder.condition == crate::reminders::ReminderCondition::Regardless {
            false
        } else {
            let connected = {
                let state = ctrl.state.lock().map_err(storage_err())?;
                state.connection == ConnectionState::Connected
                    && !state.disconnecting
                    && !state.stop
                    && !state.halted
            };
            if !connected {
                continue;
            }
            let account = match store.account() {
                Ok(Some(account)) if account.account_id == reminder.conversation.account_id => {
                    account
                }
                Err(error) => return Err(error),
                _ => continue,
            };
            let generation = store.generation()?;
            let observation = store.observation_revision()?;
            let cancel = CancelToken::default();
            {
                let mut st = ctrl.state.lock().map_err(storage_err())?;
                if st.stop || st.halted || st.disconnecting {
                    continue;
                }
                st.reminder_read = Some(cancel.clone());
            }
            let thread = match provider.get_thread_for_account(
                &account.account_id,
                &reminder.conversation.conversation_id,
                &cancel,
            ) {
                Ok(Some(thread)) => thread,
                Err(error) => {
                    clear_reminder_read(ctrl);
                    if error == MailError::StorageUnavailable {
                        return Err(error);
                    }
                    continue;
                }
                _ => {
                    clear_reminder_read(ctrl);
                    continue;
                }
            };
            clear_reminder_read(ctrl);
            if thread.conversation.conversation_ref != reminder.conversation {
                continue;
            }
            let Some(ids) = thread.message_ids.as_ref() else {
                continue;
            };
            if thread.conversation.context_complete != Some(true) {
                continue;
            }
            let senders: HashMap<String, String> = thread
                .conversation
                .messages
                .iter()
                .map(|message| (message.id.clone(), message.from.mailbox.clone()))
                .collect();
            if ids.iter().any(|id| !senders.contains_key(id))
                || senders.keys().any(|id| !ids.contains(id))
            {
                continue;
            }
            let mut has_reply = false;
            let mut complete = true;
            for id in ids.iter().filter(|id| !baseline.contains(id)) {
                match senders.get(id) {
                    Some(sender) if !sender.eq_ignore_ascii_case(&account.email_address) => {
                        has_reply = true
                    }
                    Some(_) => {}
                    None => {
                        complete = false;
                        break;
                    }
                }
            }
            if !complete {
                continue;
            }
            let st = ctrl.state.lock().map_err(storage_err())?;
            if st.stop || st.halted || st.disconnecting {
                continue;
            }
            let changed = store.finish_due_reminder_with_thread(
                &reminder,
                generation,
                observation,
                has_reply,
                Some(&thread),
            )?;
            drop(st);
            if changed {
                hub.dispatch();
            }
            continue;
        };
        let generation = store.generation()?;
        let observation = store.observation_revision()?;
        let st = ctrl.state.lock().map_err(storage_err())?;
        if st.stop || st.halted || st.disconnecting {
            continue;
        }
        let changed = store.finish_due_reminder(&reminder, generation, observation, replied)?;
        drop(st);
        if changed {
            hub.dispatch();
        }
    }
    Ok(())
}

fn clear_reminder_read(ctrl: &Ctrl) {
    if let Ok(mut st) = ctrl.state.lock() {
        st.reminder_read = None;
        ctrl.wake.notify_all();
    }
}

fn run_pass(
    store: &GmailStore,
    provider: &dyn GmailProvider,
    cancel: &CancelToken,
    action: PassAction,
    hub: &GmailHub,
) -> PassOutcome {
    let generation = match store.generation() {
        Ok(generation) => generation,
        Err(error) => return PassOutcome::Halt(error),
    };
    if action == PassAction::MutationUpgrade {
        let account = match store.account() {
            Ok(Some(account)) => account,
            Ok(None) => return PassOutcome::SyncError(MailError::AuthRequired),
            Err(error) => return PassOutcome::Halt(error),
        };
        return match provider.enable_mutations(cancel) {
            Ok(profile) if profile.account_id != account.account_id => {
                PassOutcome::SyncError(MailError::InvalidRequest {
                    field: "accountId".to_string(),
                })
            }
            Ok(_) => match provider.mutation_access() {
                Ok(true) => PassOutcome::Complete,
                Ok(false) => PassOutcome::SyncError(MailError::PermissionRequired),
                Err(error) => PassOutcome::SyncError(error),
            },
            Err(MailError::AuthCancelled) if cancel.is_cancelled() => PassOutcome::Cancelled,
            Err(error) => PassOutcome::SyncError(error),
        };
    }
    if action == PassAction::Mutations {
        return match crate::gmail::operations::run_one(store, provider, cancel) {
            Ok(true) => PassOutcome::Complete,
            Ok(false) => PassOutcome::Idle,
            Err(MailError::StorageUnavailable) => PassOutcome::Halt(MailError::StorageUnavailable),
            Err(_error) if cancel.is_cancelled() => PassOutcome::Cancelled,
            Err(error) => PassOutcome::SyncError(error),
        };
    }
    if let PassAction::Auth(kind) = action {
        let attempted = match kind {
            AuthKind::Connect => provider.connect(cancel),
            AuthKind::Restore => provider.profile(cancel),
        };
        let profile = match attempted {
            Ok(profile) => profile,
            Err(error) => return PassOutcome::AuthError { error },
        };
        match store.begin_account(&profile, generation) {
            Ok(Commit::Applied) => {}
            Ok(Commit::Discarded) => return PassOutcome::Cancelled,
            // Account identity switching without disconnect fails closed as a
            // typed, visible auth error; the worker stays alive.
            Err(MailError::InvalidRequest { field }) if field == "accountId" => {
                return PassOutcome::AuthError {
                    error: MailError::InvalidRequest { field },
                };
            }
            Err(error) => return PassOutcome::Halt(error),
        }
    }
    match store.has_account() {
        Ok(true) => {}
        Ok(false) => return PassOutcome::Idle,
        Err(error) => return PassOutcome::Halt(error),
    }
    // Discovery first, then history catch-up from the pinned baseline; an
    // expired cursor restarts bounded discovery with reconciliation.
    let mut rediscovery_restarts = 0u32;
    loop {
        match run_discovery(store, provider, cancel, generation, hub) {
            StageOutcome::Complete => {}
            StageOutcome::ExpiredRestart => {
                return match store.schedule_unknown_reconciliation() {
                    Ok(()) => PassOutcome::Complete,
                    Err(error) => PassOutcome::Halt(error),
                };
            }
            StageOutcome::SyncError(error) => return PassOutcome::SyncError(error),
            StageOutcome::Halt(error) => return PassOutcome::Halt(error),
            StageOutcome::Cancelled => return PassOutcome::Cancelled,
        }
        match run_history(store, provider, cancel, generation, hub) {
            StageOutcome::Complete => {
                return match store.schedule_unknown_reconciliation() {
                    Ok(()) => PassOutcome::Complete,
                    Err(error) => PassOutcome::Halt(error),
                };
            }
            StageOutcome::ExpiredRestart => {
                rediscovery_restarts += 1;
                if rediscovery_restarts > MAX_REDISCOVERY_RESTARTS {
                    return PassOutcome::SyncError(MailError::InvalidProviderResponse);
                }
                // Loop back through discovery, which is Running again.
            }
            StageOutcome::SyncError(error) => return PassOutcome::SyncError(error),
            StageOutcome::Halt(error) => return PassOutcome::Halt(error),
            StageOutcome::Cancelled => return PassOutcome::Cancelled,
        }
    }
}

fn run_discovery(
    store: &GmailStore,
    provider: &dyn GmailProvider,
    cancel: &CancelToken,
    generation: u64,
    hub: &GmailHub,
) -> StageOutcome {
    let mut pages = 0usize;
    let mut requested_tokens = HashSet::new();
    loop {
        if pages >= MAX_PAGES_PER_STAGE {
            return StageOutcome::SyncError(MailError::InvalidProviderResponse);
        }
        if cancel.is_cancelled() {
            return StageOutcome::Cancelled;
        }
        let incoming_token = match store.discovery() {
            Ok(DiscoveryProgress::Done) => return StageOutcome::Complete,
            Ok(DiscoveryProgress::Pending) => None,
            Ok(DiscoveryProgress::Running { page_token }) => page_token,
            Err(error) => return StageOutcome::Halt(error),
        };
        if !requested_tokens.insert(incoming_token.clone()) {
            return StageOutcome::SyncError(MailError::InvalidProviderResponse);
        }
        let page = match provider.list_inbox(incoming_token.as_deref(), cancel) {
            Ok(page) => page,
            Err(error) => return StageOutcome::SyncError(error),
        };
        pages += 1;
        if page.thread_ids.len() > MAX_DISCOVERY_IDS_PER_PAGE
            || page
                .next_page_token
                .as_ref()
                .is_some_and(|next| requested_tokens.contains(&Some(next.clone())))
        {
            return StageOutcome::SyncError(MailError::InvalidProviderResponse);
        }
        // Dedup repeated ids across and within pages; never re-fetch threads
        // already committed by this run; cap the run's discovered count.
        let seen = match store.seen_ids() {
            Ok(seen) => seen,
            Err(error) => return StageOutcome::Halt(error),
        };
        let seen_set: HashSet<&String> = seen.iter().collect();
        let mut fetched: Vec<ThreadFetch> = Vec::new();
        let mut retained_bytes = 0usize;
        let mut page_dedup: HashSet<&String> = HashSet::new();
        let mut discovered = 0usize;
        let mut capped = false;
        for id in &page.thread_ids {
            if !page_dedup.insert(id) || seen_set.contains(id) {
                continue;
            }
            if seen.len() + discovered >= DISCOVERY_CAP {
                capped = true;
                break;
            }
            match provider.get_thread(id, cancel) {
                Ok(Some(thread)) => {
                    if thread.conversation.conversation_ref.conversation_id != *id {
                        return StageOutcome::SyncError(MailError::InvalidProviderResponse);
                    }
                    if !include_retained_bytes(&mut retained_bytes, retained_thread_bytes(&thread))
                    {
                        return StageOutcome::SyncError(MailError::InvalidProviderResponse);
                    }
                    fetched.push(ThreadFetch::Cached(Box::new(thread)));
                    discovered += 1;
                }
                Ok(None) => {
                    let missing_bytes = std::mem::size_of::<ThreadFetch>() + id.capacity();
                    if !include_retained_bytes(&mut retained_bytes, missing_bytes) {
                        return StageOutcome::SyncError(MailError::InvalidProviderResponse);
                    }
                    fetched.push(ThreadFetch::Missing(id.clone()));
                }
                Err(error) => {
                    // Preserve the threads already fetched from this page:
                    // the page token is NOT advanced, so a rate-limit retry
                    // or restart re-lists this page and skips committed
                    // threads via the durable seen set instead of refetching
                    // them. A generation race (disconnect) discards the
                    // partial write like any stale result.
                    match store.apply_discovery_page(
                        &fetched,
                        incoming_token.as_deref(),
                        false,
                        false,
                        generation,
                    ) {
                        Ok(Commit::Applied) => return StageOutcome::SyncError(error),
                        Ok(Commit::Discarded) => return StageOutcome::Cancelled,
                        Err(commit_error) => return StageOutcome::Halt(commit_error),
                    }
                }
            }
        }
        let done = page.next_page_token.is_none() || capped;
        match store.apply_discovery_page(
            &fetched,
            page.next_page_token.as_deref(),
            done,
            capped,
            generation,
        ) {
            Ok(Commit::Applied) => {}
            Ok(Commit::Discarded) => return StageOutcome::Cancelled,
            Err(error) => return StageOutcome::Halt(error),
        }
        hub.dispatch();
        if done {
            return StageOutcome::Complete;
        }
    }
}

fn run_history(
    store: &GmailStore,
    provider: &dyn GmailProvider,
    cancel: &CancelToken,
    generation: u64,
    hub: &GmailHub,
) -> StageOutcome {
    let mut pages = 0usize;
    let mut requested_tokens = HashSet::new();
    loop {
        if pages >= MAX_PAGES_PER_STAGE {
            return StageOutcome::SyncError(MailError::InvalidProviderResponse);
        }
        if cancel.is_cancelled() {
            return StageOutcome::Cancelled;
        }
        let (batch_start, incoming_token) = match store.history() {
            Ok(HistoryProgress::Idle {
                cursor: Some(cursor),
            }) => (cursor, None),
            Ok(HistoryProgress::Idle { cursor: None }) => return StageOutcome::Complete,
            Ok(HistoryProgress::Resuming {
                batch_start,
                page_token,
            }) => (batch_start, Some(page_token)),
            Err(error) => return StageOutcome::Halt(error),
        };
        let incoming_token = incoming_token.flatten();
        if !requested_tokens.insert(incoming_token.clone()) {
            return StageOutcome::SyncError(MailError::InvalidProviderResponse);
        }
        let page = match provider.history(&batch_start, incoming_token.as_deref(), cancel) {
            Ok(page) => page,
            Err(crate::gmail::types::GmailHistoryError::Expired) => {
                // Cursor expired: bounded rediscovery from a fresh baseline,
                // never a silent skip of the expired window.
                let profile = match provider.profile(cancel) {
                    Ok(profile) => profile,
                    Err(error) => return StageOutcome::SyncError(error),
                };
                match store.begin_rediscovery(&profile.history_id, generation) {
                    Ok(Commit::Applied) => return StageOutcome::ExpiredRestart,
                    Ok(Commit::Discarded) => return StageOutcome::Cancelled,
                    Err(error) => return StageOutcome::Halt(error),
                }
            }
            Err(crate::gmail::types::GmailHistoryError::Mail(error)) => {
                return StageOutcome::SyncError(error)
            }
        };
        pages += 1;
        if page.changed_thread_ids.len() > MAX_HISTORY_IDS_PER_PAGE
            || page
                .next_page_token
                .as_ref()
                .is_some_and(|next| requested_tokens.contains(&Some(next.clone())))
        {
            return StageOutcome::SyncError(MailError::InvalidProviderResponse);
        }
        let fetched = match fetch_changed_threads(provider, &page.changed_thread_ids, cancel) {
            Ok(fetched) => fetched,
            Err(error) => return StageOutcome::SyncError(error),
        };
        match store.apply_history_page(&page, &fetched, &batch_start, generation) {
            Ok(Commit::Applied) => {}
            Ok(Commit::Discarded) => return StageOutcome::Cancelled,
            Err(error) => return StageOutcome::Halt(error),
        }
        hub.dispatch();
        if page.next_page_token.is_none() {
            // All pages of this batch applied; the cursor advanced inside the
            // final transaction.
            return StageOutcome::Complete;
        }
    }
}

/// Fetches changed threads with per-page dedup; `None` responses become
/// removals. Pathological provider data (mismatched ids) fails typed.
fn fetch_changed_threads(
    provider: &dyn GmailProvider,
    changed_thread_ids: &[String],
    cancel: &CancelToken,
) -> Result<Vec<ThreadFetch>, MailError> {
    let mut fetched = Vec::new();
    let mut retained_bytes = 0usize;
    let mut page_dedup: HashSet<&String> = HashSet::new();
    for id in changed_thread_ids {
        if !page_dedup.insert(id) {
            continue;
        }
        match provider.get_thread(id, cancel)? {
            Some(thread) => {
                if thread.conversation.conversation_ref.conversation_id != *id {
                    return Err(MailError::InvalidProviderResponse);
                }
                if !include_retained_bytes(&mut retained_bytes, retained_thread_bytes(&thread)) {
                    return Err(MailError::InvalidProviderResponse);
                }
                fetched.push(ThreadFetch::Cached(Box::new(thread)));
            }
            None => {
                let missing_bytes = std::mem::size_of::<ThreadFetch>() + id.capacity();
                if !include_retained_bytes(&mut retained_bytes, missing_bytes) {
                    return Err(MailError::InvalidProviderResponse);
                }
                fetched.push(ThreadFetch::Missing(id.clone()));
            }
        }
    }
    Ok(fetched)
}

fn include_retained_bytes(total: &mut usize, additional: usize) -> bool {
    let Some(next) = total.checked_add(additional) else {
        return false;
    };
    if next > MAX_RETAINED_THREAD_BYTES_PER_PAGE {
        return false;
    }
    *total = next;
    true
}

/// Conservative estimate of heap retained by one DTO, including collection
/// capacities and string allocations rather than only body text lengths.
fn retained_thread_bytes(thread: &GmailThread) -> usize {
    let conversation = &thread.conversation;
    let mut bytes = std::mem::size_of::<ThreadFetch>()
        .saturating_add(std::mem::size_of::<GmailThread>())
        .saturating_add(std::mem::size_of::<Conversation>())
        .saturating_add(conversation.conversation_ref.account_id.capacity())
        .saturating_add(conversation.conversation_ref.conversation_id.capacity())
        .saturating_add(conversation.subject.capacity())
        .saturating_add(
            conversation
                .messages
                .capacity()
                .saturating_mul(std::mem::size_of::<Message>()),
        )
        .saturating_add(
            conversation
                .unsupported_reason
                .as_ref()
                .map_or(0, String::capacity),
        )
        .saturating_add(
            conversation
                .pending_operation_id
                .as_ref()
                .map_or(0, String::capacity),
        )
        .saturating_add(
            thread
                .inbox_message_ids
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        )
        .saturating_add(thread.history_id.capacity());
    if let Some(sender) = &thread.newest_sender {
        bytes = bytes
            .saturating_add(sender.mailbox.capacity())
            .saturating_add(sender.display_name.as_ref().map_or(0, String::capacity));
    }
    bytes = bytes.saturating_add(
        thread
            .attachments
            .capacity()
            .saturating_mul(std::mem::size_of::<crate::attachments::AttachmentDescriptor>()),
    );
    for d in &thread.attachments {
        bytes = bytes
            .saturating_add(d.message_id.capacity())
            .saturating_add(d.attachment_id.capacity())
            .saturating_add(d.filename.capacity())
            .saturating_add(d.mime_type.capacity());
    }
    if let Some(reply_context) = &conversation.reply_context {
        bytes = bytes
            .saturating_add(std::mem::size_of::<crate::drafts::types::ReplyContext>())
            .saturating_add(reply_context.source_message_id.capacity())
            .saturating_add(reply_context.from_mailbox.capacity())
            .saturating_add(reply_context.message_id.capacity())
            .saturating_add(
                reply_context
                    .reply_to_mailboxes
                    .as_ref()
                    .map_or(0, |mailboxes| {
                        mailboxes
                            .capacity()
                            .saturating_mul(std::mem::size_of::<String>())
                            .saturating_add(
                                mailboxes
                                    .iter()
                                    .map(String::capacity)
                                    .fold(0usize, usize::saturating_add),
                            )
                    }),
            )
            .saturating_add(
                reply_context
                    .references
                    .capacity()
                    .saturating_mul(std::mem::size_of::<String>()),
            )
            .saturating_add(
                reply_context
                    .references
                    .iter()
                    .map(String::capacity)
                    .fold(0usize, usize::saturating_add),
            );
    }
    for message in &conversation.messages {
        bytes = bytes
            .saturating_add(message.id.capacity())
            .saturating_add(message.sent_at.capacity())
            .saturating_add(message.body_text.capacity())
            .saturating_add(std::mem::size_of::<Address>())
            .saturating_add(
                message
                    .from
                    .display_name
                    .as_ref()
                    .map_or(0, String::capacity),
            )
            .saturating_add(message.from.mailbox.capacity())
            .saturating_add(
                message
                    .to
                    .capacity()
                    .saturating_mul(std::mem::size_of::<Address>()),
            );
        for address in &message.to {
            bytes = bytes
                .saturating_add(address.display_name.as_ref().map_or(0, String::capacity))
                .saturating_add(address.mailbox.capacity());
        }
    }
    for message_id in &thread.inbox_message_ids {
        bytes = bytes.saturating_add(message_id.capacity());
    }
    for inventory in [&thread.message_ids, &thread.unread_message_ids]
        .into_iter()
        .flatten()
    {
        bytes = bytes.saturating_add(
            inventory
                .capacity()
                .saturating_mul(std::mem::size_of::<String>()),
        );
        for message_id in inventory {
            bytes = bytes.saturating_add(message_id.capacity());
        }
    }
    bytes
}

#[cfg(test)]
mod worker_halt_tests {
    use super::*;
    use crate::gmail::types::{GmailProfile, HistoryPage};

    const TEST_ACCOUNT: &str = "halt-test-account";
    const TEST_THREAD: &str = "halt-test-thread";

    type HaltTestProvider = crate::testing::operations_fake::FakeProvider;

    fn provider() -> Arc<HaltTestProvider> {
        HaltTestProvider::with_halt_thread(test_thread())
    }

    use crate::testing::until;

    fn test_profile() -> GmailProfile {
        crate::testing::profile(TEST_ACCOUNT, "halt@example.test", "history-1")
    }

    fn test_thread() -> GmailThread {
        let message = crate::testing::message(
            "message-1",
            "sender@example.test",
            "2026-01-01T00:00:00Z",
            "synthetic body",
        );
        let mut thread = crate::testing::thread(
            TEST_ACCOUNT,
            TEST_THREAD,
            vec![message],
            &["message-1"],
            Some(vec![]),
            "history-1",
        );
        thread.conversation.subject = "synthetic halt test".to_string();
        thread.conversation.is_read = Some(true);
        thread
    }

    #[test]
    fn mutation_accepted_after_post_pass_count_is_dispatched_without_another_wakeup() {
        use std::sync::mpsc;

        use crate::testing::TIMEOUT;
        let dir = crate::testing::temp_profile("gmail-lost-wakeup");
        let provider = provider();
        let core = GmailCore::open(dir.path(), provider.clone()).expect("open Gmail core");
        assert!(until(|| {
            core.account_status().is_ok_and(|status| {
                status.connection == ConnectionState::Connected
                    && status.sync.initial_sync_complete
                    && status.sync.state == SyncState::Idle
            }) && core
                .list_conversations()
                .is_ok_and(|snapshot| !snapshot.conversations.is_empty())
        }));
        core.wait_for_test_idle(TIMEOUT).expect("startup work idle");

        let (count_tx, count_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        *core.inner.ctrl.after_mutation_count.lock().unwrap() = Some(Box::new(move |count| {
            let _ = count_tx.send(count);
            let _ = release_rx.recv_timeout(TIMEOUT);
        }));
        let conversation = ConversationRef {
            account_id: TEST_ACCOUNT.into(),
            conversation_id: TEST_THREAD.into(),
        };
        core.set_archived(&SetArchived {
            conversation: conversation.clone(),
            archived: true,
            request_id: "lost-wakeup-a".into(),
        })
        .expect("accept mutation A");
        assert!(
            !count_rx
                .recv_timeout(TIMEOUT)
                .expect("post-pass count observed"),
            "A was the only claimable operation at the post-pass count"
        );

        core.set_archived(&SetArchived {
            conversation,
            archived: false,
            request_id: "lost-wakeup-b".into(),
        })
        .expect("accept mutation B during the count/update gap");
        assert_eq!(
            core.list_conversations().unwrap().activity[0].status,
            crate::dto::OperationStatus::Queued,
            "B is durably queued while the worker is held"
        );
        let cycle_before_release = core.inner.ctrl.state.lock().unwrap().test_wait_cycles;
        assert!(core.inner.ctrl.state.lock().unwrap().operations_requested);
        release_tx.send(()).expect("release worker boundary");

        assert!(
            until(|| {
                core.inner.ctrl.state.lock().unwrap().test_wait_cycles > cycle_before_release
            }),
            "worker must pass the post-pass control update and reach its next wait cycle"
        );
        let boundary_state = {
            let state = core.inner.ctrl.state.lock().unwrap();
            let status = core.list_conversations().unwrap().activity[0].status;
            (
                state.operations_requested
                    || state.active_action == Some(PassAction::Mutations)
                    || status == crate::dto::OperationStatus::Confirmed,
                status,
            )
        };
        if !boundary_state.0 {
            core.stop();
            drop(core);
            panic!(
                "B was stranded after the worker returned to waiting: {:?}",
                boundary_state.1
            );
        }
        assert!(
            until(|| {
                core.list_conversations().is_ok_and(|snapshot| {
                    snapshot.activity[0].status == crate::dto::OperationStatus::Confirmed
                })
            }),
            "B must dispatch without another command or sync wake"
        );
        assert_eq!(provider.halt_writes(), 2, "A and B both dispatch");
        core.stop();
        drop(core);
    }

    #[test]
    fn gmail_no_reply_deadline_defers_offline_then_uses_fresh_thread_read() {
        use crate::reminders::{PutReminder, ReminderCondition, ReminderPhase};
        let dir = crate::testing::temp_profile("gmail-reminder-worker");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let store = GmailStore::open(dir.path(), clock.clone()).unwrap();
        store.begin_account(&test_profile(), 0).unwrap();
        store
            .apply_discovery_page(
                &[ThreadFetch::Cached(Box::new(test_thread()))],
                None,
                true,
                false,
                0,
            )
            .unwrap();
        store
            .put_reminder(&PutReminder {
                conversation: ConversationRef {
                    account_id: TEST_ACCOUNT.into(),
                    conversation_id: TEST_THREAD.into(),
                },
                source_message_id: "message-1".into(),
                due_at: Some("2026-01-01T00:01:00Z".into()),
                condition: ReminderCondition::IfNoReply,
                expected_revision: None,
                request_id: "gmail-reminder-put".into(),
            })
            .unwrap();
        clock.advance_seconds(60);
        let provider = provider();
        let ctrl = Arc::new(Ctrl {
            state: Mutex::new(CtrlState {
                stop: false,
                halted: false,
                auth_requested: false,
                auth_kind: AuthKind::Restore,
                auth_auto_retry: false,
                sync_requested: false,
                reminder_work: false,
                operations_requested: false,
                upgrade_requested: false,
                upgrade_in_flight: false,
                active_action: None,
                pass_in_flight: false,
                disconnecting: false,
                pass_cancel: CancelToken::default(),
                reply_enrichments: HashMap::new(),
                destination_read: None,
                reminder_read: None,
                connection: ConnectionState::Disconnected,
                error: None,
                backoff: 0,
                #[cfg(test)]
                wait_divisor: 1,
                #[cfg(test)]
                test_wait_cycles: 0,
                #[cfg(test)]
                test_sync_deadline: None,
                #[cfg(test)]
                test_reminder_deadline: None,
                #[cfg(test)]
                test_tick_due: false,
                #[cfg(any(test, feature = "test-support"))]
                operations_paused: false,
            }),
            wake: Condvar::new(),
            #[cfg(test)]
            after_mutation_count: Mutex::new(None),
        });
        let hub = GmailHub {
            listeners: Mutex::new(HashMap::new()),
        };
        process_due_reminders(&store, provider.as_ref(), &ctrl, &hub).unwrap();
        assert_eq!(
            store.list_reminders().unwrap()[0].phase,
            ReminderPhase::Pending,
            "offline cannot prove no reply"
        );
        ctrl.state.lock().unwrap().connection = ConnectionState::Connected;
        process_due_reminders(&store, provider.as_ref(), &ctrl, &hub).unwrap();
        assert_eq!(
            store.list_reminders().unwrap()[0].phase,
            ReminderPhase::Returned,
            "complete fresh thread evidence resolves the due reminder"
        );
        store
            .put_reminder(&PutReminder {
                conversation: ConversationRef {
                    account_id: TEST_ACCOUNT.into(),
                    conversation_id: TEST_THREAD.into(),
                },
                source_message_id: "message-1".into(),
                due_at: Some("2026-01-01T00:02:00Z".into()),
                condition: ReminderCondition::IfNoReply,
                expected_revision: None,
                request_id: "gmail-reminder-put-reply".into(),
            })
            .unwrap();
        provider.state.lock().unwrap().include_reply = true;
        clock.advance_seconds(60);
        process_due_reminders(&store, provider.as_ref(), &ctrl, &hub).unwrap();
        assert_eq!(
            store.list_reminders().unwrap()[0].phase,
            ReminderPhase::Suppressed,
            "new external message IDs in fresh thread evidence suppress a conditional reminder"
        );
        assert_eq!(
            provider.state.lock().unwrap().halt_writes,
            0,
            "reminder handling performs no provider mutation"
        );
        drop(store);
    }

    // Virtual wall-clock jumps do not expire the worker's real Instant timer.
    // Non-timer scenarios explicitly publish that clock event to the worker.
    fn advance_reminder_clock(core: &GmailCore, clock: &crate::clock::FakeClock, seconds: i64) {
        let mut state = core.inner.ctrl.state.lock().unwrap();
        clock.advance_seconds(seconds);
        state.reminder_work = true;
        drop(state);
        core.inner.ctrl.wake.notify_all();
    }

    // Keep the control guard so the caller can advance virtual time only after
    // the real worker has armed its timer, without sending an artificial wake.
    fn wait_for_reminder_timer(
        core: &GmailCore,
        before: Option<Instant>,
    ) -> std::sync::MutexGuard<'_, CtrlState> {
        let timeout = Instant::now() + crate::testing::TIMEOUT;
        let mut state = core.inner.ctrl.state.lock().unwrap();
        loop {
            if state.test_reminder_deadline.is_some_and(|deadline| {
                deadline > Instant::now() && before.is_none_or(|previous| deadline < previous)
            }) {
                return state;
            }
            let remaining = timeout.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                drop(state);
                panic!("worker did not arm the requested reminder timer");
            }
            state = core
                .inner
                .ctrl
                .wake
                .wait_timeout(state, remaining)
                .unwrap()
                .0;
        }
    }

    #[test]
    fn due_read_reconciles_external_archive_without_provider_writes() {
        use crate::reminders::{PutReminder, ReminderCondition, ReminderPhase};
        let dir = crate::testing::temp_profile("due-archive");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let provider = provider();
        let core = GmailCore::open_with_clock(dir.path(), provider.clone(), clock.clone()).unwrap();
        assert!(until(|| core
            .list_conversations()
            .is_ok_and(|s| s.conversations.len() == 1)));
        core.inner
            .ctrl
            .wait_until_idle(Duration::from_secs(5))
            .unwrap();
        core.put_reminder(&PutReminder {
            conversation: test_thread().conversation.conversation_ref,
            source_message_id: "message-1".into(),
            due_at: Some("2026-01-01T00:00:01Z".into()),
            condition: ReminderCondition::IfNoReply,
            expected_revision: None,
            request_id: "archive-due".into(),
        })
        .unwrap();
        provider.state.lock().unwrap().archived = true;
        advance_reminder_clock(&core, &clock, 2);
        assert!(until(|| core
            .list_reminders()
            .is_ok_and(|r| r[0].phase == ReminderPhase::Returned)));
        assert!(
            core.list_conversations().unwrap().conversations.is_empty(),
            "fresh external archive must survive local reminder return"
        );
        assert_eq!(provider.halt_writes(), 0);
        core.stop();
        drop(core);
    }

    #[test]
    fn reminder_wakes_do_not_starve_sync_recovery() {
        use crate::reminders::{PutReminder, ReminderCondition, ReminderPhase};
        let dir = crate::testing::temp_profile("sync-reminder-retry");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let provider = provider();
        let core = GmailCore::open_with_clock(dir.path(), provider.clone(), clock.clone()).unwrap();
        assert!(until(|| core
            .list_conversations()
            .is_ok_and(|s| s.conversations.len() == 1)));
        core.inner
            .ctrl
            .wait_until_idle(Duration::from_secs(5))
            .unwrap();
        core.put_reminder(&PutReminder {
            conversation: test_thread().conversation.conversation_ref,
            source_message_id: "message-1".into(),
            due_at: Some("2026-01-01T00:00:01Z".into()),
            condition: ReminderCondition::IfNoReply,
            expected_revision: None,
            request_id: "incomplete-due".into(),
        })
        .unwrap();
        {
            let mut state = provider.state.lock().unwrap();
            state.incomplete = true;
            state.fail_history = true;
        }
        let previous_deadline = core
            .inner
            .ctrl
            .state
            .lock()
            .unwrap()
            .test_sync_deadline
            .unwrap();
        clock.advance_seconds(2);
        crate::testing::request_sync_when_idle(&core);
        assert!(until(
            || core.account_status().unwrap().sync.error == Some(MailError::NetworkUnavailable)
        ));
        core.inner
            .ctrl
            .wait_until_idle(Duration::from_secs(5))
            .unwrap();
        assert!(until(|| core
            .inner
            .ctrl
            .state
            .lock()
            .unwrap()
            .test_sync_deadline
            .is_some_and(|deadline| deadline > previous_deadline)));
        let calls = provider.state.lock().unwrap().halt_history_calls;
        provider.state.lock().unwrap().fail_history = false;
        // Observe completed reminder wake cycles while the real sync deadline
        // remains fixed. Advance only that timer after proving it was preserved.
        let deadline = core
            .inner
            .ctrl
            .state
            .lock()
            .unwrap()
            .test_sync_deadline
            .unwrap();
        for _ in 0..3 {
            let cycle = {
                let mut st = core.inner.ctrl.state.lock().unwrap();
                let cycle = st.test_wait_cycles;
                st.reminder_work = true;
                cycle
            };
            core.inner.ctrl.wake.notify_all();
            assert!(until(|| core
                .inner
                .ctrl
                .state
                .lock()
                .unwrap()
                .test_wait_cycles
                > cycle));
            assert_eq!(
                core.inner.ctrl.state.lock().unwrap().test_sync_deadline,
                Some(deadline)
            );
            assert_eq!(
                provider.state.lock().unwrap().halt_history_calls,
                calls,
                "reminder wake must not shorten sync backoff"
            );
        }
        core.inner.ctrl.state.lock().unwrap().test_tick_due = true;
        core.inner.ctrl.wake.notify_all();
        assert!(
            until(|| provider.state.lock().unwrap().halt_history_calls > calls),
            "periodic sync must recover while reminder evidence stays incomplete"
        );
        assert_eq!(
            core.list_reminders().unwrap()[0].phase,
            ReminderPhase::Pending
        );
        assert_eq!(provider.halt_writes(), 0);
        core.stop();
        drop(core);
    }

    #[test]
    fn local_reminder_worker_reschedules_deadline_and_catches_up_after_reopen() {
        use crate::reminders::{PutReminder, ReminderCondition, ReminderPhase};
        let dir = crate::testing::temp_profile("reminder-worker-public");
        let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
            "2026-01-01T00:00:00Z",
        )));
        let provider = provider();
        let core = GmailCore::open_with_clock(dir.path(), provider.clone(), clock.clone()).unwrap();
        assert!(until(|| core
            .account_status()
            .is_ok_and(|s| s.sync.initial_sync_complete)
            && core
                .list_conversations()
                .is_ok_and(|s| !s.conversations.is_empty())));
        core.inner
            .ctrl
            .wait_until_idle(Duration::from_secs(5))
            .unwrap();
        // A real consumer may synchronously read status in its change listener.
        let observed = core.clone();
        let listener = core.subscribe(move || {
            observed.account_status().unwrap();
        });
        let command = PutReminder {
            conversation: ConversationRef {
                account_id: TEST_ACCOUNT.into(),
                conversation_id: TEST_THREAD.into(),
            },
            source_message_id: "message-1".into(),
            due_at: Some("2026-01-01T00:01:00Z".into()),
            condition: ReminderCondition::Regardless,
            expected_revision: None,
            request_id: "public-long".into(),
        };
        let first = core.put_reminder(&command).unwrap();
        assert!(core.list_conversations().unwrap().conversations.is_empty());
        let long_deadline = wait_for_reminder_timer(&core, None)
            .test_reminder_deadline
            .unwrap();
        let revised = core
            .put_reminder(&PutReminder {
                due_at: Some("2026-01-01T00:00:01Z".into()),
                expected_revision: Some(first.revision),
                request_id: "public-short".into(),
                ..command.clone()
            })
            .unwrap();
        {
            let _parked = wait_for_reminder_timer(&core, Some(long_deadline));
            clock.advance_seconds(2);
        }
        // No request_sync or list-side execution: the sleeping worker must wake itself.
        assert!(until(|| core
            .list_reminders()
            .is_ok_and(|rows| rows[0].phase == ReminderPhase::Returned)));
        assert_eq!(
            core.list_reminders().unwrap()[0].revision,
            revised.revision + 1
        );
        assert_eq!(core.list_conversations().unwrap().conversations.len(), 1);
        let next = core
            .put_reminder(&PutReminder {
                due_at: Some("2026-01-01T00:00:03Z".into()),
                request_id: "public-restart".into(),
                ..command
            })
            .unwrap();
        listener.unsubscribe();
        core.stop();
        drop(core);
        clock.advance_seconds(2);
        let reopened = GmailCore::open_with_clock(dir.path(), provider.clone(), clock).unwrap();
        assert!(until(|| reopened
            .list_reminders()
            .is_ok_and(|r| r[0].phase == ReminderPhase::Returned)));
        assert_eq!(
            reopened.list_reminders().unwrap()[0].revision,
            next.revision + 1
        );
        assert_eq!(provider.halt_writes(), 0);
        reopened.stop();
        drop(reopened);
    }

    #[test]
    fn local_reminder_thread_read_is_cancelled_on_stop_and_disconnect() {
        use crate::reminders::{PutReminder, ReminderCondition, ReminderPhase};
        for disconnect in [false, true] {
            let dir = crate::testing::temp_profile("reminder-read-cancel");
            let clock = Arc::new(crate::clock::FakeClock::new(crate::clock::utc(
                "2026-01-01T00:00:00Z",
            )));
            let provider = provider();
            let core =
                GmailCore::open_with_clock(dir.path(), provider.clone(), clock.clone()).unwrap();
            assert!(until(|| core
                .account_status()
                .is_ok_and(|s| s.sync.initial_sync_complete)
                && core
                    .list_conversations()
                    .is_ok_and(|s| !s.conversations.is_empty())));
            core.inner
                .ctrl
                .wait_until_idle(Duration::from_secs(5))
                .unwrap();
            provider.state.lock().unwrap().block_thread = true;
            core.put_reminder(&PutReminder {
                conversation: ConversationRef {
                    account_id: TEST_ACCOUNT.into(),
                    conversation_id: TEST_THREAD.into(),
                },
                source_message_id: "message-1".into(),
                due_at: Some("2026-01-01T00:00:01Z".into()),
                condition: ReminderCondition::IfNoReply,
                expected_revision: None,
                request_id: "cancel-read".into(),
            })
            .unwrap();
            advance_reminder_clock(&core, &clock, 2);
            assert!(until(|| provider.state.lock().unwrap().thread_started));
            if disconnect {
                core.disconnect_account().unwrap();
                assert!(core.list_reminders().unwrap().is_empty());
                assert!(core.list_conversations().unwrap().conversations.is_empty());
            } else {
                core.stop();
                assert_eq!(
                    core.list_reminders().unwrap()[0].phase,
                    ReminderPhase::Pending
                );
            }
            assert_eq!(provider.halt_writes(), 0);
            core.stop();
            drop(core);
        }
    }

    #[test]
    fn mutation_admission_precheck_storage_halt_stops_queued_setters_until_restart() {
        let dir = crate::testing::temp_profile("gmail-worker-halt");
        let provider = provider();
        let core =
            GmailCore::open(dir.path(), provider.clone()).expect("open synthetic Gmail core");
        assert!(until(|| {
            core.account_status().is_ok_and(|status| {
                status.connection == ConnectionState::Connected
                    && status.sync.initial_sync_complete
                    && status.sync.state == SyncState::Idle
            }) && core
                .list_conversations()
                .is_ok_and(|snapshot| !snapshot.conversations.is_empty())
        }));

        provider.block_history();
        crate::testing::request_sync_when_idle(&core);
        assert!(
            provider.wait_for_history(),
            "sync is held before queued setter dispatch"
        );
        let ref_ = ConversationRef {
            account_id: TEST_ACCOUNT.to_string(),
            conversation_id: TEST_THREAD.to_string(),
        };
        core.set_archived(&SetArchived {
            conversation: ref_.clone(),
            archived: true,
            request_id: "queued-before-halt".to_string(),
        })
        .expect("first action is durably queued behind sync");
        assert_eq!(
            core.list_conversations().unwrap().activity[0].status,
            crate::dto::OperationStatus::Queued
        );

        // This failure happens in the admission precheck, before the setter's
        // acceptance transaction gets a chance to latch the worker halt.
        core.inner.store.set_test_persistence_failure(true);
        assert_eq!(
            core.set_archived(&SetArchived {
                conversation: ref_.clone(),
                archived: true,
                request_id: "account-precheck-storage-failure".to_string(),
            }),
            Err(MailError::StorageUnavailable)
        );
        core.inner.store.set_test_persistence_failure(false);
        provider.release_history();
        assert!(until(|| {
            let state = core.inner.ctrl.state.lock().unwrap();
            state.halted
                && !state.pass_in_flight
                && state.error == Some(MailError::StorageUnavailable)
        }));

        assert_eq!(
            provider.halt_writes(),
            0,
            "halted worker never dispatches queued action after storage recovery"
        );
        assert_eq!(
            core.list_conversations().unwrap().activity[0].status,
            crate::dto::OperationStatus::Queued
        );
        assert_eq!(
            core.set_archived(&SetArchived {
                conversation: ref_,
                archived: true,
                request_id: "after-storage-recovery".to_string(),
            }),
            Err(MailError::StorageUnavailable)
        );
        core.stop();
        drop(core);
    }

    include!("search_sync_tests.rs");

    /// Core-level group path (docs/ux-05-safe-bulk-processing.md §4.2): the
    /// capability gate rejects before acceptance; an accepted group's members
    /// execute serially through the unchanged worker; the group undoes as one
    /// action and compensation dispatches immediately.
    #[test]
    fn gmail_core_group_gate_acceptance_execution_and_undo() {
        let dir = crate::testing::temp_profile("gmail-group");
        let provider = provider();
        let core =
            GmailCore::open(dir.path(), provider.clone()).expect("open synthetic Gmail core");
        assert!(until(|| {
            core.account_status().is_ok_and(|status| {
                status.connection == ConnectionState::Connected && status.sync.initial_sync_complete
            }) && core
                .list_conversations()
                .is_ok_and(|snapshot| !snapshot.conversations.is_empty())
        }));
        let ref_ = ConversationRef {
            account_id: TEST_ACCOUNT.to_string(),
            conversation_id: TEST_THREAD.to_string(),
        };

        // Capability gate fires before any acceptance write.
        provider.set_mutation_access(false);
        assert_eq!(
            core.set_read_group(&crate::groups::SetReadGroup {
                account_id: TEST_ACCOUNT.into(),
                members: vec![ref_.clone()],
                read: true,
                request_id: "core-group-denied".into(),
            }),
            Err(MailError::PermissionRequired)
        );
        assert!(
            core.get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: TEST_ACCOUNT.into(),
                request_id: "core-group-denied".into(),
            })
            .unwrap()
            .is_none(),
            "denied capability wrote no group"
        );
        provider.set_mutation_access(true);

        // Accepted group executes through the serial worker.
        let writes_before = provider.halt_writes();
        let receipt = core
            .set_read_group(&crate::groups::SetReadGroup {
                account_id: TEST_ACCOUNT.into(),
                members: vec![ref_.clone()],
                read: true,
                request_id: "core-group-1".into(),
            })
            .expect("group accepted");
        assert!(until(|| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|row| row.status == crate::dto::OperationStatus::Confirmed)
        }));
        assert_eq!(provider.halt_writes(), writes_before + 1);
        let status = core
            .get_operation_group(&crate::groups::GetOperationGroupRequest {
                account_id: TEST_ACCOUNT.into(),
                request_id: "core-group-1".into(),
            })
            .expect("lookup")
            .expect("committed");
        assert_eq!(
            status.members[0].status,
            crate::groups::GroupMemberStatus::Confirmed
        );
        assert!(status.undo.available);

        // Group Undo compensates the confirmed member and dispatches.
        let undo = core
            .undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "core-undo-group-1".into(),
            })
            .expect("group undo");
        assert_eq!(
            undo.members[0].decision,
            crate::groups::GroupMemberUndoDecision::Compensating
        );
        assert!(until(|| {
            core.list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|row| {
                    undo.members[0].operation_ids.contains(&row.id)
                        && row.status == crate::dto::OperationStatus::Confirmed
                })
        }));
        // Replaying the group undo returns the same durable decisions.
        assert_eq!(
            core.undo_operation_group(&crate::groups::UndoOperationGroup {
                group_id: receipt.group_id.clone(),
                request_id: "core-undo-group-1".into(),
            })
            .expect("replay"),
            undo
        );
        core.stop();
        drop(core);
    }
}

#[cfg(test)]
#[path = "reply_context_sync_tests.rs"]
mod reply_context_sync_tests;
