//! OS-backed profile lock held for the full core lifetime. A second writer on
//! the same profile is rejected (`profile_in_use`) instead of corrupting the
//! database. Uses std file locking (`File::try_lock`, stable since 1.89).

use std::fs::{File, OpenOptions};
use std::io;
use std::path::{Path, PathBuf};

use crate::error::MailError;

pub(crate) struct ProfileGuard {
    /// Held open for the lifetime of the core; closing releases the lock.
    _lock_file: File,
    #[allow(dead_code)]
    path: PathBuf,
}

impl ProfileGuard {
    pub(crate) fn acquire(profile_dir: &Path) -> Result<ProfileGuard, MailError> {
        std::fs::create_dir_all(profile_dir).map_err(io_err)?;
        let path = profile_dir.join("profile.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(io_err)?;
        lock_file.try_lock().map_err(|err| match err {
            std::fs::TryLockError::WouldBlock => MailError::ProfileInUse,
            std::fs::TryLockError::Error(_) => MailError::StorageUnavailable,
        })?;
        Ok(ProfileGuard {
            _lock_file: lock_file,
            path,
        })
    }
}

fn io_err(_: io::Error) -> MailError {
    MailError::StorageUnavailable
}
