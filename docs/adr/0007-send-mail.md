# ADR 0007: Send plain-text mail on macOS and Android

**Status:** Proposed

## Context

- New messages and replies are plain-text local drafts with no send path
  ([docs/current-status.md:13](../current-status.md#runtime-availability)).
  The shell opens a separate draft database for the selected profile
  ([src-tauri/src/setup.rs:62](../../src-tauri/src/setup.rs#L62)).
  Draft saves and deletes use revision checks and durable request receipts
  ([crates/mail-core/src/drafts/store.rs:228](../../crates/mail-core/src/drafts/store.rs#L228)).
  Disconnect retains local drafts while clearing the Gmail cache and mailbox
  operation history ([crates/mail-core/src/gmail/store/profile.rs:301](../../crates/mail-core/src/gmail/store/profile.rs#L301)).
- Reply preparation already checks the displayed source, selects validated
  Reply-To or From mailboxes, and persists the source Message-ID and References
  alongside the conversation ID
  ([crates/mail-core/src/drafts/store.rs:540](../../crates/mail-core/src/drafts/store.rs#L540)).
  The draft model includes editable To, Cc and Subject fields
  ([crates/mail-core/src/drafts/types.rs:35](../../crates/mail-core/src/drafts/types.rs#L35)).
- Gmail starts with `gmail.readonly` and requests `gmail.modify` through a
  separate mailbox-actions upgrade
  ([crates/mail-core/src/gmail/auth.rs:26](../../crates/mail-core/src/gmail/auth.rs#L26)).
  macOS uses Keychain, and the existing Keychain adapter fails closed on other
  platforms ([crates/mail-core/src/gmail/secrets.rs:84](../../crates/mail-core/src/gmail/secrets.rs#L84)).
  Android currently selects fixture mode
  ([src-tauri/src/setup.rs:40](../../src-tauri/src/setup.rs#L40)).
- The ledger returns acceptance receipts after persistence and claims work before
  provider calls. Interrupted applying rows become outcome-unknown
  ([crates/mail-core/src/gmail/store/worker.rs:4](../../crates/mail-core/src/gmail/store/worker.rs#L4),
  [crates/mail-core/src/gmail/store/profile.rs:30](../../crates/mail-core/src/gmail/store/profile.rs#L30)).
  The current worker executes label setters. Its synthetic policy can requeue an
  interrupted setter whose intended state is absent
  ([crates/mail-core/src/gmail/operations.rs:160](../../crates/mail-core/src/gmail/operations.rs#L160)).
- The shared editor footer has Save and close on desktop and the compact sheets
  use a header X. The editor describes drafts as “never sent”
  ([src/components/DraftEditorCore.vue:101](../../src/components/DraftEditorCore.vue#L101),
  [src/components/DraftEditorCore.vue:366](../../src/components/DraftEditorCore.vue#L366),
  [src/components/ComposeCard.vue:120](../../src/components/ComposeCard.vue#L120),
  [src/components/ReplyComposer.vue:132](../../src/components/ReplyComposer.vue#L132)).
  ADR 0003 established these layouts. ADR 0002 established the shared synthetic
  provider seam.

## Options considered

| Option | Trade-off |
| --- | --- |
| Send the local draft via `users.messages.send` | One provider write and the narrow `gmail.send` scope. The API exposes no idempotency key. A lost response needs read-only reconciliation and can remain unresolved. |
| Create a Gmail draft, then use `users.drafts.send` | The stable draft ID provides another recovery clue, and a successful send consumes the draft. This also creates a remote draft visible to other clients, requires a broader compose-capable scope, and adds a create request whose own result can be lost. A missing draft can also mean deletion. |
| Send directly from the editor and wait for HTTP | Smaller initial change. Offline sends have to wait in the editor, and a lost IPC response or process exit leaves the app without a durable record of whether it already attempted the send. |
| Queue in the operation ledger | Recovers the user's intent and the dispatch state independently of the editor. Requires a recoverable handoff from the saved draft and separate retry rules for an irreversible operation. |
| Move drafts into the ledger database | Makes admission and terminal draft cleanup each a single transaction. Requires importing every existing draft and its request history, retiring the old store, and testing interruption and upgrade across both profiles. |
| Keep the draft store separate | Adds an operation-owned draft lock and startup repair across the two databases. The ledger remains authoritative, and existing draft data and request history stay in place. |

[Gmail send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send),
[Gmail drafts lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts),
[Gmail draft send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send).

## Decisions

### 2026-11-21

- The owner chose immediate Send with a **five-second Undo window** in both
  layouts. Keep recipients and subject visible, place Send apart from X, and
  omit a confirmation dialog.
- Undo cancels before dispatch and reopens the unchanged draft. An interrupted
  Undo window returns the draft to Drafts with “Not sent” on restart. If the
  window ends while offline, the intent stays queued until it can dispatch.
- Show the temporary Undo action after Send. Subsequent status belongs in
  Drafts and Activity, with no countdown or completion toast.

## Decision (proposed)

Use `users.messages.send` with an immutable send intent in the operation ledger.
It preserves local draft ownership, requires only one sending write, and lets the
same core enforce the recovery rules on both platforms and in fixture mode.

### Consent and identity

Keep initial sign-in read-only. **Enable sending** explains that the app will be
allowed to send mail from the connected address. Require this explicit in-app
step once per account, even when the credential already covers sending. Track
D owns the disclosure, trigger, send capability and the mapping from
`GmailGrant::Send` to `https://www.googleapis.com/auth/gmail.send`. Use
track B's `GmailProvider::request_grant(GmailGrant::Send, cancel)` on both
platforms. An already verified `gmail.modify` or `gmail.send` grant covers
the send request. When the mechanism reports already covered, persist in-app
enablement with no Google consent screen. Request `gmail.send` through OAuth
only when the account has neither grant. The upgrade requests the union of
existing scopes and the requested scope. Track B owns the generic mechanism,
including same-account OAuth, scope verification, refresh and secure
credential storage. Missing, denied or cancelled consent preserves the draft
and prior access. Enable sending never queues a draft.
Recheck account identity, in-app enablement and current grant coverage
immediately before dispatch. Loss of
permission pauses queued sends until the same account restores access and
explicitly resumes. Fixture mode exposes send capability without consent or
credentials. [Gmail scope reference](https://developers.google.com/workspace/gmail/api/auth/scopes).

### MIME and replies

- Build MIME in Rust with a standards-aware serializer and structured header
  values. Emit From, To, Cc when present, Subject, Date, Message-ID and
  MIME-Version. From is the verified primary mailbox of the active account
  (the fixture identity in fixture mode). Omit an editable From and alias
  selection. Use a single `text/plain; charset=UTF-8` part with base64 transfer
  encoding. Encode non-ASCII subjects as RFC 2047 encoded words, fold headers
  at legal boundaries, use CRLF framing and base64url-encode the complete MIME
  for the JSON `raw` field. Generate a random RFC Message-ID and fix the Date
  at acceptance. Persist both through retries of the same intent.
- Validate again in core at send time. Accept comma-separated, bare ASCII
  mailboxes with at least one To and at most 20 distinct recipients in To and
  Cc combined, using the existing reply mailbox validation rules. Flag duplicates
  during recipient review. Reject controls in headers,
  invalid addresses and oversized input under the existing draft bounds.
  Preserve Unicode and line breaks in the body. Local saves can still hold
  incomplete editor text. Show an empty subject explicitly during send review.
- For a reply, use the persisted, account-bound reply link for the exact
  source the user chose. Set `In-Reply-To` to the source RFC Message-ID and
  `References` to the validated chain ending in that ID. Persist the source
  subject when preparing new reply drafts. Supply the source conversation ID
  as JSON `threadId` when the subject matches apart from the normal `Re:`
  prefix. When the subject changes beyond that prefix, omit `threadId`, keep
  both reply headers, and show “This reply will start a new conversation” in
  the editor. The provider's returned thread ID determines where the message
  appears. For an older draft without the saved source subject, verify it
  against exact-source metadata on demand. A missing or invalid link or an
  unavailable required metadata read leaves the draft editable. A newer
  message arriving in the thread does not retarget the reply.
  [Internet Message Format](https://datatracker.ietf.org/doc/html/rfc5322),
  [Gmail threading requirements](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#Message).

### Outbox, recovery and draft lifecycle

Use the existing account-scoped ledger and serial worker, with a distinct send
operation and payload. Keep send separate from label preimages, group actions
and mailbox Undo selection. Keep `local-drafts/drafts.db` separate and add a per-draft
lock naming the send operation and the saved revision. The ledger holds the
authoritative outcome, draft ID and revision, and frozen MIME. A draft lock by
itself cannot dispatch. A crash before the ledger commit leaves a lock without
an intent. A crash after the commit leaves a durable intent with enough
information to repair draft state. Both cases recover under the profile lock, so the
single-transaction design does not justify importing existing drafts.

Send flushes the editor and submits a request ID, DraftRef and expected
revision. Under the draft lifecycle gate, look up the account-scoped request in the ledger
first, verify the active account and saved revision, commit the draft lock
with a reserved operation ID, then commit the queued intent and request
receipt in the ledger. Only the ledger commit permits dispatch and acceptance
acknowledgement. Save, discard, retry and another Send must respect the lock.
If the ledger commit returns an error, read the ledger before clearing the
lock. If the outcome of the local commit cannot be read, leave the draft
locked and surface the storage error until recovery. Replaying the same
account and request ID with the same arguments returns the original receipt
even after provider confirmation. Changed arguments conflict. The worker
checks the session generation and same-account credential at dispatch.
Provider I/O runs outside database transactions and the draft lifecycle gate.

At acceptance, persist a queued hold with a `not_before` time five seconds
after the ledger clock's acceptance time. Return the deadline with the
receipt. Under the ledger transaction, **Undo** cancels only the targeted
hold with time remaining. Commit cancellation and release the draft lock
through the existing repair path before reopening the same draft revision.
Replayed Undo requests return the prior result. At the deadline, the running
app commits a release to ordinary queued work, even while offline. Schedule
release independently of provider preflight and backoff so a slow provider
call cannot extend the window. Release and Undo are mutually exclusive. The
worker can claim only released work and only at or after `not_before`.

On startup, cancel any hold still awaiting release, even when its stored
deadline has passed. This restores the draft if the process exited just
after the deadline but before committing the release. Show “Not sent” in
Drafts. A persisted release lets a queued send resume normally.

Repair both stores at startup under the profile lock, before draft edits or
send dispatch. Run the same repair after interrupted local cleanup and before
reopening an affected draft:

- A lock with no ledger row unlocks after a successful authoritative lookup.
  A queued, applying or unknown ledger row keeps or restores the lock for its
  exact revision. A missing draft or conflicting revision blocks a queued
  dispatch and surfaces a storage error without overwriting newer text.
- A confirmed ledger row deletes the matching draft and writes a tombstone.
  A cancelled or failed row releases its lock. Cleanup is idempotent and
  compares the operation ID and revision before touching a draft. Keep the
  terminal ledger record through cleanup, including on disconnect. An already
  cleaned row cannot affect a newer lock or revision.
- If confirmation commits and draft cleanup fails, the ledger still says
  Sent. The original draft stays unavailable for editing or sending until
  cleanup succeeds. Startup and subsequent draft access retry local cleanup
  without another provider call.

| Ledger state | Behavior |
| --- | --- |
| Pending, queued during Undo | The draft and frozen intent are durable. Undo is available for five seconds from acceptance. The provider send cannot start. Undo or startup recovery of an unreleased hold returns the unchanged draft. |
| Pending, released and queued | The window has ended. The worker waits for connectivity and same-account access. Preflight errors known to precede dispatch leave the intent queued with a reason and backoff, including after restart. Activity retains **Cancel queued send**, which restores the editable draft if it wins against the dispatch claim. |
| Pending, applying | Commit an applying marker immediately before the first possible POST. Stop accepting cancellation once this marker commits. Disable transport-level redirects and POST retries for this endpoint. Exit after the marker, including after provider acceptance but before local confirmation commits, recovers as unknown. |
| Confirmed | A valid successful send response with authoritative message and thread IDs, or positive Sent evidence, confirms provider acceptance for sending. Commit those IDs and remove the frozen payload in the ledger, then delete the draft and write a tombstone through the repairable cleanup. The receipt remains queryable. “Sent” reports provider acceptance. Recipient delivery is outside the app's evidence. |
| Failed | A documented, definitive provider refusal or an unrecoverable pre-dispatch validation failure releases the draft lock through cleanup and leaves the draft editable. For a retryable refusal, an unchanged revision can be retried explicitly from the latest failed attempt with a new request ID and a link to that attempt, reusing the frozen identity and MIME. An edited draft requires a new send action. |
| Outcome unknown | A transport failure after dispatch becomes possible, an ambiguous response (including a 5xx or unusable success receipt), or an interrupted applying row takes this path. Keep the draft available read-only with the original intent. Neither the worker, a reconnect, nor a generic Activity Retry can POST it again. Later operations can continue. |
| Cancelled before dispatch | Retain the receipt, release the draft and discard the frozen payload. An explicit Undo reopens the editor. A later send starts with a fresh Send action and request ID. |

Retire a failed attempt's frozen payload when an edit, discard or newer
attempt supersedes its retry. Keep MIME, addresses, provider response bodies
and credentials out of routine diagnostics.

For an unknown send, check the expected reply thread and use bounded, paced Sent
lookup by `rfc822msgid:` on startup or a sync beat and via **Check status**. Use
the existing read access to fetch a candidate and verify its exact Message-ID,
Sent label and sender in the active account. Require an unambiguous positive
match. No match, incomplete results or a rewritten Message-ID leave the outcome
unknown. The generated ID correlates observations and does not make Gmail's POST
idempotent. The guarantee is no automatic or manual replay of that uncertain
intent, including in fixture mode. **Copy to a new draft** on an unknown row
shows “The first message may already have been sent” and creates a separate
editable draft with the original fields and a fresh draft ID. Copying makes
no provider call. Sending the copy
requires a separate Send action, a new ledger intent and a fresh Message-ID.
The original stays read-only and unknown until positive evidence or explicit
**Dismiss**. Dismiss hides it from Drafts and Activity while preserving the
ledger evidence and lock used to prevent replay. It does not mark the send as
failed or withdraw it. [Gmail search API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[Gmail error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

Disconnect cancels work still queued at the dispatch barrier and restores those
drafts. Work that crossed the barrier remains confirmed or unknown according to
the available evidence. Keep account-scoped local draft locks and minimal send
receipts needed to recover unknown or confirmed sends across same-account
reconnect. Other accounts see none of them. Update disconnect copy to explain
that queued sends are cancelled and that a send already started may have gone
through. Continue clearing credentials and the ordinary cache on disconnect.

### Editors, Activity and the reader

The owner chooses how much space to give send status in Activity. The
recommendation is compact send rows in the existing Activity list, with actions
on the selected row. A dedicated Outbox section in Activity would make pending
and unresolved sends easier to find at the cost of a separate section. Both
use the same ledger and Drafts links. Neither adds a countdown or a completion
toast.

- Place **Send** in the desktop editor and compact sheet footers, apart from
  the close control, for both new messages and replies. Keep it reachable above
  the phone keyboard. Keep the verified From, all recipients including
  populated Cc, and the subject visible in the editor, including when replying.
  Send flushes and queues the reviewed revision immediately. Keep X and Escape
  as save-and-close actions. Replace blanket “never sent” copy on send-capable
  surfaces with “Local draft” or “Saved on this device.” Enter in any editor
  field does not send.
- Disable duplicate submission and recover an interrupted IPC response by
  replaying the same request ID. Close the editor only after durable acceptance.
  Show validation and admission failures in the editor so the user can recover
  without losing the draft.
- After the editor closes, show an accessible **Undo** action in the existing
  notice area through the ledger deadline. Bind it to the specific send
  operation. A successful Undo reopens the preserved draft and returns focus
  to the editor. Expiry removes the action quietly. If a newer editor is open,
  save it through the normal close flow before switching to the restored draft.
- In both layouts, use persistent send rows with short status copy. Show
  “Queued to send,” “Sending…,” “Sent,” “Send failed,” or “Send outcome
  unknown,” with the relevant reason and action. A failed draft is available
  to reopen. Unknown shows Check status, Copy to a new draft and Dismiss.
  Drafts links pending and unresolved items to their status in Activity.
- After provider confirmation, fetch the exact returned thread through the
  account-fenced read path. Merge provider messages by provider message ID and invalidate
  reader detail/visible destination snapshots so the sent reply appears once
  without stealing focus. Give confirmed new messages an **Open conversation**
  action in Activity that can fetch sent-only threads outside Inbox discovery.
  Refresh failure leaves the send confirmed and the thread refresh retryable.
  Pending and unknown sends do not render an outgoing message as sent.

### Synthetic provider and browser fake

Use the same ledger, MIME and worker in native fixture mode. The synthetic
provider persists a Sent message on the requested thread or creates a new
thread without Inbox membership, and returns synthetic provider IDs. Use its
existing pause and one-shot rejection controls
([crates/mail-core/src/synthetic/provider.rs:35](../../crates/mail-core/src/synthetic/provider.rs#L35)).
Extend them with fixture-only one-shot outcomes for commit-then-lose-response
and lose-response-without-commit, with controllable Sent visibility for tests.
Keep scripted barriers in test support and make the fixed outcomes available
for manual fixture validation without credentials. Use the injected clock to
verify zero send calls during the window, after Undo, and after restart with
an unreleased hold. Verify one call after release and reconnection if the
window expires offline. Fault controls apply only after dispatch reaches the
synthetic provider. The browser fake models the same window, observable states
and controls in memory.

## Scope and out of scope

Include new messages and replies with plain-text bodies, To and editable Cc,
on macOS and Android in fixture and supported Gmail profiles. Sending a reply
uses the existing Reply-To or From defaults. The browser fake supports UI
validation with synthetic data.

Defer reply-all, forward, Bcc, attachments, HTML composition, alias selection,
provider-synced drafts, user-scheduled send and sending while the app is
fully quit. Linux and Windows desktop send and Gmail token storage are outside
this proposal. Keep the send capability unavailable on those native platforms.

## Owner actions

1. Before live consent validation, use the Google Cloud project that owns the
   existing macOS OAuth client and track B's Android configuration. Add
   `gmail.send` to the consent configuration for that project and make the
   disposable sender eligible for the applicable testing audience. Keep existing
   client configuration and secrets in their approved local channels. Before
   public distribution, confirm the project's verification requirements for the
   scopes used. [Google OAuth and scope requirements](https://developers.google.com/workspace/gmail/api/auth/scopes).
2. After fixture validation and after track B can authenticate the approved
   Android build, the owner runs real sends on macOS and Android. Use a
   disposable sender and a recipient inbox the owner controls. Exercise
   the read-only sender's deny/cancel and grant flows, returning to the draft
   after each. Also verify that a sender with verified modify access enables
   sending in the app with no Google consent screen. Exercise a new send, a
   threaded reply and a changed-subject reply.
   Verify From, To/Cc as applicable, Unicode content, one message per attempt,
   provider Sent, recipient receipt and thread placement. Record observations
   without committing real addresses, message content or credentials.
3. Before stage 6, choose compact Activity rows or a dedicated Outbox section.

## Dependencies

- **Track B, ADR 0005.** Supplies the generic `request_grant` mechanism,
  its already-covered result, verified grants, and refresh and disconnect
  fences on macOS and Android. Track D adds `GmailGrant::Send`, defines
  coverage by either verified send or modify scope, and owns the disclosure
  and capability. Stage 7 waits for B's merged mechanism.
- **Track A, ADR 0004.** Supplies the installable Android build lane and the
  approved package/signing configuration used for the owner run. Track D
  supplies the send smoke steps and fixture evidence. Coordinate shared
  emulator use under the programme lock.
- **Track C, ADR 0006.** Plain-text sends use the existing renderer and the
  provider-observed reader model. Share the thread invalidation expectations
  with C so that a sent reply refreshes the same reader.

## Implementation plan

Stages 1–6 and Android fixture build and validation can finish before track B
merges. Stage 7 starts after B's scope-upgrade mechanism is merged.

1. Add core send validation and MIME construction with an independent parse
   round-trip. Check focused MIME tests for Unicode, folding, body limits,
   injection, Reply-To-derived recipients, Cc and both reply subject cases.
2. Add the draft lock, ledger admission and two-store repair, initially with
   the capability disabled. Inject faults after the lock commit, after the
   ledger commit, and during terminal cleanup. Reopen and check both repair
   directions, receipt replay, and preservation of newer revisions.
3. Add the five-second hold and release, Undo, and send-specific claim,
   cancellation, completion and retry to the ledger. With a stub provider
   and injected clock, check Undo immediately before and at the deadline,
   competing release and cancellation, restart before and after durable
   release, lost acceptance ACK, edits after failure, confirmed cleanup and
   disconnect/account fences.
4. Implement the synthetic provider and fixed fault controls. Check native
   fixture integration through send, provider reopen, one-row thread projection,
   both unknown paths and exactly one invocation for a lost response. Verify
   Undo and restart of an unreleased hold make zero provider calls. Release
   while offline, then reconnect and verify one send.
5. Wire the bridge, generated IPC contract and in-memory fake. Check
   `mise run check:contract`, native bridge tests, and fake-client parity for
   pending, failed, confirmed and unknown, including dismissal and copying
   as a separate intent. Keep live Gmail sending gated.
6. Wire immediate Send, the temporary Undo action, Activity and confirmed-thread
   refresh. Check draft flush and conflict, exact draft restoration, keyboard
   focus, changed subject copy, failure, unknown actions and rendered behavior
   at both widths.
   Finish Android fixture build, screenshots and recording at this stage.
7. Wire live Gmail send, targeted reads and consent after B's merge.
   Check mock HTTP requests, scopes, account verification, response boundaries,
   in-app enablement without OAuth for an existing modify grant, the scope union
   for a read-only credential, positive-only reconciliation, and the absence of
   POST retries. Keep the real-Gmail validation owner-run.

## Validation plan

- Run the focused MIME, two-store recovery, ledger and provider tests above.
  Cover malformed/empty address inputs, Unicode text, matching and changed subjects,
  valid and invalid grants, denied consent, offline/reconnect, crash before
  and after dispatch, a lost IPC receipt, 5xx/timeout, delayed Sent visibility,
  missing evidence, repeated status checks, and stable provider-call counts
  when copying or dismissing an unknown send. Verify the Undo deadline with
  an injected clock and zero dispatches for Undo or an interrupted window.
  Verify a released offline send persists across restart and dispatches once
  when online. Test mailbox Undo alongside send Undo to check their isolation.
  Run `CARGO_TARGET_DIR=/home/exedev/email-os/target CARGO_BUILD_JOBS=2 mise run check:all`
  and the rendered suites using the programme's shared build limits.
- Capture Chromium screenshots at desktop and phone widths using the
  repository's rendered screenshot harness and the configured
  `EMAIL_OS_RENDERED_LAYOUT_CHROME`. Capture both editors with recipients
  and subject visible, the Undo action, quiet queued/failed/unknown Activity,
  and the confirmed reply in the thread. Use `mise run screenshots:mobile`
  for phone evidence and the rendered editor suite with a desktop viewport
  for desktop evidence.
- Under the emulator lock, use the T3 device session to capture Android fixture
  screenshots including the open keyboard, Undo, Activity status and the
  reader. In one fixture recording, press Send, tap Undo within five seconds,
  show the unchanged draft, then press Send again and allow the window to
  expire. Show one sent message in the reader (`agent-device record`, at most
  60 seconds). Separately exercise a kill during the Undo window, offline
  expiry and reconnection, and the two provider fault paths. Store small
  synthetic artifacts in `docs/validation/send/` and list larger video paths
  from `/home/exedev/email-os-usable/send/` in the PR.
- Record owner-only live results separately from fixture and mocked HTTP
  evidence. Include macOS Keychain and Android credential reuse across restart
  in the live check.

## Risks and open questions

- Gmail can accept a message before the app commits the receipt. Sent lookup
  can lag or fail to match the generated Message-ID. A copy can lead to a
  duplicate if the user sends it after the original went through. The copy
  disclosure and separate Send action make that choice explicit.
- Separate database commits add recovery paths. Draft edits and dispatch are
  gated on successful startup repair. A failed cleanup preserves the ledger
  receipt for recovery.
- Should Activity show compact send rows or a dedicated Outbox section?
  Recommend compact rows.
