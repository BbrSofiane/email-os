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
  OperationGroupReceipt,
  OperationGroupStatus,
  OperationGroupSummary,
  OperationReceipt,
  SetArchivedGroup,
  SetReadGroup,
  SetStarredGroup,
  UndoReceipt,
} from '../lib/ipc/client';
import { matchesSplit } from '../lib/saved-split';
import { OPERATION_GROUP_MAX_MEMBERS, toMailError } from '../lib/ipc/client';

/**
 * J/K moves keep showing the previous conversation (never actionable) for this
 * long before the loading presentation replaces it, so a fast response never
 * produces an intermediate empty frame.
 */
export const READER_LOADING_DELAY_MS = 120;
/** Neighbor-detail cache bounds (read-only prefetch; see `prefetchConversation`). */
export const DETAIL_CACHE_MAX = 3;
export const DETAIL_CACHE_TTL_MS = 30_000;

export type ListState = 'loading' | 'ready' | 'error';
export type DetailState = 'idle' | 'loading' | 'ready' | 'error';
export type AccountState = 'loading' | 'ready' | 'error';
export type AccountAction = 'connect' | 'disconnect' | 'sync' | 'enable-actions' | 'cancel-upgrade';
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

export function sameConversation(a: ConversationRef | null, b: ConversationRef | null): boolean {
  return a !== null && b !== null && a.accountId === b.accountId && a.conversationId === b.conversationId;
}

export type BrowseContext = 'inbox' | 'saved' | 'done' | 'starred' | 'trash' | 'search';

/**
 * UX-05 product/safety bound for selection and groups (docs/ux-05-safe-bulk-
 * processing.md §3.1). The UI rejects additions beyond this bound; the stores
 * re-validate and never truncate.
 */
export const SELECTION_MAX = OPERATION_GROUP_MAX_MEMBERS;

/**
 * Single-slot group notice (UX-05 §3.2/§4.3): the explicit pending identity of
 * one bulk action. It carries the ORIGINAL request id and the exact original
 * command until acceptance is resolved — a rejected IPC promise alone never
 * establishes that nothing committed, and recovery replays that exact request,
 * never a fresh one. The persisted member list (not the live selection) drives
 * progress/recovery after dispatch.
 */
export interface GroupNotice {
  requestId: string;
  accountId: string;
  kind: 'archive' | 'read' | 'star';
  requestedArchived?: boolean;
  requestedRead?: boolean;
  requestedStarred?: boolean;
  /** Frozen dispatch-order member refs (current loaded order at dispatch). */
  members: ConversationRef[];
  /**
   * `awaiting-acceptance`: the IPC round trip is still open.
   * `acceptance-unknown`: the promise rejected but nothing established that
   * nothing committed; recovery queries/replays the original request.
   * `accepted`: a durable receipt is known.
   */
  state: 'awaiting-acceptance' | 'acceptance-unknown' | 'accepted';
  receipt: OperationGroupReceipt | null;
  /** Authoritative member statuses/undo availability from `getOperationGroup`. */
  status: OperationGroupStatus | null;
  /** True when the latest authoritative status read FAILED (distinct from
   * absence — never rendered as "Accepting…"). */
  statusError: boolean;
  /** Receipt of the group's single Undo attempt, once accepted. */
  undone: GroupUndoReceipt | null;
  /** True once this group ever had an undo window. */
  hadWindow: boolean;
  /** The exact original command, replayed verbatim for lost-response recovery. */
  originalCommand: SetArchivedGroup | SetReadGroup | SetStarredGroup;
}

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
  const heldConversation = ref<Conversation | null>(null);
  const detailError = ref<MailError | null>(null);
  const lastCommandError = ref<MailError | null>(null);
  const inFlightCommandRef = ref<ConversationRef | null>(null);
  const commandInFlight = ref(false);
  const accountStatus = ref<AccountStatus | null>(null);
  const accountState = ref<AccountState>('loading');
  const accountError = ref<MailError | null>(null);
  const accountBusy = ref<AccountAction | null>(null);
  const lastAction = ref<LastAction | null>(null);
  const lastGroup = ref<GroupNotice | null>(null);
  const groupInFlight = ref(false);
  const selectedRefs = ref<ConversationRef[]>([]);
  const rangeAnchorRef = ref<ConversationRef | null>(null);
  const selectionNotice = ref<string | null>(null);
  const recentGroups = ref<OperationGroupSummary[]>([]);
  const groupsError = ref<MailError | null>(null);
  const groupsHasMore = ref(false);
  const groupsLoadingMore = ref(false);
  const groupDetail = ref<OperationGroupStatus | null>(null);
  const groupDetailError = ref<MailError | null>(null);

  let readerSource: 'list' | 'activity' = 'list';
  let listToken = 0;
  // Explicit query/navigation ownership must survive routine list refreshes.
  let navigationIntentToken = 0;
  let activityToken = 0;
  let detailToken = 0;
  // Neighbor-detail cache and single-slot prefetch. `detailEpoch` is bumped by
  // every invalidation so older in-flight reads can never publish.
  interface CachedDetail { conversation: Conversation; fetchedAt: number }
  const detailCache = new Map<string, CachedDetail>();
  let detailEpoch = 0;
  let prefetchInFlight: { key: string; epoch: number; promise: Promise<Conversation> } | null = null;
  let prefetchWanted: ConversationRef | null = null;
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let commandToken = 0;
  let mailboxSessionToken = 0;
  let statusToken = 0;
  let groupDetailToken = 0;
  let groupsToken = 0;
  let groupStatusFetchToken = 0;
  let groupsLoadedPages = 0;
  let groupsCursor: string | null = null;
  let groupsRefreshPending = false;
  let noticeRehydrated = false;
  let detached = false;
  let unsubscribe: (() => void) | null = null;
  let subscriptionAttempt: Promise<void> | null = null;

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

  /** Independent cache filters compose by intersection; unknown facts never qualify. */
  function matchesCachedFilters(row: ConversationSummaryLike): boolean {
    return (!unreadOnly.value || row.isRead === false)
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
    if (source === 'inbox' || source === 'saved' || !cursor || !account || loadingMore.value || listState.value !== 'ready') return;
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

  /** Status failures never reject: the UI gate renders them and stays fail-closed. */
  async function refreshStatus(token: number): Promise<void> {
    try {
      const status = await client.getAccountStatus();
      if (detached || token !== statusToken) return;
      const oldAccount = accountStatus.value?.account?.accountId;
      if (oldAccount && oldAccount !== status.account?.accountId) {
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
      accountStatus.value = status;
      accountError.value = null;
      accountState.value = 'ready';
    } catch (raw) {
      if (detached || token !== statusToken) return;
      accountError.value = toMailError(raw);
      accountState.value = 'error';
    }
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
      if (bootstrap) await refreshStatus(++statusToken);
      if (detached) return;
      await Promise.all([
        bootstrap ? Promise.resolve() : refreshStatus(++statusToken),
        refreshList(token),
        openRef.value ? loadDetail(openRef.value, true) : Promise.resolve(),
      ]);
      if (detached || token !== listToken) return;
      // Group bookkeeping rides on every authoritative refresh: the notice slot
      // and Activity groups track authoritative member statuses, and the first
      // successful refresh rehydrates the latest eligible notice after restart.
      void refreshRecentGroups();
      void refreshGroupStatus();
      // An expanded Activity group detail follows authoritative changes so it
      // cannot keep showing queued members/stale Undo availability after the
      // children finish (§6).
      if (groupDetail.value) void refreshExpandedGroupDetail();
      if (!noticeRehydrated) {
        noticeRehydrated = true;
        void rehydrateNotice();
      }
    } catch (raw) {
      if (detached || token !== listToken) return;
      inboxTotal.value = null;
      savedTotal.value = null;
      listError.value = toMailError(raw);
      listState.value = 'error';
    }
  }

  /**
   * Restart rehydration (UX-05 §6): with no user-visible slot, rehydrate the
   * latest eligible single/group notice from authoritative state only. A newer
   * group beats an older undoable single; neither is invented without a
   * backend-provided window.
   */
  async function rehydrateNotice(): Promise<void> {
    if (detached) return;
    const account = accountStatus.value?.account?.accountId;
    const sessionToken = mailboxSessionToken;
    if (!account) return;
    let groupCandidate: OperationGroupStatus | null = null;
    try {
      const page = await client.listOperationGroups({ accountId: account, limit: 5, cursor: null });
      if (detached || sessionToken !== mailboxSessionToken) return;
      for (const summary of page.groups) {
        if (summary.undone) continue;
        const status = await client.getOperationGroup({ accountId: account, requestId: summary.requestId }).catch(() => null);
        if (detached || sessionToken !== mailboxSessionToken) return;
        if (status?.undo.available) {
          groupCandidate = status;
          break;
        }
      }
    } catch { /* group discovery is best-effort; singles still rehydrate */ }
    if (detached || sessionToken !== mailboxSessionToken || lastGroup.value !== null || lastAction.value !== null) return;
    let newestSingle: OperationSummaryLike | null = null;
    for (const item of activity.value) {
      if (item.undoableUntil === undefined) continue;
      if (!newestSingle || (item.undoableUntil ?? '') > (newestSingle.undoableUntil ?? '')) newestSingle = item;
    }
    const groupAt = groupCandidate?.undo.undoableUntil ?? null;
    const singleAt = newestSingle?.undoableUntil ?? null;
    // Compare recency via the backend-provided windows (same clock basis).
    const groupNewer = groupCandidate !== null && (!singleAt || (groupAt ?? '') >= singleAt);
    if (groupNewer && groupCandidate) {
      const g = groupCandidate;
      setGroupSlot({
        requestId: g.group.requestId,
        accountId: g.group.accountId,
        kind: g.group.kind,
        requestedStarred: g.group.requestedStarred,
        ...(g.group.requestedArchived === undefined ? {} : { requestedArchived: g.group.requestedArchived }),
        ...(g.group.requestedRead === undefined ? {} : { requestedRead: g.group.requestedRead }),
        members: g.group.members.map((member) => ({ ...member.conversation })),
        state: 'accepted',
        receipt: { ...g.group },
        status: g,
        statusError: false,
        undone: null,
        hadWindow: true,
        originalCommand: g.group.kind === 'star'
          ? { accountId: g.group.accountId, members: g.group.members.map(member => ({...member.conversation})), starred: g.group.requestedStarred ?? true, requestId: g.group.requestId }
          : g.group.kind === 'read'
          ? { accountId: g.group.accountId, members: g.group.members.map((member) => ({ ...member.conversation })), read: g.group.requestedRead ?? true, requestId: g.group.requestId }
          : { accountId: g.group.accountId, members: g.group.members.map((member) => ({ ...member.conversation })), archived: g.group.requestedArchived ?? true, requestId: g.group.requestId },
      });
      return;
    }
    if (newestSingle) repointLastAction();
  }

  function detailKey(target: ConversationRef): string {
    return `${target.accountId}:${target.conversationId}`;
  }

  /** Drops every cached detail and fences in-flight prefetch results. */
  function invalidateDetailCache(): void {
    detailEpoch += 1;
    detailCache.clear();
    prefetchWanted = null;
  }

  function cachePut(conv: Conversation, epoch: number): void {
    if (epoch !== detailEpoch) return;
    const key = detailKey(conv.ref);
    detailCache.delete(key);
    detailCache.set(key, { conversation: conv, fetchedAt: Date.now() });
    while (detailCache.size > DETAIL_CACHE_MAX) detailCache.delete(detailCache.keys().next().value as string);
  }

  function cacheGet(target: ConversationRef): Conversation | null {
    const entry = detailCache.get(detailKey(target));
    if (!entry) return null;
    if (Date.now() - entry.fetchedAt > DETAIL_CACHE_TTL_MS) {
      detailCache.delete(detailKey(target));
      return null;
    }
    return entry.conversation;
  }

  function clearHold(): void {
    if (holdTimer !== null) clearTimeout(holdTimer);
    holdTimer = null;
    heldConversation.value = null;
  }

  /** Keep `shown` on screen for the loading delay; an active hold keeps its original deadline. */
  function beginHold(shown: Conversation | null): void {
    if (!shown) { clearHold(); return; }
    heldConversation.value = shown;
    if (holdTimer !== null) return;
    holdTimer = setTimeout(() => {
      holdTimer = null;
      heldConversation.value = null;
    }, READER_LOADING_DELAY_MS);
  }

  /** Starts the single wanted prefetch when none is in flight. Never writes, never surfaces errors. */
  function pumpPrefetch(): void {
    if (detached || prefetchInFlight || !prefetchWanted) return;
    const target = prefetchWanted;
    prefetchWanted = null;
    if (detailState.value !== 'ready' || readerSource !== 'list' || sameConversation(openRef.value, target)
      || cacheGet(target) || target.accountId !== openRef.value?.accountId) return;
    const epoch = detailEpoch;
    const key = detailKey(target);
    const promise = client.getConversation(target, context.value === 'search');
    const flight = { key, epoch, promise };
    prefetchInFlight = flight;
    const settle = (): void => {
      if (prefetchInFlight === flight) prefetchInFlight = null;
      pumpPrefetch();
    };
    promise.then((conv) => {
      if (!detached && epoch === detailEpoch) cachePut(conv, epoch);
      settle();
    }, () => { settle(); /* failure is silent: no cache entry */ });
  }

  function prefetchConversation(target: ConversationRef): void {
    if (detached || detailState.value !== 'ready' || readerSource !== 'list') return;
    if (sameConversation(openRef.value, target) || cacheGet(target)) return;
    if (prefetchInFlight?.key === detailKey(target) && prefetchInFlight.epoch === detailEpoch) return;
    prefetchWanted = { accountId: target.accountId, conversationId: target.conversationId };
    pumpPrefetch();
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
        if (prefetchInFlight?.key === detailKey(target) && prefetchInFlight.epoch === detailEpoch) {
          adopted = prefetchInFlight.promise;
        }
      }
      beginHold(shown);
    }
    const epoch = detailEpoch;
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

  // ---------------------------------------------------------------------------
  // UX-05 selection state: account-scoped refs, additive ranges, hard bound
  // ---------------------------------------------------------------------------

  function indexOfSelected(target: ConversationRef): number {
    return selectedRefs.value.findIndex((entry) => sameConversation(entry, target));
  }

  function isSelected(target: ConversationRef): boolean {
    return indexOfSelected(target) >= 0;
  }

  function loadedContains(target: ConversationRef): boolean {
    return conversations.value.some((row) => sameConversation(row.ref, target));
  }

  function copyRef(target: ConversationRef): ConversationRef {
    return { accountId: target.accountId, conversationId: target.conversationId };
  }

  function rejectSelectionBound(): void {
    selectionNotice.value = `Selection is limited to ${SELECTION_MAX} conversations. Clear selection to choose different conversations; nothing was replaced.`;
  }

  /** X / checkbox / Cmd-click: toggle one row; the anchor moves there. */
  function toggleSelected(target: ConversationRef): void {
    if (!savedTargetAvailable(target)) return;
    const existing = indexOfSelected(target);
    if (existing >= 0) {
      selectedRefs.value = selectedRefs.value.filter((entry) => !sameConversation(entry, target));
      selectionNotice.value = null;
    } else {
      if (selectedRefs.value.length >= SELECTION_MAX) {
        rejectSelectionBound();
        return;
      }
      selectedRefs.value = [...selectedRefs.value, copyRef(target)];
      selectionNotice.value = null;
    }
    rangeAnchorRef.value = copyRef(target);
  }

  /**
   * Additive inclusive anchor→target range over the CURRENT loaded order.
   * Reversing direction never subtracts already selected rows. The anchor is
   * retained (never moved here) so repeated Shift+J/K keep growing one range;
   * when no valid anchor exists the fallback (pre-move focus) is used, else the
   * target alone. Additions beyond the bound are rejected without replacing the
   * existing selection.
   */
  function extendSelectionTo(target: ConversationRef, fallbackAnchor: ConversationRef | null): void {
    const rows = conversations.value;
    const targetIndex = rows.findIndex((row) => sameConversation(row.ref, target));
    if (targetIndex < 0) return;
    const explicitAnchor = rangeAnchorRef.value && loadedContains(rangeAnchorRef.value)
      ? rangeAnchorRef.value
      : null;
    const fallback = fallbackAnchor && !explicitAnchor && loadedContains(fallbackAnchor) ? fallbackAnchor : null;
    const anchor = explicitAnchor ?? fallback;
    if (!anchor) {
      if (isSelected(target)) {
        // Target-only range still establishes the initial anchor (§3.1).
        rangeAnchorRef.value = copyRef(target);
        return;
      }
      if (selectedRefs.value.length + 1 > SELECTION_MAX) {
        rejectSelectionBound();
        return;
      }
      selectedRefs.value = [...selectedRefs.value, copyRef(target)];
      selectionNotice.value = null;
      // First accepted range establishes the persistent anchor at the target;
      // later ranges extend from here even after independent focus moves.
      rangeAnchorRef.value = copyRef(target);
      return;
    }
    const anchorIndex = rows.findIndex((row) => sameConversation(row.ref, anchor));
    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    const addition = rows.slice(start, end + 1)
      .map((row) => row.ref)
      .filter((ref) => !isSelected(ref));
    if (addition.length === 0) {
      // The first accepted range still anchors even when nothing was added.
      if (!explicitAnchor) rangeAnchorRef.value = copyRef(anchor);
      return;
    }
    if (selectedRefs.value.length + addition.length > SELECTION_MAX) {
      rejectSelectionBound();
      return;
    }
    selectedRefs.value = [...selectedRefs.value, ...addition.map(copyRef)];
    selectionNotice.value = null;
    // A fallback anchor used for the first range becomes THE anchor; the
    // explicit anchor is retained untouched (never moved by range extension).
    if (!explicitAnchor) rangeAnchorRef.value = copyRef(anchor);
  }

  /** Select all loaded rows; beyond the bound this refuses with visible wording. */
  function selectAllLoaded(): void {
    const rows = conversations.value;
    if (rows.length > SELECTION_MAX) {
      selectionNotice.value = `${rows.length} rows are loaded — Select all loaded is limited to ${SELECTION_MAX}. Load fewer rows or narrow the list first.`;
      return;
    }
    selectedRefs.value = rows.map((row) => copyRef(row.ref));
    const last = rows[rows.length - 1];
    rangeAnchorRef.value = last ? copyRef(last.ref) : null;
    selectionNotice.value = null;
  }

  /** Clear set, anchor and bound wording; navigation state is untouched. */
  function clearSelection(): void {
    selectedRefs.value = [];
    rangeAnchorRef.value = null;
    selectionNotice.value = null;
  }

  /**
    * A successful authoritative list refresh intersects selection with surviving
    * loaded refs and clears an absent anchor. Failures never reach this (they
    * are not an authoritative empty result).
    */
  function intersectSelectionWithLoaded(): void {
    if (selectedRefs.value.length === 0 && !rangeAnchorRef.value) return;
    selectedRefs.value = selectedRefs.value.filter((entry) => loadedContains(entry));
    if (rangeAnchorRef.value && !loadedContains(rangeAnchorRef.value)) rangeAnchorRef.value = null;
  }

  /** Exact selected references frozen in current loaded order, for dispatch. */
  function selectionInLoadedOrder(): ConversationRef[] {
    const loaded = conversations.value
      .map((row) => row.ref)
      .filter((ref) => isSelected(ref))
      .map(copyRef);
    // Selected refs already removed from the loaded list (pending overlay) stay
    // in the frozen member list; they must not vanish from the group result.
    const loadedKeys = new Set(loaded.map((ref) => `${ref.accountId}:${ref.conversationId}`));
    const remaining = selectedRefs.value.filter((ref) => !loadedKeys.has(`${ref.accountId}:${ref.conversationId}`));
    return [...loaded, ...remaining.map(copyRef)];
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

  async function connectAccount(): Promise<void> {
    if (accountBusy.value) return;
    ++navigationIntentToken;
    accountBusy.value = 'connect';
    // Mirror core: connecting flips the connection optimistically; a failure is
    // corrected by the status refetch below.
    if (accountStatus.value) {
      accountStatus.value = { ...accountStatus.value, connection: 'authenticating' };
    }
    try {
      await client.connectAccount();
      if (!detached) await refresh();
    } catch (raw) {
      if (!detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!detached) accountBusy.value = null;
    }
  }

  async function disconnectAccount(): Promise<void> {
    if (accountBusy.value) return;
    ++navigationIntentToken;
    accountBusy.value = 'disconnect';
    try {
      // Resolves only after core deleted credentials and cleared local data.
      await client.disconnectAccount();
    } catch (raw) {
      if (!detached) lastCommandError.value = toMailError(raw);
      return;
    } finally {
      if (!detached) accountBusy.value = null;
    }
    if (detached) return;
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
    if (accountStatus.value) {
      const sync = accountStatus.value.sync;
      accountStatus.value = {
        ...accountStatus.value,
        connection: 'disconnected',
        account: null,
        sync: { ...sync, state: 'idle', error: null, lastSyncedAt: null, cachedConversations: 0, initialSyncComplete: false },
      };
    }
    await refresh();
  }

  async function requestSync(): Promise<void> {
    if (accountBusy.value) return;
    accountBusy.value = 'sync';
    try {
      // Acceptance, not completion; progress arrives via status changes/events.
      await client.requestSync();
      if (!detached) await refresh();
    } catch (raw) {
      if (!detached) lastCommandError.value = toMailError(raw);
    } finally {
      if (!detached) accountBusy.value = null;
    }
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

  // ---------------------------------------------------------------------------
  // UX-05 bulk groups: explicit single-or-group pending model, lost-response
  // recovery on the ORIGINAL request id, partial group Undo
  // ---------------------------------------------------------------------------

  const bulkUnresolved = computed(() =>
    groupInFlight.value
    || lastGroup.value?.state === 'awaiting-acceptance'
    || lastGroup.value?.state === 'acceptance-unknown');

  function setGroupSlot(next: GroupNotice): void {
    // Session-fenced: an account identity change must never repopulate the slot.
    if (detached || next.accountId !== accountStatus.value?.account?.accountId) return;
    lastGroup.value = next;
  }

  function sameSlot(requestId: string): boolean {
    return lastGroup.value?.requestId === requestId;
  }

  /** Drops all Activity group surfaces and invalidates their in-flight reads
   * so old-account responses cannot repopulate after disconnect/reconnect. */
  function clearGroupSurfaces(): void {
    ++groupsToken;
    ++groupDetailToken;
    groupsLoadedPages = 0;
    groupsCursor = null;
    groupsRefreshPending = false;
    groupsLoadingMore.value = false;
    noticeRehydrated = false;
    recentGroups.value = [];
    groupsError.value = null;
    groupsHasMore.value = false;
    groupDetail.value = null;
    groupDetailError.value = null;
  }

  /** Authoritative refresh of the slot's member statuses/undo state. Fenced by
   * session, request generation and slot identity, and MERGED into the current
   * slot: a delayed pre-undo response must never overwrite a newer undo
   * receipt or roll back hadWindow. Failures set statusError (distinct from
   * absence) instead of silently rendering "Accepting…" forever. */
  async function refreshGroupStatus(): Promise<void> {
    const slot = lastGroup.value;
    if (!slot?.receipt) return;
    const sessionToken = mailboxSessionToken;
    const fetchToken = ++groupStatusFetchToken;
    const outcome = await client.getOperationGroup({ accountId: slot.accountId, requestId: slot.requestId })
      .then(
        (status) => ({ status, failed: false }),
        (): { status: OperationGroupStatus | null; failed: boolean } => ({ status: null, failed: true }),
      );
    const current = lastGroup.value;
    if (detached || sessionToken !== mailboxSessionToken || !current || current.requestId !== slot.requestId) return;
    if (fetchToken !== groupStatusFetchToken) return; // a newer status read owns the slot
    lastGroup.value = {
      ...current,
      // Never roll a newer status or undo receipt back to the captured view.
      status: outcome.status ?? current.status,
      statusError: outcome.failed,
      hadWindow: current.hadWindow || (outcome.status?.undo.undoableUntil !== null && outcome.status?.undo.undoableUntil !== undefined),
    };
  }

  /** Bounded recent group summaries for Activity, independent of list rows.
   * Session/account fenced and token-invalidated: a late response from a
   * previous account/session never repopulates the surface. A refresh retains
   * the already-loaded page range (bounded) instead of collapsing to one page. */
  async function refreshRecentGroups(): Promise<void> {
    const account = accountStatus.value?.account?.accountId;
    const sessionToken = mailboxSessionToken;
    if (!account) return;
    if (groupsLoadingMore.value) {
      groupsRefreshPending = true;
      return;
    }
    const token = ++groupsToken;
    groupsLoadingMore.value = true;
    const pagesToLoad = Math.max(1, groupsLoadedPages);
    const collected: OperationGroupSummary[] = [];
    let cursor: string | null = null;
    let hasMore = false;
    try {
      for (let page = 0; page < pagesToLoad; page += 1) {
        const result = await client.listOperationGroups({ accountId: account, limit: 10, cursor });
        if (detached || sessionToken !== mailboxSessionToken || token !== groupsToken) return;
        collected.push(...result.groups);
        if (!result.nextCursor) {
          hasMore = false;
          break;
        }
        cursor = result.nextCursor;
        hasMore = true;
      }
      groupsError.value = null;
      groupsHasMore.value = hasMore;
      groupsCursor = cursor;
      groupsLoadedPages = pagesToLoad;
      recentGroups.value = collected;
    } catch (raw) {
      if (detached || sessionToken !== mailboxSessionToken || token !== groupsToken) return;
      // A failed history read is a recovery boundary, not an empty result.
      groupsError.value = toMailError(raw);
      // Keep the last complete manifest and cursor, not a silent partial page.
    } finally {
      finishGroupsRead(sessionToken, token);
    }
  }

  function finishGroupsRead(sessionToken: number, token: number): void {
    if (detached || sessionToken !== mailboxSessionToken || token !== groupsToken) return;
    groupsLoadingMore.value = false;
    if (groupsRefreshPending) {
      groupsRefreshPending = false;
      // Coalesce invalidation received during continuation, retaining the
      // newly committed page range before the refresh captures its extent.
      void refreshRecentGroups();
    }
  }

  /** Mailbox-seam alias for retrying a failed recent-groups history read. */
  function refreshGroups(): Promise<void> {
    return refreshRecentGroups();
  }

  /** Activity continuation: append the next bounded page via the retained
   * opaque cursor; never fabricated from UI state. */
  async function loadMoreGroups(): Promise<void> {
    const account = accountStatus.value?.account?.accountId;
    const sessionToken = mailboxSessionToken;
    const token = groupsToken;
    if (!account || !groupsHasMore.value || groupsCursor === null || groupsLoadingMore.value) return;
    groupsLoadingMore.value = true;
    try {
      const result = await client.listOperationGroups({ accountId: account, limit: 10, cursor: groupsCursor });
      if (detached || sessionToken !== mailboxSessionToken || token !== groupsToken) return;
      groupsCursor = result.nextCursor;
      groupsHasMore.value = result.nextCursor !== null;
      groupsError.value = null;
      groupsLoadedPages += 1;
      const existing = new Set(recentGroups.value.map((group) => group.groupId));
      recentGroups.value = [...recentGroups.value, ...result.groups.filter((group) => !existing.has(group.groupId))];
    } catch (raw) {
      if (detached || sessionToken !== mailboxSessionToken || token !== groupsToken) return;
      groupsError.value = toMailError(raw);
    } finally {
      finishGroupsRead(sessionToken, token);
    }
  }

  function adoptGroupReceipt(receipt: OperationGroupReceipt): void {
    const slot = lastGroup.value;
    if (!slot || slot.requestId !== receipt.requestId) return;
    lastGroup.value = { ...slot, state: 'accepted', receipt: { ...receipt } };
    void refreshGroupStatus();
  }

  /**
   * Lost-response recovery (UX-05 §4.3): a rejected promise does not establish
   * that nothing committed. Query by the ORIGINAL request id; show "Acceptance
   * not yet known" while uncommitted. Never invents a fresh request here.
   */
  async function resolveUnknownAcceptance(): Promise<void> {
    const slot = lastGroup.value;
    if (!slot || slot.state === 'accepted') return;
    if (slot.state === 'awaiting-acceptance') lastGroup.value = { ...slot, state: 'acceptance-unknown' };
    const status = await client.getOperationGroup({ accountId: slot.accountId, requestId: slot.requestId }).catch(() => null);
    if (detached || !status || !sameSlot(slot.requestId)) return;
    lastGroup.value = { ...lastGroup.value!, state: 'accepted', receipt: { ...status.group }, status };
    await refresh();
  }

  /**
   * Typed admission rejections that PROVE nothing committed (the command was
   * refused before any write). Only transport-level ambiguity — where the
   * request may or may not have committed — enters `acceptance-unknown`.
   * `storage_unavailable` is deliberately excluded: the adapter also uses it
   * for untyped transport/serialization failures, which may follow a commit.
   * This classifier applies ONLY to the first attempt, never to a replay of
   * historically unresolved intent.
   */
  const DEFINITIVE_ACCEPTANCE_ERRORS: ReadonlySet<MailError['kind']> = new Set([
    'invalid_request',
    'request_id_conflict',
    'read_only',
    'permission_required',
    'not_found',
    'busy',
    'not_configured',
    'auth_required',
    'auth_failed',
    'auth_cancelled',
    'secrets_unavailable',
  ]);

  function acceptanceDefinitivelyRejected(raw: unknown): boolean {
    const error = toMailError(raw);
    return DEFINITIVE_ACCEPTANCE_ERRORS.has(error.kind);
  }

  /**
   * User-invoked recovery for an unresolved acceptance: query by request id
   * first; while still uncommitted, replay the EXACT original request (same id
   * and payload). A not-yet-committed lookup is never permission to submit a
   * different request.
   */
  async function recoverGroupAcceptance(): Promise<void> {
    const slot = lastGroup.value;
    if (!slot || slot.state !== 'acceptance-unknown' || groupInFlight.value || commandInFlight.value) return;
    const sessionToken = mailboxSessionToken;
    groupInFlight.value = true;
    try {
      // Resolve historical acceptance before attempting a replay. A failed
      // lookup is not absence and must retain the original command and fence.
      const status = await client.getOperationGroup({ accountId: slot.accountId, requestId: slot.requestId });
      if (detached || sessionToken !== mailboxSessionToken || !sameSlot(slot.requestId)) return;
      if (status) {
        lastGroup.value = { ...lastGroup.value!, state: 'accepted', receipt: { ...status.group }, status };
        lastCommandError.value = null;
        await refresh();
        return;
      }
      const command = slot.originalCommand;
      const receipt = 'archived' in command
        ? await client.setArchivedGroup(command)
        : 'starred' in command ? await client.setStarredGroup(command) : await client.setReadGroup(command);
      if (detached || sessionToken !== mailboxSessionToken) return;
      lastCommandError.value = null;
      if (sameSlot(slot.requestId)) {
        lastGroup.value = { ...lastGroup.value!, state: 'accepted', receipt: { ...receipt } };
      }
      await refresh();
    } catch (raw) {
      if (detached || sessionToken !== mailboxSessionToken) return;
      lastCommandError.value = toMailError(raw);
      // A replay can be refused by today's capability/lifecycle checks even
      // when the ORIGINAL attempt committed. No replay error proves historical
      // non-acceptance: retain its identity/fence and query again if possible.
      await resolveUnknownAcceptance();
    } finally {
      if (!detached && sessionToken === mailboxSessionToken) groupInFlight.value = false;
    }
  }

  /**
   * Dismissal is only available for a RESOLVED slot: an unresolved acceptance
   * (lost response) keeps the immutable request id and command and holds the
   * mutation fence until authoritative resolution (§3.3/§4.3) — dismissal
   * must never release them for a fresh, different request.
   */
  function dismissGroupNotice(): void {
    if (groupInFlight.value) return; // an in-flight acceptance owns the slot
    if (lastGroup.value?.state !== 'accepted') return; // unresolved intent is kept
    lastGroup.value = null;
  }

  /**
   * Bulk group dispatch. Freezes the member list in current loaded order,
   * replaces any single notice in the slot, retains the original command for
   * recovery, and blocks duplicate dispatch until acceptance is resolved.
   */
  async function submitGroup(
    kind: 'archive' | 'read' | 'star',
    members: ConversationRef[],
    value: boolean,
  ): Promise<boolean> {
    if (members.some((member) => !savedTargetAvailable(member))) return false;
    if (!mutationsAllowed()) return false;
    // P1 fence (§3.3): a pending single mutation (inline row action, undo,
    // retry) must never race a group dispatch — the group would bump
    // `commandToken`, the single's finally would stop clearing its in-flight
    // ref, and single actions could stay permanently fenced afterwards.
    if (inFlightCommandRef.value !== null) {
      lastCommandError.value = { kind: 'busy' };
      return false;
    }
    if ((kind === 'read' || kind === 'star') && accountStatus.value?.mode !== 'gmail') {
      lastCommandError.value = { kind: 'read_only' };
      return false;
    }
    const account = accountStatus.value?.account?.accountId;
    if (!account || members.length < 1) {
      lastCommandError.value = { kind: 'invalid_request', field: 'members' };
      return false;
    }
    const token = ++commandToken;
    const sessionToken = mailboxSessionToken;
    const requestId = crypto.randomUUID();
    const frozen = members.map(copyRef);
    const originalCommand: SetArchivedGroup | SetReadGroup | SetStarredGroup = kind === 'star'
      ? {accountId:account,members:frozen,starred:value,requestId}
      : kind === 'archive'
      ? { accountId: account, members: frozen, archived: value, requestId }
      : { accountId: account, members: frozen, read: value, requestId };
    // Single-slot: a new group action replaces any single notice.
    lastAction.value = null;
    groupInFlight.value = true;
    setGroupSlot({
      requestId,
      accountId: account,
      kind,
      ...(kind === 'star' ? { requestedStarred:value } : kind === 'archive' ? { requestedArchived: value } : { requestedRead: value }),
      members: frozen,
      state: 'awaiting-acceptance',
      receipt: null,
      status: null,
      statusError: false,
      undone: null,
      hadWindow: false,
      originalCommand,
    });
    try {
      const receipt = kind === 'archive'
        ? await client.setArchivedGroup(originalCommand as SetArchivedGroup)
        : kind === 'star' ? await client.setStarredGroup(originalCommand as SetStarredGroup) : await client.setReadGroup(originalCommand as SetReadGroup);
      if (detached || sessionToken !== mailboxSessionToken) return true;
      if (token === commandToken) lastCommandError.value = null;
      if (sameSlot(requestId)) adoptGroupReceipt(receipt);
      await refresh();
      return true;
    } catch (raw) {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        lastCommandError.value = toMailError(raw);
        if (acceptanceDefinitivelyRejected(raw)) {
          // Typed proof that nothing committed: release the fence and the
          // slot; the honest error stays in the status line.
          if (sameSlot(requestId)) lastGroup.value = null;
          groupInFlight.value = false;
          return false;
        }
        // Nothing yet establishes that nothing committed: query by request id.
        await resolveUnknownAcceptance();
      }
      return false;
    } finally {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        groupInFlight.value = false;
      }
    }
  }

  function setArchivedGroup(members: ConversationRef[], archived: boolean): Promise<boolean> {
    return submitGroup('archive', members, archived);
  }

  function setStarredGroup(members: ConversationRef[], starred: boolean): Promise<boolean> { return submitGroup('star',members,starred); }
  function setReadGroup(members: ConversationRef[], read: boolean): Promise<boolean> {
    return submitGroup('read', members, read);
  }

  /** Refresh the slot from authoritative state after an undo decision. */
  async function refreshSlotAfterGroupUndo(requestId: string): Promise<void> {
    await refresh();
    await refreshGroupStatus();
    if (detached || !sameSlot(requestId)) return;
    // The window is closed by definition after an undo attempt.
    const slot = lastGroup.value!;
    if (slot.status && !slot.status.undo.available) {
      lastGroup.value = { ...slot, hadWindow: true };
    }
  }

  /** Partial group Undo of the CURRENT group slot (notice Undo button / Z). */
  async function undoGroupAction(): Promise<GroupUndoReceipt | null> {
    const slot = lastGroup.value;
    if (!slot?.receipt) return null;
    return undoGroupById(slot.receipt.groupId);
  }

  /** Partial group Undo from Activity detail; one attempt, durable decisions. */
  async function undoGroupById(groupId: string): Promise<GroupUndoReceipt | null> {
    if (!mutationsAllowed()) return null;
    const slot = lastGroup.value;
    const slotMatches = slot?.receipt?.groupId === groupId;
    const token = ++commandToken;
    const sessionToken = mailboxSessionToken;
    groupInFlight.value = true;
    try {
      const receipt = await client.undoOperationGroup({ groupId, requestId: crypto.randomUUID() });
      if (detached || sessionToken !== mailboxSessionToken) return receipt;
      if (token === commandToken) lastCommandError.value = null;
      if (slotMatches && sameSlot(slot!.requestId)) {
        await refreshSlotAfterGroupUndo(slot!.requestId);
        if (!detached && sameSlot(slot!.requestId)) {
          lastGroup.value = { ...lastGroup.value!, undone: receipt, hadWindow: true };
        }
      }
      await refreshRecentGroups();
      if (!detached && groupDetail.value?.group.groupId === groupId) await openGroupDetail(groupDetail.value.group.requestId);
      return receipt;
    } catch (raw) {
      if (detached || sessionToken !== mailboxSessionToken || token !== commandToken) return null;
      const error = toMailError(raw);
      lastCommandError.value = error;
      // Even a lost Undo response can follow a committed decision. Recover
      // the durable record instead of showing original state as expired Undo.
      await refresh();
      await refreshGroupStatus();
      if (!detached && sessionToken === mailboxSessionToken && lastGroup.value?.receipt?.groupId === groupId) {
        lastGroup.value = { ...lastGroup.value!, hadWindow: true };
      }
      return null;
    } finally {
      if (!detached && sessionToken === mailboxSessionToken && token === commandToken) {
        groupInFlight.value = false;
      }
    }
  }

  /** Activity: load one group's authoritative detail by original request id.
   * Session/account fenced; a failed read surfaces typed (distinct from
   * absence) so persisted recovery records are never silently hidden. */
  async function openGroupDetail(requestId: string): Promise<void> {
    const account = accountStatus.value?.account?.accountId;
    const sessionToken = mailboxSessionToken;
    if (!account) return;
    const token = ++groupDetailToken;
    groupDetail.value = null;
    groupDetailError.value = null;
    const outcome = await client.getOperationGroup({ accountId: account, requestId })
      .then(
        (status) => ({ status, error: null as MailError | null }),
        (raw): { status: OperationGroupStatus | null; error: MailError | null } => ({ status: null, error: toMailError(raw) }),
      );
    if (detached || token !== groupDetailToken || sessionToken !== mailboxSessionToken) return;
    groupDetail.value = outcome.status;
    groupDetailError.value = outcome.error;
  }

  /** Background re-fetch of the currently expanded group detail (authoritative
   * change events): keeps the old detail visible until the fresh view lands,
   * with the same session/account/token fences as an explicit open. */
  async function refreshExpandedGroupDetail(): Promise<void> {
    const current = groupDetail.value;
    const account = accountStatus.value?.account?.accountId;
    if (!current || !account || current.group.accountId !== account) return;
    const sessionToken = mailboxSessionToken;
    const token = ++groupDetailToken;
    const outcome = await client.getOperationGroup({ accountId: account, requestId: current.group.requestId })
      .then(
        (status) => ({ status, error: null as MailError | null }),
        (raw): { status: OperationGroupStatus | null; error: MailError | null } => ({ status: null, error: toMailError(raw) }),
      );
    if (detached || sessionToken !== mailboxSessionToken || token !== groupDetailToken) return;
    if (outcome.status) groupDetail.value = outcome.status;
    groupDetailError.value = outcome.error;
  }

  async function enableMailboxActions(): Promise<void> {
    if (accountBusy.value || accountState.value !== 'ready' || accountStatus.value?.mode !== 'gmail' || accountStatus.value.mutationAccess === 'enabled') return;
    accountBusy.value = 'enable-actions';
    lastCommandError.value = null;
    try {
      // This command only accepts/enqueues an explicit OAuth upgrade. Enabled state
      // comes exclusively from a later authoritative account-status read.
      await client.enableMailboxActions();
      if (!detached) await refreshStatus(++statusToken);
    } catch (raw) {
      if (!detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!detached) accountBusy.value = null;
    }
  }

  async function cancelMailboxActionUpgrade(): Promise<void> {
    if (accountBusy.value || accountState.value !== 'ready' || accountStatus.value?.mutationAccess !== 'upgrading') return;
    accountBusy.value = 'cancel-upgrade';
    lastCommandError.value = null;
    try {
      await client.cancelMailboxActionUpgrade();
      if (!detached) await refreshStatus(++statusToken);
    } catch (raw) {
      if (!detached) {
        lastCommandError.value = toMailError(raw);
        await refreshStatus(++statusToken);
      }
    } finally {
      if (!detached) accountBusy.value = null;
    }
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
  const mode = computed<MailMode | null>(() => accountStatus.value?.mode ?? null);
  const isGmail = computed(() => mode.value === 'gmail');
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
