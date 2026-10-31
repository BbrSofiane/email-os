//! Injectable clock for deterministic timestamps in tests.

use std::sync::Mutex;

use chrono::{DateTime, SecondsFormat, Utc};

/// Source of ISO-8601 UTC timestamps. Production uses [`SystemClock`];
/// tests inject [`FakeClock`].
pub trait Clock: Send + Sync {
    fn now_iso(&self) -> String;
}

/// Wall-clock implementation.
#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_iso(&self) -> String {
        Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
    }
}

/// Deterministic clock for tests: a fixed instant that tests advance.
pub struct FakeClock {
    now: Mutex<DateTime<Utc>>,
}

impl FakeClock {
    pub fn new(start: DateTime<Utc>) -> Self {
        Self {
            now: Mutex::new(start),
        }
    }

    pub fn advance_seconds(&self, seconds: i64) {
        *self.now.lock().expect("fake clock poisoned") += chrono::Duration::seconds(seconds);
    }
}

impl Clock for FakeClock {
    fn now_iso(&self) -> String {
        self.now
            .lock()
            .expect("fake clock poisoned")
            .to_rfc3339_opts(SecondsFormat::Secs, true)
    }
}

/// Parses a fixed ISO-8601 UTC instant for tests and fixtures.
pub fn utc(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s)
        .expect("valid ISO-8601 UTC timestamp")
        .with_timezone(&Utc)
}

/// Undo eligibility window measured from acceptance (docs/ux-04-trustworthy-undo.md §3.2 rule 3).
pub(crate) const UNDO_WINDOW_SECONDS: i64 = 10;

/// Whether `now` is strictly before `accepted_at + UNDO_WINDOW_SECONDS`.
/// Unparseable timestamps fail closed (window over).
pub(crate) fn within_undo_window(accepted_at: &str, now: &str) -> bool {
    undo_deadline(accepted_at)
        .zip(DateTime::parse_from_rfc3339(now).ok())
        .is_some_and(|(deadline, now)| now < deadline)
}

/// The ISO-8601 UTC instant after which the operation is no longer undoable.
pub(crate) fn undo_deadline_iso(accepted_at: &str) -> Option<String> {
    Some(undo_deadline(accepted_at)?.to_rfc3339_opts(SecondsFormat::Secs, true))
}

fn undo_deadline(accepted_at: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(accepted_at)
        .ok()
        .map(|t| t.with_timezone(&Utc))
        .map(|t| t + chrono::Duration::seconds(UNDO_WINDOW_SECONDS))
}
