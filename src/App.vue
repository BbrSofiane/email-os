<script setup lang="ts">
/**
 * Gmail mailbox shell: compact browsing shell (UX-01), plain-text reader,
 * operation recovery, and explicit account/action capability gates.
 *
 * Account gate: the account status read decides fixture-vs-Gmail. While the status
 * is loading or failed, the UI renders no mailbox content at all — it never falls
 * back silently to fixture mode.
 *
 * Layout contract: a persistent narrow email rail, a compact Inbox
 * navigation/status header, one central surface that is either the list or the
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
 * - Shift+U: explicitly mark the focused/open conversation unread.
 * - Ignored with Ctrl/Meta/Alt held, during IME composition, inside text fields, and
 *   Enter/e are ignored when a button owns the key (it activates itself).
 * - While a visible draft editor exists, every mailbox shortcut is suppressed;
 *   a suspended editor behind another disclosure must not own keys. While a
 *   utility/contact disclosure is open, Escape closes it and mailbox shortcuts
 *   underneath are suppressed. Draft text has no submit/send path and is
 *   rendered only as ordinary text.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import InboxList from './components/InboxList.vue';
import ReaderView from './components/ReaderView.vue';
import ActivityPanel from './components/ActivityPanel.vue';
import AccountPanel from './components/AccountPanel.vue';
import DraftsPanel from './components/DraftsPanel.vue';
import ContactPane from './components/ContactPane.vue';
import { BROWSER_PREVIEW_DISCLOSURE } from './lib/ipc/browser-fake';
import type { ClientMode } from './lib/ipc';
import type { ConversationRef, DraftRef, DraftSource, MailClient } from './lib/ipc/client';
import { sameConversation, useMailbox } from './composables/useMailbox';
import { useDrafts } from './composables/useDrafts';

const props = defineProps<{
  client: MailClient;
  mode: ClientMode;
}>();

/** Contact context breakpoint (supervisor-approved strict value). */
const CONTACT_BREAKPOINT_PX = 1000;

type UtilityDrawer = 'account' | 'activity' | 'drafts';
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
  surface: 'inbox' | 'activity';
  /** Original entry focus reference; Back restores it (with fallbacks). */
  focusedRef: ConversationRef | null;
  /** Entry-time Inbox ordering, used to resolve a removed cursor. */
  ordering: ConversationRef[];
  anchor: ListAnchor | null;
}

const mailbox = useMailbox(props.client);
const inboxList = ref<InstanceType<typeof InboxList> | null>(null);
const emptyState = ref<HTMLElement | null>(null);

const readerOpen = computed(() => mailbox.openRef.value !== null);
const gmailMode = computed(() => mailbox.isGmail.value);
const mailboxActionsEnabled = computed(() => !gmailMode.value || mailbox.accountStatus.value?.mutationAccess === 'enabled');
const gmailActionsEnabled = computed(() => gmailMode.value && mailboxActionsEnabled.value);
const accountReady = computed(() => mailbox.accountState.value === 'ready');
const accountStatus = computed(() => mailbox.accountStatus.value);
const accountId = computed(() => accountStatus.value?.account?.accountId ?? null);
const drafts = useDrafts(props.client, accountId, props.mode);

// ---------------------------------------------------------------------------
// Utility disclosures (Account / Activity / Drafts)
// ---------------------------------------------------------------------------

const drawer = ref<UtilityDrawer | null>(null);
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
  activity: 'Operation activity',
  drafts: 'Local drafts',
};

/**
 * Leave the active drafts editor through its protected lifecycle before the
 * drawer unmounts. Returns false when closure failed and the drawer must stay
 * visible with its recovery/error controls rather than hiding an editor that
 * would otherwise silently own all mailbox shortcuts.
 */
async function releaseDraftsDrawer(): Promise<boolean> {
  if (drawer.value !== 'drafts' || !drafts.activeRef.value) return true;
  return drafts.flushAndClose();
}

async function openDrawer(name: UtilityDrawer, entry: 'drawer' | 'toggle' = 'drawer'): Promise<void> {
  // Switching away from the drafts surface must release the editor first:
  // without this guard, a user can move to another utility while the editor
  // silently owns shortcuts, and recovery controls stay hidden behind it.
  if (drawer.value === 'drafts' && name !== 'drafts') {
    if (!(await releaseDraftsDrawer())) return;
  }
  // Disclosures are mutually exclusive: opening a utility surface dismisses
  // the contact disclosure so both fixed regions never coexist.
  contactDisclosure.value = false;
  drawer.value = name;
  await nextTick();
  if (entry === 'drawer') drawerEl.value?.focus();
  else drawerToggles.get(name)?.focus();
}

async function closeDrawer(): Promise<void> {
  const closing = drawer.value;
  if (closing === 'drafts' && !(await releaseDraftsDrawer())) return; // closure failed; keep drawer visible
  drawer.value = null;
  await nextTick();
  if (closing) drawerToggles.get(closing)?.focus();
}

// A suspended (hidden) draft editor must never survive into the visible inbox:
// whenever no drawer is open and an editor is still active, bring its surface
// back so keyboard ownership and the visible panel agree.
watch(drawer, (value) => {
  if (value === null && drafts.isVisible.value && !readerOpen.value) void openDrawer('drafts');
});

function toggleDrawer(name: UtilityDrawer): void {
  if (drawer.value === name) void closeDrawer();
  else void openDrawer(name);
}

// A newly active editor routes to the drafts surface instead of a hidden pane.
watch(drafts.isVisible, (visible) => {
  if (visible && drawer.value !== 'drafts') void openDrawer('drafts');
});

// Local drafts are account-scoped: with no account there is no drafts surface.
watch(accountId, (id) => {
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
 * interaction as soon as the disclosure is dismissed.
 */
const centralCovered = computed(() => !!drawer.value || (!wideViewport.value && contactDisclosure.value));

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
      if (activeIsInWideContact) contactDisclosureButton.value?.focus();
    });
  } else if (!wasWide && event.matches) {
    contactDisclosure.value = false;
    void nextTick().then(() => {
      if (focusInNarrowContact) {
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
  if (drawer.value === 'drafts' && !contactDisclosure.value) {
    if (!(await releaseDraftsDrawer())) return;
  }
  // Disclosures are mutually exclusive: the contact disclosure replaces any
  // open utility drawer so the visible panel and keyboard owner agree.
  drawer.value = null;
  contactDisclosure.value = !contactDisclosure.value;
  void nextTick().then(() => {
    if (contactDisclosure.value) contactPanelEl.value?.focus();
    else contactDisclosureButton.value?.focus();
  });
}

async function closeContactDisclosure(): Promise<void> {
  contactDisclosure.value = false;
  await nextTick();
  contactDisclosureButton.value?.focus();
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown);
  wideQuery?.addEventListener('change', onViewportChange);
});

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown);
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

const contact = computed<ContactInfo | null>(() => {
  if (!readerOpen.value) return listContact.value;
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

// ---------------------------------------------------------------------------
// Reader origin, focus, and scroll restoration
// ---------------------------------------------------------------------------

const origin = ref<ReaderOrigin | null>(null);
const readerView = ref<InstanceType<typeof ReaderView> | null>(null);
/** Message identity that currently owns reader focus (for the contact baseline). */
const readerActiveMessageId = ref<string | null>(null);
/** Temporary participant hover/focus context from the reader. */
const contactOverride = ref<
  { ref: ConversationRef; messageId: string; displayName: string | null; mailbox: string } | null
>(null);

function captureListOrigin(surface: 'inbox' | 'activity'): void {
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
function closeReader(explicitInbox = false): void {
  const originState = origin.value;
  mailbox.closeReader();
  void (async () => {
    // An active draft editor owns attention: keep it visible rather than
    // leaving it hidden behind another disclosure or off-screen entirely.
    if (drafts.isVisible.value) {
      if (drawer.value !== 'drafts') await openDrawer('drafts');
      return;
    }
    await nextTick();
    const anchor = originState?.anchor ?? null;
    if (anchor && inboxList.value) await inboxList.value.restoreAnchor(anchor);
    if (originState && originState.surface === 'inbox' && !explicitInbox) {
      const resolved = resolveOriginFocus(originState);
      if (resolved) mailbox.focusConversation(resolved);
    }
    await focusFocusedRow(true);
    if (!explicitInbox && originState?.surface === 'activity') await openDrawer('activity');
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
  // Leaving an active drafts editor must go through its protected lifecycle;
  // on failed flush the editor and recovery controls stay visible and the
  // navigation aborts instead of hiding the buffer.
  if (drawer.value === 'drafts' && !(await releaseDraftsDrawer())) return;
  // Clear both disclosure surfaces so no overlay survives the destination.
  drawer.value = null;
  contactDisclosure.value = false;
  if (readerOpen.value) {
    // Explicit Inbox navigation keeps the list's own current focus rather than
    // restoring the saved entry reference, and never reopens Activity.
    closeReader(true);
  } else {
    await focusFocusedRow();
  }
}

async function openFocusedFromList(): Promise<void> {
  captureListOrigin('inbox');
  await mailbox.openFocused();
}

async function openRowFromList(target: ConversationRef): Promise<void> {
  if (!sameConversation(target, mailbox.focusedRef.value)) mailbox.focusConversation(target);
  await openFocusedFromList();
}

async function openFromActivity(target: ConversationRef): Promise<void> {
  // The saved Inbox anchor/entry context is captured only at the initial
  // list-to-reader entry. An Activity open while the reader is already open
  // never recaptures from the (unmounted) list — it only re-points the return
  // surface at Activity.
  if (readerOpen.value) {
    if (origin.value) origin.value = { ...origin.value, surface: 'activity' };
  } else {
    captureListOrigin('activity');
  }
  drawer.value = null;
  await mailbox.openConversationByRef(target);
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
  if (!readerOpen.value || origin.value?.surface !== 'inbox') return;
  if (mailbox.listState.value !== 'ready') return;
  const target = resolveReaderNeighbor(delta);
  if (!target) return;
  // Hidden list focus must not move; the open reference is the reader cursor.
  await mailbox.openConversationByRef(target);
}

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

async function archiveFromReader(): Promise<void> {
  const target = currentReaderTarget();
  const opened = mailbox.openRef.value;
  if (!target) return;
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
  const receipt = await mailbox.setArchived(target, true);
  // A late receipt must not drag the user back after they navigate or close.
  if (!receipt || mailbox.openRef.value !== opened || mailbox.listState.value !== 'ready') return;
  const op = mailbox.activity.value.find((item) => item.id === receipt.operationId);
  if (op?.status === 'failed') return;
  // An Activity-origin reader must not advance into unrelated Inbox mail.
  if (origin.value?.surface === 'activity') {
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

async function unarchiveFromReader(): Promise<void> {
  const target = currentReaderTarget();
  if (target) await mailbox.setArchived(target, false);
}

async function unarchiveFromActivity(target: ConversationRef): Promise<void> {
  await mailbox.setArchived(target, false);
}

async function setReadFromList(target: ConversationRef, read: boolean): Promise<void> {
  if (!gmailActionsEnabled.value) return;
  await mailbox.setRead(target, read);
}

async function setReadFromReader(read: boolean): Promise<void> {
  if (!gmailActionsEnabled.value) return;
  const target = currentReaderTarget();
  if (target) await mailbox.setRead(target, read);
}

async function markUnread(): Promise<void> {
  if (!gmailActionsEnabled.value) return;
  if (readerOpen.value) {
    const target = currentReaderTarget();
    if (target) await mailbox.setRead(target, false);
    return;
  }
  const summary = mailbox.focusedSummary.value;
  if (summary) await mailbox.setRead(summary.ref, false);
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
  if (await drafts.openNew(source)) closeReader();
}

function openDraft(ref: DraftRef): void {
  void drafts.openDraft(ref);
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
  // Only a visible composer owns all keys; a suspended editor behind another
  // disclosure must not silently keep keyboard ownership from the inbox.
  if (drafts.activeRef.value && drawer.value === 'drafts') return;
  if (event.isComposing || event.keyCode === 229) return; // IME composition
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (isEditableTarget(event.target)) return;

  const key = event.key;
  const readerIsOpen = readerOpen.value;

  if (key === 'Escape') {
    // The active disclosure gets Escape precedence; mailbox actions underneath
    // are suppressed while it is open.
    if (drawer.value) {
      event.preventDefault();
      void closeDrawer();
      return;
    }
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
      event.preventDefault();
      closeReader();
    }
    return;
  }
  if (drawer.value || (!wideViewport.value && contactDisclosure.value)) return;

  if (key === 'U' && event.shiftKey && !actionShortcutBlocked(event.target)) {
    event.preventDefault();
    void markUnread();
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
      void archiveFromReader();
    }
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
      void openFocusedFromList();
      return;
    case 'e':
      if (!mailboxActionsEnabled.value || buttonOwns(event.target)) return;
      event.preventDefault();
      void archiveFocusedRow();
      return;
    default:
      return;
  }
}

const pendingCount = computed(
  () => mailbox.activity.value.filter((op) => op.status === 'queued' || op.status === 'applying' || op.status === 'outcome_unknown').length,
);

function errorText(error: { kind: string; field?: string }): string {
  switch (error.kind) {
    case 'not_found':
      return 'not found';
    case 'invalid_request':
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
    default:
      return 'unknown error';
  }
}
</script>

<template>
  <div class="app" :data-client-mode="props.mode">
    <header class="app-header">
      <div class="app-title-row">
        <span class="rail-brand">Email</span>
        <h1 class="app-title" data-test="inbox-title">Inbox</h1>
      </div>
      <p v-if="props.mode === 'browser-preview'" class="preview-banner" data-test="preview-banner" role="note">
        {{ BROWSER_PREVIEW_DISCLOSURE }}
      </p>
      <p class="status-line" data-test="status-line">
        <span data-test="inbox-count">{{ mailbox.conversations.value.length }} in inbox</span>
        <span v-if="pendingCount > 0" data-test="pending-count">{{ pendingCount }} pending operation(s)</span>
        <span v-if="gmailActionsEnabled" data-test="read-shortcut-note">Shift+U marks the focused or open conversation unread.</span>
        <span v-if="mailbox.lastCommandError.value" role="alert" data-test="command-error">
          last command failed: {{ errorText(mailbox.lastCommandError.value) }}
        </span>
      </p>
    </header>

    <div
      v-if="drawer !== 'drafts' && (drafts.closeSetupError.value || drafts.closeRetryAvailable.value || (drafts.isVisible.value && drafts.error.value))"
      role="alert"
      class="draft-close-recovery"
    >
      <p v-if="drafts.closeSetupError.value">Close protection could not be initialized: {{ drafts.closeSetupError.value }}</p>
      <p v-else-if="drafts.closeRetryAvailable.value">{{ drafts.closeError.value }}</p>
      <p v-else>The local draft editor needs attention.</p>
      <button v-if="drafts.closeSetupError.value" type="button" data-test="retry-close-setup" @click="drafts.retryCloseSetup()">Retry close protection</button>
      <button v-if="drafts.closeRetryAvailable.value" type="button" data-test="retry-close" @click="drafts.retryClose()">Retry close request</button>
      <button v-if="drafts.isVisible.value && drafts.error.value" type="button" data-test="draft-attention-open" @click="openDrawer('drafts')">Open drafts</button>
    </div>

    <main class="app-main">
      <section v-if="!accountReady" class="account-gate" aria-label="Account">
        <p
          v-if="mailbox.accountState.value === 'loading' && mailbox.listState.value !== 'error'"
          data-test="account-loading"
        >Determining account mode…</p>
        <div v-else data-test="account-error">
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
        <nav class="rail" aria-label="Mail navigation">
          <button
            type="button"
            class="rail-item rail-inbox"
            data-test="rail-inbox"
            :aria-current="!readerOpen && drawer === null ? 'page' : undefined"
            @click="navigateToInbox()"
          >Inbox</button>
          <span class="rail-spacer" aria-hidden="true"></span>
          <button
            v-if="gmailMode && accountStatus"
            type="button"
            class="rail-item"
            data-test="rail-account"
            :ref="setToggleRef('account')"
            :aria-expanded="drawer === 'account'"
            @click="toggleDrawer('account')"
          >Account</button>
          <button
            type="button"
            class="rail-item"
            data-test="rail-activity"
            :ref="setToggleRef('activity')"
            :aria-expanded="drawer === 'activity'"
            @click="toggleDrawer('activity')"
          >Activity</button>
          <button
            v-if="accountId"
            type="button"
            class="rail-item"
            data-test="rail-drafts"
            :ref="setToggleRef('drafts')"
            :aria-expanded="drawer === 'drafts'"
            @click="toggleDrawer('drafts')"
          >Drafts</button>
          <button
            v-if="!wideViewport"
            type="button"
            class="rail-item"
            data-test="contact-disclosure"
            ref="contactDisclosureButton"
            :aria-expanded="contactDisclosure"
            @click="toggleContactDisclosure()"
          >Contact</button>
        </nav>

        <section class="central" :aria-label="readerOpen ? 'Reader' : 'Conversation list'" :inert="centralCovered || undefined" data-test="central-surface">
          <template v-if="!readerOpen">
            <p v-if="mailbox.listState.value === 'loading'" data-test="inbox-loading">Loading inbox…</p>
            <div v-else-if="mailbox.listState.value === 'error'" data-test="inbox-error">
              <p role="alert">Could not load the inbox: {{ mailbox.listError.value ? errorText(mailbox.listError.value) : 'unknown error' }}.</p>
              <button type="button" data-test="inbox-retry" @click="mailbox.refresh()">Retry</button>
            </div>
            <p
              v-else-if="mailbox.conversations.value.length === 0"
              data-test="inbox-empty"
              ref="emptyState"
              tabindex="-1"
            >
              No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.
            </p>
            <InboxList
              v-else
              ref="inboxList"
              :rows="mailbox.conversations.value"
              :focused-ref="mailbox.focusedRef.value"
              :actions-enabled="mailboxActionsEnabled"
              :show-read-state="gmailMode"
              :show-read-controls="gmailActionsEnabled"
              @focus="mailbox.focusConversation($event)"
              @open="openRowFromList"
              @archive="archiveRowFromList"
              @set-read="setReadFromList"
            />
          </template>
          <section v-else class="reader-pane" aria-label="Reader">
            <ReaderView
              ref="readerView"
              :conversation="mailbox.conversation.value"
              :state="mailbox.detailState.value"
              :error="mailbox.detailError.value"
              :command-in-flight="mailbox.inFlightCommandRef.value !== null"
              :open-ref="mailbox.openRef.value"
              :read-only="gmailMode && !mailboxActionsEnabled"
              :show-read-controls="gmailActionsEnabled"
              @close="closeReader()"
              @archive="archiveFromReader"
              @unarchive="unarchiveFromReader"
              @set-read="setReadFromReader"
              @prepare-reply="prepareReply"
              @active-message="onReaderActiveMessage"
              @contact-override="onReaderContactOverride"
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
          <ContactPane :contact="contact" :context="contactContext" />
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
          <ActivityPanel
            v-if="drawer === 'activity'"
            :activity="mailbox.activity.value"
            :actions-enabled="mailboxActionsEnabled"
            :gmail-mode="gmailMode"
            @open="openFromActivity($event)"
            @unarchive="unarchiveFromActivity"
            @retry="retryFromActivity"
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
          <ContactPane :contact="contact" :context="contactContext" />
        </div>
      </template>
    </main>
  </div>
</template>
