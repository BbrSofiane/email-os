use super::run_blocking;
use crate::state::AppState;
use mail_core::drafts::DraftService;
use mail_core::error::MailError;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::AccountStatus;
use tauri::State;

#[tauri::command]
pub(crate) async fn get_account_status(
    state: State<'_, AppState>,
) -> Result<AccountStatus, MailError> {
    let core = state.session()?.core.clone();
    run_blocking(core, GmailCore::account_status).await
}

#[tauri::command]
pub(crate) async fn connect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    run_blocking(
        state.session()?.drafts.clone(),
        DraftService::connect_account,
    )
    .await
}

#[tauri::command]
pub(crate) async fn disconnect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    run_blocking(
        state.session()?.drafts.clone(),
        DraftService::disconnect_account,
    )
    .await
}

#[tauri::command]
pub(crate) async fn request_sync(state: State<'_, AppState>) -> Result<(), MailError> {
    let core = state.session()?.core.clone();
    run_blocking(core, GmailCore::request_sync).await
}
