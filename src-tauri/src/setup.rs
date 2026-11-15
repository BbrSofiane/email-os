#[cfg(not(mobile))]
use crate::commands::begin_native_close;
use crate::state::AppState;
use mail_core::drafts::DraftCore;
use mail_core::fixture_transition::FixtureTransition;
use mail_core::gmail::provider::LiveGmailProvider;
use mail_core::gmail::secrets::KeychainSecrets;
use mail_core::gmail::sync::GmailCore;
use std::sync::Arc;
use tauri::{Emitter, Manager, RunEvent};

/// Opens the fixture profile under `app_data_dir`: the synthetic core on its
/// own files. A legacy `mail.db` in the same directory is never opened here;
/// retiring it is the explicit, disclosed transition (`fixture_transition`).
/// The profile lock and `local-drafts` live in the same directory, so a second
/// writer is rejected.
pub(crate) fn open_fixture_core(
    app_data_dir: &std::path::Path,
) -> Result<(GmailCore, std::path::PathBuf), Box<dyn std::error::Error>> {
    let profile_dir = app_data_dir.join("fixture-profile");
    let core = GmailCore::open_synthetic_profile(
        &profile_dir,
        mail_core::synthetic::WriteControls::from_env(),
        Arc::new(mail_core::clock::SystemClock),
    )?;
    Ok((core, profile_dir))
}

pub(crate) fn run(builder: tauri::Builder<tauri::Wry>) {
    let app = builder
        .on_window_event(|window, event| {
            #[cfg(not(mobile))]
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                begin_native_close(window.app_handle());
            }
            #[cfg(mobile)]
            let _ = (window, event);
        })
        .setup(|app| {
            #[cfg(mobile)]
            let mode = "fixture".to_owned();
            #[cfg(not(mobile))]
            let mode = match std::env::var_os("EMAIL_OS_MODE") {
                Some(value) => value
                    .into_string()
                    .map_err(|_| "EMAIL_OS_MODE must be valid UTF-8")?,
                None => "fixture".to_owned(),
            };
            let app_data_dir = app.path().app_data_dir()?;
            let (core, profile_dir) = match mode.as_str() {
                "fixture" => open_fixture_core(&app_data_dir)?,
                "gmail" => {
                    let profile_dir = app_data_dir.join("gmail-profile");
                    let provider = LiveGmailProvider::from_env(Arc::new(KeychainSecrets::new()))?;
                    let provider: Arc<dyn mail_core::gmail::types::GmailProvider> =
                        Arc::new(provider);
                    (GmailCore::open(&profile_dir, provider)?, profile_dir)
                }
                _ => return Err("EMAIL_OS_MODE must be fixture or gmail".into()),
            };
            let drafts = DraftCore::open(profile_dir.join("local-drafts"))?;
            // The one-time retirement of a legacy fixture database; a no-op in
            // Gmail mode and on a fresh fixture profile.
            app.manage(Arc::new(if mode == "fixture" {
                FixtureTransition::new(&profile_dir)
            } else {
                FixtureTransition::inactive()
            }));

            let handle = app.handle().clone();
            app.manage(AppState::new(core, drafts, move || {
                // Notifications are best-effort hints; the frontend refetches persisted state.
                let _ = handle.emit("mailbox_changed", ());
            }));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build the email-os shell");

    app.run(|app_handle, event| match event {
        #[cfg(not(mobile))]
        RunEvent::ExitRequested { api, .. } => {
            let authorized = app_handle
                .try_state::<AppState>()
                .and_then(|state| {
                    state
                        .close_gate
                        .lock()
                        .ok()
                        .map(|mut gate| gate.take_exit_authorization())
                })
                .unwrap_or(false);
            if !authorized {
                api.prevent_exit();
                begin_native_close(app_handle);
            }
        }
        #[cfg(not(mobile))]
        RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<AppState>() {
                state.core.stop();
            }
        }
        _ => {}
    });
}
