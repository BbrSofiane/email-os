//! `mail-core`: headless fixture mail core for vertical slice 01.
//!
//! Owns the frozen wire DTOs, a concrete SQLite store with a seed-once
//! synthetic inbox, durable receipts with request-key dedup, a single serial
//! cancellable archive worker, an injectable clock, an OS-backed profile
//! lock, and change subscription. No Tauri, no OAuth, no network, no mail
//! beyond the synthetic fixture account. See `docs/vertical-slice-01.md`.

pub mod clock;
pub mod dto;
pub mod error;
mod lock;
pub mod provider;
mod seed;
mod store;
mod worker;

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dto::{Conversation, ConversationRef, InboxSnapshot, OperationReceipt, SetArchived};
pub use error::{MailError, ProviderError};
use lock::ProfileGuard;
pub use provider::{ArchiveProvider, CancelToken, FakeArchiveProvider};
use store::Store;
use worker::{Notify, WorkerSignal};

/// The single synthetic fixture account.
pub const ACCOUNT_ID: &str = "fixture-account";

/// Generous shutdown budget; a paused fake provider is cancelled long before
/// this expires. If the join still times out the thread detaches, and the
/// interrupted operation stays durable for the next launch.
const STOP_JOIN_TIMEOUT: Duration = Duration::from_secs(5);

type Listener = Arc<dyn Fn() + Send + Sync>;

/// Shared listener registry. Kept separate from the core's inner state so the
/// worker's notify closure never creates a reference cycle.
struct ListenerHub {
    listeners: Mutex<HashMap<u64, Listener>>,
}

/// Cloneable, thread-safe facade. Cheap to hold from a thin async Tauri
/// shell; blocking store calls stay inside [`MailCore`] methods so the shell
/// can wrap them in a blocking boundary.
pub struct MailCore {
    inner: Arc<Inner>,
}

struct Inner {
    store: Arc<Store>,
    /// Profile lock is owned for the full core lifetime, and additionally
    /// shared with the worker thread: a detached or still-running worker can
    /// never outlive the lock (a second writer is rejected instead of two
    /// processes corrupting the database).
    profile: Arc<ProfileGuard>,
    hub: Arc<ListenerHub>,
    next_listener_id: AtomicU64,
    signal: Arc<WorkerSignal>,
    cancel: CancelToken,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    /// Queryable error surfaced when the worker halted on persistence failure.
    halt_sink: Arc<Mutex<Option<MailError>>>,
}

impl Clone for MailCore {
    fn clone(&self) -> Self {
        Self {
            inner: Arc::clone(&self.inner),
        }
    }
}

impl MailCore {
    /// Opens (or creates) the synthetic profile storage under `profile_dir`,
    /// acquires the profile lock for the full core lifetime, migrates, seeds
    /// the 18 synthetic conversations exactly once, and requeues interrupted
    /// `applying` operations in original sequence.
    pub fn open(profile_dir: impl AsRef<Path>) -> Result<MailCore, MailError> {
        let profile_dir = profile_dir.as_ref();
        let profile = Arc::new(ProfileGuard::acquire(profile_dir)?);
        let clock: Arc<dyn clock::Clock> = Arc::new(clock::SystemClock);
        let store = Arc::new(Store::open(profile_dir, clock)?);
        store.recover_applying()?;
        let hub = Arc::new(ListenerHub {
            listeners: Mutex::new(HashMap::new()),
        });
        let halt_sink = Arc::new(Mutex::new(None));
        Ok(MailCore {
            inner: Arc::new(Inner {
                store,
                profile,
                hub,
                next_listener_id: AtomicU64::new(1),
                signal: Arc::new(WorkerSignal::new()),
                cancel: CancelToken::default(),
                worker: Mutex::new(None),
                halt_sink,
            }),
        })
    }

    /// The single synthetic account id.
    pub fn account_id(&self) -> &'static str {
        ACCOUNT_ID
    }

    /// Effective inbox plus persisted activity.
    pub fn list_conversations(&self) -> Result<InboxSnapshot, MailError> {
        self.ensure_worker_healthy()?;
        self.inner.store.list_snapshot()
    }

    /// Reader view of one conversation, scoped by account.
    pub fn get_conversation(&self, r#ref: &ConversationRef) -> Result<Conversation, MailError> {
        self.ensure_worker_healthy()?;
        self.inner.store.get_conversation(r#ref)
    }

    /// Accepts an archive command: validates, dedups on the request key, and
    /// returns a receipt only after commit. Listeners fire after the commit.
    pub fn set_archived(&self, command: &SetArchived) -> Result<OperationReceipt, MailError> {
        self.ensure_worker_healthy()?;
        let receipt = self.inner.store.set_archived(command)?;
        self.dispatch();
        self.inner.signal.wake();
        Ok(receipt)
    }

    /// Starts the single serial worker. The provider is injected by the
    /// caller (the shell uses [`FakeArchiveProvider::from_env`]). Starting
    /// twice is rejected; it is not a valid request field, but the shell
    /// treats `invalid_request` with field `worker` as a programming bug.
    pub fn start_worker(&self, provider: Arc<dyn ArchiveProvider>) -> Result<(), MailError> {
        let mut worker = self
            .inner
            .worker
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        if worker.is_some() {
            return Err(MailError::InvalidRequest {
                field: "worker".to_string(),
            });
        }
        *self
            .inner
            .halt_sink
            .lock()
            .map_err(|_| MailError::StorageUnavailable)? = None;
        let handle = worker::spawn(
            Arc::clone(&self.inner.store),
            provider,
            Arc::clone(&self.inner.signal),
            self.inner.cancel.clone(),
            {
                let hub = Arc::clone(&self.inner.hub);
                Arc::new(move || dispatch(&hub)) as Notify
            },
            {
                let sink = Arc::clone(&self.inner.halt_sink);
                let hub = Arc::clone(&self.inner.hub);
                Arc::new(move |err| {
                    *sink.lock().expect("halt sink poisoned") = Some(err);
                    dispatch(&hub);
                }) as Arc<dyn Fn(MailError) + Send + Sync>
            },
            Arc::clone(&self.inner.profile),
        );
        *worker = Some(handle);
        Ok(())
    }

    /// Requests worker shutdown, cancels a paused provider call, and joins
    /// the worker thread. Interrupted work stays durable (`applying`) and is
    /// requeued on next open.
    pub fn stop_worker(&self) {
        self.inner.shutdown_worker();
    }

    /// Whether the worker thread is running.
    pub fn is_worker_running(&self) -> bool {
        self.inner
            .worker
            .lock()
            .map(|slot| slot.as_ref().is_some_and(|h| !h.is_finished()))
            .unwrap_or(false)
    }

    /// Queryable error indication: set when the worker halted on persistence
    /// failure, cleared when the worker restarts. The shell surfaces this in
    /// its error state without a DTO change.
    pub fn worker_error(&self) -> Option<MailError> {
        self.inner
            .halt_sink
            .lock()
            .ok()
            .and_then(|sink| sink.clone())
    }

    /// Registers a change listener and returns an unsubscribe handle. The
    /// listener fires after commits (receipts, confirmations, failures) and
    /// worker halts; it is a change hint, not a payload.
    pub fn subscribe(&self, listener: impl Fn() + Send + Sync + 'static) -> Unsubscribe {
        let id = self.inner.next_listener_id.fetch_add(1, Ordering::SeqCst);
        self.inner
            .hub
            .listeners
            .lock()
            .expect("listener hub poisoned")
            .insert(id, Arc::new(listener));
        Unsubscribe {
            id,
            hub: Arc::clone(&self.inner.hub),
        }
    }

    fn ensure_worker_healthy(&self) -> Result<(), MailError> {
        let halt = self
            .inner
            .halt_sink
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        match halt.as_ref() {
            Some(error) => Err(error.clone()),
            None => Ok(()),
        }
    }

    fn dispatch(&self) {
        dispatch(&self.inner.hub);
    }
}

/// Removes the listener when unsubscribed or dropped.
#[must_use = "retain this guard for as long as change notifications are needed"]
pub struct Unsubscribe {
    id: u64,
    hub: Arc<ListenerHub>,
}

impl Unsubscribe {
    pub fn unsubscribe(self) {
        // Removal happens in Drop.
    }
}

impl Drop for Unsubscribe {
    fn drop(&mut self) {
        self.hub
            .listeners
            .lock()
            .expect("listener hub poisoned")
            .remove(&self.id);
    }
}

fn dispatch(hub: &ListenerHub) {
    let listeners: Vec<Listener> = {
        let map = hub.listeners.lock().expect("listener hub poisoned");
        map.values().cloned().collect()
    };
    for listener in listeners {
        listener();
    }
}

impl Inner {
    /// RAII shutdown: cancel the provider call, request stop, join the
    /// worker. Runs both from explicit [`MailCore::stop_worker`] and from
    /// `Drop` so dropping the core never leaves a worker running. If the
    /// join times out, the worker detaches while still holding its own
    /// reference to the profile lock, so storage stays exclusively owned.
    fn shutdown_worker(&self) {
        self.cancel.cancel();
        self.signal.request_stop();
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

impl Drop for Inner {
    fn drop(&mut self) {
        self.shutdown_worker();
    }
}

#[cfg(test)]
mod facade_tests {
    use super::*;

    #[test]
    fn worker_halt_remains_visible_through_commands_after_storage_recovers() {
        let dir = std::env::temp_dir().join(format!("mail-core-halt-{}", uuid::Uuid::new_v4()));
        let core = MailCore::open(&dir).unwrap();
        let (tx, rx) = std::sync::mpsc::channel();
        let _subscription = core.subscribe(move || {
            let _ = tx.send(());
        });
        core.inner.store.set_test_persistence_failure(true);
        core.start_worker(Arc::new(FakeArchiveProvider::new()))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2))
            .expect("worker halt notification");
        core.inner.store.set_test_persistence_failure(false);

        // The underlying DB is readable again, but the worker is still halted.
        assert!(core.inner.store.list_snapshot().is_ok());
        let target = ConversationRef {
            account_id: ACCOUNT_ID.into(),
            conversation_id: "conv-01".into(),
        };
        assert_eq!(
            core.list_conversations(),
            Err(MailError::StorageUnavailable)
        );
        assert_eq!(
            core.get_conversation(&target),
            Err(MailError::StorageUnavailable)
        );
        assert_eq!(
            core.set_archived(&SetArchived {
                conversation: target,
                archived: true,
                request_id: "after-halt".into(),
            }),
            Err(MailError::StorageUnavailable)
        );
        assert!(core
            .inner
            .store
            .list_snapshot()
            .unwrap()
            .activity
            .is_empty());
        drop(core);
        let restarted = MailCore::open(&dir).unwrap();
        assert!(restarted.list_conversations().is_ok());
        drop(restarted);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
