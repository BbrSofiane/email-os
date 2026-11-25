//! Thin Tauri adapter over the fixture and Gmail mail cores.
//!
//! `EMAIL_OS_MODE` selects the profile at launch (`fixture` by default, or
//! `gmail`). The two modes use separate app-data directories; Gmail credentials
//! stay in the OS Keychain and mailbox actions require verified user opt-in.
//! Fixture mode runs the Gmail core on the built-in synthetic provider; a
//! pre-existing legacy fixture database is retired once, with disclosure and a
//! verified backup (ADR 0002).

mod android_auth;
mod close_gate;
mod commands;
mod diagnostics;
#[cfg(test)]
mod manifest_tests;
mod mode;
mod setup;
mod state;
#[cfg(test)]
mod test_support;

use commands::*;
use diagnostics::init_logging;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    init_logging();
    let builder = tauri::Builder::default().invoke_handler(tauri::generate_handler![
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
        load_confirmed_send_thread,
        list_attachments,
        get_message_html,
        get_inline_image,
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
        send_available,
        send_draft,
        list_send_activity,
        undo_send,
        cancel_send,
        retry_send,
        check_sends,
        dismiss_send,
        copy_unknown_send,
        list_drafts,
        get_draft,
        create_draft,
        save_draft,
        delete_draft,
        get_app_close_request,
        get_mode_choice,
        switch_mode,
        get_fixture_transition_status,
        accept_fixture_transition,
        complete_app_close,
        cancel_app_close
    ]);
    #[cfg(target_os = "android")]
    let builder = builder.plugin(android_auth::plugin());
    setup::run(builder);
}
