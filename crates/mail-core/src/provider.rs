//! Archive provider seam: one method, one fake implementation with test
//! controls (pause/resume, fail-next, call recording, shutdown cancellation).
//! The fake is a test fixture, not a production IPC surface.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use crate::error::ProviderError;

/// Lets a paused provider observe shutdown so the worker can stop cleanly.
/// Cancelled work stays durably in `applying` and is requeued on next launch.
#[derive(Clone, Default)]
pub struct CancelToken {
    inner: Arc<CancelInner>,
}

#[derive(Default)]
struct CancelInner {
    cancelled: Mutex<bool>,
    notified: Condvar,
}

impl CancelToken {
    pub fn cancel(&self) {
        let mut cancelled = self.inner.cancelled.lock().expect("cancel token poisoned");
        *cancelled = true;
        self.inner.notified.notify_all();
    }

    pub fn is_cancelled(&self) -> bool {
        *self.inner.cancelled.lock().expect("cancel token poisoned")
    }

    /// Blocks until cancelled or the timeout elapses. Returns whether the
    /// token is now cancelled.
    pub fn wait_until_cancelled(&self, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut cancelled = self.inner.cancelled.lock().expect("cancel token poisoned");
        while !*cancelled {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (guard, _) = self
                .inner
                .notified
                .wait_timeout(cancelled, remaining)
                .expect("cancel token poisoned");
            cancelled = guard;
        }
        true
    }
}

/// Applies an archive intent to cached message ids. Implementations must
/// respect `cancel`: never hold a pause past shutdown, and return
/// [`ProviderError::Cancelled`] instead of a definite failure. The database
/// is never locked while this runs.
pub trait ArchiveProvider: Send + Sync {
    fn apply_archive(
        &self,
        account_id: &str,
        message_ids: &[String],
        archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), ProviderError>;
}

/// Fake provider: records calls, can pause (resume manually or via cancel),
/// and can fail the next call definitely. All coordination uses condvars, no
/// sleeps, and no network.
#[derive(Default)]
pub struct FakeArchiveProvider {
    inner: Arc<FakeInner>,
}

#[derive(Debug, Clone, Copy, Default)]
struct FakeState {
    paused: bool,
    fail_next: bool,
    calls: usize,
    /// Calls inside the provider: blocked at the pause gate or completing.
    inflight: usize,
}

#[derive(Default)]
struct FakeInner {
    state: Mutex<FakeState>,
    /// Wakes paused waiters on resume and call-arrival barriers.
    gate: Condvar,
}

impl FakeArchiveProvider {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fixture-only launch mode: `EMAIL_OS_FAKE_PROVIDER=paused|reject|success`.
    pub fn from_env() -> Self {
        let fake = Self::new();
        match std::env::var("EMAIL_OS_FAKE_PROVIDER").ok().as_deref() {
            Some("paused") => fake.set_paused(true),
            Some("reject") => fake.fail_next(),
            _ => {}
        }
        fake
    }

    /// Pauses every subsequent call at its gate until [`Self::resume`] fires
    /// or the worker's cancel token does.
    pub fn set_paused(&self, paused: bool) {
        self.inner
            .state
            .lock()
            .expect("fake provider poisoned")
            .paused = paused;
        self.inner.gate.notify_all();
    }

    pub fn resume(&self) {
        self.set_paused(false);
    }

    /// The next completing call fails definitely (`provider_rejected`).
    pub fn fail_next(&self) {
        self.inner
            .state
            .lock()
            .expect("fake provider poisoned")
            .fail_next = true;
    }

    /// Total calls that have arrived, including ones still paused.
    pub fn call_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("fake provider poisoned")
            .calls
    }

    /// Calls currently inside the provider.
    pub fn inflight_count(&self) -> usize {
        self.inner
            .state
            .lock()
            .expect("fake provider poisoned")
            .inflight
    }

    /// Barrier: resolves once `n` calls have arrived. Deterministic; no sleep.
    pub fn wait_for_calls(&self, n: usize, timeout: Duration) -> bool {
        let deadline = std::time::Instant::now() + timeout;
        let mut state = self.inner.state.lock().expect("fake provider poisoned");
        while state.calls < n {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            if remaining.is_zero() {
                return false;
            }
            let (guard, _) = self
                .inner
                .gate
                .wait_timeout(state, remaining)
                .expect("fake provider poisoned");
            state = guard;
        }
        true
    }
}

impl ArchiveProvider for FakeArchiveProvider {
    fn apply_archive(
        &self,
        _account_id: &str,
        _message_ids: &[String],
        _archived: bool,
        cancel: &CancelToken,
    ) -> Result<(), ProviderError> {
        let mut state = self.inner.state.lock().expect("fake provider poisoned");
        state.calls += 1;
        state.inflight += 1;
        self.inner.gate.notify_all();
        loop {
            if cancel.is_cancelled() {
                state.inflight -= 1;
                self.inner.gate.notify_all();
                return Err(ProviderError::Cancelled);
            }
            if !state.paused {
                break;
            }
            // Wake periodically to observe cancellation; the worker released
            // the database before calling in, so nothing is held here.
            let (guard, _) = self
                .inner
                .gate
                .wait_timeout(state, Duration::from_millis(20))
                .expect("fake provider poisoned");
            state = guard;
        }
        if state.fail_next {
            state.fail_next = false;
            state.inflight -= 1;
            self.inner.gate.notify_all();
            return Err(ProviderError::Rejected);
        }
        state.inflight -= 1;
        self.inner.gate.notify_all();
        Ok(())
    }
}
