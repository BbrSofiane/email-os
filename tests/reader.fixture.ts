/**
 * Synthetic three-message reader fixture (UX-02). Browser- and Vitest-importable.
 *
 * Deliberately independent of Vitest/@vue/test-utils runtime imports: the same
 * module can be loaded through Vite by the real-Chrome rendered tests and by
 * jsdom component tests. Only the typed MailClient seam is used.
 *
 * Scenario (matches the UX-02 E2E checkpoint): one conversation with three
 * ordered messages — an old message from a named participant, a middle message
 * with hostile literal markup from a nameless sender, and a newest message with
 * a long body and valid latest-source reply context — plus several Inbox
 * neighbors and duplicate Activity references to the same conversation.
 *
 * This is explicitly synthetic, in-memory, labelled test data. It never
 * represents real mail, native IPC, or provider behavior.
 */
import type {
  AccountStatus,
  Address,
  Conversation,
  ConversationRef,
  CreateDraft,
  DeleteDraft,
  Draft,
  DraftContent,
  DraftDeleteReceipt,
  DraftReceipt,
  DraftReplyLink,
  InboxSnapshot,
  MailClient,
  MailError,
  Message,
  OperationSummary,
  SaveDraft,
  SetArchived,
  SetRead,
} from '../src/lib/ipc/client';

export const READER_ACCOUNT_ID = 'reader-account';
export const READ_NOW = '2026-02-02T12:00:00Z';
const ACCOUNT_EMAIL = 'reader@example.test';

export function readerRef(conversationId: string): ConversationRef {
  return { accountId: READER_ACCOUNT_ID, conversationId };
}

const ME: Address = { displayName: 'You', mailbox: 'you@example.test' };
const NAMED_SENDER: Address = { displayName: 'Ada Fixture', mailbox: 'ada@example.test' };
const NAMELESS_SENDER: Address = { displayName: null, mailbox: 'anon@example.test' };
const MIDDLE_RECIPIENT: Address = { displayName: 'Ravi Longname', mailbox: 'ravi@example.test' };

const HOSTILE_BODY = [
  'Middle message: plain text only.',
  '<script>alert("body")</script>',
  '<img src=x onerror=alert(1)> subject with <b>markup</b>',
  'No remote assets, no HTML execution.',
].join('\n');

const LONG_BODY = [
  'Newest message: this body is intentionally long so the reader scroller',
  'must scroll independently of the rail, header, and persistent toolbar.',
  ...Array.from({ length: 40 }, (_, index) => `Paragraph ${index + 1}: still plain, still literal text.`),
  'The final paragraph sits at the bottom of the long body.',
].join('\n');

interface StoredConversation {
  ref: ConversationRef;
  subject: string;
  messages: Message[];
  replyContext?: Conversation['replyContext'];
  contextComplete?: boolean;
  retainedSnapshotAt?: string;
  unsupportedReason?: string;
  isRead?: boolean;
}

/** Newest-first Inbox order (backend order is authoritative). */
const INBOX_ORDER = ['read-01', 'read-02', 'read-03', 'read-04'];

function baseConversations(): Map<string, StoredConversation> {
  const conversations = new Map<string, StoredConversation>();
  conversations.set('read-01', {
    ref: readerRef('read-01'),
    subject: 'Reader journey thread',
    messages: [
      {
        id: 'read-01-m1',
        from: NAMED_SENDER,
        to: [ME, MIDDLE_RECIPIENT],
        sentAt: '2026-02-02T09:00:00Z',
        bodyText: 'Oldest message: short body.',
      },
      {
        id: 'read-01-m2',
        from: NAMELESS_SENDER,
        to: [ME],
        sentAt: '2026-02-02T10:00:00Z',
        bodyText: HOSTILE_BODY,
      },
      {
        id: 'read-01-m3',
        from: NAMED_SENDER,
        to: [ME],
        sentAt: '2026-02-02T11:00:00Z',
        bodyText: LONG_BODY,
      },
    ],
    replyContext: {
      sourceMessageId: 'read-01-m3',
      fromMailbox: 'ada@example.test',
      replyToMailboxes: null,
      messageId: '<read-01-m3@mail.test>',
      references: ['<read-01-m1@mail.test>', '<read-01-m2@mail.test>', '<read-01-m3@mail.test>'],
    },
    isRead: false,
  });
  for (const id of ['read-02', 'read-03', 'read-04']) {
    conversations.set(id, {
      ref: readerRef(id),
      subject: `Neighbor thread ${id}`,
      messages: [
        {
          id: `${id}-m1`,
          from: NAMED_SENDER,
          to: [ME],
          sentAt: '2026-02-01T09:00:00Z',
          bodyText: `Neighbor body for ${id}.`,
        },
      ],
      // Trustworthy per-thread threading metadata so reply-capable neighbors
      // derive their own draft defaults and reply links (P2-09).
      replyContext: {
        sourceMessageId: `${id}-m1`,
        fromMailbox: NAMED_SENDER.mailbox,
        replyToMailboxes: null,
        messageId: `<${id}-m1@mail.test>`,
        references: [`<${id}-m1@mail.test>`],
      },
      isRead: true,
    });
  }
  return conversations;
}

/** Duplicate Activity references to the same conversation (J/K must ignore both). */
function duplicateActivity(): OperationSummary[] {
  return [
    {
      id: 'read-op-1',
      conversation: readerRef('read-02'),
      requestedArchived: true,
      status: 'confirmed',
      failure: null,
      kind: 'archive',
    },
    {
      id: 'read-op-2',
      conversation: readerRef('read-02'),
      requestedArchived: true,
      status: 'confirmed',
      failure: null,
      kind: 'archive',
    },
  ];
}

// ---------------------------------------------------------------------------
// Reply default derivation (P2-09 source fidelity)
//
// Bounded fixture form of the mail-core `prepare_reply` semantics
// (crates/mail-core/src/drafts/store.rs, docs/vertical-slice-04.md) — NOT a
// mail-core/RFC parser reimplementation. Fail-closed on anything unavailable
// or ambiguous; canonical structured fixture metadata only.
// ---------------------------------------------------------------------------

const MAX_REPLY_TO_RECIPIENTS = 20;
const MAX_REPLY_REFERENCES = 100;

/** Bounded single-mailbox sanity check (canonical string, no controls/space). */
function validMailbox(value: string): boolean {
  return value.length > 0 && value.length <= 254 && !/[\s\x00-\x1f\x7f]/.test(value);
}

/** Bounded `<id@domain>` Message-ID token check (no controls/whitespace). */
function validMessageId(value: string): boolean {
  return /^<[^<>\s\x00-\x1f\x7f]+@[^<>\s\x00-\x1f\x7f]+>$/.test(value);
}

function deriveReplyDefaults(
  conversation: StoredConversation,
  sourceId: string,
): { content: DraftContent; replyLink: DraftReplyLink } | null {
  const latest = conversation.messages[conversation.messages.length - 1] ?? null;
  const context = conversation.replyContext ?? null;
  if (!latest || latest.id !== sourceId) return null;
  if (conversation.contextComplete === false || conversation.retainedSnapshotAt) return null;
  // Replies to the account's own message are unsupported (Slice04).
  if (!latest.from.mailbox || latest.from.mailbox.toLowerCase() === ACCOUNT_EMAIL.toLowerCase()) return null;
  if (!context || context.sourceMessageId !== sourceId) return null;
  if (!validMailbox(context.fromMailbox)) return null;
  // Absent Reply-To uses the context From mailbox; present-but-empty fails
  // closed (never falls back); present valid Reply-To wins.
  let rawTargets: string[];
  if (context.replyToMailboxes === null) {
    rawTargets = [context.fromMailbox];
  } else if (context.replyToMailboxes.length === 0 || context.replyToMailboxes.length > MAX_REPLY_TO_RECIPIENTS) {
    return null;
  } else {
    rawTargets = [];
    for (const value of context.replyToMailboxes) {
      if (!validMailbox(value)) return null;
      rawTargets.push(value);
    }
  }
  // Exclude the account self and deduplicate case-insensitively, keeping the
  // first spelling; if nothing remains, deny.
  const targets: string[] = [];
  for (const mailbox of rawTargets) {
    if (mailbox.toLowerCase() === ACCOUNT_EMAIL.toLowerCase()) continue;
    if (!targets.some((prior) => prior.toLowerCase() === mailbox.toLowerCase())) targets.push(mailbox);
  }
  if (targets.length === 0) return null;
  if (!validMessageId(context.messageId)) return null;
  if (context.references.length > MAX_REPLY_REFERENCES) return null;
  // Ancestor references drop source Message-ID occurrences; the source ID is
  // appended exactly once at the end.
  const references: string[] = [];
  for (const reference of context.references) {
    if (!validMessageId(reference)) return null;
    if (reference !== context.messageId) references.push(reference);
  }
  references.push(context.messageId);
  if (references.length > MAX_REPLY_REFERENCES) return null;
  return {
    content: {
      to: targets.join(', '),
      cc: '',
      subject: /^re:/i.test(conversation.subject) ? conversation.subject : `Re: ${conversation.subject}`,
      bodyText: '',
    },
    replyLink: {
      conversation: readerRef(conversation.ref.conversationId),
      sourceMessageId: sourceId,
      messageId: context.messageId,
      references,
    },
  };
}

function toDetail(conversation: StoredConversation, inboxIds: string[]): Conversation {
  const detail: Conversation = {
    ref: { ...conversation.ref },
    subject: conversation.subject,
    messages: conversation.messages.map((message) => ({
      id: message.id,
      from: { ...message.from },
      to: message.to.map((address) => ({ ...address })),
      sentAt: message.sentAt,
      bodyText: message.bodyText,
    })),
    isInInbox: inboxIds.includes(conversation.ref.conversationId),
    pendingOperationId: null,
  };
  if (conversation.replyContext) detail.replyContext = JSON.parse(JSON.stringify(conversation.replyContext));
  if (conversation.contextComplete !== undefined) detail.contextComplete = conversation.contextComplete;
  if (conversation.retainedSnapshotAt !== undefined) detail.retainedSnapshotAt = conversation.retainedSnapshotAt;
  if (conversation.unsupportedReason !== undefined) detail.unsupportedReason = conversation.unsupportedReason;
  if (conversation.isRead !== undefined) detail.isRead = conversation.isRead;
  return detail;
}

function toSummary(conversation: StoredConversation, inboxIds: string[]): InboxSnapshot['conversations'][number] {
  const last = conversation.messages[conversation.messages.length - 1];
  if (!last) throw new Error(`reader fixture conversation ${conversation.ref.conversationId} has no messages`);
  const summary: InboxSnapshot['conversations'][number] = {
    ref: { ...conversation.ref },
    subject: conversation.subject,
    participants: [{ ...last.from }, ...last.to.map((address) => ({ ...address }))],
    primaryCorrespondent: { ...last.from },
    preview: last.bodyText.replace(/\s+/g, ' ').slice(0, 120),
    lastMessageAt: last.sentAt,
    pendingOperationId: null,
  };
  if (conversation.isRead !== undefined) summary.isRead = conversation.isRead;
  void inboxIds;
  return summary;
}

export interface ReaderFixture {
  client: MailClient;
  controls: {
    /** Background snapshot replacement of a conversation (same identity by default). */
    replaceDetail(conversationId: string, patch?: Partial<Conversation>): void;
    /** Removes a message from the stored detail and notifies. */
    removeMessage(conversationId: string, messageId: string): void;
    /** Reorders the Inbox list (backend order change) and notifies. */
    reorderInbox(conversationIds: string[]): void;
    /** Removes a conversation from the Inbox list and notifies. */
    removeFromInbox(conversationId: string): void;
    /** Delays the next N getConversation responses. */
    delayNextDetail(ms: number, count?: number): void;
    /** Fails the next getConversation response. */
    failNextDetail(error: MailError): void;
    /** Emits a mailbox_changed event like the real subscription. */
    notify(): void;
    /** Call/command logs for no-unintended-write assertions. */
    detailCalls: ConversationRef[];
    archiveCommands: SetArchived[];
    readCommands: SetRead[];
    draftCreations: CreateDraft[];
  };
}

export function createReaderFixtureClient(): ReaderFixture {
  const conversations = baseConversations();
  let inboxIds = [...INBOX_ORDER];
  const listeners = new Set<() => void>();
  const detailCalls: ConversationRef[] = [];
  const archiveCommands: SetArchived[] = [];
  const readCommands: SetRead[] = [];
  const draftCreations: CreateDraft[] = [];
  let detailDelayMs = 0;
  let delayedDetailCount = 0;
  let nextDetailFailure: MailError | null = null;
  let draftCounter = 0;
  /** Locally stored drafts, mirroring core's local draft store for get_draft. */
  const draftsStore = new Map<string, Draft>();

  const notify = (): void => { listeners.forEach((listener) => listener()); };

  const respond = <T>(value: T): Promise<T> => {
    if (detailDelayMs > 0) {
      const ms = detailDelayMs;
      delayedDetailCount -= 1;
      if (delayedDetailCount <= 0) detailDelayMs = 0;
      return new Promise<T>((resolve) => { setTimeout(() => resolve(value), ms); });
    }
    return Promise.resolve(value);
  };

  const client: MailClient = {
    listCachedDone: async () => ({ conversations: [...conversations.values()].filter((c) => !inboxIds.includes(c.ref.conversationId) && archiveCommands.some((command) => command.archived && command.conversation.conversationId === c.ref.conversationId)).map((c) => toSummary(c, inboxIds)), nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: READ_NOW }),
    listConversations: () => {
      const rows = inboxIds
        .map((id) => conversations.get(id))
        .filter((conversation): conversation is StoredConversation => conversation !== undefined)
        .map((conversation) => toSummary(conversation, inboxIds));
      return Promise.resolve({ conversations: rows, activity: duplicateActivity() });
    },
    getConversation: (target) => {
      detailCalls.push({ ...target });
      const conversation = conversations.get(target.conversationId);
      if (!conversation) return Promise.reject({ kind: 'not_found' } satisfies MailError);
      if (nextDetailFailure) {
        const failure = nextDetailFailure;
        nextDetailFailure = null;
        return Promise.reject(failure);
      }
      return respond(toDetail(conversation, inboxIds));
    },
    setArchived: (command) => {
      archiveCommands.push(JSON.parse(JSON.stringify(command)));
      if (command.archived) inboxIds = inboxIds.filter((id) => id !== command.conversation.conversationId);
      else if (!inboxIds.includes(command.conversation.conversationId)) inboxIds = [command.conversation.conversationId, ...inboxIds];
      notify();
      return Promise.resolve({ operationId: `read-op-${archiveCommands.length}`, acceptedAt: READ_NOW });
    },
    setRead: (command) => {
      readCommands.push(JSON.parse(JSON.stringify(command)));
      const conversation = conversations.get(command.conversation.conversationId);
      if (conversation) conversation.isRead = command.read;
      notify();
      return Promise.resolve({ operationId: `read-read-${readCommands.length}`, acceptedAt: READ_NOW });
    },
    retryOperation: () => Promise.reject({ kind: 'invalid_request', field: 'mode' } satisfies MailError),
    undoOperation: () => Promise.reject({ kind: 'not_found' } satisfies MailError),
    enableMailboxActions: () => Promise.resolve(),
    cancelMailboxActionUpgrade: () => Promise.resolve(),
    subscribe: (listener) => {
      listeners.add(listener);
      return Promise.resolve(() => { listeners.delete(listener); });
    },
    getAccountStatus: () => Promise.resolve({
      mode: 'fixture',
      connection: 'connected',
      account: { accountId: READER_ACCOUNT_ID, emailAddress: ACCOUNT_EMAIL },
      sync: { state: 'idle', lastSyncedAt: READ_NOW, error: null, cachedConversations: 4, initialSyncComplete: true, coverageLimit: 0 },
    } satisfies AccountStatus),
    connectAccount: () => Promise.resolve(),
    disconnectAccount: () => Promise.resolve(),
    requestSync: () => Promise.resolve(),
    listDrafts: () => Promise.resolve([...draftsStore.values()].map((draft) => ({
      ref: { ...draft.ref },
      revision: draft.revision,
      updatedAt: draft.updatedAt,
      subject: draft.content.subject,
      to: draft.content.to,
      source: JSON.parse(JSON.stringify(draft.source)),
    }))),
    getDraft: (ref) => {
      const draft = draftsStore.get(ref.draftId);
      if (!draft || draft.ref.accountId !== ref.accountId) return Promise.reject({ kind: 'not_found' } satisfies MailError);
      return Promise.resolve(JSON.parse(JSON.stringify(draft)) as Draft);
    },
    createDraft: async (command) => {
      draftCreations.push(JSON.parse(JSON.stringify(command)));
      let content: DraftContent = command.initialContent
        ? JSON.parse(JSON.stringify(command.initialContent))
        : { to: '', cc: '', subject: '', bodyText: '' };
      let replyLink: DraftReplyLink | null = null;
      if (command.source.kind === 'reply') {
        // Reply defaults are source-derived, never fabricated: the requested
        // account/conversation/latest-source must match stored state and the
        // conversation must expose trustworthy threading metadata (P2-09),
        // with Reply-To/From/self/dedup and reference semantics mirroring
        // mail-core's prepare_reply (fail-closed, no silent fabrication).
        if (command.initialContent !== null) throw { kind: 'invalid_request', field: 'initialContent' } satisfies MailError;
        if (command.source.conversation.accountId !== READER_ACCOUNT_ID) throw { kind: 'reply_unavailable' } satisfies MailError;
        const conversation = conversations.get(command.source.conversation.conversationId);
        const derived = conversation ? deriveReplyDefaults(conversation, command.source.sourceMessageId) : null;
        if (!derived) throw { kind: 'reply_unavailable' } satisfies MailError;
        content = derived.content;
        replyLink = derived.replyLink;
      }
      draftCounter += 1;
      const draft: Draft = {
        ref: { accountId: READER_ACCOUNT_ID, draftId: `read-draft-${draftCounter}` },
        revision: 1,
        createdAt: READ_NOW,
        updatedAt: READ_NOW,
        content,
        source: JSON.parse(JSON.stringify(command.source)),
        replyLink,
      };
      draftsStore.set(draft.ref.draftId, JSON.parse(JSON.stringify(draft)) as Draft);
      return Promise.resolve({ ref: draft.ref, revision: 1, savedAt: READ_NOW } satisfies DraftReceipt);
    },
    saveDraft: (command: SaveDraft) => {
      const draft = draftsStore.get(command.ref.draftId);
      if (draft) {
        draft.content = JSON.parse(JSON.stringify(command.content));
        draft.revision = command.expectedRevision + 1;
        draft.updatedAt = READ_NOW;
      }
      return Promise.resolve({ ref: command.ref, revision: command.expectedRevision + 1, savedAt: READ_NOW });
    },
    deleteDraft: (command: DeleteDraft) => {
      draftsStore.delete(command.ref.draftId);
      return Promise.resolve({ ref: command.ref, deletedAt: READ_NOW } satisfies DraftDeleteReceipt);
    },
    subscribeDrafts: () => Promise.resolve(() => undefined),
    subscribeAppClose: () => Promise.resolve(() => undefined),
    completeAppClose: (_requestId: string) => Promise.resolve(),
    cancelAppClose: (_requestId: string) => Promise.resolve(),
  };

  return {
    client,
    controls: {
      replaceDetail: (conversationId, patch) => {
        const conversation = conversations.get(conversationId);
        if (!conversation) return;
        // Same identity, fresh object: mimics a background snapshot replacement.
        conversations.set(conversationId, { ...conversation, ...patch });
        notify();
      },
      removeMessage: (conversationId, messageId) => {
        const conversation = conversations.get(conversationId);
        if (!conversation) return;
        conversation.messages = conversation.messages.filter((message) => message.id !== messageId);
        notify();
      },
      reorderInbox: (nextOrder) => { inboxIds = [...nextOrder]; notify(); },
      removeFromInbox: (conversationId) => {
        inboxIds = inboxIds.filter((id) => id !== conversationId);
        notify();
      },
      delayNextDetail: (ms, count = 1) => { detailDelayMs = ms; delayedDetailCount = count; },
      failNextDetail: (error) => { nextDetailFailure = error; },
      notify,
      detailCalls,
      archiveCommands,
      readCommands,
      draftCreations,
    },
  };
}

/** Retained/incomplete snapshot helpers for the unchanged-guard regressions. */
export function markRetained(savedAt: string): Partial<Conversation> {
  return { retainedSnapshotAt: savedAt };
}

export function markIncomplete(): Partial<Conversation> {
  return { contextComplete: false };
}

export function markUnsupported(reason: string): Partial<Conversation> {
  return { unsupportedReason: reason };
}
