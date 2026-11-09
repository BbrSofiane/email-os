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
import { compactDateLabel, fullDateLabel, machineDateTime } from '../lib/browsing-dates';
import { messageSnippet } from '../lib/message-snippet';
import { bodyNeedsMonospace, splitMessageBody, type MessageBodyParts } from '../lib/message-body-format';
import { computed, nextTick, reactive, ref, useId, watch } from 'vue';
import HeaderGlyph from './HeaderGlyph.vue';
import MessageAttachments from './MessageAttachments.vue';
import { useAttachmentTransfer } from '../composables/useAttachmentTransfer';
import type { Address, Conversation, ConversationRef, DraftSource, MailClient, MailError, Message } from '../lib/ipc/client';
import type { AttachmentDescriptor } from '../lib/ipc/generated';
import type { DetailState } from '../composables/useMailbox';

const props = defineProps<{
  conversation: Conversation | null;
  state: DetailState;
  error: MailError | null;
  commandInFlight: boolean;
  reminderEnabled?: boolean;
  /** The conversation reference the shell currently wants displayed. */
  openRef: ConversationRef | null;
  /**
   * Target identity from the list's own row, shown while the target loads and
   * no previous conversation is held. Never message content.
   */
  loadingIdentity?: { subject: string; sender: string | null; at: string | null } | null;
  /** Gmail mode: archive/unarchive controls are hidden, not just disabled. */
  readOnly?: boolean;
  browsingOnly?: boolean;
  navigationUnavailable?: boolean;
  showReadControls?: boolean;
  /** Nonzero: shared controls dispatch to the SELECTION (§3.3), so the reader
   * offers explicit count-labelled desired-state controls instead of the open
   * conversation's single-state toggles (mixed selections included). */
  selectionCount?: number;
  selectionContext?: 'inbox' | 'saved' | 'done' | 'starred' | 'search';
  /** Header slots the quiet icon actions are teleported into; inline when null. */
  backHost?: HTMLElement | null;
  actionsHost?: HTMLElement | null;
  /** J/K availability; undefined hides the previous/next chevrons. */
  canMovePrev?: boolean;
  canMoveNext?: boolean;
  /** Inline attachment rows: without a client the reader shows none. */
  client?: MailClient;
  /** Browser preview: saves are modelled in memory and say so. */
  preview?: boolean;
}>();

const emit = defineEmits<{
  close: [];
  /** Previous (-1) / next (+1) conversation, same path as K / J. */
  move: [delta: number];
  attachments: [origin: HTMLElement];
  archive: [];
  remind: [];
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

type StarCoverage = NonNullable<Conversation['stars']>;

/** Short visible star line; exact coverage moves to the title/description. */
function starSummary(stars: StarCoverage): string {
  if (stars.starredMessages > 0) return stars.knownMessages < stars.totalMessages ? 'Starred (partial)' : 'Starred';
  return stars.knownMessages === stars.totalMessages && stars.totalMessages > 0 ? 'Not starred' : 'Star state unknown';
}

/** The line appears only with news: starred, incomplete coverage, or a pending
 * action (the effective value may then include unconfirmed intent). */
function starLine(conversation: NonNullable<typeof props.conversation>): { text: string; attention: boolean } | null {
  const stars = conversation.stars;
  if (!stars) return null;
  const complete = stars.totalMessages > 0 && stars.knownMessages === stars.totalMessages;
  const pending = Boolean(conversation.pendingOperationId);
  if (stars.starredMessages === 0 && complete && !pending) return null;
  return { text: starSummary(stars) + (pending ? ' (unconfirmed)' : ''), attention: !complete || pending };
}

function starCoverageDetail(stars: StarCoverage): string {
  return `Effective star values known for ${stars.knownMessages} of ${stars.totalMessages} cached messages. Pending intent is not provider confirmation.`;
}

const latestMessage = computed(() => props.conversation?.messages.at(-1) ?? null);
const replyBlockedReason = computed(() => {
  if (!props.conversation || !latestMessage.value) return 'No displayed latest message is available as a reply source.';
  if (props.conversation.retainedSnapshotAt) return 'Reply preparation is blocked for a retained snapshot; current message headers cannot be verified.';
  if (props.conversation.contextComplete === false) return 'Reply preparation is blocked because this cached conversation is incomplete.';
  if (props.conversation.replyContext && props.conversation.replyContext.sourceMessageId !== latestMessage.value.id) return 'Reply preparation is blocked because cached reply headers do not match the displayed latest message.';
  return null;
});

const replySourceId = `reader-reply-source-${useId()}`;
const replyTargetLabel = computed(() => latestMessage.value
  ? `Reply targets the latest message from ${latestMessage.value.from.displayName ?? latestMessage.value.from.mailbox}`
  : '');
/** Conversation-specific actions exist only for a ready conversation. */
const actionable = computed(() => props.state === 'ready' && !!props.conversation);
/**
 * A previous conversation kept on screen while the J/K target loads. It is
 * display only: nothing in it is actionable as if it were the open thread.
 */
const held = computed(() => props.state === 'loading' && !!props.conversation && keyOfDisplayed() === null);
/** Header actions stay mounted (disabled, not removed) for as long as a conversation is open. */
const actionsShown = computed(() => props.openRef !== null || actionable.value);
const hasMetaRow = computed(() => {
  if (!(actionable.value || held.value)) return false;
  return !!(props.readOnly || props.showReadControls || bulkScope.value);
});

/** The one rule for whether Reply may run (button, glyph and the R key). */
function canPrepareReply(): boolean {
  return actionable.value && !props.browsingOnly && !!latestMessage.value && replyBlockedReason.value === null;
}

/** Title for the reply controls: the action label with its key, plus the target. */
const replyTitle = computed(() => {
  if (!actionable.value) return actionLabel('reply');
  return replyBlockedReason.value ?? `${actionLabel('reply')}. ${replyTargetLabel.value}`;
});

/** The standing guarantee behind the status line (hook per mode); Cached Trash has its own line and only names the mode. */
const readerStatus = computed(() => {
  // Cached Trash keeps its own line below; the status span only names the mode,
  // with no standing sentence or hook.
  if (props.browsingOnly) return { hook: undefined, word: 'Read-only', sentence: null };
  if (props.readOnly) {
    return {
      hook: 'reader-readonly',
      word: 'Read-only',
      sentence: 'Read-only Gmail view: messages are never marked as read. Opening this conversation does not change read state.',
    };
  }
  if (props.showReadControls) {
    return {
      hook: 'reader-no-auto-read',
      word: null,
      sentence: 'Opening this conversation does not change read state; use an explicit read control.',
    };
  }
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
      return 'The request was rejected.';
    case 'request_id_conflict':
      return 'The request conflicted with an earlier one.';
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
  /** Messages whose trailing quoted text is shown. */
  quoteOpenIds: Set<string>;
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
  visit.quoteOpenIds = new Set([...visit.quoteOpenIds].filter((id) => present.has(id)));
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
async function schedulePostUpdate(key: string, focusIntent: boolean, readerHadFocus: boolean, restoringAfterLoading: boolean, switched: boolean): Promise<void> {
  const seq = ++updateSeq;
  await nextTick();
  if (seq !== updateSeq || keyOfDisplayed() !== key) return;
  const visit = visits.get(key);
  const scroller = scrollerEl.value;
  if (visit && scroller) {
    // A returning visit restores its anchor; a first visit starts at the top
    // instead of inheriting the outgoing conversation's offset.
    if (visit.anchor) restoreScroll(visit, scroller);
    else if (switched) scroller.scrollTop = 0;
  }
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
        quoteOpenIds: new Set<string>(),
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
    void schedulePostUpdate(key, key !== previousKey || restoringAfterLoading, readerHadFocus, restoringAfterLoading, key !== previousKey);
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
  return `reader-body-${props.conversation?.ref.accountId}-${message.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

function quoteId(message: Message): string {
  return `reader-quote-${props.conversation?.ref.accountId}-${message.id}`.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * Prose / signature / trailing quote of a body, split once per distinct text
 * (reading a thread again after J/K never re-splits it).
 */
const bodyParts = new Map<string, { text: string; parts: MessageBodyParts }>();
function partsOf(message: Message): MessageBodyParts {
  const cached = bodyParts.get(message.id);
  if (cached && cached.text === message.bodyText) return cached.parts;
  const parts = splitMessageBody(message.bodyText);
  bodyParts.set(message.id, { text: message.bodyText, parts });
  return parts;
}

/**
 * Trailing line breaks of a part are not shown: they only separated the prose,
 * the signature and the quote, and would draw an empty gap between them. Every
 * other character, blank lines inside a part included, stays in the DOM text.
 */
function shown(text: string): string {
  return text.replace(/(?:\r?\n)+$/, '');
}

function isQuoteOpen(message: Message): boolean {
  return visitRef.value?.quoteOpenIds.has(message.id) ?? false;
}

function toggleQuote(message: Message): void {
  const visit = visitRef.value;
  if (!visit || !actionable.value) return;
  setActive(message.id);
  if (visit.quoteOpenIds.has(message.id)) visit.quoteOpenIds.delete(message.id);
  else visit.quoteOpenIds.add(message.id);
}

function setActive(messageId: string): void {
  const visit = visitRef.value;
  if (visit && visit.activeMessageId !== messageId) visit.activeMessageId = messageId;
}

function setActiveByFocus(message: Message): void {
  // Focusing any control of a message updates its message identity.
  setActive(message.id);
}

/** Collapsing a message also closes its details: collapsed messages show no Details UI. */
function collapseMessage(visit: VisitState, id: string): void {
  visit.expandedIds.delete(id);
  if (visit.detailsOpenId === id) visit.detailsOpenId = null;
  if (focusParticipant.value?.messageId === id) focusParticipant.value = null;
  if (hoverParticipant.value?.messageId === id) hoverParticipant.value = null;
}

function toggleMessage(message: Message): void {
  const visit = visitRef.value;
  if (!visit || !actionable.value) return;
  setActive(message.id);
  if (visit.expandedIds.has(message.id)) collapseMessage(visit, message.id);
  else visit.expandedIds.add(message.id);
}

function onDetailsToggle(event: Event, message: Message): void {
  const visit = visitRef.value;
  if (!visit) return;
  if (!actionable.value) {
    // Held content: keep the disclosure exactly as saved.
    (event.target as HTMLDetailsElement).open = isDetailsOpen(message);
    return;
  }
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
  if (visit.expandedIds.has(visit.activeMessageId)) collapseMessage(visit, visit.activeMessageId);
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

// ---------------------------------------------------------------------------
// Inline attachment rows
// ---------------------------------------------------------------------------

type AttachmentLoad = { state: 'ready'; files: AttachmentDescriptor[] } | { state: 'failed' };

/** Descriptor lists per conversation, kept for this reader session: J/K revisits never refetch. */
const attachmentLoads = reactive(new Map<string, AttachmentLoad>());
const attachmentRequests = new Map<string, number>();
let attachmentSeq = 0;
const displayedKey = computed(() => keyOfDisplayed());
const attachmentTransfer = useAttachmentTransfer({
  client: () => props.client!,
  conversation: () => props.conversation!.ref,
  preview: () => props.preview === true,
});

/** Set only for a ready, displayed conversation that claims attachments. */
const attachmentKeyToLoad = computed(() => {
  const conversation = props.conversation;
  if (props.state !== 'ready' || !props.client || !conversation || displayedKey.value === null) return null;
  return conversation.messages.some((message) => message.hasAttachment === true) ? visitKey(conversation.ref) : null;
});

async function loadAttachments(key: string, ref: ConversationRef): Promise<void> {
  const client = props.client;
  if (!client) return;
  const known = attachmentLoads.get(key);
  // A list already loaded (or loading) is final for this visit; only a failure is retried.
  if ((known && known.state === 'ready') || (!known && attachmentRequests.has(key))) return;
  const token = ++attachmentSeq;
  attachmentRequests.set(key, token);
  let result: AttachmentLoad;
  try {
    result = { state: 'ready', files: await client.listAttachments({ ...ref }) };
  } catch {
    result = { state: 'failed' };
  }
  // A newer request for this key owns the result. The result is stored under
  // its own conversation key, so it can never show on another conversation.
  if (attachmentRequests.get(key) !== token) return;
  attachmentLoads.set(key, result);
}

// After the ready snapshot has rendered: never blocks the J/K hot path.
watch(attachmentKeyToLoad, (key) => {
  const conversation = props.conversation;
  if (key && conversation) void loadAttachments(key, conversation.ref);
}, { immediate: true, flush: 'post' });

// A transfer belongs to the conversation it started in.
watch(displayedKey, (key, previous) => {
  if (previous === undefined || key === previous) return;
  if (attachmentTransfer.pending.value) void attachmentTransfer.cancel();
  attachmentTransfer.reset();
});

/**
 * What a message's inline list shows. Only `hasAttachment === true` ever claims
 * files (false and unknown show nothing); null while the list is still loading.
 */
function attachmentRow(message: Message): { loadState: 'ready' | 'failed'; files: AttachmentDescriptor[] } | null {
  if (message.hasAttachment !== true || !props.conversation) return null;
  const load = attachmentLoads.get(visitKey(props.conversation.ref));
  if (!load) return null;
  if (load.state === 'failed') return { loadState: 'failed', files: [] };
  return { loadState: 'ready', files: load.files.filter((file) => file.messageId === message.id) };
}

const transferTargetKey = computed(() => attachmentTransfer.target.value);
const pendingTransferKey = computed(() => (attachmentTransfer.pending.value ? transferTargetKey.value : null));

/**
 * Puts focus back on the active message toggle (or the reader article when no
 * message exists). Used when an inline composer closes and focus fell to <body>.
 */
function focusActiveMessage(): void {
  const visit = displayedVisit();
  if (visit?.activeMessageId) focusMessageToggle(visit.activeMessageId, false);
  else focusElement(container.value, false);
}

defineExpose({
  canPrepareReply,
  prepareReply,
  focusActiveMessage,
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
    <!-- Quiet icon actions live in the app header (Teleport); with no host
         (standalone mount) they render inline. Every icon keeps a hidden text
         name plus a title with its shortcut. -->
    <Teleport :to="props.backHost ?? undefined" :disabled="!props.backHost">
      <button type="button" class="header-glyph reader-back" :title="actionLabel('back')" data-test="reader-close" @click="emit('close')"><HeaderGlyph name="back" /><span class="visually-hidden">Close (Esc)</span></button>
    </Teleport>
    <Teleport :to="props.actionsHost ?? undefined" :disabled="!props.actionsHost">
      <div class="reader-actions" data-test="reader-toolbar">
        <button v-if="actionsShown && props.reminderEnabled && !bulkScope && props.conversation?.isInInbox" type="button" class="header-glyph" data-test="reader-remind" title="Remind me on this device" :disabled="!actionable || props.commandInFlight" @click="emit('remind')"><HeaderGlyph name="reminders" /><span class="visually-hidden">Remind me on this device</span></button>
        <button
          v-if="actionsShown && !props.readOnly && !bulkScope"
          type="button"
          class="header-glyph"
          :class="{ 'header-glyph-held': held }"
          data-test="reader-archive-toggle"
          :title="actionLabel(props.conversation?.isInInbox === false ? 'unarchive' : 'archive')"
          :disabled="!actionable || props.commandInFlight || props.navigationUnavailable"
          @click="props.conversation?.isInInbox === false ? emit('unarchive') : emit('archive')"
        ><HeaderGlyph name="done" /><span class="visually-hidden">{{ props.conversation?.isInInbox === false ? 'Mark not done' : 'Mark done (E)' }}</span></button>
        <button
          v-if="actionsShown && props.showReadControls && !bulkScope && (!props.conversation || props.conversation.isRead !== undefined)"
          type="button"
          class="header-glyph"
          :class="{ 'header-glyph-held': held }"
          data-test="reader-toggle-read"
          :title="actionLabel(props.conversation?.isRead ? 'unread' : 'read')"
          :disabled="!actionable || props.commandInFlight || props.navigationUnavailable"
          @click="emit('setRead', !props.conversation?.isRead)"
        ><HeaderGlyph :name="props.conversation?.isRead ? 'unread' : 'read'" /><span class="visually-hidden">Mark {{ props.conversation?.isRead ? 'unread' : 'read' }}</span></button>
        <button v-if="actionsShown" type="button" class="header-glyph" :class="{ 'header-glyph-held': held }" data-test="files-links" title="Files and links — ⌘O" :disabled="!actionable" @click="emit('attachments', $event.currentTarget as HTMLElement)"><HeaderGlyph name="files" /><span class="visually-hidden">Files and links (⌘O)</span></button>
        <button
          v-if="actionsShown && !props.browsingOnly"
          type="button"
          class="header-glyph"
          :class="{ 'header-glyph-held': held }"
          data-test="prepare-reply"
          :title="replyTitle"
          :aria-describedby="actionable ? replySourceId : undefined"
          :disabled="!actionable || !!replyBlockedReason"
          @click="prepareReply"
        ><HeaderGlyph name="reply" /><span class="visually-hidden">Reply</span></button>
        <span
          v-if="!props.browsingOnly && actionable && latestMessage"
          :id="replySourceId"
          class="visually-hidden"
          data-test="reply-source-label"
        >{{ replyTargetLabel }}</span>
        <button v-if="props.canMovePrev !== undefined" type="button" class="header-glyph" data-test="reader-prev" title="Previous conversation — K" :disabled="!props.canMovePrev" @click="emit('move', -1)"><HeaderGlyph name="prev" /><span class="visually-hidden">Previous conversation (K)</span></button>
        <button v-if="props.canMoveNext !== undefined" type="button" class="header-glyph" data-test="reader-next" title="Next conversation — J" :disabled="!props.canMoveNext" @click="emit('move', 1)"><HeaderGlyph name="next" /><span class="visually-hidden">Next conversation (J)</span></button>
      </div>
    </Teleport>

    <div class="reader-scroll" ref="scrollerEl" data-test="reader-scroll">
      <template v-if="props.state === 'loading' && !held">
        <!-- The list row's own subject, sender and date: truthful while the detail loads. -->
        <template v-if="props.loadingIdentity">
          <h2 class="reader-subject" data-test="reader-loading-subject">{{ props.loadingIdentity.subject }}</h2>
          <p class="reader-loading-identity" data-test="reader-loading-identity">
            <span v-if="props.loadingIdentity.sender" data-test="reader-loading-sender">{{ props.loadingIdentity.sender }}</span>
            <time v-if="props.loadingIdentity.at" :datetime="machineDateTime(props.loadingIdentity.at)" :title="fullDateLabel(props.loadingIdentity.at)">{{ compactDateLabel(props.loadingIdentity.at) }}</time>
          </p>
        </template>
        <p data-test="reader-loading" role="status" :class="{ 'reader-loading-quiet': props.loadingIdentity }">Loading conversation…</p>
        <!-- Static placeholder of the loaded shape (subject, then message rows) so the
             pane does not jump when the conversation arrives. No motion; hidden from assistive tech. -->
        <div class="reader-skeleton" aria-hidden="true" data-test="reader-skeleton">
          <span v-if="!props.loadingIdentity" class="reader-skeleton-subject"></span>
          <span v-for="n in 3" :key="n" class="reader-skeleton-row"></span>
        </div>
      </template>
      <p v-else-if="props.state === 'error' && props.error" data-test="reader-error" role="alert">
        {{ describeError(props.error) }}
      </p>
      <template v-else-if="props.conversation">
        <h2 class="reader-subject">{{ props.conversation.subject }}</h2>
        <!-- Honest-state text controls (read state, count-labelled selection
             actions) stay explicit, in one quiet line under the subject. -->
        <div v-if="hasMetaRow" class="reader-meta-row" data-test="reader-meta-row">
          <!-- One muted status line: the standing guarantee is its title and
               visually hidden text (read once by assistive tech), not a paragraph. -->
          <span
            v-if="(props.readOnly || props.showReadControls)"
            class="reader-status"
            :data-test="readerStatus?.hook"
            :title="readerStatus?.sentence ?? undefined"
          >
            <span v-if="readerStatus?.word" class="reader-status-word" data-test="reader-status-word">{{ readerStatus.word }}</span>
            <span data-test="reader-read-state">{{ props.conversation.isRead === undefined ? 'Read state unknown' : props.conversation.isRead ? 'Read' : 'Unread' }}</span>
            <span v-if="readerStatus?.sentence" class="visually-hidden" data-test="reader-status-detail">{{ readerStatus.sentence }}</span>
          </span>
          <template v-if="props.showReadControls && !bulkScope && props.conversation.isRead === undefined">
            <button type="button" :title="actionLabel('read')" data-test="reader-mark-read" :disabled="!actionable || props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', true)">Mark read</button>
            <button type="button" :title="actionLabel('unread')" data-test="reader-mark-unread" :disabled="!actionable || props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', false)">Mark unread</button>
          </template>
          <!-- Selected scope: explicit count-labelled desired-state controls, never
               a toggle derived from the OPEN conversation's state (§3.3). -->
          <button
            v-if="!props.readOnly && bulkScope && bulkScope.context !== 'done'"
            type="button"
            data-test="reader-selection-archive"
            :disabled="!actionable || props.commandInFlight || props.navigationUnavailable"
            @click="emit('archive')"
          >Mark {{ bulkScope.count }} done</button>
          <button
            v-if="!props.readOnly && bulkScope && bulkScope.context !== 'inbox'"
            type="button"
            data-test="reader-selection-unarchive"
            :disabled="!actionable || props.commandInFlight || props.navigationUnavailable"
            @click="emit('unarchive')"
          >Mark {{ bulkScope.count }} not done</button>
          <template v-if="props.showReadControls && bulkScope">
            <button type="button" data-test="reader-selection-mark-read" :disabled="!actionable || props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', true)">Mark {{ bulkScope.count }} read</button>
            <button type="button" data-test="reader-selection-mark-unread" :disabled="!actionable || props.commandInFlight || props.navigationUnavailable" @click="emit('setRead', false)">Mark {{ bulkScope.count }} unread</button>
          </template>
        </div>
        <p
          v-if="props.conversation.stars && starLine(props.conversation)"
          data-test="reader-stars"
          class="reader-context-note"
          :data-attention="starLine(props.conversation)!.attention || undefined"
          :title="starCoverageDetail(props.conversation.stars)"
        >{{ starLine(props.conversation)!.text }}<span class="visually-hidden" data-test="reader-stars-detail"> — {{ starCoverageDetail(props.conversation.stars) }}</span></p>
        <p v-if="replyBlockedReason" class="reader-notice" data-test="reply-blocked" role="note">
          {{ replyBlockedReason }}
        </p>
        <p v-if="props.conversation.retainedSnapshotAt" class="reader-recovery-snapshot" data-test="retained-snapshot-notice" role="note">
          Local recovery snapshot saved <time :datetime="machineDateTime(props.conversation.retainedSnapshotAt)">{{ fullDateLabel(props.conversation.retainedSnapshotAt) }}</time>; Gmail may have newer messages or mailbox changes.
        </p>
        <p v-if="props.browsingOnly" class="reader-readonly" role="note">Cached Trash — read only. Recovery is not available here; use your provider client.</p>
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
            <div class="message-header">
              <button
                type="button"
                class="message-toggle"
                :data-test="`message-toggle-${message.id}`"
                :tabindex="tabIndexFor(message)"
                :aria-expanded="isExpanded(message) ? 'true' : 'false'"
                :aria-disabled="actionable ? undefined : 'true'"
                :aria-controls="bodyId(message)"
                @click="toggleMessage(message)"
              >
                <span class="message-from">{{ message.from.displayName ?? message.from.mailbox }}</span>
                <span class="message-to">to {{ message.to.map((t) => t.displayName ?? t.mailbox).join(', ') }}</span>
                <span v-if="!isExpanded(message) && messageSnippet(partsOf(message).main)" class="message-snippet">{{ messageSnippet(partsOf(message).main) }}</span>
                <time class="message-time" :datetime="machineDateTime(message.sentAt)" :title="fullDateLabel(message.sentAt)">
                  <span aria-hidden="true">{{ compactDateLabel(message.sentAt) }}</span>
                  <span class="visually-hidden">{{ fullDateLabel(message.sentAt) }}</span>
                </time>
              </button>
              <!-- Quiet reply glyph: only on the displayed latest message while it is
                   active; same gating and event as the toolbar Reply. -->
              <button
                v-if="!props.browsingOnly && isActive(message) && message.id === latestMessage?.id"
                type="button"
                class="message-reply"
                :data-test="`message-reply-${message.id}`"
                aria-label="Reply"
                :title="replyTitle"
                :disabled="!actionable || !!replyBlockedReason"
                @click="prepareReply"
              >
                <svg class="message-reply-glyph" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
                  <path d="M6.5 3.5L2.75 7l3.75 3.5" />
                  <path d="M3 7h5.5a4.5 4.5 0 014.5 4.5V13" />
                </svg>
              </button>
            </div>
            <details
              class="message-details"
              :data-test="`message-details-${message.id}`"
              :open="isDetailsOpen(message)"
              :hidden="!isExpanded(message)"
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
                <!-- The cached Message has no Cc: say so instead of implying there is none. -->
                <div class="message-field">
                  <span class="message-field-label">Cc</span>
                  <span
                    class="message-field-note"
                    :data-test="`message-cc-${message.id}`"
                    title="Cc is not stored in the local cache; reply recipients are not inferred from it."
                  >Not cached</span>
                </div>
                <div class="message-field">
                  <span class="message-field-label">Sent</span>
                  <time :data-test="`message-sent-${message.id}`" :datetime="machineDateTime(message.sentAt)">{{ fullDateLabel(message.sentAt) }}</time>
                </div>
              </div>
            </details>
            <div class="message-body" :class="{ 'message-body-mono': bodyNeedsMonospace(partsOf(message).main) }" :id="bodyId(message)" :hidden="!isExpanded(message)" data-test="message-body">{{ partsOf(message).signature !== null || partsOf(message).quoted !== null ? shown(partsOf(message).main) : partsOf(message).main }}</div>
            <!-- Signature: the same reading face in Ash, always visible with the message. -->
            <div v-if="partsOf(message).signature !== null" class="message-trail message-signature" :hidden="!isExpanded(message)" data-test="message-signature">{{ partsOf(message).quoted !== null ? shown(partsOf(message).signature!) : partsOf(message).signature }}</div>
            <!-- Trailing quote: behind a real disclosure button, per message, kept in the visit state. -->
            <template v-if="partsOf(message).quoted !== null">
              <button
                type="button"
                class="message-quote-toggle"
                :hidden="!isExpanded(message)"
                :aria-expanded="isQuoteOpen(message) ? 'true' : 'false'"
                :aria-controls="isQuoteOpen(message) ? quoteId(message) : undefined"
                :aria-disabled="actionable ? undefined : 'true'"
                :data-test="`message-quote-toggle-${message.id}`"
                @click="toggleQuote(message)"
              >{{ isQuoteOpen(message) ? 'Hide quoted text' : 'Show quoted text' }}</button>
              <div v-if="isQuoteOpen(message) && isExpanded(message)" :id="quoteId(message)" class="message-trail message-quoted" data-test="message-quoted">{{ shown(partsOf(message).quoted!) }}</div>
            </template>
            <MessageAttachments
              v-if="isExpanded(message) && attachmentRow(message)"
              :message-id="message.id"
              :files="attachmentRow(message)!.files"
              :load-state="attachmentRow(message)!.loadState"
              :retained="!!props.conversation.retainedSnapshotAt"
              :pending="pendingTransferKey"
              :target="transferTargetKey"
              :status="attachmentTransfer.status.value"
              :error="attachmentTransfer.error.value"
              @save="attachmentTransfer.save"
              @cancel="attachmentTransfer.cancel"
            />
          </li>
        </ol>
      </template>
    </div>
  </article>
</template>
