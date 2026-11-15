//! Thin Tauri adapter over the fixture and Gmail mail cores.
//!
//! `EMAIL_OS_MODE` selects the profile at launch (`fixture` by default, or
//! `gmail`). The two modes use separate app-data directories; Gmail credentials
//! stay in the OS Keychain and mailbox actions require verified user opt-in.
//! Fixture mode runs the Gmail core on the built-in synthetic provider; a
//! pre-existing legacy fixture database is retired once, with disclosure and a
//! verified backup (ADR 0002).

mod close_gate;
mod commands;
mod diagnostics;
mod state;
use mail_core::attachments::{AttachmentDescriptor, AttachmentSaved, SaveAttachment};

use commands::*;
use diagnostics::{cause, init_logging, storage_failure};
use mail_core::drafts::types::{
    AppCloseRequest, CreateDraft, DeleteDraft, Draft, DraftDeleteReceipt, DraftReceipt, DraftRef,
    DraftSummary, SaveDraft,
};
use mail_core::drafts::{DraftCore, DraftService};
use mail_core::dto::ConversationRef;
use mail_core::error::MailError;
use mail_core::fixture_transition::{FixtureTransition, FixtureTransitionStatus};
use mail_core::gmail::provider::LiveGmailProvider;
use mail_core::gmail::secrets::KeychainSecrets;
use mail_core::gmail::sync::GmailCore;
use mail_core::gmail::types::AccountStatus;
use state::AppState;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State};

/// Opens the fixture profile under `app_data_dir`: the synthetic core on its
/// own files. A legacy `mail.db` in the same directory is never opened here;
/// retiring it is the explicit, disclosed transition (`fixture_transition`).
/// The profile lock and `local-drafts` live in the same directory, so a second
/// writer is rejected.
fn open_fixture_core(
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

#[tauri::command]
async fn list_attachments(
    state: State<'_, AppState>,
    target: ConversationRef,
) -> Result<Vec<AttachmentDescriptor>, MailError> {
    run_blocking(state.core.clone(), move |core| {
        core.list_attachments(&target)
    })
    .await
}

#[tauri::command]
async fn save_attachment(
    app: AppHandle,
    state: State<'_, AppState>,
    request: SaveAttachment,
) -> Result<AttachmentSaved, MailError> {
    #[cfg(target_os = "android")]
    {
        let _ = (app, state, request);
        return Err(MailError::UnsupportedPlatform);
    }
    #[cfg(not(target_os = "android"))]
    {
        let directory = app
            .path()
            .download_dir()
            .map_err(|_| storage_failure(cause::PATH_UNAVAILABLE))?;
        let transfers = state.attachment_transfers.clone();
        let cancel = transfers.begin(&request.request_id)?;
        let id = request.request_id.clone();
        let result = run_blocking(state.core.clone(), move |core| {
            core.download_attachment(&request, &cancel, &directory)
        })
        .await;
        transfers.finish(&id)?;
        result
    }
}

#[tauri::command]
fn cancel_attachment(state: State<'_, AppState>, request_id: String) -> Result<(), MailError> {
    state.attachment_transfers.cancel(&request_id)
}

#[tauri::command]
async fn open_external_link(url: String) -> Result<(), MailError> {
    #[cfg(target_os = "android")]
    {
        let _ = url;
        return Err(MailError::UnsupportedPlatform);
    }
    #[cfg(not(target_os = "android"))]
    {
        let url = mail_core::attachments::validated_external_url(&url)?;
        #[cfg(target_os = "macos")]
        {
            tauri::async_runtime::spawn_blocking(move || {
                std::process::Command::new("/usr/bin/open")
                    .arg("--")
                    .arg(url)
                    // OS errors must not echo a mailbox URL into application logs.
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .status()
                    .map_err(|_| MailError::ProviderUnavailable)
                    .and_then(|status| {
                        if status.success() {
                            Ok(())
                        } else {
                            Err(MailError::ProviderUnavailable)
                        }
                    })
            })
            .await
            .map_err(|_| MailError::ProviderUnavailable)?
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = url;
            Err(MailError::ProviderUnavailable)
        }
    }
}

#[tauri::command]
async fn get_account_status(state: State<'_, AppState>) -> Result<AccountStatus, MailError> {
    let core = state.core.clone();
    run_blocking(core, GmailCore::account_status).await
}

#[tauri::command]
async fn connect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    run_blocking(state.drafts.clone(), DraftService::connect_account).await
}

#[tauri::command]
async fn disconnect_account(state: State<'_, AppState>) -> Result<(), MailError> {
    run_blocking(state.drafts.clone(), DraftService::disconnect_account).await
}

#[tauri::command]
async fn list_drafts(state: State<'_, AppState>) -> Result<Vec<DraftSummary>, MailError> {
    run_blocking(state.drafts.clone(), DraftService::list_drafts).await
}

#[tauri::command]
async fn get_draft(state: State<'_, AppState>, r#ref: DraftRef) -> Result<Draft, MailError> {
    run_blocking(state.drafts.clone(), move |drafts| drafts.get_draft(&r#ref)).await
}

#[tauri::command]
async fn create_draft(
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
async fn save_draft(
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
async fn delete_draft(
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

#[tauri::command]
async fn get_fixture_transition_status(
    transition: State<'_, Arc<FixtureTransition>>,
) -> Result<FixtureTransitionStatus, MailError> {
    let transition = Arc::clone(&transition);
    tauri::async_runtime::spawn_blocking(move || transition.status())
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
}

#[tauri::command]
async fn accept_fixture_transition(
    transition: State<'_, Arc<FixtureTransition>>,
) -> Result<FixtureTransitionStatus, MailError> {
    let transition = Arc::clone(&transition);
    tauri::async_runtime::spawn_blocking(move || transition.accept())
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
}

#[tauri::command]
fn get_app_close_request(state: State<'_, AppState>) -> Result<Option<AppCloseRequest>, MailError> {
    state
        .close_gate
        .lock()
        .map(|gate| gate.pending())
        .map_err(|_| storage_failure(cause::LOCK_POISONED))
}

#[tauri::command]
fn complete_app_close(
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
fn cancel_app_close(state: State<'_, AppState>, request_id: String) -> Result<(), MailError> {
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

#[tauri::command]
async fn request_sync(state: State<'_, AppState>) -> Result<(), MailError> {
    let core = state.core.clone();
    run_blocking(core, GmailCore::request_sync).await
}

fn fresh_close_request_id() -> String {
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

fn begin_native_close(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    if let Ok(mut gate) = state.close_gate.lock() {
        let request = gate.request(fresh_close_request_id);
        let _ = app.emit("app_close_requested", request);
    };
}

#[cfg(test)]
mod attachment_transfer_tests {
    use super::*;
    use mail_core::attachments::AttachmentTransfers;
    #[test]
    fn cancellation_before_or_during_admission_and_single_transfer_bound() {
        let transfers = AttachmentTransfers::default();
        transfers.cancel("early").unwrap();
        assert!(matches!(
            transfers.begin("early"),
            Err(MailError::AuthCancelled)
        ));
        let token = transfers.begin("active").unwrap();
        assert!(matches!(transfers.begin("other"), Err(MailError::Busy)));
        transfers.cancel("active").unwrap();
        assert!(token.is_cancelled());
        transfers.finish("active").unwrap();
        for i in 0..100 {
            transfers.cancel(&format!("r{i}")).unwrap();
        }
        // Only the 64 most recent cancellations are remembered (the exact
        // bound is asserted in mail-core): r36 is still refused, r35 is not.
        assert!(matches!(
            transfers.begin("r36"),
            Err(MailError::AuthCancelled)
        ));
        transfers.finish("r36").unwrap();
        assert!(transfers.begin("r35").is_ok());
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    let app = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            list_provider_destinations,
            browse_provider_destination,
            list_conversations,
            list_reminders,
            put_reminder,
            cancel_reminder,
            list_cached_done,
            list_cached_starred,
            set_starred,
            set_starred_group,
            get_saved_split,
            save_saved_split,
            search_mail,
            cancel_search_mail,
            list_cached_trash,
            get_conversation,
            list_attachments,
            save_attachment,
            cancel_attachment,
            open_external_link,
            set_archived,
            enable_mailbox_actions,
            cancel_mailbox_action_upgrade,
            set_read,
            retry_operation,
            undo_operation,
            set_archived_group,
            set_read_group,
            get_operation_group,
            list_operation_groups,
            undo_operation_group,
            get_account_status,
            connect_account,
            disconnect_account,
            request_sync,
            list_drafts,
            get_draft,
            create_draft,
            save_draft,
            delete_draft,
            get_app_close_request,
            get_fixture_transition_status,
            accept_fixture_transition,
            complete_app_close,
            cancel_app_close
        ])
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
    use mail_core::dto::{ConversationRef, RetryOperation, SetArchived, SetRead};
    use mail_core::error::MailError;

    use mail_core::gmail::sync::GmailCore;

    use mail_core::gmail::types::MailMode;
    use std::{collections::BTreeSet, fs};

    use mail_core::testing::temp_profile as temp_dir;

    fn quoted_values(source: &str, marker: &str) -> BTreeSet<String> {
        source
            .lines()
            .filter_map(|line| {
                let value = if marker == "\"" {
                    line.trim()
                } else {
                    line.split_once(marker)?.1.trim()
                };
                let value = value.trim();
                let value = value.strip_prefix('"')?.split('"').next()?;
                Some(value.to_owned())
            })
            .collect()
    }

    fn assert_command_sets_match(
        expected: &BTreeSet<String>,
        actual: &BTreeSet<String>,
        source: &str,
    ) {
        let missing: Vec<_> = expected.difference(actual).collect();
        let extra: Vec<_> = actual.difference(expected).collect();
        assert!(
            missing.is_empty() && extra.is_empty(),
            "{source} differs from generate_handler!: missing {missing:?}; extra {extra:?}"
        );
    }

    #[test]
    fn native_command_manifests_match_across_all_sources() {
        let main = include_str!("lib.rs");
        let handler = main
            .split_once("tauri::generate_handler![")
            .unwrap()
            .1
            .split_once("])")
            .unwrap()
            .0;
        let registered: BTreeSet<String> = handler
            .split(',')
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .collect();
        let build_source = include_str!("../build.rs");
        let build_block = build_source
            .split_once(".commands(&[")
            .unwrap()
            .1
            .split_once("])")
            .unwrap()
            .0;
        let build = quoted_values(build_block, "\"");
        assert_command_sets_match(&registered, &build, "build.rs");

        let capability: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/main-window.json")).unwrap();
        let allowed: BTreeSet<String> = capability["permissions"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|value| {
                value
                    .as_str()?
                    .strip_prefix("allow-")
                    .map(|name| name.replace('-', "_"))
            })
            .collect();
        assert_command_sets_match(&registered, &allowed, "main-window.json allow permissions");

        let permissions_dir =
            std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("permissions/autogenerated");
        let mut permission_commands = BTreeSet::new();
        let mut denied_commands = BTreeSet::new();
        for entry in fs::read_dir(permissions_dir).unwrap() {
            let path = entry.unwrap().path();
            if path.extension().and_then(|ext| ext.to_str()) != Some("toml") {
                continue;
            }
            let source = fs::read_to_string(path).unwrap();
            permission_commands.extend(quoted_values(&source, "commands.allow = ["));
            denied_commands.extend(quoted_values(&source, "commands.deny = ["));
        }
        assert_command_sets_match(
            &registered,
            &permission_commands,
            "autogenerated commands.allow",
        );
        assert_command_sets_match(&registered, &denied_commands, "autogenerated commands.deny");

        let client = include_str!("../../src/lib/ipc/tauri-client.ts");
        let invoked_constants: BTreeSet<String> = client
            .match_indices("call")
            .filter_map(|(offset, _)| {
                let rest = &client[offset + 4..];
                if !rest.starts_with('<') && !rest.starts_with('(') {
                    return None;
                }
                let rest = if rest.starts_with('<') {
                    rest.split_once('>')?.1
                } else {
                    rest
                };
                let rest = rest.trim_start().strip_prefix('(')?.trim_start();
                let name: String = rest
                    .chars()
                    .take_while(|ch| ch.is_ascii_uppercase() || *ch == '_')
                    .collect();
                (!name.is_empty()).then_some(name)
            })
            .collect();
        let generated = include_str!("../../src/lib/ipc/generated.ts");
        let client_names: BTreeSet<String> = generated
            .lines()
            .filter_map(|line| {
                let (name, value) = line.split_once(" = '")?;
                if !invoked_constants.contains(name.strip_prefix("export const ")?) {
                    return None;
                }
                Some(value.split('\'').next()?.to_owned())
            })
            .collect();
        assert_command_sets_match(&registered, &client_names, "tauri-client.ts invocations");
    }

    #[test]
    fn gmail_mutations_require_verified_access() {
        // Construction-level guard, covered without real credentials/network.
        let provider = mail_core::testing::operations_fake::FakeProvider::new(false);
        provider.set_configured(false);
        provider.set_credentials(false);
        let dir = temp_dir("gmail-readonly");
        let gmail = GmailCore::open(dir.path(), provider).unwrap();
        assert!(gmail.list_reminders().unwrap().is_empty());
        let status = gmail.account_status().unwrap();
        assert_eq!(status.mode, MailMode::Gmail);
        assert_eq!(
            status.mutation_access,
            Some(mail_core::gmail::types::MutationAccess::ReadOnly)
        );
        let result = gmail.set_archived(&SetArchived {
            conversation: ConversationRef {
                account_id: "a".into(),
                conversation_id: "c".into(),
            },
            archived: true,
            request_id: "bridge-readonly".into(),
        });
        assert_eq!(result, Err(MailError::PermissionRequired));
        assert_eq!(gmail.enable_mutations(), Err(MailError::NotConfigured));
        assert_eq!(gmail.cancel_mutation_upgrade(), Ok(()));
        assert_eq!(
            gmail.set_read(&SetRead {
                conversation: ConversationRef {
                    account_id: "a".into(),
                    conversation_id: "c".into(),
                },
                read: true,
                request_id: "bridge-readonly-read".into(),
            }),
            Err(MailError::PermissionRequired)
        );
        assert_eq!(
            gmail.retry_operation(&RetryOperation {
                operation_id: "bridge-operation".into(),
                request_id: "bridge-retry".into(),
            }),
            Err(MailError::PermissionRequired)
        );
        // Undo requires an active account that owns the operation; without
        // credentials the Gmail core has none.
        assert_eq!(
            gmail.undo_operation(&mail_core::dto::UndoOperation {
                operation_id: "bridge-operation".into(),
                request_id: "bridge-undo".into(),
            }),
            Err(MailError::AuthRequired)
        );
        gmail.stop();
        let _ = std::fs::remove_dir_all(dir);
    }
}

/// Native bridge tests for the opt-in synthetic core (ADR 0002 stage 3): the
/// same core methods the Tauri commands call, on a synthetic session.
#[cfg(test)]
mod synthetic_bridge_tests {
    use super::*;
    use mail_core::attachments::SaveAttachment;
    use mail_core::drafts::types::DraftSource;
    use mail_core::drafts::DraftCore;
    use mail_core::drafts::{load_validated_reply_context, require_draft_account, DraftLifecycle};
    use mail_core::dto::{
        CachedDoneRequest, CachedTrashRequest, ConversationRef, RetryOperation, SetArchived,
        SetRead,
    };
    use mail_core::error::MailError;
    use mail_core::fixture_transition::FixtureTransition;
    use mail_core::gmail::browsing::DestinationRequest;
    use mail_core::gmail::sync::GmailCore;
    use mail_core::gmail::types::{ConnectionState, MailMode};
    use mail_core::reminders::PutReminder;
    use mail_core::synthetic::WriteControls;
    use mail_core::testing::{temp_profile, until, TIMEOUT};
    use mail_core::CancelToken;
    use mail_core::ACCOUNT_ID;
    use std::sync::mpsc;
    use std::sync::Arc;
    use std::time::Duration;

    fn open(app_data: &std::path::Path, controls: WriteControls) -> GmailCore {
        let profile_dir = app_data.join("fixture-profile");
        GmailCore::open_synthetic_profile(
            profile_dir,
            controls,
            Arc::new(mail_core::clock::SystemClock),
        )
        .unwrap()
    }

    fn conv(id: &str) -> ConversationRef {
        ConversationRef {
            account_id: ACCOUNT_ID.into(),
            conversation_id: id.into(),
        }
    }

    fn mode_error() -> MailError {
        MailError::InvalidRequest {
            field: "mode".to_owned(),
        }
    }

    #[test]
    fn status_is_explicit_and_mutations_need_no_google_grant() {
        let dir = temp_profile("synthetic-status");
        let core = open(dir.path(), WriteControls::default());
        let status = core.account_status().unwrap();
        assert_eq!(status.mode, MailMode::Fixture);
        assert_eq!(status.connection, ConnectionState::Connected);
        assert_eq!(status.mutation_access, None);
        assert_eq!(status.sync.coverage_limit, 0);
        assert_eq!(status.sync.cached_conversations, 18);
        let account = core.active_account().unwrap();
        assert_eq!(account.account_id, ACCOUNT_ID);
        assert_eq!(account.email_address, mail_core::FIXTURE_MAILBOX);
        core.stop();
    }

    #[test]
    fn rejects_lifecycle_trash_and_destinations_with_todays_variants_and_admits_read_and_star() {
        let dir = temp_profile("synthetic-rejects");
        let core = open(dir.path(), WriteControls::default());
        assert_eq!(core.connect_account(), Err(mode_error()));
        assert_eq!(core.disconnect_account(), Err(mode_error()));
        assert_eq!(core.request_sync(), Err(mode_error()));
        assert_eq!(core.enable_mutations(), Err(mode_error()));
        assert_eq!(core.cancel_mutation_upgrade(), Err(mode_error()));
        assert_eq!(
            core.list_cached_trash(&CachedTrashRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 50,
                cursor: None,
            }),
            Err(mode_error())
        );
        assert_eq!(
            core.list_provider_destinations(ACCOUNT_ID, false),
            Err(MailError::ReadOnly)
        );
        assert_eq!(
            core.browse_provider_destination(&DestinationRequest {
                account_id: ACCOUNT_ID.into(),
                destination_id: "SENT".into(),
                cursor: None,
                cached: false,
            }),
            Err(MailError::ReadOnly)
        );
        // Nothing local was erased by the rejected lifecycle commands.
        assert_eq!(core.account_status().unwrap().sync.cached_conversations, 18);
        // Decision 2: read, star and retry are admitted.
        let read = core
            .set_read(&SetRead {
                conversation: conv("conv-02"),
                read: true,
                request_id: "bridge-read".into(),
            })
            .unwrap();
        let star = core
            .set_starred(&mail_core::stars::SetStarred {
                conversation: conv("conv-03"),
                starred: true,
                request_id: "bridge-star".into(),
            })
            .unwrap();
        assert!(until(|| {
            let snapshot = core.list_conversations().unwrap();
            [&read.operation_id, &star.operation_id].iter().all(|id| {
                snapshot.activity.iter().any(|op| {
                    &op.id == *id && op.status == mail_core::dto::OperationStatus::Confirmed
                })
            })
        }));
        let starred = core
            .list_cached_starred(&CachedDoneRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 100,
                cursor: None,
            })
            .unwrap();
        assert_eq!(starred.conversations.len(), 1);
        assert_eq!(
            core.retry_operation(&RetryOperation {
                operation_id: "unknown-operation".into(),
                request_id: "bridge-retry".into(),
            }),
            Err(MailError::NotFound)
        );
        core.stop();
    }

    #[test]
    fn reminder_bridge_preserves_exact_source_and_account_gate() {
        let dir = temp_profile("synthetic-reminders");
        let core = open(dir.path(), WriteControls::default());
        let detail = core.get_conversation(&conv("conv-01")).unwrap();
        let mut command = PutReminder {
            conversation: conv("conv-01"),
            source_message_id: detail.messages.last().unwrap().id.clone(),
            due_at: None,
            condition: mail_core::reminders::ReminderCondition::IfNoReply,
            expected_revision: None,
            request_id: "bridge-reminder".into(),
        };
        let receipt = core.put_reminder(&command).unwrap();
        assert_eq!(core.put_reminder(&command).unwrap(), receipt);
        assert_eq!(core.list_reminders().unwrap(), vec![receipt]);
        command.conversation.account_id = "foreign".into();
        assert_eq!(core.put_reminder(&command), Err(MailError::NotFound));
        let mut stale = command.clone();
        stale.conversation = conv("conv-02");
        stale.source_message_id = "not-the-latest".into();
        stale.request_id = "bridge-stale".into();
        assert!(core.put_reminder(&stale).is_err());
        core.stop();
    }

    #[test]
    fn saved_split_bridge_coexists_with_the_star_surface() {
        let dir = temp_profile("synthetic-split");
        let core = open(dir.path(), WriteControls::default());
        let split = mail_core::splits::SavedSplit {
            name: "Clients".into(),
            criterion: mail_core::splits::SplitCriterion::Domain,
            value: "example.test".into(),
            enabled: true,
            hide_when_empty: false,
        };
        assert_eq!(core.get_saved_split(ACCOUNT_ID).unwrap(), None);
        assert_eq!(core.save_saved_split(ACCOUNT_ID, &split).unwrap(), split);
        assert_eq!(core.get_saved_split(ACCOUNT_ID).unwrap(), Some(split));
        assert_eq!(core.get_saved_split("foreign"), Err(MailError::NotFound));
        assert!(core
            .set_starred(&mail_core::stars::SetStarred {
                conversation: conv("conv-01"),
                starred: true,
                request_id: "split-star".into(),
            })
            .is_ok());
        core.stop();
    }

    #[test]
    fn draft_scope_and_reply_sources_come_from_the_synthetic_account() {
        let dir = temp_profile("synthetic-drafts");
        let core = open(dir.path(), WriteControls::default());
        let account = core.active_account().unwrap();
        assert_eq!(account.account_id, ACCOUNT_ID);
        assert_eq!(
            require_draft_account(
                &account,
                &DraftRef {
                    account_id: "untrusted-other-account".into(),
                    draft_id: "draft-id".into(),
                }
            ),
            Err(MailError::NotFound)
        );
        // Reply context: complete, latest-source, deterministic headers.
        let detail = core.get_conversation(&conv("conv-02")).unwrap();
        let source = detail.messages.last().unwrap().id.clone();
        let replied = load_validated_reply_context(&core, &conv("conv-02"), &source).unwrap();
        let context = replied.reply_context.unwrap();
        assert_eq!(context.source_message_id, source);
        assert!(context.message_id.ends_with("@fixture.emailos>"));
        assert_eq!(
            load_validated_reply_context(&core, &conv("conv-02"), "an-older-message"),
            Err(MailError::ReplyUnavailable)
        );
        // A session change invalidates reply reads (core-independent).
        let mut lifecycle = DraftLifecycle::default();
        let before = lifecycle.session_epoch();
        assert!(lifecycle.is_current(before));
        lifecycle.advance();
        assert!(!lifecycle.is_current(before));
        assert!(lifecycle.is_current(lifecycle.session_epoch()));
        core.stop();
    }

    #[test]
    fn state_keeps_forwarding_after_command_acceptance() {
        let dir = temp_profile("synthetic-events");
        let core = open(dir.path(), WriteControls::default());
        let (tx, rx) = mpsc::channel();
        let drafts = DraftCore::open(dir.path().join("local-drafts")).unwrap();
        let state = AppState::new(core, drafts, move || {
            let _ = tx.send(());
        });
        let receipt = state
            .core
            .set_archived(&SetArchived {
                conversation: conv("conv-01"),
                archived: true,
                request_id: "bridge-test".into(),
            })
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2))
            .expect("acceptance event");
        assert!(until(|| {
            state
                .core
                .list_conversations()
                .unwrap()
                .activity
                .iter()
                .any(|op| {
                    op.id == receipt.operation_id
                        && op.status == mail_core::dto::OperationStatus::Confirmed
                })
        }));
        // Completion also notified (drain until quiet, never sleeping).
        assert!(rx.try_iter().count() >= 1 || rx.recv_timeout(Duration::from_secs(2)).is_ok());
        let done = state
            .core
            .list_cached_done(&CachedDoneRequest {
                account_id: ACCOUNT_ID.into(),
                limit: 10,
                cursor: None,
            })
            .unwrap();
        assert!(done
            .conversations
            .iter()
            .any(|row| row.conversation_ref.conversation_id == "conv-01"));
        assert_eq!(done.exact_total, None);
        assert_eq!(
            state.core.list_cached_done(&CachedDoneRequest {
                account_id: "foreign".into(),
                limit: 10,
                cursor: None,
            }),
            Err(MailError::NotFound)
        );
        state.core.stop();
    }

    #[test]
    fn paused_write_does_not_block_reads_or_shutdown() {
        let dir = temp_profile("synthetic-paused");
        let core = open(
            dir.path(),
            WriteControls {
                paused: true,
                reject_next: false,
            },
        );
        let receipt = core
            .set_archived(&SetArchived {
                conversation: conv("conv-01"),
                archived: true,
                request_id: "paused".into(),
            })
            .unwrap();
        // Reads, status and a second command stay responsive while paused.
        assert!(until(|| core
            .list_conversations()
            .unwrap()
            .activity
            .iter()
            .any(|op| {
                op.id == receipt.operation_id
                    && op.status == mail_core::dto::OperationStatus::Applying
            })));
        core.get_conversation(&conv("conv-02")).unwrap();
        core.account_status().unwrap();
        let (done_tx, done_rx) = mpsc::channel();
        let stopper = core.clone();
        std::thread::spawn(move || {
            stopper.stop();
            let _ = done_tx.send(());
        });
        done_rx
            .recv_timeout(TIMEOUT)
            .expect("stop completes while paused");
    }

    #[test]
    fn download_revalidates_exact_targets_and_never_opens_documents() {
        let dir = temp_profile("synthetic-attachment");
        let core = open(dir.path(), WriteControls::default());
        let target = core.list_conversations().unwrap().conversations[0]
            .conversation_ref
            .clone();
        let descriptor = core.list_attachments(&target).unwrap().remove(0);
        assert_eq!(descriptor.attachment_id, "fixture-text");
        assert_eq!(descriptor.filename, "example.txt");
        assert_eq!(descriptor.mime_type, "text/plain");
        let request = SaveAttachment {
            conversation: target,
            message_id: descriptor.message_id,
            attachment_id: descriptor.attachment_id,
            request_id: "r1".into(),
        };
        let downloads = temp_profile("synthetic-downloads");
        let saved = core
            .download_attachment(&request, &CancelToken::default(), downloads.path())
            .unwrap();
        assert_eq!(
            std::fs::read(downloads.path().join(&saved.filename)).unwrap(),
            b"Synthetic attachment only.\n"
        );
        let mut wrong_message = request.clone();
        wrong_message.message_id = "another-message".into();
        assert_eq!(
            core.download_attachment(&wrong_message, &CancelToken::default(), downloads.path()),
            Err(MailError::NotFound)
        );
        let mut wrong_attachment = request.clone();
        wrong_attachment.attachment_id = "another-attachment".into();
        assert_eq!(
            core.download_attachment(&wrong_attachment, &CancelToken::default(), downloads.path()),
            Err(MailError::NotFound)
        );
        let mut foreign = request.clone();
        foreign.conversation.account_id = "foreign".into();
        assert_eq!(
            core.download_attachment(&foreign, &CancelToken::default(), downloads.path()),
            Err(MailError::NotFound)
        );
        let cancelled = CancelToken::default();
        cancelled.cancel();
        assert_eq!(
            core.download_attachment(&request, &cancelled, downloads.path()),
            Err(MailError::AuthCancelled)
        );
        assert_eq!(
            std::fs::read_dir(downloads.path()).unwrap().count(),
            1,
            "only the one download"
        );
        core.stop();
    }

    const LEGACY_MAIL_DB: &[u8] =
        include_bytes!("../../crates/mail-core/tests/fixtures/legacy-fixture-profile/mail.db");

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
        assert_eq!(core.account_status().unwrap().sync.cached_conversations, 18);
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
