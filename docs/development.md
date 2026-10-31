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
the slice contracts for individual acceptance scope.

## Layout

| Path | Owner |
|---|---|
| `crates/mail-core/` | Rust DTOs, fixture core, Gmail provider/auth/cache/sync/actions, SQLite, profile locks |
| `src/`, `tests/`, `package.json`, configs | Vue 3/TypeScript frontend, IPC adapter and tests |
| `src/lib/ipc/generated.ts` | **Generated** — do not edit by hand; regenerate with `mise run gen:ts` |
| `src-tauri/` | Thin Tauri 2 shell: typed mail/draft/close commands, `mailbox_changed` and `drafts_changed` hints, fixture/Gmail profile selection and lifecycle |
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
Partial results are worded honestly ("Undo accepted for 1 of 2; 1 skipped —
failed"), and per-member failures stay recoverable in Activity regardless of
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

## Native prerequisites and platform limits

The Linux Tauri build needs GTK/WebKitGTK development packages and `pkg-config`,
e.g. on Debian/Ubuntu:

```sh
sudo apt install pkg-config libglib2.0-dev libgtk-3-dev libwebkit2gtk-4.1-dev
```

(Also linkable alternatives: `libsoup-3.0-dev` and
`libjavascriptcoregtk-4.1-dev` are WebKitGTK dependencies; macOS uses Xcode
command line tools and WKWebView.) Do not install OS packages as part of a
headless integration check. During UX-05 integration the UX-05 core lane did
install these prerequisites in the Linux integration VM (`pkg-config
libglib2.0-dev librsvg2-dev libwebkit2gtk-4.1-dev libsoup-3.0-dev
libjavascriptcoregtk-4.1-dev libgtk-3-dev`), so native compile/bridge gates now
run there; a fresh VM still needs the setup above. Native gates cannot validate
macOS WKWebView/IME, Keychain prompts, system browser
launch, loopback OAuth interaction, or Google TLS behavior.

## Fixture data

Fixture mode uses only synthetic `fixture-account`, `conv-01`…`conv-18` rows,
seeded once; it never resets provider facts or operation history. Gmail mode has a
separate SQLite schema/profile and bounded cache. Neither mode logs subjects,
addresses, bodies, OAuth codes, or credentials. Gmail history catch-up does not
import arbitrary newly observed archived-thread bodies; the disclosed cache is
limited to up to 100 discovered conversations and may omit inbox threads outside
the bounded view.
