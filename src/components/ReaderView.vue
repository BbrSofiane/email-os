<script setup lang="ts">
/**
 * Plain-text, keyboard-first conversation reader (UX-02). Opening is read-only —
 * never marks read.
 *
 * Visit-scoped message state (active message, expansion, details disclosure,
 * scroll anchor) lives inside this mounted reader instance, keyed by
 * account+conversation reference and message ID — never by array position. It
 * survives J/K round trips and same-reference background replacements within
 * the reader session and is released when the reader closes (component
 * unmount) or the account changes.
 *
 * Archive/read controls are shown only when the authoritative capability permits them, and
 * Gmail-supplied plain-text limitations are disclosed explicitly (`unsupportedReason`,
 * `contextComplete === false`) instead of silently dropping content.
 *
 * Safety: message content is rendered exclusively through text interpolation
 * ({{ }}). No v-html, no markdown/HTML processing, no remote assets anywhere in
 * this slice — hostile markup stays literal text. Reply preparation always
 * targets the explicitly displayed latest message, never the focused message.
 *
 * Message commands (N/P/O/Shift+O, details dismissal) are exposed as narrow
 * methods for App's single keyboard dispatcher — this component never adds its
 * own window listener.
 */
import { actionLabel } from '../lib/browsing-actions';
import { computed, nextTick, reactive, ref, watch } from 'vue';
import type { Address, Conversation, ConversationRef, DraftSource, MailError, Message } from '../lib/ipc/client';
import type { DetailState } from '../composables/useMailbox';

const props = defineProps<{
  conversation: Conversation | null;
  state: DetailState;
  error: MailError | null;
  commandInFlight: boolean;
  /** The conversation reference the shell currently wants displayed. */
  openRef: ConversationRef | null;
  /** Gmail mode: archive/unarchive controls are hidden, not just disabled. */
  readOnly?: boolean;
  navigationUnavailable?: boolean;
  showReadControls?: boolean;
  /** Nonzero: shared controls dispatch to the SELECTION (§3.3), so the reader
   * offers explicit count-labelled desired-state controls instead of the open
   * conversation's single-state toggles (mixed selections included). */
  selectionCount?: number;
  selectionContext?: 'inbox' | 'done';
}>();

const emit = defineEmits<{
  close: [];
  archive: [];
  unarchive: [];
  setRead: [read: boolean];
  prepareReply: [source: DraftSource];
  /** Identity of the message that currently owns reader focus. */
  activeMessage: [messageId: string | null];
  /** Hover/focus participant context override; `null` restores the baseline. */
  contactOverride: [
    override:
      | { ref: ConversationRef; messageId: string; displayName: string | null; mailbox: string }
      | null,
  ];
}>();

const container = ref<HTMLElement | null>(null);
const scrollerEl = ref<HTMLElement | null>(null);
const messageEls = new Map<string, HTMLElement>();

/** Selected-scope toolbar mode: nonzero selection dispatches to the whole
 * selection with explicit count labels (§3.3); null keeps single behavior. */
const bulkScope = computed(() =>
  (props.selectionCount ?? 0) > 0
    ? { count: props.selectionCount!, context: props.selectionContext ?? 'inbox' }
    : null,
);

const latestMessage = computed(() => props.conversation?.messages.at(-1) ?? null);
const replyBlockedReason = computed(() => {
  if (!props.conversation || !latestMessage.value) return 'No displayed latest message is available as a reply source.';
  if (props.conversation.retainedSnapshotAt) return 'Reply preparation is blocked for a retained snapshot; current message headers cannot be verified.';
  if (props.conversation.contextComplete === false) return 'Reply preparation is blocked because this cached conversation is incomplete.';
  if (props.conversation.replyContext && props.conversation.replyContext.sourceMessageId !== latestMessage.value.id) return 'Reply preparation is blocked because cached reply headers do not match the displayed latest message.';
  return null;
});

function prepareReply(): void {
  // Reply always targets the explicitly displayed latest message; focusing an
  // older message never changes the reply contract.
  const conversation = props.conversation;
  const source = latestMessage.value;
  if (!conversation || !source || replyBlockedReason.value) return;
  emit('prepareReply', {
    kind: 'reply',
    conversation: { ...conversation.ref },
    sourceMessageId: source.id,
  });
}

function describeError(error: MailError): string {
  switch (error.kind) {
    case 'not_found':
      return 'That conversation is no longer available.';
    case 'invalid_request':
      return `The request was rejected (invalid field: ${error.field}).`;
    case 'request_id_conflict':
      return 'The request conflicted with an earlier request ID.';
    case 'storage_unavailable':
      return 'Local storage is unavailable. The operation was not confirmed.';
    case 'profile_in_use':
      return 'Another window is using this profile.';
    case 'read_only':
      return 'Gmail is read-only; archiving is unavailable.';
    case 'not_configured':
      return 'Gmail is not configured on this device.';
    case 'auth_required':
      return 'Sign-in is required; cached conversations stay readable.';
    case 'auth_cancelled':
      return 'Sign-in was cancelled.';
    case 'auth_failed':
      return 'Sign-in failed. Cached conversations stay readable.';
    case 'secrets_unavailable':
      return 'Secure credential storage is unavailable.';
    case 'network_unavailable':
      return 'The network is unavailable; cached conversations stay readable.';
    case 'rate_limited':
      return 'The provider is rate limiting. Cached conversations stay readable.';
    case 'provider_unavailable':
      return 'The mail provider is temporarily unavailable.';
    case 'invalid_provider_response':
      return 'The provider returned an unexpected response.';
    case 'busy':
      return 'A sync is already in progress. Try again shortly.';
    case 'permission_required':
      return 'Google mailbox-action permission is not enabled.';
    case 'provider_rejected':
      return 'The provider rejected this action.';
    case 'outcome_unknown':
      return 'The remote result is uncertain. Review Activity before retrying.';
    default:
      return 'Could not load the conversation.';
  }
}

// ---------------------------------------------------------------------------
// Visit-scoped message state, keyed by account+conversation
// ---------------------------------------------------------------------------

/** Viewport-relative scroll anchor: a message top plus a scrollTop fallback. */
interface MessageAnchor { messageId: string; offsetTop: number; scrollTop: number }

interface VisitState {
  activeMessageId: string | null;
  expandedIds: Set<string>;
  detailsOpenId: string | null;
  anchor: MessageAnchor | null;
  /** Message ordering this state was built against (for removed-ID resolution). */
  order: string[];
}

const visits = new Map<string, VisitState>();
/** Reactive holder for the currently displayed visit. */
const visitRef = ref<VisitState | null>(null);
let lastDataKey: string | null = null;
/**
 * Foreground activation intent, tracked separately from `lastDataKey`: a
 * loading transition that removed reader-owned focus owes the next ready
 * snapshot a message-focus restoration, even when the user reverses back to
 * the same key as the last loaded one (which would otherwise be classified as
 * an unfocused same-reference background replacement).
 */
let pendingFocusRestore = false;

function visitKey(ref: ConversationRef): string {
  return `${ref.accountId}:${ref.conversationId}`;
}

function keyOfDisplayed(): string | null {
  const conversation = props.conversation;
  const open = props.openRef;
  if (!conversation || !open) return null;
  if (conversation.ref.accountId !== open.accountId || conversation.ref.conversationId !== open.conversationId) return null;
  return visitKey(conversation.ref);
}

/**
 * Prune removed message IDs and resolve removed active/anchor IDs by the
 * surviving old neighbors (next surviving old neighbor, then previous), so a
 * background replacement can never leave a stale message target.
 */
function pruneVisit(visit: VisitState, nextIds: string[]): void {
  const present = new Set(nextIds);
  const resolve = (id: string | null): string | null => {
    if (id === null || present.has(id)) return id;
    const oldIndex = visit.order.indexOf(id);
    if (oldIndex >= 0) {
      for (let i = oldIndex + 1; i < visit.order.length; i += 1) {
        const candidate = visit.order[i]!;
        if (present.has(candidate)) return candidate;
      }
      for (let i = oldIndex - 1; i >= 0; i -= 1) {
        const candidate = visit.order[i]!;
        if (present.has(candidate)) return candidate;
      }
    }
    return null;
  };
  visit.activeMessageId = resolve(visit.activeMessageId);
  visit.detailsOpenId = visit.detailsOpenId !== null && present.has(visit.detailsOpenId) ? visit.detailsOpenId : null;
  if (visit.anchor && !present.has(visit.anchor.messageId)) {
    const resolved = resolve(visit.anchor.messageId);
    visit.anchor = resolved
      ? { ...visit.anchor, messageId: resolved }
      : { messageId: '', offsetTop: 0, scrollTop: visit.anchor.scrollTop };
  }
  visit.expandedIds = new Set([...visit.expandedIds].filter((id) => present.has(id)));
  visit.order = [...nextIds];
}

function captureScrollAnchor(visit: VisitState): MessageAnchor | null {
  const scroller = scrollerEl.value;
  if (!scroller || visit.order.length === 0) return null;
  const scrollerTop = scroller.getBoundingClientRect().top;
  for (const id of visit.order) {
    const el = messageEls.get(id);
    if (!el) continue;
    const top = el.getBoundingClientRect().top;
    if (top >= scrollerTop - 1 || id === visit.order[visit.order.length - 1]) {
      return { messageId: id, offsetTop: top - scrollerTop, scrollTop: scroller.scrollTop };
    }
  }
  return null;
}

function restoreScroll(visit: VisitState, scroller: HTMLElement): void {
  const anchor = visit.anchor;
  if (!anchor) return;
  const el = messageEls.get(anchor.messageId);
  if (!el || scroller.clientHeight === 0 || !anchor.messageId) {
    // Fallback: the anchored message no longer exists; restore the raw offset.
    scroller.scrollTop = anchor.scrollTop;
    return;
  }
  const relative = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  scroller.scrollTop = scroller.scrollTop + (relative - anchor.offsetTop);
}

function focusElement(el: HTMLElement | null | undefined, reveal: boolean): boolean {
  if (!el || !el.isConnected) return false;
  // Never move focus into an inert ancestor (e.g. a drawer covering the reader).
  if (el.closest('[inert]')) return false;
  el.focus({ preventScroll: true });
  if (reveal && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  return document.activeElement === el;
}

function focusMessageToggle(messageId: string, reveal: boolean): void {
  focusElement(messageEls.get(messageId)?.querySelector<HTMLElement>('.message-toggle'), reveal);
}

type ComponentPublicInstance = import('vue').ComponentPublicInstance;

function setMessageEl(el: Element | ComponentPublicInstance | null, messageId: string): void {
  if (el instanceof HTMLElement) messageEls.set(messageId, el);
  else messageEls.delete(messageId);
}

let updateSeq = 0;

/**
 * Loading teardown: if reader-owned focus was dropped to <body> because the
 * loading placeholder removed the focused message control, park it on the
 * persistent reader article. Never steals toolbar, rail, overlay, or other
 * unrelated focus — including a surface the user moved to while this delayed
 * work was in flight — respects inert ancestors, and is invalidated by any
 * newer update (a ready snapshot takes over via schedulePostUpdate).
 */
async function scheduleLoadingFocus(seq: number): Promise<void> {
  await nextTick();
  if (seq !== updateSeq) return;
  // Focus already lives on a surviving reader surface (e.g. the toolbar);
  // leave it exactly where it is.
  if (container.value?.contains(document.activeElement) ?? false) return;
  // Park only over focus that fell to <body> when the message control was
  // torn down: a still-focused rail/outside button keeps its focus.
  const active = document.activeElement;
  if (active !== null && active !== document.body) return;
  focusElement(container.value, false);
}

/**
 * Post-update work for one conversation snapshot: restore the visit's scroll
 * position and, on a visit switch, focus the visit's active message toggle
 * (the article stays the empty/error fallback). The delayed focus is guarded
 * against a changed reference, a newer update, and inert ancestors.
 */
async function schedulePostUpdate(key: string, focusIntent: boolean, readerHadFocus: boolean, restoringAfterLoading: boolean): Promise<void> {
  const seq = ++updateSeq;
  await nextTick();
  if (seq !== updateSeq || keyOfDisplayed() !== key) return;
  const visit = visits.get(key);
  const scroller = scrollerEl.value;
  if (visit && scroller) restoreScroll(visit, scroller);
  const messages = props.conversation?.messages ?? [];
  // A replacement that removed the focused message element must not drop
  // reader focus to <body>; resolve it to the visit's active message toggle.
  if (!focusIntent && readerHadFocus && !(container.value?.contains(document.activeElement) ?? false)) {
    if (messages.length === 0 || !visit?.activeMessageId) {
      focusElement(container.value, false);
      return;
    }
    // Scroll geometry was just restored; do not let focus-reveal shift it.
    focusMessageToggle(visit.activeMessageId, false);
    return;
  }
  if (!focusIntent) return;
  if (restoringAfterLoading) {
    // A delayed reversal must not yank focus from a surface the user moved to
    // while the loading placeholder was up: only our own parked article focus
    // (or focus that fell to <body>) may be promoted to a restoration target.
    // This ownership check must come BEFORE choosing the target so it also
    // protects the empty-visit article fallback, not just the message toggle.
    const active = document.activeElement;
    const inReader = active instanceof Node && (container.value?.contains(active) ?? false);
    if (inReader ? active !== container.value : active !== null && active !== document.body) return;
  }
  if (messages.length === 0 || !visit?.activeMessageId) {
    // Empty/error fallback: the reader article keeps focus instead of a
    // message control that does not exist.
    focusElement(container.value, false);
    return;
  }
  // A revisit with a saved anchor is positioned by restoreScroll; focusing
  // must not reveal-scroll and destroy the restored reading offset. A first
  // visit has no geometry yet, so reveal the focused header as needed.
  focusMessageToggle(visit.activeMessageId, visit.anchor === null);
}

watch(
  () => props.conversation,
  (conversation) => {
    // Capture the outgoing visit's scroll geometry BEFORE any DOM teardown,
    // including the foreground null/loading transition: useMailbox clears the
    // conversation before the next detail arrives, and by the following
    // non-null update the outgoing message elements are already gone. This
    // watcher runs pre-flush, so the old elements are still live here. The
    // capture is a no-op once the elements are gone, so a loading/empty DOM
    // can never overwrite a saved anchor.
    const outgoing = lastDataKey !== null ? visits.get(lastDataKey) : null;
    if (outgoing && scrollerEl.value) {
      const captured = captureScrollAnchor(outgoing);
      if (captured) outgoing.anchor = captured;
    }
    const readerHadFocus = container.value?.contains(document.activeElement) ?? false;
    if (!conversation) {
      // Loading/error: visit state must not be erased. Only reader-owned
      // focus that is about to lose its message control is parked on the
      // persistent reader article (not <body>) and remembered for message
      // focus restoration on the next ready snapshot even when it resolves to
      // the last loaded key (immediate reversal). Focus that already lives
      // elsewhere (rail/overlay/outside) is never scheduled over.
      const seq = ++updateSeq;
      if (readerHadFocus) {
        pendingFocusRestore = true;
        void scheduleLoadingFocus(seq);
      }
      return;
    }
    const key = visitKey(conversation.ref);
    const previousKey = lastDataKey;
    const ids = conversation.messages.map((message) => message.id);
    let visit = visits.get(key);
    if (!visit) {
      const newest = ids[ids.length - 1] ?? null;
      // Reactive so state mutations (pruning resolution, command handlers)
      // publish through visitRef to templates and the active-ID watcher.
      visit = reactive<VisitState>({
        activeMessageId: newest,
        expandedIds: new Set(newest === null ? [] : [newest]),
        detailsOpenId: null,
        anchor: null,
        order: [...ids],
      });
      visits.set(key, visit);
    } else {
      pruneVisit(visit, ids);
    }
    visitRef.value = visit;
    lastDataKey = key;
    // Foreground activation is tracked separately from the last loaded key:
    // a reversal back to the same key still owes a focus restoration.
    const restoringAfterLoading = pendingFocusRestore;
    pendingFocusRestore = false;
    // A same-reference replacement never changes focus; a visit switch or a
    // reversed loading transition does.
    void schedulePostUpdate(key, key !== previousKey || restoringAfterLoading, readerHadFocus, restoringAfterLoading);
  },
  { immediate: true, flush: 'pre' },
);

/** Loading/error fallback: keep the reader article focused, never steal toolbar focus. */
watch(
  () => props.state,
  async (state) => {
    if (state !== 'error') return;
    const seq = ++updateSeq;
    await nextTick();
    if (seq !== updateSeq) return;
    const active = document.activeElement;
    if (active instanceof Node && container.value?.contains(active)) return;
    focusElement(container.value, false);
  },
);

// Reader focus identity + participant context (App consumes these).
watch(
  () => visitRef.value?.activeMessageId ?? null,
  (activeId) => { emit('activeMessage', activeId); },
  { immediate: true },
);

const hoverParticipant = ref<{ messageId: string; address: Address } | null>(null);
const focusParticipant = ref<{ messageId: string; address: Address } | null>(null);
// Keyboard focus overrides hover independently; both restore the baseline on exit.
const effectiveParticipant = computed(() => focusParticipant.value ?? hoverParticipant.value);

watch(
  effectiveParticipant,
  (value) => {
    const open = props.openRef;
    if (!value || !open) {
      emit('contactOverride', null);
      return;
    }
    emit('contactOverride', {
      ref: { ...open },
      messageId: value.messageId,
      displayName: value.address.displayName,
      mailbox: value.address.mailbox,
    });
  },
);

function sameParticipant(
  current: { messageId: string; address: Address } | null,
  messageId: string,
  address: Address,
): boolean {
  return current !== null && current.messageId === messageId && current.address.mailbox === address.mailbox;
}

function onParticipantEnter(message: Message, address: Address): void {
  hoverParticipant.value = { messageId: message.id, address };
}

function onParticipantLeave(message: Message, address: Address): void {
  if (sameParticipant(hoverParticipant.value, message.id, address)) hoverParticipant.value = null;
}

function onParticipantFocus(message: Message, address: Address): void {
  focusParticipant.value = { messageId: message.id, address };
}

function onParticipantBlur(message: Message, address: Address): void {
  if (sameParticipant(focusParticipant.value, message.id, address)) focusParticipant.value = null;
}

// ---------------------------------------------------------------------------
// Message rendering helpers + narrow message commands (exposed to App)
// ---------------------------------------------------------------------------

/**
 * The visit a message command may act on: only a ready, matching displayed
 * reference qualifies. During loading the outgoing visit stays saved for
 * restoration, but stale commands must never mutate it.
 */
function displayedVisit(): VisitState | null {
  if (props.state !== 'ready') return null;
  const key = keyOfDisplayed();
  return key !== null ? visits.get(key) ?? null : null;
}

function isActive(message: Message): boolean {
  return visitRef.value?.activeMessageId === message.id;
}

/** Roving tabindex: the active toggle is the tab stop; the first is the fallback. */
function tabIndexFor(message: Message): 0 | -1 {
  if (isActive(message)) return 0;
  if ((visitRef.value?.activeMessageId ?? null) === null && message.id === (props.conversation?.messages[0]?.id ?? null)) return 0;
  return -1;
}

function isExpanded(message: Message): boolean {
  return visitRef.value?.expandedIds.has(message.id) ?? false;
}

function isDetailsOpen(message: Message): boolean {
  return visitRef.value?.detailsOpenId === message.id;
}

function bodyId(message: Message): string {
  return `reader-body-${message.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

function setActive(messageId: string): void {
  const visit = visitRef.value;
  if (visit && visit.activeMessageId !== messageId) visit.activeMessageId = messageId;
}

function setActiveByFocus(message: Message): void {
  // Focusing any control of a message updates its message identity.
  setActive(message.id);
}

function toggleMessage(message: Message): void {
  const visit = visitRef.value;
  if (!visit) return;
  setActive(message.id);
  if (visit.expandedIds.has(message.id)) visit.expandedIds.delete(message.id);
  else visit.expandedIds.add(message.id);
}

function onDetailsToggle(event: Event, message: Message): void {
  const visit = visitRef.value;
  if (!visit) return;
  const open = (event.target as HTMLDetailsElement).open;
  if (open && visit.detailsOpenId !== message.id) visit.detailsOpenId = message.id;
  else if (!open && visit.detailsOpenId === message.id) {
    visit.detailsOpenId = null;
    // Dismissing the disclosure ends its participant context: a browser may
    // keep focus inside the closed disclosure without firing blur, so clear
    // the keyboard-held override for this message explicitly.
    if (focusParticipant.value?.messageId === message.id) focusParticipant.value = null;
    if (hoverParticipant.value?.messageId === message.id) hoverParticipant.value = null;
  }
}

/** N/P: move message focus without implicitly expanding (no wrap). */
function moveMessage(delta: number): void {
  const visit = displayedVisit();
  const messages = props.conversation?.messages ?? [];
  if (!visit || messages.length === 0) return;
  const ids = messages.map((message) => message.id);
  const index = visit.activeMessageId ? ids.indexOf(visit.activeMessageId) : -1;
  const targetIndex = index < 0
    ? (delta > 0 ? 0 : ids.length - 1)
    : Math.min(ids.length - 1, Math.max(0, index + delta));
  const target = messages[targetIndex]!;
  setActive(target.id);
  // Explicit movement reveals the target header as needed.
  focusMessageToggle(target.id, true);
}

/** O: expand/collapse the focused message. */
function toggleActiveMessage(): void {
  const visit = displayedVisit();
  if (!visit || !visit.activeMessageId) return;
  if (visit.expandedIds.has(visit.activeMessageId)) visit.expandedIds.delete(visit.activeMessageId);
  else visit.expandedIds.add(visit.activeMessageId);
  focusMessageToggle(visit.activeMessageId, true);
}

/** Shift+O: idempotent expand-all. */
function expandAllMessages(): void {
  const visit = displayedVisit();
  const messages = props.conversation?.messages ?? [];
  if (!visit || messages.length === 0) return;
  for (const message of messages) visit.expandedIds.add(message.id);
}

function hasOpenDetails(): boolean {
  const visit = displayedVisit();
  return visit?.detailsOpenId !== null && visit?.detailsOpenId !== undefined;
}

/** Escape dismissal of an open message-details disclosure. Returns true when one was open. */
function dismissMessageDetails(): boolean {
  const visit = displayedVisit();
  if (!visit || visit.detailsOpenId === null) return false;
  const id = visit.detailsOpenId;
  visit.detailsOpenId = null;
  focusMessageToggle(id, true);
  return true;
}

defineExpose({
  moveMessage,
  toggleActiveMessage,
  expandAllMessages,
  hasOpenDetails,
  dismissMessageDetails,
});
</script>

<template>
  <article
    class="reader"
    tabindex="-1"
    aria-label="Conversation reader"
    data-test="reader"
    ref="container"
  >
    <div class="reader-toolbar" data-test="reader-toolbar">
      <button type="button" :title="actionLabel('back')" data-test="reader-close" @click="emit('close')">Close (Esc)</button>
      <button
        v-if="props.state === 'ready' && props.conversation"
        type="button"
        data-test="prepare-reply"
        :disabled="!!replyBlockedReason"
        @click="prepareReply"
      >Prepare reply</button>
      <span
        v-if="props.state === 'ready' && latestMessage"
        class="reply-source-label"
        data-test="reply-source-label"
      >Reply targets the latest message from {{ latestMessage.from.displayName ?? latestMessage.from.mailbox }}</span>
      <button
        v-if="!props.readOnly && props.state === 'ready' && props.conversation && !bulkScope"
        type="button"
        data-test="reader-archive-toggle"
        :title="actionLabel(props.conversation?.isInInbox ? 'archive' : 'unarchive')"
        :disabled="props.commandInFlight || props.navigationUnavailable"
        @click="props.conversation.isInInbox ? emit('archive') : emit('unarchive')"
      >
        {{ props.conversation.isInInbox ? 'Archive (e)' : 'Unarchive' }}
      </button>
      <!-- Selected scope: explicit count-labelled desired-state controls, never
           a toggle derived from the OPEN conversation's state (§3.3). -->
      <button
        v-if="!props.readOnly && props.state === 'ready' && bulkScope && bulkScope.context === 'inbox'"
        type="button"
        data-test="reader-selection-archive"
        :disabled="props.commandInFlight || props.navigationUnavailable"
        @click="emit('archive')"
      >Mark {{ bulkScope.count }} Done (archive)</button>
      <button
        v-if="!props.readOnly && props.state === 'ready' && bulkScope && bulkScope.context === 'done'"
        type="button"
        data-test="reader-selection-unarchive"
        :disabled="props.commandInFlight || props.navigationUnavailable"
        @click="emit('unarchive')"
      >Mark {{ bulkScope.count }} Not Done</button>
      <span v-if="(props.readOnly || props.showReadControls) && props.conversation" data-test="reader-read-state">
        {{ props.conversation.isRead === undefined ? 'Read state unknown' : props.conversation.isRead ? 'Read' : 'Unread' }}
      </span>
      <template v-if="props.showReadControls && props.conversation && !bulkScope && props.conversation.isRead === undefined">
        <button type="button" :title="actionLabel('read')" data-test="reader-mark-read" :disabled="props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', true)">Mark read</button>
        <button type="button" :title="actionLabel('unread')" data-test="reader-mark-unread" :disabled="props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', false)">Mark unread</button>
      </template>
      <template v-if="props.showReadControls && bulkScope">
        <!-- Explicit Mark N read / Mark N unread for a (possibly mixed)
             selection; never a mixed-state toggle from the open row. -->
        <button type="button" data-test="reader-selection-mark-read" :disabled="props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', true)">Mark {{ bulkScope.count }} read</button>
        <button type="button" data-test="reader-selection-mark-unread" :disabled="props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', false)">Mark {{ bulkScope.count }} unread</button>
      </template>
      <button
        v-if="props.showReadControls && props.conversation && !bulkScope && props.conversation.isRead !== undefined"
        type="button"
        data-test="reader-toggle-read"
        :disabled="props.commandInFlight || props.navigationUnavailable"
        @click="emit('setRead', !props.conversation.isRead)"
      >
        Mark {{ props.conversation.isRead ? 'unread' : 'read' }}
      </button>
    </div>

    <div class="reader-scroll" ref="scrollerEl" data-test="reader-scroll">
      <p v-if="props.state === 'loading'" data-test="reader-loading">Loading conversation…</p>
      <p v-else-if="props.state === 'error' && props.error" data-test="reader-error" role="alert">
        {{ describeError(props.error) }}
      </p>
      <template v-else-if="props.conversation">
        <h2 class="reader-subject">{{ props.conversation.subject }}</h2>
        <p v-if="replyBlockedReason" class="reader-notice" data-test="reply-blocked" role="note">
          {{ replyBlockedReason }}
        </p>
        <p v-if="props.conversation.retainedSnapshotAt" class="reader-recovery-snapshot" data-test="retained-snapshot-notice" role="note">
          Local recovery snapshot saved at {{ props.conversation.retainedSnapshotAt }}; Gmail may have newer messages or mailbox changes.
        </p>
        <p v-if="props.readOnly" class="reader-readonly" data-test="reader-readonly" role="note">
          Read-only Gmail view: messages are never marked as read. Opening this conversation does not change read state.
        </p>
        <p v-else-if="props.showReadControls" class="reader-readonly" data-test="reader-no-auto-read" role="note">
          Opening this conversation does not change read state; use an explicit read control.
        </p>
        <p
          v-if="props.conversation.unsupportedReason"
          data-test="unsupported-notice"
          class="reader-notice"
          role="note"
        >
          Some content is not shown: {{ props.conversation.unsupportedReason }}
        </p>
        <p
          v-else-if="props.conversation.contextComplete === false"
          data-test="context-incomplete"
          class="reader-notice"
          role="note"
        >
          This cached conversation may be incomplete; some context was unavailable in plain text.
        </p>
        <p v-if="props.conversation.pendingOperationId" data-test="reader-pending" class="reader-pending">
          A mailbox action is pending for this conversation.
        </p>
        <ol class="messages" data-test="reader-messages">
          <li
            v-for="message in props.conversation.messages"
            :key="message.id"
            class="message"
            :class="{ 'message-active': isActive(message) }"
            :data-test="`message-${message.id}`"
            :ref="(el) => setMessageEl(el, message.id)"
            @focusin="setActiveByFocus(message)"
          >
            <button
              type="button"
              class="message-toggle"
              :data-test="`message-toggle-${message.id}`"
              :tabindex="tabIndexFor(message)"
              :aria-expanded="isExpanded(message) ? 'true' : 'false'"
              :aria-controls="bodyId(message)"
              @click="toggleMessage(message)"
            >
              <span class="message-from">{{ message.from.displayName ?? message.from.mailbox }}</span>
              <span class="message-to">to {{ message.to.map((t) => t.displayName ?? t.mailbox).join(', ') }}</span>
              <time class="message-time">{{ message.sentAt }}</time>
            </button>
            <div class="message-body" :id="bodyId(message)" :hidden="!isExpanded(message)" data-test="message-body">{{ message.bodyText }}</div>
            <details
              class="message-details"
              :data-test="`message-details-${message.id}`"
              :open="isDetailsOpen(message)"
              @toggle="onDetailsToggle($event, message)"
            >
              <summary :data-test="`message-details-summary-${message.id}`">Details</summary>
              <div class="message-fields">
                <div class="message-field">
                  <span class="message-field-label">From</span>
                  <span
                    class="participant"
                    :data-test="`participant-from-${message.id}`"
                    tabindex="0"
                    @mouseenter="onParticipantEnter(message, message.from)"
                    @mouseleave="onParticipantLeave(message, message.from)"
                    @focus="onParticipantFocus(message, message.from)"
                    @blur="onParticipantBlur(message, message.from)"
                  >{{ message.from.displayName ?? message.from.mailbox }} &lt;{{ message.from.mailbox }}&gt;</span>
                </div>
                <div class="message-field">
                  <span class="message-field-label">To</span>
                  <span class="message-field-recipients">
                    <span
                      v-for="participant in message.to"
                      :key="participant.mailbox"
                      class="participant"
                      :data-test="`participant-to-${message.id}-${participant.mailbox}`"
                      tabindex="0"
                      @mouseenter="onParticipantEnter(message, participant)"
                      @mouseleave="onParticipantLeave(message, participant)"
                      @focus="onParticipantFocus(message, participant)"
                      @blur="onParticipantBlur(message, participant)"
                    >{{ participant.displayName ?? participant.mailbox }} &lt;{{ participant.mailbox }}&gt;</span>
                  </span>
                </div>
                <div class="message-field">
                  <span class="message-field-label">Sent</span>
                  <time :data-test="`message-sent-${message.id}`">{{ message.sentAt }}</time>
                </div>
              </div>
            </details>
          </li>
        </ol>
      </template>
    </div>
  </article>
</template>
