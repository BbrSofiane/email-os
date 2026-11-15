mod mailbox;
pub(crate) use mailbox::*;

mod attachments;
pub(crate) use attachments::*;

use crate::diagnostics::{cause, storage_failure};
use mail_core::error::MailError;

/// Run all synchronous core/storage operations outside Tauri's async/UI threads.
pub(crate) async fn run_blocking<S, T, F>(subject: S, f: F) -> Result<T, MailError>
where
    S: Send + 'static,
    F: FnOnce(&S) -> Result<T, MailError> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(move || f(&subject))
        .await
        .map_err(|_| storage_failure(cause::TASK_JOIN))?
}
