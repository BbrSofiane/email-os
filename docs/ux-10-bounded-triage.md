# UX-10 — Optional bounded triage contracts

Status: **A implemented; B–E not enabled.** This is deliberately a read-only
prerequisite increment, not completion of the requested trash/recover journey.

Original base: `feat/ux-05-safe-bulk-processing` at `6c30b9c`. Rebased onto
`origin/main` at `7fbd928` (UX-09 merge); UX-06–09 are now present and preserved.
This is a partial UX-10, not a claim that the roadmap or BROWSE-12 is complete.
No real mail authority.

## Original prerequisite inspection (before rebase)

At the original base, UX-06/07/08/09 were absent. There is no provider-folder query/catalog, separate
Important/Other view membership, or trash operation dimension. Gmail currently
extracts only INBOX/UNREAD; SQLite operation targets/preimages, worker, retry,
Undo and groups implement only archive/read. Archive evidence alone cannot
establish that a conversation is not now in Trash or Spam.

## A — Read-only cached Trash and membership safety (enabled)

Journey: open **Cached Trash** → inspect known locally cached trashed conversations
→ open literal plain-text reader → Back to Cached Trash. No automatic read,
provider request, mutation, draft creation, external opener or send is involved.
This is a bounded local read destination, not provider-complete Trash discovery.

- Full Gmail thread parsing captures exact per-message TRASH/SPAM membership.
  SQLite additive nullable facts preserve legacy unknowns, unsupported-body IDs,
  operation-retained facts and snapshots across restart. Unknown is not false.
- Any observed TRASH/SPAM message excludes the conversation from Inbox and Done,
  including locally archived conversations later externally trashed/spammed.
  This is conservative conversation-level presentation, not a new label setter.
- `list_cached_trash` is account scoped, read-only, pages 1–100 candidates in
  newest-date/ID order. Cursor is versioned/account-bound, not authorization or
  a retained snapshot. Results include only known TRASH membership with readable
  cached or retained context; null exact total and local-cache coverage.
- Fixture native backend rejects this Gmail-only read destination. Browser fake
  explicitly models synthetic membership in memory, never native durability.
- Cached Trash is a read-only list context in the main list pane (not a drawer),
  and a Trash open uses it as its reader origin. Back returns to this list at the
  same row; adjacent navigation and shared mailbox actions are suppressed in the
  list and in this reader.
  Existing Activity, durable intent/Undo/groups, local drafts and normal close
  remain unchanged. No Trash mutation control or misleading Restore-to-Inbox.

Acceptance checklist (execution evidence appended below):
- [x] Provider extraction includes TRASH/SPAM even for unsupported message bodies.
- [x] Migration/restart, retained snapshot, account/cursor/limit rejection.
- [x] Archive evidence cannot put known Trash/Spam in Done; unrelated rows survive.
- [x] Vue → typed transport → native command/permission → SQLite query wiring
  implemented and compile/transport tested (not native UI E2E certified).
- [x] Synthetic drawer → exact account+ID reader → Back; no writes or auto-read.
- [x] Generated contract, core/UI/lint/typecheck/web/native tasks recorded below.
- [ ] Native WKWebView/VoiceOver full journey and real-provider validation.
- [ ] Trash/recover mutation, immutable multi-dimension preimages and Undo (B).
- [ ] BROWSE-12 placement/scopes (D).

## B — Trash/recover + Undo (NOT enabled)

Concrete prerequisite: there is no trash dimension/preimage or provider trash
adapter here. Reusing `setArchived` would change INBOX, not TRASH. A new contract
must settle exact message-level provider effects (including INBOX effects of
trash/untrash), mixed memberships and recovery destination before implementation;
then persist all changed dimensions and immutable IDs atomically and extend
single/group/retry/reconciliation/Undo tests. No permanent-delete/empty-Trash.
Decision requested before enabling: should recovery restore captured per-message
pre-trash membership, or only remove TRASH and leave archived mail archived?
These are different operations; neither is silently mapped to Not Done.

## C — Mute/unmute and Spam/recover (NOT enabled)

Require validated Gmail semantics and exact recovery effects, new durable
preimages and uncertainty tests. Removing INBOX is not mute, and no future-mail
behavior is claimed. SPAM is captured as a read fact only in A.

## D — Important/Other and rules (NOT enabled)

Needs separate local view membership and explicit per-conversation scope first;
Gmail IMPORTANT is not this model. Sender/domain rules require a further bounded
contract, matching rules, existing/future-mail scope and disclosure that execution
only runs while the app runs. No rule engine or UX-06 replacement here.

## E — Unsubscribe/Block (omitted)

No exact external URL/send/provider authority contract exists. No controls,
arbitrary URL opener, hidden send path, filter creation or credential changes.

## Evidence

### Headless core and component evidence

- `mise run gen:ts`: generated TypeScript from Rust; no manual generated edits.
- `mise run check`: passing after the P1 fix (233 core tests; 445 UI tests, 21 opt-in browser
  tests skipped; generated-contract check, fmt/clippy and typecheck pass).
- `mise run build:web`: passing production build.
- New store tests cover exact membership, tie-keyset paging, invalid account/
  cursor/bounds, old archive evidence versus observed Trash/Spam, unrelated
  conversation independence, retained-reader recovery and reopen, and additive
  migration preserving unknown legacy facts. Provider parsing covers message IDs
  without safe bodies. Existing durable-operation/group/Undo/draft tests remain.
- Five new component/fake tests cover exact account+ID, selected-set isolation,
  no mailbox writes/Reply, reader Back and focus, unsupported mode rejection,
  empty versus error/retry and unmounted delayed responses. The transport test
  asserts the generated named command and exact `{ request }` envelope.
- Earlier check attempts exposed formatting and a new test's bool-assert clippy
  issue, both corrected; these failed attempts are not reported as passes.
  Locked UI dependencies were installed with `mise run install:ui` because this
  worktree initially had no node_modules. No OS packages were installed.

### Rendered synthetic browser evidence (not native/provider)

`tests/discovery/discovery.rendered.test.ts`: **6 passed**, using trusted CDP keyboard/
mouse input with the existing Comet Chromium binary, a fresh temporary browser
profile and only local Vite/synthetic data. The new UX-10 scenario runs at 1200
and 999 CSS px: Commands → cached Trash → exact hostile-text fixture reader →
Back to its row. It asserts literal markup, no script/image elements, no Reply,
no mailbox/draft writes, and restored row focus. It does not measure Superhuman
pixel parity, remote convergence or assistive technology behavior.

```sh
EMAIL_OS_RENDERED_LAYOUT_CHROME=/Applications/Comet.app/Contents/MacOS/Comet \
  mise exec -- pnpm exec vitest run tests/discovery/discovery.rendered.test.ts \
  --maxWorkers=1 --minWorkers=1
```

The first rendered run passed UX-10 but failed the old palette typing assertion:
it selected `document.querySelector('input')`, now a UX-05 checkbox (`value=on`),
not the palette input. Narrowed it to `[data-test="action-query"]`; all six then
passed. No typing/no-mutation assertion was removed or weakened.

### Adversarial-review follow-up — selected P1 only

The accepted P1 showed that real over-cap eviction and capped rediscovery pruned
later untargeted TRASH/SPAM message facts, despite retaining an older archive
operation and reader snapshot. The original retention test deleted bodies
manually and did not exercise either pruning predicate.

Both production pruning predicates now retain current conversation facts under
same-account recovery-snapshot ownership, independently of historical operation
targets. This does not retain extra bodies or expand any original targets or
preimages. Full provider observations still replace the facts; message/thread
deletion and disconnect still clear stale evidence. Facts already lost under the
old pruning behavior cannot be reconstructed locally: they require a fresh
provider observation, not a fabricated clean membership or new provider access.

`triage_facts_survive_real_cache_eviction_and_capped_rediscovery` exercises both
production paths with later untargeted TRASH/SPAM messages, reopen, unchanged
immutable targets/preimages, unrelated rows, account-scoped ownership, unowned
fact pruning, membership removal, message/thread deletion and disconnect.

The three report-only P2s remain deliberately unfixed under the selected scope:
failed refresh Retry mode/cursor, original Inbox anchor when entering Trash from
an existing reader, and TRASH/SPAM inventory memory accounting. No new mutation
capabilities or authority were added.

Worker validation: 30 store unit tests and 64 cache/Done/operations/Undo
integration tests passed with serialized test threads; `mise run lint:core`
passed. Parent independently ran the default `mise run check` (233 core tests,
445 UI tests, 21 opt-in browser tests skipped), the production web build and
native compile/bridge gates. The final results are summarized below. Rendered
browser evidence above is the pre-fix UI run, not a new browser or provider run.

### Native compile/bridge evidence versus remaining runtime gates

`mise run check:native` and `mise run test:native`: **passing on this Mac**;
7 native tests, including direct fixture-mode rejection of cached Trash.
The build generated `permissions/autogenerated/list_cached_trash.toml`; command
registration and the main-window allowlist are updated. This is compile/backend
bridge evidence only: no native app window was launched, no Keychain/OAuth flow
was used, and no native full-journey or restart-UI validation is claimed.

WKWebView real keys/focus, VoiceOver, native normal-close/restart UI and real Gmail
TRASH/SPAM observation remain unexercised. Positive native Trash UI requires an
approved synthetic Gmail harness or separately approved disposable account;
the default native fixture correctly omits this unsupported destination. Real
Gmail writes/convergence are neither implemented for Trash nor authorized here.
The separate recovery decision in B is required before implementing writes.

### Rebase onto UX-09 main — current validation

Rebased onto `origin/main` at `7fbd928`, retaining saved splits, historical search,
Gmail stars/groups/Undo, provider destinations and their account/cancellation
fences. Provider Trash remains distinct from this cache-only destination. Rust
owns the regenerated IPC types; cached Trash summaries also carry the current
star read model. Added nullable triage fields to the new provider-destination
synthetic thread fixture and updated the component assertion for main's explicit
`search=false` reader argument. Two pre-existing search-test cloned slices were
changed to borrowed slices to satisfy the combined clippy gate.

Final gates on this rebased tree:
- `mise run check`: **277 core tests, 586 UI tests passed; 29 opt-in browser tests
  skipped**. Contract generation, formatting, clippy and typecheck passed.
- `mise run build:web`, `mise run check:native`: passed.
- `mise run test:native`: **8 passed** (backend/bridge only).
- Opt-in `tests/discovery/discovery.rendered.test.ts`: **14 passed**, including UX-06,
  UX-08 and cached Trash at 1200/999 CSS px, using fresh Comet Chromium state.
- Live browser preview at 1280×800: two synthetic Trash conversations and one
  synthetic Spam conversation excluded from Inbox; Trash drawer → hostile-text
  reader → Escape restored focus to `conv-06`. `S`/`E` caused zero fake writes;
  reader contained no executable script/image or Reply control. Saved actual
  screenshots of the drawer and reader for operator inspection.

An initial parallel check hit the existing 60 ms delayed-detail timing assertion;
its isolated rerun and final complete check passed without weakening it. Earlier
attempts also exposed the missing new fixture fields, stale IPC expectation and
clippy failures above; they are not counted as successful validation. Rodney
failed to keep its Chromium connection; screenshots used the preview browser
instead. No native window, OAuth, Keychain or real-provider runtime validation was
performed. The three previously deferred P2 findings remain intentionally unfixed.
