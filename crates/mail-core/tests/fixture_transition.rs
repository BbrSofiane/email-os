//! The one-time retirement of the legacy fixture database (ADR 0002 stage 4):
//! every state, and every failure path: cancel, crash and restart at each
//! step, insufficient disk, backup failure, and "a verified backup exists
//! before anything is deleted".

use std::collections::BTreeMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use mail_core::fixture_transition::{
    Fault, FixtureTransition, FixtureTransitionFailure, FixtureTransitionState, Step,
    TransitionEnv, BACKUP_DIR, LEGACY_DB, MARKER_FILE,
};
use mail_core::testing::temp_profile;
use mail_core::MailError;
use rusqlite::Connection;

const ALL_STEPS: [Step; 11] = [
    Step::Preflight,
    Step::MarkBackingUp,
    Step::BackupWrite,
    Step::BackupVerify,
    Step::BackupRename,
    Step::MarkBackupDone,
    Step::RemoveWal,
    Step::RemoveShm,
    Step::RemoveJournal,
    Step::RemoveDb,
    Step::MarkDone,
];

/// Steps before the point of no return (`backup_done` durable).
fn before_point_of_no_return(step: Step) -> bool {
    matches!(
        step,
        Step::Preflight
            | Step::MarkBackingUp
            | Step::BackupWrite
            | Step::BackupVerify
            | Step::BackupRename
            | Step::MarkBackupDone
    )
}

struct TestEnv {
    available: AtomicU64,
    plan: Mutex<Option<(Step, Fault)>>,
    stamps: AtomicU32,
}

impl TestEnv {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            available: AtomicU64::new(u64::MAX),
            plan: Mutex::new(None),
            stamps: AtomicU32::new(0),
        })
    }
    /// Fires once at `step`, then the env is healthy again.
    fn inject(&self, step: Step, fault: Fault) {
        *self.plan.lock().unwrap() = Some((step, fault));
    }
}

impl TransitionEnv for TestEnv {
    fn available_bytes(&self, _dir: &Path) -> io::Result<u64> {
        Ok(self.available.load(Ordering::SeqCst))
    }
    fn checkpoint(&self, step: Step) -> Result<(), Fault> {
        let mut plan = self.plan.lock().unwrap();
        if let Some((planned, fault)) = *plan {
            if planned == step {
                *plan = None;
                return Err(fault);
            }
        }
        Ok(())
    }
    fn stamp(&self) -> String {
        format!(
            "20261115T0000{:02}Z",
            self.stamps.fetch_add(1, Ordering::SeqCst)
        )
    }
}

struct Profile {
    _root: tempfile::TempDir,
    fixture: PathBuf,
    gmail: PathBuf,
}

impl Profile {
    /// A fixture profile holding a REAL legacy `mail.db` (built once with the
    /// legacy core: 18 conversations, 26 messages, 4 operations, a reminder),
    /// with drafts and a Gmail profile sentinel beside it.
    fn legacy() -> Self {
        let profile = Self::empty();
        std::fs::copy(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("tests/fixtures/legacy-fixture-profile/mail.db"),
            profile.fixture.join(LEGACY_DB),
        )
        .unwrap();
        profile
    }

    fn empty() -> Self {
        let root = temp_profile("fixture-transition");
        let fixture = root.path().join("fixture-profile");
        let gmail = root.path().join("gmail-profile");
        std::fs::create_dir_all(fixture.join("local-drafts")).unwrap();
        std::fs::create_dir_all(&gmail).unwrap();
        std::fs::write(fixture.join("local-drafts/draft-1.json"), b"{\"draft\":1}").unwrap();
        std::fs::write(gmail.join("gmail.db"), b"gmail-sentinel").unwrap();
        std::fs::write(gmail.join("credentials-marker"), b"keep").unwrap();
        Self {
            _root: root,
            fixture,
            gmail,
        }
    }

    fn transition(&self, env: &Arc<TestEnv>) -> FixtureTransition {
        FixtureTransition::with_env(&self.fixture, env.clone())
    }

    fn legacy_bytes(&self) -> Option<Vec<u8>> {
        std::fs::read(self.fixture.join(LEGACY_DB)).ok()
    }

    /// Everything the transition must never touch.
    fn untouchable(&self) -> BTreeMap<String, Vec<u8>> {
        let mut found = BTreeMap::new();
        for root in [&self.gmail, &self.fixture.join("local-drafts")] {
            for entry in std::fs::read_dir(root).unwrap() {
                let path = entry.unwrap().path();
                found.insert(path.display().to_string(), std::fs::read(&path).unwrap());
            }
        }
        found
    }

    fn backups(&self) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(self.fixture.join(BACKUP_DIR))
            .map(|entries| entries.flatten().map(|e| e.path()).collect())
            .unwrap_or_default();
        files.sort();
        files
    }

    fn complete_backups(&self) -> Vec<PathBuf> {
        self.backups()
            .into_iter()
            .filter(|p| p.extension().is_some_and(|e| e == "db"))
            .collect()
    }

    fn marker(&self) -> Option<String> {
        std::fs::read_to_string(self.fixture.join(MARKER_FILE)).ok()
    }
}

fn counts(path: &Path) -> (i64, i64, i64) {
    let conn = Connection::open(path).unwrap();
    let count = |t: &str| -> i64 {
        conn.query_row(&format!("SELECT COUNT(*) FROM {t}"), [], |r| r.get(0))
            .unwrap()
    };
    (
        count("conversations"),
        count("messages"),
        count("operations"),
    )
}

fn assert_verified_backup(profile: &Profile) {
    let backups = profile.complete_backups();
    assert!(!backups.is_empty(), "a complete backup exists");
    for backup in backups {
        assert_eq!(
            counts(&backup),
            (18, 26, 4),
            "backup reproduces the legacy rows"
        );
        let integrity: String = Connection::open(&backup)
            .unwrap()
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .unwrap();
        assert_eq!(integrity, "ok");
    }
}

fn assert_legacy_intact(profile: &Profile, original: &[u8]) {
    assert_eq!(
        profile.legacy_bytes().as_deref(),
        Some(original),
        "mail.db untouched"
    );
}

#[test]
fn fresh_profile_and_gmail_mode_need_nothing_and_touch_nothing() {
    let profile = Profile::empty();
    let env = TestEnv::new();
    let before = profile.untouchable();
    let transition = profile.transition(&env);
    assert_eq!(
        transition.status().unwrap().state,
        FixtureTransitionState::NotNeeded
    );
    assert_eq!(
        transition.accept().unwrap().state,
        FixtureTransitionState::NotNeeded
    );
    assert!(profile.marker().is_none() && profile.backups().is_empty());
    assert_eq!(
        FixtureTransition::inactive().status().unwrap().state,
        FixtureTransitionState::NotNeeded
    );
    assert_eq!(profile.untouchable(), before);
}

#[test]
fn legacy_profile_needs_disclosure_and_cancel_changes_nothing() {
    let profile = Profile::legacy();
    let original = profile.legacy_bytes().unwrap();
    let env = TestEnv::new();
    let before = profile.untouchable();
    for _ in 0..3 {
        // "Cancel" is never calling accept: quit, relaunch, ask again.
        let status = profile.transition(&env).status().unwrap();
        assert_eq!(status.state, FixtureTransitionState::NeedsDisclosure);
        assert_eq!(status.legacy_megabytes, Some(1));
        assert_eq!(status.failure, None);
    }
    assert_legacy_intact(&profile, &original);
    assert!(profile.marker().is_none() && profile.backups().is_empty());
    assert_eq!(profile.untouchable(), before);
}

#[test]
fn accept_backs_up_verifies_retires_and_is_idempotent() {
    let profile = Profile::legacy();
    let env = TestEnv::new();
    let before = profile.untouchable();
    let transition = profile.transition(&env);
    let status = transition.accept().unwrap();
    assert_eq!(status.state, FixtureTransitionState::Done);
    assert_verified_backup(&profile);
    assert_eq!(profile.complete_backups().len(), 1);
    assert!(profile.legacy_bytes().is_none(), "mail.db retired");
    for side in ["mail.db-wal", "mail.db-shm", "mail.db-journal"] {
        assert!(!profile.fixture.join(side).exists());
    }
    assert!(profile.marker().unwrap().contains("\"done\""));
    // Idempotent, also for a brand-new process.
    assert_eq!(
        transition.accept().unwrap().state,
        FixtureTransitionState::Done
    );
    assert_eq!(
        profile.transition(&env).status().unwrap().state,
        FixtureTransitionState::Done
    );
    assert_eq!(profile.complete_backups().len(), 1);
    // The Gmail profile, credentials and local drafts never changed.
    assert_eq!(profile.untouchable(), before);
}

#[test]
fn insufficient_disk_changes_nothing_and_says_how_much_is_needed() {
    let profile = Profile::legacy();
    let original = profile.legacy_bytes().unwrap();
    let env = TestEnv::new();
    env.available.store(1024 * 1024, Ordering::SeqCst); // 1 MiB free
    let before = profile.untouchable();
    let status = profile.transition(&env).accept().unwrap();
    assert_eq!(status.state, FixtureTransitionState::Failed);
    assert!(matches!(
        status.failure,
        Some(FixtureTransitionFailure::InsufficientDisk { required_megabytes, available_megabytes })
            if required_megabytes >= 17 && available_megabytes == 1
    ));
    assert_legacy_intact(&profile, &original);
    assert!(profile.marker().is_none() && profile.backups().is_empty());
    assert_eq!(profile.untouchable(), before);
    // Space freed: the same profile completes.
    env.available.store(u64::MAX, Ordering::SeqCst);
    assert_eq!(
        profile.transition(&env).accept().unwrap().state,
        FixtureTransitionState::Done
    );
    assert_verified_backup(&profile);
}

#[test]
fn a_backup_failure_at_any_stage_deletes_nothing_and_a_retry_succeeds() {
    for step in [
        Step::MarkBackingUp,
        Step::BackupWrite,
        Step::BackupVerify,
        Step::BackupRename,
        Step::MarkBackupDone,
    ] {
        let profile = Profile::legacy();
        let original = profile.legacy_bytes().unwrap();
        let env = TestEnv::new();
        env.inject(step, Fault::Io(io::ErrorKind::StorageFull));
        let status = profile.transition(&env).accept().unwrap();
        assert_eq!(status.state, FixtureTransitionState::Failed, "{step:?}");
        assert_eq!(
            status.failure,
            Some(FixtureTransitionFailure::BackupFailed),
            "{step:?}"
        );
        // The old data is exactly as it was; no partial file lingers.
        assert_legacy_intact(&profile, &original);
        assert!(
            profile
                .backups()
                .iter()
                .all(|p| !p.to_string_lossy().ends_with(".partial")),
            "{step:?}: no partial backup left"
        );
        assert_eq!(
            profile.transition(&env).status().unwrap().state,
            FixtureTransitionState::NeedsDisclosure,
            "{step:?}: asks again"
        );
        // The fault was one-shot: the retry completes.
        assert_eq!(
            profile.transition(&env).accept().unwrap().state,
            FixtureTransitionState::Done,
            "{step:?}"
        );
        assert_verified_backup(&profile);
    }
}

#[test]
fn a_corrupt_backup_is_never_trusted_the_original_is_kept() {
    // The backup is verified against the legacy row counts before anything is
    // deleted: a source that cannot be snapshotted fails the backup stage.
    let profile = Profile::legacy();
    let env = TestEnv::new();
    std::fs::write(profile.fixture.join(LEGACY_DB), b"this is not a database").unwrap();
    let original = profile.legacy_bytes().unwrap();
    let status = profile.transition(&env).accept().unwrap();
    assert_eq!(status.failure, Some(FixtureTransitionFailure::BackupFailed));
    assert_legacy_intact(&profile, &original);
    assert!(profile.complete_backups().is_empty());
}

#[test]
fn a_crash_at_every_step_recovers_without_loss_or_a_second_prompt_after_the_backup() {
    for step in ALL_STEPS {
        let profile = Profile::legacy();
        let original = profile.legacy_bytes().unwrap();
        let before = profile.untouchable();
        let env = TestEnv::new();
        env.inject(step, Fault::Crash);
        let outcome = profile.transition(&env).accept();
        assert_eq!(
            outcome,
            Err(MailError::StorageUnavailable),
            "{step:?}: the crash is surfaced"
        );

        // Restart: a NEW process (fresh env, no injected fault).
        let restarted_env = TestEnv::new();
        let restarted = profile.transition(&restarted_env);
        let status = restarted.status().unwrap();
        if before_point_of_no_return(step) {
            // The legacy files are intact; the user is asked again.
            assert_eq!(
                status.state,
                FixtureTransitionState::NeedsDisclosure,
                "{step:?}"
            );
            assert_legacy_intact(&profile, &original);
            assert!(
                profile
                    .backups()
                    .iter()
                    .all(|p| !p.to_string_lossy().ends_with(".partial")),
                "{step:?}: partial backup cleaned"
            );
            assert_eq!(
                restarted.accept().unwrap().state,
                FixtureTransitionState::Done,
                "{step:?}"
            );
        } else {
            // The verified backup exists: the reset resumes without asking.
            assert_eq!(status.state, FixtureTransitionState::Done, "{step:?}");
        }
        assert_verified_backup(&profile);
        assert!(
            profile.complete_backups().len() <= 2,
            "{step:?}: at most one stray backup"
        );
        assert!(
            profile.legacy_bytes().is_none(),
            "{step:?}: retired exactly once"
        );
        assert!(profile.marker().unwrap().contains("\"done\""), "{step:?}");
        // And it never runs again.
        assert_eq!(
            profile.transition(&TestEnv::new()).status().unwrap().state,
            FixtureTransitionState::Done
        );
        assert_eq!(
            profile.untouchable(),
            before,
            "{step:?}: drafts and Gmail untouched"
        );
    }
}

#[test]
fn a_verified_backup_exists_before_any_legacy_file_is_removed() {
    // Fail at each removal step: the backup is already complete and verified,
    // the failure is reported as a reset failure, and the next start finishes it.
    for step in [
        Step::RemoveWal,
        Step::RemoveShm,
        Step::RemoveJournal,
        Step::RemoveDb,
        Step::MarkDone,
    ] {
        let profile = Profile::legacy();
        let env = TestEnv::new();
        env.inject(step, Fault::Io(io::ErrorKind::PermissionDenied));
        let status = profile.transition(&env).accept().unwrap();
        assert_eq!(
            status.failure,
            Some(FixtureTransitionFailure::ResetFailed),
            "{step:?}"
        );
        assert_verified_backup(&profile);
        assert!(
            profile.marker().unwrap().contains("backup_done") || step == Step::MarkDone,
            "{step:?}"
        );
        let finished = profile.transition(&TestEnv::new()).status().unwrap();
        assert_eq!(finished.state, FixtureTransitionState::Done, "{step:?}");
        assert!(profile.legacy_bytes().is_none());
        assert_eq!(profile.complete_backups().len(), 1);
    }
}

#[test]
fn a_missing_backup_after_backup_done_never_deletes_the_legacy_file() {
    let profile = Profile::legacy();
    let original = profile.legacy_bytes().unwrap();
    let env = TestEnv::new();
    env.inject(Step::RemoveWal, Fault::Crash);
    assert!(profile.transition(&env).accept().is_err());
    // Someone removed the backup before the restart.
    for backup in profile.complete_backups() {
        std::fs::remove_file(backup).unwrap();
    }
    let status = profile.transition(&TestEnv::new()).status().unwrap();
    assert_eq!(status.state, FixtureTransitionState::NeedsDisclosure);
    assert_legacy_intact(&profile, &original);
}

#[test]
fn an_unreadable_marker_fails_closed_without_deleting_anything() {
    let profile = Profile::legacy();
    let original = profile.legacy_bytes().unwrap();
    std::fs::write(profile.fixture.join(MARKER_FILE), b"{ not json").unwrap();
    let transition = profile.transition(&TestEnv::new());
    assert_eq!(transition.status(), Err(MailError::StorageUnavailable));
    assert_eq!(transition.accept(), Err(MailError::StorageUnavailable));
    assert_legacy_intact(&profile, &original);
    assert!(profile.backups().is_empty());
}

#[test]
fn done_wins_over_a_stray_legacy_file_which_is_left_alone() {
    // e.g. the user ran an older build once more after the transition.
    let profile = Profile::legacy();
    assert_eq!(
        profile.transition(&TestEnv::new()).accept().unwrap().state,
        FixtureTransitionState::Done
    );
    std::fs::write(profile.fixture.join(LEGACY_DB), b"stray").unwrap();
    assert_eq!(
        profile.transition(&TestEnv::new()).status().unwrap().state,
        FixtureTransitionState::Done
    );
    assert_eq!(profile.legacy_bytes().unwrap(), b"stray");
}

#[test]
fn a_wal_mode_legacy_database_with_live_side_files_is_snapshotted_consistently() {
    // A legacy core that died leaves -wal/-shm behind with committed rows in
    // the WAL only. The backup must contain them (a raw copy of mail.db would not).
    let profile = Profile::legacy();
    let conn = Connection::open(profile.fixture.join(LEGACY_DB)).unwrap();
    conn.pragma_update(None, "journal_mode", "WAL").unwrap();
    conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
    conn.execute(
        "INSERT INTO conversations (account_id, conversation_id, subject) VALUES ('fixture-account','wal-only','in the wal')",
        [],
    )
    .unwrap();
    assert!(profile.fixture.join("mail.db-wal").exists());
    // Leak the connection so the WAL stays, like a crashed process.
    std::mem::forget(conn);
    let status = profile.transition(&TestEnv::new()).accept().unwrap();
    assert_eq!(status.state, FixtureTransitionState::Done);
    let backup = &profile.complete_backups()[0];
    let rows: i64 = Connection::open(backup)
        .unwrap()
        .query_row(
            "SELECT COUNT(*) FROM conversations WHERE conversation_id='wal-only'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(rows, 1, "the WAL-only row is in the backup");
}
