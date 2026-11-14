# UX-06 — One real saved split

## Contract

One optional named view per account, stored by Rust in the existing SQLite
`meta` table under an account-scoped key. The two named IPC commands are
`get_saved_split(accountId)` and `save_saved_split(accountId, split)`; the
Rust-owned `SavedSplit`/`SplitCriterion` DTOs generate the TypeScript seam.
Saving commits before returning and emits the normal mailbox change hint.
No OAuth scope, provider write, classification, or operation receipt is involved.
Gmail disconnect deletes this local definition along with account/cache data.
The synthetic browser preview remains explicitly in-memory only.

## Deliberate bounds and completion choices

- Name: trimmed, 1–40 Unicode characters, no control characters.
- One exact sender address **or** one exact domain, trimmed and ASCII
  case-normalized. ASCII mailbox/domain syntax is validated again in Rust.
  No wildcards, body search, labels, inferred importance, OR rules, or NLP.
- Sender means **the newest provider message's sender**, using Rust's
  `primaryCorrespondent` summary fact, independently of body renderability.
  Gmail chooses the maximum `(message_sent_at, message ID)` using its existing
  timestamp normalization (internalDate, then Date, then unknown empty timestamp)
  and lexicographic ID tie-break, shared with reply-source selection; response
  array order never selects the sender. Only a bounded, single usable From
  mailbox qualifies. Missing, malformed, duplicate, grouped or multiple From
  addresses remain unknown; there is no fallback to older renderable messages,
  recipients, participant names, or reply headers. Unknown does not match either
  sender or domain. Exact domains do not implicitly include subdomains.
- Gmail persists this one header-only sender fact in nullable
  `gmail_conversations.newest_sender_json`, account/conversation scoped and
  atomically replaced on discovery/history/operation reconciliation, including
  known → unknown updates. Old caches gain a NULL column without backfilling
  from body rows; membership stays unknown until a provider refresh supplies it.
  Evicted operation-only reader snapshots have no authoritative sender metadata
  and do not invent one. No HTML is imported or made renderable; existing reader
  limitations, reply eligibility, preview/date ordering and mutation facts remain
  unchanged. Synthetic fixture messages are already complete plain-text inputs.
- Membership is a pure projection of effective Inbox summaries; overlap with
  Inbox is intentional. Archives remove a conversation from both projections;
  Undo restores it subject to the same predicate. Disabling keeps the definition
  for re-enabling and never moves, relabels, archives, or deletes mail.
- Stable ordering is inherited unchanged: newest message first, ID ascending
  for ties. Existing local-time date-group code is reused.
- Badges count **all conversations**, independent of unread filtering. Only
  exact known integers 1…999 render. Zero, 1000+, and unavailable totals render
  no badge. Gmail totals describe the **local Inbox cache**, not the provider
  mailbox; an adjacent disclosure states this explicitly. Failed reads do not
  advertise stale counts as current totals.
- Optional hide-when-empty uses the unfiltered split total. An enabled hidden
  split remains reachable as “Go to [name]” in Commands/Destinations. An already
  open hidden split retains its title, empty explanation, and Inbox return path.
- Inbox cannot be disabled or hidden. No Important/Other tabs are invented.

## Navigation and interaction

Create the split through **Commands → Create Split** (or Cmd+K in the native
app). Once a definition exists, use **Commands → Edit Split**, including for a
disabled or hidden split. There are no standalone Create/Edit buttons. Creation
is available only before a definition exists, including from an empty or
unavailable list. Both commands return to Inbox before opening the editor from
a reader or utility drawer. Inputs receive focus on opening; Cancel/Escape and
successful save return focus to Commands while that editor owns focus.
Invalid input or storage failure is visible and leaves the definition/mail
unchanged. Save is single-flight.
After failure, focus displaced by disabled save controls returns to the prior
field/control, unless focus has moved outside the editor or to another view/overlay.
The visible editor owns Escape even when focus was displaced outside its form;
while saving, Escape is consumed without cancelling the in-flight save. Enter on
displaced body focus is also consumed so native submission cannot queue a second
save when fields re-enable; Tab remains native. The editor suppresses shortcuts
rather than allowing them to act on the list beneath it.
Successful save returns focus to its trigger only while that editor owns focus.

Pointer buttons and palette commands reuse account-scoped browsing contexts,
history, reader Back, action availability, bulk processing, Activity, and Undo.
Context changes clear selection and range anchors. Definition edits also clear
selection in the affected view. A changed definition invalidates old list rows,
focus and list-origin reader targets before publishing the new definition,
matching rows and totals together. Stale list callbacks cannot act on old-rule
members. Explicit Activity recovery visits remain account-scoped and independent
of split membership. Activity's direct Unarchive also restores without opening a
reader, even for nonmatching/unread-filtered targets or an unavailable saved list.
This narrow restoration path requires a restorable Activity row in the current
account and reuses the normal permission, single-flight/unresolved-group, durable
receipt, refresh, notice and Undo pipeline; it does not authorize stale list or
frozen bulk targets. Disabled historical contexts resolve to Inbox.
Reader Back keeps the originating split/focus/scroll behavior.

Only an actually focused ready list row (or its focused empty state) owns split
navigation: Tab moves Inbox → saved split and Shift+Tab reverses it. Navigation
is **nonwrapping**: at either boundary, native Tab traversal proceeds to controls
rather than swallowing the key. Body/initial focus, absent/loading/error lists,
form fields, checkboxes, toolbar buttons, reader, drawers/disclosures and palette
retain ordinary focus ownership. Hidden empty views are skipped unless currently
open. Users can reach row checkboxes, toolbars, and both split configuration
commands by keyboard.

The session-local unread filter is controlled through **Commands → Show Unread
Only**; while active, that command becomes **Show All Conversations**. There is
no standalone filter button. A noninteractive “Unread only” status identifies
an active filter, and empty states point to the command for turning it off.
It applies to the current browsing context and persists across view switches.
Only `isRead === false` qualifies; missing
or unknown facts are never interpreted as unread. Changing the filter closes
the reader, clears selection, and refreshes focus. It does not alter membership,
counts, saved rules, or read state. Empty filtered results explain the filter
rather than claiming Inbox zero. The filter resets on account disconnect/change.

## Validation

- `tests/saved-split/saved-split.test.ts`: exact matching and badge boundaries; overlap,
  archive/Undo, selection isolation, disabling, unread unknowns, stale navigation,
  inline editing, nonwrapping keyboard navigation, reader return, hidden commands.
- `tests/saved-split/useMailbox-safety.test.ts`: delayed/stale/failed rule and list
  reads, atomic projection publication, old-target fencing, unchanged-rule browsing,
  and independent Activity/Done ownership.
- `tests/saved-split/app-activity.test.ts`: archived Activity recovery from a saved
  split, restore actions, and the Activity-origin reader return path.
- `tests/saved-split/create-command.test.ts`: command-only creation, context transitions,
  native Cmd+K, editor focus, save/cancel return focus, and command-only editing
  of existing, disabled and hidden definitions.
- `tests/commands/unread-filter.test.ts`: command-only filtering and reverse label,
  unknown/read exclusion, total badges, context/account lifecycle, reader closure,
  empty-state recovery, read-only access and delayed-refresh focus ownership.
- `tests/saved-split/editor.test.ts`: failure focus restoration and ownership,
  in-flight submission/cancel fencing, and successful-save focus behavior.
- `crates/mail-core/tests/saved_split.rs`: save/reopen, account scoping, rejected
  updates, disabling without moving mail or superseding an existing Undo.
- Gmail store tests: reopen persistence, account fences, fail-closed storage,
  disconnect clearing. `gmail/newest_sender_tests.rs` runs actual provider parsing
  through discovery/history persistence, reverse response order/timestamp ties,
  unknown From updates, reopen, old-schema migration and account fencing. Its
  exact native wire results are checked against
  `tests/fixtures/newest-sender-summaries.json`, also consumed by
  `tests/saved-split/saved-split.test.ts` for sender/domain membership.
- `tests/discovery/discovery.rendered.test.ts`: opt-in real Chrome trusted-input journey
  through the inline editor, split Tab/Shift+Tab, reader archive, Undo, and Inbox
  overlap. Run rendered suites with `--no-file-parallelism` to avoid shared Vite
  dependency-cache races between ephemeral test servers.
- Existing reader, selection, Undo, discovery, date-group and transport suites
  remain regression coverage. Real provider/native interactive behavior is not
  asserted by synthetic tests.
