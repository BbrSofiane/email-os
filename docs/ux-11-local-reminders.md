# UX-11 — Device-local reminders

Email OS owns reminder state. Native fixture reminders use the fixture store;
Gmail-profile reminders use account-scoped tables in `gmail.db`. Gmail scheduling,
rescheduling, cancellation and return do not create provider mailbox operations,
change Gmail labels or require a write-permission upgrade. Fixture reminders retain
the earlier synthetic archive/restore operation path for compatibility.

## User flow

- H or a row/reader clock opens a focused time picker for one Inbox conversation.
  Command discovery includes Remind me, Reminders (G then H), and Reminder Settings.
  Bulk selection, active editors, composition and hidden surfaces retain their
  existing shortcut guards.
- Tomorrow, Next Monday, Next weekend and Someday are offered as presets. Next
  Monday means the strictly next Monday (seven days later when today is Monday).
  On Sunday, the duplicate Tomorrow suggestion is hidden when both resolve to
  the same available instant. Free text supports clock times such as `8 am` and
  `9:30 pm`, relative days such as
  `3 days`, month/day dates such as `Aug 7`, and explicit-offset ISO timestamps.
  The picker resolves the selection before the user confirms scheduling.
- Date presets use the device's local timezone and a configurable default time
  (08:00 initially). Preferences are stored on the device. Ambiguous/nonexistent
  local times are rejected instead of guessing a DST offset. Instants sent to the
  backend carry Z or a numeric offset. Settings, suggestions and selected-time
  confirmation name the resolved device IANA timezone when available and show
  the offset for the scheduled instant. Defaults apply to new selections,
  including explicit rescheduling. Changing defaults or the device timezone does
  not move existing scheduled instants, though displayed local times can change
  when the device timezone changes. Reminders are one-time instants; there is no
  IANA wall-clock recurrence.
- Rescheduling displays the stored instant as a readable device-local date/time
  with its current zone and offset. The original instant, including an explicit
  offset or DST-fold choice, remains selected until the user edits it. Saving
  without edits preserves that exact value. Editing clears the current selection
  until a preset or valid parsed value resolves; invalid visible text cannot be
  saved against the prior instant. Someday displays as Someday.
- Default condition is If no reply. Regardless returns without checking replies.
  Someday stores no due instant and never automatically fires.
- Pending, returned and cancelled/suppressed history are distinct destinations.
  Pending reminders support rescheduling and cancellation. Reminder actions do not
  consume the ordinary mailbox Undo slot or mark messages read.
- Acknowledged scheduling and rescheduling return to Inbox and show a brief polite
  confirmation using the accepted time, or Someday for an untimed reminder.
  Failures retain their recovery controls without announcing success. A newer
  navigation choice takes precedence over a delayed completion.

## Local storage and Inbox visibility

Acceptance captures account, conversation, explicit latest source ID and the
baseline message IDs. It rejects a stale source and conflicting mailbox intent.
The local record, immutable baseline, pinned snapshot and request receipt commit
in one transaction. Replacement reminders get a new baseline/snapshot;
rescheduling preserves the accepted baseline. Revisions fence cancel/reschedule
against deadline processing. Exact request retries return the original receipt,
including after the deadline, later revisions and a store reopen; changed payloads
with the same key conflict.

While pending, a Gmail-profile reminder hides its known conversation from the
Email OS Inbox. New message IDs release hiding immediately when synced. Someday
also hides the baseline conversation. Reaching a deadline alone does not release
conditional hiding: incomplete/offline evidence leaves the reminder pending.
Confirmed return or cancellation releases the overlay. Explicit newer remote
archive, Trash or Spam state is respected; local reminders do not unarchive mail
on the provider. The Gmail read model and reminder destination are local views,
not Gmail folders.

Active reminders retain conversation data across bounded cache eviction. Capped
rediscovery does not interpret an unseen pinned thread as proven archived;
authoritative complete discovery and direct thread updates still reconcile remote
membership. History cursor expiry preserves local reminders and receipts. Account
disconnect clears their snapshots and receipts with the account cache.

## Reply evidence and worker lifecycle

A qualifying reply is a new ID in the same thread with a sender other than the
exact primary mailbox, case-insensitively. Alias inference, RFC reply-header
inference, and cross-thread matching are excluded. Gmail conditional decisions
require a fresh complete per-thread read with inventory/sender coverage, fenced by
account, generation, reminder revision and local observation revision. Offline,
failed or incomplete reads leave the reminder pending. A reply can arrive after
the provider read checkpoint and before the local decision commits; this is not a
provider-atomic absence guarantee.

Native workers own execution while the app runs and catch up overdue reminders on
launch. New schedules/reschedules wake the worker and recalculate deadlines;
conditional retries use the periodic interval instead of a tight polling loop.
Stop and disconnect cancel in-flight reminder reads. Persistence failures halt
worker processing and reject further admission. No database/control lock is held
across provider network calls, and change subscribers run outside control locks.

Delivery times are not-before instants, not punctual guarantees: serial worker
work can delay processing. Fully-quit execution, cross-device state, OS
notifications, calendar integration and scheduled sending are outside scope.

## Verification boundaries

Automated coverage uses synthetic providers and clocks. It exercises local Inbox
visibility, due return, conditional reply suppression, offline deferral, Someday,
replacement/reschedule baselines, exact retries, account isolation, retention,
restart catch-up and cancellation of paused reads. UI coverage includes picker
keyboard behavior, source preparation and lost-ACK recovery, navigation origins,
Gmail-mode discovery and settings persistence.

The browser fake implements memory-only reminders for development and tests. It
never establishes SQLite durability or native scheduling. Its due transitions are
reconciled on synthetic reads rather than a native worker. Browser preview must
retain its memory-only disclosure.

Native compilation and synthetic bridge tests are distinct from interactive
WKWebView, VoiceOver, packaged-app quit/relaunch and disposable-account testing.
No credentials, real account connection or provider writes are authorized by the
synthetic verification workflow. Those interactive/operator checks remain separate
verification gates and must not be claimed from automated test results.

## Automated validation (2026-11-08)

On the integrated tree, `mise run check` passes: 312 core tests (including
integration suites), 881 UI tests, contract generation, formatting/clippy and
typecheck. The 33 opt-in rendered UI tests remain skipped. `mise run build:web`
passes. Native `mise run check:native` and `mise run test:native` pass, with all
11 bridge tests passing. Rust checks use `CARGO_PROFILE_DEV_DEBUG=0` and
`CARGO_PROFILE_TEST_DEBUG=0` to fit the VM disk budget. No source or assertion
is disabled by those build settings.

New worker tests exercise a shortened future deadline, local return and catch-up
after core reopen, and cancellation of a paused thread read on stop/disconnect.
Store regressions exercise receipt replay after the deadline/reopen, replacement
baseline retention through capped rediscovery and cache pruning, Someday hiding,
and account cleanup. These are synthetic process/core tests, not interactive
packaged-app or disposable-account evidence.

## Critique follow-up

The five approved UI priorities are implemented: the reminder surfaces use the
shared overlay and field styles; the picker identifies the subject and known
sender; suggestions expose combobox/listbox selection and resolved-time
announcements; Next Monday is explicit, with duplicate Sunday suggestions
removed; and device-zone labels explain scheduled times without moving stored
instants. The complete subject is available through a keyboard-operable
disclosure. Subject text remains literal and source/revision fencing is unchanged.

The integrated follow-up UI suite passes (893 tests, 33 optional rendered tests
skipped), as do typecheck, production web build and diff checks. Focused reminder
suites also pass in UTC and America/New_York. These are automated component and
flow checks, not new browser, VoiceOver or NVDA verification. Previous screenshots
show the implementation before these critique fixes and should not be presented
as current after-state captures.
