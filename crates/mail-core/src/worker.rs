//! Single serial cancellable worker. Claims queued operations in acceptance
//! order, calls the archive provider strictly outside any database lock or
//! transaction, then atomically persists confirmed facts or a definite
//! failure. Any persistence error halts the worker and is surfaced through
//! [`crate::MailCore::worker_error`]; it is never logged-and-ignored.

use std::sync::{Arc, Condvar, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

use crate::error::{MailError, ProviderError};
use crate::lock::ProfileGuard;
use crate::provider::{ArchiveProvider, CancelToken};
use crate::store::Store;

/// How long a claimless worker sleeps between wakeups. Not test
/// synchronization: tests synchronize through provider barriers and commits.
const IDLE_POLL: Duration = Duration::from_millis(200);

pub(crate) struct WorkerSignal {
    stop: Mutex<bool>,
    notified: Condvar,
}

impl WorkerSignal {
    pub(crate) fn new() -> Self {
        Self {
            stop: Mutex::new(false),
            notified: Condvar::new(),
        }
    }

    /// Wakes the worker (new work arrived or shutdown requested).
    pub(crate) fn wake(&self) {
        self.notified.notify_all();
    }

    pub(crate) fn request_stop(&self) {
        *self.stop.lock().expect("worker signal poisoned") = true;
        self.notified.notify_all();
    }

    /// Waits until stop is requested or the timeout elapses.
    fn wait_for_stop(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut stop = self.stop.lock().expect("worker signal poisoned");
        while !*stop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (guard, _) = self
                .notified
                .wait_timeout(stop, remaining)
                .expect("worker signal poisoned");
            stop = guard;
        }
        true
    }
}

pub(crate) type Notify = Arc<dyn Fn() + Send + Sync>;
pub(crate) type Halt = Arc<dyn Fn(MailError) + Send + Sync>;

pub(crate) fn spawn(
    store: Arc<Store>,
    provider: Arc<dyn ArchiveProvider>,
    signal: Arc<WorkerSignal>,
    cancel: CancelToken,
    notify: Notify,
    halt: Halt,
    profile: Arc<ProfileGuard>,
) -> JoinHandle<()> {
    std::thread::Builder::new()
        .name("mail-core-worker".to_string())
        .spawn(move || run(store, provider, signal, cancel, notify, halt, profile))
        .expect("failed to spawn mail-core worker thread")
}

fn run(
    store: Arc<Store>,
    provider: Arc<dyn ArchiveProvider>,
    signal: Arc<WorkerSignal>,
    cancel: CancelToken,
    notify: Notify,
    halt: Halt,
    // Held for the whole thread: a running or detached worker can never
    // outlive the profile lock.
    _profile: Arc<ProfileGuard>,
) {
    loop {
        if signal_is_stopped(&signal) {
            return;
        }
        match store.claim_next_queued() {
            Err(err) => {
                // Fail closed: halt on persistence failure and surface it.
                halt(err);
                return;
            }
            Ok(None) => {
                if signal_wait(&signal, IDLE_POLL) {
                    return;
                }
            }
            Ok(Some(op)) => {
                // The provider call runs with no transaction or DB mutex held.
                match provider.apply_archive(
                    &op.account_id,
                    &op.message_ids,
                    op.requested_archived,
                    &cancel,
                ) {
                    Ok(()) => {
                        if let Err(err) = store.confirm_op(&op) {
                            halt(err);
                            return;
                        }
                        notify();
                    }
                    Err(ProviderError::Cancelled) => {
                        // Shutdown: leave the operation durably in `applying`;
                        // startup recovery requeues it in original sequence.
                        return;
                    }
                    Err(definite) => {
                        let Some(kind) = definite.failure_kind() else {
                            return;
                        };
                        if let Err(err) = store.fail_op(&op.operation_id, kind) {
                            halt(err);
                            return;
                        }
                        notify();
                    }
                }
            }
        }
    }
}

fn signal_is_stopped(signal: &Arc<WorkerSignal>) -> bool {
    *signal.stop.lock().expect("worker signal poisoned")
}

fn signal_wait(signal: &Arc<WorkerSignal>, timeout: Duration) -> bool {
    signal.wait_for_stop(timeout)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::clock::{Clock, SystemClock};
    use std::time::Instant;

    /// The worker must halt and surface a persistence failure through the
    /// halt sink instead of logging-and-ignoring it (fail closed).
    #[test]
    fn worker_halts_and_surfaces_persistence_failure() {
        let dir = std::env::temp_dir().join(format!(
            "mail-core-worker-halt-{}-{}",
            std::process::id(),
            Instant::now().elapsed().as_nanos()
        ));
        let _ = std::fs::remove_dir_all(&dir);
        let clock: Arc<dyn Clock> = Arc::new(SystemClock);
        let store = Arc::new(Store::open(&dir, clock).expect("store opens"));
        store.set_test_persistence_failure(true);
        let halted: Arc<Mutex<Option<MailError>>> = Arc::new(Mutex::new(None));
        let signal = Arc::new(WorkerSignal::new());
        let profile = Arc::new(crate::lock::ProfileGuard::acquire(&dir).expect("profile guard"));
        let handle = spawn(
            store,
            Arc::new(crate::provider::FakeArchiveProvider::new()),
            Arc::clone(&signal),
            CancelToken::default(),
            Arc::new(|| {}),
            {
                let halted = Arc::clone(&halted);
                Arc::new(move |err: MailError| {
                    *halted.lock().expect("halt sink poisoned") = Some(err);
                }) as Halt
            },
            profile,
        );
        // The first claim fails, the worker halts, and the thread exits.
        handle.join().expect("worker exits after halting");
        let halted = halted.lock().expect("halt sink poisoned");
        assert_eq!(halted.as_ref(), Some(&MailError::StorageUnavailable));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
