//! Storage-failure diagnostics for the shell, with no mailbox data.
//!
//! The shell's `map_err` sites are not SQLite errors (poisoned locks, a failed blocking task,
//! an unresolved download directory), so each carries a distinct static cause tag rather than
//! a code. A line holds only that tag and the call site's `file:line`. The logger also drops
//! every target except this crate's and mail-core's storage target, so a dependency that logs
//! a URL or an identifier can never reach the sink.

use std::io::Write;
use std::panic::Location;

use mail_core::error::MailError;

/// Log target for shell storage failures.
pub(crate) const LOG_TARGET: &str = "email_os::storage";
/// Target mail-core uses for its own storage failures; kept in step with `mail_core`.
const CORE_STORAGE_TARGET: &str = "mail_core::storage";

/// Logs one line and returns the same wire error the call site returned before.
#[track_caller]
pub(crate) fn storage_failure(cause: &'static str) -> MailError {
    let site = Location::caller();
    log::error!(
        target: LOG_TARGET,
        "storage failure site={}:{} cause={}",
        site.file(),
        site.line(),
        cause
    );
    MailError::StorageUnavailable
}

/// Cause tags for the three failure shapes the shell maps.
pub(crate) mod cause {
    pub(crate) const LOCK_POISONED: &str = "lock_poisoned";
    pub(crate) const TASK_JOIN: &str = "thread_join";
    pub(crate) const PATH_UNAVAILABLE: &str = "path_unavailable";
}

struct StderrLogger;

fn allowed(target: &str) -> bool {
    target == LOG_TARGET || target == CORE_STORAGE_TARGET
}

impl log::Log for StderrLogger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        allowed(metadata.target())
    }

    fn log(&self, record: &log::Record) {
        if self.enabled(record.metadata()) {
            // A failed write to stderr has nowhere better to go.
            let _ = writeln!(
                std::io::stderr(),
                "{} {}: {}",
                record.level(),
                record.target(),
                record.args()
            );
        }
    }

    fn flush(&self) {}
}

static LOGGER: StderrLogger = StderrLogger;

/// Installs the stderr sink. Safe to call once at startup; a second call is a no-op.
pub(crate) fn init_logging() {
    if log::set_logger(&LOGGER).is_ok() {
        log::set_max_level(log::LevelFilter::Error);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_storage_targets_reach_the_sink() {
        assert!(allowed(LOG_TARGET));
        assert!(allowed(CORE_STORAGE_TARGET));
        for target in [
            "reqwest::connect",
            "tauri::manager",
            "hyper_util::client",
            "email_os",
        ] {
            assert!(!allowed(target), "{target} must be filtered");
        }
    }

    #[test]
    fn storage_failure_keeps_the_wire_error() {
        assert_eq!(
            storage_failure(cause::LOCK_POISONED),
            MailError::StorageUnavailable
        );
    }
}
