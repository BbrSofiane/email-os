# Current feature status

This page is the current feature inventory and validation summary. Slice and UX
contracts linked below define the detailed behavior and safety limits. Historical
research and architecture proposals are not feature inventories.

## Runtime availability

| Feature | Native fixture (default) | Explicit Gmail profile | Browser preview |
|---|---|---|---|
| Mailbox and reader | Durable synthetic inbox (the Gmail core on the built-in synthetic provider, [ADR 0002](adr/0002-fixture-as-synthetic-provider.md)), plain-text and HTML reader, read/unread mix, operation recovery. | Separate profile; bounded Gmail cache and plain-text and HTML reader. Read-only until the user enables mailbox actions. | Synthetic fixtures and HTML reader in memory; no Gmail, SQLite durability, or native IPC. |
| Mailbox writes | Archive/unarchive, read/unread and star/unstar (single and group), retry and undo, through the same operation ledger as Gmail; no permission grant. Interrupted writes are requeued at the next launch. | Explicit archive/unarchive, read/unread, and star/unstar setters only, after opt-in `gmail.modify` upgrade. No automatic read on open. | Fake-provider simulation only; does not prove provider writes or convergence. |
| Composition | Plain-text new messages and replies with local drafts. On macOS and Android, fixture Send uses a durable outbox and five-second Undo window. | Local-only drafts. Gmail sending awaits Track B's scope upgrade and stage 7. | Synthetic drafts and sends in memory. |
| Search | Cached search over the 24 native fixture conversations, including six HTML samples (ADR 0006). | Read-only cached search or progressive provider scan, with bounded/incomplete coverage disclosures. | Synthetic fake search only. |
| Saved split | One local, account-scoped saved split. | One local split, removed on Gmail disconnect with cached account data. | Synthetic in-memory split. |
| Stars | Star/unstar setters and the cached Starred view, shown by the backend's `triageSurfaces` capability. | Starred cache browsing is read-only; explicit star/unstar setters require enabled Gmail modify capability. Cache coverage is incomplete. | Fake simulated-Gmail star state; not fixture-native or provider validation. |
| Reminders | Device-local reminders; schedule/reschedule/cancel/return do not write the provider. | Device-local reminders; schedule/reschedule/cancel/return do not write Gmail or require modify permission. | Synthetic in-memory reminder state. |
| Attachments and links | Synthetic fixture attachment listing/downloads; confirmed links open in the system browser. | Bounded cached descriptors and authenticated read-only Gmail fetch; explicit downloads create inert `.download` files. Links need explicit browser confirmation. No automatic opening or restricted document host. | Synthetic attachment surfaces only; no native download or Gmail fetch. |
| Multiple workspaces | One native session; native tabs are not implemented or certified. | One active Gmail profile/session. This is not real multi-account activation. | Two isolated synthetic in-app workspaces are supported by the preview. |

The Android fixture target builds debug and signed release APKs for ARM64 and
x86_64 from the shared Rust shell. The new Android package is
`dev.exedev.emailos`, with launcher label **Email OS**. It uses SQLite and the
same synthetic fixture core as desktop (ADR 0002). Gmail and attachment export
are unavailable. Confirmed external links open in the system browser. The
original APK build passed on 2026-11-14. A pre-existing legacy fixture
database is retired once behind a startup screen. The unified-fixture APK was
smoke-tested on an Android 15 x86_64 emulator on 2026-11-15 (see below). Compact
phone layout is now in scope at widths ≤719px for Android fixture and browser preview.
The compact shell covers lists, reader, compose, search, reminders, utility pages,
contact details, command overlays and device-local swipe settings. Fixture sending is supported. Reply-all,
forwarding, label chips, multiple splits and destructive Trash/Spam/move
actions are not supported. HTML bodies are shown in the compact reader ([ADR 0006](adr/0006-html-mail-reader.md)). Android uses fixture data. See the
[Android smoke steps](development.md#android-fixture-apk).

The compact layout was checked on the same emulator on 2026-11-16 with a locally
built debug APK of the merged branch: swipe left to mark done and Undo, swipe
right to the reminder picker, long-press selection, the reader and its action
sheet, contact details, a new message typed with the software keyboard up, and
the saved draft in Drafts. Screenshots:
[inbox](<validation/mobile/android-inbox.png>),
[swipe and Undo](<validation/mobile/android-swipe-done-undo.png>),
[selection](<validation/mobile/android-selection.png>),
[drawer](<validation/mobile/android-drawer.png>),
[reader](<validation/mobile/android-reader.png>),
[reader actions](<validation/mobile/android-reader-more.png>),
[compose with keyboard](<validation/mobile/android-compose-keyboard.png>),
[drafts](<validation/mobile/android-drafts.png>),
[settings](<validation/mobile/android-settings.png>).
Known from that pass: the first launch right after a fresh install can still hit
the Android "isn't responding" dialog recorded for the original APK (a relaunch
is fine), and no physical device was used.

The Android install work moved profile-path resolution and database opening off
the Tauri event loop. Android 15 emulator testing still found focus-dispatch
ANRs in WebView construction before the profile worker began. On the owner's
Nothing Phone (3a) Pro on Android 17 the debug build reached the Inbox in about
2 seconds with no ANR, which met the first-launch gate on 2026-11-23. On
2026-11-24 the owner-key release workflow published 0.1.0 (1001) and (1002), and
updating 1001 to 1002 on the phone kept a draft, a Done conversation and a
setting. [Install and update evidence](validation/android-install/install-update.md)
[Cold-start evidence](validation/android-install/cold-start.md) ·
[Android install proposal](adr/0004-android-install-and-run.md)

Mode selection is deliberate: native defaults to fixture; `EMAIL_OS_MODE=gmail`
selects a separate Gmail profile. Browser preview remains synthetic. See the
[development guide](development.md) for launch and validation commands.

Provider-synced drafts, reply-all, Bcc, delete/Trash mutations and arbitrary
label editing are not implemented. Attachment saving
does not provide inline PDF/Office preview or malware scanning. Confirmed external HTTP(S) links dispatch on macOS and Android. See the
linked contracts for exact bounds and pending platform security gates.

### Fixture sending (ADR 0007)

Send saves the current draft revision, queues it for five seconds, and closes
the editor. Undo restores that revision. A restart during an interrupted hold
returns the draft to Drafts. Activity distinguishes queued, sending, sent,
failed and unknown outcomes. A send with an unknown outcome can be checked,
copied or dismissed. The app never replays it. Linux and Windows desktop keep
the local-draft workflow. See [ADR 0007](adr/0007-send-mail.md).

The Chromium fixture flow covers sending, undoing, reopening the unchanged
draft, and then opening the sent conversation from Activity. See the
[phone editor](validation/send/browser/phone-send-editor.png),
[phone Undo](validation/send/browser/phone-send-undo.png),
[phone Activity](validation/send/browser/phone-send-activity.png),
[desktop editor](validation/send/browser/desktop-send-editor.png), and
[desktop confirmed conversation](validation/send/browser/desktop-send-confirmed.png).

The Android 15 x86_64 emulator ran the locally built `dev.exedev.emailos`
debug APK from `ddd81de`. The recorded flow undoes the first send, restores
the exact recipient, subject, and body, then sends the restored draft after
the five-second window. Activity confirmed the send and the reader showed one
message. The installed app had a different signer, so this check used an
authorized clean reinstall. Android showed “Email OS isn't responding” on
the first launch. Relaunch recovered. See the
[recording](validation/send/android/undo-then-send.mp4),
[Activity](validation/send/android/activity.png), and
[confirmed conversation](validation/send/android/confirmed.png).

### HTML mail (ADR 0006)

The desktop and compact reader show formatted HTML mail in the native app and in browser preview; Android was checked on the emulator, macOS WKWebView is an owner check. Gmail keeps plain and HTML parts; HTML-only mail gets text from a bounded linear extractor for previews, search, reply quotes and copying. HTML is bounded to 512 Ki characters per message and 2 MiB per thread. Oversized HTML, including HTML over the separate 8 MiB sync-page budget for HTML, shows text and “Formatted version too large to show.” Migration `gmail-migrations-10` adds HTML state and inline-part storage; cached mail stays plain until refreshed.

Pinned DOMPurify 3.4.17 and a CSS filter clean mail in an inert document. The result is parsed in a sandboxed `srcdoc` frame, without scripts, forms, popups or top navigation. SVG, MathML and navigable `href` attributes are removed; HTTP(S) and mailto links use `data-eos-href`. Remote images are withheld as `data-eos-src` until “Load images” is chosen for that message; the choice lasts until the conversation closes. Listed, signature-checked PNG, JPEG, GIF and WebP `cid:` images up to 2 MiB load as base64 without disk writes. The frame uses `sandbox="allow-same-origin"` and a CSP of `default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'`, adding `https:` to `img-src` after loading images. It inherits the app CSP, whose only change is adding `https:` to `img-src`. A guard checks `__TAURI_INTERNALS__`, `__TAURI__`, `__TAURI_IPC__`, `__TAURI_POST_MESSAGE__`, `__TAURI_METADATA__` and `ipc`; if visible, it falls back to text with “Formatted view unavailable on this device.”

Frames fit their content; wide mail scales to a 0.5 floor then scrolls sideways. Mail with its own colours uses a white card; other mail uses app colours. Quotes collapse, plain and formatted views can be switched per message, and reader shortcuts are forwarded except selection and copy keys. Links share a confirmation with Files and links, showing the full URL and a warning for mismatched link text. Mailto offers copying the address or starting a message to it. Android dispatches confirmed HTTP(S) links through JNI; Files and links remains hidden there and attachment saving remains unsupported.

The native fixture has 24 conversations, including six HTML samples; seed version 2 upgrades version-1 profiles additively. The preview's primary workspace shares those samples; the browser fake's default test seed remains 18. CSS and sanitiser corpus tests, Chrome frame and rendered reader tests cover the feature. The frame probe passed on Android 15 WebView; macOS WKWebView remains an owner check. See [ADR 0006](adr/0006-html-mail-reader.md) and [validation](validation/html-reader/).

## Validation status

The following is the baseline supplied for this documentation task at
`f361f57c4051c0af578af43277bed8170905548a`, not a rerun for this change:

| Check | Supplied result |
|---|---|
| `mise run check` | Passed: 315 Rust core tests; 1,162 frontend tests; 34 skipped. |
| `mise run test:native` | Passed: 11 tests. |
| `mise run build:web` | Passed. |

This documentation pass did not run the app or tests. It did not validate a real
Gmail account, macOS native runtime, or browser-rendered runtime. Automated tests
and prior operator evidence recorded in individual contracts remain distinct
from those runtime gates. In particular, the baseline above does not certify
Gmail consent/deny/cancel flows, live provider convergence, Keychain behavior,
WKWebView behavior, or native attachment/download handling. Check the contracts
for feature-specific pending gates before treating a feature as operationally
validated.

### Android unified-fixture smoke (2026-11-15)

Run on Android 15 (`t3-pixel`, x86_64 emulator) with the CI debug APK from the
push run on `3061e54` (run 43696254970, artifact `email-os-android-fixture-debug`),
SHA-256 `19ca1a225f4c9820b82d0a5d4aa0e4c8d10e8d8700582c8f6c40f1465db4197c`.
The legacy-reset test used the CI APK from run 43645874365 (PR #63, head `63f7ab8`),
SHA-256 `d8c9b5364e829578bb78f06ff04de779188e8e3fee0b250c2e992c6f4fd3cf74`.
Neither APK was built locally. The UI was driven with `agent-device`; `adb` was used
for installs, `run-as` file inspection and logs only. Synthetic data only.

**Fresh install of the `3061e54` APK**

- The Inbox rendered 16 rows, 6 Read and 10 Unread. A conversation opened.
- Mark read and Mark unread worked from the reader button and from the row menu.
  Star and Unstar worked from the command palette (the row menu and reader toolbar
  have no star control); the starred conversation appeared under Cached Starred.
- Mark done archived the conversation and the Inbox count went from 16 to 15. The
  reader stayed open on a neighbouring conversation rather than returning to the
  Inbox. After killing the process (`am force-stop`) and relaunching, the archived
  conversation was still absent (Inbox 15).
- Undo after Mark done restored the row ("Restored" toast, row back in the Inbox,
  still Unread). A first attempt did not: Undo was tapped several tool calls (well over a few
  seconds) after Mark done, and the toast showed "Undo expired — Mark not done
  restores the whole conversation to Inbox". A second attempt, with Undo tapped about
  two seconds after Mark done, worked. This is the intended behaviour: Undo is
  available for 10 seconds after the action (`UNDO_WINDOW_SECONDS` in
  `crates/mail-core/src/clock.rs`), and the first attempt was later than that.
- Gmail account controls and Files and links were not present in the accessibility
  tree of the Inbox, three reader views, the command palette or the Destinations
  palette.
- A draft (To, Subject, two-line body with `café ✓`) showed "Saved locally · not
  sent". After sending Email OS to Android Settings and back (same process, pid
  unchanged) the editor still held all three fields. After killing the process, the
  Drafts list had the draft and opening it showed the exact To, Subject and body
  ("Draft loaded from this device · never sent").

**Legacy reset (pre-unification APK, then `3061e54` APK)**

Route: `adb install -r` of the main APK over the old one was refused with
`INSTALL_FAILED_UPDATE_INCOMPATIBLE` (the two CI debug APKs have different signing
certificates: SHA-256 `f2e7be56…` for run 43645874365, `7880429c…` for run
43696254970). So the data was carried across with `run-as`: the old install's
`fixture-profile/` was tarred out, the old app uninstalled, the main APK installed
and never launched, and the tarball extracted back into its data directory.

- In the old APK I archived Plumbing (Inbox 16 to 15) and saved a draft
  (`legacy@example.test`, "Legacy draft before unification", two-line body). The
  profile held `mail.db` and `local-drafts/drafts.db`.
- On first launch of the main APK, the "Your demo mailbox is being renewed" screen
  appeared with no mailbox behind it. Closing the app there left `mail.db`,
  `mail.db-wal` and `drafts.db` byte-identical (SHA-256 prefixes compared), and the
  next launch showed the screen again.
- Tapping "Back up and start fresh" led to the mailbox with 16 Inbox rows (6 Read,
  10 Unread) including Plumbing, so the archive had been reset. The saved draft
  opened with its exact text. `fixture-profile/` now had one backup
  (`backups/mail-20261115T135002Z.db`, 102,400 bytes, `fixture-transition.json`
  state `done`), and `mail.db` was gone. The backup pulled to the host passed
  `PRAGMA integrity_check` and held 18 conversations and 1 operation.
- A second launch (after killing the process) showed the Inbox directly, no reset
  screen.

**Findings**

- ANR on the first cold launch after the fresh install. logcat: `ANR in
  dev.exedev.emailos.androidfixture ... Input dispatching timed out ... Waited
  5000ms for FocusEvent(hasFocus=true)`. The host was busy (load average 4.1 on 4
  cores, CPU pressure `some avg10=50`, `kswapd0` active). The system dialog
  "email-os isn't responding" is in
  [first-launch-anr.png](<validation/android-smoke/first-launch-anr.png>). The Inbox
  had rendered behind it. A relaunch did not ANR, and neither did the six or so
  later cold launches. I did not reproduce it.
- The reader toolbar buttons overlap on this screen width: the UI tree reports Close
  (Esc) at x 212–301 and Remind me on this device at x 199–286, and the "Inbox"
  title is drawn over the icons
  ([reader-toolbar-overlap.png](<validation/android-smoke/reader-toolbar-overlap.png>)).
  Tapping Close (Esc) twice opened the reminder UI instead of closing the reader.
- Starting the app over the legacy profile created `gmail.db` and
  `synthetic-provider.db` before the reset was
  accepted. The legacy files were unchanged, but the screen's "Nothing is changed"
  covers only the old mailbox.
- The Drafts list row is cramped: the To is cut to `ana@exampl…`, the subject shows
  as "Ar", and Discard is inline
  ([drafts-list-truncated-row.png](<validation/android-smoke/drafts-list-truncated-row.png>)).

**Checked against the code: as designed**

- The reset screen says "The 18 sample conversations return to their original
  state" and the Inbox after reset shows 16 rows. Both are right: the fixture has 18
  conversations, 16 in the Inbox and two that start archived
  (`crates/mail-core/src/synthetic/data.rs`).
- Every Inbox row carries "Has attachments". The synthetic provider puts one
  synthetic attachment on the first message of every conversation
  (`crates/mail-core/src/synthetic/provider.rs`), so the marker is correct. The
  preview text of Invoice 4471 says the fixture has no attachments, which is stale
  sample copy. No attachment was opened in this run.

Screenshots: [reset screen](<validation/android-smoke/legacy-reset-screen.png>),
[legacy draft after reset](<validation/android-smoke/legacy-draft-after-reset.png>),
[Inbox on second launch](<validation/android-smoke/inbox-after-reset-second-launch.png>),
[Undo restored](<validation/android-smoke/mark-done-undo-restored.png>),
[draft saved](<validation/android-smoke/draft-saved-before-restart.png>) and
[draft recovered](<validation/android-smoke/draft-recovered-after-restart.png>).
The last two replace the 2026-11-14 images of the same name.

**Not verified**

- IME layout: text was entered with `agent-device fill` and the soft keyboard did not
  appear.
- Whether star, read/unread or the Undo result survive a process restart. Only the
  archived conversation and the drafts were checked after a restart.
- Closing the reset screen by swiping the app away from Recents. The cancel path was
  tested with `am force-stop`.
- ARM64 devices, physical devices, other Android versions, and any Gmail, network
  or attachment behaviour.
- The data directory the emulator held before this run (the 2026-11-14 install) was
  backed up before uninstalling; it was not restored afterwards.

### Android fixture target (2026-11-14)

`mise run android:doctor` passed with API 35, build-tools 35.0.0, NDK
27.2.12479018, JDK 17, and ARM64/x86_64 Rust targets. The command
`CARGO_BUILD_JOBS=2 mise run android:build` passed and produced
`src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`.
Static APK validation confirmed package ID `dev.exedev.emailos.androidfixture`,
minimum API 24, target API 35, a valid v2 APK signature, and both `arm64-v8a`
and `x86_64` `libemail_os.so` libraries. SHA-256:
`161befa9ca00e1a8dfb8bf97ff3685415ad4d55821ea0a4fcfa6d15fc5762708`.

Device smoke passed on an Android 15 x86_64 emulator. The 16-row fixture inbox
rendered, a conversation opened, Mark done worked, and the archived conversation
remained absent after process restart. Gmail controls and Files and links were
absent. A locally saved draft reopened with its exact subject and body, and the
editor remained intact after backgrounding Email OS, opening Android Settings,
and resuming Email OS. Screenshots are [reader before archive](<validation/android-smoke/reader-before-insets.png>),
[draft saved before restart](<validation/android-smoke/draft-saved-before-restart.png>),
and [draft recovered after restart](<validation/android-smoke/draft-recovered-after-restart.png>).

The first Android launch failed at profile-lock acquisition because
`File::try_lock` returned a storage error on Android 15. Android now uses
nonblocking `flock`; desktop still uses `File::try_lock`. The device check also
found status-bar overlap and a visible Files and links control. The current APK
includes safe-area insets, `adjustResize`, and the Android-only control gate; the
focused Android-vs-browser UI test passed. The keyboard stayed hidden during
draft entry, so actual IME layout was not verified. See the
[development smoke steps](development.md#android-fixture-apk).

On 2026-11-14, `CARGO_BUILD_JOBS=2 mise run check:all` passed before the
Android lock correction: core tests, generated IPC contract, formatting and
core clippy, all 1,454 frontend tests, frontend typecheck, native clippy, 14
native bridge tests, and production web build. After the lock correction,
`CARGO_BUILD_JOBS=2 mise run test:core` passed with 216 unit tests and all core
integration suites, and `CARGO_BUILD_JOBS=2 mise run lint:core` passed. The
focused Android control visibility test and the final APK build also passed.

## Feature contracts

| Area | Contract |
|---|---|
| Initial fixture inbox | [Vertical slice 01](vertical-slice-01.md) |
| Gmail reading and profile boundary | [Vertical slice 02](vertical-slice-02.md) |
| Gmail archive and read actions | [Vertical slice 03](vertical-slice-03.md) |
| Local-only drafts and composer | [Vertical slice 04](vertical-slice-04.md) |
| Browsing shell and reader | [UX-01](ux-01-compact-browsing-shell.md), [UX-02](ux-02-conversation-reader.md) |
| Command discovery and Undo | [UX-03](ux-03-command-discovery.md), [UX-04](ux-04-trustworthy-undo.md) |
| Bulk processing and saved split | [UX-05](ux-05-safe-bulk-processing.md), [UX-06](ux-06-saved-split.md) |
| Historical search | [UX-07](ux-07-historical-search.md) |
| Stars | [UX-08](ux-08-stars.md) |
| Provider destinations and triage | [UX-09](ux-09-provider-destinations.md), [UX-10](ux-10-bounded-triage.md) |
| Reminders and attachments | [UX-11](ux-11-local-reminders.md), [UX-12](ux-12-safe-attachments.md) |
| Independent synthetic workspaces | [UX-13](ux-13-independent-workspaces.md) |

For architecture, see [current architecture](current-architecture.md). For
setup, commands, and platform limitations, see the [development guide](development.md).
