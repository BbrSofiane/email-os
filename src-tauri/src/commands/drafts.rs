use super::run_blocking;
use crate::state::AppState;
use mail_core::drafts::types::{
    CreateDraft, DeleteDraft, Draft, DraftDeleteReceipt, DraftReceipt, DraftRef, DraftSummary,
    SaveDraft,
};
use mail_core::drafts::DraftService;
use mail_core::error::MailError;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub(crate) async fn list_drafts(
    state: State<'_, AppState>,
) -> Result<Vec<DraftSummary>, MailError> {
    run_blocking(state.session()?.drafts.clone(), DraftService::list_drafts).await
}

#[tauri::command]
pub(crate) async fn get_draft(
    state: State<'_, AppState>,
    r#ref: DraftRef,
) -> Result<Draft, MailError> {
    run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.get_draft(&r#ref)
    })
    .await
}

#[tauri::command]
pub(crate) async fn create_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: CreateDraft,
) -> Result<DraftReceipt, MailError> {
    let receipt = run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.create_draft(&command)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}

#[tauri::command]
pub(crate) async fn save_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: SaveDraft,
) -> Result<DraftReceipt, MailError> {
    let receipt = run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.save_draft(&command)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}

#[tauri::command]
pub(crate) async fn delete_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: DeleteDraft,
) -> Result<DraftDeleteReceipt, MailError> {
    let receipt = run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.delete_draft(&command)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}

fn require_send_platform() -> Result<(), MailError> {
    if cfg!(any(target_os = "android", target_os = "macos")) {
        Ok(())
    } else {
        Err(MailError::UnsupportedPlatform)
    }
}

#[tauri::command]
pub(crate) async fn send_available(state: State<'_, AppState>) -> Result<bool, MailError> {
    if require_send_platform().is_err() {
        return Ok(false);
    }
    run_blocking(state.session()?.drafts.clone(), |drafts| {
        Ok(drafts.send_available())
    })
    .await
}

#[tauri::command]
pub(crate) async fn send_draft(
    state: State<'_, AppState>,
    command: mail_core::drafts::types::AdmitSend,
) -> Result<mail_core::drafts::types::SendStatus, MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.send_draft(&command)
    })
    .await
}

#[tauri::command]
pub(crate) async fn list_send_activity(
    state: State<'_, AppState>,
) -> Result<Vec<mail_core::drafts::types::SendStatus>, MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), DraftService::send_activity).await
}

#[tauri::command]
pub(crate) async fn undo_send(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<Option<DraftRef>, MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.undo_fixture_send(&operation_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn cancel_send(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<bool, MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.cancel_fixture_send(&operation_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn retry_send(
    state: State<'_, AppState>,
    operation_id: String,
    request_id: String,
) -> Result<mail_core::drafts::types::SendStatus, MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.retry_fixture_send(&operation_id, &request_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn check_sends(state: State<'_, AppState>) -> Result<(), MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), |drafts| {
        drafts.check_fixture_sends(&mail_core::CancelToken::default())
    })
    .await
}

#[tauri::command]
pub(crate) async fn dismiss_send(
    state: State<'_, AppState>,
    operation_id: String,
) -> Result<bool, MailError> {
    require_send_platform()?;
    run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.dismiss_fixture_send(&operation_id)
    })
    .await
}

#[tauri::command]
pub(crate) async fn copy_unknown_send(
    app: AppHandle,
    state: State<'_, AppState>,
    operation_id: String,
    request_id: String,
) -> Result<DraftReceipt, MailError> {
    require_send_platform()?;
    let receipt = run_blocking(state.session()?.drafts.clone(), move |drafts| {
        drafts.copy_unknown_send(&operation_id, &request_id)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}
