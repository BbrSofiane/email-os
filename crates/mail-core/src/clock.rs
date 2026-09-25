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
