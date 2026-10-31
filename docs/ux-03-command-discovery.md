# UX-03 — Discover actions and navigate to recoverable mail

Status: implemented and parent-validated with the explicit limitations below. Nothing
in this document certifies new native behavior. UX-02's Mac approval does not
certify UX-03.

## Narrow contract and ownership

Starting from clean `main` at `160d08955a5c5134635222fc41ee3f9c7812481d`, implement
Inbox → command palette → cached Done → archived reader → Reader Back to Done →
Context Back to the saved Inbox focus and scroll anchor. Cached Done also has a
pointer destination and `G`, then `E`. No Undo, selection, search, saved splits,
provider discovery, stars, labels, reminders, sending, attachments, multi-account,
AI, calendar, or new backend write authority is included.

Two fresh isolated worker worktrees have exclusive ownership: backend/Rust/Tauri/
IPC and transport tests; frontend components/composables/styles and remaining
frontend tests. Only the frontend worker owns `App.vue`. Parent owns integration,
this document, independent validation, and accepted review repairs. No worker may
stage, commit, push, publish, install packages, or access actual mail/credentials.
Fresh-context reviewers inspect the actual integrated unstaged source read-only.

Frozen frontend seam:

```ts
listCachedDone(request: CachedDoneRequest): Promise<CachedDoneSnapshot>
// request: { accountId: string; limit: number; cursor: string | null }
// snapshot: { conversations: ConversationSummary[]; nextCursor: string | null;
//   coverage: 'local_cache'; exactTotal: number | null;
//   lastSyncedAt: string | null }
```

The new named read command is `list_cached_done` with `{ request }`. Rust owns
DTOs and generated TypeScript. Native validates the active account. Limit is
1–100. Ordering is newest cached message timestamp descending, conversation ID
ascending for ties. A versioned `cached-done-v1:` JSON position includes the
account, timestamp and ID; callers treat it as opaque. It is a keyset position,
not a stable snapshot or authorization token. Retained snapshots have additive
lightweight `last_message_at` sort metadata, captured in the same persistence
transaction. Older profiles backfill it once during migration; page ordering does
not parse unselected recovery bodies. Malformed/oversized/foreign-account
cursors fail closed. Each page materializes at most `limit` candidate conversations
plus one lightweight lookahead; candidate filtering can yield a short or empty
page WITH a continuation. The UI must offer continuation in that state. Coverage
is cached/local, not provider-complete Done or All Mail; unknown totals are null,
not zero. Failure is not an empty successful query. Archive/recovery evidence is
required: a persisted, nonfailed archive operation (`queued`, `applying`,
`confirmed`, or Gmail `outcome_unknown`) plus readable cached/recovery context.
The effective per-message inbox state must be known and non-inbox; unrelated
non-INBOX Sent/Spam/Trash rows without archive evidence cannot qualify. This
intentionally excludes provider-archived mail never archived locally, and does
not infer provider-folder facts that this cache does not store. Current
membership/restore state takes precedence. Retained recovery snapshots keep
existing disclosures and action/reply restrictions.

Frontend action IDs, labels, shortcuts, availability, and execution-time target
resolution are shared by appropriate buttons, keys and palette entries. Open
reader identity, list focus, and saved Back origin remain distinct. Account-scoped
context history stores IDs and anchors, not positions. Reader J/K follows its
originating list; Activity-origin J/K remains a strict no-op. Activity stays
independently retrievable regardless of the browsing filter.

## Proposed behavior, not verified Superhuman fidelity

- `G`, then `E`: 1000 ms timeout, cancelled by unrelated keys, modifiers,
  composition, overlays, blur, or context transitions. No `G`, then `H`.
- Left reveals the destination navigator only when the list browsing surface
  owns navigation; never from editable controls or the reader.
- Cmd+K is a Mac app binding, not permission to steal browser/system-reserved
  commands. A visible pointer trigger is always available.
- Palette input owns ordinary typing, navigation highlight, Enter, and Escape.
  Escape dismisses the topmost surface and restores valid origin focus before
  reader/context Back. Covered controls are inert.
- Existing plain-text/no-remote-assets, no-auto-read, durable setters, draft
  dirty-buffer/normal-close protection, reply source validation, permission
  gates and late-response fencing remain mandatory.

## Repeatable synthetic-fixture Mac acceptance (PENDING)

On a prepared Mac checkout with existing project toolchain/dependencies, use only
fixture mode. Do not configure Gmail or supply credentials. Preserve any existing
fixture profile rather than deleting it: use a fresh macOS test user for an
independently initialized profile. Keep that same user/profile for the restart
step. Commands (from the checkout):

```sh
mise run test:core
mise run check:contract
mise run lint:core
mise run test:ui
mise run typecheck
mise run build:web
EMAIL_OS_MODE=fixture mise run dev:native
```

Record macOS version, app revision/diff, WKWebView version, viewport, input source,
fixture profile identity, observed result and evidence for every step below.
Browser/CDP or synthetic KeyboardEvents do not satisfy these native checks.

1. Confirm the explicit synthetic fixture account (no real account). In Inbox,
   focus a known row below the first (record conversation ID, visible anchor and
   nonzero scroll position). Mark one known synthetic row Done using its explicit
   control; record its ID and wait for visible operation status.
2. From the remaining Inbox row, press real **Cmd+K**. Confirm the app's palette
   opens with its input focused and no native/system command replaces it.
   Type `e/s/h` and several ordinary characters; assert input changes and no
   archive/read/other mailbox operation is added to Activity. Check an IME
   composition and ordinary text-caret arrows too.
3. Clear input, type `Go to cached Done`, inspect shortcut labels, use arrows to
   move the visible highlight, and Enter. Confirm the title and local-coverage
   disclosure. Open the recorded archived conversation; confirm original plain
   text, no automatic read change, retained/incomplete restrictions when relevant.
4. Reader Back returns to Done at its saved row/anchor. Context Back returns to
   the exact previous Inbox ID and scroll anchor. Repeat with the pointer palette
   affordance, then the pointer destination navigator; no stale row action may
   target the previous context.
5. From Inbox list navigation, Left opens the navigator; Escape closes it and
   restores focus. Left in palette/editor text only moves the caret. `G`, then
   `E` within 1 second opens Done. Check timeout, unrelated key, modifier, blur
   and overlay cancellation; `G`, then `H` does nothing unsupported.
6. Open palette/navigator over list and reader. Tab/Shift+Tab must not reach
   covered archive/read/reply controls; Escape must dismiss only the top surface.
   Repeat with Account/Activity/Contact and a local draft. Dirty-draft departure
   must save or preserve the visible buffer on failure. Normal Close/Cmd+Q after
   editing a synthetic local draft must preserve acknowledged text on restart.
7. Quit normally and relaunch the **same fixture profile** using the command
   above. Reach cached Done and reopen the recorded archived ID. This restart
   step is the native persisted-archive recovery gate, not preview-memory proof.
   Confirm Activity is reachable from Done, including failures. Activity-origin
   reader J/K must not fetch or move to unrelated mail; Done-origin J/K remains
   within Done. Check explicit read controls only in a supported synthetic setup;
   fixture absence of Gmail-only controls is correct, not a failed write test.
8. Record VoiceOver focus/announcements, visible highlight, Escape focus return,
   and OS-reserved shortcuts separately. Any unexercised item stays pending.

Linux native checks are blocked by missing GTK/WebKit development prerequisites;
no OS packages will be installed. No native success is inferred from core, jsdom,
or Chrome tests.

## Validation and review ledger

Before integration, the parent independently ran all six `.pi/factory.json`
commands against untouched baseline application/test source: all exited 0. Core
reported 105 unit tests plus 7/8/30/15/16 integration tests, all passing. Default
UI reported 276 passed and 15 opt-in browser tests skipped (16 files). These
baseline results are not UX-03 validation. Logs: `/tmp/ux03-baseline/`.

The parent also reproduced the baseline default-locale Chrome row-layout result:
1 passed / 1 failed, exactly `Sep 30, 2001` versus `30 Sept 2001` at the existing
date assertion. The Vitest command exited 1; the diagnostic shell wrapper exited
0 because it printed the captured status. This is a failed gate, not a pass.

After integrating the backend handoff, parent `mise run test:core`,
`mise run check:contract`, and `mise run lint:core` all exited 0. Core now reports
184 passing tests (106 unit; 2 cached-Done; existing 7/8/30/15/16 integration).
The new temporary-SQLite tests cover archive→restart→query→restore, 137-result
bounds/tie ordering, failed/unknown/restored/new-arrival membership, foreign
accounts/cursors, and incomplete retained recovery after cache eviction/reopen.
Logs: `/tmp/ux03-integrated/`.

Initial combined parent checks: all six configured checks exited 0; UI 296 passed /
19 opt-in skipped. Parent Chrome discovery/reader/covered-focus suites: 17 passed.
A disposable external-copy negative control disabled the overlay propagation,
overlay-owner, and editable-target guards together: the real typing test failed
at its zero-mutation assertion, as intended. The actual checkout was unchanged.

The full en-GB layout gate caught a new rail-width regression (2 failures), which
was reproduced independently. The new Cached Done label widened the automatic
rail to ~139px, forcing More mode in previously inline scenarios. Bounding and
wrapping only that label restores both existing layout cases (2 passed); the
unrelated default-locale date limitation remains unchanged.

### Fresh review and accepted in-scope repairs

Two fresh-context read-only reviewers inspected actual integrated source/diffs.
Neither found P0/P1. Initial verdict: **needs attention**, with these accepted P2s:

| Finding | Repair / regression |
| --- | --- |
| Palette row-origin focus revealed/scrolled the row before context capture | Restore through `InboxList.focusRef(..., {preventScroll:true})`; component reveal-spy and real-layout row-origin variant. |
| Background refresh discarded loaded Done pages | Revalidate the explicitly loaded candidate-page range before replacing rows; preserve page-two focus and reader neighbors. A follow-up recheck correctly caught shifted page edges: save the date/ID end boundary as well as page count and replay through that boundary. |
| Context Back falsely treated an unloaded page-two target as removed | History carries page count and date/ID end boundary and recovers that range before ID/anchor fallback resolution. Tests insert newer rows shifting the saved target from page two to three (refresh), then four (Context Back). |
| Explicit disconnect bypassed status-based context reset (both reviewers) | Clear Done context/cursor/page count/metadata before post-disconnect refresh; regression asserts no undefined-account Done request. |
| Trusted Shift+Tab helper sent `TAB` and lacked Tab keycodes | Preserve named key spelling and add Tab code/keycodes; rerun trusted keyboard trap coverage. |
| Query parsed all retained-body JSON to sort before LIMIT | Persist lightweight snapshot sort metadata, additive one-time migration, and an unselected-malformed-body regression proving paging does not parse it. |
| Replay-budget failure was hidden while a reader was open | Show originating-list alert/Retry inside the reader; pause J/K and Done mutations, disable explicit mailbox controls independently of permission labels; preserve reading and Back. Budget regression covers list and reader variants. |

Replay is bounded to the previously explicitly loaded candidate-page count plus
10 extra pages (100 candidates per request). If the old boundary is still not
reached and a continuation remains, fail visibly with a restoration-limit error,
retain history, and disable list mutations rather than invent a removed target.
Retry, Inbox navigation, and explicit fresh Done navigation remain available.
This is a reconstruction policy, not verified Superhuman behavior. A dedicated
regression asserts the finite request count and unavailable destructive action.

No unsupported feature or provider authority was added for these repairs.
The recovery/core reviewer rechecked both named findings and immediate repairs:
**correct; no P0/P1/P2 findings**. UI rechecks identified the shifted-boundary and
open-reader error-visibility gaps, both repaired as above. The final named-fix UI
recheck returned **correct; no qualifying P0/P1/P2 findings**. Reviewers were
read-only and did not run tests; the parent executed the checks below. These are
scoped verdicts, not native/platform certification or publication authorization.

### Core repeatability limitation discovered during validation

Several intermediate default full-core runs failed waiting for confirmation in
unchanged `gmail_operations.rs` tests at lines 675 or 842. An isolated retry of the
line-675 case and a subsequent full post-review run passed (184 tests), but later
full runs reproduced timeouts. The parent therefore created a FRESH archive of
unchanged HEAD `160d089` at `/tmp/ux03-baseline-core-jwFQIs`, not an old worker
worktree, and ran its unchanged `gmail_operations` suite five times: **3 passed /
2 failed**. Failures were confirmation waits at lines 842 and 794. Thus this is
reproducible before UX-03; it is not certified fixed or solely blamed on load.
Cause remains unverified. No scheduler, test timeout, or assertion was changed.
Logs: `/tmp/ux03-releasecheck/baseline-operations-{1..5}.log`.

A separate scheduler/test-reliability investigation needs operator approval; it
is outside this browsing slice. Final default/serialized results are recorded
below without replacing or hiding failed default runs.

The baseline comparison reused the build target directory; two immediate return
to-main attempts encountered stale pre-UX03 crate artifacts (missing new DTO/API
imports), not source-contract failures. The parent cleaned only `mail-core` build
artifacts (`cargo clean -p mail-core`) and rebuilt. Authoritative clean-artifact
results: default `mise run test:core` **184 passed**, explicit
`RUST_TEST_THREADS=1 mise run test:core` **184 passed**, generated-contract check
**exit 0**, and core lint **exit 0**. The serialized result is supplementary,
not a replacement for the default test command. Baseline flakiness remains a
release caveat despite this final default pass.

## Final parent validation

Executed against integrated source with the existing toolchain, cached Chrome
binary and existing harness/environment gates; no dependency or OS installs.
Logs: `/tmp/ux03-releasecheck/`.

| Configured command | Result |
| --- | --- |
| `mise run test:core` | Final clean-artifact default run: 184 passed; default repeatability caveat above remains. |
| `mise run check:contract` | Exit 0 after clean rebuild; Rust-generated TypeScript matches. |
| `mise run lint:core` | Exit 0 (format and clippy). |
| `mise run test:ui` | Exit 0; 302 passed / 20 opt-in browser tests skipped (18 files). |
| `mise run typecheck` | Exit 0. |
| `mise run build:web` | Exit 0. |

Final real-Chrome results (existing binary
`/home/exedev/.cache/rod/browser/chromium-1321438/chrome`):

- `EMAIL_OS_RENDERED_LAYOUT_CHROME` and `EMAIL_OS_DISCLOSURE_FOCUS_CHROME` set,
  `pnpm exec vitest run tests/discovery.rendered.test.ts tests/reader.rendered.test.ts tests/disclosure-focus.rendered.test.ts --maxWorkers=1 --minWorkers=1`:
  **18 passed** (5 discovery, 12 reader, 1 covered-focus). Each discovery case
  initializes fresh synthetic state. Both pointer and row-origin geometry paths
  pass; real input typing produces zero mutations; real Tab/Shift+Tab remain
  contained, and a highlighted lower result is revealed in a short palette.
- Existing layout suite under `LANG=C.UTF-8`: **1 passed / 1 failed**, exactly
  the unchanged `Sep 30, 2001` versus `30 Sept 2001` assertion. This default-locale
  gate remains failed, not green.
- The same existing layout suite with explicit
  `LANG=en_GB.UTF-8 LC_ALL=en_GB.UTF-8 LANGUAGE=en_GB`: **2 passed**.
- The earlier disposable-copy negative typing control failed at the intended
  zero-mutation assertion after all three typing guards were deliberately
  removed. This expected diagnostic failure does not alter the passing checkout.

The short-palette reveal addition also received a read-only scoped recheck:
**correct; no qualifying P0/P1/P2 findings**. Full visual/Superhuman fidelity is
not established by these synthetic runs.

Native fixture/WKWebView, OS-reserved key handling, IME, VoiceOver and native
restart recovery remain **pending**, not inferred from these checks. `pkg-config`
itself is unavailable in this VM; no prerequisite installation was attempted.

Application/test/core/native source hashes were recorded before the final browser
run and verified unchanged afterwards (excluding this documentation-only ledger).
At the end of implementation validation (before the operator's subsequent request
to open a PR), the index was empty and HEAD/origin/main remained `160d089`.
No staging, commit, push, PR, merge, deployment, mail access or publication had
occurred during implementation. The subsequent PR request authorizes branch,
commit, push and PR creation only; merge/deployment remain operator-controlled.

## Changed-file inventory

- Core: `crates/mail-core/src/{dto.rs,cached_done.rs,lib.rs,store.rs}`,
  `crates/mail-core/src/bin/generate-types.rs`,
  `crates/mail-core/src/gmail/{store.rs,sync.rs}`,
  `crates/mail-core/tests/cached_done.rs`.
- Native boundary: `src-tauri/build.rs`, `src-tauri/src/main.rs`,
  `src-tauri/capabilities/main-window.json`,
  `src-tauri/permissions/autogenerated/list_cached_done.toml`.
- Typed transport: `src/lib/ipc/{client.ts,generated.ts,tauri-client.ts,browser-fake.ts}`.
- Frontend: `src/App.vue`, `src/assets/style.css`,
  `src/composables/useMailbox.ts`, `src/lib/browsing-actions.ts`,
  `src/components/{ActionOverlay.vue,InboxList.vue,ReaderView.vue}`.
- Tests/fixtures: `tests/{discovery.component.test.ts,discovery.rendered.test.ts,
  discovery.fixture.ts,account.component.test.ts,browser-fake.test.ts,
  drafts.component.test.ts,helpers.ts,reader.fixture.ts,tauri-client.test.ts,
  useMailbox.test.ts}`.
- This contract/evidence document. No dependency/framework/OS package changes.

Known unchanged baseline limitation: `tests/inbox-list.rendered-layout.test.ts`
hardcodes `30 Sept 2001`; under `LANG=C.UTF-8` Chrome renders `Sep 30, 2001`.
Default-locale layout must not be called green. Explicit en-GB passes both
baseline cases; this slice does not fix that unrelated locale assumption.
