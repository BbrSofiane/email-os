use super::run_blocking;
use crate::state::AppState;
use mail_core::dto::{
    CachedDoneRequest, CachedDoneSnapshot, CachedTrashRequest, CachedTrashSnapshot, Conversation,
    ConversationRef, InboxSnapshot, OperationReceipt, RetryOperation, SetArchived, SetRead,
    UndoOperation, UndoReceipt,
};
use mail_core::error::MailError;
use mail_core::gmail::browsing::{DestinationCatalog, DestinationPage, DestinationRequest};
use mail_core::gmail::sync::GmailCore;
use mail_core::groups::{
    GetOperationGroupRequest, GroupUndoReceipt, ListOperationGroupsRequest, OperationGroupPage,
    OperationGroupReceipt, OperationGroupStatus, SetArchivedGroup, SetReadGroup,
    UndoOperationGroup,
};
use mail_core::reminders::{CancelReminder, PutReminder, Reminder};
use tauri::State;

#[tauri::command]
pub(crate) async fn list_cached_starred(
    state: State<'_, AppState>,
    request: CachedDoneRequest,
) -> Result<CachedDoneSnapshot, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.list_cached_starred(&request)).await
}
#[tauri::command]
pub(crate) async fn set_starred(
    state: State<'_, AppState>,
    command: mail_core::stars::SetStarred,
) -> Result<OperationReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_starred(&command)).await
}
#[tauri::command]
pub(crate) async fn set_starred_group(
    state: State<'_, AppState>,
    command: mail_core::stars::SetStarredGroup,
) -> Result<OperationGroupReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_starred_group(&command)).await
}
#[tauri::command]
pub(crate) async fn get_saved_split(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Option<mail_core::splits::SavedSplit>, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.get_saved_split(&account_id)).await
}

#[tauri::command]
pub(crate) async fn save_saved_split(
    state: State<'_, AppState>,
    account_id: String,
    split: mail_core::splits::SavedSplit,
) -> Result<mail_core::splits::SavedSplit, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.save_saved_split(&account_id, &split)).await
}

#[tauri::command]
pub(crate) async fn search_mail(
    state: State<'_, AppState>,
    request: mail_core::search::SearchRequest,
) -> Result<mail_core::search::SearchPage, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.search_mail(&request)).await
}

#[tauri::command]
pub(crate) async fn cancel_search_mail(state: State<'_, AppState>) -> Result<(), MailError> {
    state.core.cancel_search_mail();
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_reminders(state: State<'_, AppState>) -> Result<Vec<Reminder>, MailError> {
    run_blocking(state.core.clone(), |core| core.list_reminders()).await
}
#[tauri::command]
pub(crate) async fn put_reminder(
    state: State<'_, AppState>,
    command: PutReminder,
) -> Result<Reminder, MailError> {
    run_blocking(state.core.clone(), move |core| core.put_reminder(&command)).await
}
#[tauri::command]
pub(crate) async fn cancel_reminder(
    state: State<'_, AppState>,
    command: CancelReminder,
) -> Result<Reminder, MailError> {
    run_blocking(state.core.clone(), move |core| {
        core.cancel_reminder(&command)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_cached_trash(
    state: State<'_, AppState>,
    request: CachedTrashRequest,
) -> Result<CachedTrashSnapshot, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.list_cached_trash(&request)).await
}

#[tauri::command]
pub(crate) async fn list_cached_done(
    state: State<'_, AppState>,
    request: CachedDoneRequest,
) -> Result<CachedDoneSnapshot, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.list_cached_done(&request)).await
}

#[tauri::command]
pub(crate) async fn list_provider_destinations(
    state: State<'_, AppState>,
    account_id: String,
    cached: bool,
) -> Result<DestinationCatalog, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |b| {
        b.list_provider_destinations(&account_id, cached)
    })
    .await
}

#[tauri::command]
pub(crate) async fn browse_provider_destination(
    state: State<'_, AppState>,
    request: DestinationRequest,
) -> Result<DestinationPage, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |b| b.browse_provider_destination(&request)).await
}

#[tauri::command]
pub(crate) async fn list_conversations(
    state: State<'_, AppState>,
) -> Result<InboxSnapshot, MailError> {
    let core = state.core.clone();
    run_blocking(core, GmailCore::list_conversations).await
}

#[tauri::command]
pub(crate) async fn load_confirmed_send_thread(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<Conversation, MailError> {
    run_blocking(state.core.clone(), move |core| {
        core.load_confirmed_send_thread(&operation_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn get_conversation(
    state: State<'_, AppState>,
    r#ref: ConversationRef,
    load_missing_search_result: Option<bool>,
) -> Result<Conversation, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| {
        if load_missing_search_result == Some(true) {
            return core.load_search_conversation(&r#ref);
        }
        core.get_conversation(&r#ref)
    })
    .await
}

#[tauri::command]
pub(crate) async fn set_archived(
    state: State<'_, AppState>,
    command: SetArchived,
) -> Result<OperationReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_archived(&command)).await
}

#[tauri::command]
pub(crate) async fn enable_mailbox_actions(state: State<'_, AppState>) -> Result<(), MailError> {
    let core = state.core.clone();
    run_blocking(core, GmailCore::enable_mutations).await
}

#[tauri::command]
pub(crate) async fn cancel_mailbox_action_upgrade(
    state: State<'_, AppState>,
) -> Result<(), MailError> {
    let core = state.core.clone();
    run_blocking(core, GmailCore::cancel_mutation_upgrade).await
}

#[tauri::command]
pub(crate) async fn set_read(
    state: State<'_, AppState>,
    command: SetRead,
) -> Result<OperationReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_read(&command)).await
}

#[tauri::command]
pub(crate) async fn retry_operation(
    state: State<'_, AppState>,
    command: RetryOperation,
) -> Result<OperationReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.retry_operation(&command)).await
}

#[tauri::command]
pub(crate) async fn undo_operation(
    state: State<'_, AppState>,
    command: UndoOperation,
) -> Result<UndoReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.undo_operation(&command)).await
}

#[tauri::command]
pub(crate) async fn set_archived_group(
    state: State<'_, AppState>,
    command: SetArchivedGroup,
) -> Result<OperationGroupReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_archived_group(&command)).await
}

#[tauri::command]
pub(crate) async fn set_read_group(
    state: State<'_, AppState>,
    command: SetReadGroup,
) -> Result<OperationGroupReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_read_group(&command)).await
}

#[tauri::command]
pub(crate) async fn get_operation_group(
    state: State<'_, AppState>,
    request: GetOperationGroupRequest,
) -> Result<Option<OperationGroupStatus>, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.get_operation_group(&request)).await
}

#[tauri::command]
pub(crate) async fn list_operation_groups(
    state: State<'_, AppState>,
    request: ListOperationGroupsRequest,
) -> Result<OperationGroupPage, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.list_operation_groups(&request)).await
}

#[tauri::command]
pub(crate) async fn undo_operation_group(
    state: State<'_, AppState>,
    command: UndoOperationGroup,
) -> Result<GroupUndoReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.undo_operation_group(&command)).await
}
