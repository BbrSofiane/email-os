# ADR 0005: Google sign-in and Gmail on Android

**Status:** Proposed (revised after coordinator review) — track B of the "usable Android app" programme. Nothing here is implemented. Implementation starts only after the coordinator's GREENLIGHT.

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
- **Android shell.** The application id is `dev.exedev.emailos.androidfixture` (`src-tauri/gen/android/app/build.gradle.kts`, `src-tauri/tauri.android.conf.json`). Track A's ADR 0004 proposes renaming it to `dev.exedev.emailos`, pending owner approval. It also moves the Kotlin sources out of `.../androidfixture/` and turns backups off. The manifest asks only for `INTERNET` (`src-tauri/gen/android/app/src/main/AndroidManifest.xml`). `MainActivity.kt` handles insets and Back. The shell uses no Tauri plugins. The `main-window` capability says "No plugins, no shell, no broad capability grants" (`src-tauri/capabilities/main-window.json`).
- **Emulator.** `emulator-5554` runs a Google Play image (`sdk_gphone64_x86_64`). It has the Play Store (`com.android.vending`) and Google Play services (`com.google.android.gms`) version 24.23.35, which is from about June 2024. These facts were checked by the coordinator on the running device. The `t3-pixel` AVD config on disk says `google_apis`; the running device is what counts. See the Play services risk below.

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

  `clearToken` and `revokeAccess` are newer than `authorize` (library 21.4.0, July 2025; see Risks). If the device's Play services does not implement them, they fail with an `ApiException`, and the bridge reports `unsupported`:
  - Rust then drops its in-memory token and calls `authorize` silently. If that call returns the same rejected token, the result is `AuthRequired`.
  - Disconnect stays local, which it is anyway (section 3).
  
  Neither call failing ever blocks a disconnect.
- **When UI is needed:** with `interactive = true`, the bridge launches the `PendingIntent` from `MainActivity` and resolves when the activity result arrives. Back or dismissing the sheet resolves `cancelled`, which maps to `AuthCancelled`. The existing 180 s `AUTH_TIMEOUT` and `CancelToken` still bound the wait on the Rust side. Silent calls (`interactive = false`) never show UI. If UI would be needed, they return `needsUserInteraction`, which maps to `AuthRequired` (**Sign-in expired** → **Sign in again**).
- **Account pinning:** when an account is already bound, the request pins it with `setAccount` so Play services does not offer a different account. The existing check still runs: `fetch_profile` must return the bound account, otherwise `AuthFailed` (`provider/api.rs:99-104`, `:250-262`).
- **What Rust reuses:** everything above the access token. That is `LiveGmailProvider`'s HTTP client, pacing, status and quota handling, account binding and credential-publication fences, `fetch_profile`, the scope verification, the sync worker, the operation ledger and the drafts. What is **not** used on Android is `authorize`, `wait_for_code`, `exchange_code` and `refresh` (`auth.rs:192-430`). They move behind a `CredentialSource` seam in `mail-core`:
  - `LoopbackPkceSource` is today's code, unchanged in behaviour, used on desktop.
  - `PlatformAuthorizerSource` sits over a small `PlatformAuthorizer` trait (`authorize`, `clear_token`, `revoke`). On Android its implementation is the bridge. In tests it is a scripted fake, so the whole Android path is tested on Linux.
- **Token lifetime on Android:** the access token lives only in process memory with its expiry. Before expiry, and after a 401, the source clears the cached token (`clearToken`) and calls `authorize(interactive = false)` **once**. A second failure is `AuthRequired`. No refresh token exists on the phone.

### 2. Token storage on Android

- `AndroidKeystoreSecrets` implements `Secrets`. It stores the serialized `TokenBundle` encrypted with an AES-256-GCM Keystore key (alias `email-os-gmail-binding`, no user authentication required, so sync can run while the app is open and unlocked). The file is in `noBackupFilesDir`. Under option C the bundle holds **no token material**: only the account id, the address and the granted scopes (section 4). The token fields stay in the type for desktop. On Android they are always empty, and a test asserts the stored JSON has no token.
- **No plaintext fallback.** A missing key, a failed decryption, a corrupt file or a Keystore error all return `SecretsUnavailable`, shown as today. **Disconnect** (`clear`) deletes the file and the key; it is the documented way to recover from a broken store. The fixture never touches it.
- **Backup and reinstall.** Track A (ADR 0004) sets `android:allowBackup="false"` with exclusion rules. B relies on that and does not change backup settings itself. B keeps the binding file in `noBackupFilesDir`, so it stays out of any backup even if A's rules change later. Keystore keys are never backed up, so a restored ciphertext could not be decrypted anyway. An uninstall deletes app data and the Keystore key. A reinstall starts at the first-run screen and needs **Connect Gmail** again. Google still remembers the grant, so the consent screen may be skipped; the account chooser can still appear.
- `KeychainSecrets` keeps failing closed on Linux and Windows. Desktop is unchanged.

### 3. Mode selection, first run and what the fixture becomes

- **Mode file (Android only).** `<app_data_dir>/mode.json` holds `{"mode":"fixture"|"gmail"}`. It is written atomically (temp file + rename + fsync). Desktop keeps `EMAIL_OS_MODE` and ignores the file. On Android, `EMAIL_OS_MODE` stays ignored.
- **Session swap.** `AppState` holds the per-profile parts (core, draft service, subscription) as one `Session` behind a lock, replaced as a unit. Two new commands are added to `main-window`, the generated types and the manifest tests:
  - `get_mode_choice` returns `{chosen: bool, mode}`.
  - `switch_mode(mode)` stops the current core (releasing its `profile.lock`), opens the other profile, writes `mode.json`, swaps the session and emits `mode_changed`.
  
  The frontend reloads the window when `mode_changed` arrives. A command already running against the old core finishes against a stopped core and gets a typed error. Its result is discarded by the reload. The two profiles stay in separate directories (`fixture-profile`, `gmail-profile`) as on desktop, so a swap never mixes data.
- **A draft open during a switch.** A switch is an account transition, so it follows the same rule as **Connect Gmail** and **Disconnect** today (`src/App.vue:1359-1377`):
  - The frontend sets `drafts.setTransitioning(true)` and calls `drafts.flushAndClose()`. It sends `switch_mode` only if that returns true, which means the latest edit is saved and the editor is closed.
  - If the flush fails (save error, conflict, recovery required), the switch is **not sent**. The editor stays open with its error, and the Account row stays where it was.
  - While a transition runs, the switch rows are disabled.
  
  The backend has its own guard, in case a draft save races the switch from a second surface:
  - `switch_mode` takes the draft service's lifecycle lock.
  - It advances the session epoch, as connect and disconnect already do (`crates/mail-core/src/drafts/service.rs:26-43`).
  - Only then does it stop the old core.
  
  A save that reaches the old session afterwards is rejected with a typed error and never written into the other profile. Drafts are account-scoped, so a fixture-account draft cannot be saved under the Gmail account either. After the reload the draft is in the Drafts list of the profile it was written in, and reappears when the user switches back.
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
- **"Already covered" needs no consent.** Each `GmailGrant` has a fixed set of stored scopes that **cover** it:
  - `Readonly` is covered by `gmail.readonly` or `gmail.modify`.
  - `Modify` is covered by `gmail.modify`.
  
  `request_grant` first checks the bound account's stored `granted_scopes`. If they cover the grant, it returns `GrantOutcome::AlreadyCovered` **without calling the authorizer**: no browser, no Play services sheet, no network. Otherwise it runs the consent flow and returns `GrantOutcome::Granted`, or the existing typed errors (`AuthCancelled`, `PermissionRequired`, `AuthFailed`, `AuthRequired`). `GmailProvider::grant_covered(grant) -> bool` answers the same question for admission checks and UI without side effects. Tests assert, with the scripted fake on Android and the loopback fake on desktop, that a covered request makes **zero** authorizer calls.
- **Read-only first, modify as an explicit upgrade:** unchanged on both platforms.
- **For track D:** D adds `GmailGrant::Send`, covered by `gmail.send` **or** `gmail.modify`. Google's `gmail.modify` already authorizes sending, so an account with modify gets `AlreadyCovered` and sees no consent screen. Only an account without modify is asked for `gmail.send`. D owns the IPC command, the consent copy, the UI entry point and the send admission check that call `request_grant(Send)` and `grant_covered(Send)`. B adds no send scope, no send UI and no call site.

### 5. Network and background behaviour

- **App open and in the foreground:** today's worker. The first sync runs after connect. Periodic sync runs every 60 s, with backoff up to 600 s. Manual **Sync now** works. Queued writes run as they do on desktop.
- **App in the background:** on window `Suspended` (Tauri 2.11, from `onPause`), the shell tells the core to **pause periodic sync**. A new `GmailCore::set_foreground(bool)` stops scheduling new periodic passes. It does not cancel a pass or a write already in flight. On `Resumed` (from `onResume`) the core resumes and runs one pass at once. A write in flight when Android freezes or kills the process is handled as on desktop after a crash. At the next start, globally applying operations become uncertain and are reconciled, never replayed blind.
- **App killed or swiped away:** nothing runs. The next launch restores the session silently. The binding is in Keystore, and the access token comes from a silent `authorize`. Then the first pass syncs.
- **Connectivity:** failures surface as today (**Sync failed · no network** with **Retry**). The bridge also registers a `ConnectivityManager` default-network callback while the app is in the foreground. When a network becomes available it calls `request_sync()` once, so recovery does not wait for the backoff.
- **Battery and data:** no foreground service, no WorkManager, no alarms, no wake locks. The 100-conversation cache cap and the existing pacing bound how much is fetched. There is no special handling for metered networks.
- **Out of scope:** push notifications (Gmail push needs Cloud Pub/Sub and a server, plus FCM), sync or sends while backgrounded or killed, scheduled background work, and notification badges.

### 6. Android-only gates

- **Stay closed:** attachment **export** (`save_attachment` → `UnsupportedPlatform`). Android has no "inert file in Downloads" equivalent without a MediaStore or Storage Access Framework design, and that needs its own decision. Gmail attachment *descriptors* still load through the core, but **Files and links** stays hidden on Android as today.
- **Stay closed in this track:** `open_external_link`. Track C (HTML mail, ADR 0006) owns links in mail bodies on Android. C may reuse this ADR's Rust-only bridge pattern for an `ACTION_VIEW` dispatch, or use its own.
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
- Tests, emulator evidence and doc updates.

Out of scope:

- Sending and the send consent (track D).
- HTML bodies and link behaviour (track C).
- Signing keys, the package name, backup settings, release builds, first-launch ANR and physical-device install (track A).
- Attachment export on Android.
- Push notifications and background sync.
- More than one account.
- Phones without Play services (option B stays available as a later fallback).
- Google OAuth verification and security assessment for public distribution.
- Desktop changes beyond the shared `mail-core` seams (desktop behaviour must not change).

## Owner actions

These are needed before the **owner-account validation** (stage 7). Stages 1 to 6 do not need them. Never paste any of this into a thread, a commit or a screenshot. A client id is not secret, but there is no reason to post it.

### Choosing how the Google app is published

The publishing choice decides whether the phone keeps working week to week. Google documents three relevant setups. Gmail `readonly`, `modify` and `send` are restricted scopes.

| Setup | What Google documents | Effect here |
|---|---|---|
| **External, Testing** | "Authorizations by a test user will expire seven days from the time of consent". The only exception is apps that request nothing beyond name, email and profile, so Gmail scopes get the 7-day rule. At most 100 test users ([Manage app audience](https://support.google.com/cloud/answer/15549945); [OAuth 2.0: refresh token expiration](https://developers.google.com/identity/protocols/oauth2#expiration)). | **Sign-in expired** every week; **Sign in again** shows the consent screen again. Usable for a validation run, not for daily use. |
| **External, In production, not verified** | The app "might display an 'unverified app' screen before it displays the consent screen" ([Unverified apps](https://support.google.com/cloud/answer/7454865)). It is limited to "100 new users in total", over the project's lifetime ([Manage app audience](https://support.google.com/cloud/answer/15549945)). The restricted-scope verification page names personal use as a case where verification may not be needed: "if you are the only user of your app or if your app is used by only a few users, all of whom are known personally to you" ([Restricted scope verification](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)). Google states the 7-day expiry **only** for Testing. It does **not** say whether authorizations last longer for an unverified production app with restricted scopes. The general expiry rules (six months unused; password change for Gmail scopes) still apply. | The owner clicks through the unverified-app screen at each consent. That expected screen is the only ongoing cost. **Unconfirmed:** whether consent survives past 7 days. To check, at least 8 days after consent, kill and relaunch the app; it must sync with no sign-in UI (validation plan). |
| **Personal mode** (user type chosen when the project is created) | "Personal mode apps do not require OAuth app verification, are not subject to the OAuth user cap or 7-day test user token expiration, and do not display the unverified app screen." "Only the Google Account that created the Personal mode application can sign in or authorize scopes for its OAuth clients." It is "a one-time selection when configuring a new application": an existing project cannot switch. Android is listed as a client type ([Manage app audience](https://support.google.com/cloud/answer/15549945); [Personal mode onboarding](https://support.google.com/cloud/answer/15544987#personal-mode-onboarding)). These pages do not list scope restrictions, and they do not say explicitly that restricted Gmail scopes are allowed. Workspace accounts "might still require configuration by your organization's administrators". | Fits a one-person app exactly: no weekly expiry, no unverified screen, no cap. It needs a **new** project, created **by the account whose mail the phone reads**. **To check at setup:** **Data access** accepts the Gmail scopes, and the first Connect shows no unverified-app screen. |

**Recommendation:** **Personal mode**, in a new project created by the Google account the owner will read on the phone. If it does not accept the Gmail scopes, or is not offered for that account, use **External, In production, not verified**. Keep the "unverified app" screen at consent, and confirm the 8-day check before relying on it. **Testing** is only for a throwaway validation account. Because a Personal project accepts only its creator, a throwaway emulator account needs its own small project: either its own Personal project created while signed in as that account, or an External Testing project where it is a test user.

### Steps

1. **Create the project.** For Personal mode, open the Personal mode onboarding (Google Cloud console → Google Auth Platform → Overview → personal onboarding, `console.cloud.google.com/auth/overview/personal`) while signed in as the account the phone will read. Otherwise use an External project. Enable **Gmail API** under **APIs & Services → Library**.
2. **Google Auth Platform → Branding:** app name, user support email, developer contact. No logo is needed.
3. **Google Auth Platform → Audience** (External projects only):
   - For daily use, set **Publish app** to **In production**, with no verification submission.
   - For a throwaway validation project, keep **Testing** and add the throwaway account as a **Test user**.
4. **Google Auth Platform → Data access:** add `.../auth/gmail.readonly` and `.../auth/gmail.modify`. Track D adds `.../auth/gmail.send` only for accounts without modify. Do not submit for verification.
5. **Google Auth Platform → Clients → Create client → Android:**
   - Package name: the final application id from track A. ADR 0004 proposes `dev.exedev.emailos`. Register the id that is merged, not today's `dev.exedev.emailos.androidfixture`.
   - SHA-1 certificate fingerprint: from track A's signing key (`keytool -list -v -keystore <keystore> -alias <alias>`).
   
   Register **one client per signing key used**: the emulator debug key on this VM (I will post its SHA-1 fingerprint, which is public, when stage 7 starts) and the key of any APK installed on your phone. Leave **Advanced settings → custom URI scheme** off. No Web client, no secret. No client id has to be sent to me or put in the build.
6. **For the emulator run:** sign a throwaway Google account into the emulator yourself through the T3 Device panel (**Settings → Passwords & accounts**, or the account chooser during Connect). I never type, see or store the password. Put a few synthetic messages in that account so the recording contains no real mail. With an account signed in, the emulator's Play Store can update Google Play services if stage 3 finds the installed version too old.
7. **For your phone** (after track A's install path works): confirm it has Google Play services, install the APK signed with a registered key, and run the short checklist in the Validation plan.
8. **Verification and the security assessment** for public distribution are **not** needed and are not requested here.

## Dependencies

- **Track A (ADR 0004, install) lands first.** B's Android work (stage 3 onward) starts from A's merged `main`. That gives B:
  - the renamed application id (proposed `dev.exedev.emailos`, pending owner approval);
  - the moved Kotlin package path (`MainActivity.kt` out of `.../androidfixture/`);
  - `allowBackup="false"` with exclusion rules.
  
  B does **not** repeat or change the backup settings. B adds to A's files only:
  - the `play-services-auth` dependency in `build.gradle.kts`;
  - activity-result forwarding for the consent `PendingIntent` in `MainActivity.kt`;
  - one new Kotlin file (`GoogleAuthBridge.kt`) in A's package path.
  
  B also needs the **signing keys**, whose SHA-1 fingerprints the owner registers, for debug (emulator), CI and phone builds. A package rename after registration means a new Android client. Stages 1 and 2 are Rust-only and do not wait for A. A's first-launch ANR fix matters too: B never runs a silent `authorize` on the main thread.
- **Track C (ADR 0006, HTML reader)** owns links in mail bodies on Android. C may reuse this ADR's Rust-only bridge pattern for `ACTION_VIEW`, or use its own. B does not build link dispatch.
- **Track D (ADR 0007, send)** builds on `GmailGrant`, `request_grant` and `grant_covered` (section 4). D adds `Send`, covered by `gmail.send` or `gmail.modify`, and requests `gmail.send` only when the account has no modify grant. If D lands first with its own mechanism, the coordinator decides which one rebases. B and D must not each add a separate scope-upgrade path. D also needs Android Gmail mode from B to send on Android.
- **From B to others:** the `CredentialSource` seam, the granted-scope set, the Android mode switch, and the Kotlin bridge as the one Rust-only native bridge that no webview capability can reach.

## Implementation plan

Each stage is one sub-agent run in this worktree. Each must pass its check, then the shared gate `CARGO_BUILD_JOBS=2 mise run check`. Stages run in order.

1. **Granted-scope set.** Add `TokenBundle.granted_scopes` with legacy read-through. Add `GmailGrant { Readonly, Modify }` and `request_grant`; `enable_mutations` delegates to it. Add `GrantOutcome { AlreadyCovered, Granted }` and `grant_covered`. Desktop requests add `include_granted_scopes=true`. *Check:* new `mail-core` tests:
   - a legacy bundle reads as the modify set;
   - a grant counts only when returned;
   - an omitted scope keeps prior grants, as today;
   - an unknown extra scope in the response does not grant `Modify`;
   - a covered request (for example `Readonly` with modify stored) returns `AlreadyCovered` and the fake authorizer records zero calls.
   
   Existing `gmail::provider` tests are unchanged and pass.
2. **Credential seam.** Extract `CredentialSource` from `LiveGmailProvider`: `access_token`, `authorize(scopes, account, interactive)`, `invalidate(token)`, `revoke`. `LoopbackPkceSource` wraps today's `auth.rs`, with identical behaviour. Add `PlatformAuthorizerSource` over the `PlatformAuthorizer` trait and a scripted fake covering granted, missing modify, cancelled, needs-interaction, developer error, Play services missing, wrong account, network, and 401 → one silent retry → `AuthRequired`. *Check:* all existing provider and auth tests pass untouched; the new fake-driven tests pass; `cargo clippy` is clean.
3. **Android bridge and Keystore secrets** (after track A is merged; based on A's package path and manifest). Add the Kotlin `GoogleAuthBridge`:
   - Authorization API, with the `PendingIntent` launched through `MainActivity`;
   - `clearToken` and `revokeAccess`, reporting `unsupported` when the device's Play services lacks them;
   - Keystore AES-GCM file in `noBackupFilesDir`;
   - connectivity callback.
   
   Add the Rust `#[cfg(target_os = "android")]` `AndroidPlatformAuthorizer` and `AndroidKeystoreSecrets` over `run_mobile_plugin`, and the `play-services-auth` dependency. No mode change yet: Android still opens fixture. **First step of the stage:** a debug-only probe records, on the emulator, whether Play services 24.23.35 accepts `authorize`, `clearToken` and `revokeAccess`. Before an Android client is registered, `authorize` is expected to reach Google and fail with `DEVELOPER_ERROR`, not "API unavailable". The probe is removed before commit. *Check:*
   - `mise run android:build` succeeds;
   - on the emulator the demo launches unchanged (screenshot);
   - `adb logcat` shows the bridge registered and no errors, and the probe results are written into the stage report;
   - `manifest_tests` still pass with no new webview permission.
4. **Mode file and session swap.** Add `mode.json`, `Session` in `AppState`, `get_mode_choice` and `switch_mode` (commands, capability, generated types, manifest tests). Android setup opens the chosen profile: Gmail uses `LiveGmailProvider` with `PlatformAuthorizerSource` and `AndroidKeystoreSecrets`. *Check:* `src-tauri` tests on Linux, using the fake authorizer and `MemorySecrets`, cover:
   - fixture → gmail → fixture swaps;
   - the profile lock is released;
   - drafts stay per profile;
   - the mode file survives restart;
   - a corrupt or unknown mode file falls back to the choice screen, never to Gmail;
   - a draft save that races `switch_mode` lands in the old profile before the swap, or is rejected after it, and never lands in the other profile.
   
   Also `mise run test:native` and `mise run check:contract` pass.
5. **Frontend.** Add the first-run choice in `StartupRoot`, the compact Account rows (**Use your own mail** / **Switch to demo mailbox**), the demo label, the phone sign-in wait copy, the reload on `mode_changed`, and the `androidShell` rename. Add the browser-fake support for the choice. The switch goes through `flushAndClose` as described in section 3. *Check:* vitest unit tests for:
   - the gate and the rows;
   - a dirty editor is saved before `switch_mode` is sent;
   - a failed save keeps the editor open with its error and sends no `switch_mode`.
   
   Also the rendered compact tests, and `mise run screenshots:mobile` with the new states (choice screen, Not connected, signing in, Sign-in expired, read-only Gmail inbox, Enable mailbox actions) in the synthetic fake.
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
  - a draft typed in the demo, then **Use your own mail** pressed with the editor open: the draft is saved first, then the switch happens, and the draft is back in the demo's Drafts after switching back (screenshots);
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
- **Lasting sign-in:** at least 8 days after the owner's first consent on the phone, in the project set up for daily use (Personal mode, or In production unverified), kill and relaunch the app. It must sync with no sign-in UI. This is the check for what Google does not document (Owner actions). The owner reports the result.

## Risks and open questions

**Risks**

- **Play services dependency.** Phones without Google Play services cannot connect. If that matters, option B (custom URI scheme) is the fallback. It relies on a setting Google has deprecated.
- **Emulator Play services version.** The emulator runs Play services 24.23.35 (about June 2024) and has the Play Store.
  - What Google documents: `authorize()` fails "if authorization is not available on the device (for example, internal error or Play Services not available)", and unsupported calls "fail with an ApiException" ([AuthorizationClient reference](https://developers.google.com/android/reference/com/google/android/gms/auth/api/identity/AuthorizationClient); [Play services release notes](https://developers.google.com/android/guides/releases)). `clearToken` and `revokeAccess` were added in play-services-auth **21.4.0 (July 2025)**. I found no documented minimum Play services APK version for any of these calls.
  - Inferred, not documented: `authorize()` predates the 21.x library releases, so 24.23.35 very likely supports it. Then the emulator can run the real flow with a throwaway Google account. `clearToken` and `revokeAccess` may be missing from a June 2024 Play services.
  - Handling: stage 3's probe records what the emulator supports. The bridge treats missing `clearToken`/`revokeAccess` as `unsupported` and degrades as described in section 1. With a throwaway account signed in, the Play Store can update Play services; an update changes the emulator, so it needs the coordinator's agreement. The owner's phone, with current Play services, is the final check either way.
- **Bridge mechanics.** A blocking `run_mobile_plugin` call that waits on an activity result must not deadlock with the main thread, and the `PendingIntent` result must reach the bridge after a configuration change. Stage 3 proves this before anything depends on it.
- **Consent lifetime.** Testing expires every 7 days (documented). Personal mode documents no 7-day expiry, but its pages do not say explicitly that restricted Gmail scopes are allowed. Unverified production has no documented 7-day rule but no positive statement either. The 8-day check in the validation plan settles it for the chosen setup.
- **Process freeze in background.** Android may freeze or kill the process during a write. This relies on the existing outcome-unknown reconciliation; no new guarantee is claimed.
- **Package rename by track A** after the Android client is registered means a new client. Register only after A's rename is merged.

**Open questions for the owner**

1. Is depending on **Google Play services** (option C) acceptable? Does your phone have it? If not, should B build option B instead, accepting the deprecated custom-scheme setting and a refresh token on the phone?
2. **First run:** a choice screen (recommended), or open the demo by default with **Use your own mail** only in Account?
3. **Disconnect:** local only, as on desktop (recommended), or also revoke the app's access at Google from the phone?
4. *(Resolved by the coordinator: backup settings are track A's, ADR 0004.)*
5. *(Resolved by the coordinator: links in bodies are track C's; `open_external_link` stays closed in B.)*
6. Which **Google account** will be used on the emulator? A throwaway one is recommended, holding only synthetic mail. Will you sign it in yourself through the Device panel when stage 7 starts?
7. **Google Cloud project setup:** a new **Personal mode** project created by the account the phone will read (recommended; see Owner actions), or an External project published **In production** without verification? A Personal project cannot be the existing desktop project, because existing projects cannot switch to Personal. Desktop can keep its current project, or add a Desktop client in the new one later.
