/** Core read models are authoritative; events only request another snapshot. */
import { computed, onScopeDispose, ref, type ComputedRef, type Ref } from 'vue';
import type {
  AccountStatus,
  CachedDoneSnapshot,
  CachedTrashSnapshot,
  SavedSplit,
  Conversation,
  ConversationRef,
  GroupUndoReceipt,
  InboxSnapshot,
  MailClient,
  MailError,
  MailMode,
  OperationGroupStatus,
  OperationGroupSummary,
  OperationReceipt,
  UndoReceipt,
} from '../lib/ipc/client';
import { matchesSplit } from '../lib/saved-split';
import { toMailError } from '../lib/ipc/client';
import { sameConversation } from './mailbox-refs';
import type { CommandFence, MailboxSession } from './mailbox-session';
import { SELECTION_MAX, useMailboxSelection } from './useMailboxSelection';
import { useMailboxAccount, type AccountAction, type AccountState } from './useMailboxAccount';
import { useMailboxGroups, type GroupNotice } from './useMailboxGroups';
import {
  DETAIL_CACHE_MAX, DETAIL_CACHE_TTL_MS, READER_LOADING_DELAY_MS, useMailboxDetailCache,
} from './useMailboxDetailCache';

// Definitions moved to focused modules; the exported names stay importable from here.
export { DETAIL_CACHE_MAX, DETAIL_CACHE_TTL_MS, READER_LOADING_DELAY_MS, SELECTION_MAX, sameConversation };
export type { AccountAction, AccountState, GroupNotice };

export type ListState = 'loading' | 'ready' | 'error';
export type DetailState = 'idle' | 'loading' | 'ready' | 'error';
export type ConversationSummaryLike = InboxSnapshot['conversations'][number];
export type OperationSummaryLike = InboxSnapshot['activity'][number];
/** The setter action an undoable last action was performed with. */
export type LastActionId = 'archive' | 'unarchive' | 'read' | 'unread' | 'star' | 'unstar';

/**
 * Single-slot notice state for the most recent accepted conversation action
 * (UX-04). `undoableUntil` comes from the refreshed activity row, never from a
 * local guess; the backend stays the authority on undo eligibility.
 */
export interface LastAction {
  /** The accepted operation. `acceptedAt` is carried only when it is real:
   * a re-pointed slot knows no acceptance time and fabricates none. */
  receipt: { operationId: string; acceptedAt?: string };
  actionId: LastActionId;
  target: ConversationRef;
  /** Best-effort subject; null when no row carried one — never a raw id. */
  subject: string | null;
  undoableUntil: string | null;
  /** True once this action ever had an undo window; the expired wording is
   * shown only then, never for actions that were never undoable. */
  hadWindow: boolean;
  /** Receipt of a successful undo of this action. Keeps the slot alive after
   * the undo so the notice can report Cancelled/Restored/compensation outcome. */
  undone: UndoReceipt | null;
}

/**
 * `reminders` and `drafts` are list contexts whose rows are not conversations:
 * the mailbox only tracks that one is the active context (history, Back, reader
 * origin); `useReminders` and `useDrafts` own their rows.
 */
export type BrowseContext = 'inbox' | 'saved' | 'done' | 'starred' | 'trash' | 'reminders' | 'drafts' | 'search';

export interface SearchVisit { query: string; cachedOnly: boolean; coverage: string; rows: ConversationSummaryLike[]; cursor: string | null }

export interface DoneBoundary { lastMessageAt: string; conversationId: string }
function reachesBoundary(rows: ConversationSummaryLike[], boundary: DoneBoundary | null): boolean {
  const last = rows.at(-1);
  return !boundary || !!last && (last.lastMessageAt < boundary.lastMessageAt
    || last.lastMessageAt === boundary.lastMessageAt && last.ref.conversationId >= boundary.conversationId);
}
function boundaryOf(rows: ConversationSummaryLike[]): DoneBoundary | null {
  const last = rows.at(-1);
  return last ? { lastMessageAt: last.lastMessageAt, conversationId: last.ref.conversationId } : null;
}

export interface Mailbox {
  savedSplit: Ref<SavedSplit | null>;
  splitError: Ref<MailError | null>;
  splitBusy: Ref<boolean>;
  inboxTotal: Ref<number | null>;
  savedTotal: Ref<number | null>;
  unreadOnly: Ref<boolean>;
  saveSplit(split: SavedSplit): Promise<boolean>;
  setUnreadOnly(unread: boolean): Promise<void>;
  searchQuery: Ref<string>;
  searchCoverage: Ref<string>;
  searchCachedOnly: Ref<boolean>;
  search(query: string, cachedOnly?: boolean): Promise<void>;
  restoreSearch(visit: SearchVisit): Promise<void>;
  /** Explicit navigation supersedes a search still awaiting cancellation. */
  invalidateSearchIntent(): void;
  /** Capture current ownership for deferred navigation, without claiming a new intent. */
  captureNavigationIntent(): () => boolean;
  context: Ref<BrowseContext>;
  starredOnly: Ref<boolean>;
  nextCursor: Ref<string | null>;
  loadingMore: Ref<boolean>;
  exactTotal: Ref<number | null>;
  lastSyncedAt: Ref<string | null>;
  activityError: Ref<MailError | null>;
  loadedDonePages: Ref<number>;
  loadedDoneBoundary: Ref<DoneBoundary | null>;
  setContext(context: BrowseContext, pages?: number, boundary?: DoneBoundary | null, starredOnly?: boolean): Promise<void>;
  loadMore(): Promise<void>;
  conversations: Ref<ConversationSummaryLike[]>;
  activity: Ref<OperationSummaryLike[]>;
  listState: Ref<ListState>;
  listError: Ref<MailError | null>;
  /** Explicit account-scoped conversation focus; never an array position. */
  focusedRef: Ref<ConversationRef | null>;
  /** The focused row in the current snapshot; `null` when the ref is absent. */
  focusedSummary: ComputedRef<ConversationSummaryLike | null>;
  openRef: Ref<ConversationRef | null>;
  conversation: Ref<Conversation | null>;
  detailState: Ref<DetailState>;
  /**
   * Display-only previous conversation kept on screen for up to
   * READER_LOADING_DELAY_MS while a J/K target loads. It is never an action
   * target: `conversation` stays null and `detailState` stays 'loading'.
   */
  heldConversation: Ref<Conversation | null>;
  detailError: Ref<MailError | null>;
  lastCommandError: Ref<MailError | null>;
  inFlightCommandRef: Ref<ConversationRef | null>;
  /** Includes targetless retries; mutation ownership is not a conversation. */
  commandInFlight: Ref<boolean>;
  /** Authoritative account/mode status; `null` until the first status read lands. */
  accountStatus: Ref<AccountStatus | null>;
  accountState: Ref<AccountState>;
  accountError: Ref<MailError | null>;
  accountBusy: Ref<AccountAction | null>;
  /** Mode from the last accepted status; `null` while unknown (UI must fail closed). */
  mode: ComputedRef<MailMode | null>;
  isGmail: ComputedRef<boolean>;
  ready: Promise<void>;
  refresh(): Promise<void>;
  connectAccount(): Promise<void>;
  disconnectAccount(): Promise<void>;
  requestSync(): Promise<void>;
  focusConversation(target: ConversationRef | null): void;
  moveFocus(delta: number): void;
  openConversationByRef(ref: ConversationRef, source?: 'list' | 'activity'): Promise<void>;
  /** J/K and chevron moves: instant from the neighbor cache, else delayed loading. */
  openNeighbor(ref: ConversationRef): Promise<void>;
  /** Best-effort, read-only prefetch of one neighbor of the ready open reader. */
  prefetchConversation(ref: ConversationRef): void;
  openFocused(): Promise<void>;
  closeReader(): void;
  setArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null>;
  setStarred(target: ConversationRef, starred: boolean): Promise<OperationReceipt | null>;
  setStarredGroup(members: ConversationRef[], starred: boolean): Promise<boolean>;
  unarchiveFromActivity(target: ConversationRef): Promise<OperationReceipt | null>;
  setRead(target: ConversationRef, read: boolean): Promise<OperationReceipt | null>;
  retryOperation(operationId: string): Promise<OperationReceipt | null>;
  /** Single-slot notice state for the latest accepted setter action. */
  lastAction: Ref<LastAction | null>;
  /** Undo of the last action; re-points on `superseded`, exposes `expired`. */
  undoLastAction(): Promise<UndoReceipt | null>;
  // --- UX-05 selection state (account-scoped, additive ranges) ---
  /** Insertion-ordered selected references; never indexes, never focus. */
  selectedRefs: Ref<ConversationRef[]>;
  /** Range anchor for Shift+J/K and Shift-click ranges. */
  rangeAnchorRef: Ref<ConversationRef | null>;
  /** Last bound/scope explanation (limit reached, select-all refused). */
  selectionNotice: Ref<string | null>;
  isSelected(target: ConversationRef): boolean;
  /** X / checkbox / Cmd-click: toggle one row and set the anchor there. */
  toggleSelected(target: ConversationRef): void;
  /** Shift+J/K / Shift-click: additive inclusive anchor→target range. */
  extendSelectionTo(target: ConversationRef, fallbackAnchor: ConversationRef | null): void;
  /** Select all currently loaded rows; refuses beyond the bound with wording. */
  selectAllLoaded(): void;
  clearSelection(): void;
  /** Exact selected references frozen in current loaded order (dispatch input). */
  selectionInLoadedOrder(): ConversationRef[];
  // --- UX-05 group actions and single-or-group pending model ---
  /** Single-slot group notice; a newer single/group action replaces it. */
  lastGroup: Ref<GroupNotice | null>;
  /** True only while a group IPC round trip or its recovery replay is open. */
  groupInFlight: Ref<boolean>;
  /** True while a group acceptance or its receipt recovery is unresolved. */
  bulkUnresolved: ComputedRef<boolean>;
  setArchivedGroup(members: ConversationRef[], archived: boolean): Promise<boolean>;
  setReadGroup(members: ConversationRef[], read: boolean): Promise<boolean>;
  /** Lost-response recovery: query/replay the ORIGINAL request id. */
  recoverGroupAcceptance(): Promise<void>;
  dismissGroupNotice(): void;
  /** Partial group Undo (one attempt); rejects surface through the slot. */
  undoGroupAction(): Promise<GroupUndoReceipt | null>;
  /** Activity: bounded recent group summaries, independent of list rows. */
  recentGroups: Ref<OperationGroupSummary[]>;
  /** True when the most recent group-history read failed (not an empty result). */
  groupsError: Ref<MailError | null>;
  /** True when the backend returned a continuation cursor for more groups. */
  groupsHasMore: Ref<boolean>;
  /** Shared history-read ownership: refresh and continuation cannot overlap. */
  groupsLoadingMore: Ref<boolean>;
  /** Bounded Activity continuation: appends the next recent-groups page. */
  loadMoreGroups(): Promise<void>;
  /** Retry a failed recent-groups history read. */
  refreshGroups(): Promise<void>;
  /** Activity: detail for one group by request id; null while loading/absent. */
  groupDetail: Ref<OperationGroupStatus | null>;
  /** True when the most recent group-detail read failed (not absence). */
  groupDetailError: Ref<MailError | null>;
  openGroupDetail(requestId: string): Promise<void>;
  /** Undo an arbitrary addressable group from Activity detail. */
  undoGroupById(groupId: string): Promise<GroupUndoReceipt | null>;
  enableMailboxActions(): Promise<void>;
  cancelMailboxActionUpgrade(): Promise<void>;
  archiveFocused(): Promise<void>;
}

export function useMailbox(client: MailClient): Mailbox {
  const context = ref<BrowseContext>('inbox');
  const starredOnly = ref(false);
  const savedSplit = ref<SavedSplit | null>(null);
  const splitError = ref<MailError | null>(null);
  const splitBusy = ref(false);
  const inboxTotal = ref<number | null>(null);
  const savedTotal = ref<number | null>(null);
  const unreadOnly = ref(false);
  const searchQuery = ref('');
  const searchCoverage = ref('');
  const searchCachedOnly = ref(false);
  const loadingMore = ref(false);
  const loadedDonePages = ref(1);
  const loadedDoneBoundary = ref<DoneBoundary | null>(null);
  const nextCursor = ref<string | null>(null);
  const exactTotal = ref<number | null>(null);
  const lastSyncedAt = ref<string | null>(null);
  const activityError = ref<MailError | null>(null);
  const conversations = ref<ConversationSummaryLike[]>([]);
  const activity = ref<OperationSummaryLike[]>([]);
  const listState = ref<ListState>('loading');
  const listError = ref<MailError | null>(null);
  const focusedRef = ref<ConversationRef | null>(null);
  const openRef = ref<ConversationRef | null>(null);
  const conversation = ref<Conversation | null>(null);
  const detailState = ref<DetailState>('idle');
  const detailError = ref<MailError | null>(null);
  const lastCommandError = ref<MailError | null>(null);
  const inFlightCommandRef = ref<ConversationRef | null>(null);
  const commandInFlight = ref(false);
  const lastAction = ref<LastAction | null>(null);

  const {
    selectedRefs, rangeAnchorRef, selectionNotice, isSelected, toggleSelected, extendSelectionTo,
    selectAllLoaded, clearSelection, intersectSelectionWithLoaded, selectionInLoadedOrder,
  } = useMailboxSelection({ rows: () => conversations.value, targetAvailable: (target) => savedTargetAvailable(target) });

  let readerSource: 'list' | 'activity' = 'list';
  let listToken = 0;
  // Explicit query/navigation ownership must survive routine list refreshes.
  let navigationIntentToken = 0;
  let activityToken = 0;
  let detailToken = 0;
  let commandToken = 0;
  let mailboxSessionToken = 0;
  let detached = false;
  let unsubscribe: (() => void) | null = null;
  let subscriptionAttempt: Promise<void> | null = null;

  // Read-only views of the parent's session counters and the shared command fence;
  // the extracted pieces compare what they captured against these after every await.
  const session: MailboxSession = {
    get generation() { return mailboxSessionToken; },
    get detached() { return detached; },
  };
  const commands: CommandFence = { next: () => ++commandToken, current: () => commandToken };
  const {
    accountStatus, accountState, accountError, accountBusy, mode, isGmail, refreshAccountStatus,
    connectAccount, disconnectAccount, requestSync, enableMailboxActions, cancelMailboxActionUpgrade,
  } = useMailboxAccount({
    client, session,
    supersedeNavigation: () => invalidateSearchIntent(),
    onAccountChanged: () => resetForAccountChange(),
    onDisconnected: () => resetAfterDisconnect(),
    refresh: () => refresh(),
    lastCommandError,
  });
  const {
    heldConversation, currentDetailEpoch, adoptablePrefetch, invalidateDetailCache, cachePut, cacheGet,
    clearHold, beginHold, prefetchConversation,
  } = useMailboxDetailCache({
    client, session,
    searchContext: () => context.value === 'search',
    detailState, openRef, readerSource: () => readerSource,
  });
  const {
    lastGroup, groupInFlight, bulkUnresolved, recentGroups, groupsError, groupsHasMore, groupsLoadingMore,
    groupDetail, groupDetailError, setArchivedGroup, setReadGroup, setStarredGroup, recoverGroupAcceptance,
    dismissGroupNotice, undoGroupAction, undoGroupById, loadMoreGroups, refreshGroups, openGroupDetail,
    clearGroupSurfaces, afterAuthoritativeRefresh: afterGroupRefresh,
  } = useMailboxGroups({
    client, session, commands,
    accountId: () => accountStatus.value?.account?.accountId,
    mode: () => accountStatus.value?.mode,
    savedTargetAvailable: (target) => savedTargetAvailable(target),
    mutationsAllowed: () => mutationsAllowed(),
    refresh: () => refresh(),
    repointLastAction: () => repointLastAction(),
    lastAction, lastCommandError, commandInFlight, inFlightCommandRef, activity,
  });

  async function ensureSubscribed(): Promise<void> {
    if (unsubscribe || detached) return;
    if (!subscriptionAttempt) {
      // Share an in-flight attempt; a failed attempt is retried on Retry/focus/online.
      subscriptionAttempt = Promise.resolve()
        .then(() => client.subscribe(() => { void refresh(); }))
        .then((unsub) => {
          if (detached) unsub();
          else unsubscribe = unsub;
        })
        .finally(() => { subscriptionAttempt = null; });
    }
    await subscriptionAttempt;
  }

  function sameSplit(a: SavedSplit | null, b: SavedSplit | null): boolean {
    return a === b || (a !== null && b !== null && a.name === b.name
      && a.criterion === b.criterion && a.value === b.value
      && a.enabled === b.enabled && a.hideWhenEmpty === b.hideWhenEmpty);
  }

  /** A new rule cannot inherit the old view's rows, selection or reader visit. */
  function invalidateSavedView(): void {
    if (context.value !== 'saved') return;
    // Activity owns an explicit recovery visit, independent of split membership.
    if (readerSource !== 'activity') closeReader(); // fences old list-detail reads
    clearSelection();
    focusedRef.value = null;
    conversations.value = [];
    listState.value = 'loading';
    listError.value = null;
    inboxTotal.value = null;
    savedTotal.value = null;
  }

  /** Independent cache filters compose by intersection; unknown facts never qualify.
   *  Cached Trash is a read-only recovery view: it always lists everything, so the unread filter never applies there. */
  function matchesCachedFilters(row: ConversationSummaryLike): boolean {
    return (!unreadOnly.value || context.value === 'trash' || row.isRead === false)
      && (!starredOnly.value || (row.stars?.starredMessages ?? 0) > 0);
  }

  /** Cached Done, Starred and Trash share one paged, replayable list read. */
  function isCachedList(source: BrowseContext): source is 'done' | 'starred' | 'trash' {
    return source === 'done' || source === 'starred' || source === 'trash';
  }

  function readCachedPage(source: 'done' | 'starred' | 'trash', accountId: string, cursor: string | null): Promise<CachedDoneSnapshot | CachedTrashSnapshot> {
    const request = { accountId, limit: 100, cursor };
    return source === 'starred' ? client.listCachedStarred(request)
      : source === 'trash' ? client.listCachedTrash(request)
      : client.listCachedDone(request);
  }

  async function refreshList(token: number): Promise<void> {
    const source = context.value;
    const account = accountStatus.value?.account?.accountId;
    // Activity always comes from the unfiltered inbox snapshot, not Done rows.
    const activityRequest = ++activityToken;
    const inbox = client.listConversations();
    const activityRead = inbox.then((snap) => {
      if (detached || activityRequest !== activityToken) return;
      activity.value = snap.activity;
      activityError.value = null;
    }, (raw) => {
      if (!detached && activityRequest === activityToken) {
        activityError.value = toMailError(raw);
      }
    });
    const current = (): boolean => !detached && token === listToken && source === context.value;
    // Stage the definition with the exact Inbox snapshot used for membership and
    // totals. Activity never publishes projection state, even if it finishes first.
    const projectionRead = (async () => {
      let definition = savedSplit.value;
      let definitionError: MailError | null = null;
      if (account) {
        try {
          definition = await client.getSavedSplit(account);
          if (!current()) return null;
          if (!sameSplit(definition, savedSplit.value)) invalidateSavedView();
        } catch (raw) {
          if (!current()) return null;
          definitionError = toMailError(raw);
          if (source === 'saved') {
            invalidateSavedView();
            splitError.value = definitionError;
            throw raw;
          }
        }
      }
      const snap = await inbox;
      if (!current()) return null;
      const matching = definition ? snap.conversations.filter((row) => matchesSplit(row, definition!)) : [];
      return { definition, definitionError, snap, matching };
    })();
    // Only Inbox, Saved and the cached lists consume the projection. Drafts,
    // Reminders and Search never await it, so a failed Inbox read must not
    // surface as an unhandled rejection there. Awaiting callers still see it.
    projectionRead.catch(() => {});
    const publishProjection = (projection: NonNullable<Awaited<typeof projectionRead>>): void => {
      savedSplit.value = projection.definition;
      splitError.value = projection.definitionError;
      inboxTotal.value = projection.snap.conversations.length;
      savedTotal.value = projection.definitionError ? null : projection.matching.length;
    };
    // Done owns its own list read. A delayed/failed Inbox or definition read must
    // not hold Done rows hostage; its badges still use a fenced projection pair.
    const doneProjection = isCachedList(source) ? projectionRead.then((projection) => {
      if (current() && projection) publishProjection(projection);
    }, () => {
      if (current()) { inboxTotal.value = null; savedTotal.value = null; }
    }) : null;
    try {
      if (source === 'reminders' || source === 'drafts') {
        // These lists read their own transports; the mailbox list is empty.
        if (!current()) return;
        conversations.value = [];
        focusedRef.value = null;
        listError.value = null;
        listState.value = 'ready';
        return;
      }
      if (source === 'search') {
        // Background invalidations refresh loaded identities from cached facts, not
        // a new provider traversal that would discard the user's loaded pages.
        if (listState.value === 'loading' || listState.value === 'error') {
          const page = await client.searchMail({ accountId: account!, query: searchQuery.value, cursor: null, cachedOnly: searchCachedOnly.value });
          if (detached || token !== listToken || context.value !== 'search') return;
          conversations.value = page.conversations;
          nextCursor.value = page.nextCursor;
          searchCoverage.value = page.coverage;
          // Pin the continuation mode chosen by the backend (e.g. offline),
          // so reconnection cannot reinterpret a cached cursor as provider data.
          if (page.coverage === 'cached_incomplete') searchCachedOnly.value = true;
        } else if (conversations.value.length) {
          // Update authoritative action/read overlays without re-running a
          // provider traversal or replacing the loaded query/page identities.
          const refreshed = new Map<string, ConversationSummaryLike>();
          let cursor: string | null = null;
          for (let pageNumber = 0; pageNumber < 5; pageNumber += 1) {
            const page = await client.searchMail({ accountId: account!, query: searchQuery.value, cursor, cachedOnly: true });
            if (detached || token !== listToken || context.value !== 'search') return;
            for (const row of page.conversations) refreshed.set(row.ref.conversationId, row);
            cursor = page.nextCursor;
            if (!cursor || conversations.value.every((row) => refreshed.has(row.ref.conversationId))) break;
          }
          conversations.value = conversations.value.map((row) => refreshed.get(row.ref.conversationId) ?? row);
        }
        if (detached || token !== listToken || context.value !== 'search') return;
        focusedRef.value = resolveFocus(conversations.value, focusedRef.value, conversations.value);
        listState.value = 'ready';
        listError.value = null;
        return;
      }
      const projection = (source === 'inbox' || source === 'saved') ? await projectionRead : null;
      const initial = (source === 'inbox' || source === 'saved') ? projection?.snap : await readCachedPage(source, account!, null);
      if (!current() || !initial) return;
      let snap = initial;
      if (projection) {
        if (source === 'saved') {
          if (!projection.definition?.enabled) {
            publishProjection(projection);
            await setContext('inbox');
            return;
          }
          snap = { ...snap, conversations: projection.matching };
        }
      }
      if (isCachedList(source) && 'nextCursor' in snap) {
        // Recover the saved identity range even when new archives shift page edges.
        const pages = loadedDonePages.value;
        const boundary = loadedDoneBoundary.value;
        let replayed = 1;
        while (snap.nextCursor && (replayed < pages || !reachesBoundary(snap.conversations, boundary))) {
          if (detached || token !== listToken || source !== context.value) return;
          // Finite recovery budget beyond the user's explicitly loaded range.
          // Never misclassify an uninspected target as removed on budget exhaustion.
          if (replayed >= pages + 10) throw { kind: 'invalid_request', field: 'cachedDoneRestoreRange' } satisfies MailError;
          const next = await readCachedPage(source, account!, snap.nextCursor);
          snap = { ...next, conversations: [...snap.conversations, ...next.conversations.filter((row) => !snap.conversations.some((old) => sameConversation(old.ref, row.ref)))] };
          replayed += 1;
        }
        if (detached || token !== listToken || source !== context.value) return;
        loadedDonePages.value = replayed;
      }
      if (detached || token !== listToken || source !== context.value) return;
      const previous = conversations.value;
      conversations.value = snap.conversations.filter(matchesCachedFilters);
      if (isCachedList(source) && 'nextCursor' in snap) {
        nextCursor.value = snap.nextCursor;
        exactTotal.value = snap.exactTotal;
        lastSyncedAt.value = snap.lastSyncedAt;
        loadedDoneBoundary.value = boundaryOf(snap.conversations);
      }
      focusedRef.value = resolveFocus(previous, focusedRef.value, conversations.value);
      intersectSelectionWithLoaded();
      if (projection) publishProjection(projection);
      listError.value = null;
      listState.value = 'ready';
    } finally { await Promise.all([activityRead, doneProjection]); }
  }

  async function restoreSearch(visit: SearchVisit): Promise<void> {
    ++navigationIntentToken;
    ++listToken;
    void client.cancelSearchMail().catch(() => {});
    closeReader();
    clearSelection();
    context.value = 'search';
    searchQuery.value = visit.query;
    searchCachedOnly.value = visit.cachedOnly;
    searchCoverage.value = visit.coverage;
    conversations.value = visit.rows;
    nextCursor.value = visit.cursor;
    focusedRef.value = resolveFocus([], null, visit.rows);
    listState.value = 'ready';
    listError.value = null;
    loadingMore.value = false;
  }

  function invalidateSearchIntent(): void {
    ++navigationIntentToken;
  }

  function captureNavigationIntent(): () => boolean {
    const intent = navigationIntentToken;
    return () => !detached && intent === navigationIntentToken;
  }

  async function search(query: string, cachedOnly = false): Promise<void> {
    const account = accountStatus.value?.account?.accountId;
    if (detached || !account || accountBusy.value === 'connect' || accountBusy.value === 'disconnect') return;
    const intent = ++navigationIntentToken;
    const source = context.value;
    ++listToken;
    await client.cancelSearchMail().catch(() => {});
    // Refreshes may replace list reads while cancellation is pending, but only
    // a newer explicit intent or account/context change may discard submission.
    if (detached || intent !== navigationIntentToken
      || account !== accountStatus.value?.account?.accountId || source !== context.value) return;
    searchQuery.value = query;
    searchCachedOnly.value = cachedOnly;
    searchCoverage.value = '';
    context.value = 'search';
    closeReader();
    clearSelection();
    conversations.value = [];
    focusedRef.value = null;
    nextCursor.value = null;
    listState.value = 'loading';
    listError.value = null;
    await refresh();
  }

  async function setContext(next: BrowseContext, pages = 1, boundary: DoneBoundary | null = null, filter = false): Promise<void> {
    // Even choosing the current destination supersedes a pending submission.
    ++navigationIntentToken;
    if (next === 'saved' && (!savedSplit.value?.enabled || splitError.value)) next = 'inbox';
    if (next === context.value && filter === starredOnly.value && listState.value === 'ready') return;
    starredOnly.value = filter;
    void client.cancelSearchMail().catch(() => {});
    loadedDonePages.value = Math.max(1, Math.floor(pages));
    loadedDoneBoundary.value = boundary;
    ++listToken;
    closeReader();
    context.value = next;
    conversations.value = [];
    focusedRef.value = null;
    // Browsing-context changes clear selection and anchor; Back restores
    // navigation, never the old selected set (approved decision 4).
    clearSelection();
    nextCursor.value = null;
    exactTotal.value = null;
    lastSyncedAt.value = null;
    listState.value = 'loading';
    listError.value = null;
    await refresh();
  }

  async function setUnreadOnly(unread: boolean): Promise<void> {
    if (unread === unreadOnly.value) return;
    unreadOnly.value = unread;
    closeReader();
    clearSelection();
    focusedRef.value = null;
    conversations.value = [];
    listState.value = 'loading';
    await refresh();
  }

  async function saveSplit(split: SavedSplit): Promise<boolean> {
    const account = accountStatus.value?.account?.accountId;
    if (!account || splitBusy.value) return false;
    const session = mailboxSessionToken;
    splitBusy.value = true;
    splitError.value = null;
    try {
      await client.saveSavedSplit(account, split);
      if (detached || session !== mailboxSessionToken) return false;
      // Fence reads started before acceptance (including the save change hint).
      // Keep the published definition until matching rows/totals are ready.
      ++listToken;
      invalidateSavedView();
      savedTotal.value = null;
      await refresh();
      return true;
    } catch (raw) {
      if (!detached && session === mailboxSessionToken) splitError.value = toMailError(raw);
      return false;
    } finally { if (session === mailboxSessionToken) splitBusy.value = false; }
  }

  async function loadMore(): Promise<void> {
    const source = context.value;
    const cursor = nextCursor.value;
    const account = accountStatus.value?.account?.accountId;
    if (source === 'inbox' || source === 'saved' || source === 'reminders' || source === 'drafts' || !cursor || !account || loadingMore.value || listState.value !== 'ready') return;
    const token = ++listToken;
    loadingMore.value = true;
    try {
      const snap = source === 'search'
        ? await client.searchMail({ accountId: account, query: searchQuery.value, cachedOnly: searchCachedOnly.value, cursor })
        : await readCachedPage(source, account, cursor);
      if (detached || token !== listToken || context.value !== source) return;
      conversations.value = [...conversations.value, ...snap.conversations.filter((row: ConversationSummaryLike) => matchesCachedFilters(row) && !conversations.value.some((old) => sameConversation(old.ref, row.ref)))];
      focusedRef.value = resolveFocus(conversations.value, focusedRef.value, conversations.value);
      loadedDonePages.value += 1;
      loadedDoneBoundary.value = boundaryOf(snap.conversations) ?? loadedDoneBoundary.value;
      nextCursor.value = snap.nextCursor;
      if ('lastSyncedAt' in snap) { exactTotal.value = snap.exactTotal; lastSyncedAt.value = snap.lastSyncedAt; }
      listState.value = 'ready';
      listError.value = null;
    } catch (raw) {
      if (detached || token !== listToken) return;
      listError.value = toMailError(raw);
      listState.value = context.value === 'search' ? 'ready' : 'error';
    } finally { if (token === listToken) loadingMore.value = false; }
  }

  /**
   * Focus resolution across snapshots. A surviving reference wins; otherwise the
   * next surviving row from the old ordering, then the previous survivor, then
   * the first available new row. An empty result clears focus, and an initial
   * nonempty load focuses the first row.
   */
  function resolveFocus(
    previous: ConversationSummaryLike[],
    focused: ConversationRef | null,
    next: ConversationSummaryLike[],
  ): ConversationRef | null {
    if (next.length === 0) return null;
    const survives = (target: ConversationRef | null): boolean =>
      target !== null && next.some((row) => sameConversation(row.ref, target));
    if (survives(focused)) return focused;
    const oldIndex = focused === null ? -1 : previous.findIndex((row) => sameConversation(row.ref, focused));
    if (oldIndex >= 0) {
      for (let i = oldIndex + 1; i < previous.length; i += 1) {
        const candidate = previous[i]!.ref;
        if (survives(candidate)) return candidate;
      }
      for (let i = oldIndex - 1; i >= 0; i -= 1) {
        const candidate = previous[i]!.ref;
        if (survives(candidate)) return candidate;
      }
    }
    return next[0]!.ref;
  }

  /** The account identity changed: nothing from the previous account may survive. */
  function resetForAccountChange(): void {
    ++navigationIntentToken;
    ++listToken;
    ++activityToken;
    activityError.value = null;
    ++mailboxSessionToken;
    ++commandToken;
    inFlightCommandRef.value = null;
    commandInFlight.value = false;
    lastAction.value = null;
    lastGroup.value = null;
    groupInFlight.value = false;
    clearGroupSurfaces();
    clearSelection();
    exactTotal.value = null;
    lastSyncedAt.value = null;
    closeReader();
    conversations.value = [];
    activity.value = [];
    focusedRef.value = null;
    context.value = 'inbox';
    starredOnly.value = false;
    savedSplit.value = null;
    splitError.value = null;
    splitBusy.value = false;
    inboxTotal.value = null;
    savedTotal.value = null;
    unreadOnly.value = false;
    searchQuery.value = '';
    searchCoverage.value = '';
    void client.cancelSearchMail().catch(() => {});
    loadedDonePages.value = 1;
    loadedDoneBoundary.value = null;
    nextCursor.value = null;
    listState.value = 'loading';
    queueMicrotask(() => { if (!detached) void refresh(); });
  }

  /** A successful disconnect: drop every cached surface and fence in-flight reads. */
  function resetAfterDisconnect(): void {
    context.value = 'inbox';
    starredOnly.value = false;
    savedSplit.value = null;
    splitError.value = null;
    splitBusy.value = false;
    inboxTotal.value = null;
    savedTotal.value = null;
    unreadOnly.value = false;
    nextCursor.value = null;
    loadedDonePages.value = 1;
    loadedDoneBoundary.value = null;
    loadingMore.value = false;
    exactTotal.value = null;
    lastSyncedAt.value = null;
    // Drop every cached surface immediately and invalidate in-flight reads so stale
    // responses cannot repopulate the UI after a disconnect.
    closeReader();
    listToken += 1;
    activityToken += 1;
    activityError.value = null;
    detailToken += 1;
    commandToken += 1;
    mailboxSessionToken += 1;
    inFlightCommandRef.value = null;
    commandInFlight.value = false;
    lastAction.value = null;
    lastGroup.value = null;
    groupInFlight.value = false;
    clearGroupSurfaces();
    clearSelection();
    conversations.value = [];
    activity.value = [];
    // Focus is account-scoped: a new account starts with no conversation focus.
    focusedRef.value = null;
  }

  async function refresh(): Promise<void> {
    if (detached) return;
    const token = ++listToken;
    loadingMore.value = false;
    // Any list/status reload may reflect a mailbox change: no cached detail
    // may be shown as fresh afterwards.
    invalidateDetailCache();
    try {
      // Subscription-before-read: events are registered before any status/list/detail
      // read so a change occurring mid-refresh cannot be lost. A successful list alone
      // must not hide a broken change subscription.
      await ensureSubscribed();
      if (detached) return;
      // Status failures are handled inside refreshStatus (the UI gate renders them
      // fail-closed); list/detail failures reject into the catch below.
      // Bootstrap the account once; subsequent status/list reads remain
      // independent, preserving Activity and mutation refresh ownership.
      const bootstrap = !accountStatus.value;
      if (bootstrap) await refreshAccountStatus();
      if (detached) return;
      await Promise.all([
        bootstrap ? Promise.resolve() : refreshAccountStatus(),
        refreshList(token),
        openRef.value ? loadDetail(openRef.value, true) : Promise.resolve(),
      ]);
      if (detached || token !== listToken) return;
      afterGroupRefresh();
    } catch (raw) {
      if (detached || token !== listToken) return;
      inboxTotal.value = null;
      savedTotal.value = null;
      listError.value = toMailError(raw);
      listState.value = 'error';
    }
  }

  async function loadDetail(
    target: ConversationRef,
    background = false,
    source: 'list' | 'activity' = 'list',
    neighbor = false,
  ): Promise<void> {
    if (detached) return;
    const token = ++detailToken;
    let adopted: Promise<Conversation> | null = null;
    if (!background) {
      readerSource = source;
      invalidateSearchIntent();
      // Only J/K moves may keep the previous conversation on screen.
      const shown = neighbor ? conversation.value ?? heldConversation.value : null;
      // New object records explicit navigation independently of background refreshes.
      openRef.value = { ...target };
      conversation.value = null;
      detailState.value = 'loading';
      detailError.value = null;
      if (neighbor && source === 'list') {
        const hit = cacheGet(target);
        if (hit) {
          // Instant swap; revalidate through the ordinary background path.
          clearHold();
          conversation.value = hit;
          detailState.value = 'ready';
          void loadDetail(target, true);
          return;
        }
        adopted = adoptablePrefetch(target);
      }
      beginHold(shown);
    }
    const epoch = currentDetailEpoch();
    try {
      const conv = await (adopted ?? client.getConversation(target, context.value === 'search'));
      if (detached || token !== detailToken || !sameConversation(openRef.value, target)) return;
      if (readerSource === 'list') cachePut(conv, epoch);
      clearHold();
      conversation.value = conv;
      detailState.value = 'ready';
      detailError.value = null;
    } catch (raw) {
      if (detached || token !== detailToken || !sameConversation(openRef.value, target)) return;
      clearHold();
      detailError.value = toMailError(raw);
      detailState.value = 'error';
      conversation.value = null;
    }
  }

  function focusConversation(target: ConversationRef | null): void {
    if (target && !savedTargetAvailable(target)) return;
    focusedRef.value = target === null ? null : { accountId: target.accountId, conversationId: target.conversationId };
  }

  function moveFocus(delta: number): void {
    if (conversations.value.length === 0) return;
    const currentIndex = conversations.value.findIndex((row) => sameConversation(row.ref, focusedRef.value));
    const targetIndex = currentIndex < 0
      ? 0
      : Math.min(conversations.value.length - 1, Math.max(0, currentIndex + delta));
    focusConversation(conversations.value[targetIndex]!.ref);
  }

  function loadedContains(target: ConversationRef): boolean {
    return conversations.value.some((row) => sameConversation(row.ref, target));
  }

  async function openConversationByRef(target: ConversationRef, source: 'list' | 'activity' = 'list'): Promise<void> {
    if (source === 'activity') {
      // Recovery is an explicit account-scoped source, not a stale list callback.
      if (target.accountId !== accountStatus.value?.account?.accountId) return;
    } else if (!savedTargetAvailable(target)) return;
    await loadDetail(target, false, source);
  }

  async function openNeighbor(target: ConversationRef): Promise<void> {
    if (!savedTargetAvailable(target)) return;
    await loadDetail(target, false, 'list', true);
  }

  async function openFocused(): Promise<void> {
    // A non-ready or stale list must never supply an open target.
    if (listState.value !== 'ready') return;
    const summary = focusedSummary.value;
    if (summary) await loadDetail(summary.ref);
  }

  function closeReader(): void {
    readerSource = 'list';
    detailToken += 1;
    invalidateDetailCache();
    clearHold();
    openRef.value = null;
    conversation.value = null;
    detailState.value = 'idle';
    detailError.value = null;
  }

  // Only saved-view targets need this membership fence. Recovery/Undo owns
  // immutable operation targets independently, and ordinary Inbox/Done behavior
  // is unchanged. An existing reader may outlive ordinary membership refreshes,
  // but definition invalidation always closes that visit.
  function savedTargetAvailable(target: ConversationRef, allowReader = false): boolean {
    const openTarget = allowReader && detailState.value === 'ready'
      && sameConversation(openRef.value, target) && sameConversation(conversation.value?.ref ?? null, target);
    return context.value !== 'saved' || (readerSource === 'activity' && openTarget)
      || (listState.value === 'ready' && (loadedContains(target) || openTarget));
  }

  function mutationsAllowed(): boolean {
    if (accountState.value !== 'ready' || !accountStatus.value) {
      lastCommandError.value = { kind: 'invalid_request', field: 'accountStatus' };
      return false;
    }
    if (accountStatus.value.mode === 'gmail' && accountStatus.value.mutationAccess !== 'enabled') {
      lastCommandError.value = { kind: 'read_only' };
      return false;
    }
    // Duplicate-mutation fence: while a group acceptance or its receipt recovery
    // is unresolved, no further mutation dispatch (single or group) may start.
    if (bulkUnresolved.value || commandInFlight.value || inFlightCommandRef.value !== null) {
      lastCommandError.value = { kind: 'busy' };
      return false;
    }
    // A mutation is about to start: cached neighbor state is no longer trusted.
    invalidateDetailCache();
    return true;
  }

  async function submitMutation(
    send: (requestId: string) => Promise<OperationReceipt>,
    target: ConversationRef | null,
  ): Promise<OperationReceipt | null> {
    if (!mutationsAllowed()) return null;
    const token = ++commandToken;
    const sessionToken = mailboxSessionToken;
    commandInFlight.value = true;
    inFlightCommandRef.value = target ? { ...target } : null;
    try {
      const receipt = await send(crypto.randomUUID());
      if (detached || sessionToken !== mailboxSessionToken) return receipt;
      if (token === commandToken) lastCommandError.value = null;
      // A newer single action replaces a resolved group notice (single slot).
      if (lastGroup.value?.state === 'accepted') lastGroup.value = null;
      // A successful receipt is authoritative acceptance even if a newer
      // command owns the error slot. Events are best-effort, so refresh this
      // account session rather than dropping the older accepted operation.
      await refresh();
      return receipt;
    } catch (raw) {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        lastCommandError.value = toMailError(raw);
      }
      return null;
    } finally {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        inFlightCommandRef.value = null;
        commandInFlight.value = false;
      }
    }
  }

  async function setArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null> {
    if (!savedTargetAvailable(target, true)) return null;
    return submitArchived(target, archived);
  }

  /** Explicit recovery authority: only a current-account, restorable Activity
   * target, never a saved-list callback or a reader/loading-state exception. */
  async function unarchiveFromActivity(target: ConversationRef): Promise<OperationReceipt | null> {
    if (detached || target.accountId !== accountStatus.value?.account?.accountId) return null;
    const restorable = activity.value.some((op) => sameConversation(op.conversation, target)
      && (op.kind === undefined || op.kind === 'archive') && op.requestedArchived && op.status !== 'cancelled');
    if (!restorable) return null;
    return submitArchived(target, false);
  }

  /** Shared durable setter/notice pipeline; callers establish target authority. */
  async function submitArchived(target: ConversationRef, archived: boolean): Promise<OperationReceipt | null> {
    const subject = subjectFor(target);
    // Fenced at CALL time: an account identity change while the IPC round trip is
    // pending must never repopulate the notice with the previous account's op.
    const sessionToken = mailboxSessionToken;
    const receipt = await submitMutation(
      (requestId) => client.setArchived({ conversation: { ...target }, archived, requestId }),
      target,
    );
    if (receipt && !detached && sessionToken === mailboxSessionToken) {
      recordLastAction(receipt, archived ? 'archive' : 'unarchive', target, subject);
    }
    return receipt;
  }

  async function setStarred(target: ConversationRef, starred: boolean): Promise<OperationReceipt | null> {
    if (!savedTargetAvailable(target, true)) return null;
    if (accountStatus.value?.mode !== 'gmail') {
      lastCommandError.value = { kind: 'read_only' };
      return null;
    }
    const subject = subjectFor(target);
    const session = mailboxSessionToken;
    const receipt = await submitMutation(requestId => client.setStarred({ conversation: { ...target }, starred, requestId }), target);
    if (receipt && !detached && session === mailboxSessionToken) recordLastAction(receipt, starred ? 'star' : 'unstar', target, subject);
    return receipt;
  }
  async function setRead(target: ConversationRef, read: boolean): Promise<OperationReceipt | null> {
    if (!savedTargetAvailable(target, true)) return null;
    if (accountStatus.value?.mode !== 'gmail') {
      lastCommandError.value = { kind: 'read_only' };
      return null;
    }
    const subject = subjectFor(target);
    // Same call-time session fence as setArchived.
    const sessionToken = mailboxSessionToken;
    const receipt = await submitMutation(
      (requestId) => client.setRead({ conversation: { ...target }, read, requestId }),
      target,
    );
    if (receipt && !detached && sessionToken === mailboxSessionToken) {
      recordLastAction(receipt, read ? 'read' : 'unread', target, subject);
    }
    return receipt;
  }

  /** Best-effort subject at action time; rows may vanish during the refresh.
   * Returns null rather than a raw conversation id — the id is never a subject. */
  function subjectFor(target: ConversationRef): string | null {
    const row = conversations.value.find((entry) => sameConversation(entry.ref, target));
    if (row) return row.subject;
    const open = conversation.value;
    if (open && sameConversation(open.ref, target)) return open.subject;
    return null;
  }

  function recordLastAction(receipt: OperationReceipt, actionId: LastActionId, target: ConversationRef, subject: string | null): void {
    const operation = activity.value.find((item) => item.id === receipt.operationId);
    const undoableUntil = operation?.undoableUntil ?? null;
    lastAction.value = {
      receipt: { ...receipt },
      actionId,
      target: { ...target },
      subject,
      undoableUntil,
      hadWindow: undoableUntil !== null,
      undone: null,
    };
  }

  /**
   * On `superseded`, re-point the slot at the newest still-undoable activity
   * row instead of guessing: only the backend knows which operation (if any)
   * currently satisfies the undo rules. Only `receipt.operationId` is consumed
   * after re-pointing; the receipt's `acceptedAt` is not a real acceptance.
   */
  function repointLastAction(): void {
    const candidates = activity.value.filter((item) => item.undoableUntil !== undefined);
    let newest: OperationSummaryLike | null = null;
    for (const item of candidates) {
      if (!newest || (item.undoableUntil ?? '') >= (newest.undoableUntil ?? '')) newest = item;
    }
    if (!newest) {
      lastAction.value = null;
      return;
    }
    lastAction.value = {
      // Only the operation id is consumed from a re-pointed slot; no fake
      // acceptedAt is invented (undoableUntil is carried on the slot itself).
      receipt: { operationId: newest.id },
      actionId: newest.kind === 'star' ? (newest.requestedStarred ? 'star' : 'unstar') : newest.kind === 'read' ? (newest.requestedRead ? 'read' : 'unread') : newest.requestedArchived ? 'archive' : 'unarchive',
      target: { ...newest.conversation },
      subject: subjectFor(newest.conversation),
      undoableUntil: newest.undoableUntil ?? null,
      hadWindow: true,
      undone: null,
    };
  }

  async function undoLastAction(): Promise<UndoReceipt | null> {
    const slot = lastAction.value;
    if (!slot) return null;
    if (!mutationsAllowed()) return null;
    const token = ++commandToken;
    const sessionToken = mailboxSessionToken;
    commandInFlight.value = true;
    inFlightCommandRef.value = { ...slot.target };
    try {
      const receipt = await client.undoOperation({ operationId: slot.receipt.operationId, requestId: crypto.randomUUID() });
      if (detached || sessionToken !== mailboxSessionToken) return receipt;
      if (token === commandToken) lastCommandError.value = null;
      await refresh();
      if (detached || sessionToken !== mailboxSessionToken) return receipt;
      // The action is undone (no redo level), but the slot STAYS: the notice
      // reports Cancelled / Restored / the compensation outcome from the
      // refreshed compensating rows. The window is closed by definition. Only
      // the undone operation's own slot is written back — a newer action
      // recorded during the undo's refresh must not be clobbered.
      if (lastAction.value?.receipt.operationId === slot.receipt.operationId) {
        lastAction.value = { ...slot, undoableUntil: null, undone: receipt };
      }
      return receipt;
    } catch (raw) {
      if (detached || sessionToken !== mailboxSessionToken || token !== commandToken) return null;
      const error = toMailError(raw);
      lastCommandError.value = error;
      if (error.kind === 'undo_unavailable' && error.reason === 'superseded') {
        await refresh();
        if (!detached) repointLastAction();
      }
      if (error.kind === 'undo_unavailable' && error.reason === 'expired') {
        // Mirror the superseded branch: the authoritative row no longer carries
        // undoableUntil, so refresh FIRST — the notice wording derives from the
        // refreshed activity — then close the slot window on the backend's
        // decision.
        await refresh();
        if (!detached) lastAction.value = { ...slot, undoableUntil: null };
      }
      // Activity / Mark not done stay reachable either way.
      return null;
    } finally {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        inFlightCommandRef.value = null;
        commandInFlight.value = false;
      }
    }
  }

  async function retryOperation(operationId: string): Promise<OperationReceipt | null> {
    if (mode.value !== 'gmail') {
      lastCommandError.value = { kind: 'invalid_request', field: 'mode' };
      return null;
    }
    return submitMutation(
      (requestId) => client.retryOperation({ operationId, requestId }),
      null,
    );
  }

  async function archiveFocused(): Promise<void> {
    // A non-ready or stale list must never supply an action target.
    if (listState.value !== 'ready') return;
    const summary = focusedSummary.value;
    if (summary) await setArchived(summary.ref, true);
  }

  const ready = refresh();
  const onWindowFocus = (): void => { void refresh(); };
  const onReconnect = (): void => { void refresh(); };
  window.addEventListener('focus', onWindowFocus);
  window.addEventListener('online', onReconnect);

  onScopeDispose(() => {
    detached = true;
    ++navigationIntentToken;
    void client.cancelSearchMail().catch(() => {});
    listToken += 1;
    activityToken += 1;
    detailToken += 1;
    invalidateDetailCache();
    clearHold();
    unsubscribe?.();
    unsubscribe = null;
    window.removeEventListener('focus', onWindowFocus);
    window.removeEventListener('online', onReconnect);
  });

  const focusedSummary = computed(() => {
    const focused = focusedRef.value;
    if (!focused) return null;
    return conversations.value.find((row) => sameConversation(row.ref, focused)) ?? null;
  });
  return {
    savedSplit, splitError, splitBusy, inboxTotal, savedTotal, unreadOnly, saveSplit, setUnreadOnly,
    searchQuery, searchCoverage, searchCachedOnly, search, restoreSearch, invalidateSearchIntent, captureNavigationIntent,
    context, starredOnly, nextCursor, loadingMore, loadedDonePages, loadedDoneBoundary, exactTotal, lastSyncedAt, activityError, setContext, loadMore,
    conversations, activity, listState, listError, focusedRef, focusedSummary,
    openRef, conversation, detailState, heldConversation, detailError, lastCommandError,
    inFlightCommandRef, commandInFlight, ready, refresh, focusConversation, moveFocus,
    openConversationByRef, openNeighbor, prefetchConversation, openFocused, closeReader, setArchived, unarchiveFromActivity, setRead, setStarred, setStarredGroup, retryOperation,
    lastAction, undoLastAction,
    selectedRefs, rangeAnchorRef, selectionNotice, isSelected, toggleSelected, extendSelectionTo,
    selectAllLoaded, clearSelection, selectionInLoadedOrder,
    lastGroup, bulkUnresolved, groupInFlight, setArchivedGroup, setReadGroup, recoverGroupAcceptance,
    dismissGroupNotice, undoGroupAction, recentGroups, groupsError, groupsHasMore, groupsLoadingMore, loadMoreGroups,
    groupDetail, groupDetailError, openGroupDetail, undoGroupById,
    enableMailboxActions, cancelMailboxActionUpgrade, archiveFocused,
    refreshGroups,
    accountStatus, accountState, accountError, accountBusy, mode, isGmail,
    connectAccount, disconnectAccount, requestSync,
  };
}
