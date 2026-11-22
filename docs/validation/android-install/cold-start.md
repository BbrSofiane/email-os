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

Android reported an ANR for **populated 2** on PID 866, with the report
logged during a later run. The reason was input dispatch waiting 5003 ms
for a focus event. At the report, guest CPU pressure was
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
