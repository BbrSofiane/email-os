use tauri::Manager;

pub(crate) struct GoogleAuthHandle(pub(crate) tauri::plugin::PluginHandle<tauri::Wry>);

pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("google-auth")
        .setup(|app, api| {
            let handle = api.register_android_plugin("dev.exedev.emailos", "GoogleAuthBridge")?;
            app.manage(GoogleAuthHandle(handle));
            Ok(())
        })
        .build()
}
