# UX-08 — stars implementation contract

Base: UX-05 (`6c30b9c`). UX-06 saved splits and UX-07 search do not exist in
this checkout and are not prerequisites for cache-scoped Starred browsing.

## Narrow contract

- Store observed star facts per account/message, including messages whose body
  cannot be rendered. Missing legacy facts are unknown, never false.
- Conversation star aggregation is existential: one known star proves membership;
  no known stars proves absence only with complete known inventory. Report known,
  starred and total counts; partial facts remain visible.
- Star setters affect the immutable observed message inventory at acceptance, not
  later arrivals. They change STARRED only, independent of INBOX and UNREAD.
- Reuse durable operation ordering, snapshots, retries, reconciliation, groups
  (100 loaded conversations maximum), preimages and ten-second latest-action Undo.
  Unknown prior values cannot claim exact Undo. Uncertain dispatch is read-reconciled,
  never silently reposted.
- Starred is local-cache coverage, including archived and retained conversations;
  it is not provider-complete and has no fabricated mailbox total.
- S toggles a single fully known target; unknown/partial targets and bulk actions
  use explicit Star/Unstar desired states. Selection remains exact account+IDs.
- Unstar removal uses next surviving row, then previous, then empty; reader Back
  restores its originating context. Context changes clear selection.
- Gmail writes require verified modify capability and operator authorization for
  any real-account validation. No credentials, OAuth changes, external writes or sends
  are authorized here. Fixture/browser coverage must not be called native/provider
  convergence. Plain text, no-auto-read, drafts and normal-close gates remain intact.

## Acceptance checklist

- [x] migration preserves unknown legacy facts; unsupported bodies retain star facts
- [x] mixed/partial/unknown aggregation and account fencing
- [x] durable exact-target single and group setters, independent dimensions
- [x] failure, restart, reconcile, unknown prior and mixed-preimage Undo
- [x] archived mail in Starred; unstar neighbor/reader/Back; S and explicit bulk actions
- [x] typed IPC registration, allowlist, generated contract, transport tests
- [x] UI/typecheck/build/lint/contract and native compile/bridge checks
- [ ] fully green core gate (existing queued-versus-claimed Undo test race below)
- [ ] rendered Chrome, native GUI and approved disposable-provider validation

## Implementation and capability boundary

Implemented directly in this worktree, without merging other slices or delegating.
No UX-06/07 infrastructure was imported. The native legacy fixture store supports
archive only (as before for read state); it now explicitly rejects all three star
commands with `read_only`. Star controls and destination are absent in that mode.
The Gmail core is tested with a synthetic provider/temporary SQLite; the labelled
browser fake supports stars only in its simulated Gmail mode. Neither reaches a
real mailbox during these tests.

Wire additions are Rust-owned `StarState`, `SetStarred`, `SetStarredGroup`, optional
`stars` aggregates and `requestedStarred` operation/group fields. Commands:
`set_starred({command})`, `set_starred_group({command})`, and
`list_cached_starred({request})`. The latter reuses the bounded
`CachedDoneRequest`/`CachedDoneSnapshot` *shape*, not Done membership semantics.
Cursors have a separate `cached-starred-v1` namespace, remain account-bound and
are not snapshots. A short/empty candidate page can still have a continuation.
`exactTotal` stays null. No inbox discovery cursor or history checkpoint changes.

SQLite stores nullable per-message observations; the provider's explicit map also
retains partial label coverage and unsupported-body IDs. `StarState` describes
**effective cached values** (observations plus pending intent), not remote success.
Pending operation IDs/status remain visible; copy explicitly distinguishes local
intent from provider confirmation. A known positive establishes membership with
partial coverage; absent positives establish absence only for a nonempty fully
known inventory. `S` toggles only a fully known single target; on unknown/partial
state or with a selection it means explicit Star. Unstar is always available as
an explicit desired-state action when authorized. Both use all immutable observed
message IDs, including unsupported bodies, and never a later reply.

A single starred-only filter works within Inbox/cached Done over returned cached
rows. Unknowns do not match. Changing it clears selection, preserves ordinary mail
membership and adds a Back entry; destination Back restores filter/focus/loaded
range. No saved split, provider search, cross-page selection or filter-combination
engine is implied. Catalog, rail, header controls, S, notices, Activity and Z all
reuse the existing named durable action paths. The reader advances on single
unstar removal in Starred/filtered views using action-time next/previous ordering;
bulk dispatch deliberately does not use single-reader auto-advance.

ADR 0001 now explicitly records this bounded expansion from archive/read to
STARRED only, without new OAuth scopes or arbitrary-label authority.

## Validation ledger

### Headless synthetic core / Vue / IPC

- `mise run test:ui`: **447 passed, 21 opt-in rendered tests skipped**. Includes
  seven new star cases: archived browsing/unstar; exact noncontiguous bulk targets
  and group Undo; reader next/Back focus; cache filter/Back; typing/IME/modifier
  safety; bounded empty-page/keyset cursor fencing; unsupported legacy fixture boundary.
- `mise run typecheck`, `mise run build:web`: pass.
- `mise run gen:ts`, `mise run check:contract`: pass; generated TS was not edited.
- `mise run lint:core`: pass (fmt and clippy `-D warnings`).
- Eight new synthetic Gmail-core star integration tests pass: archived membership
  and independent read/inbox state; fail/restart/retry retaining original IDs;
  legacy migration/unknown facts/account and cursor fencing; aggregation;
  uncertain dispatch/restart/GET reconciliation without repost;
  mixed-preimage group Undo; retained offline recovery snapshot; capability denial
  and unknown-prior Undo refusal. Provider tests cover partial observations,
  unsupported bodies and exact STARRED-only HTTP setter bodies over snapshot IDs.
- Full `RUST_TEST_THREADS=1 mise run test:core` was run twice. Latest result:
  all other suites pass (136 lib, 2 cached Done, 7 drafts, 7 auth, 30 cache/sync,
  23 operation tests including eight stars, 16 integration); Undo **16/17**.
  `cached_done_excludes_cancelled_and_undone_archives_but_keeps_failed_compensation`
  expects `Cancelled` but the worker can claim between its queued read and Undo,
  correctly returning `Compensating`. This exact pre-existing race is recorded in
  UX-05 §9–10; the failing assertion/worker scheduler was not changed here.
  Earlier parallel checking also hit the documented queued-Undo assertion race
  in `undo_of_a_still_queued_operation_cancels_in_place_with_zero_provider_calls`.
  **The full core gate is not claimed green.** Logs: `/tmp/ux08-core-final2.log`;
  focused star test output is in the session tool history.

### P1 follow-up — retained inventory survives real cache trimming

Body-cache eviction and capped rediscovery now retain **all observed message
facts** for conversations with an account-matched operation recovery snapshot,
not only immutable operation targets. This also preserves later-arrival INBOX /
UNREAD facts and unknown star values. Retry/Undo target sets are unchanged.
Conversations without recovery context still lose non-target facts; explicit
provider message/thread deletions and disconnect still clear facts. Existing
small-slice operation/snapshot history retention is unchanged; this does not pin
arbitrary archived threads or enlarge the 100-conversation body cache.

Synthetic/local follow-up validation only:

- `mise run test:core -- --test gmail_operations stars::cache_trim_preserves_starred_arrival_outside_original_operation_targets -- --exact --nocapture`:
  **1 passed**. Confirm Unstar on `m-1,m-2`, sync starred `m-3`, seed 100 newer
  synthetic bodies plus an unretained eviction control, then let the real history
  checkpoint trim the cache. Detail and paginated Starred preserve `{starred: 1,
  known: 3, total: 3}` with retained-snapshot disclosure; body count is 100,
  unretained facts are removed, original operation targets remain `m-1,m-2`, and
  there is no extra provider mutation. No manual body deletion drives this test.
- `mise run test:core -- --test gmail_operations stars::`: **9 passed**.
- `mise run test:core -- --lib capped_rediscovery_retains_full_recovery_inventory_not_unretained_facts`:
  **1 passed**; includes unknown-star inventory, independent INBOX/UNREAD,
  unretained-fact cleanup, explicit message deletion and disconnect cleanup.
- `mise run test:core -- --lib gmail::store::tests::`: **28 passed**.
- `mise run test:core -- --lib star`: **6 passed** (substring filter also
  selects restart tests, not six dedicated star tests).
- `mise run test:core -- --test gmail_operations`: **24 passed**.
- `mise run test:core -- --test gmail_cache_sync`: **30 passed**.
- `mise run lint:core`: **pass**, formatting check and core clippy `-D warnings`.

The full core gate, UI/native/browser gates and provider convergence were not
rerun for this follow-up. No P2 UI/browser-fake changes are included.

### Rendered browser evidence (separate, pending)

`tests/discovery.rendered.test.ts` adds an opt-in trusted CDP journey for S →
archive → cached Starred → unstar/empty → context Back, using only the labelled
in-memory fake and a temporary Chrome profile. It was **not executed** here:
`EMAIL_OS_RENDERED_LAYOUT_CHROME` was not configured and the standard Chrome
binary was absent. No browser/OS packages were installed. jsdom results above
are not rendered layout, native keyboard or provider evidence.

### macOS native compilation versus runtime/provider gates

- `mise run check:native`: pass on this macOS host.
- `mise run test:native`: **7/7 pass**, including typed fixture star denial,
  named commands/permissions and existing draft/normal-close tests. Generated
  narrow permission files are retained. No generic execution capability was added.
- The native GUI was not launched. No OAuth, Keychain, real-mailbox reads/writes,
  credentials, remote sends or operator security gates were exercised or changed.
- Still required with operator approval: WKWebView actual S/palette/IME/VoiceOver,
  neighbor and reader Back/scroll at desktop breakpoints; native restart recovery
  and close/draft regression; disposable-Gmail modify denial/revocation and
  STARRED-only convergence, offline/uncertain restart reconciliation, exact group
  targets, new incoming reply exclusion and mixed per-message Undo.

No native GUI or remote convergence claim follows from fakes or compilation.
The concrete implementation boundary is the existing archive-only fixture profile,
not a dependency on another active thread. No unresolved product/security decision
was silently used to enable unsupported controls.
