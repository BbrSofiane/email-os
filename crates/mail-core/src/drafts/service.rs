//! Account-scoped draft operations over the mail core and the local draft
//! store.
//!
//! [`DraftCore`] persists drafts for an account it is handed; it does not know
//! which account is signed in. [`DraftService`] decides that: every operation
//! resolves the active account from the [`GmailCore`], refuses a draft that
//! belongs to another account, and revalidates a reply against the displayed
//! conversation before a draft is built from it. A session change (connect or
//! disconnect) advances an epoch under the same lock, so a reply that was being
//! prepared across a session change is rejected instead of being written to
//! the wrong account.

use std::sync::{Arc, Mutex, MutexGuard};

use crate::drafts::store::DraftCore;
use crate::drafts::types::{
    CreateDraft, DeleteDraft, Draft, DraftDeleteReceipt, DraftReceipt, DraftRef, DraftSource,
    DraftSummary, SaveDraft,
};
use crate::dto::{Conversation, ConversationRef};
use crate::error::MailError;
use crate::gmail::sync::GmailCore;
use crate::gmail::types::AccountInfo;
use crate::storage_log::storage_err;

/// Counts account-session changes so a reply prepared before one cannot be
/// written after it.
#[derive(Debug, Default)]
pub struct DraftLifecycle {
    session_epoch: u64,
}

impl DraftLifecycle {
    pub fn advance(&mut self) {
        self.session_epoch = self.session_epoch.wrapping_add(1);
    }

    pub fn is_current(&self, epoch: u64) -> bool {
        self.session_epoch == epoch
    }

    pub fn session_epoch(&self) -> u64 {
        self.session_epoch
    }
}

/// A draft may only be touched under the account that owns it.
pub fn require_draft_account(account: &AccountInfo, draft_ref: &DraftRef) -> Result<(), MailError> {
    if draft_ref.account_id == account.account_id {
        Ok(())
    } else {
        Err(MailError::NotFound)
    }
}

/// A reply may only be built from the exact displayed conversation: same
/// reference, complete context, not a retained snapshot, and the displayed
/// message is the newest one.
pub fn validate_reply_conversation(
    conversation: &Conversation,
    expected_ref: &ConversationRef,
    source_message_id: &str,
) -> Result<(), MailError> {
    if &conversation.conversation_ref != expected_ref
        || conversation.context_complete != Some(true)
        || conversation.retained_snapshot_at.is_some()
        || conversation
            .messages
            .last()
            .map(|message| message.id.as_str())
            != Some(source_message_id)
    {
        return Err(MailError::ReplyUnavailable);
    }
    Ok(())
}

/// The core's reply-context load, re-checked against the displayed
/// conversation before a reply draft may be built from it.
pub fn load_validated_reply_context(
    core: &GmailCore,
    r#ref: &ConversationRef,
    source_message_id: &str,
) -> Result<Conversation, MailError> {
    let conversation = core.load_reply_context(r#ref, source_message_id)?;
    validate_reply_conversation(&conversation, r#ref, source_message_id)?;
    if conversation
        .reply_context
        .as_ref()
        .is_none_or(|context| context.source_message_id != source_message_id)
    {
        return Err(MailError::ReplyUnavailable);
    }
    Ok(conversation)
}

/// Cloneable, thread-safe. Every method is synchronous and blocking; the shell
/// runs them on its blocking pool.
#[derive(Clone)]
pub struct DraftService {
    core: GmailCore,
    drafts: DraftCore,
    lifecycle: Arc<Mutex<DraftLifecycle>>,
}

impl DraftService {
    pub fn new(core: GmailCore, drafts: DraftCore) -> Self {
        Self {
            core,
            drafts,
            lifecycle: Arc::new(Mutex::new(DraftLifecycle::default())),
        }
    }

    #[track_caller]
    fn lock(&self) -> Result<MutexGuard<'_, DraftLifecycle>, MailError> {
        self.lifecycle.lock().map_err(storage_err())
    }

    pub fn list_drafts(&self) -> Result<Vec<DraftSummary>, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.drafts.list_drafts(&account)
    }

    pub fn get_draft(&self, r#ref: &DraftRef) -> Result<Draft, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        require_draft_account(&account, r#ref)?;
        self.drafts.get_draft(&account, r#ref)
    }

    pub fn create_draft(&self, command: &CreateDraft) -> Result<DraftReceipt, MailError> {
        let lifecycle_guard = self.lock()?;
        let account = self.core.active_account()?;
        if let Some(receipt) = self.drafts.lookup_create_receipt(&account, command)? {
            return Ok(receipt);
        }
        match &command.source {
            DraftSource::NewMessage => self.drafts.create_draft(&account, command, None),
            DraftSource::Reply {
                conversation,
                source_message_id,
            } => {
                if conversation.account_id != account.account_id {
                    return Err(MailError::ReplyUnavailable);
                }
                let displayed = self.core.get_conversation(conversation)?;
                validate_reply_conversation(&displayed, conversation, source_message_id)?;
                let session_epoch = lifecycle_guard.session_epoch();
                drop(lifecycle_guard);

                // This helper is a cache hit when metadata is ready. A legacy
                // metadata fetch is readonly and deliberately happens unlocked.
                let reply_conversation =
                    load_validated_reply_context(&self.core, conversation, source_message_id)?;

                let lifecycle_guard = self.lock()?;
                if !lifecycle_guard.is_current(session_epoch)
                    || self.core.active_account()?.account_id != account.account_id
                {
                    return Err(MailError::AuthRequired);
                }
                let current = self.core.get_conversation(conversation)?;
                validate_reply_conversation(&current, conversation, source_message_id)?;
                if current.reply_context != reply_conversation.reply_context {
                    return Err(MailError::ReplyUnavailable);
                }
                self.drafts
                    .create_draft(&account, command, Some(&reply_conversation))
            }
        }
    }

    pub fn save_draft(&self, command: &SaveDraft) -> Result<DraftReceipt, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        require_draft_account(&account, &command.draft_ref)?;
        self.drafts.save_draft(&account, command)
    }

    pub fn delete_draft(&self, command: &DeleteDraft) -> Result<DraftDeleteReceipt, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        require_draft_account(&account, &command.draft_ref)?;
        self.drafts.delete_draft(&account, command)
    }

    /// Connects the account. The session epoch advances only when the connect
    /// succeeded.
    pub fn connect_account(&self) -> Result<(), MailError> {
        let mut lifecycle = self.lock()?;
        self.core.connect_account()?;
        lifecycle.advance();
        Ok(())
    }

    /// Disconnects the account. The epoch advances first, so a reply being
    /// prepared is rejected even if the disconnect itself then fails.
    pub fn disconnect_account(&self) -> Result<(), MailError> {
        let mut lifecycle = self.lock()?;
        lifecycle.advance();
        self.core.disconnect_account()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::synthetic::Synthetic;

    #[test]
    fn a_session_change_makes_an_earlier_epoch_stale() {
        let mut lifecycle = DraftLifecycle::default();
        let before = lifecycle.session_epoch();
        assert!(lifecycle.is_current(before));
        lifecycle.advance();
        assert!(!lifecycle.is_current(before));
        assert!(lifecycle.is_current(lifecycle.session_epoch()));
        lifecycle.session_epoch = u64::MAX;
        lifecycle.advance();
        assert_eq!(
            lifecycle.session_epoch(),
            0,
            "the epoch wraps, it never panics"
        );
    }

    #[test]
    fn a_failed_connect_keeps_the_epoch_but_a_disconnect_advances_it_first() {
        let s = Synthetic::open("draft-service-epoch");
        let store = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let drafts = DraftService::new(s.core.clone(), store);
        let epoch = || drafts.lock().unwrap().session_epoch();
        let start = epoch();
        // A synthetic session rejects both, so neither session change happened;
        // connect then leaves the epoch alone...
        assert!(drafts.connect_account().is_err());
        assert_eq!(epoch(), start);
        // ...while disconnect invalidates in-flight replies up front, even when
        // the disconnect itself is then refused.
        assert!(drafts.disconnect_account().is_err());
        assert_eq!(epoch(), start.wrapping_add(1));
        s.core.stop();
    }
}
