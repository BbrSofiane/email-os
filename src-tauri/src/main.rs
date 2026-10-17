//! Thin Tauri adapter over the fixture and Gmail mail cores.
//!
//! `EMAIL_OS_MODE` selects the profile at launch (`fixture` by default, or
//! `gmail`). The two modes use separate app-data directories; Gmail credentials
//! stay in the OS Keychain and mailbox actions require verified user opt-in.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mail_core::dto::{
    Conversation, ConversationRef, InboxSnapshot, OperationReceipt, RetryOperation, SetArchived,
    SetRead,
};
use mail_core::error::MailError;
use mail_core::gmail::provider::GmailProvider;
use mail_core::gmail::secrets::KeychainSecrets;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::{AccountInfo, AccountStatus, MailMode, SyncInfo, SyncState};
use mail_core::{FakeArchiveProvider, MailCore, ACCOUNT_ID};
use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent, State};

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

    fn get_conversation(&self, r#ref: &ConversationRef) -> Result<Conversation, MailError> {
        match self {
            Self::Fixture(core) => core.get_conversation(r#ref),
            Self::Gmail(core) => core.get_conversation(r#ref),
        }
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
    _subscription: Subscription,
}

impl AppState {
    fn new(backend: Backend, on_change: impl Fn() + Send + Sync + 'static) -> Self {
        let subscription = backend.subscribe(on_change);
        Self {
            backend,
            _subscription: subscription,
        }
    }
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
async fn get_account_status(state: State<'_, AppState>) -> Result<AccountStatus, MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::account_status).await
}

#[tauri::command]
async fn connect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::connect_account).await
}

#[tauri::command]
async fn disconnect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::disconnect_account).await
}

#[tauri::command]
async fn request_sync(state: State<'_, AppState>) -> Result<(), MailError> {
    let backend = state.backend.clone();
    run_blocking(backend, Backend::request_sync).await
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_conversations,
            get_conversation,
            set_archived,
            enable_mailbox_actions,
            cancel_mailbox_action_upgrade,
            set_read,
            retry_operation,
            get_account_status,
            connect_account,
            disconnect_account,
            request_sync
        ])
        .setup(|app| {
            let mode = match std::env::var_os("EMAIL_OS_MODE") {
                Some(value) => value
                    .into_string()
                    .map_err(|_| "EMAIL_OS_MODE must be valid UTF-8")?,
                None => "fixture".to_owned(),
            };
            let app_data_dir = app.path().app_data_dir()?;
            let backend = match mode.as_str() {
                "fixture" => {
                    let core = MailCore::open(app_data_dir.join("fixture-profile"))?;
                    let provider: Arc<dyn mail_core::ArchiveProvider> =
                        Arc::new(FakeArchiveProvider::from_env());
                    core.start_worker(provider)?;
                    Backend::Fixture(core)
                }
                "gmail" => {
                    let provider = GmailProvider::from_env(Arc::new(KeychainSecrets::new()))?;
                    let provider: Arc<dyn mail_core::gmail::types::GmailReadProvider> =
                        Arc::new(provider);
                    Backend::Gmail(GmailCore::open(
                        app_data_dir.join("gmail-profile"),
                        provider,
                    )?)
                }
                _ => return Err("EMAIL_OS_MODE must be fixture or gmail".into()),
            };

            let handle = app.handle().clone();
            app.manage(AppState::new(backend, move || {
                // Notifications are best-effort hints; the frontend refetches persisted state.
                let _ = handle.emit("mailbox_changed", ());
            }));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the email-os shell");

    app.run(|app_handle, event| {
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.backend.stop();
            }
        }
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
        backend.stop();
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fixture_state_keeps_forwarding_after_command_acceptance() {
        let dir = temp_dir("events");
        let core = MailCore::open(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        let state = AppState::new(Backend::Fixture(core), move || {
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
        state.backend.stop();
        drop(state);
        let _ = std::fs::remove_dir_all(dir);
    }
}
