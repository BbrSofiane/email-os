//! One diagnosable log line per storage failure, with no mailbox data.
//!
//! Every storage failure still surfaces as [`MailError::StorageUnavailable`]; the wire error
//! is unchanged. What this module adds is a record of *why*, so a failure can be diagnosed
//! from a log. The privacy promise is enforced structurally: a line is built only from
//! static strings, the call site's `file:line` and the numeric SQLite result codes. Display
//! text of an underlying error is never read, because SQLite messages can quote data such as
//! constraint-violating values or SQL fragments.

use std::panic::Location;

use crate::error::MailError;

/// Log target used for every line; the shell's logger filters on it.
pub const LOG_TARGET: &str = "mail_core::storage";

/// What is known about a failure, limited to values that cannot contain mailbox data.
pub(crate) struct Cause {
    /// Static tag naming the kind of failure.
    pub(crate) kind: &'static str,
    /// SQLite primary result code name and extended code, when the cause is a SQLite error.
    pub(crate) sqlite: Option<(&'static str, i32)>,
}

impl Cause {
    const fn plain(kind: &'static str) -> Self {
        Cause { kind, sqlite: None }
    }
}

/// Classifies an underlying error without reading its message.
pub(crate) trait StorageCause {
    fn cause(&self) -> Cause;
}

impl StorageCause for rusqlite::Error {
    fn cause(&self) -> Cause {
        match self {
            rusqlite::Error::SqliteFailure(error, _) => Cause {
                kind: "sqlite",
                sqlite: Some((code_name(error.code), error.extended_code)),
            },
            // Prepare-time failures carry the code plus the SQL text and an offset. Only the
            // numeric code is read; the SQL and message are never touched.
            rusqlite::Error::SqlInputError { error, .. } => Cause {
                kind: "sqlite",
                sqlite: Some((code_name(error.code), error.extended_code)),
            },
            // Other variants carry no result code; their payloads may hold
            // column names or values, so only the variant is recorded.
            rusqlite::Error::QueryReturnedNoRows => Cause::plain("sqlite_no_rows"),
            rusqlite::Error::FromSqlConversionFailure(..) => Cause::plain("sqlite_from_sql"),
            rusqlite::Error::InvalidColumnType(..) => Cause::plain("sqlite_column_type"),
            rusqlite::Error::InvalidParameterCount(..) => Cause::plain("sqlite_parameter_count"),
            _ => Cause::plain("sqlite_other"),
        }
    }
}

fn code_name(code: rusqlite::ErrorCode) -> &'static str {
    use rusqlite::ErrorCode::*;
    match code {
        InternalMalfunction => "InternalMalfunction",
        PermissionDenied => "PermissionDenied",
        OperationAborted => "OperationAborted",
        DatabaseBusy => "DatabaseBusy",
        DatabaseLocked => "DatabaseLocked",
        OutOfMemory => "OutOfMemory",
        ReadOnly => "ReadOnly",
        OperationInterrupted => "OperationInterrupted",
        SystemIoFailure => "SystemIoFailure",
        DatabaseCorrupt => "DatabaseCorrupt",
        NotFound => "NotFound",
        DiskFull => "DiskFull",
        CannotOpen => "CannotOpen",
        FileLockingProtocolFailed => "FileLockingProtocolFailed",
        SchemaChanged => "SchemaChanged",
        TooBig => "TooBig",
        ConstraintViolation => "ConstraintViolation",
        TypeMismatch => "TypeMismatch",
        ApiMisuse => "ApiMisuse",
        NoLargeFileSupport => "NoLargeFileSupport",
        AuthorizationForStatementDenied => "AuthorizationForStatementDenied",
        ParameterOutOfRange => "ParameterOutOfRange",
        NotADatabase => "NotADatabase",
        Unknown => "Unknown",
        // `ErrorCode` is non-exhaustive; a future variant still logs its numeric extended code.
        _ => "Other",
    }
}

impl<T> StorageCause for std::sync::PoisonError<T> {
    fn cause(&self) -> Cause {
        Cause::plain("lock_poisoned")
    }
}

impl StorageCause for std::io::Error {
    fn cause(&self) -> Cause {
        Cause::plain("io")
    }
}

impl StorageCause for chrono::ParseError {
    fn cause(&self) -> Cause {
        Cause::plain("time_parse")
    }
}

impl StorageCause for serde_json::Error {
    fn cause(&self) -> Cause {
        Cause::plain("json")
    }
}

/// Already logged where it was first mapped; mapping it again must not log a second line.
impl StorageCause for MailError {
    fn cause(&self) -> Cause {
        Cause::plain("already_logged")
    }
}

fn record(site: &'static Location<'static>, cause: &Cause) {
    if cause.kind == "already_logged" {
        return;
    }
    match cause.sqlite {
        Some((code, extended)) => log::error!(
            target: LOG_TARGET,
            "storage failure site={}:{} cause={} code={} extended={}",
            site.file(),
            site.line(),
            cause.kind,
            code,
            extended
        ),
        None => log::error!(
            target: LOG_TARGET,
            "storage failure site={}:{} cause={}",
            site.file(),
            site.line(),
            cause.kind
        ),
    }
}

/// Replacement for `.map_err(|_| MailError::StorageUnavailable)`: logs once, returns the same
/// wire error. The recorded site is the caller of this function.
#[track_caller]
pub(crate) fn storage_err<E: StorageCause>() -> impl FnOnce(E) -> MailError {
    let site = Location::caller();
    move |error| {
        record(site, &error.cause());
        MailError::StorageUnavailable
    }
}

/// A storage failure with no underlying error to classify (a missing row that must exist, an
/// impossible persisted state, a simulated persistence loss). `reason` must be a static tag.
#[track_caller]
pub(crate) fn storage_fault(reason: &'static str) -> MailError {
    record(Location::caller(), &Cause::plain(reason));
    MailError::StorageUnavailable
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::sync::{Mutex, Once};

    const SENSITIVE_SUBJECT: &str = "Quarterly layoffs plan";
    const SENSITIVE_ADDRESS: &str = "ceo.private@example.test";
    const SENSITIVE_COLUMN: &str = "secret_body_of_alice";

    static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());
    static SERIAL: Mutex<()> = Mutex::new(());
    static INSTALL: Once = Once::new();

    struct Capture;

    impl log::Log for Capture {
        fn enabled(&self, metadata: &log::Metadata) -> bool {
            metadata.target() == LOG_TARGET
        }
        fn log(&self, record: &log::Record) {
            if self.enabled(record.metadata()) {
                LINES.lock().unwrap().push(format!(
                    "{} {}: {}",
                    record.level(),
                    record.target(),
                    record.args()
                ));
            }
        }
        fn flush(&self) {}
    }

    /// Serialises tests that read the shared capture and returns the lines logged from this
    /// file while `run` executes. Other tests in the crate may log concurrently; their lines
    /// carry other call sites and are ignored.
    fn capture(run: impl FnOnce()) -> Vec<String> {
        let _guard = SERIAL
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        INSTALL.call_once(|| {
            log::set_logger(&Capture).expect("install capture logger");
            log::set_max_level(log::LevelFilter::Trace);
        });
        LINES.lock().unwrap().clear();
        run();
        LINES
            .lock()
            .unwrap()
            .iter()
            .filter(|line| line.contains("crates/mail-core/src/storage_log.rs:"))
            .cloned()
            .collect()
    }

    fn assert_no_sensitive_text(line: &str) {
        for fragment in [
            SENSITIVE_SUBJECT,
            SENSITIVE_ADDRESS,
            SENSITIVE_COLUMN,
            "layoffs",
            "ceo.private",
            "alice",
        ] {
            assert!(
                !line.contains(fragment),
                "log line leaked {fragment:?}: {line}"
            );
        }
    }

    fn database_with_trigger() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(&format!(
            "CREATE TABLE message (subject TEXT);
             CREATE TRIGGER reject BEFORE INSERT ON message
             BEGIN SELECT RAISE(ABORT, '{SENSITIVE_SUBJECT} sent to {SENSITIVE_ADDRESS}'); END;"
        ))
        .unwrap();
        conn
    }

    #[test]
    fn sqlite_failure_logs_code_and_site_but_never_message_text() {
        let conn = database_with_trigger();
        let mut result = None;
        let lines = capture(|| {
            result = Some(
                conn.execute("INSERT INTO message VALUES (?1)", [SENSITIVE_SUBJECT])
                    .map_err(storage_err()),
            );
        });

        // The wire error is exactly what it was before logging existed.
        assert_eq!(result.unwrap(), Err(MailError::StorageUnavailable));
        // Exactly one diagnosable line, with code, extended code and the call site.
        assert_eq!(lines.len(), 1, "{lines:?}");
        let line = &lines[0];
        assert!(line.starts_with("ERROR mail_core::storage: storage failure site="));
        assert!(
            line.contains("cause=sqlite code=ConstraintViolation"),
            "{line}"
        );
        assert!(line.contains("extended=1811"), "{line}");
        assert_no_sensitive_text(line);

        // The test is only meaningful if SQLite really put the text in its error.
        let raw = conn
            .execute("INSERT INTO message VALUES (?1)", [SENSITIVE_SUBJECT])
            .unwrap_err();
        assert!(raw.to_string().contains(SENSITIVE_SUBJECT));
        assert!(raw.to_string().contains(SENSITIVE_ADDRESS));
    }

    #[test]
    fn sql_text_and_identifiers_in_errors_are_not_logged() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE message (subject TEXT);")
            .unwrap();
        let mut result = None;
        let lines = capture(|| {
            result = Some(
                conn.prepare(&format!("SELECT {SENSITIVE_COLUMN} FROM message"))
                    .map(|_| ())
                    .map_err(storage_err()),
            );
        });
        assert_eq!(result.unwrap(), Err(MailError::StorageUnavailable));
        assert_eq!(lines.len(), 1, "{lines:?}");
        assert!(
            lines[0].contains("cause=sqlite code=Unknown"),
            "{}",
            lines[0]
        );
        assert_no_sensitive_text(&lines[0]);

        let raw = conn
            .prepare(&format!("SELECT {SENSITIVE_COLUMN} FROM message"))
            .map(|_| ())
            .unwrap_err();
        assert!(raw.to_string().contains(SENSITIVE_COLUMN));
    }

    #[test]
    fn lock_poison_and_missing_rows_are_labelled_without_a_sqlite_code() {
        let poisoned = std::sync::Arc::new(Mutex::new(0_u8));
        let clone = std::sync::Arc::clone(&poisoned);
        let _ = std::thread::spawn(move || {
            let _held = clone.lock().unwrap();
            panic!("poison the lock");
        })
        .join();
        let mut errors = Vec::new();
        let lines = capture(|| {
            errors.push(poisoned.lock().map(|_| ()).map_err(storage_err()));
            errors.push(Err(storage_fault("missing_persisted_row")));
        });
        assert_eq!(errors, vec![Err(MailError::StorageUnavailable); 2]);
        assert_eq!(lines.len(), 2, "{lines:?}");
        assert!(lines[0].contains("cause=lock_poisoned"), "{}", lines[0]);
        assert!(!lines[0].contains("code="), "{}", lines[0]);
        assert!(
            lines[1].contains("cause=missing_persisted_row"),
            "{}",
            lines[1]
        );
    }

    #[test]
    fn remapping_an_already_logged_error_does_not_log_twice() {
        let conn = database_with_trigger();
        let mut result = None;
        let lines = capture(|| {
            let first: Result<usize, MailError> = conn
                .execute("INSERT INTO message VALUES (?1)", [SENSITIVE_SUBJECT])
                .map_err(storage_err());
            result = Some(first.map_err(storage_err()));
        });
        assert_eq!(result.unwrap(), Err(MailError::StorageUnavailable));
        assert_eq!(lines.len(), 1, "{lines:?}");
    }
}
