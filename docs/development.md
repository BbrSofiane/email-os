# Development guide

This repository contains two deliberately separate native profiles: the durable
synthetic fixture slice (Slice 01) and an explicit Gmail profile built in stages.
Slice 02 adds system-browser OAuth/PKCE, a macOS Keychain credential store,
bounded inbox caching, and background sync. Slice 03 adds opt-in, durable Gmail
archive/unarchive and explicit read/unread actions; Gmail remains read-only until
the user explicitly requests the broader Google `gmail.modify` permission.
Slice 04 adds a local-only plain-text composer and durable draft recovery, but
still does not send/delete mail or expose arbitrary labels. Opening a message
never marks it read. UX-05 adds bounded multi-select and durable bulk
archive/read group processing with one-level partial group Undo; the browser
preview remains synthetic and in-memory. See
the slice contracts for individual acceptance scope. UX-08 adds narrow Gmail-mode
Star/Unstar singles/groups, durable Undo/reconciliation, cache-only Starred and a
single cached starred filter; see [its contract and validation ledger](ux-08-stars.md).
The legacy native fixture remains archive-only; unsupported star controls are
absent there. No real provider writes are authorized by implementation tests.
UX-06 adds one durable local
sender/domain split over Inbox, exact cached-count badges, and a single unread
filter. See [the saved-split contract](ux-06-saved-split.md) for matching,
keyboard navigation, cache coverage, and persistence boundaries.

## Layout

| Path | Owner |
|---|---|
| `crates/mail-core/` | Rust DTOs, fixture core, Gmail provider/auth/cache/sync/actions, SQLite, profile locks |
| `src/`, `tests/`, `package.json`, configs | Vue 3/TypeScript frontend, IPC adapter and tests |
| `src/lib/ipc/generated.ts` | **Generated** — do not edit by hand; regenerate with `mise run gen:ts` |
| `src-tauri/` | Thin Tauri 2 shell: typed mail/draft/close commands, `mailbox_changed` and `drafts_changed` hints, fixture/Gmail profile selection and lifecycle |
| `mise.toml` | Project tasks (see below) |

## UX-09 increment A: read-only provider mail

The **Provider mail** rail entry (Gmail native or labelled browser preview) opens
a bounded destination browser for Sent, provider Drafts, All Mail, Spam, Trash
and user labels. Search covers the loaded catalog; Show more expands it. It is
not mailbox search. All Mail excludes Spam/Trash. Every page contains at most
25 conversations, at most 16 MiB of serialized thread DTOs, and no exact total.
The read-only drawer intentionally has no triage/reply controls. Its page remains
mounted during a reader visit; closing the drawer returns to the prior inbox
context. This is not yet the roadmap's integrated main-list destination context.

Native commands `list_provider_destinations(accountId, cached)` and
`browse_provider_destination(request)` run off the UI thread, require the active
account, and use readonly Gmail APIs. Page cursors carry account+destination
identity and a bounded opaque provider token; they grant no authority.
A separate SQLite table retains one catalog and up to 20 destination snapshots
(latest successful page per retained destination), independent of inbox discovery,
history and operation recovery. **Use saved catalog/page** is explicit and
timestamped; provider failures are never silently converted to saved success or
an empty list. Restart retains these snapshots; disconnect clears them.

Provider Drafts are read-only snapshots, **not** the app's local editable drafts.
The native fixture rejects both provider commands; browser preview models them
in memory only. Label/Move, label badges on ordinary inbox rows, palette integration,
and saved-view/search criteria are not implemented here. After rebasing onto
`b4972ee`, the UX-06/07/08 contracts are preserved but not extended by this
increment. See [the increment contract](ux-09-provider-destinations.md)
for evidence and remaining gates.

## Tooling

All commands run through [mise](https://mise.jdx.dev) (pinned: node 24.4.1,
pnpm 10.18.0, rust 1.89.0). First-time setup:

```sh
mise trust           # after inspecting the repository's mise.toml
mise install         # install the project-pinned runtimes/tools
mise run setup:linux  # Debian/Ubuntu VMs only; installs OS packages with apt-get
mise run install:ui   # locked frontend dependencies (pnpm install --frozen-lockfile)
```

Rust dependencies resolve via the committed `Cargo.lock` on first `cargo`/`mise` use;
no global configuration is needed.

### Local-only `mise.local.toml`

`mise.local.toml` is **gitignored and machine-local** (`/mise.local.toml` in `.gitignore`):
it holds no secrets and must never be committed. Create it in every checkout/worktree you
use, with this canonical content:

```toml
# Local-only launcher; OAuth credentials live outside this repository.
[tools]
# Hermetic Python provider for the dev:gmail shim (no system python3 needed).
uv = "0.13.7"

[env]
# Stable local code-signing identity for the tauri dev binary. Without this,
# every rebuild is ad-hoc signed and the macOS keychain "Always Allow" grant
# for the mail-core-gmail item no longer matches, re-triggering the prompt.
APPLE_SIGNING_IDENTITY = "email-os-dev"

[tasks."dev:gmail"]
description = "Run native Gmail mode using the private local Desktop OAuth client"
run = 'uv run --no-project "$HOME/.config/email-os/dev-gmail.py"'
```

Why each piece:

- **`[tools] uv`** — pins uv (installed by `mise install`). The `dev:gmail` task runs its
  shim via `uv run --no-project`, so no system `python3` is needed, no project venv is
  created, and the stdlib-only shim runs on a uv-managed CPython. Bump the pin when you
  want a newer uv (`0.13.7` is the current latest).
- **`[tasks."dev:gmail"]`** — runs `~/.config/email-os/dev-gmail.py`, which loads the
  Desktop OAuth client from `~/.config/email-os/google-desktop-client.json` (outside the
  repo), validates the expected `project_id`, exports `EMAIL_OS_MODE=gmail` plus the
  client env vars, and execs `mise run dev:native`. It never prints the client secret.
  Validate the config without launching the app or making any Google request:
  `mise x -- uv run --no-project "$HOME/.config/email-os/dev-gmail.py" --check`
- **`[env] APPLE_SIGNING_IDENTITY`** (macOS only) — without this, the tauri dev binary is
  ad-hoc signed and every `cargo` rebuild changes its signature; keychain "Always Allow"
  grants are tied to the code signature, so the `mail-core-gmail` keychain prompt reappears
  on every `mise run dev:gmail`. Signing the dev binary with a stable local certificate
  keeps a single grant across rebuilds.

One-time macOS keychain setup:

1. **Keychain Access → Certificate Assistant → Create a Certificate**: name it
   `email-os-dev`, identity type *Self Signed Root*, certificate type **Code Signing**
   (default validity 1 year; recreate with the same name when it expires, then re-allow
   once).
2. Run `mise run dev:gmail` once and click **Always Allow** on the "email-os wants to use
   your confidential information stored in `mail-core-gmail`" prompt. The grant is pinned
   to the `email-os-dev` identity, so rebuilds no longer prompt.
3. Do **not** set the keychain item's Access Control to "Allow all applications to access
   this item" — that silences the prompt forever but lets *any* app running as you read
   the Gmail tokens silently. Keep the per-app grant.

The stored token is one keychain generic-password entry (service `mail-core-gmail`,
account `single-profile`, `WhenUnlockedThisDeviceOnly` — local, not synced to iCloud).
To rotate/disconnect, delete it (`security delete-generic-password -s mail-core-gmail -a
single-profile`) or use the app's disconnect action; the next `mise run dev:gmail` starts
a fresh OAuth flow. Never paste credentials into the app, logs, screenshots, or reports.

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
printed localhost URL. UX-13A mounts two explicitly synthetic **in-app account
workspaces**, each with its own labelled in-memory client and the same conversation
IDs. These are not native tabs. Switch with the account buttons or the supported
Switch account command; the current local editor must save/recover successfully
before leaving. Each workspace retains navigation/Back, selection, command query,
reader state, focus and scroll. There is no mail-search capability on this UX-05
base (UX-06/07 are absent), real OAuth, credentials or mailbox access in preview.
Native mode remains a single account/window and exposes no switch command. See
[UX-13A's contract and remaining gates](ux-13-independent-workspaces.md).

**Native fixture mode (default):** `mise run dev:native`. This opens the synthetic
fixture profile under `<app_data_dir>/fixture-profile`; local drafts are stored
separately beneath `<app_data_dir>/fixture-profile/local-drafts`. The fixture
provider's optional demo behavior is selected with
`EMAIL_OS_FAKE_PROVIDER=paused|reject|success` (default: success). Profile locks
reject a second writer to the same mail or draft profile.

**Explicit native Gmail mode:** launch with `EMAIL_OS_MODE=gmail`; it uses the
separate `<app_data_dir>/gmail-profile`, never the fixture database. Local drafts
are in the separate `<app_data_dir>/gmail-profile/local-drafts` profile; disconnect
retains those drafts on this device for the same account after reconnect. Set the
Google client environment before launching:

```sh
EMAIL_OS_MODE=gmail \
EMAIL_OS_GOOGLE_CLIENT_ID='your-desktop-client-id.apps.googleusercontent.com' \
EMAIL_OS_GOOGLE_CLIENT_SECRET='optional-desktop-client-secret' \
mise run dev:native
```

The client secret is optional. It belongs only in the local launch environment,
not source control, frontend state, logs, or a shell history copied into a report.
Initial connection requests only `https://www.googleapis.com/auth/gmail.readonly`.
Missing/blank client ID shows `Not configured` in Gmail mode; it does not fail app
startup or fall back to the fixture. Unsupported Keychain platforms fail closed.
Mailbox controls stay disabled until the user selects **Enable mailbox actions**
and Google returns a verified modify grant for the same authenticated account.
That upgrade requests `https://www.googleapis.com/auth/gmail.modify`; Google's
scope is broader than this app's implemented archive/unarchive and read/unread
commands and can authorize other mailbox changes (including sending or deleting
mail). The app does not provide those broader actions, arbitrary labels, or a
composer. Denial or cancellation leaves the read-only account and cached reading
available.

### Google Desktop OAuth setup (disposable account only)

For the explicitly approved Mac smoke path, use a dedicated Google Cloud project
and disposable Gmail account, not a primary/personal mailbox:

1. Enable the **Gmail API** in the project.
2. Configure the OAuth consent screen and add the disposable account as a test
   user when the app is in **Testing** status.
3. Create an OAuth client of type **Desktop app**. Put its client ID in
   `EMAIL_OS_GOOGLE_CLIENT_ID`; the optional client secret goes only in
   `EMAIL_OS_GOOGLE_CLIENT_SECRET` in the launch environment.
4. Confirm initial connection requests only `gmail.readonly`. The separate
   **Enable mailbox actions** flow requests Google's broader `gmail.modify` scope
   only after explicit user opt-in; do not add any other Gmail scopes.
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

### Disposable Mac smoke checklist (Slice 02 prior operator validation)

Run only on the operator-approved disposable-account Mac path:

- Verify fixture is the default, `EMAIL_OS_MODE=gmail` is explicit, and missing
  client ID reports `Not configured` without fixture rows.
- Connect, complete the system-browser OAuth/loopback callback, cancel once, and
  verify cancellation is recoverable; confirm Keychain credentials survive an
  app restart without exposing them.
- Complete bounded initial discovery, inspect plain-text content and unsupported
  content disclosures, and verify archive controls/shortcuts remain absent until
  the separate explicit Slice 03 permission upgrade is enabled.
- Quit, disable network, relaunch, and read cached conversations offline; restore
  network and sync. Change/archive/delete a thread using the external disposable
  Gmail client and confirm catch-up updates the local inbox without skipping the
  expired-cursor recovery path.
- Disconnect and confirm local cache/credentials are cleared while understanding
  that Google authorization itself is not remotely revoked.

No real-account OAuth, Gmail network, or macOS Keychain behavior was tested in the
Linux integration VM. The operator's earlier Slice 01 validation and prior Slice 02
Mac validation are separate gates; neither substitutes for the new Slice 03
consent, mutation, recovery, and external-change checks.

### Mailbox-action validation (Slice 03 still pending on Mac)

Run this only after the separate Slice 02 disposable-account checks, on the
operator-approved disposable Mac account. Keep Gmail read-only until the explicit
upgrade button is chosen. Verify both grant and deny/cancel paths:

- On the read-only account, verify cached reading still works and opening a
  conversation does not mark it read. Request **Enable mailbox actions** only
  after reviewing the broader `gmail.modify` scope disclosure. Confirm the UI
  remains read-only/upgrading until authoritative account status reports a
  verified same-account grant. Deny OAuth and cancel an in-progress upgrade in
  separate runs; each must retain the old read credential, cache and reading
  access without reporting actions enabled. Upgrade cancellation is not
  disconnect and must not revoke a completed Google grant.
- With actions enabled, explicitly archive a conversation, then explicitly
  mark it read and unread. Confirm Activity distinguishes queued, applying,
  confirmed, failed and outcome-unknown; verify ordinary opening does not alter
  read state. Disconnect warning must explain that local pending operations are
  removed but confirmed remote Gmail changes are not undone and Google's grant
  is not revoked.
- Queue an archive while offline, restart, restore network, and verify durable
  Activity/recovery. Interrupted setter dispatch must be reconciled with a GET
  over its exact original message IDs before confirmation; it must not
  automatically POST again. A newer incoming message must not be added to an
  older operation's target snapshot. Use explicit Retry only for a failed or
  outcome-unknown operation and verify it creates a new request ID while
  retaining the old immutable targets; a retry can override the current state.
- Archive enough conversations to exercise the 100-conversation view cap,
  restart, and recover an archived conversation from Activity. The reader must
  identify a retained local recovery snapshot and warn Gmail may have newer
  messages or mailbox changes. Make an external archive/read change in the
  disposable Gmail client, sync, and verify provider facts update without
  erasing a newer pending local intent.

The Slice 03 provider, persistence, bridge and browser behavior is covered with
synthetic HTTP/fake-provider tests only in this VM. This new Mac checkpoint is
not satisfied by the operator's earlier Slice 02 validation; OAuth consent,
Keychain upgrades, native command registration and all Slice 03 scenarios remain
pending operator validation.

### Local drafts and normal close (Slice 04)

Native `list_drafts`, `get_draft`, `create_draft`, `save_draft`, and
`delete_draft` commands use a dedicated `local-drafts/drafts.db` with its own
profile lock and FULL/WAL transactions. The bridge derives account scope from
backend status rather than an account ID supplied by the UI; local drafts do not
require Gmail's `gmail.modify` permission. Disconnect retains local drafts,
but disconnect clears cached account identity, so native list/edit access resumes
after reconnecting the same account. Drafts from another account are never
returned by the selected account's commands.

Draft To/Cc/subject/body text is stored exactly as entered, including incomplete
recipients, whitespace and Unicode. Limits are 16 KiB each for To and Cc, 4 KiB
for subject, and 1 MiB for body; oversized values fail instead of truncating or
normalizing. This is local editor storage, not recipient validation or send
readiness. Revisions start at 1; save/discard use expected-revision checks.
Exact request retries return durable receipts; conflicting reuse of a key is
rejected. Receipts/tombstones do not store body content, and deletes do not let
late saves resurrect a draft. Only a committed receipt is a durable saved label.

Reply is only available for the explicitly selected latest message with complete
current non-retained plaintext and trustworthy metadata. A single From mailbox
is required. Absent Reply-To falls back to From; malformed, empty, group, or
ambiguous Reply-To fails closed. Display names do not expand, aliases and
plus/dot equivalence are not inferred, duplicate mailboxes are removed, and the
account's primary mailbox is excluded. Reply to the account's own latest sent
message is unsupported. A reply starts with empty Cc/body and one `Re:` prefix;
there is no reply-all, Bcc, signature, or automatic quoted text. Legacy cache
rows can use a readonly metadata-only Gmail fetch when online; cached metadata
hits are network-free. If that metadata is unavailable offline, reply preparation
is unavailable, while new-message and existing-draft editing remain local.

Native window Close and normal OS quit pause behind an in-memory
`app_close_requested` request. The UI flushes the current buffer, then completes
only that request after a durable receipt; failure/conflict cancels the request
and leaves the window and buffer open. Requests coalesce, stale IDs are rejected,
and completion without a pending native request cannot close the app. Browser
preview only models this protocol in memory and is never durable. Force quit,
crash, or power loss before a save ACK is not guaranteed to preserve the latest
keystrokes.

### Disposable Mac smoke checklist (Slice 04 pending)

Run only after the existing Slice 02 and Slice 03 operator checkpoints, using a
disposable Mac/profile and no production account:

- Edit recipient, subject, and body immediately before normal window Close and
  Cmd+Q in separate runs; restart and verify exact committed recovery.
- Inject a save failure and a stale-revision conflict during close; verify the
  app stays open, the buffer remains exact, the request is cancelled, and no
  saved label appears without a committed receipt.
- Verify cached/offline, readonly, and auth-expired editing needs no Gmail modify
  grant. Verify a legacy first Reply uses only the readonly metadata enrichment
  path when available.
- Disconnect/reconnect the same account and verify drafts remain on this device;
  switch account and verify no cross-account draft visibility or mutation.
- After reply creation evict/retain the source conversation and verify the
  immutable reply link survives while stale, retained, incomplete, or unsupported
  source preparation fails closed.
- Exercise idempotent retry, duplicate create before metadata reads, delete versus
  late save, and verify no send/outbox/provider-draft side effect.
- Verify fixture native restart recovery and that browser preview continues to
  label its memory-only drafts as non-durable.

Slice 04 synthetic core/UI checks pass in this VM. Native Tauri compile-check
currently stops at the missing `pkg-config`/GTK prerequisites described below;
no OS packages were installed. Native close handling and this Mac checkpoint
remain pending operator validation.

### Safe bulk selection and processing (UX-05)

Conversations can be selected in the Inbox/Done list with `X`, `Shift+J/K`,
Cmd/Ctrl-click, Shift-click ranges and per-row labelled checkboxes, bounded to
100 selected conversations per action (additive ranges; Select all loaded is
disabled with an explanation beyond the bound; selection clears on
context/account changes and survives reader visits with a visible bulk-scope
banner). Shared toolbar, palette and shortcut actions apply to the whole
selection when one exists (group path, even for one row); inline row actions
stay row-scoped, and Reply/open/navigation are never bulk.

A bulk action accepts one durable **operation group**: structure, duplicates,
bounds, request ID, active account and capability are validated before a single
SQLite transaction persists the group header, immutable per-member targets and
preimages, and per-member acceptance results. A gone/unactionable member becomes
a persisted typed rejection, not a fabricated failed provider operation;
all-rejected valid requests get an idempotent receipt and consume no Undo slot.
Same-request replays (including after restart) return the original receipt;
changed payloads are `request_id_conflict`. Archive/unarchive groups work in
fixture and Gmail mode; read/unread groups are Gmail-only, like the single
setters.

`Z` within the 10-second Rust-clock window undoes the latest top-level action,
whether a single or a group. A group Undo makes one durable attempt: queued
members are cancelled, applying/confirmed members are compensated from the
original preimages, and ineligible members (failed, unknown outcome, unknown
prior, already undone, acceptance-rejected) are explicitly skipped with reasons.
Partial results are worded honestly: the dock line stays short ("Restored 1 · 1
skipped — failed"; skips are named only when there are some) while its title and
accessible description keep the exact ledger ("Undo accepted for 1 of 2; 1
skipped (1 failed); …"), and per-member failures stay recoverable in Activity regardless of
current list rows. A rejected IPC acceptance is never treated as "nothing
happened": the UI keeps the original request ID and recovers via
`get_operation_group` / replay of the exact original request.

Browser-preview group behavior is modelled by the labelled in-memory fake, which
continues to disclose that it is non-durable; it makes no provider or storage
calls.

#### Disposable Mac smoke checklist (UX-05 pending)

Run only on the operator-approved disposable Mac path, after the Slice 02–04
checkpoints: actual `X`/`Shift+J`/`Shift+K`/Cmd-Shift-click selection and
clear/last-row focus, Escape clearing selection before leaving a context,
bulk Done/read against the fixture or disposable account, `Z` group Undo inside
and outside the window, restart recovery of group receipts and Activity members,
and VoiceOver selection/outcome announcements. Native IPC command registration
is covered only by the bridge tests in this VM; Gmail read-group remote
convergence (BROWSE-18) additionally requires the approved disposable account.

## UX-10 A — Read-only cached Trash (partial UX-10)

Gmail mode exposes **Go to cached Trash (read only)** in Commands and Destinations.
This lists known locally cached TRASH conversations, including operation-retained
snapshots; it does not discover Gmail Trash or claim mailbox-complete coverage.
Refresh is explicit, pagination is bounded, and Back preserves the loaded local
browsing state. Trash-origin readers omit mailbox actions and Reply. Opening
never marks read. The native fixture profile rejects this Gmail-only query;
browser-preview fixtures can simulate it in memory.

Observed per-message TRASH/SPAM facts now exclude those conversations from Inbox
and Done. Old profiles migrate with unknown (nullable) triage facts; unknown is
not asserted to be outside Trash/Spam. No mutation permission or provider write
was added. Existing archive/read durable intent, groups, Undo, Activity, local
drafts and close protections remain in place.

See [UX-10 bounded contracts and acceptance](ux-10-bounded-triage.md). Trash/recover
writes and Undo await a recovery-effects decision and a new durable dimension;
mute/spam writes, Important/Other, rules, Block and Unsubscribe are not enabled.
There is no permanent-delete/empty-Trash, arbitrary URL opener or send command.
Synthetic checks do not establish native WKWebView or remote Gmail convergence.
## UX-12 attachment capability and validation

See [UX-12 contract and evidence](ux-12-safe-attachments.md). The reader's Files
and links button (native Cmd+O) offers up to 32 cached descriptors and 32 literal
HTTP(S) links. No automatic read, file opening or URL dispatch occurs. Gmail
uses its existing readonly grant; only explicit Save issues attachment-endpoint
reads and decodes file bytes in Rust. Inline body-only parts without a fetchable
attachment ID are omitted; existing bounded full-thread reads can contain inline
payload fields, which are not decoded as attachments.
Missing/legacy descriptors need a sync; retained snapshots do not acquire new
provider authority. No attachment uploads, provider drafts or sending.

Saves create a unique file directly in OS Downloads with a `.download` suffix;
the frontend cannot supply a destination. Files never execute and must be
inspected/renamed outside the app. Cancel/dismiss discards an unfinished
transfer (a blocked HTTP call can take its existing 30-second timeout to return);
a completed save or process crash may leave an inert file. A lost save response
may leave a completed download; retries can create another unique file. Browser
preview only models a memory-only save and external handoff, not filesystem or
provider effects. External HTTP(S) dispatch currently targets macOS only.

PDF preview is **not implemented**: the restricted macOS platform sandbox and
compatibility spike has not passed. No PDF/HTML/Office document enters a webview,
trusted DOM or third-party viewer. Native build/bridge tests do not satisfy
WKWebView key handling, VoiceOver, Downloads permissions, OS browser dispatch,
or the PDF security spike. Disposable provider validation remains separately
operator-gated, not authorized by implementation work.

## Desktop-local reminder increment (UX-11, fixture only)

See [the frozen contract and acceptance evidence](ux-11-local-reminders.md) and
ADR 0001's explicit reminder-deferral amendment. Native synthetic fixture mode
supports H / Remind me for one Inbox conversation, explicit offset-bearing
RFC3339 time (or unscheduled Someday), default If no reply / Regardless, and
Reminders pending/returned/history destinations (also G then H and palette).
Cancel/recover and reschedule are revisioned, durable commands. Pending stages
are not provider confirmation; returned membership requires confirmed return.
The existing fixture worker executes while running and reconciles overdue work
on launch. No execution while fully quit, cross-device state or calendar.

**Not Gmail support:** reminder commands reject Gmail mode, and UI discovery
hides them. The ordinary browser fake deliberately has no reminder transport;
component tests inject a labelled synthetic capability but do not establish
SQLite or native convergence. Gmail's bounded cache is not complete fresh reply
evidence. Fresh thread reconciliation, pinned recovery inventory and atomic
Gmail reminder/setter acceptance remain concrete implementation blockers before
Gmail exposure. No credentials or real provider were used for this increment.

## Synthetic account workspaces (UX-13A)

### UX-13A validation boundaries

`tests/workspaces.component.test.ts` and `browser-fake.accounts.test.ts` exercise
two synthetic identities with colliding conversation/message/draft/request IDs,
late detail/list/action results, independent Back/focus/selection/command queries,
save-before-switch, failed saves and serialized pending saves. This is in-memory
frontend integration, not proof of native account/credential ownership.

The existing opt-in `tests/discovery.rendered.test.ts` CDP harness also contains a
`UX-13:` pointer/keyboard journey (isolated temporary Chromium profile). Run with
`EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chromium mise exec -- pnpm exec vitest run tests/discovery.rendered.test.ts -t 'UX-13:'`.
It checks actual inert focus rejection, independent IDs/selection, list scroll,
reader Back and exact account-local action outcomes. It does not test WKWebView
or native tabs. Existing core mail/Gmail/draft profile-lock tests remain the
exclusive-writer regression gate; frontend sessions are not native profile leases.
No IPC, command registration, permissions or Rust-generated TS change in UX-13A.

Native account expansion is blocked on approval of a registry/credential/lease/
close-coordinator design. Current `KeychainSecrets` is a single global
`mail-core-gmail` / `single-profile` entry, not one credential namespace per DB
directory. Do not run a second Gmail profile as a multi-account workaround.

## Native prerequisites and platform limits

For a Debian/Ubuntu Linux VM, run the explicit setup task once:

```sh
mise run setup:linux
```

It runs `apt-get update`, then installs the compiler tools, `pkg-config`,
GTK/WebKitGTK development libraries, `librsvg2-dev`, and `dbus-daemon`. WebKitGTK
pulls in its Soup and JavaScriptCore dependencies. It also installs `xvfb`,
`xauth`, `xdotool`, `openbox`, `x11-utils`, and `scrot` for native window capture.
It uses `sudo` unless run as root. Re-running it keeps installed packages and
installs any missing ones; apt may update the listed packages.

The task rejects non-Linux hosts and hosts without `apt-get` before any package
operation. Other Linux distributions need equivalent packages installed manually.
It does not install mise runtimes or frontend dependencies. No build, check, or
macOS task depends on it. Do not run OS setup as part of an integration check.
macOS still uses Xcode command line tools and WKWebView, with the existing local
signing setup above.

### Native screenshots on a headless Linux VM

Use synthetic fixture mode and an isolated temporary data directory. Start the
app in a virtual X11 desktop from the repository root:

```sh
export EMAIL_OS_CAPTURE_DIR="$(mktemp -d /tmp/email-os-capture.XXXXXX)"
echo "$EMAIL_OS_CAPTURE_DIR"  # use this path in the second terminal
xvfb-run -a --server-args='-screen 0 1280x900x24 -nolisten tcp' sh -c '
  printf "%s\n" "$DISPLAY" > "$EMAIL_OS_CAPTURE_DIR/display"
  printf "%s\n" "$XAUTHORITY" > "$EMAIL_OS_CAPTURE_DIR/xauthority"
  openbox &
  export GDK_BACKEND=x11 EMAIL_OS_MODE=fixture
  export XDG_DATA_HOME="$EMAIL_OS_CAPTURE_DIR/data"
  exec dbus-run-session -- mise run dev:native
'
```

Wait for the native window to load. In a second terminal, set the printed path:

```sh
export EMAIL_OS_CAPTURE_DIR=/tmp/email-os-capture.XXXXXX  # replace with printed path
export DISPLAY="$(cat "$EMAIL_OS_CAPTURE_DIR/display")"
export XAUTHORITY="$(cat "$EMAIL_OS_CAPTURE_DIR/xauthority")"
xdotool windowactivate --sync "$(xdotool search --onlyvisible --class email-os | head -1)"
scrot -u -b "$EMAIL_OS_CAPTURE_DIR/native-inbox.png"
```

Use `xdotool` mouse/keyboard actions to open a conversation or Commands, then
capture another PNG. Stop the first terminal with Ctrl+C when finished. The
temporary directory retains the screenshots and isolated fixture data.
The default native task starts Vite on port 5173; free that port before launch.
For browser captures, run `mise run dev:web` and open its URL in the browser;
browser preview uses separate in-memory fixtures.

Linux native screenshots exercise WebKitGTK and the Rust fixture backend.
They do not validate macOS WKWebView/IME, Keychain prompts, system browser
launch, loopback OAuth interaction, or Google TLS behavior. Keep those Mac gates
separate. No sandbox or app security setting needs to be disabled for capture.

## Fixture data

Fixture mode uses only synthetic `fixture-account`, `conv-01`…`conv-18` rows,
seeded once; it never resets provider facts or operation history. Gmail mode has a
separate SQLite schema/profile and bounded cache. Neither mode logs subjects,
addresses, bodies, OAuth codes, or credentials. Gmail history catch-up does not
import arbitrary newly observed archived-thread bodies; the disclosed cache is
limited to up to 100 discovered conversations and may omit inbox threads outside
the bounded view.
