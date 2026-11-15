use crate::diagnostics::{cause, storage_failure};
use crate::state::AppState;
use mail_core::drafts::types::AppCloseRequest;
use mail_core::error::MailError;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, State};

#[tauri::command]
pub(crate) fn get_app_close_request(
    state: State<'_, AppState>,
) -> Result<Option<AppCloseRequest>, MailError> {
    state
        .close_gate
        .lock()
        .map(|gate| gate.pending())
        .map_err(|_| storage_failure(cause::LOCK_POISONED))
}

#[tauri::command]
pub(crate) fn complete_app_close(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), MailError> {
    let mut gate = state
        .close_gate
        .lock()
        .map_err(|_| storage_failure(cause::LOCK_POISONED))?;
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
pub(crate) fn cancel_app_close(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), MailError> {
    let mut gate = state
        .close_gate
        .lock()
        .map_err(|_| storage_failure(cause::LOCK_POISONED))?;
    if !gate.cancel(&request_id) {
        return Err(MailError::InvalidRequest {
            field: "requestId".to_owned(),
        });
    }
    Ok(())
}

pub(crate) fn fresh_close_request_id() -> String {
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

pub(crate) fn begin_native_close(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Ok(mut gate) = state.close_gate.lock() {
        let request = gate.request(fresh_close_request_id);
        let _ = app.emit("app_close_requested", request);
    };
}
