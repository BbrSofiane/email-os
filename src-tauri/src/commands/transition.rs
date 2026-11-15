use crate::diagnostics::{cause, storage_failure};
use mail_core::error::MailError;
use mail_core::fixture_transition::{FixtureTransition, FixtureTransitionStatus};
use std::sync::Arc;
use tauri::State;

#[tauri::command]
pub(crate) async fn get_fixture_transition_status(
    transition: State<'_, Arc<FixtureTransition>>,
) -> Result<FixtureTransitionStatus, MailError> {
    let transition = Arc::clone(&transition);
    tauri::async_runtime::spawn_blocking(move || transition.status())
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
