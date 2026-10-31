fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "list_conversations",
        "list_cached_done",
        "get_conversation",
        "set_archived",
        "enable_mailbox_actions",
        "cancel_mailbox_action_upgrade",
        "set_read",
        "retry_operation",
        "undo_operation",
        "get_account_status",
        "connect_account",
        "disconnect_account",
        "request_sync",
        "list_drafts",
        "get_draft",
        "create_draft",
        "save_draft",
        "delete_draft",
        "get_app_close_request",
        "complete_app_close",
        "cancel_app_close",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to generate the approved app command permissions");
}
