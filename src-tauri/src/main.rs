//! Thin Tauri adapter over the fixture and Gmail mail cores.
//!
//! `EMAIL_OS_MODE` selects the profile at launch (`fixture` by default, or
//! `gmail`). The two modes use separate app-data directories; Gmail credentials
//! stay in the OS Keychain and mailbox actions require verified user opt-in.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod close_gate;
use mail_core::attachments::{AttachmentDescriptor, AttachmentSaved, SaveAttachment};
use mail_core::CancelToken;
use std::collections::{HashMap, VecDeque};

use close_gate::CloseGate;
use mail_core::drafts::types::{
    AppCloseRequest, CreateDraft, DeleteDraft, Draft, DraftDeleteReceipt, DraftReceipt, DraftRef,
    DraftSource, DraftSummary, SaveDraft,
};
use mail_core::drafts::DraftCore;
use mail_core::dto::{
    CachedDoneRequest, CachedDoneSnapshot, CachedTrashRequest, CachedTrashSnapshot, Conversation,
    ConversationRef, InboxSnapshot, OperationReceipt, RetryOperation, SetArchived, SetRead,
    UndoOperation, UndoReceipt,
};
use mail_core::error::MailError;
use mail_core::gmail::browsing::{DestinationCatalog, DestinationPage, DestinationRequest};
use mail_core::gmail::provider::GmailProvider;
use mail_core::gmail::secrets::KeychainSecrets;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{AccountInfo, AccountStatus, MailMode, SyncInfo, SyncState};
use mail_core::groups::{
    GetOperationGroupRequest, GroupUndoReceipt, ListOperationGroupsRequest, OperationGroupPage,
    OperationGroupReceipt, OperationGroupStatus, SetArchivedGroup, SetReadGroup,
    UndoOperationGroup,
};
use mail_core::reminders::{CancelReminder, PutReminder, Reminder};
use mail_core::{FakeArchiveProvider, MailCore, ACCOUNT_ID};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

const FIXTURE_ATTACHMENT: &[u8] = b"Synthetic attachment only.\n";

#[derive(Clone)]
enum Backend {
    Fixture(MailCore),
    Gmail(GmailCore),
}

impl Backend {
    fn list_reminders(&self) -> Result<Vec<Reminder>, MailError> {
        match self {
            Self::Fixture(core) => core.list_reminders(),
            Self::Gmail(core) => core.list_reminders(),
        }
    }
    fn put_reminder(&self, command: &PutReminder) -> Result<Reminder, MailError> {
        match self {
            Self::Fixture(core) => core.put_reminder(command),
            Self::Gmail(core) => core.put_reminder(command),
        }
    }
    fn cancel_reminder(&self, command: &CancelReminder) -> Result<Reminder, MailError> {
        match self {
            Self::Fixture(core) => core.cancel_reminder(command),
            Self::Gmail(core) => core.cancel_reminder(command),
        }
    }
    fn list_provider_destinations(
        &self,
        account_id: &str,
        cached: bool,
    ) -> Result<DestinationCatalog, MailError> {
        match self {
            Self::Gmail(core) => core.list_provider_destinations(account_id, cached),
            Self::Fixture(_) => Err(MailError::ReadOnly),
        }
    }
    fn browse_provider_destination(
        &self,
        request: &DestinationRequest,
    ) -> Result<DestinationPage, MailError> {
        match self {
            Self::Gmail(core) => core.browse_provider_destination(request),
            Self::Fixture(_) => Err(MailError::ReadOnly),
        }
    }

    fn list_conversations(&self) -> Result<InboxSnapshot, MailError> {
        match self {
            Self::Fixture(core) => core.list_conversations(),
            Self::Gmail(core) => core.list_conversations(),
        }
    }

    fn get_saved_split(
        &self,
        account: &str,
    ) -> Result<Option<mail_core::splits::SavedSplit>, MailError> {
        match self {
            Self::Fixture(core) => core.get_saved_split(account),
            Self::Gmail(core) => core.get_saved_split(account),
        }
    }
    fn save_saved_split(
        &self,
        account: &str,
        split: &mail_core::splits::SavedSplit,
    ) -> Result<mail_core::splits::SavedSplit, MailError> {
        match self {
            Self::Fixture(core) => core.save_saved_split(account, split),
            Self::Gmail(core) => core.save_saved_split(account, split),
        }
    }

    fn search_mail(
        &self,
        request: &mail_core::search::SearchRequest,
    ) -> Result<mail_core::search::SearchPage, MailError> {
        match self {
            Self::Fixture(core) => core.search_mail(request),
            Self::Gmail(core) => core.search_mail(request),
        }
    }
    fn list_cached_trash(
        &self,
        request: &CachedTrashRequest,
    ) -> Result<CachedTrashSnapshot, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".into(),
            }),
            Self::Gmail(core) => core.list_cached_trash(request),
        }
    }

    fn list_cached_done(
        &self,
        request: &CachedDoneRequest,
    ) -> Result<CachedDoneSnapshot, MailError> {
        match self {
            Self::Fixture(core) => core.list_cached_done(request),
            Self::Gmail(core) => core.list_cached_done(request),
        }
    }

    fn get_conversation(&self, r#ref: &ConversationRef) -> Result<Conversation, MailError> {
        match self {
            Self::Fixture(core) => core.get_conversation(r#ref),
            Self::Gmail(core) => core.get_conversation(r#ref),
        }
    }

    fn list_attachments(
        &self,
        target: &ConversationRef,
    ) -> Result<Vec<AttachmentDescriptor>, MailError> {
        match self {
            Self::Gmail(core) => core.list_attachments(target),
            Self::Fixture(core) => {
                let conversation = core.get_conversation(target)?;
                Ok(conversation
                    .messages
                    .first()
                    .map(|m| AttachmentDescriptor {
                        message_id: m.id.clone(),
                        attachment_id: "fixture-text".into(),
                        filename: "example.txt".into(),
                        mime_type: "text/plain".into(),
                        size: FIXTURE_ATTACHMENT.len() as u32,
                    })
                    .into_iter()
                    .collect())
            }
        }
    }

    fn download_attachment(
        &self,
        request: &SaveAttachment,
        cancel: &CancelToken,
        directory: &std::path::Path,
    ) -> Result<AttachmentSaved, MailError> {
        match self {
            Self::Gmail(core) => core.download_attachment(request, cancel, directory),
            Self::Fixture(_) => {
                let descriptor = self
                    .list_attachments(&request.conversation)?
                    .into_iter()
                    .find(|d| {
                        d.message_id == request.message_id
                            && d.attachment_id == request.attachment_id
                    })
                    .ok_or(MailError::NotFound)?;
                mail_core::attachments::save_download(
                    directory,
                    &descriptor,
                    FIXTURE_ATTACHMENT,
                    cancel,
                )
            }
        }
    }

    fn load_reply_context(
        &self,
        r#ref: &ConversationRef,
        source_message_id: &str,
    ) -> Result<Conversation, MailError> {
        let conversation = match self {
            Self::Fixture(core) => core.get_conversation(r#ref)?,
            Self::Gmail(core) => core.load_reply_context(r#ref, source_message_id)?,
        };
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

    fn account_status(&self) -> Result<AccountStatus, MailError> {
        match self {
            Self::Fixture(_) => Ok(AccountStatus {
                mode: MailMode::Fixture,
                mutation_access: None,
                connection: mail_core::gmail::types::ConnectionState::Connected,
                account: Some(AccountInfo {
                    account_id: ACCOUNT_ID.to_owned(),
                    email_address: mail_core::FIXTURE_MAILBOX.to_owned(),
                }),
                sync: SyncInfo {
                    state: SyncState::Idle,
                    last_synced_at: None,
                    error: None,
                    cached_conversations: 18,
                    initial_sync_complete: true,
                    coverage_limit: 0,
                },
            }),
            Self::Gmail(core) => core.account_status(),
        }
    }

    fn connect_account(&self) -> Result<(), MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.connect_account(),
        }
    }

    fn disconnect_account(&self) -> Result<(), MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.disconnect_account(),
        }
    }

    fn request_sync(&self) -> Result<(), MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.request_sync(),
        }
    }

    fn enable_mailbox_actions(&self) -> Result<(), MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.enable_mutations(),
        }
    }

    fn cancel_mailbox_action_upgrade(&self) -> Result<(), MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.cancel_mutation_upgrade(),
        }
    }

    fn set_archived(&self, command: &SetArchived) -> Result<OperationReceipt, MailError> {
        match self {
            Self::Fixture(core) => core.set_archived(command),
            Self::Gmail(core) => core.set_archived(command),
        }
    }

    fn set_starred(
        &self,
        command: &mail_core::stars::SetStarred,
    ) -> Result<OperationReceipt, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::ReadOnly),
            Self::Gmail(core) => core.set_starred(command),
        }
    }
    fn set_starred_group(
        &self,
        command: &mail_core::stars::SetStarredGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::ReadOnly),
            Self::Gmail(core) => core.set_starred_group(command),
        }
    }
    fn list_cached_starred(
        &self,
        request: &CachedDoneRequest,
    ) -> Result<CachedDoneSnapshot, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::ReadOnly),
            Self::Gmail(core) => core.list_cached_starred(request),
        }
    }

    fn set_read(&self, command: &SetRead) -> Result<OperationReceipt, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.set_read(command),
        }
    }

    fn retry_operation(&self, command: &RetryOperation) -> Result<OperationReceipt, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.retry_operation(command),
        }
    }

    /// Unlike the Gmail-only setters, Undo is forwarded for both backends:
    /// the fixture store covers Done/Not Done undo (archive only).
    fn undo_operation(&self, command: &UndoOperation) -> Result<UndoReceipt, MailError> {
        match self {
            Self::Fixture(core) => core.undo_operation(command),
            Self::Gmail(core) => core.undo_operation(command),
        }
    }

    /// Archive/unarchive group acceptance; both backends support it (the
    /// fixture covers archive groups like the single setter).
    fn set_archived_group(
        &self,
        command: &SetArchivedGroup,
    ) -> Result<OperationGroupReceipt, MailError> {
        match self {
            Self::Fixture(core) => core.set_archived_group(command),
            Self::Gmail(core) => core.set_archived_group(command),
        }
    }

    /// Group read/unread is Gmail-only, like the single `set_read`.
    fn set_read_group(&self, command: &SetReadGroup) -> Result<OperationGroupReceipt, MailError> {
        match self {
            Self::Fixture(_) => Err(MailError::InvalidRequest {
                field: "mode".to_owned(),
            }),
            Self::Gmail(core) => core.set_read_group(command),
        }
    }

    fn get_operation_group(
        &self,
        request: &GetOperationGroupRequest,
    ) -> Result<Option<OperationGroupStatus>, MailError> {
        match self {
            Self::Fixture(core) => core.get_operation_group(request),
            Self::Gmail(core) => core.get_operation_group(request),
        }
    }

    fn list_operation_groups(
        &self,
        request: &ListOperationGroupsRequest,
    ) -> Result<OperationGroupPage, MailError> {
        match self {
            Self::Fixture(core) => core.list_operation_groups(request),
            Self::Gmail(core) => core.list_operation_groups(request),
        }
    }

    /// Group Undo is forwarded for both backends (fixture groups are archive
    /// groups; Gmail groups are archive or read).
    fn undo_operation_group(
        &self,
        command: &UndoOperationGroup,
    ) -> Result<GroupUndoReceipt, MailError> {
        match self {
            Self::Fixture(core) => core.undo_operation_group(command),
            Self::Gmail(core) => core.undo_operation_group(command),
        }
    }

    fn subscribe(&self, on_change: impl Fn() + Send + Sync + 'static) -> Subscription {
        match self {
            Self::Fixture(core) => Subscription::Fixture(core.subscribe(on_change)),
            Self::Gmail(core) => Subscription::Gmail(core.subscribe(on_change)),
        }
    }

    fn stop(&self) {
        match self {
            Self::Fixture(core) => core.stop_worker(),
            Self::Gmail(core) => core.stop(),
        }
    }
}

#[allow(dead_code)] // Retained solely for its Drop-based unsubscribe behavior.
enum Subscription {
    Fixture(mail_core::Unsubscribe),
    Gmail(mail_core::gmail::sync::GmailUnsubscribe),
}

/// Managed app state retains its change-listener guard for the full app life.
#[derive(Default)]
struct AttachmentTransfers {
    active: HashMap<String, CancelToken>,
    cancelled: VecDeque<String>,
}
impl AttachmentTransfers {
    fn begin(&mut self, id: &str) -> Result<CancelToken, MailError> {
        if !mail_core::attachments::valid_id(id) {
            return Err(mail_core::attachments::invalid("requestId"));
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
        while self.cancelled.len() > 64 {
            self.cancelled.pop_front();
        }
    }
}

struct AppState {
    backend: Backend,
    drafts: DraftCore,
    draft_lifecycle: Arc<Mutex<DraftLifecycle>>,
    attachment_transfers: Arc<Mutex<AttachmentTransfers>>,
    close_gate: Arc<Mutex<CloseGate>>,
    _subscription: Subscription,
}

#[derive(Default)]
struct DraftLifecycle {
    session_epoch: u64,
}

impl DraftLifecycle {
    fn advance(&mut self) {
        self.session_epoch = self.session_epoch.wrapping_add(1);
    }

    fn is_current(&self, epoch: u64) -> bool {
        self.session_epoch == epoch
    }
}

impl AppState {
    fn new(
        backend: Backend,
        drafts: DraftCore,
        on_change: impl Fn() + Send + Sync + 'static,
    ) -> Self {
        let subscription = backend.subscribe(on_change);
        Self {
            backend,
            drafts,
            draft_lifecycle: Arc::new(Mutex::new(DraftLifecycle::default())),
            attachment_transfers: Arc::new(Mutex::new(AttachmentTransfers::default())),
            close_gate: Arc::new(Mutex::new(CloseGate::default())),
            _subscription: subscription,
        }
    }
}

fn active_account(backend: &Backend) -> Result<AccountInfo, MailError> {
    backend
        .account_status()?
        .account
        .ok_or(MailError::AuthRequired)
}

fn require_draft_account(account: &AccountInfo, draft_ref: &DraftRef) -> Result<(), MailError> {
    if draft_ref.account_id == account.account_id {
        Ok(())
    } else {
        Err(MailError::NotFound)
    }
}

fn validate_reply_conversation(
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

/// Run all synchronous core/storage operations outside Tauri's async/UI threads.
async fn run_blocking<T, F>(backend: Backend, f: F) -> Result<T, MailError>
where
    F: FnOnce(&Backend) -> Result<T, MailError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&backend))
        .await
        .map_err(|_| MailError::StorageUnavailable)?
}

#[tauri::command]
async fn list_cached_starred(
    state: State<'_, AppState>,
    request: CachedDoneRequest,
) -> Result<CachedDoneSnapshot, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| {
        backend.list_cached_starred(&request)
    })
    .await
}
#[tauri::command]
async fn set_starred(
    state: State<'_, AppState>,
    command: mail_core::stars::SetStarred,
) -> Result<OperationReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.set_starred(&command)).await
}
#[tauri::command]
async fn set_starred_group(
    state: State<'_, AppState>,
    command: mail_core::stars::SetStarredGroup,
) -> Result<OperationGroupReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.set_starred_group(&command)).await
}
#[tauri::command]
async fn get_saved_split(
    state: State<'_, AppState>,
    account_id: String,
) -> Result<Option<mail_core::splits::SavedSplit>, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.get_saved_split(&account_id)).await
}

#[tauri::command]
async fn save_saved_split(
    state: State<'_, AppState>,
    account_id: String,
    split: mail_core::splits::SavedSplit,
) -> Result<mail_core::splits::SavedSplit, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| {
        backend.save_saved_split(&account_id, &split)
    })
    .await
}

#[tauri::command]
async fn search_mail(
    state: State<'_, AppState>,
    request: mail_core::search::SearchRequest,
) -> Result<mail_core::search::SearchPage, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.search_mail(&request)).await
}

#[tauri::command]
async fn cancel_search_mail(state: State<'_, AppState>) -> Result<(), MailError> {
    if let Backend::Gmail(core) = &state.backend {
        core.cancel_search_mail();
    }
    Ok(())
}

#[tauri::command]
async fn list_reminders(state: State<'_, AppState>) -> Result<Vec<Reminder>, MailError> {
    run_blocking(state.backend.clone(), |backend| backend.list_reminders()).await
}
#[tauri::command]
async fn put_reminder(
    state: State<'_, AppState>,
    command: PutReminder,
) -> Result<Reminder, MailError> {
    run_blocking(state.backend.clone(), move |backend| {
        backend.put_reminder(&command)
    })
    .await
}
#[tauri::command]
async fn cancel_reminder(
    state: State<'_, AppState>,
    command: CancelReminder,
) -> Result<Reminder, MailError> {
    run_blocking(state.backend.clone(), move |backend| {
        backend.cancel_reminder(&command)
    })
    .await
}

#[tauri::command]
async fn list_cached_trash(
    state: State<'_, AppState>,
    request: CachedTrashRequest,
) -> Result<CachedTrashSnapshot, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.list_cached_trash(&request)).await
}

#[tauri::command]
async fn list_cached_done(
    state: State<'_, AppState>,
    request: CachedDoneRequest,
) -> Result<CachedDoneSnapshot, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.list_cached_done(&request)).await
}

#[tauri::command]
async fn list_provider_destinations(
    state: State<'_, AppState>,
    account_id: String,
    cached: bool,
) -> Result<DestinationCatalog, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |b| {
        b.list_provider_destinations(&account_id, cached)
    })
    .await
}

#[tauri::command]
async fn browse_provider_destination(
    state: State<'_, AppState>,
    request: DestinationRequest,
) -> Result<DestinationPage, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |b| b.browse_provider_destination(&request)).await
}

#[tauri::command]
async fn list_conversations(state: State<'_, AppState>) -> Result<InboxSnapshot, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::list_conversations).await
}

#[tauri::command]
async fn get_conversation(
    state: State<'_, AppState>,
    r#ref: ConversationRef,
    load_missing_search_result: Option<bool>,
) -> Result<Conversation, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| {
        if load_missing_search_result == Some(true) {
            if let Backend::Gmail(core) = &backend {
                return core.load_search_conversation(&r#ref);
            }
        }
        backend.get_conversation(&r#ref)
    })
    .await
}

#[tauri::command]
async fn list_attachments(
    state: State<'_, AppState>,
    target: ConversationRef,
) -> Result<Vec<AttachmentDescriptor>, MailError> {
    run_blocking(state.backend.clone(), move |backend| {
        backend.list_attachments(&target)
    })
    .await
}

#[tauri::command]
async fn save_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SaveAttachment,
) -> Result<AttachmentSaved, MailError> {
    let directory = app
        .path()
        .download_dir()
        .map_err(|_| MailError::StorageUnavailable)?;
    let transfers = Arc::clone(&state.attachment_transfers);
    let cancel = transfers
        .lock()
        .map_err(|_| MailError::StorageUnavailable)?
        .begin(&request.request_id)?;
    let id = request.request_id.clone();
    let result = run_blocking(state.backend.clone(), move |backend| {
        backend.download_attachment(&request, &cancel, &directory)
    })
    .await;
    transfers
        .lock()
        .map_err(|_| MailError::StorageUnavailable)?
        .active
        .remove(&id);
    result
}

#[tauri::command]
fn cancel_attachment(state: State<'_, AppState>, request_id: String) -> Result<(), MailError> {
    if !mail_core::attachments::valid_id(&request_id) {
        return Err(mail_core::attachments::invalid("requestId"));
    }
    state
        .attachment_transfers
        .lock()
        .map_err(|_| MailError::StorageUnavailable)?
        .cancel(&request_id);
    Ok(())
}

#[tauri::command]
async fn open_external_link(url: String) -> Result<(), MailError> {
    let url = mail_core::attachments::validated_external_url(&url)?;
    #[cfg(target_os = "macos")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            std::process::Command::new("/usr/bin/open")
                .arg("--")
                .arg(url)
                // OS errors must not echo a mailbox URL into application logs.
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .map_err(|_| MailError::ProviderUnavailable)
                .and_then(|status| {
                    if status.success() {
                        Ok(())
                    } else {
                        Err(MailError::ProviderUnavailable)
                    }
                })
        })
        .await
        .map_err(|_| MailError::ProviderUnavailable)?
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = url;
        Err(MailError::ProviderUnavailable)
    }
}

#[tauri::command]
async fn set_archived(
    state: State<'_, AppState>,
    command: SetArchived,
) -> Result<OperationReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.set_archived(&command)).await
}

#[tauri::command]
async fn enable_mailbox_actions(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::enable_mailbox_actions).await
}

#[tauri::command]
async fn cancel_mailbox_action_upgrade(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::cancel_mailbox_action_upgrade).await
}

#[tauri::command]
async fn set_read(
    state: State<'_, AppState>,
    command: SetRead,
) -> Result<OperationReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.set_read(&command)).await
}

#[tauri::command]
async fn retry_operation(
    state: State<'_, AppState>,
    command: RetryOperation,
) -> Result<OperationReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.retry_operation(&command)).await
}

#[tauri::command]
async fn undo_operation(
    state: State<'_, AppState>,
    command: UndoOperation,
) -> Result<UndoReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.undo_operation(&command)).await
}

#[tauri::command]
async fn set_archived_group(
    state: State<'_, AppState>,
    command: SetArchivedGroup,
) -> Result<OperationGroupReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.set_archived_group(&command)).await
}

#[tauri::command]
async fn set_read_group(
    state: State<'_, AppState>,
    command: SetReadGroup,
) -> Result<OperationGroupReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.set_read_group(&command)).await
}

#[tauri::command]
async fn get_operation_group(
    state: State<'_, AppState>,
    request: GetOperationGroupRequest,
) -> Result<Option<OperationGroupStatus>, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| {
        backend.get_operation_group(&request)
    })
    .await
}

#[tauri::command]
async fn list_operation_groups(
    state: State<'_, AppState>,
    request: ListOperationGroupsRequest,
) -> Result<OperationGroupPage, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| {
        backend.list_operation_groups(&request)
    })
    .await
}

#[tauri::command]
async fn undo_operation_group(
    state: State<'_, AppState>,
    command: UndoOperationGroup,
) -> Result<GroupUndoReceipt, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| {
        backend.undo_operation_group(&command)
    })
    .await
}

#[tauri::command]
async fn get_account_status(state: State<'_, AppState>) -> Result<AccountStatus, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::account_status).await
}

#[tauri::command]
async fn connect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    run_blocking(backend, move |backend| {
        let mut lifecycle = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        backend.connect_account()?;
        lifecycle.advance();
        Ok(())
    })
    .await
}

#[tauri::command]
async fn disconnect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    run_blocking(backend, move |backend| {
        let mut lifecycle = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        lifecycle.advance();
        backend.disconnect_account()
    })
    .await
}

#[tauri::command]
async fn list_drafts(state: State<'_, AppState>) -> Result<Vec<DraftSummary>, MailError> {
    let backend = state.backend.clone();
    let drafts = state.drafts.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    run_blocking(backend, move |backend| {
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account = active_account(backend)?;
        drafts.list_drafts(&account)
    })
    .await
}

#[tauri::command]
async fn get_draft(state: State<'_, AppState>, r#ref: DraftRef) -> Result<Draft, MailError> {
    let backend = state.backend.clone();
    let drafts = state.drafts.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    run_blocking(backend, move |backend| {
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account = active_account(backend)?;
        require_draft_account(&account, &r#ref)?;
        drafts.get_draft(&account, &r#ref)
    })
    .await
}

#[tauri::command]
async fn create_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: CreateDraft,
) -> Result<DraftReceipt, MailError> {
    let backend = state.backend.clone();
    let drafts = state.drafts.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    let receipt = run_blocking(backend, move |backend| {
        let lifecycle_guard = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account = active_account(backend)?;
        if let Some(receipt) = drafts.lookup_create_receipt(&account, &command)? {
            return Ok(receipt);
        }
        match &command.source {
            DraftSource::NewMessage => drafts.create_draft(&account, &command, None),
            DraftSource::Reply {
                conversation,
                source_message_id,
            } => {
                if conversation.account_id != account.account_id {
                    return Err(MailError::ReplyUnavailable);
                }
                let displayed = backend.get_conversation(conversation)?;
                validate_reply_conversation(&displayed, conversation, source_message_id)?;
                let session_epoch = lifecycle_guard.session_epoch;
                drop(lifecycle_guard);

                // This helper is a cache hit when metadata is ready. A legacy
                // metadata fetch is readonly and deliberately happens unlocked.
                let reply_conversation =
                    backend.load_reply_context(conversation, source_message_id)?;

                let lifecycle_guard = lifecycle
                    .lock()
                    .map_err(|_| MailError::StorageUnavailable)?;
                if !lifecycle_guard.is_current(session_epoch)
                    || active_account(backend)?.account_id != account.account_id
                {
                    return Err(MailError::AuthRequired);
                }
                let current = backend.get_conversation(conversation)?;
                validate_reply_conversation(&current, conversation, source_message_id)?;
                if current.reply_context != reply_conversation.reply_context {
                    return Err(MailError::ReplyUnavailable);
                }
                drafts.create_draft(&account, &command, Some(&reply_conversation))
            }
        }
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}

#[tauri::command]
async fn save_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: SaveDraft,
) -> Result<DraftReceipt, MailError> {
    let backend = state.backend.clone();
    let drafts = state.drafts.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    let receipt = run_blocking(backend, move |backend| {
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account = active_account(backend)?;
        require_draft_account(&account, &command.draft_ref)?;
        drafts.save_draft(&account, &command)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}

#[tauri::command]
async fn delete_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: DeleteDraft,
) -> Result<DraftDeleteReceipt, MailError> {
    let backend = state.backend.clone();
    let drafts = state.drafts.clone();
    let lifecycle = Arc::clone(&state.draft_lifecycle);
    let receipt = run_blocking(backend, move |backend| {
        let _lifecycle = lifecycle
            .lock()
            .map_err(|_| MailError::StorageUnavailable)?;
        let account = active_account(backend)?;
        require_draft_account(&account, &command.draft_ref)?;
        drafts.delete_draft(&account, &command)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}

#[tauri::command]
fn get_app_close_request(state: State<'_, AppState>) -> Result<Option<AppCloseRequest>, MailError> {
    state
        .close_gate
        .lock()
        .map(|gate| gate.pending())
        .map_err(|_| MailError::StorageUnavailable)
}

#[tauri::command]
fn complete_app_close(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), MailError> {
    let mut gate = state
        .close_gate
        .lock()
        .map_err(|_| MailError::StorageUnavailable)?;
    if !gate.complete(&request_id) {
        return Err(MailError::InvalidRequest {
            field: "requestId".to_owned(),
        });
    }
    drop(gate);
    app.exit(0);
    Ok(())
}

#[tauri::command]
fn cancel_app_close(state: State<'_, AppState>, request_id: String) -> Result<(), MailError> {
    let mut gate = state
        .close_gate
        .lock()
        .map_err(|_| MailError::StorageUnavailable)?;
    if !gate.cancel(&request_id) {
        return Err(MailError::InvalidRequest {
            field: "requestId".to_owned(),
        });
    }
    Ok(())
}

#[tauri::command]
async fn request_sync(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::request_sync).await
}

fn fresh_close_request_id() -> String {
    static NEXT_CLOSE_ID: AtomicU64 = AtomicU64::new(1);
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!(
        "{:x}-{:x}-{:x}",
        std::process::id(),
        timestamp,
        NEXT_CLOSE_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn begin_native_close(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Ok(mut gate) = state.close_gate.lock() {
        let request = gate.request(fresh_close_request_id);
        let _ = app.emit("app_close_requested", request);
    };
}

#[cfg(test)]
mod attachment_transfer_tests {
    use super::*;
    #[test]
    fn cancellation_before_or_during_admission_and_single_transfer_bound() {
        let mut transfers = AttachmentTransfers::default();
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
    fn fixture_download_revalidates_exact_targets_and_never_opens_documents() {
        let dir = tempfile::tempdir().unwrap();
        let core = MailCore::open(dir.path().join("profile")).unwrap();
        let backend = Backend::Fixture(core);
        let target = backend.list_conversations().unwrap().conversations[0]
            .conversation_ref
            .clone();
        let descriptor = backend.list_attachments(&target).unwrap().remove(0);
        let request = SaveAttachment {
            conversation: target,
            message_id: descriptor.message_id,
            attachment_id: descriptor.attachment_id,
            request_id: "r1".into(),
        };
        let saved = backend
            .download_attachment(&request, &CancelToken::default(), dir.path())
            .unwrap();
        assert_eq!(
            std::fs::read(dir.path().join(saved.filename)).unwrap(),
            b"Synthetic attachment only.\n"
        );
        let mut wrong = request.clone();
        wrong.message_id = "another-message".into();
        assert_eq!(
            backend.download_attachment(&wrong, &CancelToken::default(), dir.path()),
            Err(MailError::NotFound)
        );
        drop(backend);
        let _ = std::fs::remove_dir_all(dir);
    }
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_provider_destinations,
            browse_provider_destination,
            list_conversations,
            list_reminders,
            put_reminder,
            cancel_reminder,
            list_cached_done,
            list_cached_starred,
            set_starred,
            set_starred_group,
            get_saved_split,
            save_saved_split,
            search_mail,
            cancel_search_mail,
            list_cached_trash,
            get_conversation,
            list_attachments,
            save_attachment,
            cancel_attachment,
            open_external_link,
            set_archived,
            enable_mailbox_actions,
            cancel_mailbox_action_upgrade,
            set_read,
            retry_operation,
            undo_operation,
            set_archived_group,
            set_read_group,
            get_operation_group,
            list_operation_groups,
            undo_operation_group,
            get_account_status,
            connect_account,
            disconnect_account,
            request_sync,
            list_drafts,
            get_draft,
            create_draft,
            save_draft,
            delete_draft,
            get_app_close_request,
            complete_app_close,
            cancel_app_close
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                begin_native_close(window.app_handle());
            }
        })
        .setup(|app| {
            let mode = match std::env::var_os("EMAIL_OS_MODE") {
                Some(value) => value
                    .into_string()
                    .map_err(|_| "EMAIL_OS_MODE must be valid UTF-8")?,
                None => "fixture".to_owned(),
            };
            let app_data_dir = app.path().app_data_dir()?;
            let (backend, profile_dir) = match mode.as_str() {
                "fixture" => {
                    let profile_dir = app_data_dir.join("fixture-profile");
                    let core = MailCore::open(&profile_dir)?;
                    let provider: Arc<dyn mail_core::ArchiveProvider> =
                        Arc::new(FakeArchiveProvider::from_env());
                    core.start_worker(provider)?;
                    (Backend::Fixture(core), profile_dir)
                }
                "gmail" => {
                    let profile_dir = app_data_dir.join("gmail-profile");
                    let provider = GmailProvider::from_env(Arc::new(KeychainSecrets::new()))?;
                    let provider: Arc<dyn mail_core::gmail::types::GmailReadProvider> =
                        Arc::new(provider);
                    (
                        Backend::Gmail(GmailCore::open(&profile_dir, provider)?),
                        profile_dir,
                    )
                }
                _ => return Err("EMAIL_OS_MODE must be fixture or gmail".into()),
            };
            let drafts = DraftCore::open(profile_dir.join("local-drafts"))?;

            let handle = app.handle().clone();
            app.manage(AppState::new(backend, drafts, move || {
                // Notifications are best-effort hints; the frontend refetches persisted state.
                let _ = handle.emit("mailbox_changed", ());
            }));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the email-os shell");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { api, .. } => {
            let authorized = app_handle
                .try_state::<AppState>()
                .and_then(|state| {
                    state
                        .close_gate
                        .lock()
                        .ok()
                        .map(|mut gate| gate.take_exit_authorization())
                })
                .unwrap_or(false);
            if !authorized {
                api.prevent_exit();
                begin_native_close(app_handle);
            }
        }
        RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.backend.stop();
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::BTreeSet,
        fs,
        sync::{mpsc, Arc},
        time::Duration,
    };

    use mail_core::testing::temp_profile as temp_dir;

    fn quoted_values(source: &str, marker: &str) -> BTreeSet<String> {
        source
            .lines()
            .filter_map(|line| {
                let value = if marker == "\"" {
                    line.trim()
                } else {
                    line.split_once(marker)?.1.trim()
                };
                let value = value.trim();
                let value = value.strip_prefix('"')?.split('"').next()?;
                Some(value.to_owned())
            })
            .collect()
    }

    fn assert_command_sets_match(
        expected: &BTreeSet<String>,
        actual: &BTreeSet<String>,
        source: &str,
    ) {
        let missing: Vec<_> = expected.difference(actual).collect();
        let extra: Vec<_> = actual.difference(expected).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "{source} differs from generate_handler!: missing {missing:?}; extra {extra:?}"
        );
    }

    #[test]
    fn native_command_manifests_match_across_all_sources() {
        let main = include_str!("main.rs");
        let handler = main
            .split_once("tauri::generate_handler![")
            .unwrap()
            .1
            .split_once("])")
            .unwrap()
            .0;
        let registered: BTreeSet<String> = handler
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        let build_source = include_str!("../build.rs");
        let build_block = build_source
            .split_once(".commands(&[")
            .unwrap()
            .1
            .split_once("])")
            .unwrap()
            .0;
        let build = quoted_values(build_block, "\"");
        assert_command_sets_match(&registered, &build, "build.rs");

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        let allowed: BTreeSet<String> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| {
                value
                    .as_str()?
                    .strip_prefix("allow-")
                    .map(|name| name.replace('-', "_"))
            })
            .collect();
        assert_command_sets_match(&registered, &allowed, "main-window.json allow permissions");

        let permissions_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("permissions/autogenerated");
        let mut permission_commands = BTreeSet::new();
        let mut denied_commands = BTreeSet::new();
        for entry in fs::read_dir(permissions_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("toml") {
                continue;
            }
            let source = fs::read_to_string(path).unwrap();
            permission_commands.extend(quoted_values(&source, "commands.allow = ["));
            denied_commands.extend(quoted_values(&source, "commands.deny = ["));
        }
        assert_command_sets_match(
            &registered,
            &permission_commands,
            "autogenerated commands.allow",
        );
        assert_command_sets_match(&registered, &denied_commands, "autogenerated commands.deny");

        let client = include_str!("../../src/lib/ipc/tauri-client.ts");
        let invoked_constants: BTreeSet<String> = client
            .match_indices("call")
            .filter_map(|(offset, _)| {
                let rest = &client[offset + 4..];
                if !rest.starts_with('<') && !rest.starts_with('(') {
                    return None;
                }
                let rest = if rest.starts_with('<') {
                    rest.split_once('>')?.1
                } else {
                    rest
                };
                let rest = rest.trim_start().strip_prefix('(')?.trim_start();
                let name: String = rest
                    .chars()
                    .take_while(|ch| ch.is_ascii_uppercase() || *ch == '_')
                    .collect();
                (!name.is_empty()).then_some(name)
            })
            .collect();
        let generated = include_str!("../../src/lib/ipc/generated.ts");
        let client_names: BTreeSet<String> = generated
            .lines()
            .filter_map(|line| {
                let (name, value) = line.split_once(" = '")?;
                if !invoked_constants.contains(name.strip_prefix("export const ")?) {
                    return None;
                }
                Some(value.split('\'').next()?.to_owned())
            })
            .collect();
        assert_command_sets_match(&registered, &client_names, "tauri-client.ts invocations");
    }

    #[test]
    fn fixture_status_is_explicit_and_gmail_mutations_require_verified_access() {
        let dir = temp_dir("status");
        let fixture = MailCore::open(&dir).unwrap();
        let backend = Backend::Fixture(fixture);
        let status = backend.account_status().unwrap();
        assert_eq!(status.mode, MailMode::Fixture);
        assert_eq!(status.sync.coverage_limit, 0);
        // The Gmail variant cannot dispatch to the fixture archive core; this
        // construction-level guard is covered without real credentials/network.
        let provider = mail_core::testing::operations_fake::FakeProvider::new(false);
        provider.set_configured(false);
        provider.set_credentials(false);
        let dir = temp_dir("gmail-readonly");
        let gmail = GmailCore::open(dir.path(), provider).unwrap();
        let gmail = Backend::Gmail(gmail);
        assert!(gmail.list_reminders().unwrap().is_empty());
        let status = gmail.account_status().unwrap();
        assert_eq!(status.mode, MailMode::Gmail);
        assert_eq!(
            status.mutation_access,
            Some(mail_core::gmail::types::MutationAccess::ReadOnly)
        );
        let result = gmail.set_archived(&SetArchived {
            conversation: ConversationRef {
                account_id: "a".into(),
                conversation_id: "c".into(),
            },
            archived: true,
            request_id: "bridge-readonly".into(),
        });
        assert_eq!(result, Err(MailError::PermissionRequired));
        assert_eq!(
            gmail.enable_mailbox_actions(),
            Err(MailError::NotConfigured)
        );
        assert_eq!(gmail.cancel_mailbox_action_upgrade(), Ok(()));
        assert_eq!(
            gmail.set_read(&SetRead {
                conversation: ConversationRef {
                    account_id: "a".into(),
                    conversation_id: "c".into(),
                },
                read: true,
                request_id: "bridge-readonly-read".into(),
            }),
            Err(MailError::PermissionRequired)
        );
        assert_eq!(
            gmail.retry_operation(&RetryOperation {
                operation_id: "bridge-operation".into(),
                request_id: "bridge-retry".into(),
            }),
            Err(MailError::PermissionRequired)
        );
        // Undo requires an active account that owns the operation; without
        // credentials the Gmail backend has none.
        assert_eq!(
            gmail.undo_operation(&mail_core::dto::UndoOperation {
                operation_id: "bridge-operation".into(),
                request_id: "bridge-undo".into(),
            }),
            Err(MailError::AuthRequired)
        );
        gmail.stop();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fixture_reminder_bridge_preserves_exact_source_and_account_gate() {
        let dir = temp_dir("reminders");
        let core = MailCore::open(&dir).unwrap();
        let backend = Backend::Fixture(core);
        let target = ConversationRef {
            account_id: ACCOUNT_ID.into(),
            conversation_id: "conv-01".into(),
        };
        let detail = backend.get_conversation(&target).unwrap();
        let mut command = PutReminder {
            conversation: target,
            source_message_id: detail.messages.last().unwrap().id.clone(),
            due_at: None,
            condition: mail_core::reminders::ReminderCondition::IfNoReply,
            expected_revision: None,
            request_id: "bridge-reminder".into(),
        };
        let receipt = backend.put_reminder(&command).unwrap();
        assert_eq!(backend.put_reminder(&command).unwrap(), receipt);
        assert_eq!(backend.list_reminders().unwrap(), vec![receipt]);
        command.conversation.account_id = "foreign".into();
        assert_eq!(backend.put_reminder(&command), Err(MailError::NotFound));
        backend.stop();
        drop(backend);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn fixture_rejects_gmail_only_mailbox_commands() {
        // UX-08 stays fail-closed on the legacy archive-only fixture backend.
        let dir = temp_dir("fixture-gmail-actions");
        let core = MailCore::open(&dir).unwrap();
        let backend = Backend::Fixture(core);
        let target = ConversationRef {
            account_id: ACCOUNT_ID.into(),
            conversation_id: "conv-01".into(),
        };
        assert_eq!(
            backend.set_starred(&mail_core::stars::SetStarred {
                conversation: target.clone(),
                starred: true,
                request_id: "star-disabled".into()
            }),
            Err(MailError::ReadOnly)
        );
        assert_eq!(
            backend.set_starred_group(&mail_core::stars::SetStarredGroup {
                account_id: ACCOUNT_ID.into(),
                members: vec![target],
                starred: true,
                request_id: "group-star-disabled".into()
            }),
            Err(MailError::ReadOnly)
        );
        assert_eq!(
            backend.list_cached_starred(&CachedDoneRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 100,
                cursor: None
            }),
            Err(MailError::ReadOnly)
        );
        let mode_error = MailError::InvalidRequest {
            field: "mode".to_owned(),
        };
        assert_eq!(
            backend.list_cached_trash(&CachedTrashRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 50,
                cursor: None,
            }),
            Err(mode_error.clone())
        );
        assert_eq!(backend.enable_mailbox_actions(), Err(mode_error.clone()));
        assert_eq!(
            backend.cancel_mailbox_action_upgrade(),
            Err(mode_error.clone())
        );
        assert_eq!(
            backend.set_read(&SetRead {
                conversation: ConversationRef {
                    account_id: ACCOUNT_ID.into(),
                    conversation_id: "conv-01".into(),
                },
                read: true,
                request_id: "fixture-read".into(),
            }),
            Err(mode_error.clone())
        );
        assert_eq!(
            backend.retry_operation(&RetryOperation {
                operation_id: "fixture-operation".into(),
                request_id: "fixture-retry".into(),
            }),
            Err(mode_error)
        );
        // Undo is NOT Gmail-only: the fixture backend forwards it, so an
        // unknown operation fails typed as not found rather than as a mode
        // rejection.
        assert_eq!(
            backend.undo_operation(&mail_core::dto::UndoOperation {
                operation_id: "fixture-operation".into(),
                request_id: "fixture-undo".into(),
            }),
            Err(MailError::NotFound)
        );
        backend.stop();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn saved_split_bridge_coexists_with_gmail_only_star_surface() {
        let dir = temp_dir("split-stars");
        let backend = Backend::Fixture(MailCore::open(&dir).unwrap());
        let split = mail_core::splits::SavedSplit {
            name: "Clients".into(),
            criterion: mail_core::splits::SplitCriterion::Domain,
            value: "example.test".into(),
            enabled: true,
            hide_when_empty: false,
        };
        assert_eq!(backend.get_saved_split(ACCOUNT_ID).unwrap(), None);
        assert_eq!(backend.save_saved_split(ACCOUNT_ID, &split).unwrap(), split);
        assert_eq!(backend.get_saved_split(ACCOUNT_ID).unwrap(), Some(split));
        assert_eq!(backend.get_saved_split("foreign"), Err(MailError::NotFound));
        assert_eq!(
            backend.set_starred(&mail_core::stars::SetStarred {
                conversation: ConversationRef {
                    account_id: ACCOUNT_ID.into(),
                    conversation_id: "conv-01".into()
                },
                starred: true,
                request_id: "split-star-unsupported".into(),
            }),
            Err(MailError::ReadOnly)
        );
        backend.stop();
        drop(backend);
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn draft_scope_uses_backend_account_and_session_epoch_invalidates_reply_reads() {
        let dir = temp_dir("draft-scope");
        let core = MailCore::open(&dir).unwrap();
        let backend = Backend::Fixture(core.clone());
        let account = active_account(&backend).unwrap();
        assert_eq!(account.account_id, ACCOUNT_ID);
        assert_eq!(account.email_address, mail_core::FIXTURE_MAILBOX);
        assert_eq!(
            require_draft_account(
                &account,
                &DraftRef {
                    account_id: "untrusted-other-account".into(),
                    draft_id: "draft-id".into(),
                }
            ),
            Err(MailError::NotFound)
        );
        assert_eq!(
            require_draft_account(
                &account,
                &DraftRef {
                    account_id: account.account_id.clone(),
                    draft_id: "draft-id".into(),
                }
            ),
            Ok(())
        );

        let mut lifecycle = DraftLifecycle::default();
        let before_disconnect = lifecycle.session_epoch;
        assert!(lifecycle.is_current(before_disconnect));
        lifecycle.advance();
        assert!(!lifecycle.is_current(before_disconnect));
        assert!(lifecycle.is_current(lifecycle.session_epoch));
        core.stop_worker();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fixture_state_keeps_forwarding_after_command_acceptance() {
        let dir = temp_dir("events");
        let core = MailCore::open(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        let drafts = DraftCore::open(dir.path().join("local-drafts")).unwrap();
        let state = AppState::new(Backend::Fixture(core), drafts, move || {
            let _ = tx.send(());
        });
        let provider = Arc::new(FakeArchiveProvider::new());
        provider.set_paused(true);
        if let Backend::Fixture(core) = &state.backend {
            core.start_worker(provider.clone()).unwrap();
        }
        let receipt = state
            .backend
            .set_archived(&SetArchived {
                conversation: ConversationRef {
                    account_id: ACCOUNT_ID.into(),
                    conversation_id: "conv-01".into(),
                },
                archived: true,
                request_id: "bridge-test".into(),
            })
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2))
            .expect("acceptance event");
        assert!(provider.wait_for_calls(1, Duration::from_secs(2)));
        provider.resume();
        rx.recv_timeout(Duration::from_secs(2))
            .expect("completion event");
        let snapshot = state.backend.list_conversations().unwrap();
        assert!(snapshot.activity.iter().any(|op| {
            op.id == receipt.operation_id && op.status == mail_core::dto::OperationStatus::Confirmed
        }));
        assert_eq!(
            state.backend.list_provider_destinations(ACCOUNT_ID, false),
            Err(MailError::ReadOnly)
        );
        assert_eq!(
            state
                .backend
                .browse_provider_destination(&DestinationRequest {
                    account_id: ACCOUNT_ID.into(),
                    destination_id: "SENT".into(),
                    cursor: None,
                    cached: false,
                }),
            Err(MailError::ReadOnly)
        );
        let request = CachedDoneRequest {
            account_id: ACCOUNT_ID.into(),
            limit: 10,
            cursor: None,
        };
        let done = state.backend.list_cached_done(&request).unwrap();
        assert!(done
            .conversations
            .iter()
            .any(|row| row.conversation_ref.conversation_id == "conv-01"));
        assert_eq!(done.exact_total, None);
        assert_eq!(
            done.coverage,
            mail_core::dto::CachedDoneCoverage::LocalCache
        );
        assert_eq!(
            state.backend.list_cached_done(&CachedDoneRequest {
                account_id: "foreign".into(),
                ..request
            }),
            Err(MailError::NotFound)
        );
        state.backend.stop();
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
