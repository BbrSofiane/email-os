//! Cooperative cancellation shared by every provider call and worker.

use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// Lets a paused or in-flight provider call observe shutdown so the worker can
/// stop cleanly. Cancelled work stays durable and is reconciled on next launch.
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
