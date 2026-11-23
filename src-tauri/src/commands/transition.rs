use crate::diagnostics::{cause, storage_failure};
use mail_core::error::MailError;
use mail_core::fixture_transition::{FixtureTransition, FixtureTransitionStatus};
use std::sync::Arc;
use tauri::{AppHandle, Manager};

fn ready_transition(app: &AppHandle) -> Result<Arc<FixtureTransition>, MailError> {
    #[cfg(target_os = "android")]
    {
        app.state::<crate::setup::StartupCoordinator>()
            .ensure_ready(app)
    }
    #[cfg(not(target_os = "android"))]
    {
        Ok(Arc::clone(app.state::<Arc<FixtureTransition>>().inner()))
    }
}

#[tauri::command]
pub(crate) async fn get_fixture_transition_status(
    app: AppHandle,
) -> Result<FixtureTransitionStatus, MailError> {
    tauri::async_runtime::spawn_blocking(move || ready_transition(&app)?.status())
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
}

#[tauri::command]
pub(crate) async fn accept_fixture_transition(
    app: AppHandle,
) -> Result<FixtureTransitionStatus, MailError> {
    tauri::async_runtime::spawn_blocking(move || ready_transition(&app)?.accept())
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
}
