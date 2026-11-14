//! Admission and cancellation of attachment downloads: at most one transfer at
//! a time, and a bounded memory of cancelled request ids so a cancel that
//! arrives before the download starts still wins.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};

use super::{invalid, valid_id};
use crate::storage_log::storage_err;
use crate::{CancelToken, MailError};

/// How many cancelled request ids are remembered.
const CANCELLED_MEMORY: usize = 64;

#[derive(Default)]
struct TransferState {
    active: HashMap<String, CancelToken>,
    cancelled: VecDeque<String>,
}

impl TransferState {
    fn begin(&mut self, id: &str) -> Result<CancelToken, MailError> {
        if !valid_id(id) {
            return Err(invalid("requestId"));
        }
        if !self.active.is_empty() {
            return Err(MailError::Busy);
        }
        if self.cancelled.iter().any(|v| v == id) {
            return Err(MailError::AuthCancelled);
        }
        let token = CancelToken::default();
        self.active.insert(id.into(), token.clone());
        Ok(token)
    }

    fn cancel(&mut self, id: &str) {
        if let Some(token) = self.active.get(id) {
            token.cancel();
        }
        self.cancelled.push_back(id.into());
        while self.cancelled.len() > CANCELLED_MEMORY {
            self.cancelled.pop_front();
        }
    }
}

/// Cloneable, thread-safe registry of the attachment download in flight.
#[derive(Clone, Default)]
pub struct AttachmentTransfers {
    state: Arc<Mutex<TransferState>>,
}

impl AttachmentTransfers {
    #[track_caller]
    fn lock(&self) -> Result<MutexGuard<'_, TransferState>, MailError> {
        self.state.lock().map_err(storage_err())
    }

    /// Admits a download: rejects an invalid or already-cancelled request id
    /// and any second concurrent transfer. The returned token is cancelled by
    /// a later [`Self::cancel`] for the same id.
    pub fn begin(&self, request_id: &str) -> Result<CancelToken, MailError> {
        self.lock()?.begin(request_id)
    }

    /// Cancels the transfer with this id, or remembers the id so a transfer
    /// that has not been admitted yet is refused.
    pub fn cancel(&self, request_id: &str) -> Result<(), MailError> {
        if !valid_id(request_id) {
            return Err(invalid("requestId"));
        }
        self.lock()?.cancel(request_id);
        Ok(())
    }

    /// Releases the admission slot once the transfer has ended.
    pub fn finish(&self, request_id: &str) -> Result<(), MailError> {
        self.lock()?.active.remove(request_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cancellation_before_or_during_admission_and_single_transfer_bound() {
        let mut transfers = TransferState::default();
        transfers.cancel("early");
        assert!(matches!(
            transfers.begin("early"),
            Err(MailError::AuthCancelled)
        ));
        let token = transfers.begin("active").unwrap();
        assert!(matches!(transfers.begin("other"), Err(MailError::Busy)));
        transfers.cancel("active");
        assert!(token.is_cancelled());
        transfers.active.remove("active");
        for i in 0..100 {
            transfers.cancel(&format!("r{i}"));
        }
        assert_eq!(transfers.cancelled.len(), 64);
    }

    #[test]
    fn the_shared_registry_admits_one_transfer_and_frees_the_slot_on_finish() {
        let transfers = AttachmentTransfers::default();
        let clone = transfers.clone();
        let token = transfers.begin("first").unwrap();
        // A clone is the same registry.
        assert_eq!(clone.begin("second").err(), Some(MailError::Busy));
        clone.cancel("first").unwrap();
        assert!(token.is_cancelled());
        transfers.finish("first").unwrap();
        assert!(clone.begin("second").is_ok());
        // Finishing an id that is not active changes nothing.
        transfers.finish("unknown").unwrap();
        assert_eq!(clone.begin("third").err(), Some(MailError::Busy));
    }

    #[test]
    fn request_ids_are_validated_before_admission_and_cancellation() {
        let transfers = AttachmentTransfers::default();
        for id in ["", "has space", "a/b", &"x".repeat(257)] {
            assert_eq!(
                transfers.begin(id).err(),
                Some(invalid("requestId")),
                "begin {id:?}"
            );
            assert_eq!(
                transfers.cancel(id),
                Err(invalid("requestId")),
                "cancel {id:?}"
            );
        }
        // An invalid id did not take the slot or enter the cancelled memory.
        assert!(transfers.begin("valid").is_ok());
    }

    #[test]
    fn a_cancel_for_an_old_request_is_forgotten_after_the_memory_is_full() {
        let transfers = AttachmentTransfers::default();
        for i in 0..CANCELLED_MEMORY {
            transfers.cancel(&format!("r{i}")).unwrap();
        }
        // The oldest id is still refused until a 65th cancel pushes it out.
        assert_eq!(transfers.begin("r0").err(), Some(MailError::AuthCancelled));
        transfers.cancel("newest").unwrap();
        let token = transfers.begin("r0").unwrap();
        assert!(!token.is_cancelled());
    }

    #[test]
    fn a_poisoned_lock_is_a_storage_failure() {
        let transfers = AttachmentTransfers::default();
        let clone = transfers.clone();
        let _ = std::thread::spawn(move || {
            let _guard = clone.state.lock().unwrap();
            panic!("poison the registry");
        })
        .join();
        assert_eq!(
            transfers.begin("any").err(),
            Some(MailError::StorageUnavailable)
        );
        assert_eq!(transfers.cancel("any"), Err(MailError::StorageUnavailable));
        assert_eq!(transfers.finish("any"), Err(MailError::StorageUnavailable));
    }
}
