fn main() {
    let manifest = tauri_build::AppManifest::new().commands(&[
        "list_conversations",
        "get_conversation",
        "set_archived",
    ]);
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(manifest))
        .expect("failed to generate the fixture command permissions");
}
