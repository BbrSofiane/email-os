# UX-04 — Process one conversation with trustworthy Undo

Status: **implemented and merged; parent-validated with operator-reported native fixture validation (see §8).** Derived from the
[UX spec](../superhuman-email-browsing-ux-spec.md) (§Triage while browsing,
§Undo and optimistic updates, BROWSE-07/08) and the
[implementation plan](superhuman-browsing-implementation-plan.md) §UX-04, scoped
against the source at `main` `7e84f5c` (UX-03 merged). Every behavior below is a
proposed contract (`P`) unless it cites a `D` item from the spec; nothing here
claims Superhuman fidelity. Nothing here authorizes operating on a real mailbox.

## 1. Journey and narrow contract

```text
E (or inline Done)  →  row leaves Inbox, focus moves to surviving neighbor,
                       notification: "Marked Done · Undo (Z)" + pending status
Z within 10 s       →  Rust validates eligibility, cancels or compensates,
                       row returns with its exact prior per-message state,
                       focus returns to it, notification: "Restored"
Z after 10 s        →  Rust rejects `undo_unavailable: expired`; the UI says so
                       and points at Activity / Mark Not Done
```

In scope:

- Undo for the **single latest** conversation action: Done, Not Done, and the
  explicit Gmail read/unread setters. One level only; no redo.
- A persisted, per-message **preimage** captured at acceptance, so Undo restores
  exactly what each message had, not "all messages back to inbox".
- Rust-owned **eligibility** (window, supersession, unknown prior values,
  uncertain outcome) and an idempotent `undo_operation` command.
- A concise **notification** with Undo that shows accepted / confirmed /
  failed / unknown distinctly and rolls back on failure.
- Fixture-store parity for Done/Not Done so the native fixture gate is exercisable.

Out of scope (explicitly): multi-action history, redo, group/bulk Undo (UX-05
reuses the preimages), stars/labels/trash/reminders, Undo for drafts, toast
stacking/animation fidelity, any automatic mark-as-read, provider authority
beyond the existing archive/read setters.

## 2. Why the existing machinery is not enough

Source facts (not new runtime certification):

| Today | Consequence for Undo |
|---|---|
| `gmail/store.rs::accept_operation_tx` targets every `gmail_message_facts` row of the conversation and stores only the requested **single** value; `gmail_operation_snapshots` stores an aggregate `is_in_inbox`/`is_read`, not per-message facts. | Prior per-message values are never persisted. A thread with your own sent replies has messages that were never in INBOX; `setArchived(false)` would wrongly pull them into the inbox. Undo needs a preimage table. |
| `effective_conversation_state_with_coverage` already computes per-message effective facts (cached + pending overlay with confirmed barriers) but returns only aggregates. | Refactor to expose the per-message map; the preimage must be the *effective* value at acceptance so "archive (queued offline) → Not Done → Z" restores "archived", not the stale cached fact. |
| Worker is serial; `claim_next_operation` flips `queued → applying` under the connection mutex. There is no cancel path; `OperationStatus` has no cancelled state and the fixture `operations.status` CHECK allows only four values. | Cancel-in-place for still-queued intent is cheap and atomic (`UPDATE … WHERE status='queued'`), but needs a new status and a fixture table rebuild. |
| Providers expose `apply_archive(ids, value)` / `apply_read(ids, value)`: one value per call. | Mixed preimages are restored by staging **one compensating operation per distinct prior value** (≤ 2), each a normal operation with explicit targets. No provider or `OperationRecord` shape change. |
| Fixture `Store` supports archive only; `set_read`/`retry_operation` are Gmail-only and the shell rejects them in fixture mode. | Fixture Undo covers Done/Not Done only. Read Undo is Gmail-only, like read itself. |
| Frontend `submitMutation` returns the receipt and refreshes; there is no notification surface beyond `role="status"` paragraphs. `archiveFocused` relies on existing neighbor focus resolution. | Add a single-slot notification and an `undo` composable path; neighbor focus already satisfies the removal half of BROWSE-08 and needs tests, not new logic. |
| `cached_done.rs` qualifies rows by "a persisted, nonfailed archive operation". | Cancelled/undone archives must not qualify; needs a rule update and a test. |

## 3. Proposed durable semantics (Rust is authoritative)

### 3.1 Preimage capture (at acceptance, same transaction)

For every target message of a new operation, persist the effective prior value
of **that operation's dimension only**:

- Gmail: new table `gmail_operation_preimages (account_id, operation_id,
  message_id, prior_value INTEGER NULL, PRIMARY KEY(account_id, operation_id,
  message_id))`. `NULL` = unknown fact (e.g. `is_unread` not observed).
- Fixture: new column `operations.prior_values TEXT` (JSON `{messageId: bool}`),
  additive migration; fixture facts are never unknown.
- Retries (`clone_targets_from`) copy the **original's** preimage, not a fresh
  one; a retry restores the same prior world as the operation it retries.
- Compensating operations record their own preimage too (cheap, keeps the
  table uniform) but are never themselves undoable in UX-04.

### 3.2 Eligibility (evaluated in Rust at `undo_operation` time and in queries)

An operation `O` is undoable iff **all** hold:

1. `O` belongs to the active account and exists.
2. `O` is not itself a compensating operation (`undo_of IS NULL`).
3. `now < O.accepted_at + 10 s` using the injected `Clock` (`D` for the 10 s
   window; the UI timer is advisory).
4. `O` is the account's **newest accepted non-compensating operation**
   (single-level history; a newer action of any kind supersedes it). This is a
   deliberate simplification of "same-target newer action"; it is strictly
   safer and matches "latest eligible action only".
5. `O` has not already been undone (no row with `undo_of = O.id`).
6. `O.status ∈ {queued, applying, confirmed}`. `failed` is not undoable (the
   overlay is already dropped, so state is restored); `outcome_unknown` is not
   undoable (reconcile/retry via Activity instead — never report "undone" over
   an uncertain dispatch).
7. Every target's preimage is known (`prior_value IS NOT NULL`). Mixed values
   are fine; unknown values are not exactly undoable.

Failure of any rule returns a new typed error:

```rust
MailError::UndoUnavailable { reason: UndoUnavailableReason }
// reason ∈ { expired, superseded, already_undone, not_applicable (failed/compensating),
//            uncertain (outcome_unknown), unknown_prior }
```

### 3.3 Execution

`undo_operation({ operationId, requestId })`, idempotent under `requestId`
through the existing `gmail_operation_requests` / `request_keys` dedup, in one
transaction:

- **Still `queued`:** `UPDATE … SET status='cancelled' WHERE status='queued'`.
  If zero rows changed the worker claimed it concurrently → fall through to the
  compensation branch. Cancelled operations are excluded from the pending
  overlay, from `claim_next_operation`, from `pending_operation_id`, and from
  cached-Done evidence; they stay visible in Activity.
- **`applying` or `confirmed`:** group `O`'s targets by `prior_value`; insert
  one `queued` operation per group with `kind = O.kind`, `requested_value =
  prior_value`, **explicit targets** (new `OperationAcceptance.explicit_targets`
  path; never re-derived from current facts, so a reply that arrived after `O`
  is untouched), and `undo_of = O.id`. Serial ordering guarantees they run
  after `O` and after anything queued in between.
- Returns `UndoReceipt { undoneOperationId, outcome: 'cancelled' | 'compensating',
  operationIds: string[], acceptedAt }` and wakes the worker.

Compensating operations go through the unchanged executor: capability recheck,
confirm/requeue/fail/outcome_unknown, reconciliation, restart recovery
(`applying → queued` in the fixture, `→ outcome_unknown` in Gmail). An
uncertain compensation is reported as uncertain, not as "restored".

### 3.4 Frozen frontend seam (exact generated TypeScript)

Rust owns these DTOs; `generate-types` must emit exactly this shape (ts-rs
formatting). The frontend builds against this text before the generated file
lands; at integration the generated file wins and `check:contract` decides.

```ts
export const UNDO_OPERATION_COMMAND = 'undo_operation';

export type OperationStatus = "queued" | "applying" | "confirmed" | "failed" | "outcome_unknown" | "cancelled";

// MailError union gains exactly one variant:
//   | { "kind": "undo_unavailable", reason: UndoUnavailableReason, }
export type UndoUnavailableReason = "expired" | "superseded" | "already_undone" | "not_applicable" | "uncertain" | "unknown_prior";

export type UndoOperation = { operationId: string, requestId: string, };

export type UndoOutcome = "cancelled" | "compensating";

export type UndoReceipt = { undoneOperationId: string, outcome: UndoOutcome,
/**
 * Compensating operation ids in queue order; empty when `cancelled`.
 */
operationIds: Array<string>, acceptedAt: string, };

// OperationSummary gains two optional fields (serde skip_serializing_if + #[ts(optional)]):
//   undoOf?: string,         // id of the operation this one compensates
//   undoableUntil?: string,  // ISO-8601 UTC; present only while §3.2 rules 1–7 hold at query time
```

```ts
// MailClient
undoOperation(command: UndoOperation): Promise<UndoReceipt>;
// tauri-client: call<UndoReceipt>(UNDO_OPERATION_COMMAND, { command })
// shell: #[tauri::command] async fn undo_operation(state, command: UndoOperation) -> Result<UndoReceipt, MailError>
```

`isMailErrorShape` accepts `undo_unavailable` only when `reason` is one of the
six strings. `browsingActions` gains `{ id: 'undo', label: 'Undo last action',
shortcut: 'Z' }`.

### 3.5 Schema / DTO changes (all additive except the fixture CHECK)

- `OperationStatus` += `Cancelled`. Frontend `ActivityPanel` renders it as
  "Cancelled by Undo".
- `gmail_operations` += `undo_of TEXT NULL`; fixture `operations` += `undo_of`,
  `prior_values`; fixture `status` CHECK rebuilt to admit `'cancelled'`
  (schema_version `1 → 2`, copy-rebuild in one transaction; `Some(other) =>
  StorageUnavailable` stays).
- `OperationSummary` += `undo_of?: string`, `undoable_until?: string`
  (present only while rules 1–7 hold at query time; derived, never stored).
- New DTOs per §3.4. `generate-types` regenerates `generated.ts`;
  `check:contract` must pass.
- New native command `undo_operation` in `src-tauri/src/main.rs`, `build.rs`
  manifest, `capabilities/main-window.json`,
  `permissions/autogenerated/undo_operation.toml`; forwarded for both
  `Backend::Fixture` and `Backend::Gmail`.

## 4. Frontend scope

- **Transport:** `MailClient.undoOperation(command: UndoOperation):
  Promise<UndoReceipt>`; `isMailErrorShape` learns `undo_unavailable`;
  `browser-fake.ts` models preimage/cancel/compensate/expiry with an injectable
  `now()` and discloses non-durability as today.
- **Action catalog:** `browsing-actions.ts` += `{ id: 'undo', label: 'Undo last
  action', shortcut: 'Z' }`; palette entry shares availability with the key.
- **Dispatch:** `Z` (no modifiers, not composing, not editable target, no
  overlay/drawer/disclosure open) in **both** list and reader. `Cmd+Z` is left
  to native text editing (`D`). Same `actionShortcutBlocked` guard as `E`.
- **`useMailbox`:** `lastAction: { receipt, actionId, target, subject,
  undoableUntil } | null` set from each successful `setArchived`/`setRead`
  receipt; `undoLastAction()` calls the client with that `operationId`, then
  `refresh()`. On `undo_unavailable: superseded` it re-reads `activity` and
  re-points the slot at the newest `undoable_until` op rather than guessing.
  On `expired` it shows the reason and keeps Activity/Not Done reachable.
- **Notification (`ActionNotice.vue`, single slot, `role="status"`):** label +
  truncated subject; status derived from `activity` on every refresh
  (`queued/applying` → "Accepted locally, not yet confirmed"; `confirmed` →
  "Confirmed"; `failed` → "Failed — restored, see Activity"; `outcome_unknown`
  → "Outcome unknown — see Activity"; `cancelled` → "Cancelled"). Undo button
  and "Z" hint visible only while `undoableUntil > now`; the UI timer hides the
  control but never decides eligibility. Replaced, not stacked, by a newer
  action. Never covers the focused row or the reader back path.
- **Focus:** removal already resolves next → previous → empty (BROWSE-08).
  After a successful undo, if the restored conversation is in the current
  context's rows after refresh, focus returns to it with `preventScroll`
  reveal semantics from UX-03; otherwise focus is unchanged.
- **Counts/empty state:** derived from the refreshed list; the empty-Inbox
  state must still show the notification so Undo of the last row is reachable.
- Failure rollback is the existing overlay drop; the UI must *say* it rolled
  back, not just silently redraw.

## 5. Tests

Rust (`FakeClock`, paused `FakeArchiveProvider`/Gmail fake, temp SQLite),
Gmail store unless marked:

1. Archive thread with a non-INBOX sent reply → Z at 9 s → exactly the
   originally-INBOX message IDs return; the reply stays out. (Both stores.)
2. Z at 10 s + 1 ms → `expired`; nothing enqueued. (Both.)
3. Provider paused, op still `queued` → Z cancels in place, zero provider
   calls, overlay gone, Activity shows `cancelled`. (Both.)
4. Op `applying` → Z stages compensation; it runs after the original and
   restores. Race: cancel attempt that loses to claim falls through to compensation.
5. New message arrives between archive and Z → compensation targets exclude it.
6. Read op over mixed unread facts → two compensating ops, each restoring its
   group; any `NULL` prior → `unknown_prior`.
7. Newer op on the account → `superseded`; undoing the newer one works; the
   older stays rejected. Retry counts as a newer op.
8. Second Z with the same `requestId` returns the same receipt; a different
   `requestId` → `already_undone`.
9. `outcome_unknown` → `uncertain`; `failed` → `not_applicable`; a compensating
   op → `not_applicable`.
10. Accept offline → restart within window → `undoable_until` still present →
    Z works; restart after window → `expired`. Interrupted compensation
    recovers like any op.
11. Cached Done: cancelled archive and confirmed archive + confirmed
    compensation do not qualify; archive + *failed* compensation still does.
12. Fixture migration `1 → 2` preserves existing rows and request keys.

Vitest / browser-fake: notice lifecycle and status wording per operation
status; Z precedence (palette/editor/overlay/reader disclosure → no undo,
BROWSE-10 style); Z in reader; focus return after undo; last/only-row archive
then undo (BROWSE-08); `superseded` re-pointing; `expired` messaging;
ActivityPanel renders `cancelled` and `undo_of` linkage; contract shape in
`tauri-client.test.ts`; `check:contract`, `typecheck`, `build:web` green.

Mac fixture gate (extends the UX-03 checklist; pending until run): real `Z`
after E on a known row; `Z` inside the palette input types a character and
mutates nothing; archive the only row → valid empty state → Z restores; quit
and relaunch the same profile after an accepted-but-paused archive and undo it
within the window; VoiceOver announces accepted/confirmed/restored separately.
Gmail remote convergence only on the approved disposable account.

## 6. Work breakdown and sequencing

Same ownership model as UX-03: one backend worktree (Rust core, shell, IPC,
generated types, transport tests), one frontend worktree (components,
composables, styles, browser fake, UI tests; sole owner of `App.vue`), parent
owns integration, this document, and independent validation.

| # | Step | Owner | Depends on |
|---|---|---|---|
| 1 | Freeze DTOs/error variant in `dto.rs`/`error.rs`, regenerate `generated.ts`, hand the frozen seam to frontend | backend | — |
| 2 | Per-message effective-facts helper (refactor, no behavior change) + preimage tables/migrations in both stores | backend | 1 |
| 3 | `explicit_targets` acceptance path; `undo_operation` in `GmailStore`, fixture `Store`, `GmailCore`, `MailCore`; `Cancelled` handling in claim/overlay/cached-Done | backend | 2 |
| 4 | Shell command, manifest, capability, permission; `Backend` forwarding | backend | 3 |
| 5 | Rust tests §5.1–12 | backend | 3 |
| 6 | `MailClient.undoOperation`, `browser-fake` model, action catalog, `Z` dispatch, `useMailbox.undoLastAction`, `ActionNotice.vue`, Activity rendering | frontend | 1 (frozen seam) |
| 7 | UI tests §5 | frontend | 6 |
| 8 | Integration, six `.pi/factory.json` checks, fresh-context review, ledger in this doc | parent | 4–7 |

Rough size: backend ≈ the UX-03 cached-Done backend (new table + command +
~12 integration tests); frontend smaller than UX-03 (one component, one key, one
composable path). The fixture CHECK rebuild is the only non-additive migration.

## 7. Decisions needed before implementation

Each decision lists what the target is documented to do. `D` = Superhuman help
center; `U` = unresolved; "blog" = the Dec 2016 Superhuman engineering post
[Architecting a web app to "just work" offline](https://blog.superhuman.com/architecting-a-web-app-to-just-work-offline-part-1/),
which describes mechanism a decade ago and is supporting inference, not `D`.

1. **Single-level "newest on account" supersession** (§3.2 rule 4) versus
   "newest on the same targets". Recommended: newest on account for UX-04; it
   is simpler to reason about and strictly safer. UX-05 group Undo can relax it.
   *Target:* "hit Z within 10 seconds" to "undo your last action"; Mark Done:
   "Change your mind? Hit Z to undo." (`D`; [Undo](https://help.superhuman.com/hc/en-us/articles/46005666743309-Undo),
   [Mark Done](https://help.superhuman.com/hc/en-us/articles/47439134613773-Mark-Done)).
   Always singular, account-wide. Undoing an older action after a newer one is
   not documented (`U`); "same targets" would be invented capability.
2. **Cancel-in-place for queued intent** requires `OperationStatus::Cancelled`
   and the fixture table rebuild. Alternative: always compensate (no new status,
   but an offline archive + Z would queue two network operations instead of
   none). Recommended: cancel-in-place, as the plan states.
   *Target:* mechanism undocumented in help (`U`). Blog: per-thread modifier
   queues; `modify()` applies locally and synchronously (per message label),
   `persist()` async; permanent failure handling is "remove the modifier from
   the queue, recombine the cached email data with the rest of the modifiers"
   — i.e. cancel-in-place; star→unstar produces two ordered persisted
   modifiers — i.e. compensation once persisted. Consistent with §3.3.
3. **Expired-window recovery wording.** After 10 s the only path is Activity /
   Mark Not Done, which restores *all* messages to the inbox, not the exact
   preimage. The notice should say "Undo expired — Mark Not Done restores the
   whole conversation to Inbox". Confirm this is acceptable, or extend the
   window locally (would be a documented departure from the `D` value).
   *Target:* "There isn't a way to extend the Undo window at the moment."
   (`D`; Undo FAQ). After that: go to Done or search and "move it back to your
   inbox anytime" (`D`; Mark Done FAQ) — a forward action. Whether their Not
   Done is per-message-exact or whole-thread is `U`; Gmail `threads.modify`
   is whole-thread. Exception: Get Me To Zero is reversible for seven days via
   Cmd+K → Bulk Actions (`D`; [Mass Archive](https://help.superhuman.com/hc/en-us/articles/46005611576589-Mass-Archive));
   that is bulk-only and belongs to UX-05.
4. **Read Undo is Gmail-only** because the fixture has no read setter.
   Confirm that the native fixture gate covering Done/Not Done only is
   sufficient for this slice.
   *Target:* Undo is documented for sends, reminders, Done, and generically
   "your last action" (`D`); read/unread specifically is `U`. The Undo article
   also confirms `Cmd+Z` is text autocorrect undo, supporting the Z-only
   binding. The fixture limitation is a repository constraint, not a target
   behavior.

## 8. Implementation ledger

Status: implemented on `feat/ux-04-trustworthy-undo` by two isolated worker
lanes (backend: Rust/shell/IPC; frontend: components/composables/browser fake),
integrated by the parent at `7cc2131`, then reviewed by two fresh-context
read-only reviewers. Nothing here certifies native WKWebView behavior.

### Integrated gate results (parent, `7cc2131`, logs `/tmp/ux04-integrated/`)

| Configured command | Result |
| --- | --- |
| `mise run test:core` | 199 passed (106 unit; 2 cached_done; 7 draft_core; 8 gmail_auth_contract; 30 gmail_cache_sync; 15 gmail_operations; 16 integration; 15 new `tests/undo.rs`) |
| `mise run check:contract` | exit 0 |
| `mise run lint:core` | exit 0 |
| `mise run test:ui` | 335 passed / 20 opt-in browser tests skipped |
| `mise run typecheck` | exit 0 |
| `mise run build:web` | exit 0 |

### Deviations accepted from the lanes

- `MailCore::open_with_clock` / `GmailCore::open_with_clock` additive
  constructors so the 10 s window is testable with `FakeClock`.
- `gmail_operation_requests.accepted_at` (nullable, additive) so an idempotent
  replay of a *cancelled* undo returns the identical receipt.
- Undo admission does not require Gmail mutation access: cancel is local;
  compensations recheck capability in the unchanged executor.
- Re-undo of an already-cancelled operation reports `already_undone`.
- Preimage `prior_value` is stored in the operation's own requested-value
  domain (archive → effective archived; read → effective read).
- `Z` is also suppressed while a reader message-details disclosure is open.

### Review findings

Core reviewer: no P0/P1; verdict *needs attention*. Accepted: retry of a
failed compensation must keep `undo_of` (otherwise a redo path appears);
vacuous zero-provider-call assertions; cancelled-replay untested; stale
`last_error` on cancel; capability description count; misleading race comment;
add an effective-preimage pin test. **Declined:** skipping the compensation
group whose prior value equals the original's requested value — a remote no-op
that halves network writes in the sent-reply case; recorded as a follow-up
optimisation, not a defect.

UI reviewer: two P1s; verdict *needs attention*. Accepted: post-undo
"Restored / Cancelled / Restore failed / Restore outcome unknown" feedback
(the slot was cleared on success, so the cancel path showed nothing);
key-repeat double undo producing a false `already_undone` error; notice button
not `inert` under overlays; undo control driven by stale slot `undoableUntil`;
expired wording shown for never-undoable actions and with Done-specific
recovery advice for Not Done/read; late receipt after account change
re-populating the slot; focus dropped to `body` after a button undo;
`display:none` live region; fake/Rust divergences; test gaps. **Declined:**
letting `Z` reach the backend after the local 10 s gate closes. Policy: the
local timer closes the key, palette entry and button; anything that *is* sent
is still decided by Rust, and the expiry wording after a locally closed window
is a local statement about the control, not a claim about backend state. This
is a proposed reconstruction policy.

### Fix pass

Two fresh worktree workers applied the accepted findings off `7cc2131`.
Backend: `accept_retry` now propagates the original's `undo_of` (regression
test mutation-verified); both §5.3 tests now confirm an unrelated operation
after the cancel and assert the provider saw only that one; cancelled-replay
idempotency and `already_undone` asserted in both stores; `last_error`
(Gmail) / `failure_kind` (fixture) cleared on cancel; comments reworded; new
effective-preimage pin test (`the_preimage_is_the_effective_value_under_a_pending_earlier_operation`).
Frontend: slot retained after undo with `undone` receipt and compensation
lookup ("Cancelled" / "Restored" / "Restore failed — see Activity" /
"Restore outcome unknown — see Activity" / "Restoring…"); `event.repeat`
and in-flight gate on `undo`; notice button routed through `executeAction` and
`inert` under overlays; undo control driven by the refreshed row's
`undoableUntil`; `hadWindow` gate and per-action expiry recovery clause;
session-fenced `recordLastAction`; focus fallback to reader/list after a
button undo; always-rendered live region; fake aligned with Rust
(`already_undone`, cached-Done candidate exclusion); Activity hides Unarchive
for cancelled archives; expired alert de-duplicated; test gaps filled.

Integrated gate results after the fix pass (parent, logs `/tmp/ux04-fixpass/`):

| Configured command | Result |
| --- | --- |
| `mise run test:core` | 201 passed (17 in `tests/undo.rs`); no gmail_operations flake observed |
| `mise run check:contract` | exit 0 (no DTO change in the fix pass) |
| `mise run lint:core` | exit 0 |
| `mise run test:ui` | 359 passed / 20 opt-in browser tests skipped |
| `mise run typecheck` | exit 0 |
| `mise run build:web` | exit 0 |

### Scoped rechecks of the fix pass

Core recheck: **correct**; every accepted fix verified against the diff, each
new/strengthened test shown to fail without its fix, no new P0–P2. One P3
recorded as policy rather than changed: after a compensation is *retried*, an
idempotent replay of the original undo request reports `operationIds` as all
compensations in queue order (including the retry), not only the ids committed
at undo time. Nothing in `src/` consumes `operationIds`. Residual pre-existing
risk noted: the Gmail §5.3 test's `wait_status(Queued)` returns immediately at
acceptance; a mid-claim worker could take the compensation branch. Observed
green on every run; not changed in this slice.

UI recheck: **needs attention** (no P0/P1). Accepted and applied in a second
fix pass by the resumed UI worker: fake cached-Done filter must qualify if
*any* archive lacks a live compensation (archive → undo → re-archive was
wrongly hidden); backend `expired` rejection now refreshes before closing the
slot window and the UI test holds the list read so `Z` genuinely reaches the
backend; success write-back guarded against clobbering a newer action recorded
during the undo's refresh; post-undo palette/key gate ignores a stale activity
row. Applied and verified; UI: 362 passed / 20 opt-in skipped, typecheck and
build exit 0; core 201, contract and lint exit 0 (logs `/tmp/ux04-fixpass2/`).

### Native validation

The operator checked out `674c5f3` on the MacBook (`/Users/sofianebebert/workspace/email-os`)
and ran the fixture-mode checklist (shell compile, happy path, reader and
precedence, last/only row, paused-provider cancel-in-place, rejecting-provider
rollback, VoiceOver) and reported it as passing. This is an operator report,
not a parent-captured evidence log; no step-by-step artefacts were retained.

### Still pending (not inferred from these checks)

Real-Chrome rendered suites, Gmail remote convergence on the approved
disposable account, and read/unread Undo (Gmail-only; the fixture has no read
setter). `pkg-config`/GTK remain unavailable in this VM; no
prerequisites were installed. Known unchanged baseline limitation: the
default-locale `30 Sept 2001` layout assertion.

Merged to `main` via pull request at the operator's request after native
validation; the feature branch was deleted locally and on origin.

## 9. Known risks

- `gmail_operations.rs` confirmation-wait flakiness recorded in the UX-03
  ledger is unresolved; Undo tests add more worker waits. Use the same
  patterns, record default and `RUST_TEST_THREADS=1` results separately, and
  do not change scheduler or timeouts inside this slice.
- The 10 s window is checked against `accepted_at`, so a slow IPC round trip or
  a frozen app eats into the window. Acceptable and honest; do not pad it.
- `undoable_until` in `OperationSummary` is computed per query; the list query
  already loads all operations, so cost is negligible, but it must use the same
  `Clock` as the command path or tests will disagree.
- Default-locale Chrome layout assertion (`30 Sept 2001`) remains a known red
  gate unrelated to this slice.
