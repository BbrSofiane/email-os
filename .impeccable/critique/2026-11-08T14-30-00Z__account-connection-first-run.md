---
target: account, connection and first-run (AccountPanel, ProviderDestinations, FixtureWorkspaces, App.vue first-launch / no-account / sync / permission paths, header note slot, empty-inbox state)
total_score: 22
p0_count: 1
p1_count: 4
timestamp: 2026-11-08T14-30-00Z
slug: account-connection-first-run
---
# Critique run 1: account, connection and first-run

Method: single-agent, code-and-test verification only. Nothing was rendered (no Chrome on this VM), so every visual claim is read from CSS and templates. The whole-app review scored this area 22/40 and ranked it next after reader/compose. Each finding was re-checked against `App.vue`, `useMailbox.ts`, `browser-fake.ts`, the Rust status DTOs and the tests; verdicts are CONFIRMED, PARTLY WRONG or REJECTED.

## Heuristics 22/40
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 2 | Sync, sign-in expiry, offline and "connecting" exist only inside the Account drawer; the inbox says nothing |
| 2 | Match system / real world | 2 | "Determining account mode…", `conversation(s)`, raw `network_unavailable` in Provider mail, lowercase "unknown error" |
| 3 | User control and freedom | 3 | Cancel sign-in / cancel upgrade exist; Disconnect has no confirm step but a permanent warning instead |
| 4 | Consistency and standards | 2 | Bordered card, italic connection text and 0.3/0.8rem spacing vs the rest of the drawers; ProviderDestinations is unstyled `<p>`/`<button>` |
| 5 | Error prevention | 3 | Permission scope is disclosed before the upgrade; Disconnect is destructive and one click |
| 6 | Recognition rather than recall | 2 | No Connect / Sync now in the palette; Account is a bottom-rail glyph |
| 7 | Flexibility and efficiency | 2 | Provider mail has no row keys (j/k, Enter, Esc); no direct Sync |
| 8 | Aesthetic and minimalist design | 2 | Permanent "Disposable test account" note and the full disconnect warning with equal weight to the real action |
| 9 | Error recovery | 3 | Typed errors with plain sentences in Account; Retry is far from the message |
| 10 | Help and documentation | 1 | The empty inbox gives help that is false in four states |
| | **Total** | **22/40** | Acceptable |

## Findings: verification

### 1. False empty state — CONFIRMED, P0
`App.vue` (`inbox-empty`) shows "No conversations are currently in the inbox. Archived conversations stay recoverable from Activity." whenever `conversations.length === 0` in the inbox context and the list state is ready. Existing tests prove that `not_configured` and `disconnected` give zero rows (`account.component.test.ts` "shows a visible not_configured state…", "moves from disconnected to connected…"), so the sentence is shown with a Connect action nowhere on the page. The same branch runs during an unfinished first sync (`initialSyncComplete: false`, 0 rows), after `auth_required` with an empty cache, and after a failed first sync. None of those mean the inbox is empty. Two further inaccuracies found while reading:
- In Gmail mode with mailbox actions off (read-only) "stay recoverable from Activity" is also untrue: Activity never offers Mark not done there (`account.component.test.ts` "shows the account panel, read-only inbox…" asserts that).
- "Archived" is a banned label (DESIGN.md "Do": "Archive" is never a label), though this sentence predates that rule.
Fix: derive one state from `AccountStatus` (connection, sync.state, sync.error, initialSyncComplete, cachedConversations) and render a terse honest line with an inline action. The real "inbox is empty" text is kept only for connected, synced, empty; the Activity clause only where Mark not done really exists.

### 2. Reachability — PARTLY WRONG, P2
The review says the Account entry may be unreachable with no account. Verified: the rail Account button is `v-if="gmailMode && accountStatus"`, where `gmailMode` is `status.mode === 'gmail'`, and core reports `mode: 'gmail'` with `account: null` and `connection: not_configured | disconnected` before any account exists (fake: `useGmailMode(fake, { connection: 'disconnected', emailAddress: null })`, driven by the existing tests above, which open the drawer and click Connect). The palette action `account` is available on the same condition. Fixture mode (native default) and browser preview always have an account and a connected state, so there is nothing to connect and the entry is correctly absent. When the status read itself fails, the shell shows the account-gate Retry instead. So Connect is reachable in every mode where it can exist.
What is real: discoverability. Connect lives behind a 16px glyph at the bottom of the rail and nothing on the list points to it (finding 1). That is fixed by the empty state and the status slot, plus Connect / Sync now as palette commands.

### 3. No global status — CONFIRMED, P1 (wording partly wrong)
`grep sync.state src/App.vue` finds nothing; `accountStatus` is read only for mode, mutation access and the address. Sync running, sync error, offline (`network_unavailable` sync error), `auth_required` and `authenticating` are invisible outside the drawer. The only header note about the account is the read-only hint ("Gmail is read-only · Review access").
The suggested wording "Reading works; actions off" is NOT claimable: `actionAvailable` and `mailboxActionsEnabled` depend on `mutationAccess` only, never on `connection`, so with an expired sign-in the action buttons still run (and fail at the provider). The honest statement is about reading: "Cached mail stays readable." That goes in the note's title / hidden text; the visible part is the fact and the action ("Sign-in expired · Sign in"). No new gating of actions is introduced (out of scope, would change semantics).
`offline` is not a core state: it is a sync error whose kind is `network_unavailable`. The note says "Offline" only for that kind and says "Sync failed" for the rest, so unknown causes are not relabelled.

### 4. AccountPanel — CONFIRMED, P1
- Initial sync is one long sentence; `coverageText()` is 160+ characters.
- "Disposable test account. Cached reading remains available during permission changes." is permanent on a product that has no concept of a disposable account in its model: it is development guidance (already in `docs/development.md`).
- The disconnect warning (≈250 chars) is a permanent paragraph with the same weight as the button. Disconnect removes the local cache and pending actions on one click.
- `upgrading` renders a status sentence then a "Cancel permission upgrade" button that has no more weight than "Disconnect"; the user has to go and finish sign-in in a browser that Email OS does not show.
- The sync error is an alert paragraph far from the Sync now button, with no Retry beside it.
- Disconnect while `authenticating` is the same control relabelled "Cancel sign-in"; that is fine (nothing to lose) and stays immediate.
The permission-scope disclosure ("broad Gmail modify permission… sending and deleting") is consent text that must stay visible next to the Enable button; it is shortened, not hidden.

### 5. ProviderDestinations — CONFIRMED, P1
Bare `<p>`, `<button>`, a labelled search input and a toolbar with four unnamed-purpose buttons ("Refresh catalog", "Use saved catalog", "Refresh first page", "Use latest saved page"). Errors print the raw kind (`Could not load catalog: network_unavailable.`), which `AccountPanel.describeError` already has plain sentences for. No row model: catalog and destination rows are tab stops in a plain list, with no j/k/Enter. Loading is a status line at the bottom (`Loading bounded provider data…`) after the list. Escape is handled only for the reader.

### 6. Visual language and copy — CONFIRMED, P2 (one part wrong)
- `.account-panel` is a bordered 6px-radius box (the generic-card look the brand rejects) with 0.6rem/0.8rem padding and 0.3rem/0.8rem gaps: none are on the 4/6/12/24 scale.
- "Determining account mode…" is internal vocabulary. It also is not a connection: it reads local status, so "Connecting to your mailbox…" would claim a network step that is not happening. Replaced with "Loading account…".
- `conversation(s)` -> plural handled. `unknown error` default in `describeError` -> "Unknown error." (the lowercase `'unknown error'` in `App.vue` banners is a mid-sentence fragment that the template completes, and is left as is).
- Workspace banner: one 120-character run-on in a `<p>`. Shortened with the full sentence kept as the nav's accessible description.
- The switch button lacking a shortcut hint — PARTLY WRONG: there is no shortcut for it (`switch-account` is palette-only, `shortcut: ''`). The button gets a title naming the real route ("Switch account — also in Commands"), not an invented key.

### 7. Keyboard — CONFIRMED, P3
`browsing-actions.ts` has `account` (no chord) but no Connect / Sync. The g-chord set is `g e` (Done) and `g h` (Reminders, fixture only). Plan: palette commands `Connect Gmail` / `Sign in again` and `Sync now` (shown only when they can run); and `g a` -> Go to Account, in the existing chord machinery (`isGoSecondKey`, hint text, grace window), only in Gmail mode.

## Priority order
P0 false empty state; P1 global status slot, AccountPanel, ProviderDestinations; P2 visual language, copy; P3 keys. Reachability needs no code fix beyond discoverability.

## Not verified (before implementation)
No rendered check is possible (no Chrome). Real Gmail, OAuth and macOS Keychain are untouched: all states are exercised through the synthetic in-memory fake.

## Implementation results (same day)
Every change was written test-first; the new tests failed on the unchanged code (empty-state test saw the false "inbox" sentence on a failed first sync; AccountPanel 17/20 and ProviderDestinations 12/17 failed before) and pass after.

| # | Verdict | Result |
|---|---|---|
| 1 | CONFIRMED | Gmail plain-Inbox empty line is derived from `AccountStatus` (`src/lib/account-status.ts`) with an inline action; the old sentence survives only for a connected, fully synced, empty inbox, and Gmail read-only no longer promises Activity recovery |
| 2 | PARTLY WRONG | No gating change; a test now pins rail, palette and empty-state Connect with no account |
| 3 | CONFIRMED, wording corrected | `account-status-note` in the header slot; no "actions off" claim; "Offline" only for `network_unavailable` |
| 4 | CONFIRMED | Sections not a card; inline Disconnect confirm; permanent disposable note removed; "Finish sign-in in your browser" with Cancel primary; Retry inline with the sync error |
| 5 | CONFIRMED | Classes, plain errors, loading line before the list, j/k + arrows + Enter + stepwise Esc |
| 6 | CONFIRMED / 2 PARTLY WRONG | "Loading account…" (not "Connecting…": nothing is connecting); plural; "Unknown error."; banner shortened; switch button title names the palette (no shortcut exists) |
| 7 | CONFIRMED | `Connect Gmail` / `Sign in again` and `Sync now` palette commands; `g a` -> Account |

Checks on the final tree: `pnpm test` 1024 passed / 33 skipped (rendered Chrome gates are opt-in), `pnpm typecheck` clean, `pnpm build` clean. No Rust touched.

## Not verified
Nothing was rendered: header-note truncation at narrow widths, drawer spacing, and contrast are computed from tokens only. Screen-reader announcements are reasoned from markup. Real Google OAuth, real sync, native offline behaviour and the macOS Keychain were not exercised. Known limit (pre-existing, now documented in DESIGN.md): while `connectAccount` is in flight the Cancel sign-in controls are unavailable, so a browser flow that never completes cannot be cancelled from the UI.

## Follow-up (critique run 2, 28/40)
Implemented test-first on the same branch. Five issues from the second critique:

| # | Issue | Result |
|---|---|---|
| 1 | P1 header squeeze | Tabs get a width floor and notes give up width first (CSS); any connection or sync note replaces the read-only hint. jsdom cannot measure layout, so the CSS rule is pinned by a stylesheet test and the hint suppression by a component test |
| 2 | P2 repeated actions | Header note keeps words only when the empty line carries the action; one `Account` link on not configured; drawer Sync now hidden while Retry shows |
| 3 | P2 first-run clarity | One Ash line under the Connect empty sentence ("Opens Google sign-in in your browser. Starts read-only."); contact pane no-correspondent text hidden with no account; Provider mail disconnected note has a Connect control |
| 4 | P2 wording and cause | "Sync failed" everywhere; `network_unavailable` reads "Sync failed · no network" (no "Offline" wording); drawer label "Failed"; cause is visible words, not only a title; action error tone unified with the sync error |
| 5 | P3 | Connect Gmail ranks above Go to Account while disconnected; empty Keys rows hidden; sync facts separated and labelled; Disconnect and Keep account differentiated; duplicate "read only" removed; coverage line dropped when nothing is cached |

Checks: `pnpm test` 1047 passed / 33 skipped, `pnpm typecheck` and `pnpm build` clean. No Rust touched.

Still not verified: header layout at real widths (no rendered check of the new floor), real Google OAuth and sync, macOS Keychain, native offline behaviour, screen-reader announcements.

## Follow-up 2 (critique run 3, 28/40)
Implemented test-first on the same branch. The empty inbox line now owns the status sentence in zero-row states (user decision). Five issues from the third critique:

| # | Issue | Result |
|---|---|---|
| 1 | P1 tab floor (two tabs + `Unread only` + read-only hint at 1030px left `Inbox` 13px, label 0px) | The tab column floor is built from the strip: `max(10rem, Inbox 4.5rem + saved 9rem + chips 4.75rem each + 18px gaps)` through `:has()` rules; tabs and nav are `flex: 0 0 auto`; a saved-tab label stops at `12ch` with an ellipsis (full name in `title`); at 1100px and below the read-only hint collapses to its Review access link. Pinned by the stylesheet test and a markup test |
| 2 | P2 duplicate status text | In a zero-row state with the empty line showing a status, the header note loses its visible words, link and count and stays as one hidden `role=status` announcement; the Preview tag remains. With rows, or when the line only says the inbox is empty, the note shows as before. `emptyLineOwnsStatus` is unit tested |
| 3 | P2 first-run void | Contact pane silent when the list has no rows (any state), `text-wrap: balance` against the straggler; not configured gets the next step in the empty line (`Add a Google client ID to the launch environment, then restart.`) and the drawer, and the "connecting is unavailable" wording is gone; the `Connect Gmail` hint now explains read-only |
| 4 | P3 names and tone | `Connect Gmail`, `Sign in again`, `Cancel sign-in`, `Retry`, `Sync now` on every surface; the network cause reads `no network` in the header, empty line, drawer and title; `Disconnect` confirm has a Coral Fault text and border cue, Keep account stays focused |
| 5 | P3 drawer facts and announcements | Mode row and Sync section hidden while disconnected, not configured or signing in; a typed failure shows one Coral line with Retry (no `Failed` state word); `Sign-in expired` once in the drawer; header note silent while the drawer shows the same failure as its alert; `Sync now` leads the palette on a sync failure |

Rejected or deferred: drawer focus on open stays on the region (the shared `openDrawer` pattern for every drawer; Account does not diverge). The palette `Keys` row `Open destinations ←` stays: Left still opens the navigator with no account. The drawer and palette keep a `Connect Gmail` control for a not-configured device (unchanged behaviour; the line above it now says why it cannot work yet). The 36x16 header Retry hit area and the 4.30:1 rail icon from the personas were not touched.

Still not verified: layout at real widths (no browser was available; the floor is computed from the measured widths and the tokens, so 1030px has not been re-measured), `text-wrap: balance` rendering, real Google OAuth and sync, macOS Keychain, native offline behaviour, screen-reader announcements (the single `role=status` and the silenced note are reasoned from markup), and Tab order in the drawer.
