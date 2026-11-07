<script setup lang="ts">
/**
 * Gmail mailbox shell: compact browsing shell (UX-01), plain-text reader,
 * operation recovery, and explicit account/action capability gates.
 *
 * Account gate: the account status read decides fixture-vs-Gmail. While the status
 * is loading or failed, the UI renders no mailbox content at all — it never falls
 * back silently to fixture mode.
 *
 * Layout contract: a persistent narrow email rail, a 78px split header in the
 * list column (no status line), one central surface that is either the list or the
 * reader (never both), and contact context. Account/Activity/Drafts live in
 * explicit labelled utility disclosures instead of permanent competing columns;
 * the contact pane shows only exact known fields.
 *
 * Keyboard contract (window-level, one handler):
 * - j / ArrowDown, k / ArrowUp: move conversation focus in the list (row focus
 *   follows). Inside the reader only j/k switch conversations; ArrowUp/Down
 *   keep native scrolling there.
 * - Enter: open the focused conversation. Escape: close the active utility or
 *   contact disclosure first, then the reader.
 * - e: archive the focused (or reader-open) conversation when actions are enabled.
 * - Shift+E: restore to Inbox; G then E (within 1000ms): cached Done.
 * - Left from list navigation: destination navigator; pointer Commands opens palette.
 * - Cmd+K opens the palette in native mode only (browser reservations stay native).
 * - c: compose a new local draft in the inline compose card in the central pane (works from list and reader).
 * - Shift+U: explicitly mark the focused/open conversation unread.
 * - z: undo the last accepted conversation action (single level, 10 s window;
 *   the backend's eligibility decision is authoritative). Cmd/Ctrl+Z is left
 *   to native text editing.
 * - Ignored with Ctrl/Meta/Alt held, during IME composition, inside text fields, and
 *   Enter/e are ignored when a button owns the key (it activates itself).
 * - While a visible draft editor exists, every mailbox shortcut is suppressed;
 *   a suspended editor behind another disclosure must not own keys. While a
 *   utility/contact disclosure is open, Escape closes it and mailbox shortcuts
 *   underneath are suppressed. Draft text has no submit/send path and is
 *   rendered only as ordinary text.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CachedTrashPanel from './components/CachedTrashPanel.vue';
import { emptyCachedTrash } from './lib/cached-trash';
import ActionOverlay from './components/ActionOverlay.vue';
import RemindersPanel from './components/RemindersPanel.vue';
import ActionNotice, { type GroupNoticeView } from './components/ActionNotice.vue';
import SelectionBar from './components/SelectionBar.vue';
import HeaderGlyph from './components/HeaderGlyph.vue';
import PaneGlyph from './components/PaneGlyph.vue';
import { browsingActions, actionLabel, type BrowsingActionId } from './lib/browsing-actions';
import InboxList from './components/InboxList.vue';
import SplitEditor from './components/SplitEditor.vue';
import { splitBadge } from './lib/saved-split';
import type { SavedSplit } from './lib/ipc/client';
import ReaderView from './components/ReaderView.vue';
import AttachmentChooser from './components/AttachmentChooser.vue';
import ActivityPanel from './components/ActivityPanel.vue';
import AccountPanel from './components/AccountPanel.vue';
import DraftsPanel from './components/DraftsPanel.vue';
import ReplyComposer from './components/ReplyComposer.vue';
import ComposeCard from './components/ComposeCard.vue';
import ProviderDestinations from './components/ProviderDestinations.vue';
import ContactPane from './components/ContactPane.vue';
import FullDate from './components/FullDate.vue';
import { BROWSER_PREVIEW_DISCLOSURE } from './lib/ipc/browser-fake';
import type { ClientMode } from './lib/ipc';
import type { ConversationRef, DraftRef, DraftSource, MailClient } from './lib/ipc/client';
import { sameConversation, useMailbox, type BrowseContext, type DoneBoundary, type SearchVisit, type LastActionId } from './composables/useMailbox';
import { useDrafts } from './composables/useDrafts';

const props = withDefaults(defineProps<{
  client: MailClient;
  mode: ClientMode;
  /** Only the visible in-app workspace may own global keys or focus. */
  active?: boolean;
  switchAccountLabel?: string;
}>(), { active: true });
const emit = defineEmits<{ switchAccount: []; workspaceTitle: [title: string] }>();
const workspaceActive = computed(() => props.active !== false);

/** Contact context breakpoint (supervisor-approved strict value). */
const CONTACT_BREAKPOINT_PX = 1000;

type UtilityDrawer = 'account' | 'activity' | 'drafts' | 'destinations' | 'reminders' | 'trash';
const trashState = ref(emptyCachedTrash());
type ContactContext = 'focused' | 'open';
interface ContactInfo { displayName: string | null; mailbox: string }
/** Visible-row anchor for the reader round trip. */
interface ListAnchor { ref: ConversationRef; offsetTop: number; scrollTop: number }
/**
 * Reader origin, captured ONLY at the initial list-to-reader entry. J/K inside
 * the reader and Activity opens while the reader is already open never
 * recapture from an unmounted list.
 */
interface ReaderOrigin {
  surface: BrowseContext | 'activity' | 'reminders' | 'trash';
  /** Original entry focus reference; Back restores it (with fallbacks). */
  focusedRef: ConversationRef | null;
  /** Entry-time Inbox ordering, used to resolve a removed cursor. */
  ordering: ConversationRef[];
  anchor: ListAnchor | null;
}

const mailbox = useMailbox(props.client);
const inboxList = ref<InstanceType<typeof InboxList> | null>(null);
const editingSplit = ref(false);
const splitEditor = ref<InstanceType<typeof SplitEditor> | null>(null);
const contextTitle = computed(() => mailbox.context.value === 'search' ? 'Search' : mailbox.context.value === 'starred' ? 'Cached Starred' : mailbox.context.value === 'done' ? 'Cached Done' : mailbox.context.value === 'saved' ? mailbox.savedSplit.value?.name ?? 'Saved split' : 'Inbox');
const savedTabVisible = computed(() => mailbox.savedSplit.value?.enabled && !mailbox.splitError.value && (!mailbox.savedSplit.value.hideWhenEmpty || mailbox.savedTotal.value !== 0));
async function closeSplitEditor(restoreFocus = true): Promise<void> {
  editingSplit.value = false;
  await nextTick();
  if (restoreFocus && !editingSplit.value && !overlay.value && !readerOpen.value && !drawer.value && !contactDisclosure.value) {
    paletteButton.value?.focus();
  }
}
async function saveSplit(split: SavedSplit): Promise<void> {
  const editor = splitEditor.value;
  if (mailbox.splitBusy.value) return;
  if (await mailbox.saveSplit(split)) {
    // A pending save must not dismiss a newly opened editor or focus a view
    // the user has since left (including a palette above the editor).
    if (!editor || editor !== splitEditor.value) return;
    const active = document.activeElement;
    await closeSplitEditor(active === document.body || editor.$el.contains(active));
  }
}
const emptyState = ref<HTMLElement | null>(null);
const actionNoticeComponent = ref<InstanceType<typeof ActionNotice> | null>(null);

// ---------------------------------------------------------------------------
// UX-05 selection: one-target policy, bulk dispatch, escape precedence
// ---------------------------------------------------------------------------

const selectedCount = computed(() => mailbox.selectedRefs.value.length);

/**
 * One-target policy (§3.3): shared toolbar/palette/shortcut dispatch resolves
 * the nonempty selection FIRST (even in the reader, even for one row); explicit
 * inline row actions bypass this and resolve exactly one row.
 */
function bulkMembers(): ConversationRef[] | null {
  if (selectedCount.value === 0) return null;
  if (!accountReady.value || mailbox.bulkUnresolved.value) return null;
  // A pending single mutation owns the dispatch boundary (P1 fence): a group
  // dispatched now would bump `commandToken`, the single's finally would stop
  // clearing its in-flight ref, and single actions could stay fenced forever.
  if (mailbox.commandInFlight.value) return null;
  if (mailbox.listState.value === 'error') return null;
  const members = mailbox.selectionInLoadedOrder();
  return members.length > 0 ? members : null;
}

function bulkActionAvailable(id: BrowsingActionId): boolean {
  if (!bulkMembers()) return false;
  if (id === 'archive') return mailbox.context.value !== 'done' && mailboxActionsEnabled.value;
  if (id === 'unarchive') return (mailbox.context.value === 'done' || mailbox.context.value === 'search') && mailboxActionsEnabled.value;
  if (id === 'read' || id === 'unread' || id === 'star' || id === 'unstar') return gmailActionsEnabled.value;
  return false;
}

function toggleRowSelection(target: ConversationRef): void {
  if (!accountReady.value) return;
  // Cmd-click moves focus and the anchor; X keeps focus on the toggled row.
  if (!sameConversation(target, mailbox.focusedRef.value)) mailbox.focusConversation(target);
  mailbox.toggleSelected(target);
}

function rangeSelectRow(target: ConversationRef): void {
  if (!accountReady.value) return;
  const preFocus = mailbox.focusedRef.value ? { ...mailbox.focusedRef.value } : null;
  mailbox.focusConversation(target);
  mailbox.extendSelectionTo(target, preFocus);
}

function bulkArchiveSelection(): Promise<void> {
  const members = bulkMembers();
  if (!members) return Promise.resolve();
  // The group path never invokes the single-reader archive-and-advance flow.
  return mailbox.setArchivedGroup(members, true).then(() => undefined);
}

function bulkRestoreSelection(): Promise<void> {
  const members = bulkMembers();
  if (!members) return Promise.resolve();
  return mailbox.setArchivedGroup(members, false).then(() => undefined);
}

function bulkSetReadSelection(read: boolean): Promise<void> {
  const members = bulkMembers();
  if (!members) return Promise.resolve();
  return mailbox.setReadGroup(members, read).then(() => undefined);
}

/** Escape-level selection clearing; navigation state is untouched. */
function clearSelectionAndReport(): void {
  mailbox.clearSelection();
}

const selectionBarRef = ref<InstanceType<typeof SelectionBar> | null>(null);

/**
 * Clear from the selection bar: removing the bar removes its focused button,
 * so focus is handed to a surviving surface (focused row or empty state)
 * without navigating (§6).
 */
async function clearSelectionFromBar(): Promise<void> {
  const barEl = selectionBarRef.value?.$el as HTMLElement | undefined;
  const active = document.activeElement;
  const focusWasInBar = !!barEl && active instanceof Node && barEl.contains(active);
  clearSelectionAndReport();
  if (!focusWasInBar) return;
  await nextTick();
  if (mailbox.listState.value === 'ready' && mailbox.conversations.value.length > 0) {
    await focusFocusedRow(true);
  } else {
    emptyState.value?.focus();
  }
}

// ---------------------------------------------------------------------------
// Action notice (UX-04): single-slot undo notification
// ---------------------------------------------------------------------------

/** Advisory wall clock for the Undo hint; the backend owns eligibility. */
const nowMs = ref(Date.now());
let nowTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Single-slot notice state, single-or-group identity (UX-04/UX-05). Status text
 * derives from the matching Activity row / authoritative group status on every
 * refresh; undo windows come only from refreshed authoritative state. The
 * backend stays the authority: an `expired` rejection refreshes and then closes
 * the slot window below. After a successful undo the slot reports the outcome.
 */
const actionNotice = computed(() => {
  const groupSlot = mailbox.lastGroup.value;
  if (groupSlot) {
    const status = groupSlot.status;
    const counts = { pending: 0, confirmed: 0, failed: 0, rejected: 0, unknown: 0, cancelled: 0 };
    if (status) {
      for (const member of status.members) {
        if (member.status === 'rejected') counts.rejected += 1;
        else if (member.status === 'confirmed') counts.confirmed += 1;
        else if (member.status === 'failed') counts.failed += 1;
        else if (member.status === 'outcome_unknown') counts.unknown += 1;
        else if (member.status === 'cancelled') counts.cancelled += 1;
        else counts.pending += 1; // queued | applying
      }
    }
    let undoneView: GroupNoticeView['undone'] = null;
    const undoMembers = status?.undoReceipt?.members ?? groupSlot.undone?.members;
    if (undoMembers) {
      const skipReasons: Record<string, number> = {};
      let cancelled = 0;
      let compensating = 0;
      let skipped = 0;
      for (const member of undoMembers) {
        if (member.decision.kind === 'cancelled') cancelled += 1;
        else if (member.decision.kind === 'compensating') compensating += 1;
        else {
          skipped += 1;
          skipReasons[member.decision.reason] = (skipReasons[member.decision.reason] ?? 0) + 1;
        }
      }
      // CURRENT compensation outcomes: prefer the backend's persisted undo
      // record (also correct after restart / lost undo response); fall back to
      // the refreshed activity rows for compensations it lists. Compensation
      // status is tracked separately from the original execution statuses.
      const outcomes = { confirmed: 0, failed: 0, unknown: 0, pending: 0 };
      const record = groupSlot.status?.undoReceipt;
      if (record) {
        for (const member of record.members) {
          for (const compensation of member.compensations) {
            if (compensation.status === 'confirmed') outcomes.confirmed += 1;
            else if (compensation.status === 'failed') outcomes.failed += 1;
            else if (compensation.status === 'outcome_unknown') outcomes.unknown += 1;
            else outcomes.pending += 1;
          }
        }
      } else {
        for (const member of groupSlot.undone?.members ?? []) {
          for (const operationId of member.operationIds) {
            const row = mailbox.activity.value.find((item) => item.id === operationId);
            if (!row) outcomes.pending += 1;
            else if (row.status === 'confirmed') outcomes.confirmed += 1;
            else if (row.status === 'failed') outcomes.failed += 1;
            else if (row.status === 'outcome_unknown') outcomes.unknown += 1;
            else outcomes.pending += 1;
          }
        }
      }
      undoneView = { cancelled, compensating, skipped, skipReasons, compensationOutcomes: outcomes };
    }
    const group: GroupNoticeView = {
      count: groupSlot.members.length,
      counts,
      acceptanceUnknown: groupSlot.state === 'acceptance-unknown',
      statusKnown: status !== null,
      statusError: groupSlot.statusError,
      undoableUntil: status?.undo.undoableUntil ?? null,
      hadWindow: groupSlot.hadWindow,
      undone: undoneView,
    };
    const groupActionId: LastActionId = groupSlot.kind === 'star' ? (groupSlot.requestedStarred ? 'star' : 'unstar') : groupSlot.kind === 'read'
      ? (groupSlot.requestedRead ? 'read' : 'unread')
      : (groupSlot.requestedArchived ? 'archive' : 'unarchive');
    return {
      label: groupSlot.kind === 'star' ? (groupSlot.requestedStarred ? 'Star' : 'Unstar') : groupSlot.kind === 'read' ? (groupSlot.requestedRead ? 'Mark read' : 'Mark unread') : (groupSlot.requestedArchived ? 'Mark done' : 'Mark not done'),
      actionId: groupActionId,
      subject: null,
      operation: null,
      undoableUntil: null,
      hadWindow: false,
      undone: null,
      group,
    };
  }
  const slot = mailbox.lastAction.value;
  if (!slot) return null;
  const operation = mailbox.activity.value.find((item) => item.id === slot.receipt.operationId) ?? null;
  const label = browsingActions.find((action) => action.id === slot.actionId)?.label ?? slot.actionId;
  return {
    label,
    actionId: slot.actionId,
    subject: slot.subject,
    operation,
    // Post-undo the window is closed outright: a stale activity row can still
    // carry undoableUntil, and the palette/key must never send a second undo.
    undoableUntil: slot.undone ? null : operation ? operation.undoableUntil ?? null : slot.undoableUntil,
    hadWindow: slot.hadWindow,
    undone: slot.undone
      ? {
          outcome: slot.undone.outcome,
          compensations: mailbox.activity.value.filter((item) => slot.undone?.operationIds.includes(item.id) ?? false),
        }
      : null,
  };
});

/** Palette/key availability share this window check; expiry is advisory only.
 *  An in-flight undo owns the slot: a second dispatch (key repeat, double-tap,
 *  button+key) must never race it into a false `already_undone` failure. */
const undoWindowOpen = computed(() => {
  const notice = actionNotice.value;
  if (!notice || notice.undone) return false;
  const until = notice.group ? notice.group.undoableUntil : notice.undoableUntil;
  return until !== null && Date.parse(until) > nowMs.value;
});

/** Undo succeeded: re-focus the restored row only when it is in the current context. */
async function undoFromNotice(): Promise<void> {
  const active = document.activeElement;
  const noticeEl = actionNoticeComponent.value?.$el as Node | undefined;
  const focusWasInNotice = !!active && active instanceof Node && !!noticeEl && noticeEl.contains(active);
  // Group slot: the group's single partial Undo attempt.
  if (mailbox.lastGroup.value) {
    await mailbox.undoGroupAction();
    return;
  }
  const target = mailbox.lastAction.value?.target ?? null;
  const receipt = await mailbox.undoLastAction();
  if (receipt && target && !readerOpen.value && mailbox.listState.value === 'ready'
    && mailbox.conversations.value.some((row) => sameConversation(row.ref, target))) {
    mailbox.focusConversation(target);
    await focusFocusedRow(true);
    return;
  }
  // The clicked Undo button is removed with the successful slot; if the restored
  // row cannot take focus, hand focus to the reader (or the list) instead of
  // dropping it to <body>.
  if (!receipt || !focusWasInNotice || !workspaceActive.value) return;
  if (readerOpen.value) (readerView.value?.$el as HTMLElement | undefined)?.focus({ preventScroll: true });
  else if (mailbox.listState.value === 'ready') await focusFocusedRow(true);
}

/** Notice group action: 'Check acceptance' recovers the ORIGINAL request; the
 * Undo button runs the group's single partial Undo attempt. */
function onNoticeGroupAction(): void {
  if (mailbox.lastGroup.value?.state === 'acceptance-unknown') void mailbox.recoverGroupAcceptance();
  else void undoFromNotice();
}

const expandedGroupRequestId = ref<string | null>(null);

async function openActivityGroup(requestId: string): Promise<void> {
  if (expandedGroupRequestId.value === requestId && mailbox.groupDetail.value) {
    expandedGroupRequestId.value = null;
    return;
  }
  expandedGroupRequestId.value = requestId;
  await mailbox.openGroupDetail(requestId);
}

const readerOpen = computed(() => mailbox.openRef.value !== null);
watch(readerOpen, (open) => { if (open) editingSplit.value = false; });
const gmailMode = computed(() => mailbox.isGmail.value);
const mailboxActionsEnabled = computed(() => !gmailMode.value || mailbox.accountStatus.value?.mutationAccess === 'enabled');
const gmailActionsEnabled = computed(() => gmailMode.value && mailboxActionsEnabled.value);
const accountReady = computed(() => mailbox.accountState.value === 'ready');
const accountStatus = computed(() => mailbox.accountStatus.value);
const accountId = computed(() => accountStatus.value?.account?.accountId ?? null);
const drafts = useDrafts(props.client, accountId, props.mode);

/**
 * Inline reply composer: a reply to the conversation the reader is currently
 * showing docks the draft editor at the bottom of the reader pane (the reader
 * stays open) instead of routing to the drafts drawer.
 */
const replyComposerOpen = ref(false);
/** Latest message of the open conversation (the fixed reply source). */
const replyLatestMessage = computed(() => {
  const conversation = mailbox.conversation.value;
  if (!readerOpen.value || !conversation || !sameConversation(conversation.ref, mailbox.openRef.value)) return null;
  return conversation.messages.at(-1) ?? null;
});
/** "Draft to {sender}": display name when known, otherwise the mailbox. */
const replyRecipientLabel = computed(() => {
  const latest = replyLatestMessage.value;
  return latest ? (latest.from.displayName ?? latest.from.mailbox) : '';
});
/**
 * Read-only quoted snippet of the latest message plain-text body (~200 chars).
 * Display-only: it is never inserted into bodyText, which stays blank on
 * prepare (frozen slice-04 contract).
 */
const quotedSnippet = computed(() => {
  const body = replyLatestMessage.value?.bodyText ?? '';
  return body.length > 200 ? `${body.slice(0, 200)}…` : body;
});
/**
 * Inline compose card: a new-message editor renders as an in-flow card in the
 * central pane (replacing the list) — or docked at the bottom of the reader
 * pane while a reader is open — instead of a modal overlay or the drafts
 * drawer. No backdrop and no dimming: the rail, header and contact pane stay
 * visible and interactive while composing.
 */
const composeCardOpen = ref(false);

// Reuse the exact draft transition protocol; never hide an unacknowledged buffer.
defineExpose({ prepareWorkspaceSwitch: () => drafts.flushAndClose() });
watch(() => [mailbox.context.value, mailbox.listState.value, mailbox.conversations.value.length, accountStatus.value?.account?.emailAddress], () => {
  const view = contextTitle.value;
  const count = mailbox.listState.value === 'ready' ? ` — ${mailbox.conversations.value.length} loaded` : '';
  emit('workspaceTitle', `${view}${count} — ${accountStatus.value?.account?.emailAddress ?? 'Loading account'}`);
}, { immediate: true });
watch(workspaceActive, () => { cancelGo(); });

// ---------------------------------------------------------------------------
// Utility disclosures (Account / Activity / Drafts)
// ---------------------------------------------------------------------------

const drawer = ref<UtilityDrawer | null>(null);
watch(drawer, (next) => { if (next) editingSplit.value = false; });

// Split header (DESIGN.md "Split Tabs"). The tabs render only for a ready
// account's list; the context heading is shown on screen only when no rendered
// tab is active, so Cached Done / Starred / Search / the reader stay named.
const splitNavShown = computed(() => accountReady.value && !!accountId.value && !readerOpen.value && !drawer.value);
const activeTabShown = computed(() => splitNavShown.value
  && (mailbox.context.value === 'inbox' || (mailbox.context.value === 'saved' && !!savedTabVisible.value)));
const SPLIT_COVERAGE = 'Local Inbox cache only — counts are exact for cached conversations, not mailbox-wide totals. Split membership uses the latest message’s sender.';
const splitCoverageShown = computed(() => splitNavShown.value && gmailMode.value
  && (mailbox.context.value === 'inbox' || mailbox.context.value === 'saved'));
const starredFilterShown = computed(() => gmailMode.value && !readerOpen.value && mailbox.context.value !== 'starred');
/** Per-workspace DOM id prefix: two fixture workspaces mount two Apps at once. */
const domIdPrefix = computed(() => props.switchAccountLabel ? accountId.value ?? '' : '');
const drawerEl = ref<HTMLElement | null>(null);
const drawerToggles = new Map<UtilityDrawer, HTMLElement>();

function setToggleRef(name: UtilityDrawer): (el: Element | import('vue').ComponentPublicInstance | null) => void {
  return (el) => {
    if (el instanceof HTMLElement) drawerToggles.set(name, el);
    else drawerToggles.delete(name);
  };
}

const drawerTitles: Record<UtilityDrawer, string> = {
  account: 'Account',
  destinations: 'Provider mail — read only',
  activity: 'Operation activity',
  drafts: 'Local drafts',
  reminders: 'Desktop-local reminders',
  trash: 'Cached Trash — read only',
};

/**
 * Leave the active drafts editor through its protected lifecycle before the
 * drawer unmounts. Returns false when closure failed and the drawer must stay
 * visible with its recovery/error controls rather than hiding an editor that
 * would otherwise silently own all mailbox shortcuts.
 */
async function releaseDraftsDrawer(): Promise<boolean> {
  // The active editor is surfaced either in the drafts drawer, docked inline at
  // the bottom of the reader pane (reply composer or compose card), or as the
  // inline compose card in the central pane; every surface hides only through
  // the same protected flush.
  if ((drawer.value !== 'drafts' && !replyComposerOpen.value && !composeCardOpen.value) || !drafts.activeRef.value) return true;
  return drafts.flushAndClose();
}

async function openDrawer(name: UtilityDrawer, entry: 'drawer' | 'toggle' = 'drawer'): Promise<void> {
  // Switching away from the drafts surface must release the editor first:
  // without this guard, a user can move to another utility while the editor
  // silently owns shortcuts, and recovery controls stay hidden behind it.
  // Another drawer would also cover the reader pane and hide the inline reply
  // composer or docked compose card, so it releases the editor through the
  // same protected flush.
  if (name !== 'drafts' && (drawer.value === 'drafts' || replyComposerOpen.value || composeCardOpen.value)) {
    if (!(await releaseDraftsDrawer())) return;
  }
  // Opening the drafts drawer itself re-docks an inline reply composer or
  // compose card there: the buffer stays visible on the new surface, so
  // nothing is hidden.
  if (name === 'drafts') {
    replyComposerOpen.value = false;
    composeCardOpen.value = false;
  }
  mailbox.invalidateSearchIntent();
  // Disclosures are mutually exclusive: opening a utility surface dismisses
  // the contact disclosure so both fixed regions never coexist.
  contactDisclosure.value = false;
  if (name === 'destinations' || name === 'trash') mailbox.clearSelection();
  drawer.value = name;
  await nextTick();
  if (!workspaceActive.value) return;
  if (entry === 'drawer') drawerEl.value?.focus();
  else drawerToggles.get(name)?.focus();
}

const reminderTarget = ref<ConversationRef | null>(null);
const reminderDestination = ref<'pending' | 'returned' | 'history'>('pending');
const remindersSupported = computed(() => !!props.client.reminders && accountStatus.value?.mode === 'fixture');
async function openReminders(picker: boolean) {
  if (!remindersSupported.value || (picker && (selectedCount.value > 0 || mailbox.commandInFlight.value || mailbox.bulkUnresolved.value))) return;
  const target = actionTarget();
  if (picker && !target) return;
  reminderTarget.value = picker && target ? { ...target } : null;
  if (picker) reminderDestination.value = 'pending';
  await openDrawer('reminders');
}
function openReminderConversation(target: ConversationRef): Promise<void> {
  return openFromUtility(target, 'reminders');
}

async function closeDrawer(): Promise<void> {
  const closing = drawer.value;
  if (closing === 'drafts' && !(await releaseDraftsDrawer())) return; // closure failed; keep drawer visible
  drawer.value = null;
  await nextTick();
  if (workspaceActive.value && closing) drawerToggles.get(closing)?.focus();
}

// A suspended (hidden) draft editor must never survive into the visible inbox:
// whenever no drawer is open and an editor is still active, bring its surface
// back so keyboard ownership and the visible panel agree. The inline compose
// card is already a visible surface, so it is not re-docked into the drawer.
watch(drawer, (value) => {
  if (value === null && drafts.isVisible.value && !readerOpen.value && !composeCardOpen.value) void openDrawer('drafts');
});

function toggleDrawer(name: UtilityDrawer): void {
  if (drawer.value === name) void closeDrawer();
  else void openDrawer(name);
}

// A newly active editor routes to a visible surface instead of a hidden pane.
// A reply to the conversation the reader is currently showing docks the
// composer at the bottom of the reader pane (the reader stays open); a reply to
// any other conversation — and every other source — keeps the drafts drawer.
/**
 * Single routing point for an active draft editor (one editor, one visible
 * surface; the buffer is shared, never duplicated):
 * - reply + reader open on the source conversation → docked reply composer;
 * - new_message + central pane free (no drawer, no narrow contact disclosure)
 *   → inline compose card in the central pane (or docked at the reader bottom
 *   when a reader is open);
 * - anything else (reply off-source, drawer already open, central covered) →
 *   the drafts drawer. The drawer is never opened while another drawer or the
 *   contact disclosure covers the central pane, so no editor surface is ever
 *   mounted inert behind a disclosure.
 */
function routeDraftSurface(visible: boolean): void {
  const source = drafts.activeSource.value;
  if (!visible) {
    replyComposerOpen.value = false;
    composeCardOpen.value = false;
    return;
  }
  if (source?.kind === 'reply'
    && readerOpen.value
    && mailbox.conversation.value
    && sameConversation(mailbox.conversation.value.ref, source.conversation)) {
    replyComposerOpen.value = true;
    composeCardOpen.value = false;
    // Docking in the reader replaces the drafts drawer (direct assignment: the
    // editor stays active, so closeDrawer's protected release must not run).
    if (drawer.value === 'drafts') drawer.value = null;
    return;
  }
  const centralFree = drawer.value === null && (wideViewport.value || !contactDisclosure.value);
  if (source?.kind === 'new_message' && centralFree) {
    composeCardOpen.value = true;
    replyComposerOpen.value = false;
    return;
  }
  composeCardOpen.value = false;
  replyComposerOpen.value = false;
  if (drawer.value !== 'drafts') void openDrawer('drafts');
}
watch(drafts.isVisible, routeDraftSurface);
watch(drawer, (value) => {
  if (value === 'drafts') composeCardOpen.value = false;
});

// If the reader moves off the reply source conversation (e.g. a contact-pane
// recent row), the docked reply composer must not keep showing the wrong
// "Draft to …"/quote: re-dock the editor into the drafts drawer instead.
watch(() => mailbox.openRef.value, (ref) => {
  const source = drafts.activeSource.value;
  if (replyComposerOpen.value && source?.kind === 'reply' && ref && !sameConversation(ref, source.conversation)) {
    replyComposerOpen.value = false;
    if (drawer.value !== 'drafts') void openDrawer('drafts');
  }
});

/** Close the inline compose card through the protected draft lifecycle; a failed flush keeps the card open. */
async function closeComposeCard(): Promise<void> {
  await drafts.flushAndClose();
}

// If the reader disappears while the inline composer is docked (background list
// events close it directly), the active editor must stay visible: re-dock it in
// the drafts drawer instead of hiding an unacknowledged buffer. A docked
// compose card needs no re-docking: its mount follows readerOpen, so it moves
// to the central pane on its own.
watch(readerOpen, (open) => {
  if (!open && replyComposerOpen.value && drafts.isVisible.value) {
    replyComposerOpen.value = false;
    if (drawer.value !== 'drafts') void openDrawer('drafts');
  }
});

// Local drafts are account-scoped: with no account there is no drafts surface.
watch(accountId, (id) => {
  trashState.value = emptyCachedTrash();
  if (drawer.value === 'trash') drawer.value = null;
  if (id === null && drawer.value === 'drafts') drawer.value = null;
});

// ---------------------------------------------------------------------------
// Contact context: pane at >=1000 CSS px, disclosure strictly below
// ---------------------------------------------------------------------------

const contactDisclosure = ref(false);
const contactPanelEl = ref<HTMLElement | null>(null);
const contactDisclosureButton = ref<HTMLElement | null>(null);
/** Wide contact surface: focus target when the narrow disclosure is removed. */
const contactColumnEl = ref<HTMLElement | null>(null);

const wideQuery = typeof window.matchMedia === 'function'
  ? window.matchMedia(`(min-width: ${CONTACT_BREAKPOINT_PX}px)`)
  : null;
const wideViewport = ref(wideQuery ? wideQuery.matches : true);

/**
 * True while a fixed utility drawer or a narrow Contact disclosure overlays the
 * central surface. The covered central surface is made `inert` so covered row
 * and reader actions can neither be focused (native Shift+Tab/Tab traversal)
 * nor user-activated (native Enter/click) while hidden behind the overlay; the
 * global shortcut guard cannot stop native button activation. The rail and the
 * active disclosure itself stay interactive. Reactivity restores normal central
 * interaction as soon as the disclosure is dismissed. The inline compose card
 * is an in-flow block inside the central surface, not a cover: while it shows,
 * the central surface and the contact pane stay interactive (non-inert).
 */
const centralCovered = computed(() => !!overlay.value || !!attachmentConversation.value || !!drawer.value || (!wideViewport.value && contactDisclosure.value));

function onViewportChange(event: MediaQueryListEvent): void {
  const wasWide = wideViewport.value;
  // Capture focus ownership BEFORE the template branches change: the wide
  // contact column and the narrow disclosure panel/trigger are all removed by
  // v-if as the reactive state updates, so ownership must be recorded first.
  const active = document.activeElement;
  const activeIsInWideContact = wasWide
    && active instanceof Node
    && (contactColumnEl.value?.contains(active) ?? false);
  const focusInNarrowContact = !wasWide && (
    (contactPanelEl.value instanceof HTMLElement && contactPanelEl.value.contains(active))
    || active === contactDisclosureButton.value
  );
  wideViewport.value = event.matches;
  if (wasWide && !event.matches) {
    // The pane becomes hidden content; keep keyboard focus out of it.
    contactDisclosure.value = false;
    void nextTick().then(() => {
      // Hand focus to the surviving narrow disclosure control only when the
      // wide contact surface owned focus; no focus theft when focus was
      // elsewhere (e.g. the list or a row).
      if (workspaceActive.value && activeIsInWideContact) contactDisclosureButton.value?.focus();
    });
  } else if (!wasWide && event.matches) {
    contactDisclosure.value = false;
    void nextTick().then(() => {
      if (workspaceActive.value && focusInNarrowContact) {
        // The disclosure and trigger no longer exist; hand focus to the
        // surviving wide contact surface instead of dropping it to the body.
        contactColumnEl.value?.focus();
      }
    });
  }
}

async function toggleContactDisclosure(): Promise<void> {
  if (wideViewport.value) return;
  // Leaving an active drafts editor must go through its protected lifecycle
  // rather than unmounting the panel silently; on failure it stays visible.
  if ((drawer.value === 'drafts' || replyComposerOpen.value || composeCardOpen.value) && !contactDisclosure.value) {
    if (!(await releaseDraftsDrawer())) return;
  }
  // Disclosures are mutually exclusive: the contact disclosure replaces any
  // open utility drawer so the visible panel and keyboard owner agree.
  drawer.value = null;
  contactDisclosure.value = !contactDisclosure.value;
  void nextTick().then(() => {
    if (!workspaceActive.value) return;
    if (contactDisclosure.value) contactPanelEl.value?.focus();
    else contactDisclosureButton.value?.focus();
  });
}

async function closeContactDisclosure(): Promise<void> {
  contactDisclosure.value = false;
  await nextTick();
  if (workspaceActive.value) contactDisclosureButton.value?.focus();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  window.addEventListener('blur', cancelGo);
  window.addEventListener('compositionstart', cancelGo);
  window.addEventListener('focusin', cancelGo);
  wideQuery?.addEventListener('change', onViewportChange);
  nowTimer = setInterval(() => { nowMs.value = Date.now(); }, 250);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
  window.removeEventListener('blur', cancelGo);
  window.removeEventListener('compositionstart', cancelGo);
  window.removeEventListener('focusin', cancelGo);
  cancelGo();
  if (nowTimer !== null) clearInterval(nowTimer);
  nowTimer = null;
  wideQuery?.removeEventListener('change', onViewportChange);
});

// ---------------------------------------------------------------------------
// Contact context data: only exact known fields, only the matching surface
// ---------------------------------------------------------------------------

const listContact = computed<ContactInfo | null>(() => {
  // A non-ready list never supplies stale contact targets.
  if (mailbox.listState.value !== 'ready') return null;
  const primary = mailbox.focusedSummary.value?.primaryCorrespondent;
  return primary ? { displayName: primary.displayName, mailbox: primary.mailbox } : null;
});

const readerContact = computed<ContactInfo | null>(() => {
  const conversation = mailbox.conversation.value;
  if (!conversation || mailbox.detailState.value !== 'ready') return null;
  if (!sameConversation(conversation.ref, mailbox.openRef.value)) return null;
  // Baseline: the sender of the focused (active) message; without one, the
  // latest displayed message. Hover/focus overrides are applied in `contact`.
  const activeId = readerActiveMessageId.value;
  const active = activeId ? conversation.messages.find((message) => message.id === activeId) ?? null : null;
  const message = active ?? conversation.messages[conversation.messages.length - 1] ?? null;
  return message ? { displayName: message.from.displayName, mailbox: message.from.mailbox } : null;
});

/** The list row of the open reference: the list's own, truthful identity data. */
const openRow = computed(() => {
  const opened = mailbox.openRef.value;
  return opened ? mailbox.conversations.value.find((row) => sameConversation(row.ref, opened)) ?? null : null;
});
const readerLoading = computed(() => readerOpen.value && mailbox.detailState.value === 'loading');
/** What the reader may say about a still-loading target, from the list row only. */
const readerLoadingIdentity = computed(() => {
  const row = readerLoading.value ? openRow.value : null;
  if (!row) return null;
  const primary = row.primaryCorrespondent;
  return {
    subject: row.subject,
    sender: primary ? primary.displayName ?? primary.mailbox : null,
    at: row.lastMessageAt ?? null,
  };
});

const contact = computed<ContactInfo | null>(() => {
  if (!readerOpen.value) return listContact.value;
  // While the target loads, the list row's sender is the only truthful source.
  if (readerLoading.value) {
    const primary = mailbox.listState.value === 'ready' ? openRow.value?.primaryCorrespondent : undefined;
    return primary ? { displayName: primary.displayName, mailbox: primary.mailbox } : null;
  }
  // A participant override applies only while the referenced message still
  // exists on the open conversation: late blur/leave events, background
  // removals, and account changes cannot leak a stale contact.
  const override = contactOverride.value;
  if (override
    && sameConversation(override.ref, mailbox.openRef.value)
    && mailbox.conversation.value?.messages.some((message) => message.id === override.messageId)
  ) {
    return { displayName: override.displayName, mailbox: override.mailbox };
  }
  return readerContact.value;
});
const contactContext = computed<ContactContext>(() => (readerOpen.value ? 'open' : 'focused'));

// Reply-target resolution for an active reply draft editor, shared by the
// drafts-drawer composer label and the contact pane's compose context. While
// the reader is open on the source conversation, the latest message's sender
// is the exact known target; otherwise the draft's current raw To text is the
// only honest fallback. No target is guessed from participants or names.
const composeTarget = computed<ContactInfo | null>(() => {
  const source = drafts.activeSource.value;
  if (!source || source.kind !== 'reply') return null;
  const open = mailbox.conversation.value;
  if (readerOpen.value && open && sameConversation(open.ref, source.conversation)) {
    const latest = open.messages[open.messages.length - 1];
    if (latest) return { displayName: latest.from.displayName, mailbox: latest.from.mailbox };
  }
  const to = drafts.content.value.to;
  return to.trim() ? { displayName: null, mailbox: to } : null;
});
const drawerRecipientLabel = computed<string | null>(() => {
  const target = composeTarget.value;
  return target ? (target.displayName ?? target.mailbox) : null;
});

// ---------------------------------------------------------------------------
// Reader origin, focus, and scroll restoration
// ---------------------------------------------------------------------------

// Context history is account-scoped and stores references/geometry, never indices.
interface ContextEntry extends ReaderOrigin { starredOnly: boolean; search?: SearchVisit; context: BrowseContext; accountId: string; loadedDonePages: number; doneBoundary: DoneBoundary | null }
const searchVisible = ref(false);
const searchDraft = ref('');
const searchInput = ref<HTMLInputElement | null>(null);
const cachedSearch = ref(false);
async function revealSearch(): Promise<void> {
  if (!accountReady.value || drawer.value || contactDisclosure.value || replyComposerOpen.value || composeCardOpen.value) return;
  searchVisible.value = true;
  searchDraft.value = mailbox.searchQuery.value;
  await nextTick();
  searchInput.value?.focus();
}
async function submitSearch(query = searchDraft.value): Promise<void> {
  if (!accountId.value) return;
  // Entering search closes the reader (and with it the docked inline reply
  // composer or compose card), so the active editor flushes through the
  // protected path first; a failed close keeps the reader and composer visible.
  if ((drawer.value === 'drafts' || replyComposerOpen.value || composeCardOpen.value) && !(await releaseDraftsDrawer())) return;
  if (mailbox.context.value !== 'search') {
    const saved = captureContext();
    if (saved) history.value.push(saved);
  }
  drawer.value = null;
  contactDisclosure.value = false;
  searchVisible.value = true;
  searchDraft.value = query;
  const token = ++navigationToken;
  await mailbox.search(query, cachedSearch.value);
  if (token !== navigationToken) return;
  cachedSearch.value = mailbox.searchCachedOnly.value;
  await focusFocusedRow();
}
async function senderSearch(address: string): Promise<void> {
  await submitSearch('from:"' + address + '"');
}
const recentFetched = ref<{ ref: ConversationRef; subject: string }[]>([]);
// The open (or focused) conversation is where the user already is: exclude it
// by ref identity, then cap, so the pane still lists up to four other threads.
const recentMail = computed(() => {
  const here = readerOpen.value ? mailbox.openRef.value : mailbox.focusedRef.value;
  return recentFetched.value.filter((item) => !sameConversation(item.ref, here)).slice(0, 4);
});
let recentToken = 0;
watch([contact, accountId], async ([person, account]) => {
  const token = ++recentToken;
  recentFetched.value = [];
  if (!person || !account) return;
  try {
    const page = await props.client.searchMail({ accountId: account, query: 'from:"' + person.mailbox + '"', cursor: null, cachedOnly: true });
    if (token === recentToken) recentFetched.value = page.conversations.map((c) => ({ ref: c.ref, subject: c.subject }));
  } catch { /* Optional cached history: never invent links on failure. */ }
});
async function openRecent(target: ConversationRef): Promise<void> {
  contactDisclosure.value = false;
  captureListOrigin(mailbox.context.value);
  await mailbox.openConversationByRef(target);
}
const history = ref<ContextEntry[]>([]);
let navigationToken = 0;
const attachmentConversation = ref<import('./lib/ipc/client').Conversation | null>(null);
let attachmentOrigin: HTMLElement | null = null;
let attachmentScroll = 0;
// Scope DOM lookups to this App: two workspaces each have their own reader scroller.
const appRoot = ref<HTMLElement | null>(null);
function openAttachments(origin?: HTMLElement) {
  if (drawer.value || overlay.value || !readerOpen.value || mailbox.detailState.value !== 'ready' || !mailbox.conversation.value) return;
  cancelGo();
  attachmentOrigin = origin ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
  attachmentScroll = appRoot.value?.querySelector('.reader-scroll')?.scrollTop ?? 0;
  attachmentConversation.value = structuredClone(JSON.parse(JSON.stringify(mailbox.conversation.value)));
}
async function closeAttachments() {
  attachmentConversation.value = null;
  await nextTick();
  if (attachmentOrigin?.isConnected && !attachmentOrigin.closest('[inert]')) attachmentOrigin.focus({ preventScroll: true });
  const scroll = appRoot.value?.querySelector('.reader-scroll');
  if (scroll) scroll.scrollTop = attachmentScroll;
}
watch(accountId, () => { attachmentConversation.value = null; });
const overlay = ref<'palette' | 'navigator' | null>(null);
// This App belongs to one immutable fixture session. Keep its command query
// across transient overlay mounts, without sharing the destination query or
// changing standalone/native palette reset behavior.
const paletteQuery = ref('');
const overlayQuery = computed({
  get: () => props.mode === 'browser-preview' && props.switchAccountLabel && overlay.value === 'palette'
    ? paletteQuery.value : undefined,
  set: (query: string) => { if (overlayQuery.value !== undefined) paletteQuery.value = query; },
});
const paletteButton = ref<HTMLElement | null>(null);
let overlayOrigin: HTMLElement | null = null;
let overlayRowOrigin: ConversationRef | null = null;
// G-chord (g then e/h). The chord window is long enough for a hesitant second
// key; when it lapses the hint disappears and a short grace window swallows a
// late e/h, so a slow "g e" can never fall through to the plain-key meaning of
// e (Archive). Any other key, focus change or explicit cancel ends the grace.
const GO_CHORD_WINDOW_MS = 1500;
const GO_CHORD_GRACE_MS = 600;
let goTimer: ReturnType<typeof setTimeout> | null = null;
let goGraceTimer: ReturnType<typeof setTimeout> | null = null;
const goPending = ref(false);
function endGoGrace(): void { if (goGraceTimer) clearTimeout(goGraceTimer); goGraceTimer = null; }
function cancelGo(): void {
  if (goTimer) clearTimeout(goTimer);
  goTimer = null;
  goPending.value = false;
  endGoGrace();
}
function armGo(): void {
  cancelGo();
  goPending.value = true;
  goTimer = setTimeout(() => {
    goTimer = null;
    goPending.value = false;
    goGraceTimer = setTimeout(endGoGrace, GO_CHORD_GRACE_MS);
  }, GO_CHORD_WINDOW_MS);
}
/** Keys whose chorded meaning (Done / Reminders) differs from the plain key. */
function isGoSecondKey(event: KeyboardEvent): boolean {
  return (event.key === 'e' || (event.key === 'h' && remindersSupported.value))
    && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing;
}
const goHintLabel = computed(() => `g pressed. Press E for Done${remindersSupported.value ? ' or H for Reminders' : ''}, Escape to cancel.`);
function openOverlay(kind: 'palette' | 'navigator'): void {
  cancelGo();
  if (!accountReady.value) return;
  overlayOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlayRowOrigin = overlayOrigin?.matches('.inbox-row') && mailbox.focusedRef.value
    ? { ...mailbox.focusedRef.value } : null;
  overlay.value = kind;
}
async function closeOverlay(restore = true): Promise<void> {
  overlay.value = null;
  await nextTick();
  if (!restore || !workspaceActive.value) return;
  if (overlayOrigin?.isConnected && !overlayOrigin.closest('[inert]')) {
    if (overlayRowOrigin && inboxList.value) inboxList.value.focusRef(overlayRowOrigin, { preventScroll: true });
    else overlayOrigin.focus({ preventScroll: true });
  } else if (drawer.value) drawerEl.value?.focus({ preventScroll: true });
  else if (contactDisclosure.value) contactPanelEl.value?.focus({ preventScroll: true });
  else if (readerOpen.value) (readerView.value?.$el as HTMLElement | undefined)?.focus({ preventScroll: true });
  else if (mailbox.listState.value === 'ready') await focusFocusedRow(true);
  else paletteButton.value?.focus({ preventScroll: true });
}
async function executeOverlay(id: BrowsingActionId): Promise<void> {
  // Resolve availability again BEFORE removing the overlay; never retain a row target.
  if (!actionAvailable(id)) return;
  await closeOverlay(true);
  await executeAction(id);
}
function captureContext(): ContextEntry | null {
  if (!accountId.value) return null;
  const entry = readerOpen.value ? origin.value : null;
  return {
    starredOnly: mailbox.starredOnly.value,
    accountId: accountId.value, context: mailbox.context.value, surface: mailbox.context.value,
    search: mailbox.context.value === 'search' ? { query: mailbox.searchQuery.value, cachedOnly: mailbox.searchCachedOnly.value, coverage: mailbox.searchCoverage.value, rows: [...mailbox.conversations.value], cursor: mailbox.nextCursor.value } : undefined,
    loadedDonePages: mailbox.loadedDonePages.value,
    doneBoundary: mailbox.loadedDoneBoundary.value ? { ...mailbox.loadedDoneBoundary.value } : null,
    focusedRef: entry?.focusedRef ?? mailbox.focusedRef.value,
    ordering: entry?.ordering ?? mailbox.conversations.value.map((row) => ({ ...row.ref })),
    anchor: entry?.anchor ?? inboxList.value?.captureAnchor() ?? null,
  };
}
async function navigateContext(context: BrowseContext, saved?: ContextEntry): Promise<boolean> {
  cancelGo();
  editingSplit.value = false;
  searchVisible.value = false;
  if ((drawer.value === 'drafts' || replyComposerOpen.value || composeCardOpen.value) && !(await releaseDraftsDrawer())) return false;
  const token = ++navigationToken;
  const account = accountId.value;
  if (context === 'saved' && (!mailbox.savedSplit.value?.enabled || mailbox.splitError.value)) context = 'inbox';
  if (context !== mailbox.context.value && !saved) {
    const current = captureContext();
    if (current) history.value.push(current);
  }
  drawer.value = null;
  contactDisclosure.value = false;
  if (readerOpen.value && context === mailbox.context.value && !saved) {
    await closeReader(true);
    return token === navigationToken && account === accountId.value;
  }
  if (readerOpen.value) mailbox.closeReader();
  if (saved?.search && context === 'search') {
    await mailbox.restoreSearch(saved.search);
    searchDraft.value = saved.search.query;
    cachedSearch.value = saved.search.cachedOnly;
  } else await mailbox.setContext(context, saved?.loadedDonePages, saved?.doneBoundary, saved?.starredOnly ?? (context === mailbox.context.value && mailbox.starredOnly.value));
  if (token !== navigationToken || account !== accountId.value) return false;
  await nextTick();
  if (saved && mailbox.listState.value !== 'ready') return false;
  if (saved && saved.accountId === accountId.value) {
    mailbox.focusConversation(resolveOriginFocus(saved));
    if (saved.anchor) await inboxList.value?.restoreAnchor(saved.anchor);
  }
  await focusFocusedRow(!!saved);
  return true;
}
async function toggleStarFilter(): Promise<void> {
  if (readerOpen.value || mailbox.listState.value !== 'ready') return;
  const previous = captureContext();
  if (previous) history.value.push(previous);
  await mailbox.setContext(mailbox.context.value, 1, null, !mailbox.starredOnly.value);
  await focusFocusedRow();
}
async function contextBack(): Promise<void> {
  const saved = history.value[history.value.length - 1];
  if (!saved || saved.accountId !== accountId.value) return;
  if (await navigateContext(saved.context, saved)) history.value.pop();
}
watch(accountId, () => {
  editingSplit.value = false;
  ++navigationToken;
  history.value = [];
  searchVisible.value = false;
  searchDraft.value = '';
  origin.value = null;
  overlay.value = null;
  // Group detail is account-scoped: never keep an old-account expansion.
  expandedGroupRequestId.value = null;
  cancelGo();
});
watch([drawer, contactDisclosure, readerOpen], cancelGo);

const origin = ref<ReaderOrigin | null>(null);
const readerView = ref<InstanceType<typeof ReaderView> | null>(null);
/** Header slots the open reader teleports its quiet icon actions into. */
const readerBackHost = ref<HTMLElement | null>(null);
const readerActionsHost = ref<HTMLElement | null>(null);
/** Message identity that currently owns reader focus (for the contact baseline). */
const readerActiveMessageId = ref<string | null>(null);
/** Temporary participant hover/focus context from the reader. */
const contactOverride = ref<
  { ref: ConversationRef; messageId: string; displayName: string | null; mailbox: string } | null
>(null);

function captureListOrigin(surface: ReaderOrigin['surface']): void {
  // Only the mounted list supplies an anchor; J/K and Activity opens inside the
  // reader never recapture (they would erase the entry context with nulls).
  origin.value = {
    surface,
    focusedRef: mailbox.focusedRef.value
      ? { accountId: mailbox.focusedRef.value.accountId, conversationId: mailbox.focusedRef.value.conversationId }
      : null,
    ordering: mailbox.listState.value === 'ready'
      ? mailbox.conversations.value.map((row) => ({ accountId: row.ref.accountId, conversationId: row.ref.conversationId }))
      : [],
    anchor: inboxList.value?.captureAnchor() ?? null,
  };
}

async function focusFocusedRow(preventScroll = false): Promise<void> {
  await nextTick();
  if (!workspaceActive.value) return;
  const focused = mailbox.focusedRef.value;
  if (focused && inboxList.value) inboxList.value.focusRef(focused, { preventScroll });
  else if (mailbox.conversations.value.length === 0) emptyState.value?.focus();
}

function moveFocus(delta: number): void {
  mailbox.moveFocus(delta);
  void focusFocusedRow();
}

/**
 * Resolve the ORIGINAL entry reference against the current snapshot for Back:
 * the surviving entry reference wins; otherwise the next surviving neighbor
 * from the entry ordering, then the previous one, then the first valid row; an
 * empty result restores no row (the empty state receives focus).
 */
function resolveOriginFocus(originState: ReaderOrigin): ConversationRef | null {
  const snapshot = mailbox.conversations.value;
  if (snapshot.length === 0) return null;
  const survives = (target: ConversationRef | null): boolean =>
    target !== null && snapshot.some((row) => sameConversation(row.ref, target));
  const entry = originState.focusedRef;
  if (entry && survives(entry)) return entry;
  const order = originState.ordering;
  const index = entry ? order.findIndex((ref) => sameConversation(ref, entry)) : -1;
  if (index >= 0) {
    for (let i = index + 1; i < order.length; i += 1) {
      const candidate = order[i]!;
      if (survives(candidate)) return candidate;
    }
    for (let i = index - 1; i >= 0; i -= 1) {
      const candidate = order[i]!;
      if (survives(candidate)) return candidate;
    }
  }
  return snapshot[0]!.ref;
}

/**
 * Close the reader and restore the originating context. Back (Escape/Close
 * button) restores the ORIGINAL entry reference and captured list anchor;
 * explicit Inbox navigation (rail) keeps the list's own current focus instead.
 * An Activity-origin Back reopens Activity with the saved Inbox anchor.
 */
async function closeReader(explicitInbox = false): Promise<void> {
  // This App boundary is Back/destination navigation; the composable's internal
  // closeReader also runs on search entry and must not revoke that search.
  mailbox.invalidateSearchIntent();
  // The inline reply composer or compose card docks the active editor inside
  // the reader pane: closing the reader would hide it, so the close goes
  // through the same protected flush as the drafts drawer. A failed close
  // keeps the reader and the docked editor visible with their unacknowledged
  // buffer.
  if ((replyComposerOpen.value || composeCardOpen.value) && !(await releaseDraftsDrawer())) return;
  const originState = origin.value;
  const token = navigationToken;
  const account = accountId.value;
  mailbox.closeReader();
  await (async () => {
    // An active draft editor owns attention: keep it visible rather than
    // leaving it hidden behind another disclosure or off-screen entirely.
    // A reply docked in the reader keeps the reader open — no drawer routing;
    // a compose card docked there likewise keeps the reader open.
    if (drafts.isVisible.value) {
      if (replyComposerOpen.value || composeCardOpen.value) return;
      if (drawer.value !== 'drafts') await openDrawer('drafts');
      return;
    }
    await nextTick();
    if (token !== navigationToken || account !== accountId.value || readerOpen.value) return;
    const anchor = originState?.anchor ?? null;
    if (anchor && inboxList.value) await inboxList.value.restoreAnchor(anchor);
    if (originState && originState.surface !== 'activity' && originState.surface !== 'reminders' && originState.surface !== 'trash' && !explicitInbox) {
      const resolved = resolveOriginFocus(originState);
      if (resolved) mailbox.focusConversation(resolved);
    }
    await focusFocusedRow(true);
    if (!explicitInbox && (originState?.surface === 'activity' || originState?.surface === 'reminders' || originState?.surface === 'trash')) await openDrawer(originState.surface);
  })();
}

/**
 * Inbox rail navigation: an explicit Inbox destination dismisses the contact
 * disclosure and any utility drawer, awaits the protected draft closure, and
 * restores the list from the Inbox origin when a reader is open. Escape/Back
 * from an Activity-origin reader must still return to Activity, so the origin
 * is overridden only for this explicit destination.
 */
async function navigateToInbox(): Promise<void> {
  await navigateContext('inbox');
}

async function openFocusedFromList(): Promise<void> {
  captureListOrigin(mailbox.context.value);
  await mailbox.openFocused();
}

async function openRowFromList(target: ConversationRef): Promise<void> {
  if (!sameConversation(target, mailbox.focusedRef.value)) mailbox.focusConversation(target);
  await openFocusedFromList();
}

async function openFromTrash(target: ConversationRef): Promise<void> {
  if (target.accountId !== accountId.value) return;
  mailbox.clearSelection();
  captureListOrigin('trash');
  drawer.value = null;
  await mailbox.openConversationByRef(target);
}
const trashReader = computed(() => readerOpen.value && origin.value?.surface === 'trash');

function openFromActivity(target: ConversationRef): Promise<void> {
  return openFromUtility(target, 'activity');
}

async function openFromUtility(target: ConversationRef, surface: 'activity' | 'reminders'): Promise<void> {
  // Capture the return surface synchronously, before loading: Back can happen
  // while the detail is pending, and a late response must never rewrite the
  // origin of a newer reader. Keep the saved list anchor/entry context when
  // opening from a utility over an existing reader (the list is unmounted).
  if (readerOpen.value) {
    if (origin.value) origin.value = { ...origin.value, surface };
  } else {
    captureListOrigin(surface);
  }
  drawer.value = null;
  await mailbox.openConversationByRef(target, 'activity');
}

/**
 * Resolve a surviving neighbor of the CURRENT open conversation from the
 * originating Inbox snapshot (delta steps, no wrap). A cursor removed from the
 * current snapshot resolves through the entry-time ordering. Returns null when
 * no surviving neighbor exists.
 */
function resolveReaderNeighbor(delta: number): ConversationRef | null {
  const opened = mailbox.openRef.value;
  if (!opened) return null;
  const snapshot = mailbox.conversations.value;
  const survives = (target: ConversationRef): boolean => snapshot.some((row) => sameConversation(row.ref, target));
  const snapIndex = snapshot.findIndex((row) => sameConversation(row.ref, opened));
  const order: ConversationRef[] = snapIndex >= 0
    ? snapshot.map((row) => row.ref)
    : (origin.value?.ordering ?? []);
  const index = snapIndex >= 0
    ? snapIndex
    : order.findIndex((ref) => sameConversation(ref, opened));
  if (index < 0) return null;
  for (let i = index + delta; i >= 0 && i < order.length; i += delta) {
    const candidate = order[i]!;
    if (survives(candidate)) return candidate;
  }
  return null;
}

/** J/K inside the reader: conversation movement in the originating Inbox only. */
async function moveReaderConversation(delta: number): Promise<void> {
  // Activity-origin readers never navigate and never issue getConversation
  // calls — including when Activity history duplicates the reference.
  if (!readerOpen.value || origin.value?.surface === 'activity' || origin.value?.surface === 'reminders' || trashReader.value) return;
  if (mailbox.listState.value !== 'ready') return;
  const target = resolveReaderNeighbor(delta);
  if (!target) return;
  lastReaderMove = delta < 0 ? -1 : 1;
  // Hidden list focus must not move; the open reference is the reader cursor.
  await mailbox.openNeighbor(target);
}

/** Reader previous/next chevrons: the same neighbor rule as J/K. Hidden (undefined)
 * where J/K are no-ops (Activity/Reminders/Trash readers); disabled at the ends. */
const readerNavigates = computed(() => readerOpen.value && origin.value?.surface !== 'activity' && origin.value?.surface !== 'reminders' && !trashReader.value);

// Read-only neighbor prefetch (same getConversation call as opening) for the
// readers that allow J/K, in the direction of the last move (next by default).
let lastReaderMove: 1 | -1 = 1;
watch(readerOpen, (open) => { if (!open) lastReaderMove = 1; });
watch(
  () => {
    if (!readerNavigates.value || mailbox.detailState.value !== 'ready' || mailbox.listState.value !== 'ready') return null;
    const shown = mailbox.conversation.value;
    if (!shown || !sameConversation(shown.ref, mailbox.openRef.value)) return null;
    // `shown` changes after every background refresh, which re-arms the prefetch.
    return [shown, resolveReaderNeighbor(lastReaderMove)] as const;
  },
  (armed) => {
    if (armed?.[1]) mailbox.prefetchConversation(armed[1]);
  },
  { immediate: true },
);
const canMoveReaderPrev = computed(() => readerNavigates.value ? mailbox.listState.value === 'ready' && resolveReaderNeighbor(-1) !== null : undefined);
const canMoveReaderNext = computed(() => readerNavigates.value ? mailbox.listState.value === 'ready' && resolveReaderNeighbor(1) !== null : undefined);

function onReaderActiveMessage(messageId: string | null): void {
  readerActiveMessageId.value = messageId;
  // A new focused message restarts participant context from the baseline,
  // EXCEPT when focus landed directly on a participant of that message: the
  // reader emits the participant override BEFORE the active-message event in
  // that case, so an override matching the newly focused message and the
  // currently open conversation survives. Every other override (older message,
  // other conversation/account, cleared focus) is discarded.
  const override = contactOverride.value;
  if (messageId === null
    || !override
    || override.messageId !== messageId
    || !sameConversation(override.ref, mailbox.openRef.value)) {
    contactOverride.value = null;
  }
}

function onReaderContactOverride(
  override: { ref: ConversationRef; messageId: string; displayName: string | null; mailbox: string } | null,
): void {
  contactOverride.value = override;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function archiveFocusedRow(): Promise<void> {
  await mailbox.archiveFocused();
  await focusFocusedRow();
}

async function archiveRowFromList(target: ConversationRef): Promise<void> {
  const listElement = inboxList.value?.$el;
  const hadListFocus = listElement instanceof HTMLElement && listElement.contains(document.activeElement);
  const receipt = await mailbox.setArchived(target, true);
  if (!receipt || !hadListFocus) return;
  const operation = mailbox.activity.value.find((item) => item.id === receipt.operationId);
  if (operation?.status === 'failed') return;
  const focused = document.activeElement;
  const currentList = inboxList.value?.$el;
  if (focused !== document.body && !(currentList instanceof HTMLElement && currentList.contains(focused))) return;
  await focusFocusedRow();
}

function currentReaderTarget() {
  const target = mailbox.conversation.value?.ref ?? null;
  if (mailbox.detailState.value !== 'ready' || mailbox.inFlightCommandRef.value) return null;
  return sameConversation(target, mailbox.openRef.value) ? target : null;
}

async function archiveFromReader(starred?: boolean): Promise<void> {
  const target = currentReaderTarget();
  const opened = mailbox.openRef.value;
  if (!target) return;
  const ownsNavigation = mailbox.captureNavigationIntent();
  // ACTION-TIME ordering: capture the account-scoped snapshot ordering BEFORE
  // the archive mutates the inbox, and resolve the surviving next/previous
  // neighbors from THIS ordering after the refresh. A concurrent reorder
  // between the action and the refresh therefore cannot advance to the wrong
  // conversation. Back/Escape still resolves through the immutable ENTRY
  // ordering (origin), and J/K keeps its own snapshot/entry resolution; the
  // three orderings stay separate.
  const actionOrdering: ConversationRef[] = mailbox.conversations.value
    .filter((row) => row.ref.accountId === target.accountId)
    .map((row) => ({ accountId: row.ref.accountId, conversationId: row.ref.conversationId }));
  const receipt = starred === undefined ? await mailbox.setArchived(target, true) : await mailbox.setStarred(target, starred);
  // Acceptance stands, but its navigation must not supersede a newer intent
  // (including a search still awaiting cancellation with the same openRef).
  if (!receipt || !ownsNavigation() || mailbox.openRef.value !== opened || mailbox.listState.value !== 'ready') return;
  const op = mailbox.activity.value.find((item) => item.id === receipt.operationId);
  if (op?.status === 'failed') return;
  // An Activity-origin reader must not advance into unrelated Inbox mail.
  if (origin.value?.surface === 'activity' || origin.value?.surface === 'reminders') {
    closeReader();
    return;
  }
  // Inbox archive auto-advance selects a surviving neighbor of the CURRENT
  // actioned conversation from the ACTION-TIME ordering (next, then previous;
  // no wrap; mailbox.focusedRef deliberately stays the original entry focus);
  // without a neighbor the reader simply closes.
  const actionIndex = actionOrdering.findIndex((ref) => sameConversation(ref, target));
  let next: ConversationRef | null = null;
  if (actionIndex >= 0) {
    const survives = (candidate: ConversationRef): boolean =>
      mailbox.conversations.value.some((row) => sameConversation(row.ref, candidate));
    for (let i = actionIndex + 1; i < actionOrdering.length && next === null; i += 1) {
      if (survives(actionOrdering[i]!)) next = actionOrdering[i]!;
    }
    for (let i = actionIndex - 1; i >= 0 && next === null; i -= 1) {
      if (survives(actionOrdering[i]!)) next = actionOrdering[i]!;
    }
  } else {
    // Defensive fallback when the actioned reference is missing from the
    // action-time ordering: resolve from the current snapshot like J/K does.
    next = resolveReaderNeighbor(1) ?? resolveReaderNeighbor(-1);
  }
  if (next) await mailbox.openConversationByRef(next);
  else closeReader();
}

async function unarchiveFromActivity(target: ConversationRef): Promise<void> {
  await mailbox.unarchiveFromActivity(target);
}

async function retryFromActivity(operationId: string): Promise<void> {
  await mailbox.retryOperation(operationId);
}

async function disconnectAccount(): Promise<void> {
  if (drafts.transitioning.value) return;
  drafts.setTransitioning(true);
  try {
    if (await drafts.flushAndClose()) await mailbox.disconnectAccount();
    // A failed flush keeps the editor; the global recovery banner (shown below
    // whenever the drafts drawer is closed) routes attention back to it.
  } finally {
    drafts.setTransitioning(false);
  }
}

async function connectAccount(): Promise<void> {
  if (drafts.transitioning.value) return;
  drafts.setTransitioning(true);
  try {
    if (await drafts.flushAndClose()) await mailbox.connectAccount();
  } finally {
    drafts.setTransitioning(false);
  }
}

async function prepareReply(source: DraftSource): Promise<void> {
  if (trashReader.value) return;
  // The reader stays open after a successful preparation: the drafts watcher
  // docks the reply composer at the bottom of the reader pane instead of
  // closing the reader and opening the drafts drawer.
  await drafts.openNew(source);
}

function openDraft(ref: DraftRef): void {
  void drafts.openDraft(ref);
}

/** Targets are resolved at dispatch, not when the palette was opened. */
function actionTarget(explicit?: ConversationRef): ConversationRef | null {
  if (!accountReady.value || mailbox.commandInFlight.value) return null;
  if (mailbox.context.value !== 'inbox' && mailbox.listState.value === 'error') return null;
  if (explicit) {
    if (explicit.accountId !== accountId.value) return null;
    return mailbox.listState.value === 'ready' && mailbox.conversations.value.some((row) => sameConversation(row.ref, explicit)) ? explicit : null;
  }
  const target = readerOpen.value ? currentReaderTarget()
    : mailbox.listState.value === 'ready' ? mailbox.focusedSummary.value?.ref ?? null : null;
  return target?.accountId === accountId.value ? target : null;
}
function actionAvailable(id: BrowsingActionId, explicit?: ConversationRef): boolean {
  if (!workspaceActive.value || !accountReady.value) return false;
  if (id === 'switch-account') return props.mode === 'browser-preview' && !!props.switchAccountLabel;
  if (id === 'starred') return gmailMode.value && !!accountId.value;
  if (id === 'create-split') return !!accountId.value && !mailbox.savedSplit.value && !editingSplit.value;
  if (id === 'edit-split') return !!accountId.value && !!mailbox.savedSplit.value && !editingSplit.value;
  if (id === 'toggle-unread-filter') return !!accountId.value && !editingSplit.value && !drawer.value && !contactDisclosure.value;
  if (id === 'saved') return !!mailbox.savedSplit.value?.enabled && !mailbox.splitError.value;
  if (['inbox', 'done', 'activity'].includes(id)) return !!accountId.value;
  if (id === 'search') return !!accountId.value && !drawer.value && !contactDisclosure.value;
  if (id === 'account') return gmailMode.value;
  if (id === 'destinations') return (gmailMode.value || props.mode === 'browser-preview') && !!accountId.value;
  if (id === 'trash') return gmailMode.value && !!accountId.value;
  if (id === 'drafts') return !!accountId.value;
  if (id === 'reminders') return remindersSupported.value;
  if (id === 'back') return readerOpen.value || history.value.length > 0;
  if (id === 'select-all-loaded') return !drafts.activeRef.value && !drawer.value && !contactDisclosure.value && !readerOpen.value && mailbox.listState.value === 'ready' && mailbox.conversations.value.length > 0;
  if (id === 'clear-selection') return !drafts.activeRef.value && !drawer.value && !contactDisclosure.value && selectedCount.value > 0;
  // Compose stays available while an editor is already open: it routes to the
  // existing surface instead of stacking a second draft.
  // Like search: compose is gated while a drawer or the narrow contact
  // disclosure covers the central pane, so the inline card can never mount
  // inert behind another surface.
  if (id === 'compose') return !!accountId.value && !editingSplit.value && !drawer.value && !contactDisclosure.value;
  if (drafts.activeRef.value || drawer.value || contactDisclosure.value || trashReader.value) return false;
  if (id === 'undo') {
    // Same guards as the key: no in-flight undo (a second dispatch would race
    // into a false already_undone), and no open reader message-details disclosure.
    return undoWindowOpen.value && !mailbox.commandInFlight.value && !mailbox.groupInFlight.value && !readerView.value?.hasOpenDetails();
  }
  // One-target policy: with a nonempty selection, shared dispatch resolves the
  // selection (even in the reader); explicit row actions bypass this entirely.
  if (!explicit && (id === 'archive' || id === 'unarchive' || id === 'read' || id === 'unread' || id === 'star' || id === 'unstar')) {
    if (bulkActionAvailable(id)) return true;
    if (selectedCount.value > 0) return false;
  }
  const target = actionTarget(explicit);
  if (!target) return false;
  if (id === 'open') return !readerOpen.value;
  if (id === 'remind') return remindersSupported.value && selectedCount.value === 0 && !mailbox.bulkUnresolved.value && (readerOpen.value ? mailbox.conversation.value?.isInInbox === true : mailbox.context.value === 'inbox');
  if (id === 'read' || id === 'unread' || id === 'star' || id === 'unstar') return gmailActionsEnabled.value;
  if (mailbox.context.value === 'starred' && !readerOpen.value) return false;
  if (!mailboxActionsEnabled.value) return false;
  const inInbox = readerOpen.value ? mailbox.conversation.value?.isInInbox : mailbox.context.value !== 'done' && mailbox.context.value !== 'search';
  if (!readerOpen.value && mailbox.context.value === 'search') return true;
  return id === 'archive' ? inInbox === true : inInbox === false;
}
/** Keep permission-blocked star commands discoverable without allowing writes. */
function starPermissionReason(id: BrowsingActionId): string | undefined {
  if ((id !== 'star' && id !== 'unstar') || !accountReady.value || !gmailMode.value || gmailActionsEnabled.value) return;
  if (drafts.activeRef.value || drawer.value || contactDisclosure.value) return;
  if (!(selectedCount.value > 0 ? bulkMembers() : actionTarget())) return;
  return accountStatus.value?.mutationAccess === 'upgrading'
    ? 'Waiting for Google permission. Review access in Account.'
    : 'Read-only. Open Account → Enable mailbox actions to use Star/Unstar.';
}
const availableActions = computed(() => browsingActions
  .filter((action) => (actionAvailable(action.id) || starPermissionReason(action.id))
    && (overlay.value !== 'navigator' || ['inbox', 'saved', 'done', 'destinations', 'trash', 'starred', 'account', 'activity', 'drafts', 'reminders'].includes(action.id)))
  .map((action) => ({
    id: action.id,
    shortcut: action.shortcut,
    aliases: 'aliases' in action ? action.aliases : undefined,
    disabledReason: starPermissionReason(action.id),
    // Selected-scope actions are labelled with the count (§3.3).
    label: selectedCount.value > 0 && ['archive', 'unarchive', 'read', 'unread', 'star', 'unstar'].includes(action.id)
      ? `${action.label} — ${selectedCount.value} selected`
      : action.id === 'toggle-unread-filter' ? (mailbox.unreadOnly.value ? 'Show all conversations' : 'Show unread only')
      : action.id === 'switch-account' ? `Switch account — ${props.switchAccountLabel}`
      : action.id === 'saved' ? `Go to ${mailbox.savedSplit.value?.name ?? 'saved split'}` : action.label,
  })));
async function executeAction(id: BrowsingActionId, explicit?: ConversationRef): Promise<void> {
  if (!actionAvailable(id, explicit)) {
    // A permission-blocked S opens the explanation, never an OAuth flow or write.
    if (starPermissionReason(id)) await openDrawer('account');
    return;
  }
  switch (id) {
    case 'switch-account': emit('switchAccount'); return;
    case 'compose': {
      // One active editor: an existing draft routes to its visible surface
      // (inline compose card, inline reply composer, or drafts drawer), never a duplicate.
      if (drafts.activeRef.value) {
        if (!composeCardOpen.value && !replyComposerOpen.value) await openDrawer('drafts');
        return;
      }
      await drafts.openNew({ kind: 'new_message' });
      return;
    }
    case 'toggle-unread-filter': {
      const token = ++navigationToken;
      const account = accountId.value;
      await mailbox.setUnreadOnly(!mailbox.unreadOnly.value);
      if (token === navigationToken && account === accountId.value && accountReady.value
        && !overlay.value && !drawer.value && !contactDisclosure.value && !readerOpen.value && !editingSplit.value) {
        if (mailbox.listState.value === 'ready') await focusFocusedRow(true);
        else paletteButton.value?.focus();
      }
      return;
    }
    case 'create-split': case 'edit-split':
      if (readerOpen.value || drawer.value || contactDisclosure.value || mailbox.context.value !== 'inbox') {
        if (!(await navigateContext('inbox'))) return;
      }
      // Let reader/list restoration finish before the editor claims focus.
      await nextTick();
      if (actionAvailable(id) && !overlay.value) editingSplit.value = true;
      return;
    case 'search': await revealSearch(); return;
    case 'remind': await openReminders(true); return;
    case 'reminders': await openReminders(false); return;
    case 'inbox': await navigateToInbox(); return;
    case 'saved': await navigateContext('saved'); return;
    case 'done': await navigateContext('done'); return;
    case 'starred': await navigateContext('starred'); return;
    case 'star': case 'unstar': {
      const members = !explicit ? bulkMembers() : null;
      if (members) { await mailbox.setStarredGroup(members, id === 'star'); return; }
      const target = actionTarget(explicit);
      if (!target) return;
      if (readerOpen.value && (mailbox.context.value === 'starred' || mailbox.starredOnly.value) && id === 'unstar') await archiveFromReader(false);
      else { await mailbox.setStarred(target, id === 'star'); if (!readerOpen.value) await focusFocusedRow(); }
      return;
    }
    case 'destinations': case 'trash': case 'account': case 'activity': case 'drafts': await openDrawer(id); return;
    case 'back': if (readerOpen.value) closeReader(); else await contextBack(); return;
    case 'open': if (explicit) await openRowFromList(explicit); else await openFocusedFromList(); return;
    case 'archive':
      if (explicit) await archiveRowFromList(explicit);
      // Selection scope wins over focused/reader singles; the group path never
      // invokes the single-reader archive-and-advance flow.
      else if (bulkMembers()) await bulkArchiveSelection();
      else if (readerOpen.value) await archiveFromReader();
      else await archiveFocusedRow();
      return;
    case 'unarchive': {
      if (!explicit && bulkMembers()) {
        await bulkRestoreSelection();
        return;
      }
      const target = actionTarget(explicit);
      if (target) await mailbox.setArchived(target, false);
      return;
    }
    case 'read': case 'unread': {
      if (!explicit && bulkMembers()) {
        await bulkSetReadSelection(id === 'read');
        return;
      }
      const target = actionTarget(explicit);
      if (target) await mailbox.setRead(target, id === 'read');
      return;
    }
    case 'select-all-loaded':
      mailbox.selectAllLoaded();
      return;
    case 'clear-selection':
      clearSelectionAndReport();
      return;
    case 'undo':
      await undoFromNotice();
      return;
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function buttonOwns(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === 'function' && el.closest('button, a') !== null;
}

/**
 * A reader message toggle is the reader's navigation focus, not a toolbar
 * action button: the conversation-level shortcuts (E, Shift+U) must stay
 * usable from it. All other buttons/links keep the generic exclusion, and
 * native Enter/Space on a toggle still expands/collapses its message.
 */
function readerMessageToggleOwns(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && typeof el.closest === 'function' && el.closest('.message-toggle') !== null;
}

/** Generic button exclusion, except reader-owned message-navigation focus. */
function actionShortcutBlocked(target: EventTarget | null): boolean {
  return buttonOwns(target) && !readerMessageToggleOwns(target);
}

function onKeydown(event: KeyboardEvent): void {
  if (!workspaceActive.value) return;
  if (attachmentConversation.value) {
    // A focused Save button can become disabled during transfer, leaving native
    // focus on body. The top surface still owns Escape in that focus vacuum.
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault(); void closeAttachments();
    }
    return;
  }
  if (overlay.value) return;
  if (editingSplit.value && accountReady.value && !readerOpen.value && !drawer.value && !(!wideViewport.value && contactDisclosure.value)) {
    cancelGo();
    // Disabling the form during save can displace focus to BODY. The visible
    // editor still owns Escape and suppresses all underlying mail shortcuts.
    // Consume a displaced Enter too: it must not queue a native form submit
    // that fires when failure re-enables/refocuses the field. Keep Tab native.
    if (mailbox.splitBusy.value && event.target === document.body && event.key === 'Enter'
      && !event.altKey && !event.ctrlKey && !event.metaKey) event.preventDefault();
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && !event.altKey && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      if (!mailbox.splitBusy.value) void closeSplitEditor();
    }
    return;
  }
  if (props.mode !== 'browser-preview' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && event.key.toLowerCase() === 'o' && !event.isComposing && event.keyCode !== 229
    && !isEditableTarget(event.target) && readerOpen.value && !drawer.value) {
    event.preventDefault(); openAttachments(); return;
  }
  if (event.isComposing || event.keyCode === 229 || event.altKey || event.ctrlKey || event.metaKey) cancelGo();
  // Cmd+K is the native app binding. Browser preview leaves reserved shortcuts alone.
  if (props.mode !== 'browser-preview' && event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'k' && !event.isComposing && event.keyCode !== 229) {
    event.preventDefault(); openOverlay('palette'); return;
  }
  if (goTimer) {
    cancelGo();
    // Escape cancels the armed chord and is consumed: one Escape, one dismissal.
    if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); return; }
    if (isGoSecondKey(event) && !isEditableTarget(event.target) && !drawer.value && !contactDisclosure.value && !readerOpen.value) {
      event.preventDefault(); void executeAction(event.key === 'h' ? 'reminders' : 'done'); return;
    }
  } else if (goGraceTimer) {
    // The window just lapsed: a late second key was almost certainly meant for
    // the chord, so it is swallowed instead of running the plain-key action.
    endGoGrace();
    if (isGoSecondKey(event) && !isEditableTarget(event.target)) { event.preventDefault(); return; }
  }
  // A visible compose surface (inline reply composer or inline compose card)
  // owns Escape: it closes through the same protected flush as the drafts
  // editor. This must run before the key suppression below so the composer
  // (not the mailbox) answers Escape; the surface hides when drafts.isVisible
  // goes false.
  if ((replyComposerOpen.value || composeCardOpen.value) && event.key === 'Escape' && !event.isComposing && event.keyCode !== 229
    && !event.ctrlKey && !event.metaKey && !event.altKey) {
    event.preventDefault();
    void drafts.flushAndClose();
    return;
  }
  // Only a visible composer owns all keys; a suspended editor behind another
  // disclosure must not silently keep keyboard ownership from the inbox.
  if (drafts.activeRef.value && (drawer.value === 'drafts' || composeCardOpen.value || replyComposerOpen.value)) return;
  if (event.isComposing || event.keyCode === 229) return; // IME composition
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditableTarget(event.target)) return;

  const key = event.key;
  if (key === '/' && actionAvailable('search')) { event.preventDefault(); void executeAction('search'); return; }
  const readerIsOpen = readerOpen.value;

  if (key === 'Escape') {
    // The active disclosure gets Escape precedence; mailbox actions underneath
    // are suppressed while it is open.
    if (drawer.value) {
      event.preventDefault();
      void closeDrawer();
      return;
    }
    // Protected close of the inline reply composer or compose card: flush
    // through the draft lifecycle; the surface hides when drafts.isVisible
    // goes false.
    if (replyComposerOpen.value) { event.preventDefault(); void drafts.flushAndClose(); return; }
    if (composeCardOpen.value) { event.preventDefault(); void closeComposeCard(); return; }
    if (!wideViewport.value && contactDisclosure.value) {
      event.preventDefault();
      void closeContactDisclosure();
      return;
    }
    if (readerIsOpen) {
      // An open message-details disclosure is dismissed before the reader.
      if (readerView.value?.hasOpenDetails()) {
        event.preventDefault();
        readerView.value.dismissMessageDetails();
        return;
      }
      // Escape order (§3.2): disclosure/drawer → selected set → reader Back.
      if (selectedCount.value > 0) {
        event.preventDefault();
        clearSelectionAndReport();
        return;
      }
      event.preventDefault();
      void executeAction('back');
    } else if (selectedCount.value > 0) {
      // Escape order (§3.2): the selected set clears before any context Back,
      // including when no context history exists.
      event.preventDefault();
      clearSelectionAndReport();
    } else if (history.value.length) {
      event.preventDefault(); void executeAction('back');
    }
    return;
  }
  if (drawer.value || (!wideViewport.value && contactDisclosure.value)) return;
  if (key === 'h' && !event.shiftKey && !event.repeat && !actionShortcutBlocked(event.target)) {
    if (actionAvailable('remind')) { event.preventDefault(); void executeAction('remind'); }
    return;
  }

  const browsingOwns = !readerIsOpen && !buttonOwns(event.target) && (event.target === document.body || (event.target instanceof Node && !!inboxList.value?.$el?.contains(event.target)) || event.target === emptyState.value);
  // Split navigation is deliberately nonwrapping and owns only the list,
  // not form fields, toolbar buttons, the reader, or other destinations.
  const splitListOwns = browsingOwns && event.target === document.activeElement
    && event.target instanceof HTMLElement
    && (event.target.matches('.inbox-row') || event.target === emptyState.value)
    && mailbox.listState.value === 'ready';
  if (splitListOwns && key === 'Tab' && (mailbox.context.value === 'inbox' || mailbox.context.value === 'saved')) {
    const splits: BrowseContext[] = savedTabVisible.value || mailbox.context.value === 'saved' ? ['inbox', 'saved'] : ['inbox'];
    const index = splits.indexOf(mailbox.context.value);
    const destination = splits[index + (event.shiftKey ? -1 : 1)];
    if (destination) {
      event.preventDefault();
      void navigateContext(destination);
    }
    // At either boundary, leave Tab to native traversal (never wrap).
    return;
  }
  if (browsingOwns && !event.shiftKey && key === 'ArrowLeft') {
    event.preventDefault(); openOverlay('navigator'); return;
  }
  if (browsingOwns && !event.shiftKey && key === 'g') {
    event.preventDefault(); armGo(); return;
  }
  if (key === 's' && !event.shiftKey && !event.repeat && (browsingOwns || readerIsOpen) && !actionShortcutBlocked(event.target)) {
    const stars = readerIsOpen ? mailbox.conversation.value?.stars : mailbox.focusedSummary.value?.stars;
    event.preventDefault();
    void executeAction(selectedCount.value === 0 && stars?.knownMessages === stars?.totalMessages && (stars?.starredMessages ?? 0) > 0 ? 'unstar' : 'star');
    return;
  }
  if (key === 'E' && event.shiftKey && !actionShortcutBlocked(event.target)) {
    event.preventDefault(); void executeAction('unarchive'); return;
  }
  if (key === 'U' && event.shiftKey && !actionShortcutBlocked(event.target)) {
    event.preventDefault();
    void executeAction('unread');
    return;
  }
  // Compose works from BOTH the list and the reader, like S: no modifiers, no
  // editable target, no button owning the key (checked above).
  if (key === 'c' && !event.shiftKey && !event.repeat && (browsingOwns || readerIsOpen) && !actionShortcutBlocked(event.target)) {
    event.preventDefault();
    void executeAction('compose');
    return;
  }
  // Undo works from BOTH the list and the reader; the same guard set as E
  // applies. Availability (window, in-flight undo, reader disclosure) lives in
  // actionAvailable so the palette entry and the key cannot disagree.
  if (key === 'z' && !event.shiftKey && !actionShortcutBlocked(event.target)) {
    if (event.repeat) return; // key auto-repeat must not double-dispatch undo
    event.preventDefault();
    void executeAction('undo');
    return;
  }
  if (readerIsOpen) {
    const reader = readerView.value;
    if (key === 'n' || key === 'N') {
      event.preventDefault();
      reader?.moveMessage(1);
      return;
    }
    if (key === 'p' || key === 'P') {
      event.preventDefault();
      reader?.moveMessage(-1);
      return;
    }
    if (key === 'o' || key === 'O') {
      event.preventDefault();
      if (event.shiftKey) reader?.expandAllMessages(); // idempotent expand-all
      else reader?.toggleActiveMessage();
      return;
    }
    // Reader J/K moves the reader cursor within the originating Inbox; it is a
    // no-op for Activity-origin readers and never moves hidden list focus.
    // ArrowUp/ArrowDown keep native behavior while reading (the reader article
    // scrolls); the arrow aliases belong to the LIST navigation only.
    if (key === 'j') {
      event.preventDefault();
      void moveReaderConversation(1);
      return;
    }
    if (key === 'k') {
      event.preventDefault();
      void moveReaderConversation(-1);
      return;
    }
    if (key === 'e' && mailboxActionsEnabled.value && !actionShortcutBlocked(event.target)) {
      event.preventDefault();
      void executeAction('archive');
    }
    return;
  }

  // Selection keys: same surface ownership as the browsing keys (a contact
  // column/disclosure/drawer owning focus must never mutate the hidden list
  // selection, §3.3), with window-targeted synthetic events treated like
  // list-owned keys.
  const targetIsNode = event.target instanceof Node;
  const selectionKeysOwned = !readerIsOpen
    && !buttonOwns(event.target)
    // A real Node must be the list surface (body, list, empty state); a
    // non-Node target (window-dispatched synthetic event) is list-owned too.
    // The wide contact column / disclosures own their Nodes and never mutate
    // the hidden list selection (§3.3).
    && (!targetIsNode
      || event.target === document.body
      || (event.target instanceof Node && !!inboxList.value?.$el?.contains(event.target))
      || event.target === emptyState.value);
  if (selectionKeysOwned && (key === 'x' || key === 'X')) {
    if (event.repeat) return; // X ignores auto-repeat
    event.preventDefault();
    if (mailbox.focusedRef.value) mailbox.toggleSelected(mailbox.focusedRef.value);
    return;
  }
  if (selectionKeysOwned && event.shiftKey && (key === 'J' || key === 'K')) {
    // Shift+J/K: move one row, then add the inclusive anchor→destination range.
    // Boundary moves are a no-op (focus does not change).
    event.preventDefault();
    const preMove = mailbox.focusedRef.value ? { ...mailbox.focusedRef.value } : null;
    moveFocus(key === 'J' ? 1 : -1);
    const destination = mailbox.focusedRef.value;
    if (destination && preMove && !sameConversation(destination, preMove)) mailbox.extendSelectionTo(destination, preMove);
    return;
  }

  switch (key) {
    case 'j':
    case 'ArrowDown':
      event.preventDefault();
      moveFocus(1);
      return;
    case 'k':
    case 'ArrowUp':
      event.preventDefault();
      moveFocus(-1);
      return;
    case 'Enter':
      if (buttonOwns(event.target)) return;
      event.preventDefault();
      void executeAction('open');
      return;
    case 'e':
      if (!mailboxActionsEnabled.value || buttonOwns(event.target)) return;
      event.preventDefault();
      void executeAction('archive');
      return;
    default:
      return;
  }
}

/**
 * Unresolved operations for the Activity rail badge, derived from the same
 * activity rows the Activity drawer lists (no extra read): queued/applying
 * are pending, outcome_unknown needs the user's attention. Both are counted,
 * as the removed header status line did, and named separately in words.
 */
const unresolvedPending = computed(
  () => mailbox.activity.value.filter((op) => op.status === 'queued' || op.status === 'applying').length,
);
const unresolvedUnknown = computed(
  () => mailbox.activity.value.filter((op) => op.status === 'outcome_unknown').length,
);
const unresolvedCount = computed(() => unresolvedPending.value + unresolvedUnknown.value);
const unresolvedSummary = computed(() => {
  const pending = unresolvedPending.value;
  const unknown = unresolvedUnknown.value;
  const ops = (n: number) => `${n} ${n === 1 ? 'operation' : 'operations'}`;
  if (pending > 0 && unknown > 0) return `${ops(pending + unknown)} unresolved: ${pending} pending, ${unknown} outcome unknown`;
  if (pending > 0) return `${ops(pending)} pending`;
  if (unknown > 0) return `${ops(unknown)} with outcome unknown`;
  return '';
});

/**
 * Alert text for the in-flow command-error line beside the action notice. An expired undo window is already announced
 * by the polite action notice (expired wording); repeating it as a role=alert
 * would double-announce. Every other failure keeps its alert.
 */
const commandError = computed(() => {
  const error = mailbox.lastCommandError.value;
  if (!error) return null;
  if (error.kind === 'undo_unavailable' && error.reason === 'expired') return null;
  return error;
});

function errorText(error: { kind: string; field?: string; reason?: string }): string {
  switch (error.kind) {
    case 'not_found':
      return 'not found';
    case 'invalid_request':
      if (error.field === 'searchQuery') return 'unsupported search syntax. Use text, straight-quoted phrases, from:, to:, subject:, AND, OR and -exclusions.';
      if (error.field === 'cachedDoneRestoreRange') return 'cached Done changed beyond the restoration limit; retry or return to Inbox';
      return `invalid request (field: ${error.field ?? '?'})`;
    case 'request_id_conflict':
      return 'request ID conflict';
    case 'storage_unavailable':
      return 'storage unavailable';
    case 'profile_in_use':
      return 'profile in use';
    case 'read_only':
      return 'read-only account';
    case 'not_configured':
      return 'not configured';
    case 'auth_required':
      return 'sign-in required';
    case 'auth_cancelled':
      return 'sign-in cancelled';
    case 'auth_failed':
      return 'sign-in failed';
    case 'secrets_unavailable':
      return 'credential storage unavailable';
    case 'network_unavailable':
      return 'network unavailable';
    case 'rate_limited':
      return 'rate limited';
    case 'provider_unavailable':
      return 'provider unavailable';
    case 'invalid_provider_response':
      return 'unexpected provider response';
    case 'busy':
      return 'busy';
    case 'permission_required':
      return 'Google permission required';
    case 'provider_rejected':
      return 'provider rejected action';
    case 'outcome_unknown':
      return 'provider outcome unknown';
    case 'undo_unavailable':
      switch (error.reason) {
        case 'expired': return 'undo window expired';
        case 'superseded': return 'superseded by a newer action';
        case 'already_undone': return 'already undone';
        case 'not_applicable': return 'not undoable';
        case 'uncertain': return 'outcome unknown; use Activity';
        case 'unknown_prior': return 'prior state unknown';
        default: return 'undo unavailable';
      }
    default:
      return 'unknown error';
  }
}
</script>

<template>
  <div ref="appRoot" class="app" :data-client-mode="props.mode">
    <main class="app-main" :inert="!!overlay || !!attachmentConversation || undefined">
      <!-- Split header (DESIGN.md "Split Tabs"): one borderless 78px strip in
           the list column. Destinations hamburger on the left, split tabs on
           the 50px content inset, quiet notes and glyphs on the right. It sits
           inside <main> so it shares main's overlay inertness and the list
           column's grid track; the rail and contact pane span its height. -->
      <header class="app-header">
        <button type="button" class="header-glyph header-menu" data-test="navigator-trigger" title="Destinations (Left from list)" @click="openOverlay('navigator')"><HeaderGlyph name="menu" /><span class="visually-hidden">Destinations</span></button>
        <div class="header-tabs">
          <!-- The context heading stays in the accessibility tree; on screen the
               active split tab already names it, so it is shown only when no
               rendered tab is active (Cached Done, Starred, Search, reader). -->
          <span ref="readerBackHost" class="reader-back-host"></span>
          <h1 class="app-title" :class="{ 'visually-hidden': activeTabShown }" data-test="inbox-title">{{ contextTitle }}<template v-if="switchAccountLabel"><span class="app-title-account"> — {{ accountStatus?.account?.emailAddress }}</span></template></h1>
          <nav v-if="splitNavShown" class="split-nav" aria-label="Inbox splits" :title="splitCoverageShown ? SPLIT_COVERAGE : undefined">
            <button type="button" class="split-tab" data-test="split-inbox" :aria-current="mailbox.context.value === 'inbox' ? 'page' : undefined" :aria-describedby="splitCoverageShown ? `${domIdPrefix}split-coverage` : undefined" @click="navigateContext('inbox')"><span class="split-label">Inbox</span> <span v-if="splitBadge(mailbox.inboxTotal.value)" class="split-count">{{ splitBadge(mailbox.inboxTotal.value) }}</span></button>
            <button v-if="savedTabVisible" type="button" class="split-tab" data-test="split-saved" :aria-current="mailbox.context.value === 'saved' ? 'page' : undefined" :aria-describedby="splitCoverageShown ? `${domIdPrefix}split-coverage` : undefined" @click="navigateContext('saved')"><span class="split-label">{{ mailbox.savedSplit.value?.name }}</span> <span v-if="splitBadge(mailbox.savedTotal.value)" class="split-count">{{ splitBadge(mailbox.savedTotal.value) }}</span></button>
          </nav>
          <!-- Coverage qualifies the counts, so it lives on them: the tabs'
               accessible description and the nav's hover title. -->
          <p v-if="splitCoverageShown" :id="`${domIdPrefix}split-coverage`" class="visually-hidden" role="note" data-test="split-coverage">{{ SPLIT_COVERAGE }}</p>
          <!-- Active list filters stay visible in words, never only as a pressed glyph. -->
          <span v-if="accountReady && mailbox.unreadOnly.value" class="header-filter" role="status" data-test="unread-filter-status">Unread only</span>
          <span v-if="starredFilterShown && mailbox.starredOnly.value" class="header-filter" data-test="starred-filter-status">Starred only</span>
        </div>
        <div class="header-trail">
          <!-- Armed g-chord hint: always-present polite status so the change is
               announced; empty (display: none) when idle. It grows leftward in
               the trail, so the glyphs never move. -->
          <span class="chord-hint" role="status" data-test="chord-hint"><template v-if="goPending"><span aria-hidden="true">g…</span><span class="visually-hidden">{{ goHintLabel }}</span></template></span>
          <p v-if="props.mode === 'browser-preview'" class="header-note preview-tag" data-test="preview-banner" role="note" :title="BROWSER_PREVIEW_DISCLOSURE"><span aria-hidden="true">Preview · in-memory</span><span class="visually-hidden">{{ BROWSER_PREVIEW_DISCLOSURE }}</span></p>
          <p v-if="gmailMode && !mailboxActionsEnabled" class="header-note" data-test="mailbox-access-hint">
            {{ accountStatus?.mutationAccess === 'upgrading' ? 'Mailbox permission pending' : 'Gmail is read-only' }}
            <button type="button" class="header-link" @click="openDrawer('account')">Review access<span class="visually-hidden"> in Account</span></button>
          </p>
          <span ref="readerActionsHost" class="reader-actions-host"></span>
          <button v-if="history.length && !readerOpen" type="button" class="header-glyph" data-test="context-back" title="Back to previous context" @click="executeAction('back')"><HeaderGlyph name="back" /><span class="visually-hidden">Back to previous context</span></button>
          <button v-if="remindersSupported" type="button" class="header-glyph" :ref="setToggleRef('reminders')" title="Reminders (G then H)" @click="executeAction('reminders')"><HeaderGlyph name="reminders" /><span class="visually-hidden">Reminders</span></button>
          <button v-if="starredFilterShown" type="button" class="header-glyph" data-test="starred-filter" title="Starred only (cached)" :aria-pressed="mailbox.starredOnly.value" :disabled="mailbox.listState.value !== 'ready'" @click="toggleStarFilter()"><HeaderGlyph name="star" :filled="mailbox.starredOnly.value" /><span class="visually-hidden">Starred only (cached)</span></button>
          <button type="button" class="header-glyph" data-test="palette-trigger" ref="paletteButton" title="Commands (Cmd+K in native app)" @click="openOverlay('palette')"><HeaderGlyph name="commands" /><span class="visually-hidden">Commands</span></button>
          <button v-if="accountId" type="button" class="header-glyph" :disabled="!actionAvailable('compose')" data-test="compose-trigger" :title="actionLabel('compose')" aria-label="Compose new local draft (C)" @click="executeAction('compose')"><HeaderGlyph name="compose" /><span class="visually-hidden">Compose new local draft</span></button>
          <button v-if="accountId" type="button" class="header-glyph" :disabled="!actionAvailable('search')" data-test="search-trigger" :title="actionLabel('search')" @click="executeAction('search')"><HeaderGlyph name="search" /><span class="visually-hidden">Search</span></button>
        </div>
        <SplitEditor ref="splitEditor" v-if="editingSplit && accountReady && !readerOpen && !drawer" class="header-row" :split="mailbox.savedSplit.value" :busy="mailbox.splitBusy.value" :error="!!mailbox.splitError.value" @save="saveSplit" @cancel="closeSplitEditor" />
        <p v-if="mailbox.splitError.value && !editingSplit" class="header-row header-alert" role="alert">Saved split unavailable. <button type="button" @click="mailbox.refresh()">Retry split</button></p>
        <!-- Selection count announcement: the visible count lives in the
             SelectionBar; this keeps the existing polite announcement. -->
        <p v-if="selectedCount > 0" class="visually-hidden" role="status" data-test="selection-live">{{ selectedCount }} selected</p>
      </header>

      <!-- Static in-flow notices between the header and the list (list column
           only): context coverage and draft recovery. Lines that come and go
           with triage keys live in the bottom dock instead (.list-dock). -->
      <div class="list-notices">
        <div
          v-if="drawer !== 'drafts' && (drafts.closeSetupError.value || drafts.closeRetryAvailable.value || (drafts.isVisible.value && drafts.error.value))"
          role="alert"
          class="recovery-banner draft-close-recovery"
        >
          <p v-if="drafts.closeSetupError.value">Close protection could not be initialized: {{ drafts.closeSetupError.value }}</p>
          <p v-else-if="drafts.closeRetryAvailable.value">{{ drafts.closeError.value }}</p>
          <p v-else>The local draft editor needs attention.</p>
          <button v-if="drafts.closeSetupError.value" type="button" data-test="retry-close-setup" @click="drafts.retryCloseSetup()">Retry close protection</button>
          <button v-if="drafts.closeRetryAvailable.value" type="button" data-test="retry-close" @click="drafts.retryClose()">Retry close request</button>
          <button v-if="drafts.isVisible.value && drafts.error.value" type="button" data-test="draft-attention-open" @click="openDrawer('drafts')">Open drafts</button>
        </div>

        <p v-if="mailbox.context.value === 'starred'" class="cached-coverage" role="note" data-test="starred-coverage">Local cache only — not provider-complete Starred. Total unknown. Unknown star facts are not treated as unstarred.</p>
        <p v-if="mailbox.context.value === 'done'" class="cached-coverage" role="note" data-test="done-coverage">Local cache only — not provider-complete Done or All Mail. {{ mailbox.exactTotal.value === null ? 'Total unknown.' : `${mailbox.exactTotal.value} known locally.` }} <template v-if="mailbox.lastSyncedAt.value">Last synced <FullDate :at="mailbox.lastSyncedAt.value" />.</template><template v-else>Last sync unknown.</template></p>
      </div>
      <section v-if="!accountReady" class="account-gate" aria-label="Account">
        <p
          v-if="mailbox.accountState.value === 'loading' && mailbox.listState.value !== 'error'"
          data-test="account-loading"
        >Determining account mode…</p>
        <div v-else class="recovery-banner" data-test="account-error">
          <p v-if="mailbox.accountState.value === 'error'" role="alert">
            Could not determine the account status:
            {{ mailbox.accountError.value ? errorText(mailbox.accountError.value) : 'unknown error' }}.
          </p>
          <p v-else role="alert">
            Could not subscribe to or load the inbox:
            {{ mailbox.listError.value ? errorText(mailbox.listError.value) : 'unknown error' }}.
          </p>
          <button type="button" data-test="account-retry" @click="mailbox.refresh()">Retry</button>
        </div>
      </section>
      <template v-else>
        <!-- Icon rail (DESIGN.md "Rail"): 40px. Inbox is the 28px home circle on
             the split-tab line; the other mail destinations sit in the Inkwell
             pill from the header's bottom edge, its first glyph on the first
             list line; utilities sit at the bottom. Labels stay in the
             accessibility tree, as the hover title, and as a keyboard
             tooltip (.rail-label, shown on :focus-visible). -->
        <nav class="rail" aria-label="Mail navigation">
          <button
            type="button"
            class="rail-item rail-home rail-inbox"
            data-test="rail-inbox"
            :aria-current="!readerOpen && drawer === null && mailbox.context.value === 'inbox' ? 'page' : undefined"
            :title="actionLabel('inbox')" @click="executeAction('inbox')"
          ><PaneGlyph name="inbox" /><span class="rail-label">Inbox</span></button>
          <div v-if="accountId || gmailMode || props.mode === 'browser-preview'" class="rail-well" data-test="rail-well">
            <button v-if="accountId && gmailMode" type="button" class="rail-item" data-test="rail-starred" :title="actionLabel('starred')" :aria-current="mailbox.context.value === 'starred' && !readerOpen ? 'page' : undefined" @click="executeAction('starred')"><HeaderGlyph name="star" /><span class="rail-label">Starred</span></button>
            <button v-if="accountId" type="button" class="rail-item" data-test="rail-done" :title="actionLabel('done')" :aria-current="mailbox.context.value === 'done' && !readerOpen ? 'page' : undefined" @click="executeAction('done')"><PaneGlyph name="done" /><span class="rail-label">Cached Done</span></button>
            <button v-if="gmailMode || props.mode === 'browser-preview'" type="button" class="rail-item" data-test="rail-destinations" :ref="setToggleRef('destinations')" title="Provider mail (read only)" :aria-expanded="drawer === 'destinations'" @click="toggleDrawer('destinations')"><PaneGlyph name="provider" /><span class="rail-label">Provider mail</span></button>
            <button v-if="gmailMode && accountId" type="button" class="rail-item" data-test="rail-trash" :ref="setToggleRef('trash')" :title="actionLabel('trash')" :aria-expanded="drawer === 'trash'" @click="toggleDrawer('trash')"><PaneGlyph name="trash" /><span class="rail-label">Cached Trash</span></button>
          </div>
          <span class="rail-spacer" aria-hidden="true"></span>
          <div class="rail-utilities">
            <button
              v-if="gmailMode && accountStatus"
              type="button"
              class="rail-item"
              data-test="rail-account"
              :title="actionLabel('account')"
              :ref="setToggleRef('account')"
              :aria-expanded="drawer === 'account'"
              @click="toggleDrawer('account')"
            ><PaneGlyph name="account" /><span class="rail-label">Account</span></button>
            <!-- Unresolved operations (pending or outcome unknown) have no other
                 glanceable home since the header status line was removed: a
                 count badge on Activity, described in words for AT and hover. -->
            <button
              type="button"
              class="rail-item"
              data-test="rail-activity"
              :title="unresolvedSummary ? `${actionLabel('activity')} — ${unresolvedSummary}` : actionLabel('activity')"
              :ref="setToggleRef('activity')"
              :aria-expanded="drawer === 'activity'"
              :aria-describedby="unresolvedSummary ? `${domIdPrefix}rail-activity-unresolved` : undefined"
              @click="toggleDrawer('activity')"
            ><PaneGlyph name="activity" /><span class="rail-label">Activity</span><span v-if="unresolvedCount > 0" class="rail-badge" aria-hidden="true" data-test="rail-activity-badge">{{ unresolvedCount > 99 ? '99+' : unresolvedCount }}</span></button>
            <span v-if="unresolvedSummary" :id="`${domIdPrefix}rail-activity-unresolved`" class="visually-hidden" data-test="pending-count">{{ unresolvedSummary }}</span>
            <button
              v-if="accountId"
              type="button"
              class="rail-item"
              data-test="rail-drafts"
              :title="actionLabel('drafts')"
              :ref="setToggleRef('drafts')"
              :aria-expanded="drawer === 'drafts'"
              @click="toggleDrawer('drafts')"
            ><PaneGlyph name="drafts" /><span class="rail-label">Drafts</span></button>
            <button
              v-if="!wideViewport"
              type="button"
              class="rail-item"
              data-test="contact-disclosure"
              ref="contactDisclosureButton"
              title="Contact context"
              :aria-expanded="contactDisclosure"
              @click="toggleContactDisclosure()"
            ><PaneGlyph name="contact" /><span class="rail-label">Contact</span></button>
          </div>
        </nav>

        <section class="central" :aria-label="readerOpen ? 'Reader' : composeCardOpen ? 'New Message' : 'Conversation list'" :inert="centralCovered || undefined" data-test="central-surface">
          <form v-if="(searchVisible || mailbox.context.value === 'search') && !readerOpen && !composeCardOpen" class="mail-search" role="search" @submit.prevent="submitSearch()">
            <label for="mail-query">Find mail</label>
            <div class="mail-search-entry">
              <input id="mail-query" ref="searchInput" v-model="searchDraft" type="search" maxlength="512" aria-describedby="search-help" data-test="search-input" @keydown.esc.stop.prevent="searchVisible = false; mailbox.context.value === 'search' ? contextBack() : focusFocusedRow()" />
              <button type="submit" data-test="search-submit">Search</button>
              <button v-if="mailbox.context.value === 'search'" type="button" @click="contextBack()">Back to previous context</button>
            </div>
            <label class="search-cache-toggle"><input v-model="cachedSearch" type="checkbox" /> Cached mail only</label>
            <p id="search-help">Use from:, to:, subject:, straight-quoted phrases, AND, OR, or -exclusions. AND binds before OR. Dates, labels, Cc/Bcc and parentheses are not supported.</p>
            <p v-if="mailbox.context.value === 'search'" role="status" data-test="search-coverage">{{ mailbox.listState.value === 'loading' ? 'Searching… coverage not yet known.' : mailbox.listState.value === 'error' ? 'Search did not complete. Retry, edit the query, or choose cached mail only.' : mailbox.searchCoverage.value === 'cached_incomplete' ? 'Cached content only — incomplete mailbox coverage. Missing or HTML-only content may not match.' : 'Online · scans 20 mailbox candidates per page, including older archived mail. Spam/Trash excluded. A page can have no matches; continue to scan older mail.' }}</p>
            <p v-if="mailbox.listError.value && mailbox.listState.value === 'ready'" role="alert">{{ errorText(mailbox.listError.value) }}</p>
          </form>
          <!-- Inline compose card: while a new-message editor is active and no
               reader is open, the card replaces the list in the central surface
               (list OR reader OR compose card). It is in-flow — no backdrop, no
               dimming — so the rail, header and contact pane stay visible and
               non-inert while composing. -->
          <ComposeCard
            v-if="composeCardOpen && !readerOpen"
            :active-ref="drafts.activeRef.value"
            :source="drafts.activeSource.value"
            :content="drafts.content.value"
            :status="drafts.statusLabel.value"
            :creating="drafts.creating.value"
            :saving="drafts.saving.value"
            :conflict="drafts.conflict.value"
            :error="drafts.error.value"
            :create-error="drafts.createError.value"
            :deleting="drafts.deleting.value"
            :closing="drafts.closingForWindow.value"
            :transitioning="drafts.transitioning.value"
            :delete-pending="drafts.deletePending.value"
            :confirm-discard="drafts.confirmDiscard.value"
            :discard-busy="drafts.discardBusy.value"
            :confirm-reload="drafts.confirmReload.value"
            :copy-pending="drafts.copyPending.value"
            :recovery-required="drafts.recoveryRequired.value"
            :can-cancel-reply-preparation="drafts.canCancelReplyPreparation.value"
            :close-error="drafts.closeError.value"
            @close-editor="drafts.flushAndClose()"
            @set-field="drafts.setContent"
            @retry="drafts.retrySave()"
            @ask-discard="drafts.askDiscard()"
            @confirm-discard="drafts.discard()"
            @cancel-discard="drafts.cancelDiscard()"
            @ask-reload="drafts.confirmReload.value = true"
            @confirm-reload="drafts.reloadSaved()"
            @cancel-reload="drafts.cancelReload()"
            @save-as-new="drafts.saveAsNew()"
            @cancel-reply-preparation="drafts.cancelReplyPreparation()"
          />
          <template v-else-if="!readerOpen">
            <p v-if="mailbox.listState.value === 'loading'" class="list-state" data-test="inbox-loading">Loading {{ contextTitle }}…</p>
            <div v-else-if="mailbox.listState.value === 'error'" class="recovery-banner" data-test="inbox-error">
              <p role="alert">Could not load {{ contextTitle }}: {{ mailbox.listError.value ? errorText(mailbox.listError.value) : 'unknown error' }}.</p>
              <button type="button" data-test="inbox-retry" @click="mailbox.refresh()">Retry</button>
            </div>
            <p
              v-else-if="mailbox.conversations.value.length === 0"
              class="list-state"
              data-test="inbox-empty"
              ref="emptyState"
              tabindex="-1"
            >
              {{ mailbox.context.value === 'search' ? (mailbox.nextCursor.value ? 'No matches on this candidate page. Continue scanning older mail below.' : 'No matching conversations in the searched content.') : mailbox.unreadOnly.value ? 'No known unread conversations in this view. Use Commands → Show all conversations to turn off the unread filter; unknown read states are not included.' : mailbox.starredOnly.value ? 'No known starred conversations in this cached view; unknown facts and uncached mail are not included.' : mailbox.context.value === 'saved' ? 'No Inbox conversations match this saved split. Edit the sender or domain criteria, or return to Inbox.' : mailbox.context.value === 'inbox' ? 'No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.' : mailbox.nextCursor.value ? 'No conversations on this cache page; more cached candidates are available.' : mailbox.context.value === 'starred' ? 'No known starred conversations in this local cache; unknown and uncached mail is not included.' : 'No known archived conversations in this local cache.' }}
            </p>
            <InboxList
              v-else
              ref="inboxList"
              :rows="mailbox.conversations.value"
              :context="mailbox.context.value"
              :focused-ref="mailbox.focusedRef.value"
              :actions-enabled="mailboxActionsEnabled"
              :show-read-state="gmailMode"
              :show-read-controls="gmailActionsEnabled"
              :selected-refs="mailbox.selectedRefs.value"
              @focus="mailbox.focusConversation($event)"
              @open="executeAction('open', $event)"
              @archive="executeAction('archive', $event)"
              @unarchive="executeAction('unarchive', $event)"
              @set-read="(target, read) => executeAction(read ? 'read' : 'unread', target)"
              @select-toggle="toggleRowSelection"
              @select-range="rangeSelectRow"
            />
            <button v-if="mailbox.nextCursor.value" type="button" class="list-more" :disabled="mailbox.loadingMore.value || mailbox.listState.value !== 'ready'" data-test="done-more" @click="mailbox.loadMore()">{{ mailbox.context.value === 'search' ? 'Continue searching older mail' : `Load more ${contextTitle}` }}</button>
          </template>
          <section v-else class="reader-pane" aria-label="Reader">
            <p
              v-if="selectedCount > 0"
              class="reader-selection-scope"
              role="note"
              data-test="reader-selection-scope"
            >{{ selectedCount }} selected — bulk actions apply to the selection, not only this conversation.</p>
            <div v-if="mailbox.listState.value === 'error'" role="alert" class="recovery-banner" data-test="reader-navigation-error">
              Could not refresh the originating list: {{ mailbox.listError.value ? errorText(mailbox.listError.value) : 'unknown error' }}.
              Conversation navigation is paused. <button type="button" @click="mailbox.refresh()">Retry list</button>
            </div>
            <ReaderView
              ref="readerView"
              :conversation="mailbox.conversation.value ?? mailbox.heldConversation.value"
              :loading-identity="readerLoadingIdentity"
              :state="mailbox.detailState.value"
              :error="mailbox.detailError.value"
              :command-in-flight="mailbox.commandInFlight.value || mailbox.bulkUnresolved.value"
              :open-ref="mailbox.openRef.value"
              :navigation-unavailable="mailbox.context.value !== 'inbox' && mailbox.listState.value === 'error'"
              :read-only="trashReader || (gmailMode && !mailboxActionsEnabled)"
              :browsing-only="trashReader"
              :show-read-controls="gmailActionsEnabled && !trashReader"
              :selection-count="selectedCount"
              :selection-context="mailbox.context.value"
              :back-host="readerBackHost"
              :actions-host="readerActionsHost"
              :can-move-prev="canMoveReaderPrev"
              :can-move-next="canMoveReaderNext"
              @close="executeAction('back')"
              @move="moveReaderConversation"
              @archive="executeAction('archive')"
              @unarchive="executeAction('unarchive')"
              @set-read="executeAction($event ? 'read' : 'unread')"
              @prepare-reply="prepareReply"
              @attachments="openAttachments"
              @active-message="onReaderActiveMessage"
              @contact-override="onReaderContactOverride"
            />
            <!-- Inline reply composer docked at the bottom of the reader pane:
                 the thread stays visible above it. Wired directly to the shared
                 drafts state, exactly like the DraftsPanel mount below. -->
            <ReplyComposer
              v-if="replyComposerOpen && readerOpen"
              :recipient-label="replyRecipientLabel"
              :quoted-snippet="quotedSnippet"
              :active-ref="drafts.activeRef.value"
              :source="drafts.activeSource.value"
              :content="drafts.content.value"
              :status="drafts.statusLabel.value"
              :visible="drafts.isVisible.value"
              :creating="drafts.creating.value"
              :saving="drafts.saving.value"
              :conflict="drafts.conflict.value"
              :error="drafts.error.value"
              :create-error="drafts.createError.value"
              :deleting="drafts.deleting.value"
              :closing="drafts.closingForWindow.value"
              :transitioning="drafts.transitioning.value"
              :delete-pending="drafts.deletePending.value"
              :confirm-discard="drafts.confirmDiscard.value"
              :discard-busy="drafts.discardBusy.value"
              :confirm-reload="drafts.confirmReload.value"
              :copy-pending="drafts.copyPending.value"
              :recovery-required="drafts.recoveryRequired.value"
              :can-cancel-reply-preparation="drafts.canCancelReplyPreparation.value"
              :close-error="drafts.closeError.value"
              @close-editor="drafts.flushAndClose()"
              @set-field="drafts.setContent"
              @retry="drafts.retrySave()"
              @ask-discard="drafts.askDiscard()"
              @confirm-discard="drafts.discard()"
              @cancel-discard="drafts.cancelDiscard()"
              @ask-reload="drafts.confirmReload.value = true"
              @confirm-reload="drafts.reloadSaved()"
              @cancel-reload="drafts.cancelReload()"
              @save-as-new="drafts.saveAsNew()"
              @cancel-reply-preparation="drafts.cancelReplyPreparation()"
            />
            <!-- A new-message editor while the reader is open docks the same
                 inline compose card at the bottom of the reader pane, exactly
                 like the reply composer above it. -->
            <ComposeCard
              v-if="composeCardOpen && readerOpen"
              :active-ref="drafts.activeRef.value"
              :source="drafts.activeSource.value"
              :content="drafts.content.value"
              :status="drafts.statusLabel.value"
              :creating="drafts.creating.value"
              :saving="drafts.saving.value"
              :conflict="drafts.conflict.value"
              :error="drafts.error.value"
              :create-error="drafts.createError.value"
              :deleting="drafts.deleting.value"
              :closing="drafts.closingForWindow.value"
              :transitioning="drafts.transitioning.value"
              :delete-pending="drafts.deletePending.value"
              :confirm-discard="drafts.confirmDiscard.value"
              :discard-busy="drafts.discardBusy.value"
              :confirm-reload="drafts.confirmReload.value"
              :copy-pending="drafts.copyPending.value"
              :recovery-required="drafts.recoveryRequired.value"
              :can-cancel-reply-preparation="drafts.canCancelReplyPreparation.value"
              :close-error="drafts.closeError.value"
              @close-editor="drafts.flushAndClose()"
              @set-field="drafts.setContent"
              @retry="drafts.retrySave()"
              @ask-discard="drafts.askDiscard()"
              @confirm-discard="drafts.discard()"
              @cancel-discard="drafts.cancelDiscard()"
              @ask-reload="drafts.confirmReload.value = true"
              @confirm-reload="drafts.reloadSaved()"
              @cancel-reload="drafts.cancelReload()"
              @save-as-new="drafts.saveAsNew()"
              @cancel-reply-preparation="drafts.cancelReplyPreparation()"
            />
          </section>
        </section>

        <!-- The fixed drawer overlays this column too; its copy controls must
             not stay focusable while covered (same inert contract as central). -->
        <aside
          v-if="wideViewport"
          class="contact-column"
          data-test="contact-column"
          tabindex="-1"
          ref="contactColumnEl"
          :inert="centralCovered || undefined"
        >
          <ContactPane :contact="contact" :loading="readerLoading" :context="contactContext" :recent="recentMail" :compose-target="composeTarget" @search-sender="senderSearch" @open-recent="openRecent" />
        </aside>

        <div
          v-if="drawer"
          class="utility-drawer"
          role="region"
          tabindex="-1"
          ref="drawerEl"
          :aria-label="drawerTitles[drawer]"
          data-test="utility-drawer"
        >
          <header class="drawer-header">
            <h2>{{ drawerTitles[drawer] }}</h2>
            <button type="button" data-test="drawer-close" @click="closeDrawer()">Close</button>
          </header>
          <ProviderDestinations v-if="drawer === 'destinations' && accountId" :key="accountId" :client="props.client" :account-id="accountId" />
          <!-- No connected account (never configured, or disconnected while this
               surface was open): the capability needs an account identity, so
               render an explicit account-required state instead of an empty drawer. -->
          <p v-else-if="drawer === 'destinations'" role="note" data-test="destinations-account-required">Provider mail needs a connected Gmail account. Connect one from Account first.</p>
          <RemindersPanel v-if="drawer === 'reminders' && remindersSupported" :key="reminderTarget ? `${reminderTarget.accountId}:${reminderTarget.conversationId}` : 'destination'" :client="props.client" :target="reminderTarget" :initial-destination="reminderDestination" @destination-change="reminderDestination = $event" @open="openReminderConversation" />
          <CachedTrashPanel v-if="drawer === 'trash' && accountId && gmailMode" :key="accountId" :client="client" :account-id="accountId" :state="trashState" @open="openFromTrash" />
          <AccountPanel
            v-if="drawer === 'account' && accountStatus"
            :status="accountStatus"
            :busy="mailbox.accountBusy.value"
            :transitioning="drafts.transitioning.value"
            :action-error="mailbox.lastCommandError.value"
            @connect="connectAccount()"
            @disconnect="disconnectAccount()"
            @sync="mailbox.requestSync()"
            @enable-actions="mailbox.enableMailboxActions()"
            @cancel-upgrade="mailbox.cancelMailboxActionUpgrade()"
          />
          <p v-if="drawer === 'activity' && mailbox.activityError.value" role="alert">Could not refresh Activity. <button type="button" @click="mailbox.refresh()">Retry</button></p>
          <ActivityPanel
            v-if="drawer === 'activity'"
            :activity="mailbox.activity.value"
            :actions-enabled="mailboxActionsEnabled && !mailbox.commandInFlight.value && !mailbox.bulkUnresolved.value"
            :gmail-mode="gmailMode"
            :groups="mailbox.recentGroups.value"
            :groups-error="mailbox.groupsError.value"
            :groups-has-more="mailbox.groupsHasMore.value"
            :groups-loading-more="mailbox.groupsLoadingMore.value"
            :group-detail="mailbox.groupDetail.value"
            :group-detail-error="mailbox.groupDetailError.value"
            :expanded-request-id="expandedGroupRequestId"
            @open="openFromActivity($event)"
            @unarchive="unarchiveFromActivity"
            @retry="retryFromActivity"
            @open-group="openActivityGroup"
            @load-more-groups="mailbox.loadMoreGroups()"
            @retry-groups="mailbox.refreshGroups()"
            @retry-group-detail="expandedGroupRequestId && mailbox.openGroupDetail(expandedGroupRequestId)"
            @undo-group="(groupId) => mailbox.undoGroupById(groupId)"
          />
          <DraftsPanel
            v-if="drawer === 'drafts'"
            :summaries="drafts.summaries.value"
            :active-ref="drafts.activeRef.value"
            :source="drafts.activeSource.value"
            :content="drafts.content.value"
            :status="drafts.statusLabel.value"
            :visible="drafts.isVisible.value"
            :suspended-editor="!!drafts.activeRef.value && !drafts.isVisible.value"
            :creating="drafts.creating.value"
            :saving="drafts.saving.value"
            :conflict="drafts.conflict.value"
            :error="drafts.error.value"
            :create-error="drafts.createError.value"
            :deleting="drafts.deleting.value"
            :closing="drafts.closingForWindow.value"
            :transitioning="drafts.transitioning.value"
            :delete-pending="drafts.deletePending.value"
            :confirm-discard="drafts.confirmDiscard.value"
            :discard-busy="drafts.discardBusy.value"
            :confirm-reload="drafts.confirmReload.value"
            :copy-pending="drafts.copyPending.value"
            :recovery-required="drafts.recoveryRequired.value"
            :can-cancel-reply-preparation="drafts.canCancelReplyPreparation.value"
            :list-error="drafts.listError.value"
            :subscription-error="drafts.draftSubscriptionError.value"
            :close-error="drafts.closeError.value"
            :close-retry-available="drafts.closeRetryAvailable.value"
            :close-setup-error="drafts.closeSetupError.value"
            :recipient-label="drawerRecipientLabel"
            @retry-draft-subscription="drafts.retryDraftSubscription()"
            @retry-close="drafts.retryClose()"
            @retry-close-setup="drafts.retryCloseSetup()"
            @new-draft="drafts.openNew()"
            @cancel-reply-preparation="drafts.cancelReplyPreparation()"
            @open-draft="openDraft"
            @close-editor="drafts.flushAndClose()"
            @set-field="drafts.setContent"
            @retry="drafts.retrySave()"
            @ask-discard="drafts.askDiscard()"
            @confirm-discard="drafts.discard()"
            @cancel-discard="drafts.cancelDiscard()"
            @ask-reload="drafts.confirmReload.value = true"
            @confirm-reload="drafts.reloadSaved()"
            @cancel-reload="drafts.cancelReload()"
            @save-as-new="drafts.saveAsNew()"
          />
        </div>

        <div
          v-if="!wideViewport && contactDisclosure"
          class="utility-drawer contact-disclosure-panel"
          role="region"
          tabindex="-1"
          ref="contactPanelEl"
          aria-label="Contact context"
          data-test="contact-disclosure-panel"
        >
          <header class="drawer-header">
            <h2>Contact</h2>
            <button type="button" data-test="contact-disclosure-close" @click="closeContactDisclosure()">Close</button>
          </header>
          <ContactPane :contact="contact" :loading="readerLoading" :context="contactContext" :recent="recentMail" :compose-target="composeTarget" @search-sender="senderSearch" @open-recent="openRecent" />
        </div>
      </template>
      <!-- Bottom dock of the list column (DESIGN.md "In-flow Notices"): the
           selection bar, the single-slot action notice and the last command
           failure. In normal flow below the central surface, so showing or
           hiding them (x, e, z) never moves a row and never covers the focused
           row, the reader back path or the empty-Inbox state; it grows upward
           into the list viewport only. One 36px line stays reserved so the
           first notice does not resize the list. -->
      <div class="list-dock" data-test="list-dock">
        <!-- Covered by a drawer or disclosure exactly like the list it acts on. -->
        <SelectionBar
          v-if="!readerOpen && accountReady && selectedCount > 0 && mailbox.listState.value === 'ready'"
          ref="selectionBarRef"
          :inert="centralCovered || undefined"
          :count="selectedCount"
          :loaded-count="mailbox.conversations.value.length"
          :context="mailbox.context.value"
          :actions-enabled="mailboxActionsEnabled && !mailbox.bulkUnresolved.value && !mailbox.commandInFlight.value"
          :read-available="gmailActionsEnabled && !mailbox.bulkUnresolved.value && !mailbox.commandInFlight.value"
          :limit-message="mailbox.selectionNotice.value"
          @archive="bulkArchiveSelection()"
          @unarchive="bulkRestoreSelection()"
          @mark-read="bulkSetReadSelection(true)"
          @mark-unread="bulkSetReadSelection(false)"
          @select-all="mailbox.selectAllLoaded()"
          @clear="clearSelectionFromBar()"
        />
        <!-- Inert under a palette/navigator overlay exactly like header/main, so
             its Undo button cannot be reached while covered; drawer/disclosure
             guards apply through executeAction. -->
        <ActionNotice v-if="!trashReader && drawer !== 'trash'" ref="actionNoticeComponent" :notice="actionNotice" :now="nowMs" :inert="!!overlay || !!attachmentConversation || undefined" @undo="executeAction('undo')" @undo-group="onNoticeGroupAction" @dismiss-group="mailbox.dismissGroupNotice()" />
        <!-- The last command failure is an outcome the user must see: it sits
             in the same outcome slot as the action notice, as its own alert
             (not nested in the polite notice region, so it is announced once). -->
        <p v-if="commandError" class="command-error" role="alert" data-test="command-error">Last command failed: {{ errorText(commandError) }}</p>
      </div>
    </main>
    <AttachmentChooser v-if="attachmentConversation" :client="props.client" :conversation="attachmentConversation" :preview="props.mode === 'browser-preview'" :id-prefix="switchAccountLabel ? accountId ?? '' : ''" @close="closeAttachments" />
    <ActionOverlay v-if="overlay" v-model:query="overlayQuery" :id-prefix="switchAccountLabel ? accountId ?? '' : ''" :kind="overlay" :actions="availableActions" @close="closeOverlay()" @execute="executeOverlay" />
  </div>
</template>
