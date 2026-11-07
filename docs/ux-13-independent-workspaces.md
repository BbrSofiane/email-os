# UX-13A — Independent synthetic account workspaces

Status: narrow implementation contract, starting at UX-05 `6c30b9c`.

## Decisions and capability boundaries

The approved independently testable increment is **browser-preview-only in-app
workspaces**, not native tabs or real multi-account activation. Two immutable
synthetic client sessions own separate account identities, even though their
conversation/message/draft/request IDs can be identical. Each session retains
its own mounted Vue browsing state, list/reader DOM and scroll, Back stack,
selection, command query, Activity and in-memory draft store. No account mutation
of a shared client on switch. Hidden sessions are inert, cannot handle keys or
steal focus from a delayed response. Delayed results remain with their original
client and component; operation acceptance/recovery/Undo stays session-local.

Before switching, call the current editor's existing `flushAndClose` lifecycle.
Save failure/conflict/ambiguous intent blocks switching and preserves the visible
buffer. Serialize switches; no controls dispatch transitions while saving.
Successful switches close the editor (reopen from that account's local Drafts).
Browser beforeunload protection remains installed for each session. Native keeps
one App and its existing normal-close/quit protocol, unchanged.

Supported commands: explicit switch to the other fixture account, by workspace
button or command palette. Account-aware view/count titles use loaded row counts,
never mailbox totals. Do not intercept Cmd+T, Cmd+number, Cmd+Tab or bracket tab
shortcuts. No new tab button, unified inbox, cross-account query, credentials,
provider authority or new IPC. Existing generated Rust/TS and named transports
remain unchanged.

## Missing prerequisites / blocked continuation

UX-06/07 are absent: only Inbox and cached Done exist. Search isolation cannot be
certified; there is no mailbox-search control to expose. Command-palette query
is independent, but is **not mail search**. Do not build UX-07 in this slice.

Native runtime is still one selected mail core, draft core, lifecycle gate and
one main window. Gmail `KeychainSecrets` uses one account-independent service/key;
creating more profile directories would NOT isolate credential custody. Existing
OS locks reject competing mail/draft profile writers, not account ownership of
that global Keychain entry. Keep them; do not activate another native account.

**Decision needed before UX-13B:** approve a runtime design with backend-owned
account registry, per-account credential namespace and migration/disconnect rules,
profile allocation, shared-core window leases or deliberate duplicate rejection,
worker shutdown/recovery, and one app-wide draft-close coordinator. No frontend
account ID or path may select credentials. Same-account independent writers are
rejected; sharing requires an explicit controlled-core design, not two opens.

**Native tabs:** not implemented or certified. A real Tauri/macOS feasibility
spike must test NSWindow tabbing support, Tauri window lifecycle/main-label
assumptions, WKWebView focus/menus, title updates, reserved shortcuts, closing one
tab versus app quit and dirty editors in every window. Headless compile or API
inspection cannot establish this. In-app workspaces are a disclosed alternative,
not evidence that this application has working native tabs.

Source feasibility preflight (not the required runtime spike): this checkout's
Cargo.lock resolves Tauri 2.11.6. Its `WebviewWindowBuilder::tabbing_identifier`
API documents grouping matching identifiers on macOS and disabling automatic
tabbing when unset; our `tauri.conf.json` leaves it unset. Capability scope is
`windows: ["main"]`, and `AppState` has one lifecycle/close gate. Thus support is
plausible, but simply enabling an identifier/creating another window would not
establish command authority, independent drafts or safe per-tab close. No new
window permission, tabbing identifier or native shortcut has been enabled.

## Acceptance checklist

- [x] Two synthetic accounts with identical conversation IDs; wrong-account read,
  single/group action and draft references rejected.
- [x] Independent navigation/Back, focused/selected references, command query,
  reader expansion, DOM focus and list/reader scroll.
- [x] Delayed detail/list/action completions update only the originating session;
  hidden sessions never own mailbox keys or move active focus.
- [x] Dirty editor save before switch; failed/conflicting saves block transition;
  rapid switch attempts serialized; exact local text recovered per account.
- [x] Account-aware view/loaded counts and palette commands; reserved shortcuts
  not cancelled; native mode offers no unsupported switch control.
- [x] Existing core profile lock rejection and draft/account/normal-close tests
  (synthetic core/bridge tests, not interactive native close validation).
- [x] Existing no-auto-read, retained snapshot, safe text, permission, bulk/Undo,
  durable recovery and generated transport regression coverage executed. See the
  aggregate timing caveat below; no Rust/SQLite/IPC/permission behavior changed.

BROWSE-16 is partial only. No real mailbox/credential access is authorized.

## Implementation and validation evidence

### Headless / synthetic (pre-review aggregate)

**Final uncontended `mise run check && mise run build:web`: passed**, including
all 229 core tests with default parallel execution, 448 UI tests, generated
contract drift, formatting/clippy and typecheck. The timing observations below
are retained from earlier contended attempts; the final aggregate was not
restricted to serial tests or selected cases.

- `mise run test:ui`: **448 passed**, 21 rendered opt-in tests skipped. Includes
  seven workspace component tests and two account-fake tests. Independent empty
  Done, delayed list failure, late detail/action completion, focus/selection/Back,
  per-workspace palette queries, draft exact-text save/reopen, failed save,
  stale-revision conflict and pending-save transition serialization covered.
- `mise run typecheck`, `mise run build:web`, `mise run lint:core` and
  `mise run check:contract`: passed. Rust-generated TypeScript is unchanged.
  Existing exact typed transport tests passed; no new IPC/registrations/permissions.
- `RUST_TEST_THREADS=1 mise run test:core`: **229 passed** across unit/integration
  suites, including fixture/Gmail/draft profile locks, SQLite intent/restart,
  group/Undo and account scope. Focused default-parallel
  `archive_read_ordering_idempotency_and_unknown_after_apply` also passed alone.
- Initial aggregate checks under concurrent native/browser compilation hit the
  unchanged `gmail_operations.rs:675` five-second confirmation wait twice. One
  concurrent UI run outlasted a fixed-delay reader fixture (archive command had
  correctly become available by the assertion). No test was skipped, timeout
  raised, Rust worker changed or safety assertion weakened to obtain passes.
  These earlier failures remain part of the evidence, not remote/native defects
  inferred from fixtures. Final aggregate outcome is recorded above.

### Rendered browser (separate from core and native)

Existing CDP harness run against `/Applications/Comet.app/Contents/MacOS/Comet`,
with a new temporary browser profile and local synthetic fixtures only:
**6/6 discovery/workspace journeys passed** on the pre-review rendered run. Focused
UX-13 journey independently passed too. Trusted pointer switching restored
`conv-03` focus, selection and nonzero list scroll for the first account; the
second retained its `conv-02` reader/Back origin. Actual Chromium rejected focus
into the inert first account. Archive targeted only that account's activity;
the other account had zero operations. Account-specific document title restored.

An earlier rendered run exposed an old `querySelector('input')` assertion reading
a bulk checkbox (`"on"`) instead of the palette input; it now uses the explicit
palette data-test selector. One initial row-origin timing case also failed;
all six passed on rerun without changing application behavior for that case.
No screenshot parity, WKWebView behavior, native Cmd shortcuts or VoiceOver
certification is inferred from these browser results.

### Review fixes — focused revalidation

Workspace command queries now live in the owning App across overlay unmounts,
using an optional typed query prop/update event. Destination queries and
standalone/native palette queries retain their transient reset behavior. The
component journey dismisses the overlay before using the account buttons; a new
rendered journey uses trusted Escape, backdrop dismissal, account buttons and
palette Switch account execution, then reopens each account's distinct query.
The rendered archive journey requires exactly one archive operation targeting
`fixture-account/conv-03`, verifies its local `isInInbox: false` detail and exact
remaining Inbox rows, and checks the second account's unchanged list and zero
operations. Assertions use the fake's actual snapshot/detail/operation shapes.

Focused implementation-lane commands (all passed, no failures in these runs):

- `mise run test:ui -- tests/workspaces.component.test.ts tests/discovery.component.test.ts tests/browser-fake.accounts.test.ts tests/tauri-client.test.ts`
  — **40 tests passed**, including eight workspace tests.
- `mise run test:ui -- tests/app.component.test.ts tests/app.selection.test.ts tests/drafts.component.test.ts`
  — **147 tests passed** (shortcut, selection and draft lifecycle regressions).
- `mise run typecheck` — passed.
- `EMAIL_OS_RENDERED_LAYOUT_CHROME='/Applications/Comet.app/Contents/MacOS/Comet' mise run test:ui -- tests/discovery.rendered.test.ts`
  — **7/7 rendered journeys passed**, using the existing harness's isolated
  temporary profile, cleaned up on teardown.
- `git diff --check` — passed.

Parent handoff inspection and `mise run check && mise run build:web` also
passed after both fixes: **229 core tests**, **449 UI tests** (22 rendered
opt-in tests skipped), generated-contract drift check, formatting/clippy,
typecheck and production web build. `git diff --check` passed. The seven
rendered journeys above were executed separately by the implementation worker;
the aggregate run does not claim to execute them. No native/provider evidence
was added by these review fixes.

### Parallel review round (three read-only reviewers)

Reviewers (lifecycle races, isolation/capability boundaries, UX/test strength)
found no P0/P1 and confirmed the two earlier P2 fixes. Addressed:

- Blocked switch now returns keyboard focus to the editor and the alert clears
  on the next interaction in the active workspace (was: focus on `<body>`,
  stale alert). Test simulates Chromium's inert-blur; removing the restore fails it.
- Palette text is selected when a retained query is reopened.
- `aria-current="page"` on non-navigating account buttons → `"true"`.
- Scroll test no longer vacuous (offset zeroed while hidden, as browsers do);
  removing the restore now fails. New test opens the same conversation in both
  accounts and asserts no duplicate DOM ids.

Accepted, not fixed:

- A `getDraft` still pending at switch time can open a clean editor in the
  now-hidden owning account (no data loss, no cross-account effect, no focus
  steal). Not reproducible with the fake; fixing it means changing the shared
  draft-lifecycle generation semantics, out of scope for this slice.
- Hidden workspaces still run read-only `focus`/`online` refreshes against their
  own fixture client. Matters only if a real client is ever mounted this way.
- Not covered by default gates: remaining focus-guard redundancy (defense in
  depth), post-archive title counts, and the narrow-width `.utility-drawer`
  overlap of the account buttons (CSS-read only, not rendered-checked).

Re-run after these changes: `mise run check` (450 UI tests, 22 opt-in skipped;
core/clippy/typecheck/contract drift) and `mise run build:web` passed;
`tests/discovery.rendered.test.ts` 7/7 with the local Chrome-family harness.
No native/provider evidence was added.

### Native compile/bridge only

On this macOS checkout `mise run check:native` and `mise run test:native` passed
(**7 tests**, including backend-derived draft account/session scope and normal
close gate). This is compile/headless bridge evidence, not an interactive Tauri
launch, native-tab feasibility/validation spike, GUI draft-close validation,
Keychain access, OAuth, real multi-account activation or remote convergence.
No mailbox, credentials, external sends, provider writes or OS package installs.

### Still gated / requested decision

- [ ] UX-06/07 dependency decision for mail-search isolation; no mailbox search
  exists on this base and no unsupported search control was added.
- [ ] Approve a bounded backend-owned registry/credential namespace/migration,
  profile lease and close-coordinator design before UX-13B implementation.
  Decide controlled shared-core leases versus deliberate same-account rejection.
- [ ] Real Tauri/macOS native-tab feasibility spike and interactive Mac validation;
  the shipped increment is explicitly in-app workspaces, not native tabs.
- [ ] Separately approved disposable multi-account credential/runtime/provider
  test path. Native and provider release gates remain unsatisfied by these fakes.
