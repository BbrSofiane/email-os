# Development guide

This repository contains two deliberately separate native profiles: the durable
synthetic fixture slice (Slice 01) and an explicit, read-only Gmail profile
(Slice 02). Slice 02 adds system-browser OAuth/PKCE, a macOS Keychain credential
store, bounded inbox caching, and background sync; it does not add composing,
sending, archive, mark-read, attachments, HTML rendering, or search. The browser
preview remains synthetic and in-memory. See the two slice contracts for their
individual acceptance scope.

## Layout

| Path | Owner |
|---|---|
| `crates/mail-core/` | Rust DTOs, fixture core, read-only Gmail provider/auth/cache/sync, SQLite, profile locks |
| `src/`, `tests/`, `package.json`, configs | Vue 3/TypeScript frontend, IPC adapter and tests |
| `src/lib/ipc/generated.ts` | **Generated** — do not edit by hand; regenerate with `mise run gen:ts` |
| `src-tauri/` | Thin Tauri 2 shell: seven typed commands, `mailbox_changed`, fixture/Gmail profile selection and lifecycle |
| `mise.toml` | Project tasks (see below) |

## Tooling

All commands run through [mise](https://mise.jdx.dev) (pinned: node 24.4.1,
pnpm 10.18.0, rust 1.89.0). First-time setup:

```sh
mise trust           # after inspecting the repository's mise.toml
mise install         # install the project-pinned runtimes/tools
mise run install:ui   # locked frontend dependencies (pnpm install --frozen-lockfile)
```

Rust dependencies resolve via the committed `Cargo.lock` on first `cargo`/`mise` use;
no global configuration is needed.

## Validation gates

Core and frontend gates run independently of native GTK/WebKit prerequisites:

| Task | What it does |
|---|---|
| `mise run check` | Core tests, generated-contract check, core lint, UI tests and typecheck |
| `mise run test:core` | `cargo test -p mail-core` — synthetic fixture and Gmail auth/cache/sync tests; no real accounts or Google network |
| `mise run check:contract` | Regenerates the TS wire contract to a temp file and **fails on drift** against `src/lib/ipc/generated.ts` |
| `mise run gen:ts` | Regenerates `src/lib/ipc/generated.ts` from Rust DTOs |
| `mise run lint:core` | Workspace formatting and `clippy -D warnings` for mail-core |
| `mise run test:ui` | Vitest component/transport tests |
| `mise run typecheck` | `vue-tsc --noEmit` |
| `mise run build:web` | Frontend production build to `dist/` |
| `mise run check:native` | Locked compile-check of the Tauri shell and native tests |
| `mise run test:native` | Native shell bridge tests |
| `mise run dev:native` | Tauri dev app; GTK/WebKit development packages are required on Linux |
| `mise run build:native` | Bundled native app |

## Running the app

**Browser preview (in-memory, not durable):** `mise run dev:web`, then open the
printed localhost URL. The disclosure banner identifies the labelled fake client;
there is no real OAuth or mailbox access in browser preview.

**Native fixture mode (default):** `mise run dev:native`. This opens the synthetic
fixture profile under `<app_data_dir>/fixture-profile`. The fixture provider's
optional demo behavior is selected with `EMAIL_OS_FAKE_PROVIDER=paused|reject|success`
(default: success). A profile lock rejects a second writer to the same profile.

**Explicit native Gmail mode:** launch with `EMAIL_OS_MODE=gmail`; it uses the
separate `<app_data_dir>/gmail-profile`, never the fixture database. Set the Google
client environment before launching:

```sh
EMAIL_OS_MODE=gmail \
EMAIL_OS_GOOGLE_CLIENT_ID='your-desktop-client-id.apps.googleusercontent.com' \
EMAIL_OS_GOOGLE_CLIENT_SECRET='optional-desktop-client-secret' \
mise run dev:native
```

The client secret is optional. It belongs only in the local launch environment,
not source control, frontend state, logs, or a shell history copied into a report.
The provider requests only `https://www.googleapis.com/auth/gmail.readonly`.
Missing/blank client ID shows `Not configured` in Gmail mode; it does not fail app
startup or fall back to the fixture. Unsupported Keychain platforms fail closed.

### Google Desktop OAuth setup (disposable account only)

For the explicitly approved Mac smoke path, use a dedicated Google Cloud project
and disposable Gmail account, not a primary/personal mailbox:

1. Enable the **Gmail API** in the project.
2. Configure the OAuth consent screen and add the disposable account as a test
   user when the app is in **Testing** status.
3. Create an OAuth client of type **Desktop app**. Put its client ID in
   `EMAIL_OS_GOOGLE_CLIENT_ID`; the optional client secret goes only in
   `EMAIL_OS_GOOGLE_CLIENT_SECRET` in the launch environment.
4. Confirm the only requested Gmail scope is `gmail.readonly`. Do not broaden the
   scope or add send/modify permissions.
5. On first use, review the macOS Keychain access prompt and allow the app to use
   its Gmail credential item. Credential-storage failures are visible and fail
   closed; there is no plaintext fallback.

Google OAuth clients left in Testing can issue refresh tokens that expire after
seven days for these Gmail scopes. Plan for a fresh sign-in during testing; this
is not a reason to log or persist tokens elsewhere. A terminal-launched Tauri
process inherits that terminal's environment. Finder-launched apps generally do
not inherit the shell's exported variables; if configuration appears missing,
use the documented launch environment for the app rather than silently selecting
fixture mode. Never paste secrets into the UI or a bug report.

Disconnect removes credentials from this app's Keychain item and clears the
local Gmail profile/cache. It is a **local disconnect**, not a promise to revoke
the Google grant or revoke tokens remotely; revoke authorization through the
Google account controls separately if required.

### Gmail sync pacing and rate limits

The disposable-account diagnostic observed HTTP 403 `rateLimitExceeded` after
~60 rapid thread reads, so discovery is paced for read-only Gmail quotas:
`threads.list` discovery pages request 25 threads (the overall disclosed cap
stays 100 conversations), consecutive Gmail API reads are separated by a
100 ms minimum interval whose wait aborts promptly on cancellation, and a
mid-page failure commits the threads already fetched (the page token is not
advanced), so a rate-limit retry or restart resumes from durable progress
instead of re-fetching saved threads. HTTP 403 is classified by bounded
structured Google error reasons: only genuine quota rejections (e.g.
`rateLimitExceeded`, `userRateLimitExceeded`, `dailyLimitExceeded`,
`quotaExceeded`, `resourceExhausted`) surface as `rate_limited`; permission
denials and unclassifiable bodies surface as the generic provider error. Raw
response bodies, messages, mailbox data, or URLs with IDs are never logged or
exposed over IPC.

### Disposable Mac smoke checklist (Slice 02 still pending)

Run only on the operator-approved disposable-account Mac path:

- Verify fixture is the default, `EMAIL_OS_MODE=gmail` is explicit, and missing
  client ID reports `Not configured` without fixture rows.
- Connect, complete the system-browser OAuth/loopback callback, cancel once, and
  verify cancellation is recoverable; confirm Keychain credentials survive an
  app restart without exposing them.
- Complete bounded initial discovery, inspect plain-text content and unsupported
  content disclosures, and verify archive controls/shortcuts are absent.
- Quit, disable network, relaunch, and read cached conversations offline; restore
  network and sync. Change/archive/delete a thread using the external disposable
  Gmail client and confirm catch-up updates the local inbox without skipping the
  expired-cursor recovery path.
- Disconnect and confirm local cache/credentials are cleared while understanding
  that Google authorization itself is not remotely revoked.

No real-account OAuth, Gmail network, or macOS Keychain behavior was tested in the
Linux integration VM. The operator's earlier Slice 01 Mac validation is a separate
completed gate; Slice 02 macOS Keychain, browser, OAuth, offline/restart, external
change, and disposable-account smoke gates remain pending.

## Native prerequisites and platform limits

The Linux Tauri build needs GTK/WebKitGTK development packages and `pkg-config`,
e.g. on Debian/Ubuntu:

```sh
sudo apt install pkg-config libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev
```

(Also linkable alternatives: `libsoup-3.0-dev` and
`libjavascriptcoregtk-4.1-dev` are WebKitGTK dependencies; macOS uses Xcode
command line tools and WKWebView.) Do not install OS packages as part of a
headless integration check. This VM lacks `pkg-config`/GTK prerequisites, so
native compile/test gates are expected to stop at the prerequisite check here.
Linux cannot validate macOS WKWebView/IME, Keychain prompts, system browser
launch, loopback OAuth interaction, or Google TLS behavior.

## Fixture data

Fixture mode uses only synthetic `fixture-account`, `conv-01`…`conv-18` rows,
seeded once; it never resets provider facts or operation history. Gmail mode has a
separate SQLite schema/profile and bounded cache. Neither mode logs subjects,
addresses, bodies, OAuth codes, or credentials. Gmail history catch-up does not
import arbitrary newly observed archived-thread bodies; the disclosed cache is
limited to up to 100 discovered conversations and may omit inbox threads outside
the bounded view.
