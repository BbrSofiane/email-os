/**
 * Browser-only in-memory fake MailClient (Slices 01–04 preview + tests).
 *
 * THIS IS NOT DURABLE. It exists so the UI can run in a plain browser and so tests
 * can drive pending/failed/success operation flows deterministically. It mimics the
 * documented core semantics (per-message INBOX membership, queued/applying overlay
 * applied in acceptance order, request-ID dedup) so the UI can be exercised the way
 * the native core will behave — but native core read models remain authoritative and
 * the UI must display the "memory-only preview" disclosure whenever this client is
 * active.
 *
 * UI note: the UI never computes the pending overlay itself; this fake computes it
 * exactly where core would, behind the same read models (snapshot summaries carry
 * membership + pendingOperationId).
 *
 * The fake also models local-only drafts, native-close receipts, account lifecycle,
 * and Slice 03 permission/mutation states deterministically. `mode: 'gmail'` here is still labelled synthetic
 * in-memory data — never a real OAuth flow, never real mail. In Gmail mode the fake
 * starts with Gmail actions disabled and only enables them through a synthetic,
 * explicit grant flow. All data and grants remain in-memory only.
 */
import type {
  CachedDoneRequest,
  CachedDoneSnapshot,
  AccountStatus,
  AppCloseRequest,
  Address,
  ConnectionState,
  Conversation,
  ConversationRef,
  ConversationSummary,
  CreateDraft,
  DeleteDraft,
  Draft,
  DraftContent,
  DraftDeleteReceipt,
  DraftReceipt,
  DraftRef,
  DraftReplyLink,
  DraftSummary,
  InboxSnapshot,
  MailClient,
  MailError,
  MailMode,
  MailboxOperationKind,
  Message,
  MutationAccess,
  OperationFailure,
  OperationReceipt,
  OperationStatus,
  OperationSummary,
  RetryOperation,
  SaveDraft,
  SetArchived,
  SetRead,
  SyncState,
  UndoOperation,
  UndoReceipt,
} from './client';
import { FIXTURE_MAILBOX } from './generated';

export const BROWSER_PREVIEW_DISCLOSURE =
  'Browser preview: in-memory fake client. Nothing is durable and the native core is not connected.';

export interface FakeBehavior {
  /** Next N setter commands end in the selected status. */
  failNext: number;
  /** A definite provider failure or an ambiguous remote outcome. */
  failureKind: 'provider_unavailable' | 'provider_rejected' | 'outcome_unknown';
  /** When true, operations stay in `applying` until `release()`. */
  hold: boolean;
  /** When true, operations stay in `queued` (unclaimed by the worker) until `release()`. */
  holdQueued: boolean;
  /** When true, `undoOperation` calls stay pending until `release()`. */
  holdUndo: boolean;
  /** Hold the synthetic OAuth-upgrade completion until releaseUpgrade(). */
  holdUpgrade: boolean;
}

/** Simulated core account/sync state; mutated only through `setAccount`. */
export interface FakeAccountState {
  mode: MailMode;
  connection: ConnectionState;
  /** Address reported in `AccountInfo`; `null` means core has no account yet. */
  emailAddress: string | null;
  syncState: SyncState;
  lastSyncedAt: string | null;
  syncError: MailError | null;
  cachedConversations: number;
  initialSyncComplete: boolean;
  /** Core's discovery cap (0 = no disclosed cap, e.g. fixture mode). */
  coverageLimit: number;
  mutationAccess: MutationAccess;
}

export interface FakeControls {
  behavior: FakeBehavior;
  /** Lets all in-flight fake-provider work finish (await until quiet). */
  flush(): Promise<void>;
  /** Releases held operations. */
  release(): void;
  /** Direct read of internal activity, for assertions. */
  activity(): OperationSummary[];
  /** Number of active change listeners (teardown assertions). */
  listenerCount(): number;
  draftListenerCount(): number;
  closeListenerCount(): number;
  /** Emits one synthetic, non-durable close request without closing a browser window. */
  requestAppClose(): AppCloseRequest;
  pendingAppClose(): AppCloseRequest | null;
  completedCloseCount(): number;
  /** Current simulated account/sync state. */
  accountState(): Readonly<FakeAccountState>;
  /** Patches the simulated account/sync state and notifies change listeners. */
  setAccount(patch: Partial<FakeAccountState>): void;
  /** Holds the next N `getAccountStatus` calls until `releaseStatus()`. */
  holdNextStatus(count?: number): void;
  /** Releases all held `getAccountStatus` calls. */
  releaseStatus(): void;
  /** Next `getAccountStatus` rejects with this error (once). */
  failNextStatus(error?: MailError): void;
  /** Next `connectAccount` rejects after flipping back to the prior connection. */
  failNextConnect(error?: MailError): void;
  /** Next `disconnectAccount` rejects and keeps the current state. */
  failNextDisconnect(error?: MailError): void;
  /** Next `requestSync` ends in `sync: 'error'` with this error. */
  failNextSync(error?: MailError): void;
  /** Fails the next synthetic permission upgrade without changing prior access. */
  failNextEnable(error?: MailError): void;
  /** Releases a held synthetic permission upgrade. */
  releaseUpgrade(): void;
  /** Makes the next synthetic cancellation fail. */
  failNextCancelUpgrade(error?: MailError): void;
  /** Adds an incoming message to test immutable operation target snapshots. */
  addMessage(conversationId: string, read?: boolean, from?: Address): void;
  /** Makes read facts unknown for a synthetic conversation. */
  markReadUnknown(conversationId: string): void;
  /** Marks an Activity-openable local recovery copy with a synthetic save time. */
  markRetainedSnapshot(conversationId: string, savedAt: string): void;
  /** Flags a seeded conversation with Gmail plain-text limitations. */
  markUnsupported(conversationId: string, unsupportedReason: string, contextComplete?: boolean): void;
}

export interface BrowserFake extends MailClient {
  controls: FakeControls;
  /** Always true; the UI surfaces this to force the memory-only disclosure. */
  readonly memoryOnly: true;
}

const ACCOUNT_ID = 'fixture-account';
const CONVERSATION_COUNT = 18;

interface SeedMessage {
  id: string;
  from: Address;
  to: Address[];
  sentAt: string;
  bodyText: string;
  /** Per-message INBOX membership as seeded (core owns the real facts). */
  seededInInbox: boolean;
  seededRead: boolean | null;
}

interface FakeConversation {
  ref: ConversationRef;
  subject: string;
  messages: SeedMessage[];
  /** Operations in acceptance order; failed ones stay listed but are excluded from the overlay. */
  ops: InternalOperation[];
  /** Slice 02: Gmail plain-text limitation disclosure (absent for legacy fixture data). */
  unsupportedReason?: string;
  contextComplete?: boolean;
  retainedSnapshotAt?: string;
}

interface InternalOperation {
  id: string;
  conversationId: string;
  kind: MailboxOperationKind;
  requestedArchived: boolean;
  requestedRead?: boolean;
  messageIds: string[];
  status: OperationStatus;
  failure: OperationFailure | null;
  lastError?: MailError;
  /** Acceptance time from the injected clock; the undo window runs from here. */
  acceptedAt: string;
  /**
   * Effective prior value of this operation's dimension per target message,
   * captured at acceptance; `null`/absent is an unknown fact (not undoable).
   * For `archive` the dimension is archived-ness; for `read`, read-ness.
   */
  priorValues: Record<string, boolean | null>;
  /** Present on compensating operations; they are never themselves undoable. */
  undoOf?: string;
}

const iso = (minutesOffset: number): string =>
  new Date(Date.UTC(2025, 0, 6, 9, 0, 0) + minutesOffset * 60_000).toISOString();

function snapshotCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function addr(displayName: string | null, mailbox: string): Address {
  return { displayName, mailbox };
}

function msg(
  id: string,
  from: Address,
  to: Address[],
  minutesOffset: number,
  bodyText: string,
  seededInInbox = true,
  seededRead: boolean | null = true,
): SeedMessage {
  return { id, from, to, sentAt: iso(minutesOffset), bodyText, seededInInbox, seededRead };
}

const SAFE_SENDER = addr('Ada Fixture', 'ada@example.test');
const HOSTILE_SENDER = addr('<script>alert("sender")</script>', 'hostile@example.test');
const ME = addr('You', FIXTURE_MAILBOX);

function seedConversations(): FakeConversation[] {
  const conversations: FakeConversation[] = [];
  for (let i = 1; i <= CONVERSATION_COUNT; i += 1) {
    const id = `conv-${String(i).padStart(2, '0')}`;
    const hostile = i % 6 === 0; // 3 hostile-markup fixtures
    const from = hostile ? HOSTILE_SENDER : SAFE_SENDER;
    const subject = hostile
      ? '<img src=x onerror=alert(1)> subject with <b>markup</b>'
      : `Fixture thread ${i}: weekly status`;
    const body = hostile
      ? [
          'Plain text must render literally.',
          '<script>alert("body")</script>',
          '<a href="javascript:alert(2)">click</a>',
          'No remote assets, no HTML execution.',
        ].join('\n')
      : `Thread ${i} body.\nPlain text only.\nLine three.`;
    const base = 5000 - i * 37;
    conversations.push({
      ref: { accountId: ACCOUNT_ID, conversationId: id },
      subject,
      messages: [
        msg(`${id}-m1`, from, [ME], base, `First message of ${id}.\n${body}`),
        msg(`${id}-m2`, ME, [from], base + 30, `Reply in ${id}. Still plain text.`),
        msg(`${id}-m3`, from, [ME], base + 60, `Latest message in ${id}.\n${body}`, true, i % 2 === 0),
      ],
      ops: [],
    });
  }
  return conversations;
}

function summarize(conv: FakeConversation, pendingOperationId: string | null): ConversationSummary {
  const last = conv.messages[conv.messages.length - 1];
  if (!last) throw new Error(`fixture conversation ${conv.ref.conversationId} has no messages`);
  const participants = [last.from, ...last.to];
  const seen = new Set<string>();
  const unique: Address[] = [];
  for (const p of participants) {
    if (!seen.has(p.mailbox)) {
      seen.add(p.mailbox);
      unique.push(p);
    }
  }
  const readStates = effectiveRead(conv);
  return {
    ref: { ...conv.ref },
    subject: conv.subject,
    participants: unique.map((participant) => ({ ...participant })),
    // Backend-derived like core: newest message's sender, never a participant guess.
    primaryCorrespondent: { ...last.from },
    preview: last.bodyText.replace(/\s+/g, ' ').slice(0, 120),
    lastMessageAt: last.sentAt,
    ...(readStates.every((read) => read !== null) ? { isRead: readStates.every(Boolean) } : {}),
    pendingOperationId,
  };
}

/**
 * Effective per-message INBOX membership: seed facts with all queued/applying/confirmed
 * operations applied in acceptance order (failed ops are excluded). A conversation is
 * in the inbox when ANY observed message is effectively in the inbox.
 */
function effectiveInInbox(conv: FakeConversation): boolean[] {
  const flags = conv.messages.map((m) => m.seededInInbox);
  for (const op of conv.ops) {
    if (op.status === 'failed' || op.status === 'cancelled' || op.kind !== 'archive') continue;
    for (let i = 0; i < conv.messages.length; i += 1) {
      const m = conv.messages[i];
      if (m && op.messageIds.includes(m.id)) flags[i] = !op.requestedArchived;
    }
  }
  return flags;
}

function effectiveRead(conv: FakeConversation): Array<boolean | null> {
  const flags = conv.messages.map((message) => message.seededRead);
  for (const op of conv.ops) {
    if (op.status === 'failed' || op.status === 'cancelled' || op.kind !== 'read' || op.requestedRead === undefined) continue;
    for (let i = 0; i < conv.messages.length; i += 1) {
      const message = conv.messages[i];
      if (message && op.messageIds.includes(message.id)) flags[i] = op.requestedRead;
    }
  }
  return flags;
}

function pendingOperationId(conv: FakeConversation): string | null {
  for (let i = conv.ops.length - 1; i >= 0; i -= 1) {
    const op = conv.ops[i];
    if (op && (op.status === 'queued' || op.status === 'applying' || op.status === 'outcome_unknown')) return op.id;
  }
  return null;
}

const UNDO_WINDOW_MS = 10_000;

function toOperationSummary(op: InternalOperation, accountId: string, undoableUntil?: string): OperationSummary {
  return {
    id: op.id,
    conversation: { accountId, conversationId: op.conversationId },
    requestedArchived: op.requestedArchived,
    status: op.status,
    failure: op.failure,
    kind: op.kind,
    ...(op.requestedRead === undefined ? {} : { requestedRead: op.requestedRead }),
    ...(op.lastError === undefined ? {} : { lastError: op.lastError }),
    ...(op.undoOf === undefined ? {} : { undoOf: op.undoOf }),
    ...(undoableUntil === undefined ? {} : { undoableUntil }),
  };
}

export function createBrowserFakeMailClient(now: () => string = () => new Date().toISOString()): BrowserFake {
  const conversations = seedConversations();
  const listeners = new Set<() => void>();
  const draftListeners = new Set<() => void>();
  const closeListeners = new Set<(request: AppCloseRequest) => void>();
  const drafts = new Map<string, Draft>();
  const draftReceipts = new Map<string, { fingerprint: string; receipt: DraftReceipt | DraftDeleteReceipt }>();
  let draftCounter = 0;
  let closeCounter = 0;
  let pendingClose: AppCloseRequest | null = null;
  let completedCloses = 0;
  const receiptsByRequest = new Map<string, { fingerprint: string; receipt: OperationReceipt | UndoReceipt }>();
  const behavior: FakeBehavior = { failNext: 0, failureKind: 'provider_rejected', hold: false, holdQueued: false, holdUpgrade: false, holdUndo: false };

  let opCounter = 0;
  let inFlight = 0;
  let holdReleased = false;
  const holdWaiters: Array<() => void> = [];
  const undoWaiters: Array<() => void> = [];

  // Slice 02 account simulation. Fixture mode is the default so the Slice 01 preview
  // and its tests keep working unchanged.
  const account: FakeAccountState = {
    mode: 'fixture',
    connection: 'connected',
    emailAddress: FIXTURE_MAILBOX,
    syncState: 'idle',
    lastSyncedAt: null,
    syncError: null,
    cachedConversations: CONVERSATION_COUNT,
    initialSyncComplete: true,
    coverageLimit: 0,
    mutationAccess: 'read_only',
  };
  // Core clears local cache data on disconnect; the fake mirrors that with a flag.
  let cacheCleared = false;
  let heldStatusCalls = 0;
  const statusHoldWaiters: Array<() => void> = [];
  let failStatus: MailError | null = null;
  let failConnect: MailError | null = null;
  let failDisconnect: MailError | null = null;
  let failSync: MailError | null = null;
  let failEnable: MailError | null = null;
  let failCancelUpgrade: MailError | null = null;
  let upgradeGeneration = 0;
  let upgradeReleased = false;
  const upgradeWaiters: Array<() => void> = [];

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  const notifyDrafts = (): void => {
    for (const listener of draftListeners) listener();
  };

  const activeDraftAccountId = (): string | null => accountStatus().account?.accountId ?? null;

  const draftSummary = (draft: Draft): DraftSummary => ({
    ref: { ...draft.ref }, revision: draft.revision, updatedAt: draft.updatedAt,
    subject: draft.content.subject, to: draft.content.to, source: snapshotCopy(draft.source),
  });

  function validateDraftContent(content: DraftContent): void {
    const limits: Array<[keyof DraftContent, number]> = [['to', 16 * 1024], ['cc', 16 * 1024], ['subject', 4 * 1024], ['bodyText', 1024 * 1024]];
    for (const [field, max] of limits) {
      if (new TextEncoder().encode(content[field]).length > max) {
        throw { kind: 'invalid_request', field } satisfies MailError;
      }
    }
  }

  function draftCommandFingerprint(kind: string, command: unknown): string {
    const serialized = JSON.stringify([kind, command]);
    let first = 2166136261;
    let second = 0x9e3779b9;
    for (let i = 0; i < serialized.length; i += 1) {
      const code = serialized.charCodeAt(i);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ (code + i), 2246822519);
    }
    return `${serialized.length}:${first >>> 0}:${second >>> 0}`;
  }

  function validateDraftRequestId(requestId: string): void {
    if (!requestId || new TextEncoder().encode(requestId).length > 128) {
      throw { kind: 'invalid_request', field: 'requestId' } satisfies MailError;
    }
  }

  function existingDraftReceipt<T extends DraftReceipt | DraftDeleteReceipt>(accountId: string, requestId: string, fingerprint: string): T | null {
    validateDraftRequestId(requestId);
    const existing = draftReceipts.get(`${accountId}:${requestId}`);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw { kind: 'request_id_conflict' } satisfies MailError;
    return snapshotCopy(existing.receipt) as T;
  }

  const settle = (): Promise<void> => Promise.resolve();

  function accountStatus(): AccountStatus {
    const cached = account.mode === 'gmail'
      ? (cacheCleared ? 0 : account.cachedConversations)
      : conversations.length;
    return {
      mode: account.mode,
      connection: account.connection,
      account: account.emailAddress
        ? {
            accountId: account.mode === 'gmail' ? 'gmail-account' : 'fixture-account',
            emailAddress: account.emailAddress,
          }
        : null,
      sync: {
        state: account.syncState,
        lastSyncedAt: account.lastSyncedAt,
        error: account.syncError ? { ...account.syncError } : null,
        cachedConversations: cached,
        initialSyncComplete: account.initialSyncComplete,
        coverageLimit: account.coverageLimit,
      },
      mutationAccess: account.mode === 'gmail' ? account.mutationAccess : 'read_only',
    };
  }

  const byId = (conversationId: string): FakeConversation | undefined =>
    cacheCleared || !accountStatus().account ? undefined :
      conversations.find((c) => c.ref.conversationId === conversationId && c.ref.accountId === accountStatus().account?.accountId);

  const allOps = (): Array<{ conv: FakeConversation; op: InternalOperation }> =>
    conversations.flatMap((conv) => conv.ops.map((op) => ({ conv, op })));

  /** Effective prior value of the operation's dimension per target, captured before it joins the overlay. */
  function effectivePriorValues(conv: FakeConversation, kind: MailboxOperationKind, messageIds: string[]): Record<string, boolean | null> {
    const inbox = effectiveInInbox(conv);
    const read = effectiveRead(conv);
    const values: Record<string, boolean | null> = {};
    for (let i = 0; i < conv.messages.length; i += 1) {
      const message = conv.messages[i];
      if (!message || !messageIds.includes(message.id)) continue;
      // Archive ops restore archived-ness (the inverse of INBOX membership);
      // read ops restore read-ness, which can be an unknown fact.
      values[message.id] = kind === 'archive' ? !inbox[i] : read[i] ?? null;
    }
    return values;
  }

  /** §3.2 rules 2–7 (rule 1 holds by construction in the single-account fake). */
  function undoBlocker(op: InternalOperation): MailError | null {
    if (op.undoOf !== undefined) return { kind: 'undo_unavailable', reason: 'not_applicable' } satisfies MailError;
    if (Date.parse(now()) >= Date.parse(op.acceptedAt) + UNDO_WINDOW_MS) {
      return { kind: 'undo_unavailable', reason: 'expired' } satisfies MailError;
    }
    if (allOps().some((entry) => entry.op.undoOf === undefined && entry.op.id > op.id)) {
      return { kind: 'undo_unavailable', reason: 'superseded' } satisfies MailError;
    }
    if (allOps().some((entry) => entry.op.undoOf === op.id)) {
      return { kind: 'undo_unavailable', reason: 'already_undone' } satisfies MailError;
    }
    if (op.status === 'outcome_unknown') return { kind: 'undo_unavailable', reason: 'uncertain' } satisfies MailError;
    if (op.status !== 'queued' && op.status !== 'applying' && op.status !== 'confirmed') {
      // A cancelled op was already undone in place; a re-undo reports
      // already_undone, matching Rust's rule ordering.
      if (op.status === 'cancelled') return { kind: 'undo_unavailable', reason: 'already_undone' } satisfies MailError;
      return { kind: 'undo_unavailable', reason: 'not_applicable' } satisfies MailError;
    }
    if (op.messageIds.some((id) => op.priorValues[id] === undefined || op.priorValues[id] === null)) {
      return { kind: 'undo_unavailable', reason: 'unknown_prior' } satisfies MailError;
    }
    return null;
  }

  /** `undoableUntil` is present only while every undo rule still holds at query time. */
  function summarizeOperation(op: InternalOperation, accountId: string): OperationSummary {
    return toOperationSummary(
      op,
      accountId,
      undoBlocker(op) ? undefined : new Date(Date.parse(op.acceptedAt) + UNDO_WINDOW_MS).toISOString(),
    );
  }

  function snapshot(): InboxSnapshot {
    // No account / cleared cache means no cached mail; core would return the same.
    const empty =
      cacheCleared ||
      (account.mode === 'gmail' && (account.connection === 'not_configured' || account.connection === 'disconnected'));
    const activity = empty
      ? []
      : conversations
          .flatMap((c) => c.ops.map((op) => summarizeOperation(op, c.ref.accountId)))
          .sort((a, b) => a.id.localeCompare(b.id));
    const rows = empty
      ? []
      : conversations
          .map((c) => ({ c, flags: effectiveInInbox(c) }))
          .filter((entry) => entry.flags.some((f) => f))
          .map((entry) => summarize(entry.c, pendingOperationId(entry.c)))
          .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return snapshotCopy({ conversations: rows, activity });
  }

  function failNotShown(): MailError {
    return { kind: 'not_found' };
  }

  function requireMutationAccess(kind: MailboxOperationKind): void {
    if (kind === 'read' && account.mode !== 'gmail') throw { kind: 'read_only' } satisfies MailError;
    if (account.mode === 'gmail' && account.mutationAccess !== 'enabled') throw { kind: 'read_only' } satisfies MailError;
  }

  function existingReceipt<T = OperationReceipt>(requestId: string, fingerprint: string): T | null {
    const existing = receiptsByRequest.get(requestId);
    if (!existing) return null;
    if (existing.fingerprint !== fingerprint) throw { kind: 'request_id_conflict' } satisfies MailError;
    return snapshotCopy(existing.receipt) as T;
  }

  function enqueueOperation(
    conv: FakeConversation,
    kind: MailboxOperationKind,
    requestedArchived: boolean,
    requestedRead: boolean | undefined,
    messageIds: string[],
    requestId: string,
    fingerprint: string,
    options: { priorValues?: Record<string, boolean | null>; undoOf?: string } = {},
  ): OperationReceipt {
    opCounter += 1;
    const operationId = `op-${String(opCounter).padStart(4, '0')}`;
    const acceptedAt = now();
    const receipt: OperationReceipt = { operationId, acceptedAt };
    receiptsByRequest.set(requestId, { fingerprint, receipt });
    const op: InternalOperation = {
      id: operationId,
      conversationId: conv.ref.conversationId,
      kind,
      requestedArchived,
      ...(requestedRead === undefined ? {} : { requestedRead }),
      messageIds: [...messageIds],
      status: 'queued',
      failure: null,
      acceptedAt,
      // Per-message effective value of THIS operation's dimension at acceptance
      // (before this op joins the overlay); retries reuse the original's preimage.
      priorValues: options.priorValues
        ? { ...options.priorValues }
        : effectivePriorValues(conv, kind, messageIds),
      ...(options.undoOf === undefined ? {} : { undoOf: options.undoOf }),
    };
    conv.ops.push(op);
    if (behavior.hold || behavior.holdQueued) holdReleased = false;
    notify();
    void runOperation(op).then(() => notify());
    return snapshotCopy(receipt);
  }

  async function runOperation(op: InternalOperation): Promise<void> {
    inFlight += 1;
    try {
      // holdQueued models a worker that has not claimed the intent yet: the
      // operation stays `queued`, so undo can still cancel it in place.
      if (behavior.holdQueued && !holdReleased) {
        await new Promise<void>((resolve) => holdWaiters.push(resolve));
      }
      if (op.status === 'cancelled') return; // cancelled while still queued
      // queued -> applying (worker claims in acceptance order; fake uses FIFO)
      op.status = 'applying';
      notify();
      if (behavior.hold && !holdReleased) {
        await new Promise<void>((resolve) => holdWaiters.push(resolve));
      }
      // ArchiveProvider call happens outside any "transaction" in core; here it is
      // just an async boundary so state transitions are observable.
      await Promise.resolve();
      if (!conversations.some((conv) => conv.ops.includes(op))) return;
      if (behavior.failNext > 0) {
        behavior.failNext -= 1;
        if (behavior.failureKind === 'outcome_unknown') {
          op.status = 'outcome_unknown';
          op.lastError = { kind: 'outcome_unknown' };
        } else {
          op.status = 'failed';
          op.failure = { kind: behavior.failureKind };
          op.lastError = behavior.failureKind === 'provider_rejected'
            ? { kind: 'provider_rejected' }
            : { kind: 'provider_unavailable' };
        }
        notify();
        return;
      }
      op.failure = null;
      delete op.lastError;
      op.status = 'confirmed';
      notify();
    } finally {
      inFlight -= 1;
    }
  }

  const client: BrowserFake = {
    memoryOnly: true,
    controls: {
      behavior,
      async flush(): Promise<void> {
        for (let guard = 0; guard < 1000; guard += 1) {
          if (inFlight === 0) return;
          if (behavior.hold || behavior.holdQueued) return; // held work cannot finish until release()
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      release(): void {
        holdReleased = true;
        while (holdWaiters.length > 0) {
          const w = holdWaiters.shift();
          w?.();
        }
        while (undoWaiters.length > 0) {
          const w = undoWaiters.shift();
          w?.();
        }
      },
      activity(): OperationSummary[] {
        return snapshotCopy(conversations
          .flatMap((c) => c.ops.map((op) => summarizeOperation(op, c.ref.accountId)))
          .sort((a, b) => a.id.localeCompare(b.id)));
      },
      listenerCount(): number {
        return listeners.size;
      },
      draftListenerCount(): number {
        return draftListeners.size;
      },
      closeListenerCount(): number {
        return closeListeners.size;
      },
      requestAppClose(): AppCloseRequest {
        if (!pendingClose) {
          closeCounter += 1;
          pendingClose = { requestId: `close-${closeCounter}` };
          for (const listener of closeListeners) listener(snapshotCopy(pendingClose));
        }
        return snapshotCopy(pendingClose);
      },
      pendingAppClose(): AppCloseRequest | null {
        return pendingClose ? snapshotCopy(pendingClose) : null;
      },
      completedCloseCount(): number {
        return completedCloses;
      },
      accountState(): Readonly<FakeAccountState> {
        return snapshotCopy(account);
      },
      setAccount(patch: Partial<FakeAccountState>): void {
        const identityChanged = (patch.mode !== undefined && patch.mode !== account.mode) ||
          (patch.emailAddress != null && account.emailAddress != null && patch.emailAddress !== account.emailAddress);
        Object.assign(account, patch);
        if (identityChanged) {
          // Mode/account controls represent a fresh synthetic cache, not migration
          // of another account's operations or mail into the new identity.
          conversations.splice(0, conversations.length, ...seedConversations());
          receiptsByRequest.clear();
          cacheCleared = false;
        }
        const accountId = account.mode === 'gmail' ? 'gmail-account' : ACCOUNT_ID;
        for (const conv of conversations) conv.ref.accountId = accountId;
        notify();
      },
      holdNextStatus(count = 1): void {
        heldStatusCalls += count;
      },
      releaseStatus(): void {
        while (statusHoldWaiters.length > 0) {
          statusHoldWaiters.shift()?.();
        }
      },
      failNextStatus(error: MailError = { kind: 'storage_unavailable' }): void {
        failStatus = error;
      },
      failNextConnect(error: MailError = { kind: 'auth_failed' }): void {
        failConnect = error;
      },
      failNextDisconnect(error: MailError = { kind: 'storage_unavailable' }): void {
        failDisconnect = error;
      },
      failNextSync(error: MailError = { kind: 'network_unavailable' }): void {
        failSync = error;
      },
      failNextEnable(error: MailError = { kind: 'permission_required' }): void {
        failEnable = error;
      },
      releaseUpgrade(): void {
        upgradeReleased = true;
        while (upgradeWaiters.length > 0) upgradeWaiters.shift()?.();
      },
      failNextCancelUpgrade(error: MailError = { kind: 'storage_unavailable' }): void {
        failCancelUpgrade = error;
      },
      addMessage(conversationId: string, read = false, from: Address = SAFE_SENDER): void {
        const conv = byId(conversationId);
        if (!conv) throw new Error(`addMessage: unknown conversation ${conversationId}`);
        const last = conv.messages[conv.messages.length - 1];
        const sentAt = last ? new Date(Date.parse(last.sentAt) + 60_000).toISOString() : now();
        const id = `${conversationId}-incoming-${conv.messages.length + 1}`;
        conv.messages.push({ id, from: { ...from }, to: [ME], sentAt, bodyText: 'Synthetic incoming message.', seededInInbox: true, seededRead: read });
        notify();
      },
      markReadUnknown(conversationId: string): void {
        const conv = byId(conversationId);
        if (!conv) throw new Error(`markReadUnknown: unknown conversation ${conversationId}`);
        conv.messages.forEach((message) => { message.seededRead = null; });
        notify();
      },
      markRetainedSnapshot(conversationId: string, savedAt: string): void {
        const conv = byId(conversationId);
        if (!conv) throw new Error(`markRetainedSnapshot: unknown conversation ${conversationId}`);
        conv.retainedSnapshotAt = savedAt;
        notify();
      },
      markUnsupported(conversationId: string, unsupportedReason: string, contextComplete = false): void {
        const conv = byId(conversationId);
        if (!conv) throw new Error(`markUnsupported: unknown conversation ${conversationId}`);
        conv.unsupportedReason = unsupportedReason;
        conv.contextComplete = contextComplete;
        notify();
      },
    },

    async listConversations(): Promise<InboxSnapshot> {
      return snapshot();
    },

    async listCachedDone(request: CachedDoneRequest): Promise<CachedDoneSnapshot> {
      const active = accountStatus().account;
      if (!active || request.accountId !== active.accountId || cacheCleared) throw failNotShown();
      if (!Number.isInteger(request.limit) || request.limit < 1 || request.limit > 100) {
        throw { kind: 'invalid_request', field: 'limit' } satisfies MailError;
      }
      let position: [string, string] | null = null;
      if (request.cursor !== null) {
        try {
          if (request.cursor.length > 8192 || !request.cursor.startsWith('cached-done-v1:')) throw new Error();
          const value: unknown = JSON.parse(request.cursor.slice('cached-done-v1:'.length));
          if (!Array.isArray(value) || value.length !== 3 || value[0] !== request.accountId ||
              typeof value[1] !== 'string' || value[1].length > 128 ||
              typeof value[2] !== 'string' || !value[2] || value[2].length > 1024) throw new Error();
          position = [value[1], value[2]];
        } catch { throw { kind: 'invalid_request', field: 'cursor' } satisfies MailError; }
      }
      const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
      // Candidate query matches Rust: an archive whose compensation is still
      // pending/confirmed/unknown is excluded BEFORE paging (a failed or
      // cancelled compensation leaves the archive a qualifying candidate).
      const qualifies = (conv: FakeConversation): boolean => {
        const archive = conv.ops.find((op) => op.kind === 'archive' && op.requestedArchived && op.status !== 'failed' && op.status !== 'cancelled');
        if (!archive) return false;
        const compensation = conv.ops.find((op) => op.undoOf === archive.id);
        return !compensation || compensation.status === 'failed' || compensation.status === 'cancelled';
      };
      const candidates = conversations.filter(qualifies)
        .map((conv) => ({ conv, row: summarize(conv, pendingOperationId(conv)) }))
        .sort((a, b) => compare(b.row.lastMessageAt, a.row.lastMessageAt) || compare(a.row.ref.conversationId, b.row.ref.conversationId))
        .filter(({ row }) => !position || row.lastMessageAt < position[0] ||
          (row.lastMessageAt === position[0] && row.ref.conversationId > position[1]))
        .slice(0, request.limit + 1);
      const page = candidates.slice(0, request.limit);
      const last = page[page.length - 1];
      return snapshotCopy({
        conversations: page.filter(({ conv }) => !effectiveInInbox(conv).some(Boolean)).map(({ row }) => row),
        nextCursor: candidates.length > request.limit && last
          ? `cached-done-v1:${JSON.stringify([request.accountId, last.row.lastMessageAt, last.row.ref.conversationId])}` : null,
        coverage: 'local_cache', exactTotal: null, lastSyncedAt: account.lastSyncedAt,
      });
    },

    async getConversation(ref: ConversationRef): Promise<Conversation> {
      const conv = byId(ref.conversationId);
      if (!conv || conv.ref.accountId !== ref.accountId) throw failNotShown();
      const flags = effectiveInInbox(conv);
      const messages: Message[] = conv.messages.map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        sentAt: m.sentAt,
        bodyText: m.bodyText,
      }));
      const readStates = effectiveRead(conv);
      const result: Conversation = {
        ref: { ...conv.ref },
        subject: conv.subject,
        messages,
        isInInbox: flags.some((f) => f),
        ...(readStates.every((read) => read !== null) ? { isRead: readStates.every(Boolean) } : {}),
        pendingOperationId: pendingOperationId(conv),
      };
      if (conv.unsupportedReason !== undefined) result.unsupportedReason = conv.unsupportedReason;
      if (conv.contextComplete !== undefined) result.contextComplete = conv.contextComplete;
      if (conv.retainedSnapshotAt !== undefined) result.retainedSnapshotAt = conv.retainedSnapshotAt;
      const latest = conv.messages[conv.messages.length - 1];
      if (latest && conv.contextComplete !== false && !conv.retainedSnapshotAt) {
        result.replyContext = {
          sourceMessageId: latest.id,
          fromMailbox: latest.from.mailbox,
          replyToMailboxes: null,
          messageId: `<${latest.id}@fixture.emailos>`,
          references: conv.messages.slice(0, -1).map((message) => `<${message.id}@fixture.emailos>`),
        };
      }
      return snapshotCopy(result);
    },

    async setArchived(command: SetArchived): Promise<OperationReceipt> {
      requireMutationAccess('archive');
      const fingerprint = JSON.stringify(['archive', command.conversation.accountId, command.conversation.conversationId, command.archived]);
      const existing = existingReceipt(command.requestId, fingerprint);
      if (existing) return existing;
      const conv = byId(command.conversation.conversationId);
      if (!conv || conv.ref.accountId !== command.conversation.accountId) throw failNotShown();
      return enqueueOperation(conv, 'archive', command.archived, undefined, conv.messages.map((message) => message.id), command.requestId, fingerprint);
    },

    async enableMailboxActions(): Promise<void> {
      if (account.mode !== 'gmail') throw { kind: 'invalid_request', field: 'mode' } satisfies MailError;
      if (account.connection !== 'connected') throw { kind: 'auth_required' } satisfies MailError;
      if (account.mutationAccess === 'enabled' || account.mutationAccess === 'upgrading') return;
      if (failEnable) {
        const error = failEnable;
        failEnable = null;
        throw error;
      }
      account.mutationAccess = 'upgrading';
      const generation = ++upgradeGeneration;
      upgradeReleased = false;
      notify();
      void (async () => {
        if (behavior.holdUpgrade && !upgradeReleased) await new Promise<void>((resolve) => upgradeWaiters.push(resolve));
        if (generation !== upgradeGeneration || account.mutationAccess !== 'upgrading') return;
        account.mutationAccess = 'enabled';
        notify();
      })();
    },

    async cancelMailboxActionUpgrade(): Promise<void> {
      if (account.mode !== 'gmail') throw { kind: 'invalid_request', field: 'mode' } satisfies MailError;
      if (failCancelUpgrade) {
        const error = failCancelUpgrade;
        failCancelUpgrade = null;
        throw error;
      }
      if (account.mutationAccess === 'upgrading') {
        ++upgradeGeneration;
        account.mutationAccess = 'read_only';
        upgradeReleased = true;
        while (upgradeWaiters.length > 0) upgradeWaiters.shift()?.();
        notify();
      }
    },

    async setRead(command: SetRead): Promise<OperationReceipt> {
      requireMutationAccess('read');
      const fingerprint = JSON.stringify(['read', command.conversation.accountId, command.conversation.conversationId, command.read]);
      const existing = existingReceipt(command.requestId, fingerprint);
      if (existing) return existing;
      const conv = byId(command.conversation.conversationId);
      if (!conv || conv.ref.accountId !== command.conversation.accountId) throw failNotShown();
      return enqueueOperation(conv, 'read', false, command.read, conv.messages.map((message) => message.id), command.requestId, fingerprint);
    },

    async retryOperation(command: RetryOperation): Promise<OperationReceipt> {
      if (account.mode !== 'gmail') throw { kind: 'invalid_request', field: 'mode' } satisfies MailError;
      const original = conversations.flatMap((conv) => conv.ops.map((op) => ({ conv, op }))).find(({ op }) => op.id === command.operationId);
      if (!original) throw failNotShown();
      requireMutationAccess(original.op.kind);
      const fingerprint = JSON.stringify(['retry', command.operationId]);
      const existing = existingReceipt(command.requestId, fingerprint);
      if (existing) return existing;
      if (original.op.status !== 'failed' && original.op.status !== 'outcome_unknown') {
        throw { kind: 'invalid_request', field: 'operationId' } satisfies MailError;
      }
      // A retry restores the same prior world as the operation it retries: it
      // copies the original's preimage instead of capturing a fresh one.
      return enqueueOperation(original.conv, original.op.kind, original.op.requestedArchived, original.op.requestedRead, [...original.op.messageIds], command.requestId, fingerprint, { priorValues: original.op.priorValues });
    },

    async undoOperation(command: UndoOperation): Promise<UndoReceipt> {
      const fingerprint = JSON.stringify(['undo', command.operationId]);
      const existing = existingReceipt(command.requestId, fingerprint);
      if (existing) return existing as unknown as UndoReceipt;
      // Test hook: hold the IPC round trip open so in-flight undo gating is observable.
      if (behavior.holdUndo) await new Promise<void>((resolve) => { undoWaiters.push(resolve); });
      const entry = allOps().find(({ op }) => op.id === command.operationId);
      if (!entry) throw failNotShown();
      const blocker = undoBlocker(entry.op);
      if (blocker) throw blocker;
      if (entry.op.status === 'queued') {
        // Cancel-in-place: the intent never reaches the provider and drops out
        // of the pending overlay, but stays visible in Activity.
        entry.op.status = 'cancelled';
        notify();
        const cancelled: UndoReceipt = { undoneOperationId: entry.op.id, outcome: 'cancelled', operationIds: [], acceptedAt: now() };
        receiptsByRequest.set(command.requestId, { fingerprint, receipt: cancelled });
        return snapshotCopy(cancelled);
      }
      // Compensation: one queued operation per distinct prior value, each with
      // EXPLICIT targets captured in the original's preimage — never re-derived
      // from current facts, so later arrivals are untouched.
      const groups = new Map<boolean, string[]>();
      for (const id of entry.op.messageIds) {
        const value = entry.op.priorValues[id];
        if (value === null || value === undefined) continue; // unknown_prior already rejected
        const group = groups.get(value) ?? [];
        group.push(id);
        groups.set(value, group);
      }
      const operationIds: string[] = [];
      for (const [value, ids] of groups) {
        const compensating = enqueueOperation(
          entry.conv,
          entry.op.kind,
          entry.op.kind === 'read' ? entry.op.requestedArchived : value,
          entry.op.kind === 'read' ? value : entry.op.requestedRead,
          ids,
          `${command.requestId}:${ids.join(',')}`,
          JSON.stringify(['undo-compensation', command.requestId, value]),
          { undoOf: entry.op.id },
        );
        operationIds.push(compensating.operationId);
      }
      const receipt: UndoReceipt = { undoneOperationId: entry.op.id, outcome: 'compensating', operationIds, acceptedAt: now() };
      receiptsByRequest.set(command.requestId, { fingerprint, receipt });
      return snapshotCopy(receipt);
    },

    async subscribe(listener: () => void): Promise<() => void> {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    async listDrafts(): Promise<DraftSummary[]> {
      const accountId = activeDraftAccountId();
      if (!accountId) return [];
      return [...drafts.values()]
        .filter((draft) => draft.ref.accountId === accountId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(draftSummary);
    },

    async getDraft(ref: DraftRef): Promise<Draft> {
      if (!activeDraftAccountId() || ref.accountId !== activeDraftAccountId()) throw failNotShown();
      const draft = drafts.get(`${ref.accountId}:${ref.draftId}`);
      if (!draft) throw failNotShown();
      return snapshotCopy(draft);
    },

    async createDraft(command: CreateDraft): Promise<DraftReceipt> {
      const accountId = activeDraftAccountId();
      if (!accountId) throw { kind: 'auth_required' } satisfies MailError;
      const fingerprint = draftCommandFingerprint('create_draft', command);
      const existing = existingDraftReceipt<DraftReceipt>(accountId, command.requestId, fingerprint);
      if (existing) return existing;
      let content: DraftContent = command.initialContent
        ? snapshotCopy(command.initialContent)
        : { to: '', cc: '', subject: '', bodyText: '' };
      if (command.source.kind === 'reply') {
        if (command.initialContent !== null) throw { kind: 'invalid_request', field: 'initialContent' } satisfies MailError;
        const conv = byId(command.source.conversation.conversationId);
        if (!conv) throw failNotShown();
        const latest = conv.messages[conv.messages.length - 1];
        if (conv.ref.accountId !== command.source.conversation.accountId || !latest || latest.id !== command.source.sourceMessageId || conv.contextComplete === false || conv.retainedSnapshotAt) {
          throw { kind: 'reply_unavailable' } satisfies MailError;
        }
        const sender = latest.from.mailbox;
        if (!sender || sender.toLowerCase() === (account.emailAddress ?? '').toLowerCase()) throw { kind: 'reply_unavailable' } satisfies MailError;
        content = {
          to: sender,
          cc: '',
          subject: /^re:/i.test(conv.subject) ? conv.subject : `Re: ${conv.subject}`,
          bodyText: '',
        };
      }
      validateDraftContent(content);
      draftCounter += 1;
      const ref: DraftRef = { accountId, draftId: `draft-${String(draftCounter).padStart(4, '0')}` };
      let replyLink: DraftReplyLink | null = null;
      if (command.source.kind === 'reply') {
        const conv = byId(command.source.conversation.conversationId)!;
        const latest = conv.messages[conv.messages.length - 1]!;
        replyLink = {
          conversation: snapshotCopy(command.source.conversation),
          sourceMessageId: command.source.sourceMessageId,
          messageId: `<${latest.id}@fixture.emailos>`,
          references: [...conv.messages.slice(0, -1).map((message) => `<${message.id}@fixture.emailos>`), `<${latest.id}@fixture.emailos>`],
        };
      }
      const timestamp = now();
      const draft: Draft = {
        ref, revision: 1, createdAt: timestamp, updatedAt: timestamp,
        content, source: snapshotCopy(command.source), replyLink,
      };
      drafts.set(`${ref.accountId}:${ref.draftId}`, draft);
      const receipt: DraftReceipt = { ref: snapshotCopy(ref), revision: 1, savedAt: timestamp };
      draftReceipts.set(`${accountId}:${command.requestId}`, { fingerprint, receipt });
      notifyDrafts();
      return snapshotCopy(receipt);
    },

    async saveDraft(command: SaveDraft): Promise<DraftReceipt> {
      const fingerprint = draftCommandFingerprint('save_draft', command);
      const activeAccountId = activeDraftAccountId();
      const existing = existingDraftReceipt<DraftReceipt>(activeAccountId ?? command.ref.accountId, command.requestId, fingerprint);
      if (existing) return existing;
      validateDraftContent(command.content);
      if (!activeAccountId || command.ref.accountId !== activeAccountId) throw failNotShown();
      const draft = drafts.get(`${command.ref.accountId}:${command.ref.draftId}`);
      if (!draft) throw failNotShown();
      if (command.expectedRevision !== draft.revision) throw { kind: 'draft_conflict', currentRevision: draft.revision } satisfies MailError;
      if (draft.revision >= 0xffffffff) throw { kind: 'storage_unavailable' } satisfies MailError;
      draft.content = snapshotCopy(command.content);
      draft.revision += 1;
      draft.updatedAt = now();
      const receipt: DraftReceipt = { ref: snapshotCopy(draft.ref), revision: draft.revision, savedAt: draft.updatedAt };
      draftReceipts.set(`${command.ref.accountId}:${command.requestId}`, { fingerprint, receipt });
      notifyDrafts();
      return snapshotCopy(receipt);
    },

    async deleteDraft(command: DeleteDraft): Promise<DraftDeleteReceipt> {
      const fingerprint = draftCommandFingerprint('delete_draft', command);
      const activeAccountId = activeDraftAccountId();
      const existing = existingDraftReceipt<DraftDeleteReceipt>(activeAccountId ?? command.ref.accountId, command.requestId, fingerprint);
      if (existing) return existing;
      if (!activeAccountId || command.ref.accountId !== activeAccountId) throw failNotShown();
      const key = `${command.ref.accountId}:${command.ref.draftId}`;
      const draft = drafts.get(key);
      if (!draft) throw failNotShown();
      if (command.expectedRevision !== draft.revision) throw { kind: 'draft_conflict', currentRevision: draft.revision } satisfies MailError;
      drafts.delete(key);
      const receipt: DraftDeleteReceipt = { ref: snapshotCopy(command.ref), deletedAt: now() };
      draftReceipts.set(`${command.ref.accountId}:${command.requestId}`, { fingerprint, receipt });
      notifyDrafts();
      return snapshotCopy(receipt);
    },

    async subscribeDrafts(listener: () => void): Promise<() => void> {
      draftListeners.add(listener);
      return () => { draftListeners.delete(listener); };
    },

    async subscribeAppClose(listener: (request: AppCloseRequest) => void): Promise<() => void> {
      closeListeners.add(listener);
      const seen = new Set<string>();
      if (pendingClose && !seen.has(pendingClose.requestId)) {
        seen.add(pendingClose.requestId);
        listener(snapshotCopy(pendingClose));
      }
      return () => { closeListeners.delete(listener); };
    },

    async completeAppClose(requestId: string): Promise<void> {
      if (!pendingClose || pendingClose.requestId !== requestId) throw { kind: 'invalid_request', field: 'requestId' } satisfies MailError;
      pendingClose = null;
      completedCloses += 1;
    },

    async cancelAppClose(requestId: string): Promise<void> {
      if (!pendingClose || pendingClose.requestId !== requestId) throw { kind: 'invalid_request', field: 'requestId' } satisfies MailError;
      pendingClose = null;
    },

    async getAccountStatus(): Promise<AccountStatus> {
      if (heldStatusCalls > 0) {
        heldStatusCalls -= 1;
        await new Promise<void>((resolve) => statusHoldWaiters.push(resolve));
      }
      if (failStatus) {
        const error = failStatus;
        failStatus = null;
        throw error;
      }
      return accountStatus();
    },

    async connectAccount(): Promise<void> {
      if (account.mode !== 'gmail') throw { kind: 'invalid_request', field: 'mode' } satisfies MailError;
      const previous = account.connection;
      account.connection = 'authenticating';
      notify();
      await settle();
      if (failConnect) {
        const error = failConnect;
        failConnect = null;
        account.connection = previous;
        notify();
        throw error;
      }
      account.connection = 'connected';
      account.emailAddress ||= 'operator@example.test';
      account.syncState = 'idle';
      account.syncError = null;
      account.initialSyncComplete = true;
      cacheCleared = false;
      notify();
    },

    async disconnectAccount(): Promise<void> {
      if (account.mode !== 'gmail') throw { kind: 'invalid_request', field: 'mode' } satisfies MailError;
      if (failDisconnect) {
        const error = failDisconnect;
        failDisconnect = null;
        throw error;
      }
      // Fold only definite remote successes into the fake's provider facts. Pending
      // and ambiguous actions are local state and are removed, never replayed.
      for (const conv of conversations) {
        for (const op of conv.ops) {
          if (op.status !== 'confirmed') continue;
          for (const message of conv.messages) {
            if (!op.messageIds.includes(message.id)) continue;
            if (op.kind === 'archive') message.seededInInbox = !op.requestedArchived;
            else if (op.requestedRead !== undefined) message.seededRead = op.requestedRead;
          }
        }
        conv.ops = [];
        delete conv.retainedSnapshotAt;
      }
      receiptsByRequest.clear();
      // Core resolves only after credential deletion and local account/cache clearing.
      account.connection = 'disconnected';
      account.emailAddress = null;
      account.syncState = 'idle';
      account.syncError = null;
      account.lastSyncedAt = null;
      account.initialSyncComplete = false;
      cacheCleared = true;
      account.mutationAccess = 'read_only';
      ++upgradeGeneration;
      upgradeReleased = true;
      while (upgradeWaiters.length > 0) upgradeWaiters.shift()?.();
      notify();
    },

    requestSync(): Promise<void> {
      if (account.mode !== 'gmail') {
        return Promise.reject({ kind: 'invalid_request', field: 'mode' } satisfies MailError);
      }
      // Acceptance, not completion: the sync outcome surfaces later via status.
      account.syncState = 'syncing';
      account.syncError = null;
      notify();
      // Macrotask boundary so the syncing state is observable between acceptance
      // and completion (core reports the same transitions through status).
      setTimeout(() => {
        if (failSync) {
          account.syncState = 'error';
          account.syncError = failSync;
          failSync = null;
        } else {
          account.syncState = 'idle';
          account.lastSyncedAt = now();
          account.initialSyncComplete = true;
          cacheCleared = false;
        }
        notify();
      }, 0);
      return Promise.resolve();
    },
  };

  return client;
}

/** Labelled export used by the preview shell so the UI can disclose memory-only mode. */
export function createBrowserPreviewMailClient(): BrowserFake {
  return createBrowserFakeMailClient();
}
