use super::run_blocking;
#[cfg(not(target_os = "android"))]
use crate::diagnostics::{cause, storage_failure};
use crate::state::AppState;
use mail_core::attachments::{AttachmentDescriptor, AttachmentSaved, SaveAttachment};
use mail_core::dto::ConversationRef;
use mail_core::error::MailError;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
use tauri::{AppHandle, State};

#[tauri::command]
pub(crate) async fn list_attachments(
    state: State<'_, AppState>,
    target: ConversationRef,
) -> Result<Vec<AttachmentDescriptor>, MailError> {
    run_blocking(state.core.clone(), move |core| {
        core.list_attachments(&target)
    })
    .await
}

#[tauri::command]
pub(crate) async fn save_attachment(
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
pub(crate) fn cancel_attachment(
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), MailError> {
    state.attachment_transfers.cancel(&request_id)
}

#[tauri::command]
pub(crate) async fn open_external_link(url: String) -> Result<(), MailError> {
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
