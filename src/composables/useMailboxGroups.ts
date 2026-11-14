/**
 * UX-05 bulk groups: the explicit single-or-group pending model, lost-response
 * recovery on the ORIGINAL request id, partial group Undo, restart rehydration
 * of the latest undoable notice, and the Activity group history/detail surfaces.
 *
 * Session invalidation is explicit. Every async path captures
 * `session.generation` (and, where it owns one, a request token) before its
 * first await and drops its result when either moved. The owner passes the
 * session, the shared command fence, the account/mode readers and the parent
 * state it must write as arguments; nothing is closed over from the parent and
 * there is no module-level mutable state. The owner calls `clearGroupSurfaces`
 * when the account identity changes or disconnects, after bumping the session.
 */
import { computed, ref, type Ref } from 'vue';
import type {
  ConversationRef,
  GroupUndoReceipt,
  MailClient,
  MailError,
  MailMode,
  OperationGroupReceipt,
  OperationGroupStatus,
  OperationGroupSummary,
  SetArchivedGroup,
  SetReadGroup,
  SetStarredGroup,
} from '../lib/ipc/client';
import { toMailError } from '../lib/ipc/client';
import { copyRef } from './mailbox-refs';
import type { CommandFence, MailboxSession } from './mailbox-session';
import type { LastAction, OperationSummaryLike } from './useMailbox';

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

export interface MailboxGroupsDeps {
  client: MailClient;
  session: MailboxSession;
  commands: CommandFence;
  accountId: () => string | undefined;
  mode: () => MailMode | undefined;
  /** Saved-view membership fence for frozen group members. */
  savedTargetAvailable: (target: ConversationRef) => boolean;
  /** Duplicate-mutation fence; also invalidates the detail cache. */
  mutationsAllowed: () => boolean;
  /** Authoritative list/status/detail refresh. */
  refresh: () => Promise<void>;
  /** Re-point the single-action slot at the newest undoable activity row. */
  repointLastAction: () => void;
  lastAction: Ref<LastAction | null>;
  lastCommandError: Ref<MailError | null>;
  commandInFlight: Ref<boolean>;
  inFlightCommandRef: Ref<ConversationRef | null>;
  activity: Ref<OperationSummaryLike[]>;
}

export function useMailboxGroups({
  client, session, commands, accountId, mode, savedTargetAvailable, mutationsAllowed, refresh, repointLastAction,
  lastAction, lastCommandError, commandInFlight, inFlightCommandRef, activity,
}: MailboxGroupsDeps) {
  const lastGroup = ref<GroupNotice | null>(null);
  const groupInFlight = ref(false);
  const recentGroups = ref<OperationGroupSummary[]>([]);
  const groupsError = ref<MailError | null>(null);
  const groupsHasMore = ref(false);
  const groupsLoadingMore = ref(false);
  const groupDetail = ref<OperationGroupStatus | null>(null);
  const groupDetailError = ref<MailError | null>(null);

  let groupDetailToken = 0;
  let groupsToken = 0;
  let groupStatusFetchToken = 0;
  let groupsLoadedPages = 0;
  let groupsCursor: string | null = null;
  let groupsRefreshPending = false;
  let noticeRehydrated = false;

  /**
   * Restart rehydration (UX-05 §6): with no user-visible slot, rehydrate the
   * latest eligible single/group notice from authoritative state only. A newer
   * group beats an older undoable single; neither is invented without a
   * backend-provided window.
   */
  async function rehydrateNotice(): Promise<void> {
    if (session.detached) return;
    const account = accountId();
    const sessionToken = session.generation;
    if (!account) return;
    let groupCandidate: OperationGroupStatus | null = null;
    try {
      const page = await client.listOperationGroups({ accountId: account, limit: 5, cursor: null });
      if (session.detached || sessionToken !== session.generation) return;
      for (const summary of page.groups) {
        if (summary.undone) continue;
        const status = await client.getOperationGroup({ accountId: account, requestId: summary.requestId }).catch(() => null);
        if (session.detached || sessionToken !== session.generation) return;
        if (status?.undo.available) {
          groupCandidate = status;
          break;
        }
      }
    } catch { /* group discovery is best-effort; singles still rehydrate */ }
    if (session.detached || sessionToken !== session.generation || lastGroup.value !== null || lastAction.value !== null) return;
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
    if (session.detached || next.accountId !== accountId()) return;
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
    const sessionToken = session.generation;
    const fetchToken = ++groupStatusFetchToken;
    const outcome = await client.getOperationGroup({ accountId: slot.accountId, requestId: slot.requestId })
      .then(
        (status) => ({ status, failed: false }),
        (): { status: OperationGroupStatus | null; failed: boolean } => ({ status: null, failed: true }),
      );
    const current = lastGroup.value;
    if (session.detached || sessionToken !== session.generation || !current || current.requestId !== slot.requestId) return;
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
    const account = accountId();
    const sessionToken = session.generation;
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
        if (session.detached || sessionToken !== session.generation || token !== groupsToken) return;
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
      if (session.detached || sessionToken !== session.generation || token !== groupsToken) return;
      // A failed history read is a recovery boundary, not an empty result.
      groupsError.value = toMailError(raw);
      // Keep the last complete manifest and cursor, not a silent partial page.
    } finally {
      finishGroupsRead(sessionToken, token);
    }
  }

  function finishGroupsRead(sessionToken: number, token: number): void {
    if (session.detached || sessionToken !== session.generation || token !== groupsToken) return;
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
    const account = accountId();
    const sessionToken = session.generation;
    const token = groupsToken;
    if (!account || !groupsHasMore.value || groupsCursor === null || groupsLoadingMore.value) return;
    groupsLoadingMore.value = true;
    try {
      const result = await client.listOperationGroups({ accountId: account, limit: 10, cursor: groupsCursor });
      if (session.detached || sessionToken !== session.generation || token !== groupsToken) return;
      groupsCursor = result.nextCursor;
      groupsHasMore.value = result.nextCursor !== null;
      groupsError.value = null;
      groupsLoadedPages += 1;
      const existing = new Set(recentGroups.value.map((group) => group.groupId));
      recentGroups.value = [...recentGroups.value, ...result.groups.filter((group) => !existing.has(group.groupId))];
    } catch (raw) {
      if (session.detached || sessionToken !== session.generation || token !== groupsToken) return;
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
    if (session.detached || !status || !sameSlot(slot.requestId)) return;
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
    const sessionToken = session.generation;
    groupInFlight.value = true;
    try {
      // Resolve historical acceptance before attempting a replay. A failed
      // lookup is not absence and must retain the original command and fence.
      const status = await client.getOperationGroup({ accountId: slot.accountId, requestId: slot.requestId });
      if (session.detached || sessionToken !== session.generation || !sameSlot(slot.requestId)) return;
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
      if (session.detached || sessionToken !== session.generation) return;
      lastCommandError.value = null;
      if (sameSlot(slot.requestId)) {
        lastGroup.value = { ...lastGroup.value!, state: 'accepted', receipt: { ...receipt } };
      }
      await refresh();
    } catch (raw) {
      if (session.detached || sessionToken !== session.generation) return;
      lastCommandError.value = toMailError(raw);
      // A replay can be refused by today's capability/lifecycle checks even
      // when the ORIGINAL attempt committed. No replay error proves historical
      // non-acceptance: retain its identity/fence and query again if possible.
      await resolveUnknownAcceptance();
    } finally {
      if (!session.detached && sessionToken === session.generation) groupInFlight.value = false;
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
    if ((kind === 'read' || kind === 'star') && mode() !== 'gmail') {
      lastCommandError.value = { kind: 'read_only' };
      return false;
    }
    const account = accountId();
    if (!account || members.length < 1) {
      lastCommandError.value = { kind: 'invalid_request', field: 'members' };
      return false;
    }
    const token = commands.next();
    const sessionToken = session.generation;
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
      if (session.detached || sessionToken !== session.generation) return true;
      if (token === commands.current()) lastCommandError.value = null;
      if (sameSlot(requestId)) adoptGroupReceipt(receipt);
      await refresh();
      return true;
    } catch (raw) {
      if (!session.detached && sessionToken === session.generation && token === commands.current()) {
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
      if (!session.detached && sessionToken === session.generation && token === commands.current()) {
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
    if (session.detached || !sameSlot(requestId)) return;
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
    const token = commands.next();
    const sessionToken = session.generation;
    groupInFlight.value = true;
    try {
      const receipt = await client.undoOperationGroup({ groupId, requestId: crypto.randomUUID() });
      if (session.detached || sessionToken !== session.generation) return receipt;
      if (token === commands.current()) lastCommandError.value = null;
      if (slotMatches && sameSlot(slot!.requestId)) {
        await refreshSlotAfterGroupUndo(slot!.requestId);
        if (!session.detached && sameSlot(slot!.requestId)) {
          lastGroup.value = { ...lastGroup.value!, undone: receipt, hadWindow: true };
        }
      }
      await refreshRecentGroups();
      if (!session.detached && groupDetail.value?.group.groupId === groupId) await openGroupDetail(groupDetail.value.group.requestId);
      return receipt;
    } catch (raw) {
      if (session.detached || sessionToken !== session.generation || token !== commands.current()) return null;
      const error = toMailError(raw);
      lastCommandError.value = error;
      // Even a lost Undo response can follow a committed decision. Recover
      // the durable record instead of showing original state as expired Undo.
      await refresh();
      await refreshGroupStatus();
      if (!session.detached && sessionToken === session.generation && lastGroup.value?.receipt?.groupId === groupId) {
        lastGroup.value = { ...lastGroup.value!, hadWindow: true };
      }
      return null;
    } finally {
      if (!session.detached && sessionToken === session.generation && token === commands.current()) {
        groupInFlight.value = false;
      }
    }
  }

  /** Activity: load one group's authoritative detail by original request id.
   * Session/account fenced; a failed read surfaces typed (distinct from
   * absence) so persisted recovery records are never silently hidden. */
  async function openGroupDetail(requestId: string): Promise<void> {
    const account = accountId();
    const sessionToken = session.generation;
    if (!account) return;
    const token = ++groupDetailToken;
    groupDetail.value = null;
    groupDetailError.value = null;
    const outcome = await client.getOperationGroup({ accountId: account, requestId })
      .then(
        (status) => ({ status, error: null as MailError | null }),
        (raw): { status: OperationGroupStatus | null; error: MailError | null } => ({ status: null, error: toMailError(raw) }),
      );
    if (session.detached || token !== groupDetailToken || sessionToken !== session.generation) return;
    groupDetail.value = outcome.status;
    groupDetailError.value = outcome.error;
  }

  /** Background re-fetch of the currently expanded group detail (authoritative
   * change events): keeps the old detail visible until the fresh view lands,
   * with the same session/account/token fences as an explicit open. */
  async function refreshExpandedGroupDetail(): Promise<void> {
    const current = groupDetail.value;
    const account = accountId();
    if (!current || !account || current.group.accountId !== account) return;
    const sessionToken = session.generation;
    const token = ++groupDetailToken;
    const outcome = await client.getOperationGroup({ accountId: account, requestId: current.group.requestId })
      .then(
        (status) => ({ status, error: null as MailError | null }),
        (raw): { status: OperationGroupStatus | null; error: MailError | null } => ({ status: null, error: toMailError(raw) }),
      );
    if (session.detached || sessionToken !== session.generation || token !== groupDetailToken) return;
    if (outcome.status) groupDetail.value = outcome.status;
    groupDetailError.value = outcome.error;
  }

  /**
   * Group bookkeeping that rides on every authoritative refresh: the notice slot
   * and Activity groups track authoritative member statuses, and the first
   * successful refresh rehydrates the latest eligible notice after restart.
   * An expanded Activity group detail follows authoritative changes so it
   * cannot keep showing queued members/stale Undo availability (§6).
   */
  function afterAuthoritativeRefresh(): void {
    void refreshRecentGroups();
    void refreshGroupStatus();
    if (groupDetail.value) void refreshExpandedGroupDetail();
    if (!noticeRehydrated) {
      noticeRehydrated = true;
      void rehydrateNotice();
    }
  }

  return {
    lastGroup, groupInFlight, bulkUnresolved, recentGroups, groupsError, groupsHasMore, groupsLoadingMore,
    groupDetail, groupDetailError,
    setArchivedGroup, setReadGroup, setStarredGroup, recoverGroupAcceptance, dismissGroupNotice,
    undoGroupAction, undoGroupById, loadMoreGroups, refreshGroups, openGroupDetail,
    clearGroupSurfaces, afterAuthoritativeRefresh,
  };
}
