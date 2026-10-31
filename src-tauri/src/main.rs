//! Thin Tauri adapter over the fixture and Gmail mail cores.
//!
//! `EMAIL_OS_MODE` selects the profile at launch (`fixture` by default, or
//! `gmail`). The two modes use separate app-data directories; Gmail credentials
//! stay in the OS Keychain and mailbox actions require verified user opt-in.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod close_gate;

use close_gate::CloseGate;
use mail_core::drafts::types::{
    AppCloseRequest, CreateDraft, DeleteDraft, Draft, DraftDeleteReceipt, DraftReceipt, DraftRef,
    DraftSource, DraftSummary, SaveDraft,
};
use mail_core::drafts::DraftCore;
use mail_core::dto::{
    CachedDoneRequest, CachedDoneSnapshot, Conversation, ConversationRef, InboxSnapshot,
    OperationReceipt, RetryOperation, SetArchived, SetRead, UndoOperation, UndoReceipt,
};
use mail_core::error::MailError;
use mail_core::gmail::provider::GmailProvider;
use mail_core::gmail::secrets::KeychainSecrets;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{AccountInfo, AccountStatus, MailMode, SyncInfo, SyncState};
use mail_core::{FakeArchiveProvider, MailCore, ACCOUNT_ID};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

#[derive(Clone)]
enum Backend {
    Fixture(MailCore),
    Gmail(GmailCore),
}

impl Backend {
    fn list_conversations(&self) -> Result<InboxSnapshot, MailError> {
        match self {
            Self::Fixture(core) => core.list_conversations(),
            Self::Gmail(core) => core.list_conversations(),
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
struct AppState {
    backend: Backend,
    drafts: DraftCore,
    draft_lifecycle: Arc<Mutex<DraftLifecycle>>,
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
async fn list_cached_done(
    state: State<'_, AppState>,
    request: CachedDoneRequest,
) -> Result<CachedDoneSnapshot, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.list_cached_done(&request)).await
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
) -> Result<Conversation, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, move |backend| backend.get_conversation(&r#ref)).await
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

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_conversations,
            list_cached_done,
            get_conversation,
            set_archived,
            enable_mailbox_actions,
            cancel_mailbox_action_upgrade,
            set_read,
            retry_operation,
            undo_operation,
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
        sync::{mpsc, Arc},
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!(
            "email-os-bridge-{tag}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
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
        struct ReadOnlyProvider;
        impl mail_core::gmail::types::GmailReadProvider for ReadOnlyProvider {
            fn is_configured(&self) -> bool {
                false
            }
            fn has_credentials(&self) -> Result<bool, MailError> {
                Ok(false)
            }
            fn connect(
                &self,
                _: &mail_core::CancelToken,
            ) -> Result<mail_core::gmail::types::GmailProfile, MailError> {
                Err(MailError::NotConfigured)
            }
            fn disconnect(&self) -> Result<(), MailError> {
                Ok(())
            }
            fn profile(
                &self,
                _: &mail_core::CancelToken,
            ) -> Result<mail_core::gmail::types::GmailProfile, MailError> {
                Err(MailError::NotConfigured)
            }
            fn list_inbox(
                &self,
                _: Option<&str>,
                _: &mail_core::CancelToken,
            ) -> Result<mail_core::gmail::types::InboxPage, MailError> {
                Ok(mail_core::gmail::types::InboxPage {
                    thread_ids: Vec::new(),
                    next_page_token: None,
                })
            }
            fn get_thread(
                &self,
                _: &str,
                _: &mail_core::CancelToken,
            ) -> Result<Option<mail_core::gmail::types::GmailThread>, MailError> {
                Ok(None)
            }
            fn history(
                &self,
                _: &str,
                _: Option<&str>,
                _: &mail_core::CancelToken,
            ) -> Result<
                mail_core::gmail::types::HistoryPage,
                mail_core::gmail::types::GmailHistoryError,
            > {
                Err(mail_core::gmail::types::GmailHistoryError::Mail(
                    MailError::NotConfigured,
                ))
            }
        }
        let gmail =
            GmailCore::open(temp_dir("gmail-readonly"), Arc::new(ReadOnlyProvider)).unwrap();
        let gmail = Backend::Gmail(gmail);
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
    fn fixture_rejects_gmail_only_mailbox_commands() {
        let dir = temp_dir("fixture-gmail-actions");
        let core = MailCore::open(&dir).unwrap();
        let backend = Backend::Fixture(core);
        let mode_error = MailError::InvalidRequest {
            field: "mode".to_owned(),
        };
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
        let drafts = DraftCore::open(dir.join("local-drafts")).unwrap();
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
