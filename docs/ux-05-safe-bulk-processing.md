# UX-05 — Select and process several conversations safely

Status: **proposed implementation scope; not implemented or runtime-validated.**
Scoped against `ed6b2d2` after UX-04. Source requirements:
[UX spec](../superhuman-email-browsing-ux-spec.md) §List focus, opening, and
selection, §Context precedence, BROWSE-06/18; delivery boundary:
[implementation plan](superhuman-browsing-implementation-plan.md) §UX-05.
Build on [UX-03](ux-03-command-discovery.md) and
[UX-04](ux-04-trustworthy-undo.md), not a new mutation engine.

Everything below is a proposed engineering contract (`P`). The spec documents
multiselect shortcuts and bulk actions (`D`), but not these exact range,
transaction, recovery, or partial-Undo semantics. This is not a claim of
Superhuman equivalence or authorization to mutate a real mailbox.

## 1. Deliverable and boundaries

```text
Select three conversations → see “3 selected” and explicit action labels
→ Done → one durable group receipt → per-member pending/confirmed/failed/unknown
→ recover individual failures in Activity, or Z within 10 s for eligible members
→ restart → group and member outcomes remain inspectable
```

**Ship together:**

- Independent account-scoped selection, range anchor, count, pointer and keyboard
  controls in Inbox and cached Done.
- Bulk Done/Not Done and explicit Mark read/Mark unread through the shared
  action catalog, with the existing capability gates. Read remains Gmail-only;
  native fixture mode covers archive/unarchive groups, like the current setters.
- Bounded, idempotent, transactional **local group acceptance**, member receipts,
  immutable message targets and per-message preimages.
- Per-member status/recovery and one-level group Undo, including honest partial
  results. Reuse the serial worker, provider setters and reconciliation.

**Do not include:** stars (the star portion of BROWSE-06 is deferred), labels,
move, trash, reminders, new provider permissions, multiple accounts/providers,
new browsing contexts, all-matching/cross-page selection, concurrent provider
execution, a Gmail batch endpoint, arbitrary action execution, HTML rendering,
auto-read, redo or multi-level Undo. No composer/send changes. No state-framework
or worker replacement. Selection itself need not survive restart; accepted
intent and its recovery records must.

## 2. Source facts and required changes

| Current source | UX-05 consequence |
|---|---|
| `useMailbox.ts` has `focusedRef`, `openRef`, stable-ID focus resolution and context/session fences, but no selection. | Add selected references and range anchor independently; reuse account/context fencing and focus fallback. |
| `InboxList.vue` uses list/listitem, roving focus and `aria-current`; plain click opens, row actions stop propagation. | Add explicit selection controls without conflating DOM focus with selected state or breaking compact-row overflow handling. |
| `App.vue::actionTarget` resolves one explicit/focused/reader target. | Replace shared conversation-action resolution with an immutable target list; explicit inline row actions still resolve exactly one row. |
| `submitMutation` and `inFlightCommandRef` track a single target; `LastAction`/`ActionNotice` describe one operation. | Introduce an explicit single-or-group pending/notice model; do not use the first selected ref as a fake group identity. |
| Gmail `accept_new_operation` opens a transaction around `accept_operation_tx`; fixture `Store::set_archived` owns its transaction. | Extract transaction-local acceptance helpers, retaining existing checks, for one bounded group transaction. Calling public setters in a loop is insufficient. |
| Gmail acceptance already persists immutable targets, effective per-message preimages and recovery snapshots; targets are bounded to 1000 messages per operation. | Preserve those limits/semantics for each member; never re-resolve inventory during execution, retry or Undo. |
| Both stores' Undo eligibility uses the newest non-compensating **operation**. | A loop would supersede every member except the last. Model a group as one top-level user action before exposing group Undo. |
| Activity contains individual operations, including recovery after rows leave Inbox; there is no durable group/query contract. | Persist group membership and expose group detail independently of current list rows and operation-history truncation. |

These are static source observations, not a new certification of existing code.

## 3. Selection and dispatch contract

### 3.1 State and exact interactions

Use account + conversation identity (`ConversationRef`), never indexes or a bare
conversation ID. Suggested state: `selectedRefs` (keyed set/map) and
`rangeAnchorRef`. Indexes are temporary inputs for movement/range calculation.

| Input | Result |
|---|---|
| `X` on a list-owned focused row | Toggle that row, keep focus there, set range anchor there. Ignore auto-repeat. |
| Plain `J/K` (existing arrow aliases unchanged) | Move focus only, no wrap, no selection changes. |
| `Shift+J/K` | Move one row and add the inclusive anchor-to-destination range; if no valid anchor, start at the pre-move focused row. Boundary is a no-op. |
| Cmd-click row | Toggle that row and move focus/anchor there; do not open it. |
| Shift-click row | Add the inclusive anchor-to-clicked range and focus the clicked row; retain the anchor. If missing, use the pre-click focus, otherwise the clicked row alone. |
| Cmd+Shift-click | Same range behavior as Shift-click. |
| Row selection checkbox | Toggle only that row, set anchor there, never open it. |
| Plain row click / Enter | Existing open behavior; do not silently clear or widen selection. Enter on a native control retains native behavior. |
| Clear selection | Clear set and anchor, do not navigate. |

Range extension is **additive**: reversing direction does not subtract already
selected rows. This is a deliberate completion choice, not observed target
behavior. Date headings never participate. Hover never selects or marks read.

Provide **Select all loaded (N)** and **Clear selection** as discoverable pointer
controls and palette commands. Select-all snapshots only currently loaded rows,
not the exact-total count or unseen pages. Later page loads/new arrivals do not
join automatically. Proposed bound: **100 selected conversations per action**;
if more rows are loaded, disable Select all loaded with a visible explanation
and reject additions beyond 100 without replacing the existing selection. Never
silently take the first 100. This is a product/safety bound, not a provider limit.

### 3.2 Navigation and refresh

- Escape order: existing top overlay/disclosure/drawer → selected set → reader
  or context Back. Clearing selection does not also leave the current surface.
- Keep selection on reader open/return within the same browsing context, never
  extending it from reader J/K. Show its count and bulk scope in the reader too;
  hidden selection must never cause a surprising bulk action.
- Context/account changes clear selection and anchor; Back to a prior context
  restores navigation, **not** its old selected set. Disconnect/session changes
  fence outstanding receipts so old-account notices cannot repopulate the UI.
- A successful authoritative list refresh intersects selection with surviving
  loaded refs and clears an absent anchor. Loading/errors must not be mistaken
  for an authoritative empty result. Preserve existing stable-ID focus and scroll
  behavior; background refresh must not steal focus.
- At dispatch, freeze the exact selected references in current loaded order.
  The action's persisted member list, not the live selection, drives subsequent
  progress/recovery. Rows removed by a pending overlay may leave selection;
  they must not disappear from the group result surface.
- Definitively failed/rejected members stay reachable in Activity, even if no
  longer present in the active list. Provide per-item Open/Retry as applicable;
  never silently reselect them or include them in the user's next selection.

### 3.3 One target policy

Shared toolbar, palette and conversation-action shortcuts resolve:

1. Explicit inline row action → exactly that row, regardless of selected set.
2. Otherwise nonempty selection → exactly that set, even in the reader.
3. Otherwise existing focused/open conversation behavior.

Use the group path whenever selection is nonempty, even for one selected row.
Label selected-scope actions with the count; reader conversation triage controls
must use the same visible scope. Opening, copying contacts, message navigation,
and Reply are not bulk operations; Reply retains its existing source checks.
Bulk archive must not invoke single-reader “archive and advance” behavior.

Offer explicit **Mark N read** / **Mark N unread**, never a mixed-state toggle.
Existing inline single-row read toggling remains row-scoped. Selection actions
only intercept keys when the list owns them, and preserve IME, inputs,
contenteditable, buttons/links and top-surface precedence. No unconditional
global Cmd+A interception. Block duplicate mutation dispatch while acceptance
or its receipt recovery is unresolved; navigation can remain usable.

## 4. Durable group contract

### 4.1 Local acceptance is atomic; remote execution is not

A group contains one setter kind/value (archive, unarchive, read or unread)
and 1–100 unique refs from the active account. Validate structure, duplicates,
bounds, request ID, active account and capability before accepting anything.
Malformed/cross-account/unauthorized commands reject the whole request.

In **one SQLite transaction**:

1. Check a canonical fingerprint (kind, value, canonical member identities) and
   account-scoped group request ID. Same request/payload returns the original
   receipt; changed payload returns `request_id_conflict`. Preserve the original
   persisted member ordering on replay. Define collision handling with existing
   setter/Undo request IDs; no accidental cross-command receipt reuse.
2. Persist the group header, acceptance time and ordered member manifest.
3. For each member, accept an ordinary child operation with immutable message
   targets, effective preimages and recovery snapshot, using the existing checks.
   A member that is gone/unactionable or exceeds the existing target bound gets
   a persisted **rejected** acceptance result and typed reason, not a fabricated
   failed provider operation. Use prevalidation or member savepoints so rejected
   members leave no partial targets/preimages/request rows behind.
4. Persist the original receipt, including accepted operation IDs and rejected
   members; commit once. Wake the worker only after commit.

Storage/transaction failure rolls back **the entire local acceptance**. Even an
all-rejected valid request has an idempotent durable receipt, with zero child
operations. It does not supersede a previously undoable action. Accepted child
operations run serially as today; group acceptance does not promise atomic
provider application or rollback of successful siblings on failure.

Recheck mutation capability at execution as today. Disconnection, cache eviction
and restart must not orphan durable group/target/recovery records. Preserve the
existing Gmail interrupted-dispatch uncertainty behavior; do not blindly replay
an applying mutation as confirmed success.

### 4.2 Data and typed boundary

Add durable group header/request/member tables in **both stores**, with account
isolation, stable member ordinal, group-to-operation linkage and persisted
acceptance rejections. Record group Undo requests and per-member decisions too.
Migration must preserve existing operations, requests, preimages and Undo links.

Proposed named seams (freeze exact Rust DTOs/error shapes and regenerate TS
before UI integration; these names are not existing APIs):

- `set_archived_group`: account, refs, explicit `archived`, request ID.
- `set_read_group`: account, refs, explicit `read`, request ID; Gmail-only.
- `get_operation_group`: active-account lookup by original request ID, returning
  optional committed group, immutable acceptance receipt and current member
  statuses/Undo availability. This also resolves a lost acceptance response.
- `list_operation_groups`: bounded recent group summaries with cursor, independent
  of Inbox/Done rows; supplies Activity and restart recovery. Known group detail
  remains directly addressable even when absent from the recent page.
- `undo_operation_group`: group ID and request ID; durable per-member outcome.

A member result distinguishes `rejected` at acceptance from an accepted operation's
`queued`, `applying`, `confirmed`, `failed`, `outcome_unknown` or `cancelled` status.
Group counts are derived from members; accepted is not succeeded. Keep compensation
statuses separate from original execution statuses. Include group linkage on
operation summaries so existing Activity retry/open paths remain usable and group
members cannot misleadingly advertise individual Undo.

Use narrow MailClient methods, Rust-generated types, transport validation/tests,
and explicit Tauri commands, command manifest, capabilities and permissions.
Never expose arbitrary group actions/SQL/provider mutations. Browser fake models
these outcomes but continues to disclose that it is in-memory and non-durable.

### 4.3 Lost responses and recovery

The UI retains the original request ID and immutable command until acceptance is
resolved. A rejected IPC promise alone does not establish that nothing committed.
Query by request ID and/or replay **that exact request**, never invent a fresh
request to recover an ambiguous acceptance. Show “Acceptance not yet known” until
resolved; distinguish this transport state from a member's provider outcome unknown.
On restart, recent groups are discoverable through Activity without a frontend
receipt. A not-yet-committed lookup is not permission to submit a different request.

Individual retries reuse the existing immutable-target retry path. They are new
top-level user actions, linked to the original member for inspection; they do not
rewrite the historical group receipt. Unknown members retain the existing warning
to verify state before retry. No automatic Retry all or blind replay of successes.

## 5. Group Undo and single-action compatibility

Keep one-level **latest user action on the account** and the 10-second Rust-clock
window; do not relax to arbitrary same-target history. A group is one action,
not N mutually superseding operations. Introduce a shared action-order identity
(or equivalent transactionally ordered representation) for singles, groups and
retries; timestamp comparison alone is insufficient. Existing historical singles
retain their order/eligibility semantics.

- All accepted children share the group's acceptance time/deadline and top-level
  action identity. Children and compensations cannot be individually undone via
  `undo_operation`; prevent a last-child escape around group eligibility.
- A newer single action/group/individual retry supersedes the older group, and
  a newer group supersedes the older single. Compensation is not a new user
  action. Undoing the latest action does not reopen earlier history.
- Within the latest group's window, evaluate each accepted member under the
  existing status/preimage checks. Queued → atomic cancel; applying/confirmed →
  ordered compensation, at most two operations per member for mixed prior values.
  Targets/preimages come from original acceptance, never current inventory.
- Persist skipped members and reasons: acceptance rejected, failed (overlay
  already dropped), unknown outcome, unknown prior values, or already undone.
  Eligible siblings can still be undone. Expiry/supersession rejects the whole
  group Undo without changes. An all-ineligible group offers no enabled Undo.
- Validate and persist all member decisions, cancellations and compensations in
  **one transaction**, with worker-claim races handled under the same store lock.
  Group Undo has its own idempotent request/receipt. A retry with the same request
  returns the same decisions, not a new pass over changing member statuses.
- One Undo attempt per group; skipped members are not silently retried if later
  reconciled. Activity remains their recovery route. No redo.
- Say “Undo accepted for 2 of 3; 1 skipped — outcome unknown”, not “Restored 3”.
  Cancelling queued intent is immediately local; compensating intent is pending
  until confirmed. Failed/unknown compensation must remain visible per member.

## 6. UI, accessibility and recovery surfaces

- Distinct row selection marker **and** lavender focus cue; selection cannot be
  color-only. Prefer native labelled checkboxes within the existing list/listitem
  structure; expose checked state without adding invalid `aria-selected` to list
  items. Keep `aria-current` for focus. Checkboxes and row controls stop propagation.
- Add a compact selection action bar with count, explicit desired-state actions,
  Select all loaded/Clear, and honest bound/loaded-scope wording. Preserve compact
  rows at larger text sizes and the existing narrow-desktop action disclosures.
- Extend the single-slot notice to single-or-group identity. It shows accepted,
  pending, confirmed, failed, rejected, unknown and cancelled counts separately
  with an Activity/detail route; aggregate wording never hides partial failure.
  After a newer action replaces the slot, older groups remain in Activity.
- Extend Activity with group headers/detail and per-member Open/Retry plus Undo
  results. Preserve existing standalone-operation history and compensation links;
  no failure may be lost because its conversation left the current context.
- Rust supplies Undo deadlines/eligibility; UI timers are advisory. On restart,
  rehydrate the latest eligible single/group notice from authoritative state.
  Older group members must not be re-pointed as standalone undoable actions.
- Announce selection count and concise outcomes through a polite live region,
  not the entire list. Preserve normal tab order, button keyboard activation,
  focus on Clear/empty-list transitions, and Back/Activity reachability.

## 7. Acceptance and validation

### Rust/store/provider tests (both stores where supported)

1. Noncontiguous refs are accepted once; insert/reorder conversations and add a
   reply after acceptance → execution/Undo still touch only original message IDs.
2. Structural invalidity, cross-account targets, duplicates, bounds and denied
   capabilities → no group/child writes. Member unavailable → persisted rejection,
   valid siblings accepted. All-rejected case preserves prior Undo eligibility.
3. Inject transaction failure mid-group → no partial group/children/preimages;
   same request retry is safe. Member-savepoint rollback leaves no orphan data.
4. Same request replay before/after restart gives identical receipt; changed payload
   conflicts. Lost response + lookup/replay creates no duplicate children.
5. Three members: confirmed, definitively failed, outcome unknown → separate
   statuses, correct overlays, no rollback of successful siblings. Restart/reconcile
   retains group linkage, recovery snapshots and original immutable targets.
6. Group Undo at 9 seconds: queued cancel, applying/confirmed compensation; mixed
   read preimages restore independently, non-INBOX sent messages stay out, new
   replies remain untouched. Unknown/failed/rejected/prior-unknown siblings are
   explicitly skipped. Worker-claim race cannot produce duplicate compensation.
7. Expiry at 10 seconds, newer single/group/retry supersession, child single-Undo
   bypass, duplicate Undo request, second different Undo request, compensation
   failure/unknown, restart inside/outside window. Older history never reopens.
8. Migration preserves UX-04 single-action behavior and historical requests;
   cached Done evidence remains correct for cancelled/compensated group members.
9. Group detail/list pagination/account fencing; a group absent from a recent page
   is still queryable by request identity. Revoked capabilities fail closed.

### Frontend/transport/rendered tests

- X toggle/no-repeat, J/K focus-only, range extension/reversal/bounds, Cmd/Shift
  click, checkbox propagation, nonselectable headings, maximum-selection messaging.
- New arrival, reorder, page load, transient errors, context Back and account
  changes never widen or leak selection. Reader round trip retains only explicit
  IDs; Escape clears before leaving. Typing shortcuts/IME cannot mutate mail.
- Exact shared targets versus row-scoped actions; mixed read actions are explicit;
  selected-one uses group semantics. Reader banner matches scope; bulk archive
  never accidentally calls the single-reader advance path.
- Per-member failure/unknown display, retained original request on lost response,
  partial Undo wording and compensation progress, restart rehydration, Activity
  recovery independent of visible rows. Browser fake parity without durability claims.
- Native command/envelope and error validation tests; generated-contract check.
- Rendered layout/focus regression at the existing desktop/contact breakpoints
  and enlarged text; checkbox/toolbar operation does not break row disclosures or
  reader/list scroll restoration.

**Spec checkpoint:** BROWSE-06 for archive, BROWSE-18 for partial execution;
regress BROWSE-07/08/10/17/20. Stars remain explicitly unfulfilled.

Run the six checks in `.pi/factory.json` and native compile/bridge checks where
supported. Extend the real macOS/WKWebView fixture checklist: actual X, Shift+J/K,
Cmd/Shift-click, Escape, clear/last-row focus, Z, restart recovery and VoiceOver
scope/outcome announcements. Read-group remote convergence requires the approved
disposable Gmail account and opt-in modify grant; no primary-mailbox test is implied.
Record what ran and what remains pending, rather than claiming fake IPC proves
native or provider behavior.

## 8. Implementation sequence and decisions

| Step | Deliverable | Dependency |
|---|---|---|
| 1 | Freeze DTOs, bounds, errors, receipt lookup, action-order and partial-Undo rules; regenerate TS | Scope approval |
| 2 | Both-store group migrations, transaction-local acceptance, idempotency and status queries | 1 |
| 3 | Group-aware single/group Undo and restart/retry semantics; Rust tests | 2 |
| 4 | Core/shell forwarding, named permissions, client adapters and transport tests | 2–3 |
| 5 | Selection state/controls and target resolver, pending single-or-group model, browser fake | 1; integrate with 4 |
| 6 | Notice/Activity/group detail, partial recovery/Undo, UI/rendered tests | 3–5 |
| 7 | Integration, regression checks and native fixture/disposable-account validation ledger | 6 |

This is a cross-layer slice, not a checkbox-only change. The largest backend risk
is **user-action-level Undo ordering** across singles, children, retries and
compensations. The largest UI risk is hidden selection changing action scope in
the reader. Deliver selection first internally, but do not call UX-05 complete
without durable groups and recovery. If work is split later, keep one owner of
Rust/schema/generated contracts and one of App/composable/UI files; this scope
does not itself request or launch delegation.

Recommended decisions for approval before implementation:

1. **100-conversation selection/group bound**, loaded-only scope, additive ranges
   and no X auto-advance.
2. **Atomic local acceptance with persisted per-member rejections**, not atomic
   remote application; all-rejected requests do not consume the Undo slot.
3. **Latest top-level action only**, ten seconds from group acceptance, one partial
   Undo attempt with explicit skip reasons (not a new history model).
4. **Selection survives reader visits with visible bulk scope**, but clears on
   browsing-context/account changes and is not restored by context Back/restart.

No ADR expansion or new provider authority is needed for these existing archive/read
operation kinds. The safety/disposable-account gates remain unchanged.
