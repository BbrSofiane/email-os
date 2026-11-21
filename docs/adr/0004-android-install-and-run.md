# ADR 0004: Install and update Email OS on Android

**Status:** Proposed

## Context

The owner needs to install Email OS on one physical phone and update it in place
while keeping drafts, mailbox state and settings.

- `mise.toml:105–123` builds a bundled debug APK for `aarch64` and `x86_64`
  and provides a separate development run. `.github/workflows/ci.yml:9–50`
  builds and uploads a debug APK on main pushes and PRs. The Android Gradle
  project has no release signing config. Two historical CI debug artifacts had
  different certificates and Android refused the update with
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Local debug builds also use the machine's
  debug key. Uninstall removes the installed app's private data.
  [Android smoke record](../current-status.md#android-unified-fixture-smoke-2026-11-15)
- `src-tauri/tauri.android.conf.json:3` and
  `src-tauri/gen/android/app/build.gradle.kts:19–27` set
  `dev.exedev.emailos.androidfixture` as the app ID. Gradle reads version fields
  from generated `tauri.properties`, with fallbacks `1` and `1.0`. The base
  Tauri version is `0.1.0` (`src-tauri/tauri.conf.json:4`). With no override, the
  pinned Tauri CLI's documented semver calculation gives code `1000` for
  `0.1.0`. Read the actual values from the archived APK before calling those
  values the historical baseline.
  [Pinned Tauri config](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.3.0/crates/tauri-utils/src/config.rs#L2409-L2435)
- Gradle sets min API 24 and target API 35. Release enables R8, and resource
  shrinking is unset (`src-tauri/gen/android/app/build.gradle.kts:20–47`).
  The manifest requests `INTERNET`, uses a per-build cleartext setting, names a
  launcher icon and a non-exported FileProvider, and leaves backup at the
  platform default (`src-tauri/gen/android/app/src/main/AndroidManifest.xml:3–36`).
  Both launcher strings say `email-os`
  (`src-tauri/gen/android/app/src/main/res/values/strings.xml:2–3`).
- The first cold launch after a fresh install crossed Android's reported
  5-second input-dispatch deadline waiting for a focus event. The Inbox rendered
  behind the dialog, the host was under CPU and memory pressure, and relaunch
  worked. The compact-layout check later reported the first-launch issue again.
  There is no physical-phone evidence yet. ADR 0003 covers the compact layout.
  [Android smoke record](../current-status.md#android-unified-fixture-smoke-2026-11-15)

## Options considered

| Option | Trade-off |
| --- | --- |
| Keep debug builds and share one debug keystore | Stabilizes updates once everyone uses it, but leaves a debuggable owner app with debug cleartext policy. Switching to a new release certificate later would require another cutover. An old matching debug key could preserve one particular install, with no general solution for the other signers. |
| Sign release APKs with a new key and keep `androidfixture` | Keeps the current identifier, but existing installs signed by debug keys still require uninstall before installing the release. A later move to a final ID starts a new data sandbox and requires a new Android OAuth registration. |
| Sign release APKs with a new key and adopt a final ID now | Starts a new sandbox once, before OAuth registration and real mail. The old app can stay installed while the owner recovers anything they need. Future releases share the same application ID and certificate. |

For distribution, Actions artifacts reuse the current download path and give a
per-commit build record, with expiration and a ZIP to extract. GitHub Releases
provide a stable page and a direct APK asset, with an additional publishing step
and visibility tied to the repository. Play distribution would add store and
signing setup outside this owner's initial install path.
[Android app signing](https://developer.android.com/studio/publish/app-signing)
and [GitHub artifact downloads](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts).

## Decision

### App identity and signing

Adopt `dev.exedev.emailos` and the launcher and activity label **Email OS** for
Android. Align the Tauri Android identifier, Gradle ID and namespace, Kotlin
package and path, generated JNI/Kotlin paths and ignore rules. The FileProvider
authority follows the application ID. The desktop identifier stays as it is.

Use a non-debuggable release APK, signed by an owner-generated, long-lived
RSA app-signing key in a password-protected JKS. The primary copy lives outside
the repository on the owner's machine. Keep an encrypted offline copy and
the passwords in the owner's password manager. Restore the backup once and
compare its certificate fingerprints before distributing the first APK. Losing
the signing key removes the ordinary in-place update path. A compromised key
allows third parties to sign APKs Android can accept as updates. Plan any
rotation against the supported Android versions and OAuth registration before
changing the signer. [Tauri Android signing](https://v2.tauri.app/distribute/sign/android/).

Gradle's release signing config reads `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`
from the process environment. The local release task uses the same config
with values supplied from the owner's password manager for one invocation.
Debug CI and local development keep ordinary debug signing for test devices.
A release request with missing or invalid key inputs fails before any artifact
is published. Do not install the debug variant over the owner app.

Use a dedicated Actions release workflow for trusted main commits. Trigger it
for an intentional version bump and allow an explicit rerun of the same version.
Restrict the `android-release` environment to main and require owner review
where supported.
Keep key inputs out of PR workflows, unreviewed refs, caches, artifacts and logs.
Decode the base64 JKS into a restricted temporary file on the hosted runner for
the signing step, disable shell tracing and remove the file on exit, including on
failure. The upload step sees only the APK and public metadata. Verify the APK
certificate against an owner-configured SHA-256 fingerprint before uploading.
Keep release signing with the owner locally if the repository cannot protect
the environment. [GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

With the new ID, the old fixture APK and its data can stay on the phone alongside
Email OS. The new app starts with fresh fixture data. Copy any wanted draft text
out of the old app or keep that app installed. Automatic cross-package migration
is out of scope. The `run-as` transfer in the old smoke guide was for debuggable
test APKs. ADR 0002's same-profile legacy retirement still requires disclosure
and a verified backup, and retains local drafts.

### Versions, delivery and device support

Use the shared repository semver for `versionName` and set the Android
`bundle.android.versionCode` explicitly in the committed Android Tauri config,
starting at `1001`. In phase 2 verify the pinned CLI passes both fields into the
APK. If the CLI ignores the explicit code, have Gradle read that same committed
value. Bump the code on main for each owner-distributed revision, even when semver
stays the same. A single sequence covers CI and local builds and all ABIs.
A maintainer checks the intended code against the last owner-distributed build
before upload. Reruns of the same commit are rebuilds of that version. A rollback
ships a compatible fix at a higher code. Android's in-place update keeps app
data when the ID and signer match, the version advances, and app migrations
preserve the data. [Android versioning](https://developer.android.com/studio/publish/versioning).

Start with one universal signed release APK for `arm64-v8a` and `x86_64`, named
`email-os-android-release.apk` in a versioned Actions artifact. The owner downloads
and unzips it from the approved run, or uses `gh run download` with the run ID
and artifact name. Record the commit, versions, file size, APK SHA-256 and
certificate fingerprints. The owner can retain the APK after artifact expiry.
Revisit GitHub Releases if a durable direct download becomes necessary.

Keep R8 and start with resource shrinking off. Verify that the minified
release's JNI, WebView and IPC work on both ABIs before considering additional
shrinking. Measure the signed universal APK and the contribution of each
native library using APK Analyzer or ZIP entries. There is no measured release
size yet. If download or storage size is a problem, measure an ARM64-only APK
and consider per-ABI output with the same ID, signer and version sequence.
Check APK ZIP alignment with `zipalign -c -P 16 -v 4 <apk>` and ELF LOAD segment
alignment of each packaged shared library. If the pinned NDK r27 produces
unaligned segments, use Android's documented linker flags and retest. Run on
a 16 KB device or image if available and record the actual coverage. ARM64 is
the expected phone ABI. The initial APK omits 32-bit libraries.
[Android 16 KB page size guidance](https://developer.android.com/guide/practices/page-sizes).

### First-launch ANR

`src-tauri/src/setup.rs:40–76` performs profile open synchronously inside the
Tauri setup callback. `open_fixture_core` resolves the fixture profile
(`setup.rs:17–26`). The synthetic open takes the profile lock, creates or opens
the synthetic provider's facts DB, then opens the Gmail store and preloads the
synthetic mailbox before the worker starts
(`crates/mail-core/src/gmail/sync.rs:341–360,423–444,1920–1960`). The fact store
migrates and seeds with WAL and full synchronous durability
(`crates/mail-core/src/synthetic/facts.rs:39–58`). Draft open takes its own
lock, opens SQLite and runs schema setup
(`crates/mail-core/src/drafts/store.rs:37–69`). These steps cost more on a new
profile and under I/O or scheduling pressure.

Constructing `FixtureTransition` merely records the directory
(`crates/mail-core/src/fixture_transition.rs:225–245`). The Vue gate loads
status after mount, and the status and accept commands already use
`spawn_blocking` (`src/components/FixtureTransitionGate.vue:34–51`,
`src-tauri/src/commands/transition.rs:7–24`). Status checks markers and can
finish a previously accepted reset, while a fresh profile has no legacy
database to back up (`fixture_transition.rs:247–279,342–386`). The bundled
frontend mounts `StartupRoot` (`src/main.ts:17–22`), then mounts `App` once the
gate clears (`src/StartupRoot.vue:12–21`). The mailbox then subscribes, loads
account status and loads the list
(`src/composables/useMailbox.ts:805–828,1185–1187`).

The leading hypothesis is that fresh SQLite setup and synthetic preload delay
native readiness or event handling alongside first-use WebView work. Source
inspection puts the Tauri callback on the Rust/Tao event loop. The timeout is
for an Android Activity focus event, so the finding alone cannot establish
that SQLite blocked the Android UI thread. A platform WebView stall or emulator
scheduling starvation could also explain it. The legacy backup path is a low
priority suspect on empty installs.

After approval, time Activity creation (including `super.onCreate`), WebView
creation, first frame and focus callback, Rust setup and each profile-open
phase, transition IPC and Vue first paint and Inbox ready. Log only stage,
thread and monotonic durations, with no mailbox data or request payloads.
Compare first launches of fresh installs and process-cold launches of populated
profiles on the same emulator, in quiet and representative load, then use the
ARM64 phone. If it recurs, capture timestamped logcat, an ANR main-thread stack
and a Perfetto scheduler/I/O trace on the test device. Use the thread stacks
and wait chain to distinguish blocked native work, WebView startup and CPU
starvation. Compare against an otherwise equivalent diagnostic build that
moves profile I/O off the event loop.
[Android ANR diagnosis](https://developer.android.com/topic/performance/anrs/diagnose-and-fix-anrs).

If profile open is on the critical path, move Android's blocking profile work
to one background task. Show a focusable startup surface immediately. Register
the readiness gate before any page IPC. Make the transition and mailbox UI wait
asynchronously for one complete state, with a recoverable error state and a
serialized retry after partial resources are released. Keep the legacy
disclosure gate before mailbox access, the single-writer profile locks, and
the existing startup recovery rules. Exercise a deliberately delayed and a
failed open. If the trace instead implicates Activity or WebView startup,
address that path and measure again. A branded splash alone cannot fix an
input timeout.

### Manifest and presentation

Keep the normal `INTERNET` permission. Fixture launch works offline and needs
no runtime permission prompts. Mail profiles stay in app-private storage.
No broad storage permission is needed. Check the merged manifest for additional
permissions or exported components, and keep the FileProvider internal with
grants limited to the intended files if a later feature needs it.

Set `allowBackup=false` and explicit exclusion rules for cloud and
device-to-device transfer on API 31+, with full-backup exclusions on older
versions. Cover app storage including the profiles, SQLite side files,
WebView state and future credential material. Some manufacturers can still run
device transfer with `allowBackup=false` alone. Backup settings do not affect
in-place updates. Clearing storage, uninstalling or changing phones can lose
local drafts. [Android Auto Backup](https://developer.android.com/identity/data/autobackup).

Keep release cleartext disabled and the bundled Tauri WebView and IPC working.
Use platform-trusted HTTPS for later Gmail and send paths. If a track needs
Android Network Security Config for a documented debug-only endpoint, keep the
exception in the debug variant and test the signed release's effective policy.
Validate TLS trust separately in the Rust HTTP client, which uses rustls
(`crates/mail-core/Cargo.toml:20`), since manifest settings alone do not
configure that client. Retain the WebView CSP and avoid broadening it for
native API calls. [Android network security configuration](https://developer.android.com/privacy-and-security/security-config).

Verify the launcher art from the repository at phone sizes, with an adaptive
icon and a legacy fallback where needed. Use the Email OS icon and matching
window background for the system splash, and check handoff to the app in
light and dark mode, including Android 12+. Keep the compact layout, safe
insets, soft keyboard resizing and Back behavior from ADR 0003.

## Scope and out of scope

Scope covers APK packaging and signing, application identity, update delivery,
first-launch diagnostics and repair, the Android manifest and resources, and
emulator and owner phone verification. Store distribution, an in-app updater,
automatic old-package migration, and device-to-device restore are outside this
proposal. Tracks B, C and D own Google sign-in, HTML mail and sending.

## Owner actions

1. After approval and before the first signed build, confirm the app ID and
   create the key on the owner's machine. Use an interactive command so key
   passwords are prompted and stay out of shell history.

   ```sh
   umask 077
   mkdir -p "$HOME/.local/share/email-os/signing"
   keytool -genkeypair -storetype JKS -keyalg RSA -keysize 2048 -validity 10000 \
     -keystore "$HOME/.local/share/email-os/signing/email-os-release.jks" \
     -alias email-os-release
   keytool -list -v -storetype JKS \
     -keystore "$HOME/.local/share/email-os/signing/email-os-release.jks" \
     -alias email-os-release
   ```

   Store the encrypted backup and passwords, verify the restored certificate, and
   share only the SHA-1 and SHA-256 certificate fingerprints for verification
   and OAuth registration.
2. Once the signing workflow is reviewed, open repository **Settings →
   Environments → android-release** and restrict deployment branches. Add
   environment secrets `ANDROID_KEYSTORE_BASE64` (the single-line base64 JKS),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
   Set the environment variable `ANDROID_RELEASE_CERT_SHA256` to the public
   certificate digest from `keytool`. Base64 is reversible. Put it directly in
   the secret field, and keep the JKS and passwords off the shared VM and out of
   messages. For pre-merge CI validation, temporarily allow a protected candidate
   branch only if the owner can review the exact workflow and candidate commit
   before granting secret access. Remove that branch from the environment when
   the test is done. Otherwise use two owner-local signed candidates before
   merge, then compare the first trusted CI build after merge. Use main for
   routine builds.
3. Before starting the phone test, report device model and Android version, and
   whether the old fixture app has any drafts to keep. Perform the phone steps
   below using two approved signed versions. If Android blocks direct APK
   install, record the exact message and report whether USB/ADB is available.
   If developer verification becomes required for this install route, the
   owner handles registration for the final ID and signing certificate.
   [Android developer verification rollout](https://developer.android.com/developer-verification).

## Dependencies

- **Track B (ADR 0005)** needs the approved application ID early and the
  release signing certificate SHA-1 as soon as the owner generates the key.
  Track A verifies that SHA-1 against the signed APK with
  `apksigner verify --verbose --print-certs`. Track B owns the Android OAuth
  client registration with the owner, its callback, and token storage. A
  debug signer needs a separate OAuth registration if B chooses to use one.
  B should use the startup readiness contract if the Android profile changes.
  [Google Android OAuth credentials](https://developers.google.com/workspace/guides/create-credentials#android).
- **Track C (ADR 0006)** can use the signed fixture APK for native reader checks.
  Its HTML resource policy stays within its own design.
- **Track D (ADR 0007)** gets the same signed install/update path and network
  baseline. D owns sending permissions, endpoint and TLS requirements and
  delegates any manifest or network-policy dependency back to A for review.

## Implementation plan

All stages start after GREENLIGHT. Use the programme's shared Rust build settings,
single-heavy-job rule and emulator lock.

1. **Identity and release build.** Align Android IDs and label, wire signed
   release packaging and the version source, and keep debug CI. Follow the
   programme's generated-source preparation for a legacy baseline build.
   Regenerate Wry/Tauri output for the new package and verify JNI names and
   ignore rules. Use a clean CI checkout to check generation if the shared
   build cache skips it. Check the finished APK with `aapt dump badging` and
   `apksigner verify --verbose --print-certs`, inspect both ABIs and alignment,
   and verify a release request without signing inputs fails. The owner runs
   the local production-key signing check, while development checks can use a
   throwaway key on synthetic test installs.
2. **Startup diagnosis.** Add temporary timing markers and capture baseline
   cold-start timing for empty and populated profiles on the shared emulator.
   Check for a correlated main-thread stack if the timeout recurs and document
   where time was spent.
3. **Startup repair.** Change the path identified in stage 2. If moving profile
   open, check delayed readiness, typed failure and retry, single-writer
   exclusion and the ADR 0002 disclosure, cancel and recovery cases. Compare the
   before and after cold-start timing and record the startup flow.
4. **Manifest and launcher.** Add the backup policy and validate the packaged
   release manifest, release/debug networking, and bundled offline boot. Check
   launcher, splash, Inbox and keyboard screenshots for label, clipping, insets
   and first-frame continuity.
5. **Trusted delivery and update.** Add Actions signing and verified artifact
   upload. Verify artifact contents and cert digest, then exercise the emulator
   and owner's phone update flows below. Record versions and hashes, APK size,
   and the install and persistence results. Update the development and current
   status guides with the working path.

## Validation plan

### Automated and browser

- Run `CARGO_TARGET_DIR=/home/exedev/email-os/target CARGO_BUILD_JOBS=2 mise run check:all`,
  including the core fixture transition and profile-lock tests and shell
  startup and draft bridge tests. Run
  `pnpm exec vitest run tests/transition/gate.test.ts tests/layout/mobile-android-back.test.ts`
  for the frontend gate and Android-related regressions. If startup readiness
  changes, add focused cases for failure, retry and delayed availability.
- Use the programme Chromium binary to run `mise run test:rendered` and
  `mise run screenshots:mobile` with `EMAIL_OS_SCREENSHOT_DIR` pointing at the
  evidence directory. Review compact Inbox and compose and capture the startup
  surface through a rendered test harness if it changes. Browser evidence
  covers the shared layout, and Android evidence covers native startup.

### Android emulator

- Use the programme lock and T3 device tools on `local/emulator-5554`.
  Preserve any existing test state. Install version N of the universal release,
  then version N+1 via `adb install -r <apk>` without uninstalling N. Prefer
  owner-local N and trusted CI N+1 signed by the same key when available.
  Confirm both versions with APK metadata and verify both certs. Use disposable
  synthetic builds for a wrong-signer negative check and a legacy transition
  regression. The production release need not support `run-as`.
- Repeat at least five first launches with empty test data and five
  process-cold launches with populated test data before and after the startup
  change. Include quiet and representative emulator load. Record timings for
  first frame/focus and Inbox ready, plus Android version, WebView version,
  load and any ANR. The launch path should accept Back or Home while
  initialization is deliberately delayed. An observed ANR blocks acceptance.
- Before the update, save a synthetic draft, mark a specific conversation done
  and change a swipe setting. After the update, verify the exact draft fields,
  the same conversation in Done and the saved setting. Relaunch and repeat.
  Check reader, IME resize, Back, background/resume and offline launch.
  Capture launcher, startup, Inbox and retained draft screenshots and
  short fresh-launch and update/reopen recordings (each at most 60 seconds).
  Use `docs/validation/android-install/` for small synthetic evidence and
  `/home/exedev/email-os-usable/android-install/` for larger videos and traces.
  Release the lock and restore the emulator's original settings.

### Owner's physical phone

1. Keep any existing fixture install. In **Settings → About phone**, note the
   model and Android version. Use a device on Android 7 or later with an ABI
   in the artifact. If the ABI or page size needs confirmation and USB
   debugging is available, check `adb shell getprop ro.product.cpu.abilist`
   and `adb shell getconf PAGE_SIZE` from the owner's computer.
2. On the phone, sign in to GitHub if required, open the provided Actions run,
   download the approved version N artifact and unzip it in Files. Open
   `email-os-android-release.apk`. If prompted, allow installs from this source
   for Files (or the app opening the APK), then tap **Install**. If local
   signing is used, copy the verified APK to Downloads first. If the direct
   install is blocked and the device allows USB debugging, use
   `adb install <version-N.apk>` after authorizing the computer prompt.
3. Tap **Open** immediately and note time to Inbox, any blank screen, slow
   focus or system dialog. Open a conversation. In a new draft enter
   `install-check@example.test`, subject `Android update check`, and body
   `Keep this draft across the update.` Wait for the local save confirmation.
   Mark a known fixture conversation done and change a swipe setting.
   Background and reopen Email OS. Force stop it in Android App info,
   then open from the launcher and confirm the draft, Done and setting.
4. Download and unzip the approved N+1 artifact in the same way. Open the APK
   and tap **Update** (or use `adb install -r <version-N+1.apk>`). If Android
   rejects the update, keep the app installed and report the exact error.
   After success, verify the displayed version if changed (or use the APK
   metadata and installer result), reopen Drafts and check the exact text,
   check Done and the swipe setting, and repeat after force stop. Turn on
   Airplane mode, open the fixture Inbox and draft, then restore connectivity.
   Revoke the temporary Files install permission or disable USB debugging if
   enabled only for this test.
5. Report device and Android version, the two build codes, install/update
   results, time/behavior at first launch and whether the draft, Done and
   setting survived. Use screenshots or video with synthetic data only.

## Risks and open questions

- Approve `dev.exedev.emailos` as the long-lived Android ID. Does an existing
  fixture install hold drafts the owner needs to keep?
- Can the owner hold and back up the release key, and can the repository use
  an owner-reviewed signing environment? Confirm whether access-controlled
  Actions downloads meet the owner's delivery needs and who can access them.
- Which phone model and Android version will be used, and can the owner run
  the two-version update test? Sideloading support depends on device policy.
  Record installation friction even if ADB works.
- The ANR mechanism, signed APK size and 16 KB runtime coverage remain to be
  measured. Report the observed results and the device coverage before
  recommending the APK for daily use.
