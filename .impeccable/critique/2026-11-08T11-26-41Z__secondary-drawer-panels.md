---
target: secondary drawer panels (ActivityPanel, CachedTrashPanel, DraftsPanel, RemindersPanel and how App.vue mounts them)
total_score: 20
p0_count: 0
p1_count: 4
timestamp: 2026-11-08T11-26-41Z
slug: secondary-drawer-panels
---
# Critique run 1: secondary drawer panels

Method: single-agent, code-and-test verification only. Nothing was rendered (no Chrome on this VM), so every visual claim is read from templates and CSS, not measured. The whole-app review scored this area 20/40 (attention 7/10). Each of its findings was re-checked against the code, the DTOs and the tests; verdicts are CONFIRMED, PARTLY WRONG or REJECTED. Baseline: `pnpm typecheck` clean, `pnpm test` 920 passed / 33 skipped (rendered suites are opt-in).

## Heuristics 20/40
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Statuses are honest (queued / unknown / failed all distinct), but they are prose fragments ("failed (provider_rejected)") with only the row tint carrying severity |
| 2 | Match system / real world | 1 | Rows are identified by raw `conversationId`; "Retry with a new request ID"; "Conversation groups"; lowercase tab names; a typed RFC3339 field; "Revision 3" on every draft |
| 3 | User control and freedom | 2 | Esc closes the drawer, but the drafts editor has no way back to the list except closing the editor; Reminders picker can only be dismissed with a button |
| 4 | Consistency and standards | 1 | Four panels, four layouts; none shares the list's row anatomy, the composer's rows or the PR #29 status-line pattern; two headings per drawer |
| 5 | Error prevention | 3 | Retry/Undo/Cancel are explicit, disabled while busy, and gated by capability; outcome-unknown carries its warning |
| 6 | Recognition rather than recall | 2 | Reminder time must be typed; no shortcut hints in any drawer |
| 7 | Flexibility and efficiency | 1 | No keyboard model: every row action is Tab-only, in a surface whose product promise is keyboard-first |
| 8 | Aesthetic and minimalist design | 2 | Four disclaimer paragraphs before Cached Trash data; a 150px draft list; up to four sentence-length buttons per reminder; bordered rows and boxes |
| 9 | Error recovery | 3 | Retry, Inspect durable state, Retry exact request, Reload saved all exist and are honest |
| 10 | Help and documentation | 2 | Long explanations are standing paragraphs instead of titles |
| | **Total** | **20/40** | Acceptable, below the reader (23) |

## Findings: verification

### 1. Activity identifies mail by raw ID and speaks jargon — CONFIRMED, P1 (one sub-claim WRONG)
`ActivityPanel.vue` prints `op.conversation.conversationId` (`.activity-id`) for every row and group member, "Request {{ requestId }}" for a group, and "Retry with a new request ID" on both retry buttons. "Conversation groups" / "Show older groups" are the section and continuation labels. Status text is `failed (provider_rejected)` etc.; severity is carried by an italic (queued) or the `status-*` colour on the whole row.
- Subject: `OperationSummary` and `OperationGroupStatus` carry **no subject**. The wire DTO has `conversation: ConversationRef` and nothing else descriptive, so a cached subject has to come from rows the client already holds. `useMailbox.subjectFor` (rows in the current list, then the open conversation) is the existing pattern and already returns `null` rather than an id. The fix is a small session-scoped subject index in the UI (rows seen in the list, Cached Trash rows, the open conversation) that the panel receives as a lookup; unresolved refs say "Unknown conversation". No backend change.
- **WRONG: "a FullDate in the trailing slot" for single operations.** `OperationSummary` has no acceptance timestamp (only `undoableUntil`, a window end, which is not when the action happened). Showing it as the row date would be a fabricated fact. Only **groups** carry `acceptedAt`, so only group rows get a trailing FullDate. Single-operation rows put the status word in the trailing slot. Adding an `acceptedAt` to the Rust DTO is new backend behaviour and is deferred (see Remaining).
- Status words: `Queued`, `Applying…`, `Confirmed`, `Failed`, `Unknown`, `Cancelled` in sentence case; colour on the status word only (Amber Notice for queued / applying / unknown, Coral Fault for failed, Ash for confirmed / cancelled). The failure kind, request ID and operation ID move to `title`s; the human reason (`errorLabel`) and the outcome-unknown warning stay inline because they are exceptions, not standing text.
- `Request {{ id }}` becomes a title on the group toggle. "Retry with a new request ID" becomes `Retry` (the title keeps "Retry with a new request ID. The original result is not rewritten.").

### 2. Cached Trash is disclaimers plus bare buttons — CONFIRMED, P1
`CachedTrashPanel.vue` renders four stacked paragraphs ("Known cached Trash only…", "Loaded local snapshot…", "N cached conversations loaded. Total unknown.", "Trash is not Done. Move to Trash, Recover…") before the first row, a full-width "Refresh cached Trash" chip and "Load more cached Trash". Rows are a bullet list of a subject button plus a bare mailbox span (no name, no date), and nothing but Tab moves between them. The only loading state is a `role=status` sentence that renders after the list shell.
- Data for the compact anatomy exists: `ConversationSummary.primaryCorrespondent`, `subject`, `lastMessageAt` (same as the list row). Sender label rule is the list's (`displayName ?? mailbox`, "Unknown sender" when absent).
- Honesty to keep: the cache-coverage caveat (not the full Gmail Trash; total unknown; Trash is not Done; no recover / delete here) moves into one Ash line plus a `title`/visually-hidden description, the same status-line pattern as the reader. The count line stays as a `role=status` fragment ("12 cached · total unknown") because the count is data, not a disclaimer. The empty state keeps "This does not mean your Gmail Trash is empty." Failure stays a Coral `role=alert` with Retry.
- Existing test pins: text contains "not your complete Gmail Trash"; `button[data-id]` rows; focus returns to the `data-id` row on Esc; the alert contains the error kind; the empty text contains "does not mean your Gmail Trash is empty". These contracts survive.

### 3. Drafts: a two-column grid inside a 460px drawer — CONFIRMED, P1
`.drafts-pane` is `grid-template-columns: minmax(190px, .7fr) minmax(0, 2fr)` (style.css ~1752) with a collapse only at `max-width: 760px`, but the drawer is `min(460px, 92vw)` wide, so the media query never fires at desktop widths. At 460px minus 0.75rem gutters the columns are roughly 150px (list) and 270px (editor); `.draft-row` stacks `strong` subject, `span` recipient, `small` "Revision N · Reply" in a column with a border-bottom per row. The local-only paragraph, a "Draft to {name}" line and the editor's own `h2` repeat what the drawer header and the editor status line already say. The raw "Reply source is fixed: <ids>" line is already gone (PR #29 moved it into hidden `data-source-*` attributes), so that sub-claim is **stale, not actionable**.
Fix: one column. The list is the default view; opening a draft or New draft replaces the list with the editor (`DraftEditorCore` untouched), with a quiet `Back to drafts` ghost and Esc: the editor's existing Esc already runs the protected flush-and-close, which hides the editor and returns the list, and a second Esc closes the drawer. Rows are 36px: recipient (Title), subject (Body, Ash if empty-state placeholder), date trailing (`FullDate` compact). Revision appears only on a conflict (the `status` string already says "Conflict — edits preserved"); the revision lives in the title. One Ash line: "Local to this device · never sent". Recovery and error lines keep their wording and `role=alert`.

### 4. Reminders: lowercase tabs, run-on lines, four sentence buttons, raw ID, typed time — CONFIRMED, P1
`RemindersPanel.vue`: `{{ tab }}` renders `pending / returned / history` lowercase; the row line is `Someday (unscheduled) · If no reply · pending · revision 3`; a row can show Open + Reschedule + "Cancel and restore original inbox messages" + a 130-character failure paragraph; the picker prints `{{ conversationId }} · source {{ sourceMessageId }}` and asks for `2030-11-03T09:00:00-05:00` typed. Standing paragraphs: "Synthetic fixture only · …" and "New incoming mail stays in Inbox…".
Scope is proportionate (the feature is fixture-only; `remindersSupported` requires `accountStatus.mode === 'fixture'`): structure, density, copy and presets, no new backend behaviour.
- Real tabs (`role=tablist`, `aria-selected`, roving arrows) named Pending, Returned, History with counts.
- Rows: subject (Title), due `FullDate` trailing, one-word phase (Pending / Removing / Returning / Returned / Failed / Cancelling / Cancelled / Suppressed), condition only when it is not the default. Reschedule and Cancel become quiet ghost text buttons ("Reschedule", "Cancel reminder"); the "restore original inbox messages" sentence and the failed-phase explanation move to titles (the failed explanation stays inline: it is an exception).
- Picker: preset buttons (Later today, Tomorrow, Next week, Someday) compute a real RFC3339 string with a numeric offset in the viewer's time zone and fill the same `due` ref; the typed field sits behind `Custom`. `put` payloads are unchanged, so exact-retry and revision semantics are untouched. Raw conversation / message IDs leave the picker (subject instead; IDs in a title).
- Existing test pins: `input[type="text"]` (now behind Custom), "removing" text, `nav button` tabs, `Refresh reminders` / `Retry exact request` / `Reschedule` button texts, the `timezone offset` error. These are updated, not weakened.

### 5. Duplicate headings and nested landmarks — CONFIRMED, P2
`App.vue` renders `<div class="utility-drawer" role="region" :aria-label=drawerTitles[drawer]>` with `<header class="drawer-header"><h2>` and then each panel adds its own landmark and sometimes its own title: Activity `<aside aria-label="Operation activity">` + `<h2 class="activity-title">Activity</h2>`; Drafts `<section aria-label="Local drafts">` + `<h2>Drafts</h2>`; Reminders `<section aria-label="Desktop-local reminders">`; Cached Trash `<section aria-label="Cached Trash browsing">`. So "Activity" is announced twice (and "Operation activity" a third time) and an `aside` complementary landmark sits inside a region. `drawerTitles` also has long labels ("Provider mail — read only", "Cached Trash — read only") that are used as both the visible h2 and the accessible name, so the visible title is wordy.
Fix: the drawer owns the region name and the single visible h2. Panels become plain `div`s (no landmark, no heading that repeats the title). Account / Provider mail keep their markup (out of scope) but must still get a drawer header. Visible titles shorten ("Activity", "Drafts", "Reminders", "Cached Trash"); the long names stay as the region's `aria-label` where tests pin them (`Local drafts`, `Provider mail — read only`). The drawer-header close button stays.

### 6. Row borders and bordered boxes — PARTLY WRONG (documented exception, but it conflicts with the rule it sits under)
DESIGN.md ("Palette deltas", gap 10) explicitly keeps `rule` for "inside drawers (Activity and draft rows, group detail, Account panel, Reminders fieldset)", with the stated reason "so those surfaces keep their tone until a reader reference is captured". So the borders are not undocumented drift, but they are a carried-over stopgap and they contradict "Seams-Only Rule: dividers separate panes, never rows". `.activity-row`, `.draft-row` have `border-bottom: var(--rule)`; `.activity-group-detail` and `.discard-confirm` are boxed; the reminders `fieldset` is boxed.
Decision: the redesigned rows are 36px rhythm rows with no borders (Activity rows, draft rows, group detail members, reminder rows); the group detail loses its box and indents by rhythm; the reminders fieldset loses its border. `rule` stays only for the reader and the Account panel (out of scope here), and for the composer's own structure (footer rule, discard confirm: untouched, owned by PR #29). DESIGN.md gap 10 is updated to say so.

### 7. No keyboard model in any drawer — CONFIRMED, P1
No panel has a key handler, a roving tabindex or row-level focus. With a drawer open App returns early for everything but Escape (`if (drawer.value ...) return;`, App.vue ~1937), so J/K and arrows are free to be owned by the panel. Escape closes the drawer through the window handler and returns focus to the rail toggle (`closeDrawer`), which already works from any drawer element.
Fix: one shared composable (`useDrawerRows`) used by all four panels: a container handler for ArrowDown / ArrowUp / J / K / Home / End, Enter activates the row's primary action (rows are real buttons or carry one), roving `tabindex` (focused row 0, others -1, first row when none), `data-drawer-row` marker, and `aria-current` free. It ignores editable targets, IME composition, modifier keys, `repeat` where an action would double-fire, and non-row buttons (trailing actions keep native Enter/Space). Cached Trash's remembered focus (`state.focusedId`) feeds the roving index. Esc stays with App (closes the drawer; in the drafts editor the editor's own Esc flushes and returns to the list first).

### 8. Off-scale spacing and the missing 50px inset — CONFIRMED, P2
`.utility-drawer { padding: 0.5rem 0.75rem }`; row gaps 0.2 / 0.3 / 0.35 / 0.4 / 0.5 / 0.8 / 1rem across Activity, Drafts, group detail and Reminders. DESIGN.md's scale is 4 / 6 / 12 / 24 / 32 and the 50px content inset (list left edge); the 50px inset is calibrated to the *list pane*, whose left edge is the rail seam. A 460px drawer cannot reuse the full 50px (it would leave 400px, and the contact column is 272px with a 24px inset), so the drawer uses the **contact pane's 24px inset** for its content edge (the drawer is the same Deep Umber surface, and the contact pane is the documented secondary-surface precedent) with 6px/12px rhythm. No new tokens: `--contact-inset: 24px` already exists. Verdict: CONFIRMED with an adjustment; aligning to the list's 50px was rejected for width reasons.

## Cross-cutting: contrast and states (computed, not sampled)
Ash `#c0bcb6` is 7.79 / 6.86 / 4.99:1 on Warm Charcoal / Lifted Charcoal / Focus Stone; on Deep Umber `#1f1e1c` it is higher still. Drawer rows live on Deep Umber with a Focus Stone focus fill (the list's fill, no lavender bar change: the **One Signal Rule** allows the focus accent once per screen, and the list is `inert` while a drawer covers it, so the drawer's focused row is the one current row). Graphite is not used for text or meaningful glyphs on Focus Stone in the new rows. Amber `#e4c465` and Coral `#f1a9a5` words each carry text (Status-Is-Sacred).

## Remaining after this pass (not addressed here)
- Single-operation Activity rows have no timestamp: needs an `acceptedAt` on the Rust `OperationSummary` and `mise run gen:ts`. Deferred as new backend behaviour.
- The subject index is session-scoped: after a restart, operations for mail that has not been listed yet say "Unknown conversation" until the row is seen. A durable subject on the operation would fix that and is a backend change.
- Reminders stay fixture-only; the presets compute client-side local times and do not model DST gaps beyond what `Date` provides.
- Account and Provider mail drawers: out of scope.

## Not verified
No rendered check was possible in this critique (no Chrome / screenshots on this VM unless the browser preview is driven later). Contrast ratios and all geometry are computed from tokens and CSS, not sampled. Real-Chrome journeys (`*.rendered.test.ts`) are opt-in on `EMAIL_OS_RENDERED_LAYOUT_CHROME`.
