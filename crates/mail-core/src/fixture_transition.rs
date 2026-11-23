//! One-time retirement of the legacy fixture database (ADR 0002, stage 4).
//!
//! Before this change fixture mode kept its operation history in
//! `<fixture-profile>/mail.db`. The unified fixture keeps it in the Gmail
//! core's own files instead, so the legacy file is retired exactly once, with
//! the user's knowledge and a verified backup. This module is the state
//! machine for that retirement; the shell exposes it through two commands
//! (`get_fixture_transition_status`, `accept_fixture_transition`) behind a
//! startup screen.
//!
//! What it touches, and nothing else: `mail.db` (and its `-wal`, `-shm` and
//! `-journal` files), `backups/` and `fixture-transition.json`, all directly
//! under the fixture profile directory it is given. It never opens
//! `local-drafts`, `gmail-profile` or any credential.
//!
//! # State machine (persisted in `fixture-transition.json`, written atomically)
//!
//! ```text
//! no marker + mail.db        -> needs_disclosure      (derived, nothing persisted)
//! accept: preflight disk     -> failed(insufficient_disk)   (nothing written)
//!         marker backing_up
//!         VACUUM INTO backups/mail-<utc>.db.partial, fsync, integrity_check and
//!         row-count verification, rename, fsync dir
//!         marker backup_done {file}                    <- point of no return
//!         remove mail.db-wal/-shm/-journal, then mail.db, fsync dir
//!         marker done
//! ```
//!
//! * The legacy files are never removed before the backup is verified and the
//!   `backup_done` marker is durable.
//! * A crash before `backup_done` leaves the legacy files intact: the next
//!   start removes partial backups and asks again. A crash after it resumes
//!   the removal on the next start without asking (consent and a verified
//!   backup already exist).
//! * `done` is final: the transition never runs twice, so a crash cannot make
//!   it reset a profile repeatedly.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::error::MailError;
use crate::storage_log::{storage_err, storage_fault};

pub const MARKER_FILE: &str = "fixture-transition.json";
pub const LEGACY_DB: &str = "mail.db";
pub const BACKUP_DIR: &str = "backups";
const LEGACY_SIDE_FILES: [&str; 3] = ["mail.db-wal", "mail.db-shm", "mail.db-journal"];
const PARTIAL_SUFFIX: &str = ".partial";
/// Free space required beyond twice the legacy size, for the backup, SQLite
/// temporary files and the marker.
const SAFETY_MARGIN_BYTES: u64 = 16 * 1024 * 1024;
const MEGABYTE: u64 = 1024 * 1024;
const VERIFIED_TABLES: [&str; 3] = ["conversations", "messages", "operations"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "snake_case")]
pub enum FixtureTransitionState {
    /// Nothing to retire (fresh profile, Gmail mode, or already finished).
    NotNeeded,
    /// A legacy fixture database exists; the user must be told before it is retired.
    NeedsDisclosure,
    /// The legacy database was backed up and retired.
    Done,
    /// The last attempt did not complete; nothing is lost. See `failure`.
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
#[ts(rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum FixtureTransitionFailure {
    /// There is not enough free space to make a verified backup. Nothing changed.
    InsufficientDisk {
        required_megabytes: u32,
        available_megabytes: u32,
    },
    /// The backup could not be written or verified. The old data is untouched.
    BackupFailed,
    /// The backup is safe but the old files could not all be removed yet; the
    /// next start finishes it.
    ResetFailed,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ModeChoice {
    pub chosen: bool,
    pub mode: crate::gmail::types::MailMode,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct FixtureTransitionStatus {
    pub state: FixtureTransitionState,
    /// Size of the existing synthetic data in whole megabytes (at least 1),
    /// present while `needsDisclosure`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub legacy_megabytes: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub failure: Option<FixtureTransitionFailure>,
}

impl FixtureTransitionStatus {
    fn plain(state: FixtureTransitionState) -> Self {
        Self {
            state,
            legacy_megabytes: None,
            failure: None,
        }
    }

    fn failed(failure: FixtureTransitionFailure) -> Self {
        Self {
            state: FixtureTransitionState::Failed,
            legacy_megabytes: None,
            failure: Some(failure),
        }
    }
}

/// Where the state machine can be interrupted, for fault injection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Step {
    Preflight,
    MarkBackingUp,
    BackupWrite,
    BackupVerify,
    BackupRename,
    MarkBackupDone,
    RemoveWal,
    RemoveShm,
    RemoveJournal,
    RemoveDb,
    MarkDone,
}

/// An injected interruption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Fault {
    /// An I/O error the code must handle (disk full, permission, ...).
    Io(io::ErrorKind),
    /// The process dies here: no cleanup runs, state is exactly as left.
    Crash,
}

/// The machine's view of the world, replaceable in tests.
pub trait TransitionEnv: Send + Sync {
    /// Free bytes on the file system holding `dir`.
    fn available_bytes(&self, dir: &Path) -> io::Result<u64>;
    /// Called before each step; return a fault to interrupt it.
    fn checkpoint(&self, _step: Step) -> Result<(), Fault> {
        Ok(())
    }
    /// UTC stamp used in the backup name (`20261115T120000Z`).
    fn stamp(&self) -> String;
}

struct RealEnv;

impl TransitionEnv for RealEnv {
    fn available_bytes(&self, dir: &Path) -> io::Result<u64> {
        available_bytes(dir)
    }

    fn stamp(&self) -> String {
        chrono::Utc::now().format("%Y%m%dT%H%M%SZ").to_string()
    }
}

#[cfg(unix)]
fn available_bytes(dir: &Path) -> io::Result<u64> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut stats: libc::statvfs = unsafe { std::mem::zeroed() };
    // SAFETY: `path` is a valid NUL-terminated string and `stats` is a valid
    // out-pointer for the duration of the call.
    if unsafe { libc::statvfs(path.as_ptr(), &mut stats) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // `fsblkcnt_t` and `c_ulong` are u64 on 64-bit Linux but u32 on macOS and
    // 32-bit Android, so the casts are needed for portability.
    #[allow(clippy::unnecessary_cast)]
    let (blocks, block_size) = (stats.f_bavail as u64, stats.f_frsize as u64);
    Ok(blocks.saturating_mul(block_size))
}

#[cfg(not(unix))]
fn available_bytes(_dir: &Path) -> io::Result<u64> {
    Ok(u64::MAX)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct Marker {
    version: u32,
    state: MarkerState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    backup: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum MarkerState {
    BackingUp,
    BackupDone,
    Done,
}

/// Result of one internal step: a handled failure, or a simulated crash.
enum Stop {
    Failed,
    Crash,
}

pub struct FixtureTransition {
    dir: Option<PathBuf>,
    env: Arc<dyn TransitionEnv>,
}

impl FixtureTransition {
    /// The transition for one fixture profile directory.
    pub fn new(fixture_profile_dir: impl Into<PathBuf>) -> Self {
        Self::with_env(fixture_profile_dir, Arc::new(RealEnv))
    }

    pub fn with_env(fixture_profile_dir: impl Into<PathBuf>, env: Arc<dyn TransitionEnv>) -> Self {
        Self {
            dir: Some(fixture_profile_dir.into()),
            env,
        }
    }

    /// For sessions with no fixture profile (Gmail mode): always `not_needed`,
    /// touches nothing.
    pub fn inactive() -> Self {
        Self {
            dir: None,
            env: Arc::new(RealEnv),
        }
    }

    /// Current state. Also finishes an interrupted reset whose verified backup
    /// already exists, and removes leftover partial backups.
    pub fn status(&self) -> Result<FixtureTransitionStatus, MailError> {
        let Some(dir) = &self.dir else {
            return Ok(FixtureTransitionStatus::plain(
                FixtureTransitionState::NotNeeded,
            ));
        };
        match self.settle(dir)? {
            Settled::Done => Ok(FixtureTransitionStatus::plain(FixtureTransitionState::Done)),
            Settled::NotNeeded => Ok(FixtureTransitionStatus::plain(
                FixtureTransitionState::NotNeeded,
            )),
            Settled::NeedsDisclosure => {
                let bytes = legacy_total_bytes(dir);
                Ok(FixtureTransitionStatus {
                    state: FixtureTransitionState::NeedsDisclosure,
                    legacy_megabytes: Some(
                        bytes.div_ceil(MEGABYTE).clamp(1, u64::from(u32::MAX)) as u32
                    ),
                    failure: None,
                })
            }
            Settled::ResetFailed => Ok(FixtureTransitionStatus::failed(
                FixtureTransitionFailure::ResetFailed,
            )),
        }
    }

    /// The user accepted: back up, verify, then retire the legacy files.
    /// Idempotent: calling it again after `done` (or with nothing to do)
    /// returns the current status.
    pub fn accept(&self) -> Result<FixtureTransitionStatus, MailError> {
        let Some(dir) = &self.dir else {
            return self.status();
        };
        let before = self.status()?;
        if before.state != FixtureTransitionState::NeedsDisclosure {
            return Ok(before);
        }
        // 1. Preflight: never start a backup we cannot finish.
        match self.run(Step::Preflight) {
            Ok(()) => {}
            Err(Stop::Crash) => return Err(storage_fault("fixture_transition_crash")),
            Err(Stop::Failed) => return Ok(Self::backup_failed()),
        }
        let legacy_bytes = legacy_total_bytes(dir);
        let required = legacy_bytes
            .saturating_mul(2)
            .saturating_add(SAFETY_MARGIN_BYTES);
        let available = match self.env.available_bytes(dir) {
            Ok(value) => value,
            Err(_) => return Ok(Self::backup_failed()),
        };
        if available < required {
            return Ok(FixtureTransitionStatus::failed(
                FixtureTransitionFailure::InsufficientDisk {
                    required_megabytes: to_megabytes(required),
                    available_megabytes: to_megabytes(available),
                },
            ));
        }
        // 2. Backup (legacy files untouched), then the point of no return.
        match self.backup(dir) {
            Ok(()) => {}
            Err(Stop::Crash) => return Err(storage_fault("fixture_transition_crash")),
            Err(Stop::Failed) => {
                cleanup_partials(dir);
                // The legacy files are intact; go back to asking.
                let _ = fs::remove_file(dir.join(MARKER_FILE));
                return Ok(Self::backup_failed());
            }
        }
        // 3. Retire the legacy files (resumable: the marker says backup_done).
        match self.retire(dir) {
            Ok(()) => Ok(FixtureTransitionStatus::plain(FixtureTransitionState::Done)),
            Err(Stop::Crash) => Err(storage_fault("fixture_transition_crash")),
            Err(Stop::Failed) => Ok(FixtureTransitionStatus::failed(
                FixtureTransitionFailure::ResetFailed,
            )),
        }
    }

    fn backup_failed() -> FixtureTransitionStatus {
        FixtureTransitionStatus::failed(FixtureTransitionFailure::BackupFailed)
    }

    fn run(&self, step: Step) -> Result<(), Stop> {
        match self.env.checkpoint(step) {
            Ok(()) => Ok(()),
            Err(Fault::Io(_)) => Err(Stop::Failed),
            Err(Fault::Crash) => Err(Stop::Crash),
        }
    }

    /// Derives the state from the marker and the files, completing what a
    /// crash left half done.
    fn settle(&self, dir: &Path) -> Result<Settled, MailError> {
        cleanup_partials(dir);
        let marker = read_marker(dir)?;
        match marker {
            Some(Marker {
                state: MarkerState::Done,
                ..
            }) => return Ok(Settled::Done),
            Some(Marker {
                state: MarkerState::BackupDone,
                backup,
                ..
            }) => {
                let backup_exists = backup
                    .as_deref()
                    .is_some_and(|relative| dir.join(relative).is_file());
                if !backup_exists && dir.join(LEGACY_DB).is_file() {
                    // The verified backup vanished while the legacy file is
                    // still there: never delete it; ask again.
                    let _ = fs::remove_file(dir.join(MARKER_FILE));
                } else {
                    return match self.retire(dir) {
                        Ok(()) => Ok(Settled::Done),
                        Err(Stop::Crash) => Err(storage_fault("fixture_transition_crash")),
                        Err(Stop::Failed) => Ok(Settled::ResetFailed),
                    };
                }
            }
            Some(Marker {
                state: MarkerState::BackingUp,
                ..
            }) => {
                // Interrupted before the backup was verified: the legacy files
                // are intact, so forget the attempt and ask again.
                let _ = fs::remove_file(dir.join(MARKER_FILE));
            }
            None => {}
        }
        Ok(if dir.join(LEGACY_DB).is_file() {
            Settled::NeedsDisclosure
        } else {
            Settled::NotNeeded
        })
    }

    fn backup(&self, dir: &Path) -> Result<(), Stop> {
        self.run(Step::MarkBackingUp)?;
        write_marker(
            dir,
            &Marker {
                version: 1,
                state: MarkerState::BackingUp,
                backup: None,
            },
        )
        .map_err(|_| Stop::Failed)?;

        self.run(Step::BackupWrite)?;
        let backups = dir.join(BACKUP_DIR);
        fs::create_dir_all(&backups).map_err(|_| Stop::Failed)?;
        let name = format!("mail-{}.db", self.env.stamp());
        let final_path = backups.join(&name);
        let partial = backups.join(format!("{name}{PARTIAL_SUFFIX}"));
        let _ = fs::remove_file(&partial);
        let source_counts =
            write_backup(&dir.join(LEGACY_DB), &partial).map_err(|_| Stop::Failed)?;
        File::open(&partial)
            .and_then(|file| file.sync_all())
            .map_err(|_| Stop::Failed)?;

        self.run(Step::BackupVerify)?;
        verify_backup(&partial, &source_counts).map_err(|_| Stop::Failed)?;

        self.run(Step::BackupRename)?;
        fs::rename(&partial, &final_path).map_err(|_| Stop::Failed)?;
        sync_dir(&backups);
        sync_dir(dir);

        self.run(Step::MarkBackupDone)?;
        write_marker(
            dir,
            &Marker {
                version: 1,
                state: MarkerState::BackupDone,
                backup: Some(format!("{BACKUP_DIR}/{name}")),
            },
        )
        .map_err(|_| Stop::Failed)
    }

    fn retire(&self, dir: &Path) -> Result<(), Stop> {
        let steps = [
            (Step::RemoveWal, LEGACY_SIDE_FILES[0]),
            (Step::RemoveShm, LEGACY_SIDE_FILES[1]),
            (Step::RemoveJournal, LEGACY_SIDE_FILES[2]),
            // The database itself goes last: until then a resumed run still
            // sees a legacy profile.
            (Step::RemoveDb, LEGACY_DB),
        ];
        for (step, file) in steps {
            self.run(step)?;
            match fs::remove_file(dir.join(file)) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(_) => return Err(Stop::Failed),
            }
        }
        sync_dir(dir);
        self.run(Step::MarkDone)?;
        let backup = read_marker(dir)
            .ok()
            .flatten()
            .and_then(|marker| marker.backup);
        write_marker(
            dir,
            &Marker {
                version: 1,
                state: MarkerState::Done,
                backup,
            },
        )
        .map_err(|_| Stop::Failed)
    }
}

enum Settled {
    NotNeeded,
    NeedsDisclosure,
    Done,
    ResetFailed,
}

fn to_megabytes(bytes: u64) -> u32 {
    bytes.div_ceil(MEGABYTE).min(u64::from(u32::MAX)) as u32
}

fn legacy_total_bytes(dir: &Path) -> u64 {
    std::iter::once(LEGACY_DB)
        .chain(LEGACY_SIDE_FILES)
        .filter_map(|name| fs::metadata(dir.join(name)).ok())
        .map(|meta| meta.len())
        .sum()
}

fn read_marker(dir: &Path) -> Result<Option<Marker>, MailError> {
    let path = dir.join(MARKER_FILE);
    match fs::read(&path) {
        Ok(bytes) => {
            let marker: Marker = serde_json::from_slice(&bytes)
                .map_err(|_| storage_fault("fixture_transition_marker_unreadable"))?;
            if marker.version != 1 {
                return Err(storage_fault("fixture_transition_marker_version"));
            }
            Ok(Some(marker))
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(storage_err()(error)),
    }
}

/// Write-temp, fsync, rename, fsync-dir: a reader sees the old marker or the
/// new one, never a torn file.
fn write_marker(dir: &Path, marker: &Marker) -> io::Result<()> {
    let tmp = dir.join(format!("{MARKER_FILE}.tmp"));
    let bytes = serde_json::to_vec(marker).map_err(io::Error::other)?;
    {
        let mut file = OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .open(&tmp)?;
        file.write_all(&bytes)?;
        file.sync_all()?;
    }
    fs::rename(&tmp, dir.join(MARKER_FILE))?;
    sync_dir(dir);
    Ok(())
}

fn sync_dir(dir: &Path) {
    // Best effort: not every platform can fsync a directory.
    if let Ok(handle) = File::open(dir) {
        let _ = handle.sync_all();
    }
}

fn cleanup_partials(dir: &Path) {
    let Ok(entries) = fs::read_dir(dir.join(BACKUP_DIR)) else {
        return;
    };
    for entry in entries.flatten() {
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.ends_with(PARTIAL_SUFFIX))
        {
            let _ = fs::remove_file(entry.path());
        }
    }
    let _ = fs::remove_file(dir.join(format!("{MARKER_FILE}.tmp")));
}

type Counts = Vec<(&'static str, i64)>;

/// A consistent SQLite snapshot (not a raw copy of a live WAL database) and
/// the row counts it must reproduce.
fn write_backup(source: &Path, target: &Path) -> Result<Counts, rusqlite::Error> {
    // Read-only: the legacy file is only read until the backup is verified.
    let conn = Connection::open_with_flags(
        source,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let counts = table_counts(&conn)?;
    conn.execute("VACUUM INTO ?1", [target.to_string_lossy().as_ref()])?;
    Ok(counts)
}

fn table_counts(conn: &Connection) -> Result<Counts, rusqlite::Error> {
    let mut counts = Vec::new();
    for table in VERIFIED_TABLES {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1)",
            [table],
            |row| row.get(0),
        )?;
        if exists {
            let count: i64 =
                conn.query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })?;
            counts.push((table, count));
        }
    }
    Ok(counts)
}

fn verify_backup(path: &Path, expected: &Counts) -> Result<(), rusqlite::Error> {
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    let integrity: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    if integrity != "ok" {
        return Err(rusqlite::Error::ExecuteReturnedResults);
    }
    if &table_counts(&conn)? != expected {
        return Err(rusqlite::Error::ExecuteReturnedResults);
    }
    Ok(())
}
