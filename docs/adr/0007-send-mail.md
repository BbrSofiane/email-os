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
| Queue in the operation ledger | Recovers the user's intent and the dispatch state independently of the editor. Requires an atomic handoff from the saved draft and separate retry rules for an irreversible operation. |

[Gmail send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send),
[Gmail drafts lifecycle](https://developers.google.com/workspace/gmail/api/guides/drafts),
[Gmail draft send endpoint](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send).

## Decision (proposed)

Use `users.messages.send` with an immutable send intent in the operation ledger.
It preserves local draft ownership, requires only one sending write, and lets the
same core enforce the recovery rules on both platforms and in fixture mode.

### Consent and identity

Keep initial sign-in read-only. **Enable sending** explains that the app will be
allowed to send mail from the connected address. Use track B's same-account
scope-upgrade mechanism to request
`https://www.googleapis.com/auth/gmail.send` alongside the existing access.
Track D owns the disclosure, trigger and send capability. Track B owns OAuth,
scope verification, refresh and secure credential storage. Require a verified
send grant and explicit send enablement for that account. An existing
`gmail.modify` grant is sufficient at the endpoint but does not enable sending
in the app. Verify with track B that the upgrade can return a usable send grant
for an account that already has modify access without dropping its existing
read and mailbox-action access. Missing, denied or cancelled consent preserves
the draft and prior access. Returning from consent never queues a draft.
Recheck account identity and the grant immediately before dispatch. Loss of
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
  so the confirmation shows the actual envelope. Reject controls in headers,
  invalid addresses and oversized input under the existing draft bounds.
  Preserve Unicode and line breaks in the body. Local saves can still hold
  incomplete editor text. Show an empty subject explicitly in confirmation.
- For a reply, use the persisted, account-bound reply link for the exact
  source the user chose. Set `In-Reply-To` to the source RFC Message-ID and
  `References` to the validated chain ending in that ID. Supply the provider
  conversation ID as JSON `threadId`. Persist the source subject when
  preparing new reply drafts and allow the normal `Re:` prefix. For an older
  draft without that subject, verify it against exact-source metadata on
  demand and leave the draft editable if the read is unavailable. A missing
  or invalid link or a mismatched subject blocks threaded send and offers a
  deliberate Save as new. A newer message arriving
  in the thread does not retarget an existing reply. Use the provider's
  returned thread ID if it differs from the requested one.
  [Internet Message Format](https://datatracker.ietf.org/doc/html/rfc5322),
  [Gmail threading requirements](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages#Message).

### Outbox, recovery and draft lifecycle

Use the existing account-scoped ledger and serial worker, with a distinct send
operation and payload. Send does not enter label preimages, group actions or
Undo selection. Put send-capable draft rows, revision receipts and tombstones in
the same profile SQLite transaction boundary as the ledger. Under the profile
lock, import existing `local-drafts/drafts.db` rows and request receipts with
IDs, revisions, content and reply links intact. Record the import marker in the
same transaction. A failed import leaves the source intact and a restart after
commit never imports it again. Retire the old draft store only after a verified
commit. Preserve the existing durability settings and fixture transition.

Send confirmation flushes the editor and submits a request ID, DraftRef and
expected revision. In one transaction check account, revision and eligibility,
persist the frozen MIME and original request receipt, and lock the draft
against edit, discard or another live send. Replaying the same account and
request ID with the same arguments returns the original receipt even after
confirmation. Changed arguments conflict. A second request ID cannot claim a
draft already locked by pending or unknown work. The worker checks the session
generation and uses the same-account credential for dispatch. Nothing holds a
database transaction open across provider I/O.

| Ledger state | Behavior |
| --- | --- |
| Pending, queued | The accepted draft is durable. The worker waits for connectivity and same-account access, then sends while the app is running. Preflight errors known to precede dispatch leave it queued with a status reason and backoff. **Cancel queued send** restores the editable draft and atomically wins or loses against the dispatch claim. There is no timed delay or Undo Send. |
| Pending, applying | Commit an applying marker immediately before the first possible POST. Stop accepting cancellation of the send once this marker commits. Disable transport-level redirects and POST retries for this endpoint. Process exit before the marker leaves a queued intent. Exit after the marker, including after provider acceptance but before local confirmation commits, recovers as unknown. |
| Confirmed | A valid successful send response with authoritative message and thread IDs, or positive Sent evidence, confirms provider acceptance for sending. In the same commit, persist those IDs, delete the draft with a tombstone, and remove the frozen payload. The receipt remains queryable after cleanup. “Sent” reports provider acceptance. Recipient delivery is outside the app's evidence. |
| Failed | A documented, definitive provider refusal or an unrecoverable pre-dispatch validation failure leaves the draft intact and editable. For a retryable refusal, an unchanged revision can be retried explicitly from the latest failed attempt with a new request ID and a link to that attempt, reusing the frozen identity and MIME. Editing the draft invalidates the old retry and requires new confirmation. |
| Outcome unknown | A transport failure after dispatch becomes possible, an ambiguous response (including a 5xx or unusable success receipt), or an interrupted applying row takes this path. Keep the draft available read-only with the original intent. Neither the worker, a reconnect, nor a generic Activity Retry can POST it again. Later operations can continue. |
| Cancelled before dispatch | Retain the receipt, release the draft and discard the frozen payload. A later send requires a new confirmation and request ID. |

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
intent, including in fixture mode. A deliberately composed separate message is
a separate intent. [Gmail search API](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list),
[Gmail error guidance](https://developers.google.com/workspace/gmail/api/guides/handle-errors).

Disconnect cancels work still queued at the dispatch barrier and restores those
drafts. Work that crossed the barrier remains confirmed or unknown according to
the available evidence. Keep account-scoped local draft locks and minimal send
receipts needed to recover unknown or confirmed sends across same-account
reconnect. Other accounts see none of them. Update disconnect copy to explain
that queued sends are cancelled and that a send already started may have gone
through. Continue clearing credentials and the ordinary cache on disconnect.

### Editors, Activity and the reader

- Place **Send** in the shared desktop editor footer and in the compact compose
  sheet header beside X for both new messages and replies. Keep X and Escape
  as save-and-close actions. Replace blanket “never sent” copy on send-capable
  surfaces with “Local draft” or “Saved on this device.” Keep the Send target
  reachable with the keyboard open. Enter in any editor field does not send.
- Open an accessible confirmation showing the verified From, every To/Cc and
  the subject of the saved revision. Cancel returns focus to the editor.
  A concurrent edit invalidates confirmation. Disable duplicate submission and
  recover an interrupted IPC response by replaying the same request ID.
  Close the editor after durable acceptance and announce “Queued to send.”
- Use an Outbox section in Activity in both layouts, with persistent rows and
  short status copy. Show “Queued to send,” “Sending…,” “Sent,” “Send failed,”
  or “Send outcome unknown,” with a reason/action as appropriate. A failed
  draft is available to reopen. Unknown shows Check status and explains that
  the message may already have been sent. Drafts directs pending and unknown
  items to their outbox status rather than to an editable composer.
- After confirmation, fetch the exact returned thread through the account-fenced
  read path. Merge provider messages by provider message ID and invalidate
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
for manual fixture validation without credentials. The browser fake models the
same observable states and controls in memory.

## Scope and out of scope

Include new messages and replies with plain-text bodies, To and editable Cc,
on macOS and Android in fixture and supported Gmail profiles. Sending a reply
uses the existing Reply-To or From defaults. The browser fake supports UI
validation with synthetic data.

Defer reply-all, forward, Bcc, attachments, HTML composition, alias selection,
provider-synced drafts, scheduled send, Undo Send and sending while the app is
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
   deny/cancel, grant and return to the draft, a new send and a threaded reply.
   Verify From, To/Cc as applicable, Unicode content, one message per attempt,
   provider Sent, recipient receipt and thread placement. Record observations
   without committing real addresses, message content or credentials.

## Dependencies

- **Track B, ADR 0005.** Needs to expose a reusable same-account scope upgrade
  and verified grants on macOS and Android, plus the appropriate refresh and
  disconnect fences. Track D supplies the exact send scope, disclosure and
  capability contract, including the existing-modify case. Fixture send and
  core tests can proceed independently of the live Android integration.
- **Track A, ADR 0004.** Supplies the installable Android build lane and the
  approved package/signing configuration used for the owner run. Track D
  supplies the send smoke steps and fixture evidence. Coordinate shared
  emulator use under the programme lock.
- **Track C, ADR 0006.** Plain-text sends use the existing renderer and the
  provider-observed reader model. Share the thread invalidation expectations
  with C so that a sent reply refreshes the same reader.

## Implementation plan

1. Add core send validation and MIME construction with an independent parse
   round-trip. Check focused MIME tests for Unicode, folding, body limits,
   injection, Reply-To-derived recipients, Cc and thread headers.
2. Put drafts and send admission in one profile transaction boundary, initially
   with the capability disabled. Check legacy import/reopen, failure before and
   after the import commit, and preservation of draft reply links and receipts.
3. Add send-specific claim, cancellation, completion and retry to the ledger.
   Check restart, concurrent claim/cancel, lost acceptance ACK, edits after
   failure, confirmed cleanup and the disconnect/account fences with a stub
   provider.
4. Implement the synthetic provider and fixed fault controls. Check native
   fixture integration through send, provider reopen, one-row thread projection,
   both unknown paths and exactly one invocation for a lost response.
5. Wire the bridge, generated IPC contract and in-memory fake. Check
   `mise run check:contract`, native bridge tests, and fake-client parity for
   pending, failed, confirmed and unknown. Keep live Gmail sending gated.
6. Wire the shared editor, confirmation, Activity and confirmed-thread refresh.
   Check component tests for draft flush and conflict, focus, permission return,
   failure and unknown copy, and rendered composer behavior at both widths.
7. Wire live Gmail send, targeted reads and consent against B's contract.
   Check mock HTTP requests, scopes, account verification, response boundaries,
   positive-only reconciliation, and the absence of POST retries. Keep the
   real-Gmail validation owner-run.

## Validation plan

- Run the focused MIME, migration, ledger and provider tests above. Cover
  malformed/empty address inputs, Unicode text, single-level Re threading,
  valid and invalid grants, denied consent, offline/reconnect, crash before
  and after dispatch, a lost IPC receipt, 5xx/timeout, delayed Sent visibility,
  missing evidence, repeated status checks, and stable provider-call counts.
  Test an archive/Undo alongside sending to check the existing ledger behavior.
  Run `CARGO_TARGET_DIR=/home/exedev/email-os/target CARGO_BUILD_JOBS=2 mise run check:all`
  and the rendered suites using the programme's shared build limits.
- Capture Chromium screenshots at desktop and phone widths using the
  repository's rendered screenshot harness and the configured
  `EMAIL_OS_RENDERED_LAYOUT_CHROME`. Capture both editors, confirmation,
  queued/failed/unknown Activity, and the confirmed reply in the thread. Use
  `mise run screenshots:mobile` for phone evidence and the rendered editor
  suite with a desktop viewport for desktop evidence.
- Under the emulator lock, use the T3 device session to capture Android fixture
  screenshots including the open keyboard, confirmation, Outbox status and
  reader. Record a fixture send from compose through confirmation to one sent
  message in the reader (`agent-device record`, at most 60 seconds). Exercise
  offline queue/restart and the two fault paths separately. Store small
  synthetic artifacts in `docs/validation/send/` and list larger video paths
  from `/home/exedev/email-os-usable/send/` in the PR.
- Record owner-only live results separately from fixture and mocked HTTP
  evidence. Include macOS Keychain and Android credential reuse across restart
  in the live check.

## Risks and open questions

- Gmail can accept a message before the app commits the receipt. Sent lookup
  can lag or fail to match the generated Message-ID. Approve leaving such an
  intent read-only and unknown indefinitely when positive evidence is absent?
- Approve manual Cc in the first release using the existing field, with Bcc
  deferred, and require changed-subject replies to be sent as new drafts?
- Can track B expose an explicit `gmail.send` grant for accounts already
  authorized for `gmail.modify` on both clients? Verify with the owner's test
  project before exposing live send to that account state.
