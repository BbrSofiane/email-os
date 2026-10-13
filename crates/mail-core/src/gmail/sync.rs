//! Read-only Gmail cache/sync facade (`GmailCore`) plus its single serial
//! background worker (docs/vertical-slice-02.md, "Sync component"). Sync
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

use crate::clock::SystemClock;
use crate::dto::{Address, Conversation, ConversationRef, InboxSnapshot, Message};
use crate::error::MailError;
use crate::gmail::store::{
    Commit, DiscoveryProgress, GmailStore, HistoryProgress, ThreadFetch, DISCOVERY_CAP,
};
use crate::gmail::types::{
    AccountStatus, ConnectionState, GmailReadProvider, GmailThread, MailMode, SyncInfo, SyncState,
};
use crate::lock::ProfileGuard;
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
    store: Arc<GmailStore>,
    provider: Arc<dyn GmailReadProvider>,
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
}

/// Worker/control state. The worker thread is the only writer of `connection`
/// and `error` besides the disconnect path, which owns them while a
/// disconnect completes.
struct Ctrl {
    state: Mutex<CtrlState>,
    wake: Condvar,
}

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
    pass_in_flight: bool,
    disconnecting: bool,
    pass_cancel: CancelToken,
    connection: ConnectionState,
    error: Option<MailError>,
    backoff: u32,
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
        provider: Arc<dyn GmailReadProvider>,
    ) -> Result<GmailCore, MailError> {
        let profile_dir = profile_dir.as_ref();
        let profile = Arc::new(ProfileGuard::acquire(profile_dir)?);
        let store = Arc::new(GmailStore::open(profile_dir, Arc::new(SystemClock))?);

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
                pass_in_flight: false,
                disconnecting: false,
                pass_cancel: CancelToken::default(),
                connection,
                error,
                backoff: 0,
            }),
            wake: Condvar::new(),
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
                store,
                provider,
                profile,
                ctrl,
                hub,
                next_listener_id: AtomicU64::new(1),
                disconnect_lock: Mutex::new(()),
                worker: Mutex::new(Some(handle)),
            }),
        })
    }

    /// Effective inbox plus (empty) activity, served entirely from the local
    /// cache: cached reads survive offline and authentication errors.
    pub fn list_conversations(&self) -> Result<InboxSnapshot, MailError> {
        self.inner.store.list_snapshot()
    }

    /// Cached reader view of one conversation, scoped by the connected account.
    pub fn get_conversation(&self, r#ref: &ConversationRef) -> Result<Conversation, MailError> {
        self.inner.store.get_conversation(r#ref)
    }

    /// Wire-facing mode/connection/sync status. Typed errors surface storage
    /// failures; connection and sync error hints come from worker outcomes.
    pub fn account_status(&self) -> Result<AccountStatus, MailError> {
        let (connection, error, pass_in_flight) = {
            let st = self
                .inner
                .ctrl
                .state
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?;
            (st.connection, st.error.clone(), st.pass_in_flight)
        };
        Ok(AccountStatus {
            mode: MailMode::Gmail,
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

    /// Enqueues a connect attempt and returns void acceptance immediately;
    /// OAuth/sync success is observed through [`Self::account_status`]
    /// (`authenticating`, then `connected` or an error hint). A missing
    /// client configuration is a typed, visible rejection.
    pub fn connect_account(&self) -> Result<(), MailError> {
        let inner = &*self.inner;
        if !inner.provider.is_configured() {
            return Err(MailError::NotConfigured);
        }
        let mut st = inner
            .ctrl
            .state
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
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
        let _serial = inner
            .disconnect_lock
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        // Publish an admission barrier and cancellation together. The worker
        // cannot activate another pass until credentials and cache are cleared.
        {
            let mut st = inner
                .ctrl
                .state
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?;
            st.disconnecting = true;
            st.auth_requested = false;
            st.auth_auto_retry = false;
            st.sync_requested = false;
            st.pass_cancel.cancel();
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
        {
            let mut st = inner
                .ctrl
                .state
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?;
            st.disconnecting = false;
            match &cleanup {
                Ok(()) => {
                    st.connection = ConnectionState::Disconnected;
                    st.error = None;
                    st.backoff = 0;
                }
                Err(error) => st.error = Some(error.clone()),
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
        let mut st = self
            .inner
            .ctrl
            .state
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
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

    /// Blocks until no pass is in flight or the timeout elapses (`busy`).
    fn wait_until_idle(&self, timeout: Duration) -> Result<(), MailError> {
        let deadline = Instant::now() + timeout;
        let mut st = self.state.lock().expect("gmail ctrl poisoned");
        while st.pass_in_flight {
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
        let handle = self.worker.lock().ok().and_then(|mut slot| slot.take());
        if let Some(handle) = handle {
            let deadline = Instant::now() + STOP_JOIN_TIMEOUT;
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

// ------------------------------------------------------------------- worker

fn spawn_worker(
    store: Arc<GmailStore>,
    provider: Arc<dyn GmailReadProvider>,
    ctrl: Arc<Ctrl>,
    hub: Arc<GmailHub>,
    profile: Arc<ProfileGuard>,
) -> Result<JoinHandle<()>, MailError> {
    std::thread::Builder::new()
        .name("gmail-sync-worker".to_string())
        .spawn(move || run(store, provider, ctrl, hub, profile))
        .map_err(|_| MailError::StorageUnavailable)
}

fn run(
    store: Arc<GmailStore>,
    provider: Arc<dyn GmailReadProvider>,
    ctrl: Arc<Ctrl>,
    hub: Arc<GmailHub>,
    // Held for the whole thread: a running or detached worker can never
    // outlive the profile lock.
    _profile: Arc<ProfileGuard>,
) {
    let mut first_tick = true;
    loop {
        // Select the next action: request-driven work runs immediately,
        // tick-driven catch-up waits for the periodic/backoff interval.
        let (action, pass_cancel) = {
            let mut st = ctrl.state.lock().expect("gmail ctrl poisoned");
            while st.disconnecting && !st.stop {
                st = ctrl.wake.wait(st).expect("gmail ctrl poisoned");
            }
            if st.stop {
                return;
            }
            if !(st.auth_requested || st.sync_requested || first_tick) {
                // No request pending: wait for one or for the periodic
                // tick/backoff deadline.
                let deadline = Instant::now() + backoff_delay(st.backoff);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    let (guard, _) = ctrl
                        .wake
                        .wait_timeout(st, remaining)
                        .expect("gmail ctrl poisoned");
                    st = guard;
                    if st.stop {
                        return;
                    }
                    if st.disconnecting || st.auth_requested || st.sync_requested {
                        break;
                    }
                }
            }
            if st.disconnecting {
                drop(st);
                continue;
            }
            first_tick = false;
            let action = if st.auth_requested {
                st.auth_requested = false;
                PassAction::Auth(st.auth_kind)
            } else if st.connection == ConnectionState::Authenticating && st.auth_auto_retry {
                PassAction::Auth(AuthKind::Restore)
            } else if st.connection == ConnectionState::Connected {
                st.sync_requested = false;
                PassAction::Sync
            } else {
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
            (action, pass_cancel)
        };

        // Status subscribers must observe the active pass before its first
        // potentially blocking provider call.
        hub.dispatch();
        // The pass runs network calls strictly outside the ctrl lock and
        // outside any SQLite lock.
        let outcome = run_pass(&store, provider.as_ref(), &pass_cancel, action, &hub);

        let mut halted = false;
        {
            let mut st = ctrl.state.lock().expect("gmail ctrl poisoned");
            st.pass_in_flight = false;
            match outcome {
                PassOutcome::Complete => {
                    st.error = None;
                    st.backoff = 0;
                    if action.is_auth() || st.connection == ConnectionState::Authenticating {
                        st.connection = ConnectionState::Connected;
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
                        PassAction::Sync => {}
                    }
                }
                PassOutcome::SyncError(error) => {
                    st.error = Some(error.clone());
                    st.backoff = st.backoff.saturating_add(1);
                    if is_auth_failure(&error) {
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
                    halted = true;
                }
                PassOutcome::Cancelled => {
                    // Disconnect owns the state; record nothing.
                }
            }
            ctrl.wake.notify_all();
        }
        hub.dispatch();
        if halted {
            return;
        }
    }
}

fn run_pass(
    store: &GmailStore,
    provider: &dyn GmailReadProvider,
    cancel: &CancelToken,
    action: PassAction,
    hub: &GmailHub,
) -> PassOutcome {
    let generation = match store.generation() {
        Ok(generation) => generation,
        Err(error) => return PassOutcome::Halt(error),
    };
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
            StageOutcome::ExpiredRestart => return PassOutcome::Complete,
            StageOutcome::SyncError(error) => return PassOutcome::SyncError(error),
            StageOutcome::Halt(error) => return PassOutcome::Halt(error),
            StageOutcome::Cancelled => return PassOutcome::Cancelled,
        }
        match run_history(store, provider, cancel, generation, hub) {
            StageOutcome::Complete => return PassOutcome::Complete,
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
    provider: &dyn GmailReadProvider,
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
                    fetched.push(ThreadFetch::Cached(thread));
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
    provider: &dyn GmailReadProvider,
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
    provider: &dyn GmailReadProvider,
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
                fetched.push(ThreadFetch::Cached(thread));
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
    bytes
}
