use mail_core::{error::MailError, fixture_transition::ModeChoice, gmail::types::MailMode};
use tauri::{AppHandle, Manager};

#[tauri::command]
pub(crate) async fn get_mode_choice(app: AppHandle) -> Result<ModeChoice, MailError> {
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(target_os = "android")]
        let chosen = {
            let coordinator = app.state::<crate::setup::StartupCoordinator>();
            coordinator.ensure_ready(&app)?;
            coordinator.chosen()?
        };
        #[cfg(not(target_os = "android"))]
        let chosen = true;
        let mode = app
            .state::<crate::state::AppState>()
            .session()?
            .core
            .account_status()?
            .mode;
        Ok(ModeChoice { chosen, mode })
    })
    .await
    .map_err(|_| crate::diagnostics::storage_failure(crate::diagnostics::cause::TASK_JOIN))?
}

#[tauri::command]
pub(crate) async fn switch_mode(app: AppHandle, mode: MailMode) -> Result<ModeChoice, MailError> {
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, mode);
        Err(MailError::UnsupportedPlatform)
    }
    #[cfg(target_os = "android")]
    {
        use crate::diagnostics::{cause, storage_failure};
        use crate::state::{AppState, Session};
        use mail_core::fixture_transition::FixtureTransition;
        use std::sync::Arc;
        use tauri::Emitter;
        tauri::async_runtime::spawn_blocking(move || {
            let coordinator = app.state::<crate::setup::StartupCoordinator>();
            let transition = coordinator.ensure_ready(&app)?;
            let dir = app
                .path()
                .app_data_dir()
                .map_err(|_| storage_failure(cause::PATH_UNAVAILABLE))?;
            let state = app.state::<AppState>();
            let current = state.session()?.core.account_status()?.mode;
            if current != mode {
                crate::mode::switch_session(&state, || {
                    let (core, drafts) = match mode {
                        MailMode::Fixture => crate::setup::open_fixture_state(&dir),
                        MailMode::Gmail => crate::setup::open_gmail_state(&app, &dir),
                    }
                    .map_err(|error| match error.downcast::<MailError>() {
                        Ok(error) => *error,
                        Err(_) => storage_failure(cause::STARTUP),
                    })?;
                    let handle = app.clone();
                    Ok(Session::new(core, drafts, move || {
                        let _ = handle.emit("mailbox_changed", ());
                    }))
                })?;
            }
            crate::mode::write_mode(&dir, mode)?;
            let ready = if current == mode {
                transition
            } else {
                Arc::new(match mode {
                    MailMode::Fixture => FixtureTransition::new(dir.join("fixture-profile")),
                    MailMode::Gmail => FixtureTransition::inactive(),
                })
            };
            coordinator.update(ready)?;
            if current != mode {
                let _ = app.emit("mode_changed", ());
            }
            Ok(ModeChoice { chosen: true, mode })
        })
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
    }
}
