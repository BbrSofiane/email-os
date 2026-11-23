//! The Android mode choice (ADR 0005 section 3): `<app_data_dir>/mode.json`
//! holds {"mode":"fixture"} or {"mode":"gmail"}. Desktop ignores it.

use crate::diagnostics::{cause, storage_failure};
use crate::state::{retire_session, AppState, Session};
use mail_core::{error::MailError, gmail::types::MailMode};
use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};

const MODE_FILE: &str = "mode.json";
static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

#[derive(Serialize, Deserialize)]
struct ModeFile {
    mode: MailMode,
}

/// None when the file is absent, unreadable, corrupt or names an unknown mode.
// Wired by the mode commands (next part).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn read_mode(app_data_dir: &Path) -> Option<MailMode> {
    let data = fs::read(app_data_dir.join(MODE_FILE)).ok()?;
    match serde_json::from_slice::<ModeFile>(&data) {
        Ok(file) => Some(file.mode),
        Err(_) => {
            let _ = storage_failure(cause::MODE_CORRUPT);
            None
        }
    }
}

/// Atomically writes the mode and best-effort syncs the directory.
// Wired by the mode commands (next part).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn write_mode(app_data_dir: &Path, mode: MailMode) -> Result<(), MailError> {
    let write = || -> std::io::Result<()> {
        fs::create_dir_all(app_data_dir)?;
        let (path, mut file) = loop {
            let id = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
            let path = app_data_dir.join(format!(".mode-{}-{id}.tmp", std::process::id()));
            match OpenOptions::new().write(true).create_new(true).open(&path) {
                Ok(file) => break (path, file),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        };
        let result = (|| {
            serde_json::to_writer(&mut file, &ModeFile { mode })?;
            file.flush()?;
            file.sync_all()?;
            fs::rename(&path, app_data_dir.join(MODE_FILE))?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(&path);
        } else if let Ok(dir) = fs::File::open(app_data_dir) {
            let _ = dir.sync_all();
        }
        result
    };
    write().map_err(|_| storage_failure(cause::MODE_WRITE))
}

/// Opens the target before replacing and retiring the current session.
// Wired by the mode commands (next part).
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn switch_session(
    state: &AppState,
    open_target: impl FnOnce() -> Result<Session, MailError>,
) -> Result<(), MailError> {
    let next = open_target()?;
    let old = state.replace_session(next)?;
    retire_session(&old);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use mail_core::drafts::{CreateDraft, DraftContent, DraftCore, DraftSource, SaveDraft};
    use mail_core::testing::temp_profile;
    use std::sync::Arc;

    fn session(path: &Path) -> Session {
        let (core, profile) = crate::setup::open_fixture_core(path).unwrap();
        Session::new(
            core,
            DraftCore::open(profile.join("local-drafts")).unwrap(),
            || {},
        )
    }

    #[test]
    fn mode_files_round_trip_and_reject_invalid_data() {
        let dir = temp_profile("mode-file");
        assert_eq!(read_mode(dir.path()), None);
        for mode in [MailMode::Fixture, MailMode::Gmail] {
            write_mode(dir.path(), mode).unwrap();
            assert_eq!(read_mode(dir.path()), Some(mode));
            assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
        }
        for data in [r#"{"mode":"other"}"#, "not json"] {
            fs::write(dir.path().join(MODE_FILE), data).unwrap();
            assert_eq!(read_mode(dir.path()), None);
        }
    }

    #[test]
    fn switch_retires_old_session_and_releases_profile() {
        let a = temp_profile("mode-a");
        let b = temp_profile("mode-b");
        let (core, profile) = crate::setup::open_fixture_core(a.path()).unwrap();
        let state = AppState::new(
            core,
            DraftCore::open(profile.join("local-drafts")).unwrap(),
            || {},
        );
        let drafts = state.session().unwrap().drafts.clone();
        let receipt = drafts
            .create_draft(&CreateDraft {
                request_id: "create".into(),
                source: DraftSource::NewMessage,
                initial_content: None,
            })
            .unwrap();
        switch_session(&state, || Ok(session(b.path()))).unwrap();
        assert!(state.session().unwrap().core.list_conversations().is_ok());
        assert_eq!(
            drafts.save_draft(&SaveDraft {
                draft_ref: receipt.draft_ref,
                expected_revision: receipt.revision,
                request_id: "save".into(),
                content: DraftContent {
                    to: String::new(),
                    cc: String::new(),
                    subject: String::new(),
                    body_text: String::new()
                }
            }),
            Err(MailError::InvalidRequest {
                field: "mode".into()
            })
        );
        assert!(state
            .session()
            .unwrap()
            .drafts
            .list_drafts()
            .unwrap()
            .is_empty());
        // The profile lock belongs to the core and is released when the last
        // handle to the retired session goes; here that is the test's clone.
        drop(drafts);
        let reopened = session(a.path());
        reopened.core.stop();
        state.session().unwrap().core.stop();
    }

    #[test]
    fn failed_open_preserves_session_and_drafts() {
        let a = temp_profile("mode-failed");
        let (core, profile) = crate::setup::open_fixture_core(a.path()).unwrap();
        let state = AppState::new(
            core,
            DraftCore::open(profile.join("local-drafts")).unwrap(),
            || {},
        );
        let old = state.session().unwrap();
        assert_eq!(
            switch_session(&state, || Err(MailError::StorageUnavailable)),
            Err(MailError::StorageUnavailable)
        );
        assert!(Arc::ptr_eq(&old, &state.session().unwrap()));
        assert!(old
            .drafts
            .create_draft(&CreateDraft {
                request_id: "create".into(),
                source: DraftSource::NewMessage,
                initial_content: None
            })
            .is_ok());
        old.core.stop();
    }
}
