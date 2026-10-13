/**
 * Browser-only in-memory fake MailClient (Slices 01 + 02 preview + tests).
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
 * Slice 02: the fake also models the account lifecycle so the UI's Gmail states can
 * be tested deterministically. `mode: 'gmail'` here is still labelled synthetic
 * in-memory data — never a real OAuth flow, never real mail. In Gmail mode the fake
 * enforces the read-only contract (archive commands are rejected `read_only`), and
 * `disconnect` clears the simulated cache the way core must.
 */
import type {
  AccountStatus,
  Address,
  ConnectionState,
  Conversation,
  ConversationRef,
  ConversationSummary,
  InboxSnapshot,
  MailClient,
  MailError,
  MailMode,
  Message,
  OperationFailure,
  OperationReceipt,
  OperationStatus,
  OperationSummary,
  SetArchived,
  SyncState,
} from './client';

export const BROWSER_PREVIEW_DISCLOSURE =
  'Browser preview: in-memory fake client. Nothing is durable and the native core is not connected.';

export interface FakeBehavior {
  /** Next N archive commands end in provider failure (alternating kinds not modeled). */
  failNext: number;
  /** Failure kind used when failing. */
  failureKind: 'provider_unavailable' | 'provider_rejected';
  /** When true, operations stay in `queued`/`applying` until `releaseHold()`. */
  hold: boolean;
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
}

interface InternalOperation {
  id: string;
  conversationId: string;
  requestedArchived: boolean;
  messageIds: string[];
  status: OperationStatus;
  failure: OperationFailure | null;
}

const iso = (minutesOffset: number): string =>
  new Date(Date.UTC(2025, 0, 6, 9, 0, 0) + minutesOffset * 60_000).toISOString();

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
): SeedMessage {
  return { id, from, to, sentAt: iso(minutesOffset), bodyText, seededInInbox };
}

const SAFE_SENDER = addr('Ada Fixture', 'ada@example.test');
const HOSTILE_SENDER = addr('<script>alert("sender")</script>', 'hostile@example.test');
const ME = addr('You', 'you@example.test');

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
        msg(`${id}-m3`, from, [ME], base + 60, `Latest message in ${id}.\n${body}`),
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
  return {
    ref: conv.ref,
    subject: conv.subject,
    participants: unique,
    preview: last.bodyText.replace(/\s+/g, ' ').slice(0, 120),
    lastMessageAt: last.sentAt,
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
    if (op.status === 'failed') continue;
    const targets = op.messageIds;
    for (let i = 0; i < conv.messages.length; i += 1) {
      const m = conv.messages[i];
      if (m && targets.includes(m.id)) flags[i] = op.requestedArchived ? false : true;
    }
  }
  return flags;
}

function pendingOperationId(conv: FakeConversation): string | null {
  for (let i = conv.ops.length - 1; i >= 0; i -= 1) {
    const op = conv.ops[i];
    if (op && (op.status === 'queued' || op.status === 'applying')) return op.id;
  }
  return null;
}

function toOperationSummary(op: InternalOperation, accountId: string): OperationSummary {
  return {
    id: op.id,
    conversation: { accountId, conversationId: op.conversationId },
    requestedArchived: op.requestedArchived,
    status: op.status,
    failure: op.failure,
  };
}

export function createBrowserFakeMailClient(now: () => string = () => new Date().toISOString()): BrowserFake {
  const conversations = seedConversations();
  const listeners = new Set<() => void>();
  const receiptsByRequest = new Map<string, { fingerprint: string; receipt: OperationReceipt }>();
  const behavior: FakeBehavior = { failNext: 0, failureKind: 'provider_rejected', hold: false };

  let opCounter = 0;
  let inFlight = 0;
  let holdReleased = false;
  const holdWaiters: Array<() => void> = [];

  // Slice 02 account simulation. Fixture mode is the default so the Slice 01 preview
  // and its tests keep working unchanged.
  const account: FakeAccountState = {
    mode: 'fixture',
    connection: 'connected',
    emailAddress: 'fixture@example.test',
    syncState: 'idle',
    lastSyncedAt: null,
    syncError: null,
    cachedConversations: CONVERSATION_COUNT,
    initialSyncComplete: true,
    coverageLimit: 0,
  };
  // Core clears local cache data on disconnect; the fake mirrors that with a flag.
  let cacheCleared = false;
  let heldStatusCalls = 0;
  const statusHoldWaiters: Array<() => void> = [];
  let failStatus: MailError | null = null;
  let failConnect: MailError | null = null;
  let failDisconnect: MailError | null = null;
  let failSync: MailError | null = null;

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

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
        error: account.syncError,
        cachedConversations: cached,
        initialSyncComplete: account.initialSyncComplete,
        coverageLimit: account.coverageLimit,
      },
    };
  }

  const byId = (conversationId: string): FakeConversation | undefined =>
    conversations.find((c) => c.ref.conversationId === conversationId);

  function snapshot(): InboxSnapshot {
    // No account / cleared cache means no cached mail; core would return the same.
    const empty =
      cacheCleared ||
      (account.mode === 'gmail' && (account.connection === 'not_configured' || account.connection === 'disconnected'));
    const activity = empty
      ? []
      : conversations
          .flatMap((c) => c.ops.map((op) => toOperationSummary(op, c.ref.accountId)))
          .sort((a, b) => a.id.localeCompare(b.id));
    const rows = empty
      ? []
      : conversations
          .map((c) => ({ c, flags: effectiveInInbox(c) }))
          .filter((entry) => entry.flags.some((f) => f))
          .map((entry) => summarize(entry.c, pendingOperationId(entry.c)))
          .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    return { conversations: rows, activity };
  }

  function failNotShown(): MailError {
    return { kind: 'not_found' };
  }

  async function runOperation(op: InternalOperation): Promise<void> {
    inFlight += 1;
    try {
      // queued -> applying (worker claims in acceptance order; fake uses FIFO)
      op.status = 'applying';
      notify();
      if (behavior.hold && !holdReleased) {
        await new Promise<void>((resolve) => holdWaiters.push(resolve));
      }
      // ArchiveProvider call happens outside any "transaction" in core; here it is
      // just an async boundary so state transitions are observable.
      await Promise.resolve();
      if (behavior.failNext > 0) {
        behavior.failNext -= 1;
        op.status = 'failed';
        op.failure = { kind: behavior.failureKind };
        notify();
        return;
      }
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
          if (behavior.hold) return; // held work cannot finish until release()
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      },
      release(): void {
        holdReleased = true;
        while (holdWaiters.length > 0) {
          const w = holdWaiters.shift();
          w?.();
        }
      },
      activity(): OperationSummary[] {
        return conversations
          .flatMap((c) => c.ops.map((op) => toOperationSummary(op, c.ref.accountId)))
          .sort((a, b) => a.id.localeCompare(b.id));
      },
      listenerCount(): number {
        return listeners.size;
      },
      accountState(): Readonly<FakeAccountState> {
        return { ...account };
      },
      setAccount(patch: Partial<FakeAccountState>): void {
        Object.assign(account, patch);
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
      const result: Conversation = {
        ref: conv.ref,
        subject: conv.subject,
        messages,
        isInInbox: flags.some((f) => f),
        pendingOperationId: pendingOperationId(conv),
      };
      if (conv.unsupportedReason !== undefined) result.unsupportedReason = conv.unsupportedReason;
      if (conv.contextComplete !== undefined) result.contextComplete = conv.contextComplete;
      return result;
    },

    async setArchived(command: SetArchived): Promise<OperationReceipt> {
      // Gmail is read-only; the Rust side enforces this too. The fake mirrors the
      // contract so UI guard tests can rely on a typed rejection.
      if (account.mode === 'gmail') throw { kind: 'read_only' } satisfies MailError;
      const conv = byId(command.conversation.conversationId);
      if (!conv || conv.ref.accountId !== command.conversation.accountId) throw failNotShown();

      // Request-ID semantics: identical repeat returns the same receipt; a different
      // payload under the same request ID is a conflict.
      const fingerprint = JSON.stringify([
        command.conversation.accountId,
        command.conversation.conversationId,
        command.archived,
      ]);
      const existing = receiptsByRequest.get(command.requestId);
      if (existing) {
        if (existing.fingerprint === fingerprint) return existing.receipt;
        throw { kind: 'request_id_conflict' } satisfies MailError;
      }

      opCounter += 1;
      const operationId = `op-${String(opCounter).padStart(4, '0')}`;
      const receipt: OperationReceipt = { operationId, acceptedAt: now() };
      receiptsByRequest.set(command.requestId, { fingerprint, receipt });

      const op: InternalOperation = {
        id: operationId,
        conversationId: conv.ref.conversationId,
        requestedArchived: command.archived,
        // Core snapshots currently observed message IDs in the same transaction as the
        // operation insert; the fake mirrors that by snapshotting membership now.
        messageIds: conv.messages.map((m) => m.id),
        status: 'queued',
        failure: null,
      };
      conv.ops.push(op);
      notify();

      void runOperation(op).then(() => notify());
      return receipt;
    },

    async subscribe(listener: () => void): Promise<() => void> {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
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
      // Core resolves only after credential deletion and local account/cache clearing.
      account.connection = 'disconnected';
      account.emailAddress = null;
      account.syncState = 'idle';
      account.syncError = null;
      account.lastSyncedAt = null;
      account.initialSyncComplete = false;
      cacheCleared = true;
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
