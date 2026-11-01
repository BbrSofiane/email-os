# UX-11 — Bounded desktop-local reminders

Status: implemented bounded native-fixture increment; **not complete Gmail UX-11**. Source: browsing plan UX-11, source UX spec
manual reminders/BROWSE-13, ADR 0001 (amended before implementation).

## Capability boundary / prerequisites

This checkout is UX-05 at 6c30b9c. UX-06–10 are absent. No dependency on saved
splits, search, labels, or an Important/Other classifier is assumed. Implement
one single-conversation reminder in the durable native **synthetic fixture**
profile and a usable standalone pending/returned destination. Gmail is explicitly
unsupported: its bounded cache/history checkpoint is not fresh, complete reply
absence evidence; it also lacks reminder-owned retained inventories and atomic
reminder/setter acceptance. Do not wire a cached no-reply predicate into Gmail.
Provider support needs a separate implementation of fresh thread reconciliation,
generation fencing and pinned immutable inventories in Gmail's own transaction.
No real mailbox access, credential changes or provider writes are authorized.
Browser preview may disclose this boundary but must not pretend persistence.

## Frozen semantics

- Single account+conversation+explicit latest source message ID, no bulk reminder.
  Source must still be latest; baseline is **all** message IDs at acceptance.
  Require at least one effective INBOX message and no in-flight mailbox intent.
- Default condition `if_no_reply`; alternative `regardless`. Qualifying reply is
  any new ID in the same provider thread, outside the source inventory, with a
  From mailbox other than the exact primary mailbox (case-insensitive). No alias,
  RFC reply-header, delivery-order or display-name inference. Self messages do
  not qualify. Fixture DB is the complete synthetic provider inventory, not a
  model of Gmail cache completeness. Offline/incomplete Gmail never proves absence.
- Time input is strict RFC3339 with an explicit numeric offset or Z. Persist the
  original offset-bearing time and UTC instant: fixed-offset timezone, not an
  IANA wall-clock recurrence. Reject offset-free local times, natural language,
  leap seconds and past times. Thus DST gaps/folds cannot be silently guessed;
  user must choose the intended offset. No recurrence or calendar.
- `someday` = null due time; never auto-fires (including on incoming mail).
- Durable scheduling atomically snapshots original inbox IDs, stages archive
  intent, and stores the reminder. Only confirmed removal becomes pending.
  At due time, reconcile replies first; conditional replies suppress return,
  regardless returns. Return/cancel restores **only original inbox IDs**, never
  newer incoming or originally archived messages. New mail stays in Inbox; no
  repeated archive to hide it. No automatic read changes. The due transaction
  is the decision linearization point: incoming mail committed before it is
  checked; a reply arriving after return intent acceptance does not retroactively
  cancel that return. That later message is never a target of the old intent.
- Returned membership requires confirmed return, not merely queued intent.
  Pending includes removing/pending/returning/cancelling and failures, labelled
  by phase. Suppressed/cancelled history is distinct from returned. Returned is
  a persisted local return marker until the next reminder replaces it, not a
  provider folder or Important/Other classifier; subsequent ordinary triage
  does not erase that local history.
- Revision CAS serializes cancel/reschedule versus clock execution. Reschedule
  only a pending reminder, preserving its source inventory. Cancel while removal
  is in flight stages ordered exact-target restoration. Failed removal/return
  remains visible; explicit Cancel/recover stages restoration, never blind replay.
  A later independent mailbox action supersedes automatic restoration; mark
  failed and allow cancellation without overriding that newer user intent.
- Each command has a durable payload-fingerprinted request receipt; replay
  returns the original result even after newer revisions/restart. Same key with
  changed payload conflicts. Reminder intents do not consume the ordinary Undo
  slot; explicit Cancel/recover is the reminder recovery path. Existing single
  and group Undo continue to apply to their original immutable targets.
- Execute on the existing serial fixture worker while running; reconcile overdue
  reminders on worker start. Each transition and operation are one transaction.
  Restart is idempotent. Due times are not-before instants, not punctual delivery
  guarantees: the serial worker may be occupied by another intent. No execution
  guarantee while fully quit, no cross-device
  state, no notifications/calendar/send/AI/remote resources.

## Acceptance checklist

- [x] Rust-generated DTOs, typed named IPC, registration and permissions.
- [x] H picker only in supported mode, explicit immutable source, no bulk widening.
- [x] Pending/returned destination opens real cached conversations and offers
      revisioned Cancel/recover and reschedule; failures remain visible.
- [x] SQLite commit/replay/restart and fake clock/provider tests: fire once,
      conditional versus regardless reply, someday, self-message, cancellation,
      reschedule/fire CAS, failure, supersession, new-mail exact targets.
- [x] UI/transport tests, standard check/build gates.
- [ ] Native Mac/WKWebView/VoiceOver verification (separate operator gate).
- [ ] Gmail fresh-evidence/pinned-inventory implementation and approved disposable
      provider validation (not claimed by fixture tests).

## Executed evidence (synthetic/headless)

- `mise run gen:ts` generated Reminder/condition/phase/put/cancel types and named
  command constants from Rust; `check:contract` detects drift.
- `mise run check`: core synthetic tests, contract check, fmt/clippy, Vitest and
  typecheck pass (238 core tests; 462 UI tests passed, 20 opt-in rendered tests
  skipped). The final tree includes seven reminder storage/race tests,
  two fake-provider/worker integration tests, 22 reminder UI tests and
  one new exact-envelope transport test. Existing bulk/Undo/draft/close tests
  remain in the full suite. The opt-in rendered-browser suites are skipped by
  the ordinary check, not claimed as browser evidence.
- `mise run build:web`: production build passes.
- `mise run check:native`: native shell all-target compile passes in this Mac
  checkout. `mise run test:native`: eight bridge/close-gate tests pass, including
  exact-source/account reminder forwarding and Gmail mode rejection. Compilation
  and headless bridge tests are **not** a WKWebView interactive smoke test.
- One intermediate full core run hit the existing Gmail
  `archive_read_ordering_idempotency_and_unknown_after_apply` timeout; subsequent
  full checks pass without a Gmail implementation change. No provider network
  or credentials were used by those synthetic tests.
- The accepted-fixes combined check initially hit the unchanged draft test
  `retains the frozen retry across an account change during delayed save
  verification`: its transient `Saving locally` assertion observed an already
  completed saved status. That test passed in isolation and the subsequent full
  check passed without draft-code or draft-test changes. The first run is not
  counted as passing; the timing-sensitive result remains a validation caveat.

Storage evidence covers durable command replay across newer revisions/restart,
conflicting keys, per-message mixed original inbox facts, due-time commit
failure, concurrent cancel/reschedule CAS, source/account rejection, offset-free
DST rejection, explicit offset handling, conditional/external versus self reply,
regardless, someday, in-flight removal/cancel ordering, return failure recovery,
newer triage supersession, unchanged ordinary Undo slot and exact incoming-ID
exclusion. Worker integration interrupts a paused synthetic provider, restarts
overdue, and confirms exactly two archive/restore calls; a later restart makes
zero calls. A second integration test keeps the worker alive across a future
fake-clock deadline, confirms removal then return without direct reconciliation
or restart, verifies original target IDs and incoming-mail preservation, and
observes further worker polls/time advances without additional provider calls or
operations. This is idempotent **fixture setter** recovery, not exactly-once
remote execution certification.

UI evidence is Vitest/jsdom with an injected memory-only reminder capability:
H opens the supported fixture picker and is gated for bulk selection, text input,
IME composition and Gmail; a lost ACK retries the same key; invalid times remain
editable; Someday/Regardless submit explicit fields; returned membership is
separate. The pointer journey clicks Reminders, the Returned tab and a returned
conversation; Escape/Back restores that tab without auto-read. Plain-text subject
markup stays literal. Shared registry routes for palette, navigator and G then H
are implemented, but these reminder tests do not exercise those routes or assert
their capability/selection/editor/IME boundaries. The ordinary browser-preview
fake does not implement reminders and exposes no dead controls. No real-browser
reminder rendering or native interactive session was performed.

## Accepted adversarial-review fixes

The accepted fix pass covers these four findings only:

- Capture the Activity/Reminders reader origin synchronously before detail
  loading. Deferred-transport regressions cover Back during loading and a late
  reminder response after a newer Inbox reader opens; origin, J/K, focus and
  no-auto-read behavior remain owned by the current visit.
- Offer explicit in-panel source-preparation retry after transient read failure
  or stale-source rejection. Preserve time/condition choices, require explicit
  resubmission with the latest same-account/conversation source and a new key,
  retain exact retries after ambiguous ACKs, and never convert revision conflicts
  into a new schedule. Tests also fence stale/changed-target/unmounted responses.
- Test a future deadline crossed while the worker remains running, as described
  above; the restart test remains separate.
- Narrow shortcut evidence to the actual H and pointer assertions, not untested
  palette/navigator/G-H dispatch boundaries.

Deferred P2 notes were not included in this pass: Escape from reminder form
controls, clearing obsolete list-load errors after successful refresh, and
additional palette/navigator/G-H or failed-draft-flush coverage. These remain
non-blocking review notes, not verified fixes.

## Remaining gates / needed decision

Keep this increment labelled native synthetic fixture only. To finish Gmail
UX-11, decide whether to authorize a follow-up implementing fresh complete
thread evidence, generation-fenced reply checks, reminder-pinned retained
inventories and atomic exact-target Gmail intent staging, or retain the current
fixture-only boundary. Do not enable Gmail reminders merely by adding a UI flag.
No later thread was merged/cherry-picked or reimplemented to manufacture these
prerequisites. A fresh read can still race a later provider reply; the future
Gmail contract must explicitly bound its evidence checkpoint and avoid claiming
provider-atomic absence.

After that implementation, approved disposable-account validation is still
required. Native fixture H/palette/G-H, pointer/keyboard focus and retained
returned-tab round trip, WKWebView/VoiceOver, real quit/relaunch scheduling and
normal-close draft protection remain operator smoke gates. No real mailbox
access, credential changes, provider writes, sends, OS package installation,
calendar or cross-device execution was attempted.
