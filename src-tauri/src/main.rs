//! Slice 01 native shell — a thin Tauri 2 adapter over `mail-core`.
//!
//! Responsibilities (docs/vertical-slice-01.md, "Core seam and shell integration"):
//! - acquire the fixture profile via `MailCore::open` on an app-specific path
//!   (`app_data_dir()/fixture-profile`), never a user's real mail;
//! - start the single serial worker independently of UI/component lifetime
//!   (`EMAIL_OS_FAKE_PROVIDER=paused|reject|success` selects the fixture demo mode);
//! - forward exactly the three approved commands (`list_conversations`,
//!   `get_conversation`, `set_archived`) through a blocking DB boundary so no
//!   SQLite work runs on Tauri's async/UI threads;
//! - forward core change hints as the `mailbox_changed` event (empty payload);
//! - stop the worker on exit: pending `applying` operations stay durable and
//!   are requeued on the next launch (interrupted-applying recovery).
//!
//! Closing the only window quits the app (default Tauri behavior for this
//! slice, no tray): quitting stops processing; queued/applying archive
//! operations recover at next launch. A worker halt (persistence failure) is
//! queryable via `MailCore::worker_error()`; commands keep returning
//! `storage_unavailable` until restart.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use mail_core::{
    dto::Conversation, dto::ConversationRef, dto::InboxSnapshot, dto::OperationReceipt,
    dto::SetArchived, error::MailError, FakeArchiveProvider, MailCore,
};
use tauri::{Emitter, Manager, RunEvent, State};

/// Managed app state. `MailCore` is `Clone + Send + Sync`; clones share the
/// same store, profile lock and worker.
struct AppState {
    core: MailCore,
    // Dropping this guard unsubscribes: retain it for the whole app lifetime.
    _subscription: mail_core::Unsubscribe,
}

impl AppState {
    fn new(core: MailCore, on_change: impl Fn() + Send + Sync + 'static) -> Self {
        let subscription = core.subscribe(on_change);
        Self {
            core,
            _subscription: subscription,
        }
    }
}

/// Runs a synchronous store call on a blocking thread so SQLite never blocks
/// Tauri's async runtime or the UI thread.
async fn run_blocking<T, F>(core: MailCore, f: F) -> Result<T, MailError>
where
    F: FnOnce(&MailCore) -> Result<T, MailError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&core))
        .await
        .map_err(|_| MailError::StorageUnavailable)?
}

#[tauri::command]
async fn list_conversations(state: State<'_, AppState>) -> Result<InboxSnapshot, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.list_conversations()).await
}

#[tauri::command]
async fn get_conversation(
    state: State<'_, AppState>,
    r#ref: ConversationRef,
) -> Result<Conversation, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.get_conversation(&r#ref)).await
}

#[tauri::command]
async fn set_archived(
    state: State<'_, AppState>,
    command: SetArchived,
) -> Result<OperationReceipt, MailError> {
    let core = state.core.clone();
    run_blocking(core, move |core| core.set_archived(&command)).await
}

fn main() {
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_conversations,
            get_conversation,
            set_archived
        ])
        .setup(|app| {
            // App-specific fixture path; never a user's mail directory.
            let profile_dir = app.path().app_data_dir()?.join("fixture-profile");
            let core = MailCore::open(&profile_dir)?;

            // Worker lifecycle is independent of the UI: started here, stopped
            // on exit (RAII also stops it if teardown happens first).
            let provider: std::sync::Arc<dyn mail_core::ArchiveProvider> =
                std::sync::Arc::new(FakeArchiveProvider::from_env());
            core.start_worker(provider)?;

            // Forward core change hints as the approved event; payload is empty.
            let handle = app.handle().clone();
            app.manage(AppState::new(core, move || {
                // Events are best-effort hints; persisted state is read on focus/startup.
                let _ = handle.emit("mailbox_changed", ());
            }));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the email-os fixture shell");

    app.run(|app_handle, event| {
        // Quitting stops processing; interrupted operations recover next launch.
        if let RunEvent::Exit = event {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.core.stop_worker();
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

    #[test]
    fn app_state_keeps_forwarding_after_command_acceptance() {
        let dir = std::env::temp_dir().join(format!(
            "email-os-bridge-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let core = MailCore::open(&dir).unwrap();
        let (tx, rx) = mpsc::channel();
        let state = AppState::new(core, move || {
            let _ = tx.send(());
        });
        let provider = Arc::new(FakeArchiveProvider::new());
        provider.set_paused(true);
        state.core.start_worker(provider.clone()).unwrap();
        let receipt = state
            .core
            .set_archived(&SetArchived {
                conversation: ConversationRef {
                    account_id: mail_core::ACCOUNT_ID.into(),
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
            .expect("later completion event");
        let snapshot = state.core.list_conversations().unwrap();
        assert!(snapshot
            .activity
            .iter()
            .any(|op| op.id == receipt.operation_id
                && op.status == mail_core::dto::OperationStatus::Confirmed));
        drop(state);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
