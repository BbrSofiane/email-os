# UX-06 + UX-08 integration ledger

## Scope and merge state

Integration on `feat/ux-08-implementation`, starting at
`df0d27acbc89c838b8bc2ed4d370f8bb08da7d87`, with
`git merge --no-commit --no-ff 73e37fff3d7182ce44dfa322e493fa5f9fd9f1af`.
All 22 conflicted paths resolved semantically. The integration worker left the
merge staged for independent validation; final publication is on the feature
branch only. No merge into main or other-worktree modification was performed.
The ignored private `mise.local.toml` was not read or changed. Commands below use
installed tools directly, not private mise tasks/environment inspection.

This note supersedes the pre-integration statements in `ux-08-stars.md` that
UX-06 is absent. UX-07/provider search remains out of scope.

## Resolution decisions

- `useMailbox.ts`, `App.vue`, InboxList/ReaderView/SelectionBar: union of
  Inbox, saved, cached Done and cached Starred contexts. Preserve saved-definition
  loading/error/session/busy fences, atomic newest-sender membership/totals,
  Activity recovery authority and list-origin invalidation. Apply that same saved
  target fence to single Star/Unstar; groups already share the fenced dispatcher.
- Minimal filter composition is **intersection**, after ordinary context
  membership: `(!unreadOnly || isRead === false) && (!starredOnly || known positive
  starredMessages)`. Unknowns never qualify. Neither filter changes split rules,
  unfiltered badges, message read state or provider membership. Unread remains
  session-local across destinations and Back (UX-06); starred remains view/history
  state restored by UX-08's context history. Toggling either preserves the other.
  Both reset on account change/disconnect. No new query language or saved criteria.
- Cached Done/Starred retain separate IPC/cursor namespaces, unfiltered candidate
  continuation and loaded keyset boundaries even on empty filtered pages. Split
  definition/list failure cannot prevent independent cached destination rows.
  Tab split navigation owns only Inbox/saved list focus, not cached destinations.
  Inbox-only count disclosure no longer appears over cached Starred.
- Commands preserve both split create/edit and Star/Unstar, including permission-
  disabled discoverability, S and exact selected/focused/open identities. No header
  Star/Unstar buttons, hollow unstar row glyphs or standalone split editor triggers
  were introduced. No-auto-read, literal text, drafts/normal close and action-time
  versus reader-entry ordering remain unchanged.
- Rust DTO generator, client/transport, Tauri handlers/build allowlist/capability:
  preserve both narrow IPC surfaces. `generated.ts` was regenerated with the
  merged Rust generator, never hand-resolved. Saved split storage/newest sender
  metadata coexist with star facts, setters/groups/reconcile/Undo/retry/recovery.
- Preserve accepted P1: account-matched recovery snapshots keep **all observed
  facts** through real body eviction/capped rediscovery; immutable operation IDs
  still exclude later arrivals. Explicit deletion/disconnect and unretained-fact
  cleanup remain unchanged. Existing actual-eviction star regression and capped
  rediscovery regression pass in both complete core runs.
- Rust thread fixture conflicts now carry both newest-sender and conservative
  `star_facts: None`. Native sender wire fixture explicitly asserts 3 known,
  unstarred observed messages from its actual provider payload, without weakening
  its whole-JSON equality. Command label assertions still assert exact copy, now
  on `.action-copy > span`, excluding UX-08's decorative aria-hidden icon.
- Both rendered test families retained. Rust formatting applied to merged source.
  No scheduler assertion or unrelated scheduler behavior changed.

## Added synthetic cross-feature regressions

- `tests/saved-split-stars.integration.test.ts` (4): filter intersection/unknowns,
  unfiltered totals, saved/history Back and account resets; exact noncontiguous
  Star/Unstar groups + Undo, archived cached Starred and both command families;
  cached continuation/boundary with failed split reads; stale single/frozen group
  star fencing during saved-rule invalidation.
- `gmail/newest_sender_tests.rs`: real parser → saved definition → mixed observed
  stars → exact group Unstar including HTML-only IDs → reopen/account/disconnect;
  newest sender and read state stay independent.
- Tauri `saved_split_bridge_coexists_with_gmail_only_star_surface`: both narrow
  registrations/allowlists, fixture split round-trip/account fence, fixture star
  rejection. No GUI, credentials or provider connection.

## Validation (installed tools, local synthetic/mock HTTP only)

All paths below are local logs, not assertions of real-provider convergence.

| Command | Result | Log |
|---|---|---|
| `pnpm exec vitest run tests/saved-split-stars.integration.test.ts tests/stars.component.test.ts tests/saved-split.test.ts tests/saved-split.native-sender.test.ts tests/app.saved-split-activity.test.ts tests/create-split-command.test.ts tests/unread-filter-command.test.ts tests/useMailbox.saved-split-safety.test.ts tests/split-editor.component.test.ts` | 9 files, **71 passed** | `/tmp/ux08-integration-focused-ui-final.log` |
| `pnpm test` | 29 files passed, 4 skipped; **514 passed, 28 skipped** | `/tmp/ux08-integration-ui-final3.log` |
| `pnpm typecheck` | pass | `/tmp/ux08-integration-typecheck-final2.log` |
| `pnpm build` | pass | `/tmp/ux08-integration-build-final2.log` |
| `cargo test --locked -p mail-core -- --test-threads=1` | **246 passed**, including all 17 Undo tests | `/tmp/ux08-integration-core-serial.log` |
| `cargo test --locked -p mail-core` | **246 passed**, including all 17 Undo tests | `/tmp/ux08-integration-core-final.log` |
| `cargo test --locked -p mail-core gmail::store::newest_sender_tests` | **2 passed** | `/tmp/ux08-integration-focused-core.log` |
| `cargo test --locked -p mail-core capped_rediscovery_retains_full_recovery_inventory_not_unretained_facts` | **1 passed** | same focused-core log |
| `cargo test --locked -p mail-core operation_recovery_snapshot_survives_cache_eviction_and_can_be_restored` | **1 passed** | same focused-core log |
| `cargo fmt --all -- --check` | pass | `/tmp/ux08-integration-format-final.log` |
| `cargo clippy --locked -p mail-core --all-targets -- -D warnings` | pass | `/tmp/ux08-integration-clippy-final.log` |
| `cargo run --locked -q -p mail-core --bin generate-types -- "$tmp"` then `diff -u src/lib/ipc/generated.ts "$tmp"` | no drift | `/tmp/ux08-integration-contract.log` |
| `cargo check --locked -p email-os --all-targets` | pass | `/tmp/ux08-integration-native-check-final.log` |
| `cargo test --locked -p email-os` | **8 passed** | `/tmp/ux08-integration-native-test-final.log` |
| `git diff --check` / staged counterpart | pass | terminal output |

Initial intermediate failures were integration/test-fixture issues, not the known
scheduler race: two exact command text assertions included the newly decorative
icon; provider wire equality lacked the new stars aggregate. Fixed as above.
New test authoring also initially used an unsupported fake account field, omitted
required cache coverage, and allowed a fake save event to supersede a delayed
read; those harness errors were corrected without weakening the assertions.
Earlier failed outputs remain `/tmp/ux08-integration-ui.log`,
`/tmp/ux08-integration-core.log`, `...-cross-ui.log`, `...-focused-ui.log`,
`...-typecheck-final.log` and `...-ui-final2.log`.

The documented queued-versus-claimed Undo race did **not** reproduce in either
final full run. Passing runs do not prove it fixed; no scheduler tests were edited
except resolving the unrelated GmailThread fixture fields in `crates/mail-core/tests/undo.rs`.

## Independent review follow-up — consistent Starred sender identity

Independent review passed the combined tests but identified a missed adaptation:
Cached Starred derived its sender from the last renderable body, unlike Inbox and
Done. The final integration now reads account-scoped persisted newest-provider-
message metadata for Starred too. Missing/legacy metadata and recovery-only
snapshots return unknown, never an older body's sender.

`gmail::store::newest_sender_tests::starred_summary_uses_newest_sender_and_never_falls_back_to_snapshot_bodies`
passes as a focused regression. It covers an HTML-only starred newest message,
reopen persistence, missing/malformed From, legacy null metadata, sender agreement
across Inbox/Done/Starred, and unknown sender identity in Done/Starred recovery-only
snapshots. It does not change saved criteria, message targets, authority, retention
or any previously deferred P2.

After this follow-up, final parent validation passed: **247 core tests** (including
all 17 Undo tests), **514 UI tests** with 28 opt-in rendered tests skipped, and
**8 native bridge tests**. Core formatting/clippy, typecheck, web production build,
native compilation, generated-contract comparison and whitespace checks all pass.
Full output: `/tmp/ux08-combined-qa-final.log`. These results supersede the earlier
246-test core totals for the final integration; the new sender regression adds one
test. No historical scheduler-race fix or native/provider convergence is claimed.

## Native-QA readiness / exclusions

Ready for operator-authorized native QA after independent validation, not approval
to merge into main or authorize a real mailbox. Opt-in rendered Chrome suites (28 tests),
WKWebView actual keyboard/IME/VoiceOver, native GUI restart/close, OAuth/Keychain
and disposable-provider convergence were **not run**. No dev:gmail/dev:native,
OS/package install, live provider or credential action was performed.

Deferred P2s remain deliberately unchanged: late single-star focus stealing;
bulk-last-row DOM focus; reader Unstar advancing when refreshed membership still
survives; fake reconnect losing stars; palette-highlight contrast. The integration
adds only the necessary saved-target star fence and filter/paging composition;
it does not claim to remediate those P2s.
