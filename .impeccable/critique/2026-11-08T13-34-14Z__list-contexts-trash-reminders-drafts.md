---
target: moving Cached Trash, Reminders and Drafts from utility drawers into the main list pane
total_score: n/a (direction note, not a scored run)
p0_count: 0
p1_count: 3
timestamp: 2026-11-08T13-34-14Z
slug: list-contexts-trash-reminders-drafts
---
# Direction note: list contexts instead of drawers

Follows the drawer-panels pass (PR #31, `.impeccable/critique/2026-11-08T11-26-41Z__secondary-drawer-panels.md`). Review feedback: Drafts, Reminders and Cached Trash "should be in the main part of the UI that displays a list of threads". Code-verified, nothing rendered when this was written.

## Rule used
A view belongs in the main pane when its rows are conversations the user triages, opens and returns to. It stays a drawer when it is a log or settings glanced at without leaving one's place. Cached Done and Starred already pass this test: they are list contexts with a rail entry, a `G` chord, a coverage note, Back to the exact row, and a header title shown as an active-tab-style h1 when no tab is active.

## Decisions
1. **Cached Trash becomes a read-only list context (P1).** Already a read-only list of `ConversationSummary` rows; the drawer duplicates the list's row anatomy in a 460px column and is the only list needing special origin handling (`captureListOrigin('trash')`, `trashReader`, re-opening the drawer on Back, ActionNotice suppression `drawer !== 'trash'`). As a context it reuses InboxList rows and the existing context/Back machinery. Needs a read-only list mode: no row actions, no selection, no mailbox shortcuts (the existing tests pin that no `setArchived` / `setRead` / group call happens and no reply control shows).
2. **Reminders becomes a list context (P1).** A pending reminder removes the conversation from Inbox until it is due, so it is a place mail lives (`docs/ux-11-local-reminders.md` calls it a "standalone pending/returned destination"). Pending / Returned / History are views of that list; Reschedule and Cancel are row actions; the time picker is an in-flow block, not a modal. Fixture-only stays fixture-only (`remindersSupported`); no new rail slot (the header glyph and `G H` remain the entries); no new backend behaviour.
3. **Drafts becomes a main-pane list; opening a draft navigates to its source (P1).** Decided by the owner: a reply draft opens the source conversation's reader with the docked reply composer (the existing reply flow); a new-message draft opens the existing inline compose card. This removes the reason the drafts drawer existed (a reply to a conversation that is not open had nowhere to dock). Drafts are not threads (no sender, preview or read state), so they get their own row component with the list's 36px anatomy and keyboard model, not InboxList. PRODUCT.md principle 4 holds: draft focus, selection and message identity stay separate.
4. **Activity, Account and Provider mail stay drawers.** An operations log, settings and a catalog browser: glance-and-return surfaces.

## Shared contract
- Entries unchanged: rail items (`rail-trash`, `rail-drafts`), the Reminders header glyph and `G H`, palette actions. A rail item for the active context gets `aria-current="page"`, not `aria-expanded`.
- Header: no tab is active, so the context h1 (`Cached Trash`, `Reminders`, `Drafts`) shows styled like an active tab; the long names remain the accessible description.
- One Ash coverage line above the list on the 50px content inset (like `done-coverage`), caveat in `title` plus visually hidden text. Exceptions stay inline in Amber Notice or Coral Fault.
- Back and Esc return to the exact prior context and row through the existing history stack. A reader opened from these lists returns to them.
- Honest state unchanged: pending / failed / unknown stay visible; a draft is never lost or made unopenable; read-only guarantees (Trash) stay pinned by tests.
- No dead code: the drawer variants, `CachedTrashPanel`, `RemindersPanel` drawer mount and `DraftsPanel` are removed or reduced once replaced, and the `'trash' | 'reminders' | 'drafts'` entries leave `UtilityDrawer`.

## Risks
- Drafts lifecycle (flush on close, close protection, workspace switching, suspended editor, recovery banners, retry-close) is the most delicate code in the repo (about 1,800 lines of tests). Phase 3 must adapt those tests to the new surface and never weaken an assertion.
- Reply drafts whose source conversation cannot be opened (not cached, load error, retained snapshot, incomplete, header mismatch) must still be recoverable: the draft stays in the list with a visible reason, and no content is dropped.
- Reminders elevates a fixture-only feature: keep the existing "Synthetic fixture only" disclosure visible.

## Order
1. Cached Trash, 2. Reminders, 3. Drafts. One writer per checkout; each phase is committed separately on `impeccable/list-contexts` (stacked on `impeccable/drawer-panels`).
