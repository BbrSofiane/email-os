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

fn send_status(
    intent: crate::gmail::store::send::SendIntent,
) -> Result<crate::drafts::types::SendStatus, MailError> {
    use crate::drafts::types::{SendState, SendStatus};
    let state = match intent.state.as_str() {
        "hold" => SendState::Hold,
        "queued" => SendState::Queued,
        "applying" => SendState::Applying,
        "confirmed" => SendState::Confirmed,
        "failed" => SendState::Failed,
        "unknown" => SendState::Unknown,
        "cancelled" => SendState::Cancelled,
        "undone" => SendState::Undone,
        _ => return Err(MailError::StorageUnavailable),
    };
    Ok(SendStatus {
        operation_id: intent.operation_id,
        draft_ref: DraftRef {
            account_id: intent.account_id,
            draft_id: intent.draft_id,
        },
        draft_revision: intent.draft_revision,
        not_before: intent.not_before,
        state,
        retry_of: intent.retry_of,
        subject: intent.subject,
        first_recipient: intent.first_recipient,
        state_changed_at: intent.state_changed_at,
    })
}

/// Counts account-session changes so a reply prepared before one cannot be
/// written after it.
#[derive(Debug, Default)]
pub struct DraftLifecycle {
    session_epoch: u64,
    retired: bool,
    disconnecting: bool,
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
    /// Whether the active account has enabled sending and has a usable grant.
    pub fn send_available(&self) -> bool {
        self.lock()
            .and_then(|_guard| {
                let account = self.core.active_account()?;
                self.core.require_send_enabled(&account.account_id)
            })
            .is_ok()
    }

    pub fn enable_sending(&self) -> Result<(), MailError> {
        // The core owns cancellation and the generation fence during consent.
        drop(self.lock()?);
        self.core.enable_sending()
    }

    /// Admit a saved draft to the existing outbox.
    pub fn send_draft(
        &self,
        command: &crate::drafts::types::AdmitSend,
    ) -> Result<crate::drafts::types::SendStatus, MailError> {
        send_status(self.admit_send(&command.draft_ref, command.revision, &command.request_id)?)
    }

    pub fn send_activity(&self) -> Result<Vec<crate::drafts::types::SendStatus>, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.core
            .list_send_intents(&account.account_id)?
            .into_iter()
            .filter(|intent| !intent.dismissed)
            .map(send_status)
            .collect()
    }

    pub fn dismiss_send(&self, operation: &str) -> Result<bool, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.core.dismiss_send(&account.account_id, operation)
    }

    /// Copy an unknown send into a new, independently editable draft.
    pub fn copy_unknown_send(
        &self,
        operation: &str,
        request: &str,
    ) -> Result<DraftReceipt, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        if let Some(receipt) = self
            .drafts
            .lookup_copy_receipt(&account, operation, request)?
        {
            return Ok(receipt);
        }
        let intent = self
            .core
            .list_send_intents(&account.account_id)?
            .into_iter()
            .find(|intent| intent.operation_id == operation && intent.state == "unknown")
            .ok_or(MailError::NotFound)?;
        let source = DraftRef {
            account_id: account.account_id.clone(),
            draft_id: intent.draft_id,
        };
        self.drafts
            .copy_draft(&account, &source, operation, request)
    }

    pub fn restore_undone_send(&self, operation: &str) -> Result<Option<DraftRef>, MailError> {
        self.undo_send(operation)
    }

    pub fn cancel_send(&self, operation: &str) -> Result<bool, MailError> {
        self.cancel_queued_send(operation)
    }

    pub fn retry_failed_send(
        &self,
        operation: &str,
        request: &str,
    ) -> Result<crate::drafts::types::SendStatus, MailError> {
        send_status(self.retry_send(operation, request)?)
    }

    pub fn check_send_activity(&self, cancel: &crate::CancelToken) -> Result<(), MailError> {
        self.check_unknown_sends(cancel)
    }

    /// Check unknown sends using positive provider evidence only.
    pub fn check_unknown_sends(&self, cancel: &crate::CancelToken) -> Result<(), MailError> {
        self.check_unknown_sends_batch(cancel, 0, usize::MAX)
    }

    fn check_unknown_sends_batch(
        &self,
        cancel: &crate::CancelToken,
        offset: usize,
        limit: usize,
    ) -> Result<(), MailError> {
        use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
        use mailparse::MailHeaderMap;
        let lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        let generation = self.core.send_generation()?;
        let intents = self.core.list_send_intents(&account.account_id)?;
        drop(lifecycle);
        let unknown: Vec<_> = intents
            .into_iter()
            .filter(|intent| intent.state == "unknown")
            .collect();
        let count = unknown.len();
        for intent in unknown
            .into_iter()
            .cycle()
            .skip(if count == 0 { 0 } else { offset % count })
            .take(limit.min(count))
        {
            let Some(id) = (|| {
                let value: serde_json::Value = serde_json::from_slice(&intent.frozen_mime).ok()?;
                let raw = URL_SAFE_NO_PAD.decode(value.get("raw")?.as_str()?).ok()?;
                let parsed = mailparse::parse_mail(&raw).ok()?;
                let ids = parsed.headers.get_all_values("Message-ID");
                (ids.len() == 1 && !ids[0].is_empty()).then(|| ids[0].clone())
            })() else {
                continue;
            };
            if let Some((message, thread)) = self.core.find_sent(&account.account_id, &id, cancel) {
                let _lifecycle = self.lock()?;
                if self.core.confirm_unknown_send(
                    &account.account_id,
                    &intent.operation_id,
                    generation,
                    &message,
                    &thread,
                )? {
                    self.repair_send_locks(&account.account_id)?;
                }
            }
        }
        Ok(())
    }

    /// Dispatch at most one released intent. The lifecycle gate protects the
    /// exact lock through the durable claim, but never spans provider I/O.
    pub(crate) fn dispatch_send_pass(
        &self,
        cancel: &crate::CancelToken,
    ) -> Result<bool, MailError> {
        let lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        let generation = self.core.send_generation()?;
        let locks = self.drafts.send_locks(&account.account_id)?;
        let intent = self
            .core
            .list_send_intents(&account.account_id)?
            .into_iter()
            .find(|intent| {
                intent.state == "queued"
                    && locks.iter().any(|(draft, operation, revision)| {
                        draft.draft_id == intent.draft_id
                            && *operation == intent.operation_id
                            && *revision == intent.draft_revision
                    })
            });
        let Some(intent) = intent else {
            return Ok(false);
        };
        match self.core.require_send_enabled(&account.account_id) {
            Ok(()) => {}
            Err(MailError::PermissionRequired | MailError::AuthRequired) => return Ok(false),
            Err(error) => return Err(error),
        }
        if !self
            .core
            .claim_send(&account.account_id, &intent.operation_id, generation)?
        {
            return Ok(false);
        }
        drop(lifecycle);
        let result = self
            .core
            .dispatch_send(&account.account_id, &intent.frozen_mime, cancel);
        let finished = self.core.finish_send(
            &account.account_id,
            &intent.operation_id,
            generation,
            &result,
        )?;
        if finished
            && matches!(
                result,
                crate::gmail::types::SendResult::Confirmed { .. }
                    | crate::gmail::types::SendResult::Refused
            )
        {
            let _lifecycle = self.lock()?;
            self.repair_send_locks(&account.account_id)?;
        }
        // A provably pre-dispatch pause leaves this operation queued. Let the
        // next worker beat re-arm it so offline state cannot spin the worker.
        Ok(!matches!(result, crate::gmail::types::SendResult::Paused))
    }

    pub fn new(core: GmailCore, drafts: DraftCore) -> Self {
        let lifecycle = Arc::new(Mutex::new(DraftLifecycle::default()));
        let weak_lifecycle = Arc::downgrade(&lifecycle);
        let worker_drafts = drafts.clone();
        let next_check = Mutex::new((std::time::Instant::now(), 0usize));
        core.register_send_pass(move |core, cancel| {
            let Some(lifecycle) = weak_lifecycle.upgrade() else {
                return Ok(false);
            };
            let service = DraftService {
                core,
                drafts: worker_drafts.clone(),
                lifecycle,
            };
            let due = {
                let mut next = next_check.lock().expect("send check clock poisoned");
                if std::time::Instant::now() >= next.0 {
                    next.0 = std::time::Instant::now() + std::time::Duration::from_secs(60);
                    let offset = next.1;
                    next.1 = next.1.wrapping_add(10);
                    Some(offset)
                } else {
                    None
                }
            };
            if let Some(offset) = due {
                service.check_unknown_sends_batch(cancel, offset, 10)?;
            }
            service.dispatch_send_pass(cancel)
        });
        Self {
            core,
            drafts,
            lifecycle,
        }
    }

    #[track_caller]
    fn lock(&self) -> Result<MutexGuard<'_, DraftLifecycle>, MailError> {
        let guard = self.lifecycle.lock().map_err(storage_err())?;
        if guard.disconnecting {
            return Err(MailError::Busy);
        }
        if guard.retired {
            return Err(MailError::InvalidRequest {
                field: "mode".into(),
            });
        }
        Ok(guard)
    }

    /// Prevents further operations on this session and invalidates in-flight creates.
    pub fn retire(&self) -> Result<(), MailError> {
        let mut lifecycle = self.lifecycle.lock().map_err(storage_err())?;
        lifecycle.advance();
        lifecycle.retired = true;
        Ok(())
    }

    // Called only while the lifecycle gate is held. The ledger is authoritative.
    fn repair_send_locks(&self, account: &str) -> Result<(), MailError> {
        let intents = self.core.list_send_intents(account)?;
        let locks = self.drafts.send_locks(account)?;
        for (draft_ref, operation, revision) in &locks {
            match intents.iter().find(|intent| {
                intent.operation_id == *operation
                    && intent.draft_id == draft_ref.draft_id
                    && intent.draft_revision == *revision
            }) {
                None => self.drafts.release_send_lock(draft_ref, operation)?,
                Some(intent) if intent.state == "confirmed" => self
                    .drafts
                    .tombstone_confirmed_send(draft_ref, *revision, operation)?,
                Some(intent)
                    if matches!(intent.state.as_str(), "failed" | "cancelled" | "undone") =>
                {
                    self.drafts.release_send_lock(draft_ref, operation)?
                }
                Some(_) => {}
            }
        }
        for intent in &intents {
            if !matches!(
                intent.state.as_str(),
                "hold" | "queued" | "applying" | "unknown"
            ) {
                continue;
            }
            let draft_ref = DraftRef {
                account_id: account.to_owned(),
                draft_id: intent.draft_id.clone(),
            };
            if !locks.iter().any(|(r, op, rev)| {
                *r == draft_ref && *op == intent.operation_id && *rev == intent.draft_revision
            }) {
                self.drafts.acquire_send_lock(
                    &draft_ref,
                    intent.draft_revision,
                    &intent.operation_id,
                )?;
            }
        }
        Ok(())
    }

    pub fn list_drafts(&self) -> Result<Vec<DraftSummary>, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.repair_send_locks(&account.account_id)?;
        let intents = self.core.list_send_intents(&account.account_id)?;
        let mut drafts = self.drafts.list_drafts(&account)?;
        drafts.retain(|draft| {
            !intents.iter().any(|intent| {
                intent.dismissed
                    && intent.state == "unknown"
                    && intent.draft_id == draft.draft_ref.draft_id
            })
        });
        Ok(drafts)
    }

    pub fn get_draft(&self, r#ref: &DraftRef) -> Result<Draft, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.repair_send_locks(&account.account_id)?;
        require_draft_account(&account, r#ref)?;
        self.drafts.get_draft(&account, r#ref)
    }

    pub fn create_draft(&self, command: &CreateDraft) -> Result<DraftReceipt, MailError> {
        let lifecycle_guard = self.lock()?;
        let account = self.core.active_account()?;
        self.repair_send_locks(&account.account_id)?;
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

    /// Undo a held send and return its restored draft after lock repair.
    pub(crate) fn undo_send(&self, operation: &str) -> Result<Option<DraftRef>, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        if !self.core.undo_send(&account.account_id, operation)? {
            return Ok(None);
        }
        let intent = self
            .core
            .list_send_intents(&account.account_id)?
            .into_iter()
            .find(|intent| intent.operation_id == operation)
            .ok_or(MailError::NotFound)?;
        self.repair_send_locks(&account.account_id)?;
        let draft_ref = DraftRef {
            account_id: account.account_id.clone(),
            draft_id: intent.draft_id,
        };
        let draft = self.drafts.get_draft(&account, &draft_ref)?;
        if draft.revision != intent.draft_revision {
            return Err(MailError::DraftConflict {
                current_revision: draft.revision,
            });
        }
        Ok(Some(draft_ref))
    }

    pub(crate) fn cancel_queued_send(&self, operation: &str) -> Result<bool, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        let generation = self.core.send_generation()?;
        let cancelled = self
            .core
            .cancel_queued_send(&account.account_id, operation, generation)?;
        if cancelled {
            self.repair_send_locks(&account.account_id)?;
        }
        Ok(cancelled)
    }

    pub(crate) fn retry_send(
        &self,
        operation: &str,
        request: &str,
    ) -> Result<crate::gmail::store::send::SendIntent, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        if request.trim().is_empty() || request.len() > 128 {
            return Err(MailError::InvalidRequest {
                field: "requestId".into(),
            });
        }
        if let Some(receipt) = self.core.send_receipt(&account.account_id, request)? {
            return if receipt.retry_of.as_deref() == Some(operation) {
                Ok(receipt)
            } else {
                Err(MailError::RequestIdConflict)
            };
        }
        self.core.require_send_enabled(&account.account_id)?;
        let generation = self.core.send_generation()?;
        self.repair_send_locks(&account.account_id)?;
        let previous = self
            .core
            .list_send_intents(&account.account_id)?
            .into_iter()
            .find(|row| row.operation_id == operation)
            .ok_or(MailError::NotFound)?;
        if previous.state != "failed" || previous.frozen_mime.is_empty() {
            return Err(MailError::InvalidRequest {
                field: "operationId".into(),
            });
        }
        let draft_ref = DraftRef {
            account_id: account.account_id.clone(),
            draft_id: previous.draft_id.clone(),
        };
        let draft = self.drafts.get_draft(&account, &draft_ref)?;
        if draft.revision != previous.draft_revision {
            return Err(MailError::DraftConflict {
                current_revision: draft.revision,
            });
        }
        let now = self.core.send_now()?;
        let intent = crate::gmail::store::send::SendIntent {
            account_id: account.account_id,
            operation_id: uuid::Uuid::new_v4().to_string(),
            draft_id: previous.draft_id,
            draft_revision: previous.draft_revision,
            request_id: request.to_owned(),
            frozen_mime: previous.frozen_mime,
            not_before: (now + chrono::Duration::seconds(5)).to_rfc3339(),
            state: "hold".into(),
            retry_of: Some(operation.to_owned()),
            dismissed: false,
            subject: previous.subject,
            first_recipient: previous.first_recipient,
            state_changed_at: Some(now.to_rfc3339()),
        };
        self.drafts
            .acquire_send_lock(&draft_ref, intent.draft_revision, &intent.operation_id)?;
        if let Err(error) = self.core.insert_retry_send(&intent, generation) {
            match self.core.send_receipt(&intent.account_id, request) {
                Ok(Some(receipt)) if receipt.operation_id == intent.operation_id => {
                    return Ok(receipt)
                }
                Ok(_) => self
                    .drafts
                    .release_send_lock(&draft_ref, &intent.operation_id)?,
                Err(_) => return Err(error),
            }
            return Err(error);
        }
        self.core.wake_send_worker();
        Ok(intent)
    }

    /// Admit a saved revision to the durable send ledger.
    pub(crate) fn admit_send(
        &self,
        draft_ref: &DraftRef,
        revision: u32,
        request: &str,
    ) -> Result<crate::gmail::store::send::SendIntent, MailError> {
        let lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.repair_send_locks(&account.account_id)?;
        require_draft_account(&account, draft_ref)?;
        if request.trim().is_empty() || request.len() > 128 {
            return Err(MailError::InvalidRequest {
                field: "requestId".into(),
            });
        }
        if let Some(receipt) = self.core.send_receipt(&account.account_id, request)? {
            return if receipt.retry_of.is_none()
                && receipt.draft_id == draft_ref.draft_id
                && receipt.draft_revision == revision
            {
                Ok(receipt)
            } else {
                Err(MailError::RequestIdConflict)
            };
        }
        self.core.require_send_enabled(&account.account_id)?;
        let draft = self.drafts.get_draft(&account, draft_ref)?;
        if draft.revision != revision {
            return Err(MailError::DraftConflict {
                current_revision: draft.revision,
            });
        }
        let epoch = lifecycle.session_epoch();
        drop(lifecycle);
        let exact_subject = match (&draft.source, &draft.reply_link) {
            (DraftSource::NewMessage, None) => None,
            (
                DraftSource::Reply {
                    conversation,
                    source_message_id,
                },
                Some(link),
            ) if conversation.account_id == account.account_id
                && link.conversation == *conversation
                && link.source_message_id == *source_message_id
                && !source_message_id.is_empty() =>
            {
                Some(match &link.source_subject {
                    Some(subject) => subject.clone(),
                    None => self.core.exact_message_subject(
                        &account.account_id,
                        &conversation.conversation_id,
                        source_message_id,
                    )?,
                })
            }
            _ => return Err(MailError::ReplyUnavailable),
        };
        let lifecycle = self.lock()?;
        if !lifecycle.is_current(epoch)
            || self.core.active_account()?.account_id != account.account_id
        {
            return Err(MailError::AuthRequired);
        }
        if let Some(receipt) = self.core.send_receipt(&account.account_id, request)? {
            return if receipt.retry_of.is_none()
                && receipt.draft_id == draft_ref.draft_id
                && receipt.draft_revision == revision
            {
                Ok(receipt)
            } else {
                Err(MailError::RequestIdConflict)
            };
        }
        self.core.require_send_enabled(&account.account_id)?;
        let current = self.drafts.get_draft(&account, draft_ref)?;
        if current.revision != revision {
            return Err(MailError::DraftConflict {
                current_revision: current.revision,
            });
        }
        let reply = match (&draft.source, &draft.reply_link) {
            (DraftSource::NewMessage, None) => None,
            (
                DraftSource::Reply {
                    conversation,
                    source_message_id,
                },
                Some(link),
            ) if conversation.account_id == account.account_id
                && link.conversation == *conversation
                && link.source_message_id == *source_message_id
                && !source_message_id.is_empty() =>
            {
                Some((
                    link,
                    exact_subject
                        .as_deref()
                        .ok_or(MailError::ReplyUnavailable)?,
                ))
            }
            _ => return Err(MailError::ReplyUnavailable),
        };
        let now = self.core.send_now()?;
        let operation_id = uuid::Uuid::new_v4().to_string();
        let message_id = format!("<{}@email-os.local>", uuid::Uuid::new_v4());
        let mime = crate::send_mime::build_send_mime(
            &draft.content,
            &account.email_address,
            reply,
            &message_id,
            &now.to_rfc2822(),
        )?;
        let frozen_mime =
            serde_json::to_vec(&serde_json::json!({"raw": mime.raw, "threadId": mime.thread_id}))
                .map_err(storage_err())?;
        let intent = crate::gmail::store::send::SendIntent {
            account_id: account.account_id,
            operation_id,
            draft_id: draft_ref.draft_id.clone(),
            draft_revision: revision,
            request_id: request.to_owned(),
            frozen_mime,
            not_before: (now + chrono::Duration::seconds(5)).to_rfc3339(),
            state: "hold".into(),
            retry_of: None,
            dismissed: false,
            subject: Some(draft.content.subject),
            first_recipient: Some(mime.first_recipient),
            state_changed_at: Some(now.to_rfc3339()),
        };
        self.drafts
            .acquire_send_lock(draft_ref, revision, &intent.operation_id)?;
        if let Err(error) = self.core.insert_send_intent(&intent) {
            match self.core.send_receipt(&intent.account_id, request) {
                Ok(Some(receipt)) if receipt.operation_id == intent.operation_id => {
                    return Ok(receipt)
                }
                Ok(None) => self
                    .drafts
                    .release_send_lock(draft_ref, &intent.operation_id)?,
                Ok(Some(_)) => {
                    self.drafts
                        .release_send_lock(draft_ref, &intent.operation_id)?;
                    return Err(MailError::RequestIdConflict);
                }
                Err(_) => return Err(error),
            }
            return Err(error);
        }
        self.core.wake_send_worker();
        Ok(intent)
    }

    pub fn save_draft(&self, command: &SaveDraft) -> Result<DraftReceipt, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.repair_send_locks(&account.account_id)?;
        require_draft_account(&account, &command.draft_ref)?;
        self.drafts.save_draft(&account, command)
    }

    pub fn delete_draft(&self, command: &DeleteDraft) -> Result<DraftDeleteReceipt, MailError> {
        let _lifecycle = self.lock()?;
        let account = self.core.active_account()?;
        self.repair_send_locks(&account.account_id)?;
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
        lifecycle.disconnecting = true;
        drop(lifecycle);
        let result = self.core.disconnect_account();
        self.lifecycle.lock().map_err(storage_err())?.disconnecting = false;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::testing::synthetic::Synthetic;

    #[test]
    fn released_send_survives_pause_and_restart_then_sends_once() {
        use crate::drafts::types::DraftContent;
        use crate::testing::synthetic::{open_core_wrapping, Overlay};
        use crate::testing::{until, TIMEOUT};

        let s = Synthetic::open_wrapped("send-worker-paused", Overlay::wrap);
        s.provider.forward_sends();
        s.core.pause_test_operations(TIMEOUT).unwrap();
        let drafts = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(s.core.clone(), drafts.clone());
        let draft = service
            .create_draft(&CreateDraft {
                request_id: "draft".into(),
                source: DraftSource::NewMessage,
                initial_content: Some(DraftContent {
                    to: "recipient@example.com, other@example.com".into(),
                    cc: String::new(),
                    subject: "Subject".into(),
                    body_text: "Body".into(),
                }),
            })
            .unwrap();
        let original = service
            .admit_send(&draft.draft_ref, draft.revision, "undo")
            .unwrap();
        s.clock.advance_seconds(2);
        assert_eq!(
            service.undo_send(&original.operation_id).unwrap(),
            Some(draft.draft_ref.clone())
        );
        let undone_at = s.core.send_now().unwrap();
        let intent = service
            .admit_send(&draft.draft_ref, draft.revision, "send")
            .unwrap();
        s.clock.advance_seconds(5);
        s.core.wake_send_worker();
        assert!(until(|| s
            .core
            .send_receipt(&intent.account_id, "send")
            .unwrap()
            .is_some_and(|row| row.state == "queued")));
        assert_eq!(s.provider.send_calls(), 0);
        s.core.stop();
        drop(service);
        drop(drafts);
        drop(s.core);

        let reopened = open_core_wrapping(
            s.dir.path(),
            s.provider.clone(),
            &s.synthetic,
            &s.clock,
            true,
        );
        let drafts = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(reopened.clone(), drafts);
        assert_eq!(
            reopened
                .send_receipt(&intent.account_id, "send")
                .unwrap()
                .unwrap()
                .state,
            "queued"
        );
        assert_eq!(s.provider.send_calls(), 0);
        reopened.release_test_operations();
        reopened.wake_send_worker();
        assert!(until(|| reopened
            .send_receipt(&intent.account_id, "send")
            .unwrap()
            .is_some_and(|row| row.state == "confirmed")));
        reopened.wake_send_worker();
        reopened.wait_for_test_idle(TIMEOUT).unwrap();
        assert_eq!(s.provider.send_calls(), 1);
        assert!(matches!(
            service.get_draft(&draft.draft_ref),
            Err(MailError::NotFound)
        ));
        let activity = service.send_activity().unwrap();
        let [undone, confirmed] = activity.as_slice() else {
            panic!("expected one Activity row for each accepted send");
        };
        assert_eq!(undone.operation_id, original.operation_id);
        assert_eq!(undone.state, crate::drafts::types::SendState::Undone);
        assert_eq!(confirmed.operation_id, intent.operation_id);
        assert_eq!(confirmed.state, crate::drafts::types::SendState::Confirmed);
        for (row, at) in [
            (undone, undone_at),
            (confirmed, reopened.send_now().unwrap()),
        ] {
            assert_eq!(row.subject.as_deref(), Some("Subject"));
            assert_eq!(
                row.first_recipient.as_deref(),
                Some("recipient@example.com")
            );
            assert_eq!(
                chrono::DateTime::parse_from_rfc3339(row.state_changed_at.as_deref().unwrap())
                    .unwrap(),
                at
            );
        }
        let sent = reopened
            .load_confirmed_send_thread(&intent.operation_id)
            .unwrap();
        assert_eq!(sent.subject, "Subject");
        assert!(!sent.is_in_inbox);
        assert_eq!(sent.messages.len(), 1);
        let again = reopened
            .load_confirmed_send_thread(&intent.operation_id)
            .unwrap();
        assert_eq!(again.messages.len(), 1);
        assert_eq!(again.messages[0].id, sent.messages[0].id);
        reopened.stop();
    }

    #[test]
    fn worker_sends_once_at_deadline_and_never_replays_unknown() {
        use crate::drafts::types::DraftContent;
        use crate::testing::synthetic::{open_core_wrapping, Overlay};
        use crate::testing::{until, TIMEOUT};

        let s = Synthetic::open_wrapped("send-worker-unknown", Overlay::wrap);
        let drafts = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(s.core.clone(), drafts.clone());
        let draft = service
            .create_draft(&CreateDraft {
                request_id: "draft".into(),
                source: DraftSource::NewMessage,
                initial_content: Some(DraftContent {
                    to: "recipient@example.com".into(),
                    cc: String::new(),
                    subject: "Subject".into(),
                    body_text: "Body".into(),
                }),
            })
            .unwrap();
        let intent = service
            .admit_send(&draft.draft_ref, draft.revision, "send")
            .unwrap();
        s.clock.advance_seconds(4);
        s.core.wake_send_worker();
        s.core.wait_for_test_idle(TIMEOUT).unwrap();
        assert_eq!(s.provider.send_calls(), 0);
        s.clock.advance_seconds(1);
        s.core.wake_send_worker();
        assert!(until(|| s
            .core
            .send_receipt(&intent.account_id, "send")
            .unwrap()
            .is_some_and(|row| row.state == "unknown")));
        assert_eq!(s.provider.send_calls(), 1);
        s.core.wake_send_worker();
        s.core.wait_for_test_idle(TIMEOUT).unwrap();
        assert_eq!(s.provider.send_calls(), 1);

        s.core.stop();
        drop(service);
        drop(drafts);
        drop(s.core);
        let reopened = open_core_wrapping(
            s.dir.path(),
            s.provider.clone(),
            &s.synthetic,
            &s.clock,
            false,
        );
        let drafts = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let _service = DraftService::new(reopened.clone(), drafts);
        reopened.wake_send_worker();
        reopened.wait_for_test_idle(TIMEOUT).unwrap();
        assert_eq!(s.provider.send_calls(), 1);
        assert_eq!(
            reopened
                .send_receipt(&intent.account_id, "send")
                .unwrap()
                .unwrap()
                .state,
            "unknown"
        );
        reopened.stop();
    }

    #[test]
    fn unknown_send_checks_require_positive_sent_evidence() {
        use crate::drafts::types::DraftContent;
        use crate::testing::synthetic::Overlay;
        use crate::testing::until;

        for (fault, expected) in [
            ("commit-then-lose", "confirmed"),
            ("lose-without-commit", "unknown"),
        ] {
            let s = Synthetic::open_wrapped(fault, Overlay::wrap);
            s.provider.forward_sends();
            s.synthetic.set_next_send_outcome(fault);
            let drafts = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
            let service = DraftService::new(s.core.clone(), drafts);
            let draft = service
                .create_draft(&CreateDraft {
                    request_id: "draft".into(),
                    source: DraftSource::NewMessage,
                    initial_content: Some(DraftContent {
                        to: "recipient@example.com".into(),
                        cc: String::new(),
                        subject: "Subject".into(),
                        body_text: "Body".into(),
                    }),
                })
                .unwrap();
            let intent = service
                .admit_send(&draft.draft_ref, draft.revision, "send")
                .unwrap();
            s.clock.advance_seconds(5);
            s.core.wake_send_worker();
            assert!(until(|| s
                .core
                .send_receipt(&intent.account_id, "send")
                .unwrap()
                .is_some_and(|row| row.state == "unknown")));
            service
                .check_unknown_sends(&crate::CancelToken::default())
                .unwrap();
            service
                .check_unknown_sends(&crate::CancelToken::default())
                .unwrap();
            assert_eq!(
                s.core
                    .send_receipt(&intent.account_id, "send")
                    .unwrap()
                    .unwrap()
                    .state,
                expected
            );
            assert_eq!(s.provider.send_calls(), 1);
            s.core.stop();
        }
    }

    #[test]
    fn undo_send_replays_before_deadline_and_distinguishes_restart() {
        use crate::drafts::types::DraftContent;
        let s = Synthetic::open("draft-undo-send");
        let store = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(s.core.clone(), store.clone());
        let create = |id: &str| {
            service
                .create_draft(&CreateDraft {
                    request_id: id.into(),
                    source: DraftSource::NewMessage,
                    initial_content: Some(DraftContent {
                        to: "recipient@example.com".into(),
                        cc: String::new(),
                        subject: "Subject".into(),
                        body_text: "Body".into(),
                    }),
                })
                .unwrap()
        };
        let first = create("first");
        let deadline = create("deadline");
        let restart = create("restart");
        let a = service
            .admit_send(&first.draft_ref, first.revision, "send-first")
            .unwrap();
        let b = service
            .admit_send(&deadline.draft_ref, deadline.revision, "send-deadline")
            .unwrap();
        let c = service
            .admit_send(&restart.draft_ref, restart.revision, "send-restart")
            .unwrap();
        assert_eq!(
            service.undo_send(&a.operation_id).unwrap(),
            Some(first.draft_ref.clone())
        );
        assert_eq!(
            service.undo_send(&a.operation_id).unwrap(),
            Some(first.draft_ref.clone())
        );
        assert_eq!(
            service.get_draft(&first.draft_ref).unwrap().revision,
            first.revision
        );
        s.clock.advance_seconds(5);
        assert_eq!(service.undo_send(&b.operation_id).unwrap(), None);
        drop(service);
        drop(store);
        let s = s.reopen();
        let store = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(s.core.clone(), store);
        assert_eq!(service.undo_send(&c.operation_id).unwrap(), None);
        assert_eq!(
            service.get_draft(&restart.draft_ref).unwrap().revision,
            restart.revision
        );
        assert_eq!(
            service.undo_send(&a.operation_id).unwrap(),
            Some(first.draft_ref)
        );
        s.core.stop();
    }

    #[test]
    fn confirmed_send_cleanup_is_repaired_on_draft_access() {
        use crate::drafts::types::DraftContent;
        let s = Synthetic::open("draft-confirmed-repair");
        let store = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(s.core.clone(), store.clone());
        let created = service
            .create_draft(&CreateDraft {
                request_id: "create".into(),
                source: DraftSource::NewMessage,
                initial_content: Some(DraftContent {
                    to: "recipient@example.com".into(),
                    cc: String::new(),
                    subject: "Subject".into(),
                    body_text: "Body".into(),
                }),
            })
            .unwrap();
        store
            .acquire_send_lock(&created.draft_ref, created.revision, "confirmed")
            .unwrap();
        s.core
            .insert_send_intent(&crate::gmail::store::send::SendIntent {
                account_id: created.draft_ref.account_id.clone(),
                operation_id: "confirmed".into(),
                draft_id: created.draft_ref.draft_id.clone(),
                draft_revision: created.revision,
                request_id: "send".into(),
                frozen_mime: Vec::new(),
                not_before: chrono::Utc::now().to_rfc3339(),
                state: "confirmed".into(),
                retry_of: None,
                dismissed: false,
                subject: Some("Subject".into()),
                first_recipient: Some("recipient@example.com".into()),
                state_changed_at: None,
            })
            .unwrap();
        assert!(matches!(
            service.get_draft(&created.draft_ref),
            Err(MailError::NotFound)
        ));
        assert!(store
            .send_locks(&created.draft_ref.account_id)
            .unwrap()
            .is_empty());
        assert!(service.list_drafts().unwrap().is_empty());
        assert!(s
            .core
            .send_receipt(&created.draft_ref.account_id, "send")
            .unwrap()
            .is_some());
        s.core.stop();
    }

    #[test]
    fn send_admission_replays_and_repairs_locks() {
        use crate::drafts::types::DraftContent;
        let s = Synthetic::open("draft-send-repair");
        let store = DraftCore::open(s.dir.path().join("local-drafts")).unwrap();
        let service = DraftService::new(s.core.clone(), store.clone());
        let created = service
            .create_draft(&CreateDraft {
                request_id: "create".into(),
                source: DraftSource::NewMessage,
                initial_content: Some(DraftContent {
                    to: "recipient@example.com".into(),
                    cc: String::new(),
                    subject: "Subject".into(),
                    body_text: "Body".into(),
                }),
            })
            .unwrap();
        store
            .acquire_send_lock(&created.draft_ref, created.revision, "orphan")
            .unwrap();
        let intent = service
            .admit_send(&created.draft_ref, created.revision, "send")
            .unwrap();
        let replay = service
            .admit_send(&created.draft_ref, created.revision, "send")
            .unwrap();
        assert_eq!(intent.operation_id, replay.operation_id);
        assert!(matches!(
            service.admit_send(&created.draft_ref, created.revision + 1, "send"),
            Err(MailError::RequestIdConflict)
        ));
        store
            .release_send_lock(&created.draft_ref, &intent.operation_id)
            .unwrap();
        service.get_draft(&created.draft_ref).unwrap();
        assert_eq!(
            store.send_locks(&created.draft_ref.account_id).unwrap()[0].1,
            intent.operation_id
        );
        store
            .release_send_lock(&created.draft_ref, &intent.operation_id)
            .unwrap();
        let account = s.core.active_account().unwrap();
        let saved = store
            .save_draft(
                &account,
                &SaveDraft {
                    draft_ref: created.draft_ref.clone(),
                    expected_revision: created.revision,
                    request_id: "edit".into(),
                    content: DraftContent {
                        to: "recipient@example.com".into(),
                        cc: String::new(),
                        subject: "New".into(),
                        body_text: "Body".into(),
                    },
                },
            )
            .unwrap();
        store
            .tombstone_confirmed_send(&created.draft_ref, created.revision, &intent.operation_id)
            .unwrap();
        assert_eq!(
            store
                .get_draft(&account, &created.draft_ref)
                .unwrap()
                .revision,
            saved.revision
        );
        s.core.stop();
    }

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
    fn retirement_invalidates_epoch_and_rejects_operations() {
        let s = Synthetic::open("draft-service-retired");
        let drafts = DraftService::new(
            s.core.clone(),
            DraftCore::open(s.dir.path().join("local-drafts")).unwrap(),
        );
        let before = drafts.lock().unwrap().session_epoch();
        drafts.retire().unwrap();
        let lifecycle = drafts.lifecycle.lock().unwrap();
        assert!(!lifecycle.is_current(before));
        drop(lifecycle);
        let error = MailError::InvalidRequest {
            field: "mode".into(),
        };
        assert_eq!(drafts.list_drafts(), Err(error.clone()));
        assert_eq!(drafts.connect_account(), Err(error.clone()));
        assert_eq!(drafts.disconnect_account(), Err(error));
        s.core.stop();
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
