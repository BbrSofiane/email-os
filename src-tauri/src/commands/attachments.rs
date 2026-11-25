use super::run_blocking;
#[cfg(not(target_os = "android"))]
use crate::diagnostics::{cause, storage_failure};
use crate::state::AppState;
use mail_core::attachments::{AttachmentDescriptor, AttachmentSaved, SaveAttachment};
use mail_core::dto::{ConversationRef, InlineImageData, MessageHtmlBody};
use mail_core::error::MailError;
#[cfg(not(target_os = "android"))]
use tauri::Manager;
use tauri::{AppHandle, State};

#[tauri::command]
pub(crate) async fn list_attachments(
    state: State<'_, AppState>,
    target: ConversationRef,
) -> Result<Vec<AttachmentDescriptor>, MailError> {
    run_blocking(state.session()?.core.clone(), move |core| {
        core.list_attachments(&target)
    })
    .await
}

/// Returns the cached HTML body for a message.
#[tauri::command]
pub(crate) async fn get_message_html(
    state: State<'_, AppState>,
    target: ConversationRef,
    message_id: String,
) -> Result<MessageHtmlBody, MailError> {
    run_blocking(state.session()?.core.clone(), move |core| {
        core.get_message_html(&target, &message_id)
    })
    .await
}

/// Fetches and validates a listed inline image.
#[tauri::command]
pub(crate) async fn get_inline_image(
    state: State<'_, AppState>,
    target: ConversationRef,
    message_id: String,
    attachment_id: String,
) -> Result<InlineImageData, MailError> {
    run_blocking(state.session()?.core.clone(), move |core| {
        core.get_inline_image(&target, &message_id, &attachment_id)
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
        let result = run_blocking(state.session()?.core.clone(), move |core| {
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

/// Hands one validated HTTP(S) URL to the system browser. The frontend calls
/// it only from the explicit link confirmation (ADR 0006 decisions 11-13).
#[tauri::command]
pub(crate) async fn open_external_link(app: AppHandle, url: String) -> Result<(), MailError> {
    #[cfg(target_os = "android")]
    {
        let url = mail_core::attachments::validated_external_url(&url)?;
        android_view::open(&app, url).await
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
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

/// Android link dispatch: `Intent(ACTION_VIEW, Uri.parse(url))` started from
/// the app's activity on the webview's JNI thread, through Tauri's documented
/// `jni_handle().exec` hook. No plugin and no frontend permission are involved;
/// only `open_external_link` reaches it, after URL validation (ADR 0006
/// decision 13). The URL never appears in logs or errors.
#[cfg(target_os = "android")]
mod android_view {
    use jni::objects::{JObject, JValue};
    use jni::JNIEnv;
    use mail_core::error::MailError;
    use std::time::Duration;
    use tauri::{AppHandle, Manager};

    /// `Intent.FLAG_ACTIVITY_NEW_TASK`.
    const FLAG_ACTIVITY_NEW_TASK: i32 = 0x1000_0000;
    /// How long to wait for the JNI thread to report the outcome.
    const DISPATCH_TIMEOUT: Duration = Duration::from_secs(5);

    pub(super) async fn open(app: &AppHandle, url: String) -> Result<(), MailError> {
        let window = app
            .get_webview_window("main")
            .ok_or(MailError::ProviderUnavailable)?;
        let (sender, receiver) = std::sync::mpsc::channel();
        window
            .with_webview(move |webview| {
                webview.jni_handle().exec(move |env, activity, _webview| {
                    let _ = sender.send(start_view_intent(env, activity, &url));
                });
            })
            .map_err(|_| MailError::ProviderUnavailable)?;
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(DISPATCH_TIMEOUT))
            .await
            .map_err(|_| MailError::ProviderUnavailable)?
            .map_err(|_| MailError::ProviderUnavailable)?
    }

    /// Builds and starts the VIEW intent. A pending Java exception (for example
    /// `ActivityNotFoundException` when no browser is installed) is cleared and
    /// reported as unavailable, so the confirmation offers copying instead.
    fn start_view_intent(env: &mut JNIEnv, activity: &JObject, url: &str) -> Result<(), MailError> {
        let result = (|| -> jni::errors::Result<()> {
            let action = env
                .get_static_field(
                    "android/content/Intent",
                    "ACTION_VIEW",
                    "Ljava/lang/String;",
                )?
                .l()?;
            let text = env.new_string(url)?;
            let uri = env
                .call_static_method(
                    "android/net/Uri",
                    "parse",
                    "(Ljava/lang/String;)Landroid/net/Uri;",
                    &[JValue::Object(&text)],
                )?
                .l()?;
            let intent = env.new_object(
                "android/content/Intent",
                "(Ljava/lang/String;Landroid/net/Uri;)V",
                &[JValue::Object(&action), JValue::Object(&uri)],
            )?;
            env.call_method(
                &intent,
                "addFlags",
                "(I)Landroid/content/Intent;",
                &[JValue::Int(FLAG_ACTIVITY_NEW_TASK)],
            )?;
            env.call_method(
                activity,
                "startActivity",
                "(Landroid/content/Intent;)V",
                &[JValue::Object(&intent)],
            )?;
            Ok(())
        })();
        if env.exception_check().unwrap_or(false) {
            let _ = env.exception_clear();
            return Err(MailError::ProviderUnavailable);
        }
        result.map_err(|_| MailError::ProviderUnavailable)
    }
}

#[cfg(test)]
mod attachment_transfer_tests {
    use mail_core::attachments::AttachmentTransfers;
    use mail_core::error::MailError;
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
