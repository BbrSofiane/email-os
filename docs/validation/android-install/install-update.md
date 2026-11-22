# Android install and update evidence, 2026-11-22

Android 15 x86_64 emulator, WebView 124.0.6367.219. The builds use the same
throwaway PKCS12 signing certificate and the package `dev.exedev.emailos`.
Its SHA-256 is
`e65923d0b9ceb68052171137c895ecd442a51f14c789f6e2fc6107221cd9b72d`.

| Version | APK bytes | SHA-256 |
| --- | ---: | --- |
| 0.1.0 (1004) | 33,434,125 | `8bafae4b0fb7ed2f9f883e8e090a1f347a3eea08a6dfc976ad31e955ea6ac37c` |
| 0.1.0 (1005) | 33,347,733 | `fba6f4ff86f1c3bce799f5de0724caf34a8994b70d7bd9d46a0021c4a12a61de` |

Both APKs passed signature verification, ARM64 and x86_64 ABI checks and
16 KB ZIP and ELF alignment checks. These are packaging results. The
emulator does not cover ARM64 hardware or a 16 KB runtime.

1. Installed 1004 on an empty synthetic test profile. The launcher showed
   **Email OS**, and the app showed the platform splash and reached Inbox.
   A delayed ANR blocked an initial compose tap. The app worked after restart.
2. Saved a local draft to `install-check@example.test` with subject
   **Android update check** and body **Keep this draft across the update.**
   Marked **Fixture notes: restart recovery** done and set right swipe to
   **None**. The real Android keyboard was visible while editing the draft.
3. Tried 1005 signed with a different throwaway JKS signer. Android rejected
   it with `INSTALL_FAILED_UPDATE_INCOMPATIBLE`. Then installed the
   matching-signer 1005 using `adb install -r` without uninstalling 1004.
   Android reported success.
4. A focus-dispatch ANR interrupted the first launch after updating. After
   relaunch, the saved draft opened with the exact recipient, subject and
   body. The same fixture conversation was in Cached Done and right swipe
   still showed **None**. An offline cold launch reached Inbox. Switching to
   Settings and back also returned to Inbox. Airplane mode and Wi-Fi were
   restored, and 1005 was left installed.

Screenshots:
[launcher](launcher.png), [startup splash](startup.png),
[Inbox](inbox.png), [keyboard](keyboard.png),
[retained draft](retained-draft.png), [retained swipe setting](retained-swipe.png).

Recordings:
[fresh launch to splash](fresh-launch.mp4) (5 s),
[package update](package-update.mp4) (12 s),
[reopening the retained draft after relaunch](reopen-retained-draft.mp4) (4 s).
Android's recorder cut off the tail of each capture. The screenshots
and the steps above record the outcomes beyond the captured frames.

The in-place update and persistence checks passed with a throwaway signer.
The [cold-start gate](cold-start.md) remains open. Owner signing,
publication on GitHub Releases, and the Android 17 phone test remain pending.
