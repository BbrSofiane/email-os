use crate::diagnostics::{cause, storage_failure};
use mail_core::error::MailError;
use mail_core::fixture_transition::{FixtureTransition, FixtureTransitionStatus};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn get_fixture_transition_status(
    transition: State<'_, Arc<FixtureTransition>>,
    app: tauri::AppHandle,
) -> Result<FixtureTransitionStatus, MailError> {
    let transition = Arc::clone(&transition);
    #[cfg(not(target_os = "android"))]
    let _ = app;
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        {
            use tauri::Manager;
            app.state::<crate::setup::StartupCoordinator>()
                .ensure_ready(&app)?;
        }
        transition.status()
    })
    .await
    .map_err(|_| storage_failure(cause::TASK_JOIN))?
}

#[tauri::command]
pub(crate) async fn accept_fixture_transition(
    transition: State<'_, Arc<FixtureTransition>>,
) -> Result<FixtureTransitionStatus, MailError> {
    let transition = Arc::clone(&transition);
    tauri::async_runtime::spawn_blocking(move || transition.accept())
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
}
