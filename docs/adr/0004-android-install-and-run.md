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

## Decisions (2026-11-21)

- The owner approved `dev.exedev.emailos` and the launcher label **Email OS**.
- The owner will generate the release key on their own computer, back it up
  in their password manager, and add the signing inputs to a protected GitHub
  environment. CI signs the owner APK.
- The owner chose public GitHub Releases with one directly downloadable APK per
  version.
- On 2026-11-22 the owner identified the target phone as a **Nothing Phone
  (3a) Pro** running **Android 17** with Google Play services.
- On 2026-11-22 the owner reported the certificate fingerprints below.
  Track A has not verified them against an owner-signed APK.
  - SHA-1 for Track B's OAuth registration:
    `56:4F:A2:63:7A:0E:B0:33:6E:7B:63:0E:50:37:0D:F4:28:F4:21:E8`
  - SHA-256 for `ANDROID_RELEASE_CERT_SHA256`:
    `D1:8F:BA:26:93:85:B9:DC:FC:51:EB:87:41:52:EE:E7:D9:DD:64:52:BF:42:68:D1:E5:59:C6:E2:63:0F:83:31`
- The owner permits their existing keystore copy to remain on the shared VM.
  Track A does not access that copy. All local and PR validation uses throwaway
  keys.
- The coordinator assumes the old fixture app has no data worth keeping
  because it held the synthetic demo mailbox. The app will have no automatic
  migration. The owner can copy any wanted draft text before uninstalling it.

## Design

### App identity and signing

Adopt `dev.exedev.emailos` and the launcher and activity label **Email OS** for
Android. Align the Tauri Android identifier, Gradle ID and namespace, Kotlin
package and path, generated JNI/Kotlin paths and ignore rules. The FileProvider
authority follows the application ID. The desktop identifier stays as it is.

Use a non-debuggable release APK, signed by an owner-generated, long-lived
RSA app-signing key in a password-protected JKS or PKCS12 keystore. The
file extension alone does not identify its format. For PKCS12 use the store
password as the key password. The primary copy lives outside
the repository on the owner's machine. Keep an encrypted offline copy and
the passwords in the owner's password manager. Restore the backup once and
compare its certificate fingerprints before distributing the first APK. Losing
the signing key removes the ordinary in-place update path. A compromised key
allows third parties to sign APKs Android can accept as updates. Plan any
rotation against the supported Android versions and OAuth registration before
changing the signer. [Tauri Android signing](https://v2.tauri.app/distribute/sign/android/).

Gradle's release signing config reads `ANDROID_KEYSTORE_PATH`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`
from the process environment. For an emergency local owner build, supply the
same values from the owner's password manager for one invocation, with an
explicit version code as described below. Debug CI and local development keep
ordinary debug signing for test devices. Release signing fails closed when
key inputs are missing or invalid. Keep ordinary debug installs on test devices.

Use a dedicated Actions workflow named **Android Release** with
`workflow_dispatch` as its sole trigger. The signing job requires the canonical
`BbrSofiane/email-os` repository and `refs/heads/main`, checks out the dispatched
main commit, and uses the `android-release` environment. Store signing secrets
only in that environment. Restrict its deployment policy to the `main` branch
and require a reviewer, a protection available on public repositories. The
workflow builds from its own checkout and takes no PR refs, artifacts or build
caches as inputs. Decode the base64 keystore to a restricted runner temporary file
for signing, disable shell tracing and remove the file on exit, including on
failure. Publish only the APK and public metadata after checking the certificate
against the owner's configured SHA-256 fingerprint.
[GitHub deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).

PR CI uses the ordinary `pull_request` event and a separate job with no
release environment or signing secrets. It generates an ephemeral throwaway
key in the job, exercises the same release build and verification commands,
and discards the APK and key. Verify both JKS and PKCS12 with throwaway keys
before owner signing. Production signing never runs through
`pull_request_target` or a workflow triggered by a PR job. This keeps the
owner's keystore out of all PR runs, including forks.
[GitHub fork workflow and secret rules](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request).

With the new ID, the old fixture APK and its data can stay on the phone alongside
Email OS. The new app starts with fresh fixture data. Copy any wanted draft text
out of the old app or keep that app installed. Automatic cross-package migration
is out of scope. The `run-as` transfer in the old smoke guide was for debuggable
test APKs. ADR 0002's same-profile legacy retirement still requires disclosure
and a verified backup, and retains local drafts.

### Versions, delivery and device support

Use the shared repository semver for `versionName`. Set owner-build
`versionCode` automatically to `1000 + github.run_number` in **Android Release**
and pass it as `ANDROID_VERSION_CODE` to the release task. The task requires a
valid integer in Android's supported range. Gradle uses that value for release
and the generated Tauri version name. Check both values in the packaged APK.
The first workflow run starts at code `1001`. Each new dispatch increases the
code even if the commit and semver are unchanged, failed runs can leave gaps,
and rerunning a workflow run retains its code. This avoids reliance on manual
bumps, commit counts or clock time. Keep the same workflow sequence across
refactors, or explicitly carry forward the last issued code if replacing it.
[GitHub Actions context](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts#github-context).

For an emergency owner-local build, require an explicit `ANDROID_VERSION_CODE`
from a fresh **Android Release** dispatch. Cancel that run before it signs,
build its exact main commit locally, and reserve that code for the local APK.
Never distribute two distinct APK revisions at the same code. If Actions is
unavailable to allocate a code, wait before distributing the local build.
Test builds use explicit test codes and throwaway signers. An owner rollback
ships a compatible revision from main through a new dispatch. Android's
in-place update keeps app data when the ID and signer match, the version
advances, and app migrations preserve the data.
[Android versioning](https://developer.android.com/studio/publish/versioning).

Publish one universal signed APK for `arm64-v8a` and `x86_64` per GitHub
Release, named `email-os-android-release.apk`. After building, signing and
verifying the signer and package metadata, the manually dispatched workflow
creates the tag `android-v<versionName>-<versionCode>` at the exact main
commit it built, for example `android-v0.1.0-1001`. Generate release notes
from commits since the previous Android release. For the first release, use
the commit range from the Android install programme's baseline to the build
commit. Include the commit, versions, APK size, APK SHA-256 and certificate
fingerprints in the notes.

Give only the protected release job repository contents write permission.
Serialize release publication and attach the verified APK to a draft before
publishing. A rerun may finish an
unpublished draft for the same commit and code. It leaves published assets
and tags intact. Skip publishing if a higher Android code has already been
published. GitHub Release assets are public, like the repository, and the APK
contains no secrets. Track B's Android OAuth client ID is a public identifier.
The owner opens the version's release page and taps the APK asset on the phone.
[GitHub release publication](https://docs.github.com/en/repositories/releasing-projects-on-github/managing-releases-in-a-repository).

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

Track C separately reported three first-launch input timeouts after APK
installs, twice with heavy host load and once with moderate load. The
reports establish recurrence. The blocked thread and root cause remain unknown.

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

Set the Email OS label and use the existing artwork for an adaptive launcher
icon and its legacy fallback. Let the platform splash use the app icon and
existing window background. Check the handoff in light and dark mode,
including Android 12+. Keep the compact layout, safe insets, soft keyboard
resizing and Back behavior from ADR 0003.

## Scope and out of scope

Scope covers APK packaging and signing, application identity, update delivery,
first-launch diagnostics and repair, the Android manifest and resources, and
emulator and owner phone verification. Store distribution, an in-app updater,
automatic old-package migration, and device-to-device restore are outside this
proposal. Tracks B, C and D own Google sign-in, HTML mail and sending.

## Owner actions

Phase 2 uses throwaway keys. The owner can create the key sooner to give Track B
the certificate fingerprint, and runs the first owner-key build after merge.

1. Once the app ID is approved, create the key on the owner's machine. Use an
   interactive command so key passwords are prompted and stay out of shell history.

   ```sh
   umask 077
   mkdir -p "$HOME/.local/share/email-os/signing"
   keytool -genkeypair -storetype PKCS12 -keyalg RSA -keysize 2048 -validity 10000 \
     -keystore "$HOME/.local/share/email-os/signing/email-os-release.p12" \
     -alias email-os-release
   keytool -list -v \
     -keystore "$HOME/.local/share/email-os/signing/email-os-release.p12" \
     -alias email-os-release
   ```

   Use an existing owner-generated keystore if the intended key already
   exists. Preserve its actual format, alias and passwords. Store the encrypted
   backup and passwords, verify the restored certificate, and
   share only the SHA-1 and SHA-256 certificate fingerprints for verification
   and OAuth registration.
2. After merge, open **Settings → Environments → android-release** in
   `BbrSofiane/email-os`. Under **Deployment branches and tags**, choose
   **Selected branches and tags** and add only a branch rule for `main`.
   Configure **Required reviewers** with the owner or a reviewer who can
   approve the owner's dispatch if self-review is disabled. Add environment
   secrets `ANDROID_KEYSTORE_BASE64` (the single-line base64 keystore),
   `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`.
   Set the environment variable `ANDROID_RELEASE_CERT_SHA256` to the public
   certificate digest from `keytool`. Base64 is reversible. Put it directly in
   the secret field using the owner-managed copy. Keep passwords and encoded
   keystores out of messages. The workflow compares the public digest
   independently of letter case and colon separators.
3. Open **Actions → Android Release → Run workflow**, select `main`, then
   run it. On the run page, verify the branch and commit, then select
   **Review deployments → android-release → Approve and deploy**, or have
   the configured reviewer do that. When the run succeeds, open the
   `android-v<versionName>-<versionCode>` entry under **Releases** and
   download `email-os-android-release.apk`. Verify the reported
   application ID with `aapt dump badging` and the SHA-256 certificate digest
   with `apksigner verify --verbose --print-certs`. Compare the digest to the
   owner key and the output of `sha256sum email-os-android-release.apk` to
   the published APK checksum before installing.
   Start a new dispatch for the second phone-test APK so it receives a higher
   code and its own release. A rerun of the first dispatch keeps the first code.
4. Before starting the phone test, report device model and Android version.
   Perform the phone steps below using two approved signed versions.
   If Android blocks direct APK
   install, record the exact message and report whether USB/ADB is available.
   If developer verification becomes required for this install route, the
   owner handles registration for the final ID and signing certificate.
   [Android developer verification rollout](https://developer.android.com/developer-verification).

## Dependencies

- **Track B (ADR 0005)** builds on Track A's package rename after A lands.
  A moves `src-tauri/gen/android/app/src/main/java/dev/exedev/emailos/androidfixture/`
  to `src-tauri/gen/android/app/src/main/java/dev/exedev/emailos/`. B adds its
  Android-native code under the new path. B needs the approved ID early and the
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
single-heavy-job rule and emulator lock. The merge gate uses throwaway signing.
Owner-key distribution and phone validation follow merge.

1. **Identity and release build.** Align Android IDs and label, wire signed
   release packaging and the version-code input, and keep debug CI. Follow the
   programme's generated-source preparation for a legacy baseline build.
   Regenerate Wry/Tauri output for the new package and verify JNI names and
   ignore rules. Use a clean CI checkout to check generation if the shared
   build cache skips it. Check the finished APK with `aapt dump badging` and
   `apksigner verify --verbose --print-certs`, inspect both ABIs and alignment,
   and verify a release request without signing inputs fails. Use a locally
   generated throwaway key for the release build.
2. **Startup diagnosis.** Use local-only timing markers and capture baseline
   cold-start timing for empty and populated profiles on the shared emulator.
   Check for a correlated main-thread stack if the timeout recurs and document
   where time was spent. Remove the temporary markers from the shipping diff
   after collecting the before/after evidence.
3. **Startup repair.** Change the path identified in stage 2. If moving profile
   open, check delayed readiness, typed failure and retry, single-writer
   exclusion and the ADR 0002 disclosure, cancel and recovery cases. Compare the
   before and after cold-start timing and record the startup flow.
4. **Manifest and launcher.** Add the backup policy and validate the packaged
   release manifest, release/debug networking, and bundled offline boot. Check
   launcher, splash, Inbox and keyboard screenshots for label, clipping, insets
   and first-frame continuity.
5. **Trusted delivery and update.** Add the main-only GitHub Release workflow and the
   PR release build check. Verify in PR CI that an ephemeral key signs a release
   APK and that the package, version, signer and ABIs match expectations.
   Discard the APK and key. Check release tag and notes generation with
   synthetic inputs. Review the production trigger, secret scope and
   publication conditions, then complete the throwaway-key emulator update below.
   Record versions, hashes, APK size and persistence results. Document the
   validated path and the post-merge owner build and phone checks in the
   development and current status guides.

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
  Preserve any existing test state. Build universal versions N and N+1 locally
  with explicit test codes and the same throwaway key. Install N, then apply
  N+1 via `adb install -r <apk>` without uninstalling N. Confirm both versions
  with APK metadata and verify both certificates. Use disposable
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

### Owner's physical phone after merge

The shared emulator is Android 15 on x86_64. The Nothing Phone (3a) Pro on
Android 17 remains a separate validation target. Keep compileSdk and targetSdk
at 35. Check the phone's actual ABI and page size, installer and Play Protect or
developer-verification prompts, first-launch splash, focus and offline WebView
startup, and IME visibility after rotation. Record the WebView version if
startup stalls. Android 17 adds app memory limits and blocks cross-profile
loopback by default. Check first launch and resume for unexpected process exits
and check bundled IPC on the phone. Use the same Android profile for later auth
handoff. The new LAN permission
and safer dynamic native loading requirements apply to apps targeting API 37
and are checks for any future target change.
[Android 17 changes for all apps](https://developer.android.com/about/versions/17/behavior-changes-all),
[Android 17 target-specific changes](https://developer.android.com/about/versions/17/behavior-changes-17).

1. In **Settings → About phone**, note the model and Android version. The
   old fixture app can stay installed alongside Email OS. Copy any draft text
   you want before uninstalling the old app. Use a device on Android 7 or later
   with an ABI in the APK. If the ABI or page size needs confirmation and USB
   debugging is available, check `adb shell getprop ro.product.cpu.abilist`
   and `adb shell getconf PAGE_SIZE` from the owner's computer.
2. On the phone, open the approved version N under **Releases** and tap
   `email-os-android-release.apk` under **Assets**. Open the downloaded APK.
   If prompted, allow installs from this source
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
4. Open the approved N+1 release and download its APK in the same way. Open the APK
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

- Can the owner run the two-version update test on the Nothing Phone (3a) Pro?
  Sideloading support depends on device policy.
  Record installation friction even if ADB works.
- The ANR mechanism, signed APK size and 16 KB runtime coverage remain to be
  measured. Report the observed results and the device coverage before
  recommending the APK for daily use.
