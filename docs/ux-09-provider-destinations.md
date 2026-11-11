# UX-09 — provider destinations (increment A)

Originally based on UX-05 at `6c30b9c`; rebased onto main `b4972ee`, which
includes UX-06/07/08. Their contracts are preserved, not reimplemented here.
This is a read-only, independently testable increment, not completion of UX-09
or BROWSE-11.

## Contract

Named typed commands list provider destinations and read one bounded destination
page. Gmail only in native; browser preview uses labelled synthetic data.
Sent, provider Drafts, All Mail (excluding Spam/Trash), Spam, Trash and user labels
are supported. Provider Drafts are read-only snapshots, never local editable drafts.
Catalog filtering searches all loaded metadata, with nine initially visible and
Show more. Pages load at most 25 threads; no total or mailbox completeness is
inferred. Reader Back keeps loaded page, row identity and scroll via mounted list.
Opening never marks read and renders plain text only, including known To recipients.
Rows cannot open while Refresh/Next is pending, so page replacement cannot strand
a reader on a disconnected origin. Native Cmd+K reaches the palette; ordinary
mailbox shortcuts stay fenced. Reader Escape respects IME and modifier reservations
before returning to the list. Missing account identity shows an account-required
state, not an empty drawer. No provider writes.

Read membership follows Gmail `threads.list`: an exact label-ID filter selects
conversations and `threads.get` returns their full observed message stack, not
only messages with that label. Sent, provider Drafts and user-label reads use
`includeSpamTrash=true` (so matching messages in Spam/Trash can appear); Spam and
Trash use their corresponding label IDs. All Mail instead uses the closed query
`-in:spam -in:trash` with the provider's default Spam/Trash exclusion. These are
not mutually exclusive storage folders. Provider pages can change between reads;
a short page, deleted thread, or absent continuation is not an exact total.
The catalog bound is 10,000 destinations, IDs ≤256 bytes and names ≤1 KiB;
pages are capped at 25 fetched conversations and 16 MiB serialized thread data.
At most 20 destination pages plus one catalog are retained, independent of
mailbox-operation retention. Page/cursor errors preserve the previous saved page.

SQLite stores destination metadata/pages separately from inbox discovery/history,
message facts, pending operations and retained recovery snapshots. Each destination
retains only its latest successful page, explicitly timestamped; cached mode is
explicit, never a silent fallback on provider error. Disconnect clears these
snapshots; generation/account checks reject results racing disconnect. Pages and
catalogs are bounded; cursors are account/destination scoped at the UI boundary.
Live catalog, page and thread reads bind the expected account to the token from
one coherent credential publication and recheck identity after network work,
including empty pages. A stored-account preflight prevents dispatch for a missing
or foreign cached account. At most one live destination/catalog job is admitted;
overlaps return typed `Busy`. Admission releases on success/error/cancellation,
and disconnect/shutdown cancel and drain the job. Saved reads remain network-free
and do not compete for live admission. No SQLite/control lock spans network work.
Native fixture mode rejects this capability; the entry is hidden there.

## Acceptance checklist

- [x] Uncached synthetic provider destination → page → reader → same list (jsdom).
- [x] Sent/provider Drafts/All Mail/Spam/Trash/user label query mapping (local HTTP fixture).
- [x] Catalog search + Show more, literal hostile label/body text (jsdom).
- [x] Bounded provider request, malformed cursor/foreign account rejection, error versus empty.
- [x] Retained page restart and stale-generation/disconnect isolation (real SQLite).
- [x] Typed transport and generated DTO checks; named native ACLs registered in source.
- [x] Headless inbox/bulk/draft/close regression gates (see evidence below).
- [x] Post-rebase full core gate passed; the earlier failed run remains recorded below.
- [x] Real headless Chrome synthetic-preview journey and screenshots.
- [ ] Native WKWebView/Gmail and disposable provider validation.

## Next increment / capability boundary

No Label/Move controls or mutation IPC in increment A. Existing operations store
only archive/read booleans and per-dimension preimages; destination snapshots are
not authoritative action target inventories. Increment B must add current
per-message label facts, validate only existing user-label IDs, freeze exact
message targets, and persist apply/remove or apply+archive as ONE logical intent
with per-stage unknown/partial reconciliation and exact preimages. It must join
single/group/Undo ordering rather than bypass UX-05. No label create/delete,
system-label mutation, Outlook semantics, or frontend chained Move.
Increment B acceptance (all pending):

- [ ] Persist authoritative per-message existing-label facts; reject unknown,
  stale/deleted, reserved/system and cross-account label targets.
- [ ] Apply/remove changes only the selected label dimension; Label retains
  original INBOX/read/star/unrelated-label facts for the exact message targets.
- [ ] Move stages destination application plus archive as one durable logical
  intent/receipt, preserving exact targets and independent dimensions.
- [ ] Single/group/Undo ordering cannot bypass or supersede unsafe preimages;
  new incoming messages are excluded from old intent and compensation targets.
- [ ] Interruption/restart, apply-only partial state, lost responses and failed
  or unknown reconciliation remain explicit in Activity; no false full success.
- [ ] Synthetic provider tests plus a separately approved disposable-account
  native/provider gate validate the above (fakes are not remote convergence).

Main's saved-view and historical-search criteria remain unchanged; this separate
destination browser does not extend their grammar or coverage. This is not a
claim of full UX-09 completion or permission for additional provider mutations.

## Evidence

### Post-rebase integration and real-Chrome preview

After rebasing onto main `b4972ee`, the overlapping contracts and IPC methods were
combined and `mise run gen:ts` regenerated the DTOs. The synthetic destination
fake explicitly carries unknown star/newest-sender facts rather than dropping
main's new fields. `RUST_TEST_THREADS=1 mise run test:core`: **273 passed**,
including main's saved-split/star/search suites. The earlier Undo race did not
reproduce in this run; its previous failed run is not rewritten as a success.
`mise run check:contract`, `mise run typecheck`, `mise run test:ui`,
`mise run build:web`, `mise run check:native`, `mise run test:native` and
`git diff --check` passed. UI: **580 passed / 28 opt-in rendered tests skipped**;
native bridge: **8 passed**.

`mise run lint:core` completed formatting, then failed on two unchanged main
Clippy `cloned_ref_to_slice_refs` findings at `gmail/store.rs:4808,4860` in UX-07
search tests. These are outside this diff and were not silently edited as UX-09
work (the same calls are at main `store.rs:4748,4800`). Focused
`cargo clippy --locked -p mail-core --lib --test provider_destinations -- -D warnings`
passed; this does not turn the aggregate lint failure green.

The actual Vite app ran at `http://127.0.0.1:4173` with its clearly disclosed,
in-memory synthetic browser fake. Real headless Chrome checks verified catalog
search of hostile text, zero injected images/scripts, Sent paging, literal body
and known To recipients (including mailbox-only page two), Back focus restoration,
and browser-reserved Cmd+K not opening the native palette. Screenshots are stored
under `/tmp/email-os-ux09-screenshots/` (`01-catalog-drawer.png`,
`02-sent-drawer.png`, `03-reader-drawer.png`, plus full-app captures). This is
synthetic Chrome evidence, not WKWebView, OAuth, Keychain or Gmail convergence.

### Earlier pre-rebase headless/synthetic evidence

- Backend worker's post-fix serial `cargo test -p mail-core`: **241 passed**
  (142 library plus 99 integration). The subsequent parent
  `RUST_TEST_THREADS=1 mise run test:core` run failed in the unchanged
  `undo_of_a_still_queued_operation_cancels_in_place_with_zero_provider_calls`:
  expected `Cancelled`, observed `Compensating` (240 passed, one failed).
  Its isolated rerun passed. This is consistent with the baseline's documented
  queued-versus-worker-claim assertion race; serial execution does not eliminate
  it. The failed full run remains a failed gate, not replaced by the rerun.
- `mise run check:contract` and `mise run lint:core`: passed.
- `mise run typecheck`, `mise run test:ui`, `mise run build:web`: passed; UI
  **453 passed / 20 opt-in rendered-browser tests skipped** after the Escape fix.
  The focused App destination suite passed **7/7**.
- `crates/mail-core/tests/provider_destinations.rs`: synthetic provider with real SQLite; an
  uncached thread never enters the inbox/action inventory; page cursors, provider
  errors, offline page/catalog restart recovery, and disconnect isolation.
  Post-review tests also cover foreign credentials, credentialless saved reads,
  bounded overlapping jobs, and admission release after success/error/disconnect.
- `gmail::browsing::tests`: duplicate/oversized catalogs, malformed identities,
  20-page retention bound, unchanged discovery progress and stale-write rejection.
- `gmail::provider::tests::destination_catalog_and_queries_are_bounded_reads`:
  loopback HTTP fixture verifies catalog parsing and exact six destination queries.
  Additional production-seam tests verify foreign-account rejection, missing
  credentials, captured Authorization-token identity, and discarding catalog,
  empty-page and thread results when credentials switch mid-read.
- Component/App/transport tests: whole-catalog search, Show more, hostile literal
  text, no read/archive calls, stale response after Back, provider/local Drafts
  distinction, explicit saved-page mode, bulk-selection clearing and covered-inbox
  inertness. App-level native-mode jsdom tests verify Cmd+K propagation,
  account disappearance, and the reader Escape precedence. Five Escape cases
  (composition, keyCode 229, Ctrl, Meta, Alt) failed before the guard was added;
  they assert no default prevention, reader exit or focus change, followed by
  working ordinary Escape. The browser fake is memory-only, including its saved
  snapshots.

Initial validation found missing local UI dependencies (resolved using the
locked `install:ui` task), a test-only wrong CSS selector, and a test expecting
`%20` instead of valid form-encoded `+` in a query token. Those assertions were
fixed; no failures were relabelled as product success. A lint attempt also caught
formatting while the new test was being added; final formatting/clippy passed.

### Native/browser/provider gates

Latest post-rebase `mise run check:native` passed on this Mac host (compile-check
only). The generated
ACL manifest contains `allow-list-provider-destinations` and
`allow-browse-provider-destination`; both TOML permissions are build-generated.
Latest post-rebase `mise run test:native` passed, **8/8 native unit/bridge tests**,
including fixture
rejection of the two new Gmail-only queries. These are not running-webview IPC tests.
Native build or unit-test success does **not** certify WKWebView, OAuth, Keychain or Gmail.
The 28 opt-in rendered Chrome test cases were not run as suites; the separate
real-Chrome journey above is not a substitute for those suites. There is no
native keyboard or VoiceOver evidence for this new surface. No real mailbox, remote
provider convergence, Label/Move recovery, or external-send behavior was tested.
No OS packages were installed and no credentials or OAuth grants were changed.

### Remaining implementation (not a completed UX-09 claim)

This increment deliberately uses the existing protected utility drawer and a
read-only snapshot reader. It does not yet replace the main list context, add
per-destination palette entries, reuse every conversation/message shortcut, or
render per-message label badges on ordinary cached rows. The local catalog
search is deliberately separate from UX-07 historical search; rebasing preserves
the existing saved criteria/search without extending their grammar or coverage.

The concrete code prerequisites for increment B are missing: `GmailThread`
currently discards general message label IDs, SQLite action facts cover only
INBOX/read, and `MailboxOperationKind` + its recovery/Undo preimages support
only archive/read/star booleans. No durable compound label/move implementation
was added. That is unfinished implementation, **not** proof of an unresolved product
or authority decision and not permission to chain UI setters. BROWSE-11, exact
Move target semantics, interruption/restart/partial recovery for label operations
and preservation of unrelated labels/star remain unvalidated. No Label/Move
control is exposed.
