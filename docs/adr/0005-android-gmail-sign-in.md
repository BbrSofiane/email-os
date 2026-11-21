# ADR 0005: Google sign-in and Gmail on Android

**Status:** Proposed — track B of the "usable Android app" programme. Nothing here is implemented. Implementation starts only after the coordinator's GREENLIGHT.

## Context

The Android build is a fixture-only app. One person should be able to use it with their own Gmail account. This ADR decides how the phone signs in, where it keeps credentials, how the user moves between the demo mailbox and Gmail, and what runs when.

What exists today:

- **Mode is fixed on Android.** `src-tauri/src/setup.rs:41-42` sets `#[cfg(mobile)] let mode = "fixture"`. Desktop reads `EMAIL_OS_MODE` (`setup.rs:43-49`) and opens `gmail-profile` with `LiveGmailProvider::from_env(Arc::new(KeychainSecrets::new()))` (`setup.rs:53-58`). The choice is made once, at setup. `AppState` holds one `GmailCore` and one `DraftService` for the life of the process (`src-tauri/src/state.rs:8-14`). Nothing can swap them at runtime.
- **OAuth is the desktop loopback flow.** `crates/mail-core/src/gmail/auth.rs:192` `authorize` makes a PKCE verifier, challenge and state (`auth.rs:177`). It binds `127.0.0.1:0` and opens the URL with the `webbrowser` crate (`auth.rs:144`). It then waits up to `AUTH_TIMEOUT` = 180 s for the exact callback path and state (`auth.rs:239`). `exchange_code` (`auth.rs:382`) and `refresh` (`auth.rs:404`) talk to the token endpoint. The client id comes from `EMAIL_OS_GOOGLE_CLIENT_ID` in the launch environment (`GoogleConfig::from_env`, `auth.rs:70`). If it is missing, the app reports a visible `not_configured`. A phone has no launch environment.
- **Scopes.** The first connection asks only for `gmail.readonly` (`auth.rs:27`, `provider/api.rs:206-226`). **Enable mailbox actions** asks for `gmail.modify` (`provider/api.rs:72-95`). The grant is stored as a single boolean, `TokenBundle.gmail_modify_granted` (`secrets.rs:30`). It becomes true only when the token response lists the modify scope (`provider.rs:585`). It is bound to the account that first connected (`provider/api.rs:99-104`). The upgrade request does not set `include_granted_scopes`, so a third scope has nowhere to go.
- **Token custody.** The `Secrets` trait (`secrets.rs:54-61`) has one production implementation, `KeychainSecrets`, which uses the macOS Keychain. On every other platform, Android included, it returns `SecretsUnavailable` (`secrets.rs:119-132`). There is no plaintext fallback, by design. `LiveGmailProvider::access_token` (`provider.rs:221`) loads the bundle and refreshes it with the stored refresh token (`provider.rs:262`). Credential publication is fenced so a disconnect or account change during OAuth cannot be overwritten (`provider.rs:76-92`, `provider/api.rs:110-130`).
- **Disconnect** clears the secret (`provider/api.rs:314-324`) and the core clears the Gmail cache. Drafts stay on the device. Google's grant is not revoked (`docs/development.md`, "Google Desktop OAuth setup").
- **Sync** runs while the process runs. The worker repeats every 60 s (`PERIODIC_INTERVAL`, `gmail/sync.rs:37`) and backs off to at most 600 s after failures (`sync.rs:40`). Interrupted writes are never replayed automatically for Gmail. Reads are paced 100 ms apart (`provider.rs:42`). HTTP goes through `reqwest` with rustls (`crates/mail-core/Cargo.toml:20`), which compiles for Android today.
- **Android-only gates.** `save_attachment` and `open_external_link` return `UnsupportedPlatform` on Android (`src-tauri/src/commands/attachments.rs:29-33`, `:62-66`). The reader hides **Files and links** when `androidFixture` is set (`src/App.vue:95`, `:907`; `src/components/ReaderView.vue:76-77`, `:973`).
- **Android shell.** The application id is `dev.exedev.emailos.androidfixture` (`src-tauri/gen/android/app/build.gradle.kts`, `src-tauri/tauri.android.conf.json`). The manifest asks only for `INTERNET` and does not say whether backups are allowed (`src-tauri/gen/android/app/src/main/AndroidManifest.xml`). `MainActivity.kt` handles insets and Back. The shell uses no Tauri plugins. The `main-window` capability says "No plugins, no shell, no broad capability grants" (`src-tauri/capabilities/main-window.json`).
- **Emulator.** The shared `t3-pixel` AVD uses the Android 35 **Google APIs** x86_64 image (`tag.id=google_apis`, `PlayStore.enabled=no`). It has Google Play services but no Play Store, so Play services cannot be updated on it.

[ADR 0001](0001-single-account-desktop-email-client.md) says "No custom Android surface in this build" and limits Gmail to one desktop OS. [ADR 0003](0003-mobile-layout.md) already added the compact phone layout over fixture data. This ADR supersedes the following parts of ADR 0001 for Android only:

- "No custom Android surface in this build": Android becomes a supported Gmail client for **one** account.
- The single-desktop-OS limit on Gmail. It now covers macOS (desktop, unchanged) and Android (this ADR).
- The phrase "custom mobile client" in its non-goals.

Everything else in ADR 0001 still applies on Android: one connected account, read-only first, explicit modify upgrade, no plaintext credentials, no background execution while quit, and its safety gates.

## Options considered

### Sign-in flow and OAuth client type

**A. Reuse the Desktop OAuth client and the loopback flow on the phone.**
The Rust code works almost unchanged. The phone binds `127.0.0.1`, opens Chrome, and receives the redirect on loopback. The client id and secret are compiled in.
- For: almost no new code; the PKCE, exchange and refresh code is reused exactly.
- Against: Google documents the loopback redirect for desktop platforms and has moved Android, iOS and Chrome clients off it. A Desktop client is not bound to the package or signing key, so any app could present the same client id. The flow depends on our process staying alive behind the browser. It also uses a client type for a platform it was not issued for, which Google can block at any time. **Rejected.**

**B. Android OAuth client + Custom Tab + custom URI scheme redirect, with PKCE in Rust.**
The app opens the authorization URL in a Custom Tab. Google redirects to `<applicationId>:/oauth2redirect` (the exact form is to be confirmed against Google's documentation when implemented). `MainActivity` receives the intent and passes the URL to Rust. Rust checks `state` and exchanges the code with the stored PKCE verifier. The refresh token is kept in Android Keystore-backed storage behind `Secrets`.
- For: reuses `generate_pkce`, `exchange_code`, `refresh` and the publication fences. Only the "wait for callback" step changes, from a listener to a channel fed by `onNewIntent`. Works without Google Play services. Only the client id is needed (Android clients have no secret). It is not confidential and can be set at build time through a Gradle property, a `BuildConfig` field and the plugin.
- Against: Google turned custom URI schemes **off by default** for Android clients in 2023. It must be switched on under the client's Advanced settings. Google says it may be removed later and recommends Google Identity Services instead ([Google Developers Blog](https://developers.googleblog.com/en/improving-user-safety-in-oauth-flows-through-new-oauth-custom-uri-scheme-restrictions/)). Any app can register the same scheme; PKCE protects the code, but the consent screen can still be impersonated. A long-lived refresh token sits on the phone. A verified App Link (https redirect) is not available for Android-type clients and would need a domain we control. **Viable fallback; not recommended as the primary path.**

**C. Google Identity Services Authorization API (`AuthorizationClient`, Play services) with an Android OAuth client bound to package name + SHA-1.** *(Recommended)*
A small Kotlin bridge calls `Identity.getAuthorizationClient(context).authorize(AuthorizationRequest)` with the scopes we need. Consent is shown by Play services through a `PendingIntent` that the Activity launches. The result carries an access token and the list of granted scopes. Calling `authorize()` again with the same scopes returns a fresh token without UI while the grant stands. The app never receives a refresh token, and Google's guidance is "Don't store refresh tokens on the device". `revokeAccess()` and `clearToken()` exist. Incremental scopes mean calling `authorize()` again with more scopes ([Android Developers: Authorize access to Google user data](https://developer.android.com/identity/authorization)). Play services matches the package name and signing certificate to the registered Android client, so no client id is written into the build. `requestOfflineAccess` (server auth code plus a Web client) is **not** used: there is no backend.
- For: this is Google's recommended path for Android. Nothing long-lived is stored by the app: a stolen app-data directory has no token. No client id or secret is configured on the phone. Consent, account choice and the unverified-app screen are Google's own system UI. Scope upgrades are native.
- Against: requires Google Play services. Phones without it (for example de-Googled ROMs) cannot connect; they keep the demo mailbox. Adds a Kotlin dependency (`com.google.android.gms:play-services-auth`) and a Rust-to-Kotlin bridge that blocks a worker thread while waiting for a result. The Rust PKCE, exchange and refresh functions are not used on Android, so the provider needs a seam where the access token comes from. The emulator's Play services cannot be updated (risk below).

### Token storage

- **Keystore-encrypted file behind `Secrets`** (AES-256-GCM key generated in Android Keystore, not exportable; ciphertext in the app's `no_backup` directory; encrypt and decrypt in Kotlin, called from Rust through the bridge). *(Recommended)*
- **Jetpack `EncryptedSharedPreferences`.** Deprecated by AndroidX (security-crypto 1.1.0); not chosen.
- **Plain app-private file.** Rejected: plaintext violates the no-plaintext-fallback rule even inside the app sandbox.

### Mode selection

- **Persisted mode choice + in-process session swap + webview reload.** *(Recommended)* The choice lives in a small file in app data. Switching stops the current core, opens the other profile, replaces the session in `AppState`, writes the file, and reloads the page so every composable starts clean.
- **Persisted mode choice + process restart.** Simpler on the Rust side, but restarting the process from inside an Android app is not reliable (Tauri `restart` relaunches through `exit`). It also looks like a crash to the user.
- **Keep both cores open and route by mode.** Doubles workers, locks and draft services. It also invites cross-profile mistakes that ADR 0001's UX-13 section warns about. Rejected.

## Decision (proposed)

### 1. Sign-in: option C, the Authorization API

- **OAuth client:** one **Android** client in the owner's Google Cloud project for each (package name, SHA-1) pair the app is signed with. The package name and the release/debug signing keys come from track A (ADR 0004). No Web client and no client secret. The custom URI scheme toggle stays **off**.
- **No client id in the build.** Play services matches package + signature. "Configured" therefore cannot be known before the first call. A `DEVELOPER_ERROR` result (package/SHA-1 not registered) maps to `not_configured`, with a next step that says this build is not registered. "Play services missing or too old" maps to `unsupported_platform` on connect. The account status says so plainly; it is not shown as an expired sign-in.
- **Bridge:** a Kotlin class in the Android app (`GoogleAuthBridge`), registered as an Android plugin from Rust with `tauri::plugin::Builder` and `register_android_plugin`. Rust calls it with `PluginHandle::run_mobile_plugin` from worker threads, never from the main thread. **The webview cannot call it:** no plugin permission is added to `main-window`, and tokens never cross IPC. Operations:
  - `authorize(scopes, account?, interactive)` returns `{accessToken, grantedScopes, email}`, or one of `cancelled`, `needsUserInteraction`, `developerError`, `playServicesUnavailable`, `network` or `failed`.
  - `clearToken(token)`.
  - `revokeAccess(account, scopes)`.
  - `keystoreLoad`, `keystoreStore`, `keystoreClear` (section 2).
- **When UI is needed:** with `interactive = true`, the bridge launches the `PendingIntent` from `MainActivity` and resolves when the activity result arrives. Back or dismissing the sheet resolves `cancelled`, which maps to `AuthCancelled`. The existing 180 s `AUTH_TIMEOUT` and `CancelToken` still bound the wait on the Rust side. Silent calls (`interactive = false`) never show UI. If UI would be needed, they return `needsUserInteraction`, which maps to `AuthRequired` (**Sign-in expired** → **Sign in again**).
- **Account pinning:** when an account is already bound, the request pins it with `setAccount` so Play services does not offer a different account. The existing check still runs: `fetch_profile` must return the bound account, otherwise `AuthFailed` (`provider/api.rs:99-104`, `:250-262`).
- **What Rust reuses:** everything above the access token. That is `LiveGmailProvider`'s HTTP client, pacing, status and quota handling, account binding and credential-publication fences, `fetch_profile`, the scope verification, the sync worker, the operation ledger and the drafts. What is **not** used on Android is `authorize`, `wait_for_code`, `exchange_code` and `refresh` (`auth.rs:192-430`). They move behind a `CredentialSource` seam in `mail-core`:
  - `LoopbackPkceSource` is today's code, unchanged in behaviour, used on desktop.
  - `PlatformAuthorizerSource` sits over a small `PlatformAuthorizer` trait (`authorize`, `clear_token`, `revoke`). On Android its implementation is the bridge. In tests it is a scripted fake, so the whole Android path is tested on Linux.
- **Token lifetime on Android:** the access token lives only in process memory with its expiry. Before expiry, and after a 401, the source clears the cached token (`clearToken`) and calls `authorize(interactive = false)` **once**. A second failure is `AuthRequired`. No refresh token exists on the phone.

### 2. Token storage on Android

- `AndroidKeystoreSecrets` implements `Secrets`. It stores the serialized `TokenBundle` encrypted with an AES-256-GCM Keystore key (alias `email-os-gmail-binding`, no user authentication required, so sync can run while the app is open and unlocked). The file is in `noBackupFilesDir`. Under option C the bundle holds **no token material**: only the account id, the address and the granted scopes (section 4). The token fields stay in the type for desktop. On Android they are always empty, and a test asserts the stored JSON has no token.
- **No plaintext fallback.** A missing key, a failed decryption, a corrupt file or a Keystore error all return `SecretsUnavailable`, shown as today. **Disconnect** (`clear`) deletes the file and the key; it is the documented way to recover from a broken store. The fixture never touches it.
- **Backup and reinstall.** The manifest sets `android:allowBackup="false"`, plus `android:dataExtractionRules` and `android:fullBackupContent` that exclude everything. Keystore keys are never backed up, so a restored ciphertext could not be decrypted anyway. This also means local drafts and the demo mailbox are not backed up or moved to a new phone. That is consistent with "drafts are local to this device", but it is a visible change (owner question 4). An uninstall deletes app data and the Keystore key. A reinstall starts at the first-run screen and needs **Connect Gmail** again. Google still remembers the grant, so the consent screen may be skipped; the account chooser can still appear.
- `KeychainSecrets` keeps failing closed on Linux and Windows. Desktop is unchanged.

### 3. Mode selection, first run and what the fixture becomes

- **Mode file (Android only).** `<app_data_dir>/mode.json` holds `{"mode":"fixture"|"gmail"}`. It is written atomically (temp file + rename + fsync). Desktop keeps `EMAIL_OS_MODE` and ignores the file. On Android, `EMAIL_OS_MODE` stays ignored.
- **Session swap.** `AppState` holds the per-profile parts (core, draft service, subscription) as one `Session` behind a lock, replaced as a unit. Two new commands are added to `main-window`, the generated types and the manifest tests:
  - `get_mode_choice` returns `{chosen: bool, mode}`.
  - `switch_mode(mode)` stops the current core (releasing its `profile.lock`), opens the other profile, writes `mode.json`, swaps the session and emits `mode_changed`.
  
  The frontend reloads the window when `mode_changed` arrives. A command already running against the old core finishes against a stopped core and gets a typed error. Its result is discarded by the reload. The two profiles stay in separate directories (`fixture-profile`, `gmail-profile`) as on desktop, so a swap never mixes data.
- **First run.** If `mode.json` is absent, setup opens the fixture core as today, and `StartupRoot` shows a **choice screen** before any mailbox. The screen offers connecting your own mail account or opening the demo mailbox, and says that the demo is synthetic and nothing in it is sent anywhere. It follows the existing `FixtureTransitionGate` pattern. The legacy fixture transition gate, if pending, comes first. Choosing the demo writes `mode.json`. Choosing your own mail switches to Gmail mode, which shows **Not connected** with **Connect Gmail**, and starts Connect directly. A phone upgraded from an earlier fixture-only APK has no mode file, so it sees the choice once. Its demo data is kept.
- **Moving between modes.** The compact **Account** page shows in demo mode a **Use your own mail** row (→ `switch_mode("gmail")`), and in Gmail mode a **Switch to demo mailbox** row (→ `switch_mode("fixture")`). Switching to the demo **does not disconnect**: credentials, cache and drafts of the Gmail profile stay, and switching back resumes them. **Disconnect** keeps its desktop meaning: it is local, clears the binding and the Gmail cache, and keeps drafts. On Android it also calls `clearToken`. It does **not** revoke the Google grant unless the owner chooses that (owner question 3). After disconnect the app stays in Gmail mode on **Not connected**, where **Switch to demo mailbox** is available.
- **Phone layout.** The existing compact Account page and status lines (UX-14, development guide "Account, connection and first run") carry the Gmail states. The only copy change is the sign-in wait line: "Finish sign-in in your browser" becomes a phone-appropriate sentence, because the sheet is a system screen on the phone, not a browser. No new third-party brand names are added to UI copy; existing action names (**Connect Gmail**, **Sign in again**, **Enable mailbox actions**) stay as they are on desktop.
- **The fixture becomes the "demo mailbox".** It is the same ADR 0002 synthetic core, unchanged: first-run option, switch-back target, and the validation surface that needs no Google account. In a Gmail-capable build its account line is labelled as the demo so it is never mistaken for real mail. Desktop's default stays fixture.
- `androidFixture` in `App.vue` is renamed to what it means (`androidShell`). The gates in section 6 remain keyed to the platform, not to the mode.

### 4. Scopes and the upgrade mechanism

- **Granted scopes are a set.** `TokenBundle` gains `granted_scopes: Vec<String>` (`#[serde(default)]`). A legacy bundle with `gmail_modify_granted = true` is read as `{readonly, modify}`. The boolean is still written for one release so an older desktop build can read the bundle (desktop Keychain only).
- **Requests go through one function.** `GmailGrant` is a small enum. B ships `Readonly` and `Modify`. A grant maps to one scope string and one admission check. `GmailProvider::request_grant(grant, cancel)` replaces the body of `enable_mutations`. `enable_mutations` stays as the IPC-facing call and now calls `request_grant(Modify)`. A request always asks for the union of the scopes already granted and the new one:
  - desktop adds `include_granted_scopes=true` to the loopback request;
  - Android passes the full list to `authorize`.
  
  A grant counts only if the returned scope list contains it, for the same bound account. Asking is never evidence (`provider/api.rs:241-248` keeps that rule).
- **Read-only first, modify as an explicit upgrade:** unchanged on both platforms.
- **For track D:** D adds `GmailGrant::Send`, which maps to `gmail.send`. D owns the IPC command, the consent copy, the UI entry point and the send admission check that call `request_grant(Send)`. B adds no send scope, no send UI and no call site. Note for D's decision: Google documents `gmail.modify` as broader than this app's actions, and it already authorizes sending. Whether D still asks for a separate `gmail.send` grant is D's decision; the mechanism supports either.

### 5. Network and background behaviour

- **App open and in the foreground:** today's worker. The first sync runs after connect. Periodic sync runs every 60 s, with backoff up to 600 s. Manual **Sync now** works. Queued writes run as they do on desktop.
- **App in the background:** on window `Suspended` (Tauri 2.11, from `onPause`), the shell tells the core to **pause periodic sync**. A new `GmailCore::set_foreground(bool)` stops scheduling new periodic passes. It does not cancel a pass or a write already in flight. On `Resumed` (from `onResume`) the core resumes and runs one pass at once. A write in flight when Android freezes or kills the process is handled as on desktop after a crash. At the next start, globally applying operations become uncertain and are reconciled, never replayed blind.
- **App killed or swiped away:** nothing runs. The next launch restores the session silently. The binding is in Keystore, and the access token comes from a silent `authorize`. Then the first pass syncs.
- **Connectivity:** failures surface as today (**Sync failed · no network** with **Retry**). The bridge also registers a `ConnectivityManager` default-network callback while the app is in the foreground. When a network becomes available it calls `request_sync()` once, so recovery does not wait for the backoff.
- **Battery and data:** no foreground service, no WorkManager, no alarms, no wake locks. The 100-conversation cache cap and the existing pacing bound how much is fetched. There is no special handling for metered networks.
- **Out of scope:** push notifications (Gmail push needs Cloud Pub/Sub and a server, plus FCM), sync or sends while backgrounded or killed, scheduled background work, and notification badges.

### 6. Android-only gates

- **Stay closed:** attachment **export** (`save_attachment` → `UnsupportedPlatform`). Android has no "inert file in Downloads" equivalent without a MediaStore or Storage Access Framework design, and that needs its own decision. Gmail attachment *descriptors* still load through the core, but **Files and links** stays hidden on Android as today.
- **Stay closed in this track:** `open_external_link`. Opening a link from mail on the phone is part of reading mail, and track C (HTML mail, ADR 0006) owns how links in bodies behave. The bridge added here would make an `ACTION_VIEW` dispatch, behind the existing `validated_external_url` check and explicit confirmation, a small change. It is listed under Dependencies, not built here (owner question 5).
- **Open with Gmail on Android:** connect, sign in again, cancel sign-in, enable mailbox actions, sync now, disconnect, provider destinations, provider search and the provider-backed mailbox actions. These are the same commands desktop Gmail mode admits. The core decides by session policy, not by platform.

## Scope

In scope:

- The Android sign-in and token path (option C).
- Keystore-backed `Secrets` on Android.
- The `CredentialSource` and `PlatformAuthorizer` seams in `mail-core`.
- The granted-scope set and `request_grant`.
- The Android mode file, session swap and first-run choice.
- Compact Account rows for switching modes.
- Foreground and background sync pausing, and the connectivity nudge.
- Manifest backup exclusion.
- Tests, emulator evidence and doc updates.

Out of scope:

- Sending and the send consent (track D).
- HTML bodies and link behaviour (track C).
- Signing keys, the package name, release builds, first-launch ANR and physical-device install (track A).
- Attachment export on Android.
- Push notifications and background sync.
- More than one account.
- Phones without Play services (option B stays available as a later fallback).
- Google OAuth verification and security assessment for public distribution.
- Desktop changes beyond the shared `mail-core` seams (desktop behaviour must not change).

## Owner actions

These are needed before the **owner-account validation** (stage 7). Stages 1 to 6 do not need them. Never paste any of this into a thread, a commit or a screenshot. A client id is not secret, but there is no reason to post it.

1. **Choose the Google Cloud project.** Use the existing project that holds the desktop client, or create a new one, and keep it disposable-account friendly. Under **APIs & Services → Library**, make sure **Gmail API** is enabled.
2. **Google Auth Platform → Branding** (OAuth consent screen): app name, user support email, developer contact. No logo is needed in Testing.
3. **Google Auth Platform → Audience:**
   - user type **External**, publishing status **Testing**;
   - add the Google account(s) that will sign in as **Test users**. A disposable account is strongly preferred for the emulator run.
   
   In Testing, a test user's authorization expires 7 days after consent ([Google Cloud help: Manage app audience](https://support.google.com/cloud/answer/15549945)). Expect **Sign-in expired** weekly. Google also shows an "unverified app" screen for these restricted Gmail scopes; continuing past it is expected for a personal Testing app.
4. **Google Auth Platform → Data access:** add `.../auth/gmail.readonly` and `.../auth/gmail.modify`. (Track D will add `.../auth/gmail.send` if it decides to ask for it.)
5. **Google Auth Platform → Clients → Create client → Android:**
   - Package name: the final application id from track A. Today it is `dev.exedev.emailos.androidfixture`. If track A renames it, register the new one.
   - SHA-1 certificate fingerprint: from track A's signing key (`keytool -list -v -keystore <keystore> -alias <alias>`).
   
   Register **one client per signing key used**: the emulator debug key on this VM (I will post its SHA-1 fingerprint, which is public, when stage 7 starts) and the key of any APK installed on your phone. Leave **Advanced settings → custom URI scheme** off. No Web client, no secret. No client id has to be sent to me or put in the build.
6. **For the emulator run:** sign the test account into the emulator yourself through the T3 Device panel (**Settings → Passwords & accounts**, or the account chooser during Connect). I never type, see or store the password. If you prefer, put a few synthetic messages in that account so the recording contains no real mail.
7. **For your phone** (after track A's install path works): confirm it has Google Play services, install the APK signed with a registered key, and run the short checklist in the Validation plan.
8. **Publishing/verification** (moving out of Testing, restricted-scope verification and security assessment) is **not** needed for personal use and is not requested here.

## Dependencies

- **Track A (ADR 0004, install):** B needs the final **application id** and the **signing keys**, whose SHA-1 fingerprints the owner registers, for debug (emulator), CI and release/phone builds. A rename after registration means a new Android client. B also edits `AndroidManifest.xml` (backup flags), `build.gradle.kts` (`play-services-auth` dependency), `MainActivity.kt` (activity-result forwarding for the consent `PendingIntent`) and adds one Kotlin file. A owns those files' packaging concerns, so B asks A to land structural manifest or Gradle changes first, or to coordinate order with the coordinator. Track A's first-launch ANR fix matters here too: a silent `authorize` at startup must not run on the main thread, and B keeps it off the main thread.
- **Track C (ADR 0006, HTML reader):** owns link behaviour in bodies. If C wants links to open on Android, the bridge from this ADR can host an `ACTION_VIEW` call. C decides; B does not build it.
- **Track D (ADR 0007, send):** builds on `GmailGrant` and `request_grant` (section 4) and adds `Send`. If D lands first with its own mechanism, the coordinator decides which one rebases. B and D must not each add a separate scope-upgrade path. D also needs Android Gmail mode from B to send on Android.
- **From B to others:** the `CredentialSource` seam, the granted-scope set, the Android mode switch, and the Kotlin bridge as the one Rust-only native bridge that no webview capability can reach.

## Implementation plan

Each stage is one sub-agent run in this worktree. Each must pass its check, then the shared gate `CARGO_BUILD_JOBS=2 mise run check`. Stages run in order.

1. **Granted-scope set.** Add `TokenBundle.granted_scopes` with legacy read-through. Add `GmailGrant { Readonly, Modify }` and `request_grant`; `enable_mutations` delegates to it. Desktop requests add `include_granted_scopes=true`. *Check:* new `mail-core` tests: legacy bundle → modify set; a grant counts only when returned; omitted scope keeps prior grants as today; an unknown extra scope in the response does not grant `Modify`. Existing `gmail::provider` tests are unchanged and pass.
2. **Credential seam.** Extract `CredentialSource` from `LiveGmailProvider`: `access_token`, `authorize(scopes, account, interactive)`, `invalidate(token)`, `revoke`. `LoopbackPkceSource` wraps today's `auth.rs`, with identical behaviour. Add `PlatformAuthorizerSource` over the `PlatformAuthorizer` trait and a scripted fake covering granted, missing modify, cancelled, needs-interaction, developer error, Play services missing, wrong account, network, and 401 → one silent retry → `AuthRequired`. *Check:* all existing provider and auth tests pass untouched; the new fake-driven tests pass; `cargo clippy` is clean.
3. **Android bridge and Keystore secrets.** Add the Kotlin `GoogleAuthBridge` (Authorization API, `PendingIntent` launch through `MainActivity`, `clearToken`, `revokeAccess`, Keystore AES-GCM file in `noBackupFilesDir`, connectivity callback). Add the Rust `#[cfg(target_os = "android")]` `AndroidPlatformAuthorizer` and `AndroidKeystoreSecrets` over `run_mobile_plugin`. Set the manifest backup exclusion and the `play-services-auth` dependency. No mode change yet: Android still opens fixture. *Check:* `mise run android:build` succeeds. On the emulator the demo launches unchanged (screenshot). `adb logcat` shows the bridge registered and no errors. `manifest_tests` still pass with no new webview permission.
4. **Mode file and session swap.** Add `mode.json`, `Session` in `AppState`, `get_mode_choice` and `switch_mode` (commands, capability, generated types, manifest tests). Android setup opens the chosen profile: Gmail uses `LiveGmailProvider` with `PlatformAuthorizerSource` and `AndroidKeystoreSecrets`. *Check:* `src-tauri` tests on Linux, using the fake authorizer and `MemorySecrets`, cover:
   - fixture → gmail → fixture swaps;
   - the profile lock is released;
   - drafts stay per profile;
   - the mode file survives restart;
   - a corrupt or unknown mode file falls back to the choice screen, never to Gmail.
   
   Also `mise run test:native` and `mise run check:contract` pass.
5. **Frontend.** Add the first-run choice in `StartupRoot`, the compact Account rows (**Use your own mail** / **Switch to demo mailbox**), the demo label, the phone sign-in wait copy, the reload on `mode_changed`, and the `androidShell` rename. Add the browser-fake support for the choice. *Check:* vitest unit tests for the gate and rows, the rendered compact tests, and `mise run screenshots:mobile` with the new states (choice screen, Not connected, signing in, Sign-in expired, read-only Gmail inbox, Enable mailbox actions) in the synthetic fake.
6. **Lifecycle.** Add `GmailCore::set_foreground` and wire `Suspended`/`Resumed` from the shell. The connectivity callback calls `request_sync`. *Check:* `mail-core` tests with the fake clock: no periodic pass is scheduled while backgrounded; an in-flight write is not cancelled; resume runs one pass. A `src-tauri` test that the events reach the core.
7. **Emulator and owner-account validation, then docs.** Run the validation plan below. Update `docs/current-status.md` and `docs/development.md` (Android Gmail section, owner setup). Set this ADR to `Accepted` with the decisions taken. *Check:* the evidence listed below exists and `mise run check:all` passes.

## Validation plan

**Without the owner's Google account** (stages 1–6, done by me):

- Rust: the stage tests above. Every Android-specific outcome is driven through the fake `PlatformAuthorizer`. A test asserts the Android-stored bundle JSON contains no access or refresh token. The existing redaction tests extend to the new types.
- Frontend: unit tests and rendered compact tests. Browser screenshots go under `docs/validation/android-gmail/`: choice screen, demo Account page with **Use your own mail**, Gmail **Not connected**, signing in, **Sign-in expired**, synced read-only inbox (synthetic fake), and the **Enable mailbox actions** row.
- Emulator, with a debug APK whose SHA-1 is not yet registered:
  - first-run choice → demo works (regression smoke: inbox, reader, Mark done + Undo, draft survives a kill);
  - choice → own mail → **Connect Gmail** shows the Google account sheet or a `not_configured` "build not registered" state (screenshot);
  - **Switch to demo mailbox** and back keeps both profiles' files (`run-as` listing);
  - airplane mode on and off in Gmail mode shows the no-network status (the emulator state is restored afterwards).
- Screen recording (≤60 s) of choice → Connect → Google's sheet → cancel → back in the app with **Not connected**. This can be done without an account and is committed if under ~5 MB.

**With the owner's (preferably disposable) Google account** (stage 7, needs owner actions 1–6):

- On the emulator, signed in by the owner:
  - Connect → consent (read-only) → first sync → inbox → open a conversation;
  - **Enable mailbox actions** → second consent → archive and Undo, read/unread and star, checked in Gmail on the web;
  - background → change mail in Gmail on the web → resume → the change appears after the resume pass;
  - kill → relaunch → syncs with no UI;
  - revoke access in the Google account settings → **Sign-in expired** → **Sign in again**;
  - **Disconnect** → **Not connected**, cache gone, drafts kept, Keystore file gone (`run-as` listing only; file contents are never printed).
- A screen recording (≤60 s) of Connect through first sync. It contains the account address and mail, so it is **not committed**. It is kept in `/home/exedev/email-os-usable/android-gmail/` and listed in the PR, unless the account holds only synthetic mail and the owner agrees to commit it.
- On the owner's phone (after track A): install, Connect, sync, Enable mailbox actions, archive + Undo, background/resume. The owner reports the results; no screenshots of real mail are committed.

## Risks and open questions

**Risks**

- **Play services dependency.** Phones without Google Play services cannot connect. If that matters, option B (custom URI scheme) is the fallback. It relies on a setting Google has deprecated.
- **Emulator Play services version.** The `google_apis` image cannot update Play services. If its version is too old for the `AuthorizationClient` API, the emulator cannot run the real sign-in. The fallbacks are a `google_apis_playstore` image (several GB; disk is tight at ~8 GB free) or validating sign-in on the owner's phone only. Stage 3 checks this first.
- **Bridge mechanics.** A blocking `run_mobile_plugin` call that waits on an activity result must not deadlock with the main thread, and the `PendingIntent` result must reach the bridge after a configuration change. Stage 3 proves this before anything depends on it.
- **Testing-mode expiry.** Weekly re-consent is expected while the app stays in Testing.
- **Process freeze in background.** Android may freeze or kill the process during a write. This relies on the existing outcome-unknown reconciliation; no new guarantee is claimed.
- **Package rename by track A** after the Android client is registered means a new client and new app data on the phone.
- **Backups disabled.** Drafts and the demo state no longer move to a new phone through Android backup.

**Open questions for the owner**

1. Is depending on **Google Play services** (option C) acceptable? Does your phone have it? If not, should B build option B instead, accepting the deprecated custom-scheme setting and a refresh token on the phone?
2. **First run:** a choice screen (recommended), or open the demo by default with **Use your own mail** only in Account?
3. **Disconnect:** local only, as on desktop (recommended), or also revoke the app's access at Google from the phone?
4. Is turning **Android backup off** for the whole app acceptable (drafts not backed up)? The alternative is to exclude only the credential file and the Gmail profile.
5. **Links on Android:** keep them closed until track C decides (recommended), or have B add `ACTION_VIEW` dispatch with confirmation?
6. Which **Google account** will be used on the emulator? A disposable one is recommended. Will you sign it in yourself through the Device panel when stage 7 starts?
7. **Same Cloud project** as the desktop client, or a new one for Android?
