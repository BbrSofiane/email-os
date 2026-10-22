# UX-01 — Compact browsing shell: implemented contract and evidence

Status: implemented at the component/composable/core-contract level and validated
with the repository's automated gates. Targeted real-Chrome checks of the
synthetic browser preview also pass for contact resize/focus, Inbox/Activity
navigation, and a nonzero-scroll reader round trip. Native fixture/WKWebView,
full visual calibration, and assistive-technology verification remain
**explicitly pending**. These targeted browser probes do not establish native
E2E correctness or Superhuman equivalence.

Grounding: `docs/superhuman-browsing-implementation-plan.md` (UX-01, acceptance
BROWSE-01, BROWSE-05 conversation portion, BROWSE-17, BROWSE-20) and
`superhuman-email-browsing-ux-spec.md` (main-list composition, visual tokens,
reconstruction layout policy, reader replacement, contact context).

## Bounded UX-01 contract

What shipped:

- A persistent narrow email rail (Inbox + utility entries), a compact Inbox
  navigation/status header (count, pending operations, last-command error,
  preview disclosure), one central surface that is either the conversation list
  or the reader — never both at once — and a contact-context surface.
- Compact one-line rows: constrained sender, single-line subject/snippet,
  trailing compact date and row-scoped actions, ~36px scanning rhythm, lavender
  focus bar on a soft warm-gray fill, low-contrast warm dividers, and unused
  space below short lists (rows are not stretched). The subject keeps a
  readable floor (its column ≥ 136px, ~104px of subject text at the default
  font). If larger text and metadata exhaust the available row width,
  actions move behind a measured, named “More actions” disclosure; pending,
  read-state, and date remain on the row. Regression coverage includes the
  1000px contact breakpoint with 16px and 20px root fonts and an older date.
  Compact metadata presentation keeps full accessible names: visible
  "Unknown"/"Read"/"Unread" state with `aria-label="Read state unknown"`, and
  compact row action chips whose labels carry the complete "Mark read" /
  "Mark unread" semantics via `aria-label`.
- Non-selectable chronological date group headings derived in the viewer's
  calendar; they never reorder the backend's rows and are never actionable or
  tabbable.
- Account/Activity/Drafts moved into explicit labelled utility disclosures with
  keyboard-operable entry/close controls, Escape precedence, and focus
  restoration. The drafts editor routes to the drafts disclosure; close
  protection and draft recovery states remain visible or one click away; every
  user departure from an active drafts drawer (Close, another utility,
  Contact, Inbox) goes through the protected flush-and-close lifecycle and
  keeps the exact editor buffer visible on failure instead of leaving a hidden
  editor owning the keyboard. Utility and contact disclosures are mutually
  exclusive, and draft save or close failures remain recoverable even when the
  drafts drawer is not the visible surface.

Explicitly out of scope (unchanged from the plan's non-goals): message-level
focus/expansion (UX-02), bulk selection, Undo, command palette, search, saved
splits, labels/stars/reminders, native tabs, multi-account infrastructure, any
AI or calendar control, and no empty reserved regions for them (BROWSE-20).

## Supervisor-approved decisions recorded here

- **Strict 1000 CSS px contact breakpoint.** At `>= 1000px` the contact pane is
  a persistent column; strictly below `1000px` it is replaced by a
  keyboard-operable Contact disclosure. When the viewport shrinks across the
  breakpoint while the contact content holds focus, focus returns to the
  disclosure control so focus never lands in hidden content.
- **Local-calendar bucket precedence.** `Today`, `Yesterday`,
  `Earlier this month`, one named month+year bucket per calendar month, and an
  explicit `Unknown date` bucket for missing/unparsable timestamps. Bucketing
  uses the viewer's calendar (optional explicit IANA zone, otherwise the
  environment zone), computed on wall-clock components so Yesterday correctly
  crosses month, year, and DST boundaries. Backend row order is preserved; a
  heading is emitted only where the bucket changes between consecutive rows.
- **Exact newest-From semantics for the primary correspondent.**
  `ConversationSummary.primaryCorrespondent` is derived only from
  `messages.last().from` of the ordered detail stack in both summary builders
  (fixture `store.rs` and `gmail/store.rs`); it is never guessed from the
  unordered participant list, never fabricated, and nullable display names pass
  through unchanged. The field is additive: absent values are omitted on the
  wire (`skip_serializing_if`, `ts(optional)`), legacy summaries without the
  field still deserialize, and the TypeScript contract is regenerated only via
  `mise run gen:ts` (never hand-edited). The browser fake mirrors the exact
  behavior, including self-authored latest messages.
- **Focus is not selection.** Rows use ordinary `list`/`listitem` semantics with
  roving tabindex and `aria-current="true"` on the focused row; `aria-selected`
  is no longer used so a future bulk-selection model (UX-05) can diverge from
  focus. Group headings are `role="presentation"` and outside the tab order.
- **Geometry is approximate.** Warm-dark tokens and the ~36px rhythm are
  reconstruction starting values from the reference screenshot, not verified
  CSS-pixel targets. Screenshot measurements are image coordinates; calibration
  on real displays is future work.

## Focus identity and origin/fallback behavior

- `useMailbox` replaces index-based selection with an explicit account-scoped
  `focusedRef` (`{ accountId, conversationId }`). `focusConversation(ref)`,
  `moveFocus(delta)`, `openFocused()`, and `archiveFocused()` resolve the
  intended reference from the current snapshot — never a saved array position
  (BROWSE-17).
- Snapshot transitions preserve a surviving reference across inserts,
  reordering, and failed-command rollback. If the focused row is removed, focus
  resolves to the next surviving row from the old ordering, then the previous
  survivor, then the first available new row; an empty result clears focus. The
  initial nonempty load focuses the first row.
- Focus is cleared on disconnect/account change; cross-account references never
  resolve to a summary. Focusing never fetches details and never writes read
  state; `openFocused()`/`archiveFocused()` refuse to act from a non-ready or
  stale list.
- Reader round trip: before the reader replaces the list, App captures the
  Inbox origin — the focused reference plus a visible-row anchor (row
  reference, viewport-relative offset, and a `scrollTop` fallback). On
  Back/Escape the list renders again, the surviving anchor row is restored by
  applying the measured viewport-offset delta to the list's current
  `scrollTop` (the captured `scrollTop` is used only as the fallback when the
  anchor row no longer exists), and the surviving row is focused with
  `preventScroll`, which suppresses the automatic reveal so focus restoration
  cannot undo the anchor's scroll positioning; otherwise the resolved neighbor
  or the empty state receives focus. J/K scroll only enough to reveal focus
  (`scrollIntoView: nearest`).
- Activity-opened readers keep a safe Activity return target: the drawer is
  closed while the reader owns the central surface and reopens after Back,
  together with the saved Inbox anchor.
- Hover changes nothing: no hover handler mutates focus or read state, and
  focusing an inline row button neither scrolls the row to center nor reopens
  it. Inline actions stop propagation and remain row-scoped.

## Safety invariants preserved

- Opening is read-only: no auto-mark-read, anywhere, in either mode
  (`reader-no-auto-read` / read-only disclosures remain).
- Archive/read/retry authority, permission gates, request tokens, receipt
  handling, and late-receipt/navigation guards are unchanged; keyboard
  shortcuts keep their IME/modifier/text-field/button exclusions, and an open
  utility or contact disclosure takes Escape precedence and suppresses the
  mailbox shortcuts underneath it.
- Reader content remains plain text with no `v-html`, no remote assets, and no
  fabricated contact enrichment; the contact pane renders only exact known
  name/mailbox fields and discloses when nothing is known.

## Named acceptance checkpoints and evidence status

| Checkpoint | Test/manual checkpoint | Evidence status |
|---|---|---|
| BROWSE-01 (six-conversation split, one focused row, compact rows, date groups, contact context, no body in contact pane) | `tests/app.component.test.ts` "UX-01 compact browsing shell journey" (six-conversation synthetic client in `tests/helpers.ts`): compact rows, non-selectable group headings, fourth-row focus/open/back with anchor restoration, contact correctness; `tests/inbox-list.component.test.ts` for row semantics | Passing Vitest/jsdom evidence only; visual calibration pending |
| BROWSE-05 (conversation portion: move focus, open, return to the same row) | `tests/app.component.test.ts` "focuses the fourth row, opens it, and returns to the same row with a restored anchor" and the Slice 01 Enter/Escape focus-restoration tests | Passing in jsdom; parent Chrome probe also preserved conversation ID, scrollTop 170, and row viewport offset across a reader round trip. Native verification remains pending |
| BROWSE-17 (new mail while focused; action keeps the original stable ID) | `tests/useMailbox.test.ts` insertion/removal/rollback focus tests; `tests/app.component.test.ts` "keeps an action targeted at the original id when a newer row is inserted (BROWSE-17)" | Passing |
| BROWSE-20 (no AI/calendar controls or reserved regions) | `tests/app.component.test.ts` journey test asserts no calendar/AI buttons; layout reserves no slots for them | Passing |
| UX-01 Contact focus handoff (breakpoint shrink/grow) | `tests/app.component.test.ts` "hands off focus to the surviving contact disclosure when shrinking across the breakpoint (P2)" and "does not steal focus during breakpoint shrink when focus was elsewhere (P2)" | Passing jsdom and parent Chrome checks: 999→1000 moves focus to the wide contact surface; 1000→999 moves it to the Contact control; list focus is not stolen |
| UX-01 Inbox destination from overlays | `tests/app.component.test.ts` "leaves no Contact overlay after explicit Inbox navigation (P2)", "returns to Inbox (not Activity) when navigating from an Activity-origin reader (P2)", "still returns to Activity after an ordinary Escape from an Activity-origin reader (P2)", "does not hide the draft editor when Inbox navigation is requested while save is pending (P2)" | Passing in jsdom, including the pending-save guard. Parent Chrome checks also confirm Contact dismissal, explicit Inbox overriding Activity origin, and ordinary Escape restoring Activity. Native protected-close verification remains pending |

## P1 rendered-layout regression: bounded row metadata at 1000px

- **Bug.** With Gmail actions enabled, the unbounded `auto`-sized trailing
  metadata (read-state text + date + up to three `white-space: nowrap`
  actions) collapsed the subject/snippet column to **0 CSS px at 1000px** —
  both for an unknown read state alone and for the realistic unknown+pending
  combination (held `setArchived(false)` on an inbox thread; a held read
  setter makes read state known, so it is not a valid repro).
- **Fix.** `.inbox-row` is now a flex row: when the metadata is widest, the
  deficit comes out of the sender column (160→90px floor) while the
  subject/snippet column keeps a 136px floor (≈104px of readable subject, the
  preview yields first), and `.row-meta` stays content-sized (`flex: 0 0
  auto`) so nothing is clipped. Metadata presentation was compacted without
  losing capability: visible state label "Unknown" with
  `aria-label="Read state unknown"`, and row action chips with tighter inline
  padding whose compact labels carry the full accessible names
  (`aria-label="Mark read"/"Mark unread"`). All `data-test` selectors, the
  explicit archive/read controls, and the contact breakpoint are unchanged.
- **Regression.** `tests/inbox-list.rendered-layout.test.ts` exercises real
  rendered CSS/layout (not jsdom rectangles): an opt-in Vitest node-environment
  test that starts an ephemeral Vite dev server plus a headless Chrome profile
  (caller-supplied binary via `EMAIL_OS_RENDERED_LAYOUT_CHROME`, driven over
  raw CDP — no new dependencies, no E2E framework) and asserts, per scenario,
  a caret-measured readable subject prefix (≥ 10 visible leading characters at
  1000px; full subject at 1440px), ≥ 120px subject/snippet column and ≥ 100px
  subject box, single-line row height, no horizontal overflow, visible
  pending/read-state disclosures, and
  named, keyboard-reachable, clickable actions. Scenarios: unknown read state
  with actions enabled at 1000px; unknown + held-unarchive pending membership
  at 1000px; 1440px wide sanity. Default `pnpm test` runs skip it (environment
  gate); it was run and is green with
  `/home/exedev/.cache/rod/browser/chromium-1321438/chrome`:

  ```
  EMAIL_OS_RENDERED_LAYOUT_CHROME=/home/exedev/.cache/rod/browser/chromium-1321438/chrome \
    pnpm vitest run tests/inbox-list.rendered-layout.test.ts
  ```

  Against the pre-fix layout the same test fails (subject column 0px),
  demonstrating red/green. The parent independently confirmed both results:
  green on the working tree and red in an isolated copy with only the pre-fix
  row CSS/template restored. All six configured checks also passed; the default
  UI run reported 199 passed and this one browser test skipped, followed by the
  explicit Chrome invocation passing separately. Browser server and profile
  teardown happen in `finally`; only the synthetic in-memory browser fake is
  used — never real Gmail.

## Follow-up P1 fixes: covered actions and larger text

- **Covered actions.** The central list/reader surface is `inert` while a
  utility drawer or the narrow Contact disclosure is open. Rail and active
  disclosure controls remain available; closing the disclosure restores
  central interaction. This prevents Tab/Shift+Tab from reaching covered mail
  actions and Enter from activating them behind a drawer.
- **Larger text.** A row-local `ResizeObserver` detects when inline actions no
  longer fit. Compact rows offer a named “More actions” disclosure containing
  the same explicit read/unread/archive controls and stable IDs. Its local
  Escape handling returns focus to the toggle; a panel near the list bottom
  opens upward. This fixes the reproduced 1000px/20px-root-font overflow with
  unknown read facts, pending membership, and an old date without shrinking
  the user's root font or clipping actions.
- **Durable browser coverage.** `tests/disclosure-focus.rendered.test.ts`
  exercises real Chrome Tab/Shift+Tab, Enter and pointer input with Activity
  and narrow Contact, including restored interaction after dismissal.
  `tests/inbox-list.rendered-layout.test.ts` also exercises the 16px/20px,
  old-date, unknown-plus-pending cases and operable compact actions. These
  tests use isolated synthetic previews and caller-supplied Chrome, not real
  accounts or native IPC.
- **Independent combined validation.** After importing only the two workers'
  owned deltas, the parent ran both rendered test files successfully (three
  browser tests total) and all six configured checks. The normal UI suite
  reported **205 passed, three opt-in browser tests skipped**; those three
  were explicitly run with Chrome separately. This evidence note was added
  after validation without changing application or test code. P2 follow-ups
  and native/WKWebView/VoiceOver verification remain pending.

Run the browser gates separately with the appropriate environment variable:

```sh
EMAIL_OS_DISCLOSURE_FOCUS_CHROME=/path/to/chrome \
  pnpm exec vitest run tests/disclosure-focus.rendered.test.ts
EMAIL_OS_RENDERED_LAYOUT_CHROME=/path/to/chrome \
  pnpm exec vitest run tests/inbox-list.rendered-layout.test.ts
```

## Executed validation

- `mise run gen:ts` — regenerated `src/lib/ipc/generated.ts` from the additive
  Rust DTO change (executed; contract-drift check green).
- `mise run check` — core tests (including the new fixture and Gmail
  primary-correspondent tests), contract-drift check, `cargo fmt`/`clippy -D
  warnings`, all Vitest suites (186 tests, including updated Slice 01/02 account,
  draft, and close-race gates), and `vue-tsc` typecheck: **passing**.
- `mise run build:web` — production frontend build: **passing**.
- `pnpm test` / `pnpm typecheck` — **passing** (199 tests across 10 files after
  this authorized correction pass, including the breakpoint-handoff and
  Inbox-destination regressions in both directions). Production build passes.

### Parent acceptance verification after the authorized correction

- Independently ran all six `.pi/factory.json` checks through the factory's
  deterministic check helper: core tests, generated-contract check, core lint,
  UI tests (**199 passed across 10 files**), typecheck, and web build all passed.
  The source fingerprint was unchanged throughout the checks; this evidence
  summary was added afterwards without changing application or test code.
- Eight targeted checks in real headless Chrome passed against the explicitly
  labelled synthetic, in-memory browser preview: contact growth and shrink
  focus handoffs, no focus theft from the list, Contact-to-Inbox dismissal,
  opening archived fixture mail from Activity, explicit Inbox overriding that
  origin, ordinary Escape preserving it, and a reader round trip preserving
  the focused ID, nonzero list scrollTop, and viewport offset.
- Browser dimensions were changed via Chrome's actual device-metrics API at
  999/1000 CSS px. The scroll round trip used real layout, not jsdom geometry.
  These were ad hoc parent validation probes, not a newly installed E2E runner;
  no real mailbox, native IPC, or provider behavior was exercised.

## Pending verification (not claimed as done)

- `mise run check:native` / `mise run test:native` — **blocked** in this
  environment: GTK/WebKit development prerequisites (`glib-sys`/`gobject-sys`
  via pkg-config) are absent, matching `docs/development.md`. Not reported as
  passed.
- `mise run dev:native` operator follow-up: actual WKWebView/native-fixture
  scroll/focus restoration, resize behavior, keyboard/VoiceOver walk-through,
  and the six-conversation journey. Targeted Chrome success does not satisfy
  those platform gates or prove native IPC persistence.
- Full visual calibration (~36px rhythm, warm-dark tokens), broader browser
  interaction/accessibility coverage, and exact Superhuman fidelity remain
  unverified. Neither synthetic Chrome nor native fixture success is evidence
  of real Gmail behavior.
- No-auto-read remains mandatory in every mode; any future change to that
  invariant requires its own approval.
