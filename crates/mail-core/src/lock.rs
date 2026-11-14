//! OS-backed profile lock held for the full core lifetime. A second writer on
//! the same profile is rejected (`profile_in_use`) instead of corrupting the
//! database. Uses std file locking except on Android, where libc `flock` gives
//! the same non-blocking, descriptor-lifetime lock semantics.

use std::fs::{File, OpenOptions};
use std::path::{Path, PathBuf};

use crate::error::MailError;
use crate::storage_log::storage_err;

pub(crate) struct ProfileGuard {
    /// Held open for the lifetime of the core; closing releases the lock.
    _lock_file: File,
    #[allow(dead_code)]
    path: PathBuf,
}

impl ProfileGuard {
    pub(crate) fn acquire(profile_dir: &Path) -> Result<ProfileGuard, MailError> {
        std::fs::create_dir_all(profile_dir).map_err(storage_err())?;
        let path = profile_dir.join("profile.lock");
        let lock_file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(storage_err())?;
        acquire_file_lock(&lock_file)?;
        Ok(ProfileGuard {
            _lock_file: lock_file,
            path,
        })
    }
}

#[cfg(target_os = "android")]
fn acquire_file_lock(file: &File) -> Result<(), MailError> {
    use std::os::fd::AsRawFd;

    // SAFETY: The descriptor is borrowed from the open File and remains valid
    // for this call. flock changes only the lock associated with this descriptor.
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(());
    }

    let error = std::io::Error::last_os_error();
    if error.kind() == std::io::ErrorKind::WouldBlock {
        Err(MailError::ProfileInUse)
    } else {
        Err(storage_err()(error))
    }
}

#[cfg(not(target_os = "android"))]
fn acquire_file_lock(file: &File) -> Result<(), MailError> {
    file.try_lock().map_err(|error| match error {
        std::fs::TryLockError::WouldBlock => MailError::ProfileInUse,
        std::fs::TryLockError::Error(error) => storage_err()(error),
    })
}

#[cfg(test)]
mod tests {
    use super::ProfileGuard;
    use crate::error::MailError;
    use tempfile::tempdir;

    #[test]
    fn lock_rejects_a_second_writer_and_releases_when_guard_drops() {
        let dir = tempdir().unwrap();
        let first = ProfileGuard::acquire(dir.path()).unwrap();

        assert!(matches!(
            ProfileGuard::acquire(dir.path()),
            Err(MailError::ProfileInUse)
        ));

        drop(first);
        assert!(ProfileGuard::acquire(dir.path()).is_ok());
    }
}
