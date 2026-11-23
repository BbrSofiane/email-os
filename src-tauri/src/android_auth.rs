use mail_core::{cancel::CancelToken, gmail::platform_auth::PlatformAuthError};
use serde::de::DeserializeOwned;
use std::{
    sync::mpsc,
    time::{Duration, Instant},
};

/// Decode the envelope returned by the mobile bridge.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn parse_bridge_result<T: DeserializeOwned>(
    value: serde_json::Value,
) -> Result<T, PlatformAuthError> {
    let object = value.as_object().ok_or(PlatformAuthError::Failed)?;
    if let Some(value) = object.get("ok") {
        serde_json::from_value(value.clone()).map_err(|_| PlatformAuthError::Failed)
    } else if let Some(error) = object.get("error") {
        Err(serde_json::from_value(error.clone()).unwrap_or(PlatformAuthError::Failed))
    } else {
        Err(PlatformAuthError::Failed)
    }
}

/// Run a blocking bridge call while observing cancellation and a deadline.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn wait_for_bridge<T: Send + 'static>(
    call: impl FnOnce() -> T + Send + 'static,
    cancel: Option<&CancelToken>,
    timeout: Duration,
) -> Result<T, PlatformAuthError> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let _ = sender.send(call());
    });
    let start = Instant::now();
    loop {
        if cancel.is_some_and(CancelToken::is_cancelled) {
            return Err(PlatformAuthError::Cancelled);
        }
        let remaining = timeout.saturating_sub(start.elapsed());
        if remaining.is_zero() {
            return Err(PlatformAuthError::Failed);
        }
        match receiver.recv_timeout(remaining.min(Duration::from_millis(100))) {
            Ok(value) => return Ok(value),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(PlatformAuthError::Failed),
        }
    }
}

#[cfg(target_os = "android")]
mod android {
    use super::*;
    use mail_core::{
        error::MailError,
        gmail::{
            auth::AUTH_TIMEOUT,
            platform_auth::{
                PlatformAuthRequest, PlatformAuthorizer, PlatformGrant, TokenlessSecrets,
            },
            secrets::{Secrets, TokenBundle},
        },
    };
    use std::sync::Arc;
    use tauri::Manager;
    type Handle = tauri::plugin::PluginHandle<tauri::Wry>;
    const TIMEOUT: Duration = Duration::from_secs(10);
    pub(crate) struct GoogleAuthHandle(pub(crate) Handle);
    pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
        tauri::plugin::Builder::new("google-auth")
            .setup(|app, api| {
                let handle =
                    api.register_android_plugin("dev.exedev.emailos", "GoogleAuthBridge")?;
                app.manage(GoogleAuthHandle(handle));
                Ok(())
            })
            .build()
    }
    /// Platform authorization through the Android bridge.
    pub(crate) struct AndroidPlatformAuthorizer {
        handle: Handle,
    }
    impl PlatformAuthorizer for AndroidPlatformAuthorizer {
        fn authorize(
            &self,
            request: &PlatformAuthRequest,
            cancel: &CancelToken,
        ) -> Result<PlatformGrant, PlatformAuthError> {
            let handle = self.handle.clone();
            let request = request.clone();
            let value = wait_for_bridge(
                move || handle.run_mobile_plugin::<serde_json::Value>("authorize", request),
                Some(cancel),
                AUTH_TIMEOUT,
            )?
            .map_err(|_| PlatformAuthError::Failed)?;
            parse_bridge_result(value)
        }
        fn clear_token(&self, token: &str) -> Result<(), PlatformAuthError> {
            let handle = self.handle.clone();
            let token = token.to_owned();
            let value = wait_for_bridge(
                move || {
                    handle.run_mobile_plugin::<serde_json::Value>(
                        "clearToken",
                        serde_json::json!({"token": token}),
                    )
                },
                None,
                TIMEOUT,
            )?
            .map_err(|_| PlatformAuthError::Failed)?;
            parse_bridge_result::<bool>(value).map(|_| ())
        }
    }
    /// Blocking Keystore bridge; never call on the main thread. TokenlessSecrets ensures it never sees a token.
    pub(crate) struct AndroidKeystoreSecrets {
        handle: Handle,
    }
    impl AndroidKeystoreSecrets {
        fn call<T: DeserializeOwned>(
            &self,
            command: &'static str,
            payload: serde_json::Value,
        ) -> Result<T, MailError> {
            let handle = self.handle.clone();
            let value = wait_for_bridge(
                move || handle.run_mobile_plugin::<serde_json::Value>(command, payload),
                None,
                TIMEOUT,
            )
            .map_err(|_| MailError::SecretsUnavailable)?
            .map_err(|_| MailError::SecretsUnavailable)?;
            parse_bridge_result(value).map_err(|_| MailError::SecretsUnavailable)
        }
    }
    impl Secrets for AndroidKeystoreSecrets {
        fn load(&self) -> Result<Option<TokenBundle>, MailError> {
            let json: Option<String> = self.call("keystoreLoad", serde_json::json!({}))?;
            json.map(|s| serde_json::from_str(&s).map_err(|_| MailError::SecretsUnavailable))
                .transpose()
        }
        fn store(&self, bundle: &TokenBundle) -> Result<(), MailError> {
            debug_assert!(bundle.access_token.is_empty() && bundle.refresh_token.is_none());
            let json = serde_json::to_string(bundle).map_err(|_| MailError::SecretsUnavailable)?;
            let _: bool = self.call("keystoreStore", serde_json::json!({"json": json}))?;
            Ok(())
        }
        fn clear(&self) -> Result<(), MailError> {
            let _: bool = self.call("keystoreClear", serde_json::json!({}))?;
            Ok(())
        }
    }
    /// Construct credentials from the registered plugin; setup wiring follows in the next stage.
    #[allow(dead_code)]
    pub(crate) fn platform_credentials(
        app: &tauri::AppHandle,
    ) -> Option<(Arc<dyn PlatformAuthorizer>, Arc<dyn Secrets>)> {
        let handle = app.try_state::<GoogleAuthHandle>()?.0.clone();
        Some((
            Arc::new(AndroidPlatformAuthorizer {
                handle: handle.clone(),
            }),
            Arc::new(TokenlessSecrets::new(Arc::new(AndroidKeystoreSecrets {
                handle,
            }))),
        ))
    }
}
#[cfg(target_os = "android")]
#[allow(unused_imports)] // Setup will use this in the next stage.
pub(crate) use android::platform_credentials;
#[cfg(target_os = "android")]
pub(crate) use android::plugin;

#[cfg(test)]
mod tests {
    use super::*;
    use mail_core::gmail::platform_auth::PlatformGrant;
    use serde_json::json;
    #[test]
    fn parse_bridge_results() {
        let grant: PlatformGrant = parse_bridge_result(json!({"ok":{"accessToken":"synthetic","grantedScopes":[],"email":null,"expiresAtEpochMs":null}})).unwrap();
        assert_eq!(grant.access_token, "synthetic");
        assert_eq!(
            parse_bridge_result::<Option<String>>(json!({"ok":null})).unwrap(),
            None
        );
        for (tag, expected) in [
            ("cancelled", PlatformAuthError::Cancelled),
            (
                "needsUserInteraction",
                PlatformAuthError::NeedsUserInteraction,
            ),
            ("developerError", PlatformAuthError::DeveloperError),
            (
                "playServicesUnavailable",
                PlatformAuthError::PlayServicesUnavailable,
            ),
            ("unsupported", PlatformAuthError::Unsupported),
            ("network", PlatformAuthError::Network),
            ("failed", PlatformAuthError::Failed),
            ("unknown", PlatformAuthError::Failed),
        ] {
            assert_eq!(
                parse_bridge_result::<bool>(json!({"error":tag})),
                Err(expected)
            );
        }
        for value in [
            json!({}),
            json!({"ok": 1}),
            json!({"error": 1}),
            json!(null),
        ] {
            assert_eq!(
                parse_bridge_result::<bool>(value),
                Err(PlatformAuthError::Failed)
            );
        }
    }
    #[test]
    fn bridge_wait_result_cancel_timeout() {
        assert_eq!(wait_for_bridge(|| 7, None, Duration::from_secs(1)), Ok(7));
        let cancel = CancelToken::default();
        let other = cancel.clone();
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            other.cancel();
        });
        assert_eq!(
            wait_for_bridge(
                || std::thread::sleep(Duration::from_secs(1)),
                Some(&cancel),
                Duration::from_secs(2)
            ),
            Err(PlatformAuthError::Cancelled)
        );
        assert_eq!(
            wait_for_bridge(
                || std::thread::sleep(Duration::from_secs(1)),
                None,
                Duration::from_millis(20)
            ),
            Err(PlatformAuthError::Failed)
        );
    }
}
