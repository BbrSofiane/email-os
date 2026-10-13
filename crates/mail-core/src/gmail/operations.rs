//! Concrete single-operation executor for durable Gmail mailbox setters.
use crate::dto::{MailboxOperationKind, OperationStatus};
use crate::error::MailError;
use crate::gmail::store::{GmailStore, OperationRecord};
use crate::gmail::types::{GmailReadProvider, GmailThread};
use crate::CancelToken;

/// Runs at most one queued setter or one uncertain-outcome reconciliation.
/// The caller is the existing serial Gmail worker; no storage lock is held
/// during profile, reconciliation, or setter provider calls.
pub(crate) fn run_one(
    store: &GmailStore,
    provider: &dyn GmailReadProvider,
    cancel: &CancelToken,
) -> Result<bool, MailError> {
    let Some(record) = store.claim_next_operation()? else {
        return Ok(false);
    };
    if cancel.is_cancelled() {
        // A disconnect clears the durable rows after the worker reaches its
        // admission barrier. A plain shutdown leaves applying for restart
        // recovery, where migration converts it to outcome_unknown.
        return Ok(true);
    }

    let uncertain = record.status == OperationStatus::OutcomeUnknown;
    if !uncertain {
        require_mutation_access(store, provider, &record)?;
    }
    let profile = match provider.profile(cancel) {
        Ok(profile) => profile,
        Err(error) => {
            if uncertain {
                store.defer_unknown_operation(&record, &error)?;
            } else {
                store.requeue_operation(&record, &error)?;
            }
            return Err(error);
        }
    };
    if profile.account_id != record.account_id {
        let error = MailError::InvalidRequest {
            field: "accountId".to_string(),
        };
        if uncertain {
            store.defer_unknown_operation(&record, &error)?;
        } else {
            store.fail_operation(&record, error.clone())?;
        }
        return Err(error);
    }

    if uncertain {
        return reconcile(store, provider, cancel, &record);
    }

    // The grant may have been revoked between enqueue and dispatch. Check the
    // local verified capability again immediately before the setter.
    require_mutation_access(store, provider, &record)?;
    if cancel.is_cancelled() {
        return Ok(true);
    }
    let result = match record.kind {
        MailboxOperationKind::Archive => {
            provider.apply_archive(&record.message_ids, record.value, cancel)
        }
        MailboxOperationKind::Read => {
            provider.apply_read(&record.message_ids, record.value, cancel)
        }
    };
    match result {
        Ok(()) => store.confirm_operation(&record)?,
        Err(MailError::OutcomeUnknown | MailError::AuthCancelled) => {
            store.unknown_operation(&record)?;
            if !cancel.is_cancelled() {
                return reconcile(store, provider, cancel, &record);
            }
        }
        Err(error @ MailError::StorageUnavailable) => return Err(error),
        // The production setter uses these two errors only while refreshing a
        // token before batchModify; post-dispatch uncertainty is OutcomeUnknown.
        Err(
            error @ (MailError::NetworkUnavailable
            | MailError::ProviderUnavailable
            | MailError::InvalidProviderResponse
            | MailError::RateLimited
            | MailError::AuthRequired
            | MailError::PermissionRequired
            | MailError::SecretsUnavailable),
        ) => {
            store.requeue_operation(&record, &error)?;
            return Err(error);
        }
        Err(error) => {
            store.fail_operation(&record, error.clone())?;
            return Err(error);
        }
    }
    Ok(true)
}

fn reconcile(
    store: &GmailStore,
    provider: &dyn GmailReadProvider,
    cancel: &CancelToken,
    record: &OperationRecord,
) -> Result<bool, MailError> {
    let fetched = match provider.get_thread(&record.conversation_id, cancel) {
        Ok(Some(thread)) => thread,
        Ok(None) => {
            store.reconciled_unknown_operation(record)?;
            return Ok(true);
        }
        Err(error) => {
            store.defer_unknown_operation(record, &error)?;
            return Err(error);
        }
    };
    if fetched.conversation.conversation_ref.account_id != record.account_id
        || fetched.conversation.conversation_ref.conversation_id != record.conversation_id
    {
        store.reconciled_unknown_operation(record)?;
        return Ok(true);
    }
    let all_ids = observed_ids(&fetched);
    if !record.message_ids.iter().all(|id| all_ids.contains(id)) {
        store.reconcile_operation(record, &fetched, false)?;
        return Ok(true);
    }
    let matches_all = record.message_ids.iter().all(|id| match record.kind {
        MailboxOperationKind::Archive => fetched.inbox_message_ids.contains(id) != record.value,
        MailboxOperationKind::Read => fetched
            .unread_message_ids
            .as_ref()
            .is_some_and(|ids| ids.contains(id) != record.value),
    });
    store.reconcile_operation(record, &fetched, matches_all)?;
    Ok(true)
}

fn require_mutation_access(
    store: &GmailStore,
    provider: &dyn GmailReadProvider,
    record: &OperationRecord,
) -> Result<(), MailError> {
    match provider.mutation_access() {
        Ok(true) => Ok(()),
        Ok(false) => {
            store.requeue_operation(record, &MailError::PermissionRequired)?;
            Err(MailError::PermissionRequired)
        }
        Err(error) => {
            if error != MailError::StorageUnavailable {
                store.requeue_operation(record, &error)?;
            }
            Err(error)
        }
    }
}

fn observed_ids(thread: &GmailThread) -> Vec<String> {
    if let Some(ids) = &thread.message_ids {
        return ids.clone();
    }
    let mut ids = thread.inbox_message_ids.clone();
    for message in &thread.conversation.messages {
        if !ids.contains(&message.id) {
            ids.push(message.id.clone());
        }
    }
    ids
}
