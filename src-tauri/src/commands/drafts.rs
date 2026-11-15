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
    run_blocking(state.drafts.clone(), DraftService::list_drafts).await
}

#[tauri::command]
pub(crate) async fn get_draft(
    state: State<'_, AppState>,
    r#ref: DraftRef,
) -> Result<Draft, MailError> {
    run_blocking(state.drafts.clone(), move |drafts| drafts.get_draft(&r#ref)).await
}

#[tauri::command]
pub(crate) async fn create_draft(
    app: AppHandle,
    state: State<'_, AppState>,
    command: CreateDraft,
) -> Result<DraftReceipt, MailError> {
    let receipt = run_blocking(state.drafts.clone(), move |drafts| {
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
    let receipt = run_blocking(state.drafts.clone(), move |drafts| {
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
    let receipt = run_blocking(state.drafts.clone(), move |drafts| {
        drafts.delete_draft(&command)
    })
    .await?;
    let _ = app.emit("drafts_changed", ());
    Ok(receipt)
}
