# UX-02 — Conversation reader: implemented contract and evidence

Status: implemented at the component/shell level. The six repository gates,
reader Chrome suite, and covered-surface focus suite pass; an existing
locale-sensitive row-layout assertion is recorded separately below, not hidden
as an unconditional green browser gate. Real-Chrome runs cover the reader
journey, scroll/anchor behavior, and covered-surface focus safety in the
synthetic browser preview only. Native fixture/WKWebView,
VoiceOver/assistive-technology, and platform clipboard verification remain
**explicitly pending**. Browser passes do not establish native IPC/provider
correctness or Superhuman fidelity.

Grounding: `docs/superhuman-browsing-implementation-plan.md` (UX-02; acceptance
complete BROWSE-05 and the copy portion of BROWSE-15) and the UX-02 section of
`superhuman-email-browsing-ux-spec.md` (message focus/expansion, participant
details, copy-only contact controls, reader scrolling).

## Bounded UX-02 contract

Implemented behavior:

- **Visit-scoped message state** inside the mounted reader
  (`src/components/ReaderView.vue`), keyed by account+conversation reference and
  message ID — never array position. Per visit: active message ID, expanded IDs,
  details-disclosure state, and a viewport-relative scroll anchor with a
  `scrollTop` fallback. State survives J/K round trips and same-reference
  background replacements for the life of the mounted reader session and is
  released when the reader unmounts (close) or the account changes. Removed
  message IDs are pruned; a removed active/anchor ID resolves to the next
  surviving old neighbor, then the previous one. The resolved active ID is
  published to App so contact context follows the same surviving message as
  DOM focus. Empty/error states have an article fallback; loading retains saved
  visit state without exposing a stale message-command target.
- **Initial focus/expansion:** opening a conversation focuses the newest cached
  message's toggle (not the article) with that message expanded; only as much of
  its header as needed is revealed. Ordinary `ol/li` semantics with a roving
  primary message-toggle button carrying `aria-expanded`/`aria-controls`;
  focusing any control of a message updates its message identity.
- **Message movement (nonwrapping):** `N`/`P` move message focus one step
  without auto-expanding (clamped at both ends, no wrap). `O` toggles expansion
  of the focused message; `Shift+O` idempotently expands all messages. These are
  narrow methods exposed to App's single keyboard dispatcher — the reader adds
  no window listener — and ignore commands without a ready, matching displayed
  visit (including expansion/details commands during loading). They dispatch
  after the existing editor/IME/modifier/
  editable/overlay guards. Native Enter/Space button activation is preserved
  (one activation toggles expansion once, never a mailbox action), and the
  existing `e`/`Shift+U` action contracts work from the new message-toggle
  focus: a message toggle is the reader's navigation context, not a toolbar
  action button, so the conversation-level shortcuts remain usable there while
  every other focused button/link keeps the generic exclusion. Toolbar,
  editor/IME, overlay, capability, read-only, and stale-target guards are
  unchanged.
- **Reading progress across foreground loading:** the outgoing visit's
  viewport-relative scroll anchor is captured before any DOM teardown —
  including the foreground null/loading transition where the conversation is
  cleared before the next detail arrives — and retained through loading/error
  without being overwritten by the empty/loading DOM. Returning to a visit
  restores the exact scroll offset and viewport-relative message geometry, and
  revisit focus does not reveal-scroll over the restored offset (initial entry
  and explicit N/P still reveal the focused header as needed). When teardown
  removes reader-owned message focus, loading parks it on the persistent article,
  not BODY, without overriding toolbar, rail, overlay, or outside focus (including
  focus moved before delayed work runs). An immediate A-ready → B-loading →
  A-ready reversal restores A's message focus independently of the last loaded
  data key, unless the user moved to another surface.
- **Conversation movement:** Inbox-origin reader `J/K` moves the reader cursor
  through the originating Inbox's current ready snapshot resolved against the
  current `openRef` (previous context ordering for a removed cursor, no wrap),
  without moving hidden list focus and without recapturing the entry origin.
  Activity-origin reader `J/K` is a strict no-op: no navigation, no hidden-focus
  mutation, no invented ordering of duplicate operation references, and no extra
  `getConversation` calls; `N/P/O` still work there. Reader ArrowUp/ArrowDown
  retain native behavior instead of switching threads; list arrow aliases remain.
- **Back/Escape restoration:** the original entry focus, account-scoped
  ordering, and non-null list anchor are captured only at the initial
  list-to-reader entry. Back (Escape/Close) restores the ORIGINAL entry thread
  and best anchor with the fallback chain: surviving entry reference → next
  surviving neighbor from the entry ordering → previous → first valid row →
  empty state. An Activity-origin Back reopens Activity without erasing the
  saved underlying Inbox anchor; explicit Inbox navigation keeps the list's own
  current focus instead.
- **Actions target the current open thread only.** Archive/read/reply use the
  CURRENT loaded open conversation; the saved origin is never an action target.
  Existing stale-request/late-receipt guards and request tokens are retained.
  Inbox archive auto-advance captures account-scoped ACTION-TIME ordering before
  the archive, then selects the next surviving neighbor, otherwise the previous,
  without wrapping. This is separate from frozen Back entry ordering and J/K
  cursor resolution (`mailbox.focusedSummary` deliberately remains the original
  entry focus). An Activity-origin reader never advances into unrelated Inbox
  mail.
- **Participant details and context.** Each message exposes a native
  `<details>` disclosure with the complete known From/To addresses and sent
  timestamp; unknown Cc/Bcc and other headers are omitted, never fabricated.
  Participant names/addresses are keyboard-focusable context controls separate
  from the expansion toggle (no nested buttons). The active message's sender is
  the baseline reader contact; participant hover and keyboard focus each
  temporarily override it, keyboard focus wins, and exit (leave/blur, disclosure
  dismissal, message change, close) restores the baseline. Overrides are
  identity-qualified by conversation reference + message ID in App, so late
  blur/leave events, loading, removals, and account changes cannot leak a stale
  contact. Direct focus on a new message's participant preserves its valid
  identity-matching override across the active-message handoff instead of
  accidentally clearing it. A visible "Reply targets the latest message from …" label sits near
  Prepare reply so focusing an older message cannot imply a different reply
  target.
- **Copy controls (copy-only BROWSE-15 portion):** separately labelled
  copy-name (only when a display name is known) and copy-email buttons in
  `ContactPane.vue`, reachable by hover and keyboard. Activation uses
  `navigator.clipboard.writeText` only on explicit activation and reports
  success, failure, or unavailable-clipboard honestly via `role="status"`, with
  the text staying selectable for manual copy. Outcomes reset when the displayed
  identity/context changes or a new copy activates; asynchronous results publish
  only for the matching identity/context and newest activation, so reversed
  completions cannot replace the newer result. Copying never triggers a draft,
  navigation, or any mailbox write, and adds no native permission.
- **Safety unchanged:** bodies render exclusively through text interpolation —
  no `v-html`, no HTML/Markdown processing, no remote assets; hostile markup
  stays literal text (asserted in real Chrome). Retained/incomplete/header
  checks, `unsupportedReason`/`contextComplete` disclosures, draft lifecycle and
  close protection, permission gates, no-auto-read, and overlay inertness are
  preserved.
- **Reader surface:** the reader is a bounded flex surface with its own content
  scroller and a persistent toolbar/Back affordance; the toolbar stays fixed
  while content scrolls beneath it (asserted with real layout geometry in
  Chrome). The 1000px Contact breakpoint and covered-surface inertness are
  preserved, including the wide contact column being inert while a utility
  drawer overlays it.

## Reconstruction choices (marked, not verified Superhuman fidelity)

- Escape precedence inside the reader: an open message-details disclosure is
  dismissed before the reader closes; utility drawers and the narrow Contact
  disclosure keep their existing earlier precedence.
- The participant context displays the participant's display name when present
  and the bare mailbox otherwise — the same known-fields rule as the rest of
  the contact pane.
- Newest message = last entry of the cached message stack (backend order is
  authoritative); no independent relevance ordering is invented.

## Post-review fix pass (validated P1 corrections)

Two P1 review findings were corrected at the first checkpoint. That checkpoint's
report-only P2 deferral was later superseded by the operator-approved twelve-item
follow-up below; the P1 repairs remain intact:

- **Reader actions from message-toggle focus (P1-A).** Opening and N/P focus a
  message-toggle button, which the old generic `buttonOwns()` guard treated
  like a toolbar button and used to suppress `e` and Gmail `Shift+U`. The
  approved clarification (message toggles are reader navigation context, not
  toolbar action buttons) is implemented via an `actionShortcutBlocked()` guard
  that exempts only `.message-toggle` targets. Regression coverage dispatches
  bubbling key events from the actual focused toggle in component tests and
  uses real CDP keys in Chrome: default initial focus and post-N/P focus,
  current-open (never focused-message or origin) targeting, enabled synthetic
  Gmail Shift+U (test-only account-status wrapper; no production authority
  change), native Enter toggling expansion exactly once with zero mailbox
  commands, and a focused toolbar button still being excluded. A temporary
  revert of the guard made the new tests fail, confirming they pin the fix.
- **Outgoing scroll capture across foreground loading (P1-B).** The visit
  watcher now captures the outgoing visit's scroll anchor before the
  null/loading return, retains it through loading/error, and never overwrites
  it from the empty/loading DOM (the capture is a no-op once the message
  elements are gone). Revisit focus no longer reveal-scrolls over the restored
  offset when a saved anchor exists. Coverage: component round trips
  ready → null/loading → ready → null/loading → ready with controlled geometry
  asserting exact restored scrollTop, viewport-relative message geometry, focus
  identity, and expansion state; plus a real-Chrome J/K round trip with
  delayed details and NO fixture notification between the manual scroll and J,
  asserting exact scrollTop 200, stable viewport-relative geometry, all
  expansions, and focus identity. A temporary revert of the capture made both
  new component tests and the Chrome round-trip test fail.

## Accepted P2 follow-up implementation

All twelve findings from the latest UX-02 review were assigned to isolated
workers and integrated as exact owned deltas into the existing dirty checkout.
The parent caught and returned two implementation gaps (outside-focus ownership
and structured reply metadata defaults), plus an incorrectly labelled browser
reversal scenario, before accepting the handoffs for integration.

The first fresh review then confirmed two narrow P2 gaps: empty same-key
restoration bypassed the focus-ownership guard, and the native Ravi case had
already activated m1 via its Details summary, so it did not discriminate the
participant handoff. Both corrections are integrated: ownership is checked before
choosing either restoration target, with toolbar/outside and owned-empty-fallback
regressions; the native case explicitly reactivates m3 with m1 details open before
clicking Ravi. The App repair itself was already covered by a valid component
regression. These corrections do not expand the production/API scope.

| Finding | Implemented correction and regression coverage |
| --- | --- |
| P2-01 | Reactive visit pruning publishes the surviving active ID; component emission and Chrome contact-baseline checks use a differing sender. |
| P2-02 | A matching newly focused participant override survives the active-message handoff; direct Ravi focus is covered in App and Chrome. |
| P2-03 | Loading parks lost reader-owned focus on the article, preserving other surfaces and late user movement; component ownership/inert regressions and Chrome loading focus. |
| P2-04 | Pending foreground focus restoration handles A-ready → B-loading → A-ready; component coverage and a native-K Chrome case assert B is still loading before reversal. |
| P2-05 | Message/expansion/details commands require a ready matching displayed visit; loading-time O cannot mutate outgoing A. |
| P2-06 | Archive advancement uses captured action-time ordering, separate from frozen Back ordering; App and Chrome reorder regressions. |
| P2-07 | Reader arrow aliases removed; App checks no preventDefault/fetch, Chrome checks native Inbox scrolling and Activity no-fetch. |
| P2-08 | Contact copy statuses reset and fence by identity/context and newest activation; deferred success/failure, unavailability, identity change and reversed completions covered. |
| P2-09 | Synthetic draft defaults and immutable links derive from the requested source's stored metadata; latest/account/context guards, Reply-To/From/self/dedup and source-ID reference semantics covered by 15 fixture tests. |
| P2-10 | Every reader browser case mounts a fresh fixture with explicit setup/viewport; whole-file, shuffled and formerly dependent isolated cases are exercised. |
| P2-11 | The stale-detail App regression now returns distinguishable old/new content, making stale overwrite observable. |
| P2-12 | Hostile-body checks count/assert zero script nodes inside the reader, not Vite's legitimate page bootstrap; other literal-text/asset checks remain. |

The synthetic reply helper is a bounded fixture approximation over canonical
structured metadata, not an RFC parser or evidence of native/provider behavior.
No production MailClient/DTO/core/provider/permission contract changed.

## Historical P1 checkpoint validation

- `pnpm vitest run tests/reader.component.test.ts` — visit-scoped state,
  N/P/O/Shift+O semantics, ID-based pruning/removal resolution, same-reference
  replacements, account isolation with equal message IDs, empty/error fallback,
  and the loading-transition anchor round trips: **12 passed**.
- `pnpm vitest run tests/app.component.test.ts` — 65 tests including the
  reader-message keyboard contracts (initial newest-message focus, N/P vs J/K,
  original-entry Back at nonzero scroll, removed-entry fallback, J/K round-trip
  state, action-on-current-not-origin, stale/late-receipt safety, Activity
  no-op/call counts, keyboard precedence, participant restoration, copy
  success/unavailability with no writes) and the retained draft/permission/
  inertness/no-auto-read regressions, plus the E/Shift+U-from-toggle,
  toolbar-exclusion, and bubbling-target regressions: **65 passed**.
- `pnpm test` (default, Chrome gates skipped) — **240 passed, 10 skipped (14
  files)**.
- Real-Chrome opt-in suites, executed with
  `EMAIL_OS_RENDERED_LAYOUT_CHROME` and `EMAIL_OS_DISCLOSURE_FOCUS_CHROME`
  pointing at `/home/exedev/.cache/rod/browser/chromium-1321438/chrome`:
  - `tests/reader.rendered.test.ts` — **7 passed**: real keyboard/pointer
    open → N/P → O/Shift+O (incl. idempotence) → details Escape precedence →
    participant hover/focus context with baseline restore → explicit copy with
    no draft/navigation/mailbox writes; literal hostile text with zero
    created `img`/`a`/remote-stylesheet nodes; viewport-stable message
    anchor across a background replacement; original entry restored after
    source reorder and removed-entry neighbor fallback; self-scrolled reader
    with fixed toolbar geometry; contact disclosure below and column at/above
    1000px; reply exit targeting the displayed latest source (`read-03-m1`)
    with zero archive/read commands; real-E archive from message-toggle focus
    with native Enter expanding once and the toolbar exclusion intact; real
    Shift+U in enabled synthetic Gmail from message-toggle focus; and a delayed
    J/K loading round trip restoring exact scrollTop and viewport geometry.
  - `tests/inbox-list.rendered-layout.test.ts` — **2 passed** (existing layout
    gate, unaffected).
  - `tests/disclosure-focus.rendered.test.ts` — **1 passed** (covered-surface
    focus safety under Activity and narrow-Contact disclosures).
  - `pnpm test` with both Chrome gates set — **250 passed, 0 skipped (14
    files)**.
- `mise run typecheck` — **passing** (vue-tsc, includes the new
  fixture/component/rendered test types).
- `mise run build:web` — **passing** (production Vite build).
- `mise run check` — **passing** (core tests, generated-contract drift, core
  lint, frontend tests, typecheck; no generated/wire/backend changes in this
  slice). The worker reported an initial core-suite failure whose test name
  and details were lost to output filtering; its cause remains unverified.
  Subsequent worker runs and the parent's final independent core check passed.
  The fix pass touches no Rust/core code.

## Historical P1 parent verification and scoped recheck

- At the P1 checkpoint, the parent independently ran all six `.pi/factory.json`
  commands against the then-current source: core tests, generated-contract check, core lint, UI tests,
  typecheck, and production web build all passed. The normal UI run reported
  **240 passed / 10 opt-in browser tests skipped**. All ten browser tests also
  passed in separate successful Chrome runs: reader seven,
  covered-surface focus one, row layout two. Application/test hashes stayed
  unchanged during validation.
- Replaying the original real-Chrome native-key probe now archives the current
  conversation from the initial message-toggle focus and advances normally.
  The durable reader suite separately covers enabled synthetic-Gmail Shift+U,
  native Enter expansion, and the unchanged toolbar-button exclusion.
- Replaying the shared-fixture delayed J/K probes preserves **200 → 200** and
  clamped deep-body **353 → 353** scroll positions, with identical message
  viewport/relative offsets, active identity, and expansions. No fixture
  notification occurs between setting the reading offset and pressing J.
- A fresh, read-only targeted reviewer confirmed both named P1s resolved and
  found no new qualifying issue in their immediate fix delta: **OK with
  notes**. P2s were deferred at that checkpoint; the later accepted follow-up
  above supersedes that deferral. This is not a blanket no-defect claim for the
  complete application.
- These final notes were added after validation without changing application
  or test code. All browser evidence is synthetic and does not satisfy the
  native/provider/platform gates below.

## Current P2 parent validation

The parent independently validated the integrated worker source (not just the
worker reports), preserving the existing uncommitted UX-02 checkout. Source and
test hashes stayed unchanged during validation; no staging or publication occurred.

- All six `.pi/factory.json` commands exited 0: `mise run test:core`,
  `mise run check:contract`, `mise run lint:core`, `mise run test:ui`,
  `mise run typecheck`, and `mise run build:web`.
- Default UI suite after the review corrections: **276 passed / 15 opt-in browser
  tests skipped (16 files)**. This includes reader component **24**, App **69**,
  ContactPane **5**, and
  synthetic reply fixture **15** tests.
- Real-Chrome reader suite: **12 passed**, plus **12 passed** in a shuffled run.
  The formerly dependent anchor, self-scroller, and reply-exit cases each passed
  independently by name filter (**1 passed / 11 filtered skips** per run).
  Trusted CDP input covers the actual immediate K reversal while B is still
  loading, not merely an ordinary completed A → B → A round trip. The corrected
  participant handoff case also passed individually (**1 / 11 filtered skips**).
- Parent differential ownership replay after the correction: **2 passed**;
  toolbar Close and the outside button both retain focus when A returns empty,
  matching the before-P2 snapshot instead of the two failures observed before
  this correction. The durable reader suite also retains the owned-empty
  article fallback.
- Parent negative mutation check of the revised durable participant case:
  restoring only the pre-P2 App handler through an in-memory Vite transform
  causes the expected failure (`Ada Fixture` instead of `Ravi Longname`). The
  same case passes on final source. No imported/main source file was edited for
  this check; this expected-failure diagnostic is not a final-source gate failure.
- Covered-surface focus suite: **1 passed**.
- Existing row-layout suite in the VM's default `LANG=C.UTF-8` environment:
  **1 passed / 1 failed**, at the unchanged hardcoded date assertion
  `tests/inbox-list.rendered-layout.test.ts:442` (`Sep 30, 2001` versus
  `30 Sept 2001`). The exact pre-P2 dirty-source snapshot reproduces the same
  failure. With explicit `LANG=en_GB.UTF-8 LC_ALL=en_GB.UTF-8 LANGUAGE=en_GB`,
  **both row-layout tests pass**. This is a pre-existing locale-sensitive test
  assumption outside the authorized P2 fixes; no locale/test cleanup was made.
  The original failed run remains part of the evidence, not replaced by the
  conditional pass.
- Chrome runs used the existing cached binary and environment gates, ephemeral
  port-0 Vite servers and temporary profiles. The pre-existing port5173 server
  was neither used as evidence nor modified.

The first fresh review cleared the other assigned fixes and returned the two
P2 gaps described above. A new fresh-context, read-only targeted recheck confirmed
both corrections resolved and found no remaining or newly introduced P0/P1/P2
issue in those named fixes or their immediate blast radius: **Merge verdict:
OK with notes**. Prior notes/dispositions stand, except that the two findings are
now resolved. This is scoped acceptance, not publication authorization or a
blanket no-defect/native-platform release claim.

The final review outcome was recorded after validation without changing
application or test code; the independently validated source/test hashes remain
unchanged.

## Pending verification (not claimed as done)

- `mise run dev:native` on a prepared native host: the same keyboard/scroll/
  Back/disclosure/copy/reply journey, IME and native reserved-key behavior, and
  accessibility focus in the actual WKWebView shell. Not run here; recorded as
  **pending**, not passed. Native startup checks in this Linux VM are blocked by
  missing GTK/WebKit development prerequisites; no OS packages were installed.
- Native platform clipboard behavior (macOS pasteboard permissions and the
  unavailable-clipboard manual-copy path) is unverified; only the Chromium
  clipboard path of the synthetic preview was exercised.
- VoiceOver/assistive-technology walkthrough of the roving toggle, details
  disclosure, and copy status announcements: pending.
- No real accounts, credentials, mail, or provider behavior were exercised;
  synthetic Chrome success is not evidence of Gmail behavior. Screenshot pixel
  parity was not asserted anywhere.
