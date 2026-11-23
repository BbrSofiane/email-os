# Android cold startup

## Baseline, 2026-11-22

Android 15, x86_64, emulator-5554, WebView 124.0.6367.219. Tested the
throwaway-signed release at version 0.1.0 (1002), with the manifest and
launcher changes in `67cb852` and local Kotlin and Rust timing markers.
The desktop profile and the old `androidfixture` application were untouched.

Time each Activity marker from entry to `MainActivity.onCreate` using Android
uptime. The frame callback is a Choreographer callback, so it does not measure
the first frame containing the Inbox. Time Rust profile open and setup from
the Tauri setup callback on the Rust event-loop thread. The two timing
origins are independent. The WebView marker measures the callback reporting
its creation, which follows its construction. Focus is the first
`onWindowFocusChanged(true)` marker and does not establish that Android
delivered the input event before its deadline.

| Launch | Host load (1 min) | Frame callback (ms) | WebView callback (ms) | Focus (ms) | Profile open (ms) | Rust setup (ms) |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Fresh 1 | 1.83 | 229 | 9904 | 14358 | 9078 | 9154 |
| Fresh 2 | 3.46 | 344 | 5805 | 6129 | 4794 | 4905 |
| Fresh 3 | 4.83 | 226 | 6552 | 7401 | 5505 | 5552 |
| Fresh 4 | 6.04 | 85 | 5468 | 6093 | 4342 | 4372 |
| Fresh 5 | 5.44 | 144 | 5018 | 5431 | 5139 | 5176 |
| Populated 1 | 4.91 | 223 | 5617 | 5642 | 3153 | 3160 |
| Populated 2 | 5.46 | 941 | 7914 | 8471 | 6021 | 6055 |
| Populated 3 | 5.24 | 596 | 5134 | 5746 | 3866 | 3875 |
| Populated 4 | 5.12 | 189 | 5628 | 6102 | 4133 | 4143 |
| Populated 5 | 4.78 | 448 | 4899 | 5274 | 3382 | 3385 |

Android reported ANRs for **fresh 1** on PID 31309 and **populated 2** on
PID 866. Both reports arrived after the original sample capture. Android
reported input dispatch waiting 5029 ms and 5003 ms, respectively, for focus.
At the populated report, guest CPU pressure was
`some avg10=88.04`. Android attempted a thread dump, and logcat reported
a timeout and failure to collect the Java and native stacks. This leaves
the direct ANR cause unconfirmed. Focus was recorded before setup
completed for populated 1, showing the Activity main and Rust event-loop
threads can progress independently. Profile open accounted for nearly all
measured Rust startup work, so that is the work to move off the startup
event loop first. WebView initialization and scheduler pressure remain
separate suspects if timeouts recur.

### Reproduction

Before each batch run `pgrep -fa 'cargo|gradle|vitest'` and confirm no active
build. Idle Gradle and Kotlin daemons were present. Record `uptime` per
launch. With the programme lock and T3 device session held, uninstall and
reinstall only the new synthetic test package for each fresh launch. Use
the same APK for all five fresh and five subsequent populated starts.
Launch through the command returned by `device_open` with
`open dev.exedev.emailos --relaunch --no-test-ime`. Take an accessibility
snapshot. Capture timestamped logcat for `EmailOsStartup`,
`RustStdoutStderr`, `ActivityTaskManager` and `ActivityManager`, and match
ANRs to the app PID even if the result arrives after another launch.
The Inbox was confirmed on fresh 1 and after the populated batch.

## After moving Android storage startup off the event loop, 2026-11-22

Same emulator, WebView version and sample method. The diagnostic build used
the production startup changes from `4bb80f5` and `b91f70c`, with local timing
markers and a throwaway signature. No heavy build was active during the
timing runs. The worker columns measure time from entry to the worker.

| Launch | Host load (1 min) | Frame callback (ms) | WebView callback (ms) | Focus (ms) | Rust setup (ms) | Data-path lookup (ms) | Worker total (ms) | ANR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Fresh 1 | 0.32 | 274 | 9407 | 10420 | 0 | 41 | 430 | Yes |
| Fresh 2 | 2.22 | 270 | 8378 | 9364 | 0 | 2 | 347 | Yes |
| Fresh 3 | 2.70 | 212 | 6176 | 6515 | 1 | 1 | 151 | No |
| Fresh 4 | 3.53 | 186 | 7315 | 7655 | 0 | 1 | 85 | No |
| Fresh 5 | 2.73 | 200 | 6629 | 7087 | 9 | 0 | 143 | No |
| Populated 1 | 3.17 | 134 | 6540 | 6950 | 6 | 0 | 65 | No |
| Populated 2 | 3.90 | 70 | 7630 | 8501 | 1 | 1 | 176 | Yes |
| Populated 3 | 4.09 | 186 | 7080 | 7470 | 20 | 2 | 320 | Yes |
| Populated 4 | 4.78 | 417 | 6425 | 6957 | 0 | 2 | 144 | No |
| Populated 5 | 5.19 | 342 | 5767 | 6277 | 0 | 4 | 204 | No |

An intermediate run with only database opening deferred still spent
2.44–6.88 seconds in synchronous Tauri setup across ten samples.
The data path API makes a synchronous Android plugin request, so the final
change resolves it on the worker too. Final Rust setup took 0–20 ms and
the Inbox was confirmed on eight of ten launches. Fresh 1 exposed
the Inbox loading surface at snapshot time. Fresh 2 exposed the Android
**Wait** / **Close app** dialog.

Android DropBox main-thread stacks for fresh 1 (PID 29209) and fresh 2
(PID 29625) both show Android WebView construction, with the former in
`AwContents` calling the input-device Binder service and the latter in
`AwSettings` reading system settings. Guest CPU pressure
`some avg10` was 73.20 and 81.55, respectively. Both app profiles began opening
after the WebView callbacks and focus markers. The captured stacks place
these ANRs in the Android WebView startup path. The samples do not isolate
whether the provider, emulator scheduling or both account for the delay.
The storage fix removed a synchronous dependency. It did not clear the
ANR acceptance gate.

The current app uses AndroidX WebKit 1.6.1 and the emulator has WebView
124. Android's documented asynchronous startup API needs a newer WebKit
library and must complete before the app constructs a WebView to avoid
blocking on pending initialization. These stacks are inside per-instance
construction and do not establish that preinitializing the provider would
remove the stall. Test on a comparable emulator with a newer WebView and
on the physical phone before selecting a provider or lifecycle change.
[Android WebView startup guidance](https://developer.android.com/develop/ui/views/layout/webapps/optimize-webview-startup).

## After merging the HTML reader, 2026-11-22

Same Android 15 emulator, WebView 124.0.6367.219, and sample method. The
throwaway-signed diagnostic APK was 0.1.0 (1006), built at `f31c729` with
local timing markers. That head includes the HTML reader merge at `7f5b95d`.
The batch started at a one-minute host load of 1.98. No heavy build or test
ran during the samples. The measured load varied across launches, and the
batch paused between populated 4 and 5 for another track's Cargo test.

| Launch | Host load (1 min) | Frame callback (ms) | WebView callback (ms) | Focus (ms) | Rust setup (ms) | Data-path lookup (ms) | Worker total (ms) | Focus ANR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| Fresh 1 | 1.98 | 426 | 9947 | 10844 | 0 | 175 | 1018 | Yes |
| Fresh 2 | 3.37 | 215 | 7750 | 8446 | 30 | 5 | 497 | Yes |
| Fresh 3 | 3.54 | 467 | 5769 | 6086 | 2 | 4 | 80 | No |
| Fresh 4 | 3.48 | 107 | 5868 | 6238 | 0 | 4 | 143 | No |
| Fresh 5 | 3.52 | 176 | 5884 | 6154 | 5 | 4 | 129 | No |
| Populated 1 | 3.66 | 122 | 6103 | 1654 | 0 | 2 | 123 | No |
| Populated 2 | 4.48 | 203 | 5644 | 6063 | 0 | 1 | 69 | No |
| Populated 3 | 4.49 | 307 | 5196 | 5723 | 1 | 3 | 289 | No |
| Populated 4 | 4.26 | 601 | 5386 | 5786 | 0 | 1 | 96 | No |
| Populated 5 | 1.91 | 434 | 5549 | 5816 | 0 | 1 | 67 | No |

The Inbox appeared in all ten accessibility snapshots. Android reported
late focus ANRs for fresh 1 (PID 21226, 5005 ms waiting for `FocusEvent`) and
fresh 2 (PID 21638, 5011 ms). Rust setup stayed within 0–30 ms. On both ANR
launches, the profile worker started after the WebView callback and the
focus marker. Populated 1 recorded focus before the WebView callback, which
is why the focus time is lower in that row. The ANR release gate remains open.

The ten samples used fresh or already upgraded databases. To exercise the
migration separately, the pre-merge throwaway-signed APK (1005) was installed
and launched to Inbox. The merged APK (1006) was then installed over it with
the same signer. The first launch exercised schema migration 10 and the
fixture upgrade.

| Launch | Host load (1 min) | Frame callback (ms) | WebView callback (ms) | Focus (ms) | Rust setup (ms) | Data-path lookup (ms) | Worker total (ms) | Focus ANR |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |
| First launch after 1005 → 1006 update | 2.58 | 468 | 5463 | 6258 | 1 | 29 | 169 | No |

The upgraded Inbox showed the HTML fixture messages. The migration and
fixture upgrade completed within the 169 ms worker interval, after focus.
One upgrade sample cannot isolate their individual costs.

## Owner's phone, 2026-11-23

The owner installed the CI debug APK built at `f6abadf` (run 45077584648,
artifact `email-os-android-fixture-debug`) on the Nothing Phone (3a) Pro on
Android 17 and launched it repeatedly. Each launch reached the Inbox in about
2 seconds. No "isn't responding" dialog appeared.

**Gate decision (coordinator, 2026-11-23).** The ANR acceptance gate is met on
the target device. The focus ANRs above are treated as an artefact of the
loaded x86_64 Android 15 emulator with WebView 124, not as a release blocker.
If an ANR is ever observed on the phone, the gate reopens and the WebView
startup options above are the starting point. The phone's in-place update test
with the owner's signing key still follows the first owner-signed release.
