fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "list_conversations",
        "get_conversation",
        "set_archived",
        "get_account_status",
        "connect_account",
        "disconnect_account",
        "request_sync",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to generate the approved app command permissions");
}
