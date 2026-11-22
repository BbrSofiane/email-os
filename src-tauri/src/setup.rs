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

#[cfg(test)]
mod tests {
    use crate::setup::open_fixture_core;
    use crate::test_support::{conv, LEGACY_MAIL_DB};
    use mail_core::drafts::load_validated_reply_context;
    use mail_core::drafts::types::DraftSource;
    use mail_core::drafts::DraftCore;
    use mail_core::fixture_transition::FixtureTransition;
    use mail_core::gmail::types::MailMode;
    use mail_core::testing::temp_profile;

    #[test]
    fn the_default_is_the_synthetic_core_and_a_legacy_mail_db_is_never_opened() {
        let dir = temp_profile("synthetic-default");
        let profile = dir.path().join("fixture-profile");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("mail.db"), LEGACY_MAIL_DB).unwrap();
        let (core, opened) = open_fixture_core(dir.path()).unwrap();
        assert_eq!(core.account_status().unwrap().mode, MailMode::Fixture);
        assert_eq!(opened, profile);
        assert!(profile.join("synthetic-provider.db").exists());
        assert!(profile.join("gmail.db").exists());
        assert_eq!(
            std::fs::read(profile.join("mail.db")).unwrap(),
            LEGACY_MAIL_DB
        );
        assert!(!profile.join("mail.db-wal").exists() && !profile.join("mail.db-shm").exists());
        // The fixture profile has a single writer.
        assert!(matches!(
            open_fixture_core(dir.path()),
            Err(error) if error.to_string().contains("another writer")
        ));
        core.stop();
    }

    /// The real startup order: the synthetic core is open (new files), then the
    /// disclosed transition retires the legacy database beside it. Drafts keep
    /// their account and their conversation/message references.
    #[test]
    fn retiring_the_legacy_database_beside_a_live_core_keeps_drafts_and_the_core_working() {
        let dir = temp_profile("synthetic-transition");
        let profile = dir.path().join("fixture-profile");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(profile.join("mail.db"), LEGACY_MAIL_DB).unwrap();
        let (core, _) = open_fixture_core(dir.path()).unwrap();

        // A reply draft written under the legacy core (same account, same IDs).
        let drafts = DraftCore::open(profile.join("local-drafts")).unwrap();
        let account = core.active_account().unwrap();
        let detail = core.get_conversation(&conv("conv-01")).unwrap();
        let source = detail.messages.last().unwrap().id.clone();
        let receipt = drafts
            .create_draft(
                &account,
                &mail_core::drafts::types::CreateDraft {
                    request_id: "legacy-draft".into(),
                    source: DraftSource::Reply {
                        conversation: conv("conv-01"),
                        source_message_id: source.clone(),
                    },
                    initial_content: None,
                },
                Some(&detail),
            )
            .unwrap();
        let draft_files: Vec<_> = std::fs::read_dir(profile.join("local-drafts"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();

        let transition = FixtureTransition::new(&profile);
        assert_eq!(
            transition.status().unwrap().state,
            mail_core::fixture_transition::FixtureTransitionState::NeedsDisclosure
        );
        let done = transition.accept().unwrap();
        assert_eq!(
            done.state,
            mail_core::fixture_transition::FixtureTransitionState::Done
        );
        assert!(!profile.join("mail.db").exists());
        assert_eq!(
            std::fs::read_dir(profile.join("backups")).unwrap().count(),
            1
        );

        // The core never noticed; drafts and their references are intact.
        assert_eq!(core.account_status().unwrap().sync.cached_conversations, 24);
        let again: Vec<_> = std::fs::read_dir(profile.join("local-drafts"))
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(draft_files, again, "local-drafts untouched");
        let draft = drafts.get_draft(&account, &receipt.draft_ref).unwrap();
        assert_eq!(draft.revision, receipt.revision);
        let reply = load_validated_reply_context(&core, &conv("conv-01"), &source).unwrap();
        assert_eq!(reply.reply_context.unwrap().source_message_id, source);
        core.stop();
    }
}
