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

use crate::clock::SystemClock;
use crate::dto::{
    Address, Conversation, ConversationRef, InboxSnapshot, Message, OperationReceipt,
    RetryOperation, SetArchived, SetRead,
};
use crate::error::MailError;
use crate::gmail::store::{
    Commit, DiscoveryProgress, GmailStore, HistoryProgress, ThreadFetch, DISCOVERY_CAP,
};
use crate::gmail::types::{
    AccountStatus, ConnectionState, GmailReadProvider, GmailThread, MailMode, MutationAccess,
    SyncInfo, SyncState,
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
    next_enrichment_id: AtomicU64,
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
    operations_requested: bool,
    upgrade_requested: bool,
    upgrade_in_flight: bool,
    active_action: Option<PassAction>,
    pass_in_flight: bool,
    disconnecting: bool,
    pass_cancel: CancelToken,
    reply_enrichments: HashMap<u64, CancelToken>,
    connection: ConnectionState,
    error: Option<MailError>,
    backoff: u32,
}

fn cancel_reply_enrichments(st: &mut CtrlState) {
    for cancel in st.reply_enrichments.values() {
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

/// Latches persistence failures found before a mutation reaches its durable
/// acceptance transaction, so already-queued work cannot run after recovery.
fn latch_admission_storage_error(st: &mut CtrlState, ctrl: &Ctrl, error: &MailError) -> bool {
    if *error != MailError::StorageUnavailable {
        return false;
    }
    st.halted = true;
    st.error = Some(error.clone());
    st.pass_cancel.cancel();
    cancel_reply_enrichments(st);
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
                operations_requested: true,
                upgrade_requested: false,
                upgrade_in_flight: false,
                active_action: None,
                pass_in_flight: false,
                disconnecting: false,
                pass_cancel: CancelToken::default(),
                reply_enrichments: HashMap::new(),
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
                next_enrichment_id: AtomicU64::new(1),
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

    fn begin_reply_enrichment(&self) -> Result<ReplyEnrichment, MailError> {
        let mut st = self
            .inner
            .ctrl
            .state
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
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
        let cancel = CancelToken::default();
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
            let st = self
                .inner
                .ctrl
                .state
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?;
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
        let mut st = inner
            .ctrl
            .state
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
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
        self.accept_operation(|store| store.accept_archived(command))
    }

    pub fn set_read(&self, command: &SetRead) -> Result<OperationReceipt, MailError> {
        self.accept_operation(|store| store.accept_read(command))
    }

    pub fn retry_operation(&self, command: &RetryOperation) -> Result<OperationReceipt, MailError> {
        self.accept_operation(|store| store.accept_retry(command))
    }

    fn accept_operation(
        &self,
        accept: impl FnOnce(&GmailStore) -> Result<OperationReceipt, MailError>,
    ) -> Result<OperationReceipt, MailError> {
        let inner = &*self.inner;
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
                    cancel_reply_enrichments(&mut st);
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
            st.operations_requested = false;
            st.upgrade_requested = false;
            st.pass_cancel.cancel();
            cancel_reply_enrichments(&mut st);
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
            let mut st = inner
                .ctrl
                .state
                .lock()
                .map_err(|_| MailError::StorageUnavailable)?;
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
                            cancel_reply_enrichments(&mut st);
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
        cancel_reply_enrichments(&mut st);
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
        while st.pass_in_flight || !st.reply_enrichments.is_empty() {
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
            if st.stop || st.halted {
                return;
            }
            let mut tick_due = first_tick;
            let runnable_request = |st: &CtrlState| {
                st.auth_requested
                    || (st.connection == ConnectionState::Connected
                        && (st.upgrade_requested || st.sync_requested || st.operations_requested))
            };
            if !runnable_request(&st) && !first_tick {
                // No runnable request pending: wait for one or the periodic
                // catch-up/backoff deadline.
                let deadline = Instant::now() + backoff_delay(st.backoff);
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() {
                        tick_due = true;
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
                    if st.disconnecting || runnable_request(&st) {
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
            first_tick = false;
            let action = if st.auth_requested {
                st.auth_requested = false;
                PassAction::Auth(st.auth_kind)
            } else if st.connection == ConnectionState::Authenticating && st.auth_auto_retry {
                PassAction::Auth(AuthKind::Restore)
            } else if st.connection == ConnectionState::Connected && st.upgrade_requested {
                st.upgrade_requested = false;
                st.upgrade_in_flight = true;
                PassAction::MutationUpgrade
            } else if st.connection == ConnectionState::Connected && st.sync_requested {
                st.sync_requested = false;
                PassAction::Sync
            } else if st.connection == ConnectionState::Connected && st.operations_requested {
                st.operations_requested = false;
                PassAction::Mutations
            } else if st.connection == ConnectionState::Connected && tick_due {
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
        }

        let mut halted = false;
        {
            let mut st = ctrl.state.lock().expect("gmail ctrl poisoned");
            st.pass_in_flight = false;
            st.active_action = None;
            if action == PassAction::MutationUpgrade {
                st.upgrade_in_flight = false;
            }
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
                            st.operations_requested = more_claimable_mutations;
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
                        cancel_reply_enrichments(&mut st);
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
    use crate::dto::{Address, Message};
    use crate::gmail::types::{GmailHistoryError, GmailProfile, HistoryPage, InboxPage};
    use std::time::{SystemTime, UNIX_EPOCH};

    const TEST_ACCOUNT: &str = "halt-test-account";
    const TEST_THREAD: &str = "halt-test-thread";

    struct ProviderState {
        block_history: bool,
        history_started: bool,
        writes: usize,
    }

    struct HaltTestProvider {
        state: Mutex<ProviderState>,
        wake: Condvar,
    }

    impl HaltTestProvider {
        fn new() -> Arc<Self> {
            Arc::new(Self {
                state: Mutex::new(ProviderState {
                    block_history: false,
                    history_started: false,
                    writes: 0,
                }),
                wake: Condvar::new(),
            })
        }

        fn block_history(&self) {
            let mut state = self.state.lock().unwrap();
            state.block_history = true;
            state.history_started = false;
        }

        fn wait_for_history(&self) -> bool {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut state = self.state.lock().unwrap();
            while !state.history_started {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return false;
                }
                let (next, _) = self.wake.wait_timeout(state, remaining).unwrap();
                state = next;
            }
            true
        }

        fn release_history(&self) {
            let mut state = self.state.lock().unwrap();
            state.block_history = false;
            drop(state);
            self.wake.notify_all();
        }

        fn writes(&self) -> usize {
            self.state.lock().unwrap().writes
        }
    }

    fn until(mut predicate: impl FnMut() -> bool) -> bool {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if predicate() {
                return true;
            }
            if Instant::now() >= deadline {
                return predicate();
            }
            std::thread::sleep(Duration::from_millis(10));
        }
    }

    fn test_profile() -> GmailProfile {
        GmailProfile {
            account_id: TEST_ACCOUNT.to_string(),
            email_address: "halt@example.test".to_string(),
            history_id: "history-1".to_string(),
        }
    }

    fn test_thread() -> GmailThread {
        GmailThread {
            conversation: Conversation {
                conversation_ref: ConversationRef {
                    account_id: TEST_ACCOUNT.to_string(),
                    conversation_id: TEST_THREAD.to_string(),
                },
                subject: "synthetic halt test".to_string(),
                messages: vec![Message {
                    id: "message-1".to_string(),
                    from: Address {
                        display_name: None,
                        mailbox: "sender@example.test".to_string(),
                    },
                    to: vec![],
                    sent_at: "2026-01-01T00:00:00Z".to_string(),
                    body_text: "synthetic body".to_string(),
                }],
                is_in_inbox: true,
                is_read: Some(true),
                context_complete: Some(true),
                unsupported_reason: None,
                retained_snapshot_at: None,
                reply_context: None,
                pending_operation_id: None,
            },
            inbox_message_ids: vec!["message-1".to_string()],
            message_ids: Some(vec!["message-1".to_string()]),
            unread_message_ids: Some(vec![]),
            history_id: "history-1".to_string(),
        }
    }

    impl GmailReadProvider for HaltTestProvider {
        fn mutation_access(&self) -> Result<bool, MailError> {
            Ok(true)
        }

        fn apply_archive(
            &self,
            _message_ids: &[String],
            _archived: bool,
            _cancel: &CancelToken,
        ) -> Result<(), MailError> {
            self.state.lock().unwrap().writes += 1;
            Ok(())
        }

        fn is_configured(&self) -> bool {
            true
        }

        fn has_credentials(&self) -> Result<bool, MailError> {
            Ok(true)
        }

        fn connect(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
            Ok(test_profile())
        }

        fn disconnect(&self) -> Result<(), MailError> {
            Ok(())
        }

        fn profile(&self, _cancel: &CancelToken) -> Result<GmailProfile, MailError> {
            Ok(test_profile())
        }

        fn list_inbox(
            &self,
            _page_token: Option<&str>,
            _cancel: &CancelToken,
        ) -> Result<InboxPage, MailError> {
            Ok(InboxPage {
                thread_ids: vec![TEST_THREAD.to_string()],
                next_page_token: None,
            })
        }

        fn get_thread(
            &self,
            _thread_id: &str,
            _cancel: &CancelToken,
        ) -> Result<Option<GmailThread>, MailError> {
            Ok(Some(test_thread()))
        }

        fn history(
            &self,
            start_history_id: &str,
            _page_token: Option<&str>,
            cancel: &CancelToken,
        ) -> Result<HistoryPage, GmailHistoryError> {
            let mut state = self.state.lock().unwrap();
            if state.block_history {
                state.history_started = true;
                self.wake.notify_all();
                while state.block_history && !cancel.is_cancelled() {
                    let (next, _) = self
                        .wake
                        .wait_timeout(state, Duration::from_millis(10))
                        .unwrap();
                    state = next;
                }
            }
            if cancel.is_cancelled() {
                return Err(GmailHistoryError::Mail(MailError::AuthCancelled));
            }
            Ok(HistoryPage {
                changed_thread_ids: vec![],
                deleted_message_ids: vec![],
                next_page_token: None,
                history_id: start_history_id.to_string(),
            })
        }
    }

    #[test]
    fn mutation_admission_precheck_storage_halt_stops_queued_setters_until_restart() {
        let dir = std::env::temp_dir().join(format!(
            "mail-core-gmail-worker-halt-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let provider = HaltTestProvider::new();
        let core = GmailCore::open(&dir, Arc::clone(&provider) as Arc<dyn GmailReadProvider>)
            .expect("open synthetic Gmail core");
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
        core.request_sync().expect("request synthetic sync");
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
            provider.writes(),
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
        let _ = std::fs::remove_dir_all(dir);
    }
}

#[cfg(test)]
#[path = "reply_context_sync_tests.rs"]
mod reply_context_sync_tests;
