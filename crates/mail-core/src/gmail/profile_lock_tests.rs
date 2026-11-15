//! `GmailCore::open_synthetic_profile` takes the profile lock before the
//! synthetic provider creates or seeds any file, so a profile that another
//! writer holds is rejected without being touched (ADR 0002).

use std::sync::Arc;

use super::sync::GmailCore;
use crate::clock::SystemClock;
use crate::error::MailError;
use crate::lock::ProfileGuard;
use crate::synthetic::{WriteControls, SYNTHETIC_DB_FILE};
use crate::testing::temp_profile;

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<_> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn a_held_profile_is_rejected_before_the_synthetic_provider_creates_any_file() {
    let dir = temp_profile("synthetic-profile-lock");
    let profile = dir.path().join("fixture-profile");
    let other_writer = ProfileGuard::acquire(&profile).unwrap();
    // Only the lock file exists: nothing of the synthetic profile yet.
    assert_eq!(names(&profile), ["profile.lock"]);

    let result = GmailCore::open_synthetic_profile(
        &profile,
        WriteControls::default(),
        Arc::new(SystemClock),
    );
    assert!(
        matches!(result, Err(MailError::ProfileInUse)),
        "the held profile must be reported as in use"
    );
    assert!(
        !profile.join(SYNTHETIC_DB_FILE).exists(),
        "the synthetic provider must not create its database before the lock is taken"
    );
    assert_eq!(
        names(&profile),
        ["profile.lock"],
        "a rejected open leaves the profile exactly as it was"
    );

    // Once the other writer lets go the same profile opens normally.
    drop(other_writer);
    let core = GmailCore::open_synthetic_profile(
        &profile,
        WriteControls::default(),
        Arc::new(SystemClock),
    )
    .unwrap();
    assert!(profile.join(SYNTHETIC_DB_FILE).exists());
    core.stop();
}
