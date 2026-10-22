# Superhuman-inspired browsing: incremental implementation plan

**Status:** Proposed roadmap, not an implementation contract or authorization to access real mail.

Source: [Superhuman Email Browsing UX Specification](../superhuman-email-browsing-ux-spec.md).
Existing constraints: [ADR 0001](adr/0001-single-account-desktop-email-client.md),
[development guide](development.md), and implementation contracts for
[Slices 01](vertical-slice-01.md), [02](vertical-slice-02.md),
[03](vertical-slice-03.md), and [04](vertical-slice-04.md).

## Recommendation

Build the browsing experience around the existing mail foundation, not as a replacement backend or a screenshot-only frontend. Deliver a working user journey in each slice:

```text
User input → Vue interaction state → typed MailClient/Tauri boundary
           → Rust query/command → SQLite/provider where needed
           → authoritative result/change hint → visible state and recovery
```

Start with **focus → open → read → back** in the new layout. Then introduce discovery, reversible triage, bulk processing, a saved split, and historical search. Stop at that useful browsing milestone before expanding into the broader mailbox-management features.

Use `UX-01` onward below to avoid confusing this roadmap with the repository's existing numbered implementation slices. These are delivery increments, not separate architectural layers. A slice must not wait for a later "backend integration" or "testing phase" to become useful.

## 1. What exists and what must change

Source inspection, not a new runtime certification:

| Area | Current implementation | Consequence for this plan |
|---|---|---|
| Foundation | Vue 3/TypeScript, thin Tauri 2 shell, Rust `mail-core`, SQLite | Preserve the stack and narrow typed boundaries |
| Mail access | Explicit single-account Gmail profile; bounded discovery of up to 100 conversations; plain-text cache; sync and freshness reporting | Cached rows are not the entire mailbox; browsing/search/counts need explicit coverage |
| Actions | Durable archive/unarchive and explicit read/unread; immutable message targets, idempotency, reconciliation, Activity | Reuse execution machinery; Undo, groups, stars, labels, trash, etc. are new work |
| Drafts | Local-only composer, revisioned saves, safe reply preparation, native close/quit protocol | Rehouse rather than rewrite; preserve dirty-buffer and close protections |
| Layout | `App.vue` mounts list, reader, Activity, account and drafts panels; `style.css` has a multi-column utility layout | New list/reader modes and contact pane are a real layout change, not merely new colors |
| Focus | `useMailbox.ts` exposes `selectedIndex`, preserving identity during refresh; `InboxList.vue` treats focus as selection | Introduce explicit ID-based conversation focus, separate from future bulk selection |
| Reader | All plain-text messages expanded; no separate message focus | Add message focus/expansion without changing safe rendering or reply-source rules |
| Discovery | Inbox-only `listConversations()`; no search, split definitions, folder/label catalog, palette, or contact pane | Add bounded queries as the relevant slice needs them |
| Tests | Rust synthetic provider/storage tests; Vitest component/transport tests; in-memory browser fake | No existing real-browser E2E runner; fake IPC tests do not validate the native bridge |

Primary change points:

- `src/App.vue`, `src/assets/style.css`, `src/components/InboxList.vue`, `ReaderView.vue`, `ActivityPanel.vue`.
- `src/composables/useMailbox.ts`; retain `useDrafts.ts`'s persistence/lifecycle responsibilities.
- `src/lib/ipc/client.ts`, `tauri-client.ts`, `browser-fake.ts`.
- `crates/mail-core/src/dto.rs`, `store.rs`, `gmail/{types,provider,store,sync,operations}.rs`.
- `src-tauri/src/main.rs`, command manifest/permissions and capabilities whenever IPC changes.
- `src/lib/ipc/generated.ts` remains generated from Rust, never hand-maintained.

Do not reorganize the whole repository, add a state framework, build a generic workflow engine, or replace the worker before delivering the first journey.

## 2. Scope and fidelity decisions

1. **Evidence remains visible.** Implement visual/documented (`V`/`D`) requirements; treat proposed (`P`) interactions as our chosen contracts. Keep unresolved (`U`) fidelity questions in a checklist. Passing our tests does not establish behavioral equivalence to Superhuman.
2. **Keep opening non-mutating.** The app's explicit no-auto-read policy stays. The spec permits, but does not require, marking a loaded conversation read. Any later automatic-read policy needs a separate decision, capability checks, and tests.
3. **Single-account Gmail first.** Keep account identity on every reference, but do not build Outlook or multi-account infrastructure to demonstrate abstraction. Hide unsupported commands rather than implementing inert controls.
4. **Preserve the composer.** Composition/sending behavior is outside this browsing plan. New draft/Reply remain exits into the existing local-only editor; do not add sending or weaken source-message validation.
5. **Stay plain-text initially.** No `v-html`, remote avatars, tracking pixels, fabricated contact enrichment, or HTML rendering in the privileged app DOM. Attachment previews and HTML fidelity have separate security gates.
6. **Treat the larger spec as a roadmap, not a silent ADR replacement.** Saved splits/search fit the accepted first build. Broader labels/actions need explicit implementation contracts; reminders, attachment previews, and native multi-account tabs require updates to ADR 0001's explicit deferrals before implementation. AI, calendar and mobile remain excluded.
7. **No new mailbox authority is implied.** Planning a label/trash/unsubscribe action does not authorize operating it on a real account. Preserve the existing permission upgrade and disposable-account gates.

## 3. Minimal shared design, introduced incrementally

### Separate mail state from browsing state

Rust/SQLite continues to own cached provider facts, durable intent, view definitions and operation history. Vue owns navigation, focus, selected IDs, expansion, scroll anchors and overlays. Backend events remain invalidation hints, not the source of truth.

Introduce the state needed by each slice, rather than landing the entire spec's state model first:

- UX-01: focused conversation **reference**, open reference, list scroll anchor and reader origin.
- UX-02: active message ID and expanded message IDs, scoped to a conversation visit.
- UX-03: context/history and a topmost overlay; initially only inbox and cached Done.
- UX-05: selected references and range anchor, independent of focus.
- UX-06/07: saved-split/search contexts, query/filter and result-page identity.
- UX-13 only: independent per-workspace browsing state and multiple accounts.

Always key by account plus conversation/message identity, not array position. Compute an index only for adjacent movement. Clear invalid focus/contact/action targets on empty results and invalidate stale requests on account/context changes.

### One action catalog, not a generic executor

Introduce a small frontend command registry in UX-03. Buttons, shortcuts and palette entries share action IDs, labels, shortcuts, availability and target resolution. The execution path still invokes named typed IPC commands; never expose `execute`, arbitrary SQL, HTTP, filesystem or arbitrary provider-label mutation.

Dispatch precedence: system/browser reservations → top overlay → editor/IME/native controls → reader message commands → conversation actions → inbox-only split navigation. Intercept `Tab` only when the inbox conversation surface owns it, never globally. Escape dismisses the top surface, then selection, then reader/search context. Do not steal focus during background refreshes.

### Extend query contracts when contexts arrive

In UX-03 introduce a bounded browsing request/result alongside, or compatibly extending, the current inbox query. It should carry:

- A validated context, later filter/query, and opaque pagination cursor.
- Account-scoped conversation summaries with stable ordering and IDs.
- Coverage/freshness: cached versus provider results, whether more pages exist, and whether an exact total is known.
- Separate loaded-row count from any exact total count. Unknown is not zero.

The backend verifies the active account; caller-supplied IDs do not authorize another account. Provider searches/folder reads use their own bounded result/cache policy and must not reset inbox discovery/history checkpoints or evict operation recovery snapshots. Freeze details in the relevant slice contract, not all future APIs now.

## 4. Delivery sequence

### UX-01 — A compact inbox that can actually be browsed

**Journey:** Launch → move focus with J/K → see the correspondent → Enter/click → read → Escape/back to the same row and scroll position.

- Build the rail, compact top navigation and warm-dark tokens from the spec. Use constrained sender width, a one-line subject/snippet, trailing date/actions, lavender focus bar, nonselectable date groups and generous unused space below short lists.
- List mode shows contact context, not a message preview. Reader mode replaces the central list surface; rail and contact context remain. Account/Activity/drafts become explicit accessible surfaces instead of permanent competing columns. Keep freshness, pending/error indicators and recovery discoverable.
- Convert `selectedIndex` into explicit focused identity. Hover must not change focus/read state; inline actions stop propagation. Preserve existing archive/recovery controls and permission gates during the layout change.
- Render only known contact fields. Add a minimal backend-derived primary correspondent to the summary if needed; do not fetch an entire body on every J/K movement or guess the latest sender from the unordered participant list. No external enrichment.
- Use real cached/core data through existing list/detail IPC. Additive DTO changes require generator and transport tests. No new provider writes.

**E2E checkpoint:** Use a six-conversation synthetic scenario with long names, mixed read states and missing profile fields. Focus the fourth row, open it, return, and verify row identity, list scroll and contact context. Insert a newer row while focused: an action must still target the original ID. Test empty/loading/error states and narrow-desktop contact disclosure.

**Acceptance:** BROWSE-01, 05 (conversation portion), 17, 20. Screenshot measurements are image coordinates, not established CSS pixels; calibrate on the Mac rather than asserting pixel parity.

### UX-02 — Read a multi-message conversation without losing your place

**Journey:** Open a conversation → N/P between messages → O/Shift+O expand → inspect participant details → J/K to another conversation → return to the originating list.

- Add message focus, expansion and a purple focus cue; newest relevant message initially expanded. Use the existing cached message stack and safe text rendering.
- Keep reader scrolling separate from rail/header. Preserve expansion and scroll during background refresh and within the current visit; prune IDs removed remotely.
- Provide full known From/To/timestamps via disclosure. Hover/focus participant context temporarily, restore on exit; contact copy controls must not trigger navigation or drafting.
- J/K in the reader follows its originating list/context, not all cached mail. Loading a different thread disables stale destructive targets.
- Reply still targets the explicitly displayed latest source under Slice 04's checks; focusing an older message must not silently change the reply contract. Unknown Cc/Bcc/header data is absent, not fabricated.

**E2E checkpoint:** A three-message conversation with a long body, hostile literal markup and multiple participants. Exercise message versus conversation navigation, expansion, participant context, copy, reply exit and Back. Reorder/update the source list while reading; stable IDs and a surviving anchor must win.

**Acceptance:** Complete BROWSE-05; copy portion of 15. HTML-only/incomplete/retained snapshots keep their current disclosures and restrictions.

### UX-03 — Discover actions and navigate to recoverable mail

**Journey:** Cmd+K → “go to Done” → open a cached archived conversation → Back to the exact prior inbox context.

- Introduce the shared action catalog and context-aware keyboard dispatcher. Start with implemented actions only: open/back, Done/Not Done, explicit read controls, account/Activity/drafts destinations, and Inbox/cached Done.
- Palette has an input, keyboard-highlighted results, Enter execution, Escape/focus restoration and shortcut labels/tooltips. Editable controls and IME cannot invoke mailbox shortcuts.
- Left opens a small destination navigator; support `G`, then `E` with a documented proposed timeout. Inbox and cached Done reuse rows/reader and a context history stack.
- Add a Rust read query for known locally archived/recovery conversations, including retained snapshots. Label this coverage honestly: it is not provider-complete Done/All Mail. Do not define Done as every thread lacking INBOX; future Sent/Spam/Trash membership must stay distinct.
- Keep activity history independently retrievable as contexts expand; a filtered list must not accidentally filter out operation failures.

**E2E checkpoint:** Archive a fixture thread, navigate to cached Done through palette and pointer, open it and return. Deny capabilities, delay destination responses and type `e/s/h` in the palette: no wrong-thread mutation. Preserve local drafts and normal-close protection after moving their entry points.

**Acceptance:** BROWSE-10, 20 and folder return/keyboard precedence contracts. Cmd+K must be exercised in WKWebView, not just synthetic key events.

### UX-04 — Process one conversation with trustworthy Undo

**Journey:** E marks Done → row/count/focus update → Z within 10 seconds restores the exact prior target state; explicit read/unread has the same recovery discipline.

- Reuse existing durable setters and authoritative pending overlays. Add a concise notification with Undo and visible pending/confirmed/failed/unknown distinctions; accepted locally is not confirmed remotely.
- Add narrow Rust Undo eligibility/query and command contracts. Persist the original target IDs, prior **per-message** values for the affected dimension, expiry and linkage to the original operation. A UI timer or `setArchived(false)` against the thread's latest inventory is not sufficient.
- Undo atomically cancels still-unclaimed intent where safe, or stages an ordered compensating operation against the immutable targets. It must not touch a new incoming message or independent labels/star/read state.
- Initially support the latest eligible action only. Mixed read facts require restoring each prior value; unknown prior facts are not exactly undoable. Expiry and same-target newer actions are checked in Rust. Uncertain dispatched outcomes remain explicitly uncertain/reconciled, not falsely reported as undone.
- Use `Z`, not native text-editing Cmd+Z. Preserve Activity-based recovery after expiry and on restart.

**E2E checkpoint:** Archive → undo at 9 seconds; reject at expiry; archive last/only row; failure rollback; offline accept → restart → restore/reconcile; a new reply between action and Undo remains untouched. Check mixed read values and an older Undo after a newer same-target action.

**Acceptance:** BROWSE-07, 08. Fake clock/provider tests prove durable semantics; approved disposable-Mac tests prove remote convergence.

### UX-05 — Select and process several conversations safely

**Journey:** X / Shift+J/K / Cmd- or Shift-click select three rows → archive → inspect per-item results → recover failures or Undo the eligible group.

- Add selected-ID set/range anchor and explicit count; focus is not selection. Plain J/K never expands selection. Escape clears selection before leaving the list; changing context clears cross-context selection.
- Actions resolve exactly the selected set, otherwise the current conversation. Inline row actions remain explicitly row-scoped. Bulk read controls use a visible desired state rather than ambiguous mixed-state toggling.
- Add durable bounded group acceptance with member receipts/status, idempotent group request and immutable per-thread message targets. Do not treat frontend `Promise.all` as durable or atomic bulk execution.
- Reuse serial execution/reconciliation. Report accepted, succeeded, failed and unknown members separately; failed IDs remain actionable. Group Undo reuses UX-04's preimages and excludes unsafe/superseded members explicitly.
- “Select all loaded” means loaded rows only. Do not promise cross-page/all-matching selection.

**E2E checkpoint:** Select noncontiguous IDs, insert/reorder mail, archive, fail one member and lose another response. Verify precise targets, separate statuses and recovery after restart; returning from a reader must not widen selection.

**Acceptance:** BROWSE-06 (archive), 18; later star actions reuse the same selection mechanism.

### UX-06 — One real saved split, not a classification engine

**Journey:** Define a sender/domain view → switch Inbox/saved split by pointer or Tab → open/read/archive → see both memberships/counts update → disable the view without deleting mail.

- Implement the ADR's one local saved definition, initially bounded sender/domain criteria, stable ordering and optional hide-when-empty. Persist it in Rust/SQLite; add a small editor, no natural-language authoring.
- Reuse browsing contexts, reader, bulk actions, commands and Undo. Views derive membership and never mutate mail. Overlap with Inbox is intentional, not a duplicate-storage error.
- Define counts as total matching conversations, not unread. Render badges only for exact known totals 1…999; cached-only views disclose that scope, and unavailable mailbox totals are not presented as exact.
- Add single-active unread filter first, with unknown read facts not treated as unread. Choose/document nonwrapping split navigation until live evidence says otherwise. Hidden views remain reachable through the palette.
- Do not invent Important/Other classification from Gmail IMPORTANT or make those mutually exclusive storage folders. Existing-label criteria become available after UX-09.

**E2E checkpoint:** Save → restart → switch → open → archive → undo; verify overlapping views, focus/selection isolation, hiding and disabling. Synthetic exact counts 0/1/999/1000 exercise badge rules; timezone-boundary fixtures exercise date groups.

**Acceptance:** BROWSE-02, 03, 04 plus split membership/configuration contracts. Ship Inbox + one named saved split before broader split configuration.

### UX-07 — Find older mail and return without losing the query

**Journey:** / → enter query → Enter → result → reader → Back to query/results/focus → Back to previous split.

- Add search input/operator guidance and reuse the normal list/reader/action surfaces. Contact-name click becomes sender search; add up to four real recent-email links from a bounded query, not invented history.
- Add account-scoped Rust search and a bounded provider read path for older mail. Online search reaches beyond the 100-conversation inbox window; offline search uses cached content with an incompleteness disclosure. A failed search is not an empty result.
- Define a supported parser/AST for AND, OR, quoted phrases, exclusions and initial From/To/Subject criteria. Reject unsupported syntax visibly; do not silently give cached and provider modes different meanings. Add Cc/Bcc/label operators only when the requisite facts are available. Document fields, date/time and Spam/Trash defaults.
- Page/cancel provider work, guard account/context/query generations, deduplicate by conversation ID, and retain the query while loading details. Respect existing rate pacing and auth/cancellation.
- Bound search cache retention separately from inbox discovery; persist/pin any operation targets/recovery context before evicting results. Opening an uncached result is a visible load, never a substitute thread.

**E2E checkpoint:** Find an archived conversation absent from inbox discovery, page results, inspect it, return and edit the query. Force stale responses, offline incomplete coverage, expired auth, rate limits and a missing result body. Contact copy stays independent of search/draft exits.

**Acceptance:** BROWSE-09, 10, 15, 19 and archive-searchability from 07. This completes the initial browsing milestone; it does not complete the ADR's sending/dogfooding scope.

### UX-08 — Star a conversation and find it in Starred

**Journey:** S (or bulk Star) → indicator → go to Starred → unstar → correct neighbor/Back/Undo.

- Add observed per-message star facts, conversation aggregation, a narrow durable setter and reconciliation. Keep star independent of inbox/read state and feed the same group/Undo/catalog machinery.
- Starred becomes a real browsing destination. Add the starred filter once the facts exist, not before. Unknown/partial star facts must remain distinguishable where they affect correctness.

**E2E checkpoint:** Star archived mail, find it in Starred, unstar while browsing that view, fail/restart/reconcile and verify independent read/inbox facts and bulk scope.

**Acceptance:** Remaining star portion of BROWSE-06 and Starred/filter contracts. New provider writes remain capability- and operator-gated.

### UX-09 — Browse labels/folders, then Label versus Move

**Journey:** Left → label → open → L applies a tag without archiving → V moves by applying the destination and Done → recover.

- First add provider label metadata and paginated read destinations: Sent, provider Drafts, All Mail, Spam, Trash and user labels, alongside Inbox/Done/Starred. Distinguish provider Drafts from app-local drafts. Never imply the 100-row cache covers these folders.
- Introduce label facts/membership and existing-label saved-view/search criteria. Render compact badge metadata. Large catalogs get “Show more”; all destinations remain searchable through the palette.
- Then add narrow validated label-apply/remove and Gmail Move commands. Move's label-plus-archive intent is durable and recoverable as one logical operation, not two unrelated UI calls. Preserve other labels/read/star states and freeze message-level membership semantics.
- Gmail only: do not expose Outlook folder/category semantics as supported. Do not add label create/delete or arbitrary rules just to support browsing.

**E2E checkpoints (separate increments):** First browse an uncached provider label and return. Then apply a label and verify INBOX stays; Move and verify destination plus Done; interrupt between stages, restart and recover without falsely reporting full success.

**Acceptance:** BROWSE-11 and remaining ordinary destination/label contracts. Pending/returned Reminders and Muted arrive only with their actual capabilities.

### UX-10 — Broader triage, one explicit scope at a time

This is a sequence of small optional contracts, **not one large mutation PR**:

1. **Trash/recover:** move to Trash → browse Trash → restore; no permanent-delete or empty-Trash command. Distinguish from Done everywhere, including search membership and Undo.
2. **Mute/unmute and Spam/recover:** separate Gmail-supported actions/destinations, immutable targets and visible recovery. Do not assume removing INBOX reproduces future-message mute behavior; validate provider semantics first.
3. **Manual Important/Other placement:** begin with one-conversation placement and separate view membership. Only then add an explicit sender/domain rule editor and durable local rule evaluation. No automatic classification/AI; no implicit escalation from thread to sender/domain. Disclose local-only rule execution and offline/quit limits.
4. **Unsubscribe/Block:** separate exact external/send/provider effects and sender/domain scope from optional archive/trash. Do not implement these as arbitrary URL opening or silently create a send path. Add only after their specific safety/authority contract; otherwise omit the controls.

Each increment reuses contexts, action scopes, durable intent, groups and recovery. A provider feature being unavailable is a visible capability boundary, not a silent no-op.

**E2E checkpoint per increment:** Exact-target action → destination/provider effect → recover; reject unsupported provider/capability; verify sender/domain scope needs explicit confirmation and does not alter unrelated mail.

**Acceptance:** BROWSE-12 plus Trash/Mute/Spam/Block/Unsubscribe contracts. Blocking semantics are not specified sufficiently to assume parity; establish a product/provider contract before implementation.

### UX-11 — Manual reminders with correct pending and returned states

**Scope gate:** Explicitly revise ADR 0001's reminder deferral before implementation.

**Journey:** H → choose manual time/“if no reply” → pending Reminders folder → simulated clock/reply event → returned Reminders split → cancel/recover.

- Store reminder time/timezone, condition, source message/reply baseline and state durably. Default “if no reply,” offer “regardless,” and treat “someday” as unscheduled.
- Pending reminders and returned reminders are distinct memberships. Scheduling/removing from inbox and returning/recovering are coordinated durable intents, not a frontend timer.
- Freeze what counts as a qualifying reply, DST/time parsing, rescheduling/cancellation races and new-message behavior. Reconcile replies before claiming a no-reply reminder fired; incomplete/offline facts cannot prove no reply.
- Execute while the process runs; on launch, reconcile overdue work idempotently. Make desktop-local/non-cross-device behavior explicit. No promise of execution while fully quit and no calendar UI.

**E2E checkpoint:** Schedule → restart → advance fake clock → fire once; qualifying reply suppresses return, “regardless” does not, “someday” never auto-fires. Test cancellation/failure and simultaneous incoming mail.

**Acceptance:** BROWSE-13 and reminder condition/recovery contracts.

### UX-12 — Safely inspect an attachment and return to the message

**Scope gate:** Attachment preview exceeds ADR 0001's initial download-only scope.

**Journey:** Open attachment chip/Cmd+O chooser → preview PDF → Escape restores exact message/expansion/scroll → unsupported file uses explicit download/external path.

- Add bounded attachment descriptors and Rust-owned authenticated fetch/storage. Keep sender filenames/path traversal, MIME mismatch, size limits, safe save destinations and cancellation explicit.
- Validate a restricted PDF viewing surface with no privileged app IPC, no automatic remote-resource loading and a tested platform sandbox. Do not place a third-party document viewer/raw HTML into the trusted app DOM. Choose the viewer only after a macOS security/compatibility spike; download-only is an honest interim capability.
- Cmd+O offers known links/files without auto-opening one arbitrarily. Add copy/open context menus, validated external protocols and safe external handling; no automatic execution. A displayed email address/draft exit remains separate from a URL/attachment action.

**E2E checkpoint:** Preview/dismiss, corrupted PDF, oversized/missing/offline file, unsupported Office/HTML file, malicious filename/link protocol and attempted external resource load. Underlying reader remains reachable throughout.

**Acceptance:** BROWSE-14. Safe richer HTML mail rendering remains a separate project, not bundled into attachments.

### UX-13 — Independent workspaces/accounts, then genuine native tabs

**Scope gate:** Explicit multi-account and native-shell decision; do not make this a prerequisite for the single-account browsing milestone.

**Journey:** Open two workspaces on different accounts → navigate/search/select independently → switch → no state, credentials or actions leak between accounts.

- First prove isolated browsing states with the existing fixture identities and a session boundary; flush/block dirty-editor account transitions using the existing draft lifecycle.
- Then extend backend account/profile/credential ownership and locking. Two tabs must not create competing writers to one profile; same-account windows share controlled core state or are rejected deliberately.
- Validate real macOS native tab support in Tauri before promising it. In-app tabs are a disclosed alternative, not a faithful native-tab implementation. Honor browser/system-reserved Cmd+T/number/tab shortcuts in browser preview.
- Add account switch palette commands, account-aware titles/counts and independent Back stacks. Still no unified inbox or default cross-account search.

**E2E checkpoint:** Two synthetic accounts with identical conversation IDs; switch while loads/actions are pending, then verify every result/command stays scoped. Native focus/title/shortcut behavior and concurrent profile access require Mac testing.

**Acceptance:** BROWSE-16. Multi-account activation requires a separate approved credential/runtime test path.

## 5. Validation is part of every slice

### Three evidence levels — do not conflate them

1. **Headless core/contract:** temporary SQLite, synthetic Gmail HTTP responses, fake provider/secrets/clock. Assert exact IDs, facts, receipts, migrations, restart behavior and provider-call counts. Regenerate/check Rust-owned TypeScript and test exact Tauri command argument mappings/allowlists.
2. **Rendered browser UI:** retain Vitest for state races and component semantics; propose adding a real-browser E2E runner (e.g. Playwright) for key/pointer journeys, scroll/focus, viewport screenshots and accessibility checks. This runner/dependency is not currently installed. The browser fake remains explicitly synthetic/in-memory; these runs are UI integration, not proof of Rust persistence or provider behavior.
3. **Native end to end:** run the same journey in the packaged/dev Tauri app with a disposable **synthetic fixture profile**. Inspect visible results and reopen persisted state after restart. This crosses Vue → actual IPC → Rust → SQLite → UI. Use a repeatable manual Mac script initially rather than promise an unvalidated macOS automation driver. Separately, only with approval, run disposable-Gmail convergence/failure checks. Prior Mac checks do not certify new slices.

The Linux VM currently lacks native GTK/WebKit prerequisites. Do not install OS packages, connect accounts, or mark native/WKWebView gates passed because browser/core tests passed. Record "implemented; native validation pending" where appropriate.

### A slice's completion record

For every UX slice, commit its narrow behavior/contract and an acceptance checklist containing:

- Its one primary journey, relevant BROWSE IDs and explicit departures from target fidelity.
- At least one loading/empty case and one failure/stale-response or restart case applicable to that journey.
- A synthetic fixture scenario independent of the user's real mailbox; deterministic clock/timezone for date/count tests.
- Exact expected action targets/provider calls; read-only browsing must not add write calls.
- Browser evidence and native status separately, with before/after screenshot/focus/state observations where useful.
- Existing draft-save/normal-close, permission, retained-snapshot, no-auto-read, hostile-text and account-isolation regressions still passing.

Use the existing core/contract/lint/UI/typecheck tasks (`mise run check`) and web build (`mise run build:web`); native checks remain separate prerequisites/platform gates. Add browser E2E tasks only when the runner lands. No runtime tests or native/provider validation were performed merely to write this plan.

### Cross-cutting quality checks, starting with UX-01

- Semantic conversation focus **versus** bulk selection; do not keep today's focus-only `aria-selected` meaning once bulk selection exists. Use a valid list/grid/action structure and expose message expansion/dialog state.
- Keyboard and pointer routes, visible non-color-only focus, focus restoration, live announcements for counts/outcomes/errors, reduced motion and readable contrast.
- Date-group timezone/boundary policy, truncated names/subjects, unknown dates and long content; headers are never actionable conversation rows.
- Local focus/selection feedback target below 100 ms, measured on representative hardware. Build a large synthetic list test; introduce virtualization/pagination when measured necessary, preserving ID focus and screen-reader position. Do not fetch bodies on focus.
- New mail, deleted threads, partial bulk failures, offline unavailable bodies, auth expiry and attachment errors retain a valid navigation/recovery path. No invisible destructive target.
- Visible controls/palette results contain no AI/calendar items, dead placeholders or unsupported operations. Optional read receipts/Recent Opens remain omitted unless an independently supported capability is designed; recipient opens are never local read/unread state.

## 6. Traceability and release checkpoints

| Spec acceptance | Owning increment(s) |
|---|---|
| 01 — compact list/contact | UX-01 |
| 02–04 — split counts/switching | UX-06 |
| 05 — conversation/message navigation and return | UX-01/02 |
| 06 — bulk actions | UX-05; star in UX-08 |
| 07–08 — archive/Undo/neighbor | UX-04; searchability UX-07 |
| 09–10 — search/typing safety | UX-07; dispatcher safety begins UX-03 |
| 11 — Label versus Move | UX-09 |
| 12 — Important/Other action scopes | UX-10 |
| 13 — pending versus returned reminders | UX-11 |
| 14 — PDF/unsupported attachments | UX-12 |
| 15 — contact search/copy | UX-02/07 |
| 16 — tabs/accounts | UX-13 |
| 17 — stable focus on arrival | UX-01 onward |
| 18 — partial bulk failure | UX-05 onward |
| 19 — offline search coverage | UX-07 |
| 20 — no AI/calendar | Every increment |

**Checkpoint A — UX-01/02:** Visually recognizable, keyboard-complete browse/read/back loop with contact context and real native fixture integration.

**Checkpoint B — UX-03/04/05:** Discoverable commands and safe single/bulk triage, with durable recovery and no loss of existing drafts/Activity behavior.

**Checkpoint C — UX-06/07:** One useful configurable split and historical search. This is the recommended first browsing release/evaluation point. It complements rather than substitutes for the ADR's separate send/reply completion work.

**Later checkpoints — UX-08 onward:** Prioritize from observed fallback reasons, one capability at a time. Explicitly approve scope expansions before reminders, previews and multiple accounts. Do not delay Checkpoint C for full spec parity.

**Immediate next step:** Turn UX-01 alone into an implementation contract: six-row fixture scenario, chosen focus/activation/Back/viewport policies, minimal summary DTO delta, named files and native acceptance script. Implement and evaluate that cross-section before freezing the next slice's details.
