import { createBrowserFakeMailClient, type BrowserFake, type FakeAccountState } from '../src/lib/ipc/browser-fake';
import type { ConversationRef, InboxSnapshot, MailClient, SetArchived } from '../src/lib/ipc/client';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { afterEach } from 'vitest';

/** Build a keydown event with caller-supplied flags. This function does not dispatch it. */
export function createKeyEvent(key: string, init: KeyboardEventInit & { keyCode?: number } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, ...init });
  if (init.keyCode !== undefined) Object.defineProperty(event, 'keyCode', { get: () => init.keyCode });
  return event;
}

/**
 * Dispatch a keydown event. The default target is document.activeElement ?? document.body.
 * Pass window or a specific element as the third argument when the test needs that target.
 * Event flags are not inferred; pass bubbles, cancelable, and other options explicitly.
 */
export function press(key: string, init: KeyboardEventInit & { keyCode?: number } = {}, target: EventTarget = document.activeElement ?? document.body): KeyboardEvent {
  const event = createKeyEvent(key, init);
  target.dispatchEvent(event);
  return event;
}

const mountedApps = new Set<VueWrapper>();
afterEach(() => {
  for (const wrapper of mountedApps) {
    if (wrapper.exists()) wrapper.unmount();
  }
  mountedApps.clear();
});

/** Mount App with the requested client and mode. Preserve all other Vue Test Utils options. */
export function mountApp(
  client: MailClient,
  mode: 'native' | 'browser-preview',
  options: Omit<NonNullable<Parameters<typeof mount>[1]>, 'props'> & { attachTo?: Element | string; props?: Record<string, unknown> } = {},
): VueWrapper {
  const { props = {}, ...mountOptions } = options;
  const wrapper = mount(App, { ...mountOptions, props: { ...props, client, mode } }) as VueWrapper;
  mountedApps.add(wrapper);
  return wrapper;
}

/** Drain pending promise continuations and Vue updates. */
export async function flushVuePromises(): Promise<void> { await flushPromises(); }

/** Drain promise continuations, one 0ms macrotask, then promise/Vue work it schedules. */
export async function flushVueAndMacrotask(): Promise<void> {
  await flushPromises();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await flushPromises();
}

/** Flush Vue promise work, fake-client queues, then Vue work triggered by the fake. */
export async function flushFakeClientAndVueUpdates(fake: BrowserFake): Promise<void> {
  await flushPromises();
  await fake.controls.flush();
  await flushPromises();
}

/** Switches the labelled fake into a synthetic Gmail mode for UI tests. */
export function useGmailMode(fake: BrowserFake, patch: Partial<FakeAccountState> = {}): void {
  fake.controls.setAccount({
    mode: 'gmail',
    connection: 'connected',
    emailAddress: 'operator@example.test',
    cachedConversations: 18,
    initialSyncComplete: true,
    coverageLimit: 100,
    ...patch,
  });
}

export function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function flushMacrotasks(times = 5): Promise<void> {
  let p = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    p = p.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  }
  return p;
}

export interface CountingClient {
  client: MailClient;
  commands: SetArchived[];
  readCommands: import('../src/lib/ipc/client').SetRead[];
  retryCommands: import('../src/lib/ipc/client').RetryOperation[];
  listCalls(): number;
}

/** Wraps a client to count list calls (covers event/focus/online-driven refetches). */
export function countingClient(inner: MailClient): CountingClient {
  let list = 0;
  const commands: SetArchived[] = [];
  const readCommands: import('../src/lib/ipc/client').SetRead[] = [];
  const retryCommands: import('../src/lib/ipc/client').RetryOperation[] = [];
  const client = decorateClient(inner, {
    listConversations: () => {
      list += 1;
      return inner.listConversations();
    },
    setArchived: (command) => {
      commands.push(command);
      return inner.setArchived(command);
    },
    setRead: (command) => {
      readCommands.push(command);
      return inner.setRead(command);
    },
    retryOperation: (command) => {
      retryCommands.push(command);
      return inner.retryOperation(command);
    },
  });
  return { client, commands, readCommands, retryCommands, listCalls: () => list };
}

/**
 * Supplies the Slice 02 account-lifecycle methods for hand-written partial clients
 * in tests; spread into a literal so the full MailClient shape stays satisfied.
 */
export function accountMethods(
  inner: MailClient,
): Pick<MailClient, 'listAttachments' | 'saveAttachment' | 'cancelAttachment' | 'openExternalLink' | 'getSavedSplit' | 'saveSavedSplit' | 'searchMail' | 'cancelSearchMail' | 'listProviderDestinations' | 'browseProviderDestination' | 'listCachedTrash' | 'listCachedDone' | 'getAccountStatus' | 'connectAccount' | 'disconnectAccount' | 'requestSync' | 'enableMailboxActions' | 'cancelMailboxActionUpgrade' | 'setRead' | 'retryOperation' | 'undoOperation' | 'listDrafts' | 'getDraft' | 'createDraft' | 'saveDraft' | 'deleteDraft' | 'subscribeDrafts' | 'subscribeAppClose' | 'completeAppClose' | 'cancelAppClose' | 'reminders'> {
  return delegateMethods(inner, ['listAttachments', 'saveAttachment', 'cancelAttachment', 'openExternalLink', 'getSavedSplit', 'saveSavedSplit', 'searchMail', 'cancelSearchMail', 'listProviderDestinations', 'browseProviderDestination', 'listCachedTrash', 'listCachedDone', 'getAccountStatus', 'connectAccount', 'disconnectAccount', 'requestSync', 'enableMailboxActions', 'cancelMailboxActionUpgrade', 'setRead', 'retryOperation', 'undoOperation', 'listDrafts', 'getDraft', 'createDraft', 'saveDraft', 'deleteDraft', 'subscribeDrafts', 'subscribeAppClose', 'completeAppClose', 'cancelAppClose']);
}

export function fixtureRef(conversationId: string): ConversationRef {
  return { accountId: 'fixture-account', conversationId };
}

/** Delegates the five UX-05 group methods to a full client (e.g. the fake). */
export function groupMethods(
  inner: MailClient,
): Pick<MailClient, 'listCachedStarred' | 'setStarred' | 'setStarredGroup' | 'setArchivedGroup' | 'setReadGroup' | 'getOperationGroup' | 'listOperationGroups' | 'undoOperationGroup' | 'reminders'> {
  return delegateMethods(inner, ['listCachedStarred', 'setStarred', 'setStarredGroup', 'setArchivedGroup', 'setReadGroup', 'getOperationGroup', 'listOperationGroups', 'undoOperationGroup']);
}

type DelegatedClientMethods<K extends keyof MailClient> = Pick<MailClient, K | 'reminders'>;

function delegateMethods<K extends keyof MailClient>(inner: MailClient, methods: readonly K[]): DelegatedClientMethods<K> {
  const delegated: Partial<MailClient> = { reminders: inner.reminders };
  for (const method of methods) {
    const value = inner[method];
    if (typeof value === 'function') {
      // Bind to the source client so method implementations that use `this` keep working.
      (delegated as Record<keyof MailClient, unknown>)[method] = value.bind(inner);
    }
  }
  return delegated as DelegatedClientMethods<K>;
}

/** Decorate a client without changing its shape or optional capabilities. */
function decorateClient(inner: MailClient, overrides: Partial<MailClient>): MailClient {
  return new Proxy(inner, {
    get(target, property) {
      if (Object.prototype.hasOwnProperty.call(overrides, property)) {
        return Reflect.get(overrides, property);
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

/**
 * UX-05 group seam stub for hand-written partial clients that do not exercise
 * groups: queries resolve empty, mutations reject (never fake success).
 */
export function groupStub(): Pick<MailClient, 'listCachedStarred' | 'setStarred' | 'setStarredGroup' | 'setArchivedGroup' | 'setReadGroup' | 'getOperationGroup' | 'listOperationGroups' | 'undoOperationGroup'> {
  return {
    listCachedStarred: () => Promise.reject({ kind:'read_only' }),
    setStarred: () => Promise.reject({kind:'read_only'}),
    setStarredGroup: () => Promise.reject({kind:'read_only'}),
    setArchivedGroup: () => Promise.reject({ kind: 'invalid_request', field: 'members' }),
    setReadGroup: () => Promise.reject({ kind: 'invalid_request', field: 'members' }),
    getOperationGroup: () => Promise.resolve(null),
    listOperationGroups: () => Promise.resolve({ groups: [], nextCursor: null }),
    undoOperationGroup: () => Promise.reject({ kind: 'undo_unavailable', reason: 'not_applicable' }),
  };
}

export function inboxIds(snap: InboxSnapshot): string[] {
  return snap.conversations.map((c) => c.ref.conversationId);
}

export async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor: condition not met');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export { createBrowserFakeMailClient };
export type { BrowserFake };

/** Conversation rows use ordinary listitem semantics; focus is not selection. */
export function conversationRows(wrapper: VueWrapper): ReturnType<VueWrapper['findAll']> {
  return wrapper.findAll('[role="listitem"]');
}

/** The row currently marked as the focused conversation, if any. */
export function focusedRow(wrapper: VueWrapper): ReturnType<VueWrapper['find']> {
  return wrapper.find('[aria-current="true"]');
}

/** Utility surfaces live in explicit disclosures; tests open them explicitly. */
export async function openUtilityDrawer(
  wrapper: VueWrapper,
  name: 'account' | 'activity' | 'drafts',
): Promise<void> {
  await wrapper.find(`[data-test="rail-${name}"]`).trigger('click');
  await flushPromises();
}

export async function closeUtilityDrawer(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-test="drawer-close"]').trigger('click');
  await flushPromises();
}

/** Clicks a conversation row by id (reference-targeted open, not an index). */
export async function clickRow(wrapper: VueWrapper, conversationId: string): Promise<void> {
  await wrapper.find(`[data-test="conversation-row-${conversationId}"]`).trigger('click');
  await flushPromises();
}

// ---------------------------------------------------------------------------
// Six-conversation synthetic client (UX-01 journey)
// ---------------------------------------------------------------------------

const SIX_NOW = '2026-01-15T12:00:00Z';

interface SixConversation {
  ref: ConversationRef;
  subject: string;
  preview: string;
  lastMessageAt: string;
  /** Backend-derived newest-From; omitted when the stack has no usable sender. */
  primaryCorrespondent?: { displayName: string | null; mailbox: string };
  isRead?: boolean;
  body: string;
}

/**
 * Deterministic six-conversation MailClient for the UX-01 browsing journey:
 * long names, mixed/unknown read state, missing contact fields, date groups,
 * and a self-authored latest message. List mutations notify subscribers like
 * the browser fake so background refreshes are exercised.
 */
export interface SixConversationClient {
  client: MailClient;
  /** Newer-row insertion at the top of the inbox (BROWSE-17). */
  insertNewerConversation(id: string, primaryCorrespondent?: { displayName: string | null; mailbox: string }): void;
  commands: SetArchived[];
  readCommands: import('../src/lib/ipc/client').SetRead[];
  failNextList(error: import('../src/lib/ipc/client').MailError): void;
}

export function createSixConversationClient(): SixConversationClient {
  const accountId = 'six-account';
  const refOf = (id: string): ConversationRef => ({ accountId, conversationId: id });
  const conversations: SixConversation[] = [
    {
      ref: refOf('six-f'),
      subject: 'Self-authored latest',
      preview: 'I sent the last message myself.',
      lastMessageAt: '2026-01-15T11:00:00Z',
      primaryCorrespondent: { displayName: 'You', mailbox: 'you@example.test' },
      body: 'Self-authored thread body.',
    },
    {
      ref: refOf('six-a'),
      subject: 'Long sender name thread',
      preview: 'Today body.',
      lastMessageAt: '2026-01-15T09:00:00Z',
      primaryCorrespondent: {
        displayName: 'Anastasia Vasquez-Romanov of the Northern Reaches',
        mailbox: 'anastasia@example.test',
      },
      isRead: false,
      body: 'Today body.',
    },
    {
      ref: refOf('six-b'),
      subject: 'Nameless sender',
      preview: 'Yesterday body.',
      lastMessageAt: '2026-01-14T18:00:00Z',
      primaryCorrespondent: { displayName: null, mailbox: 'anon@example.test' },
      isRead: true,
      body: 'Yesterday body.',
    },
    {
      ref: refOf('six-c'),
      subject: 'Unknown read state',
      preview: 'No contact fields at all.',
      lastMessageAt: '2026-01-02T10:00:00Z',
      body: 'No contact fields at all.',
    },
    {
      ref: refOf('six-d'),
      subject: 'December thread',
      preview: 'Older body.',
      lastMessageAt: '2025-12-20T10:00:00Z',
      primaryCorrespondent: { displayName: "Devon O'Brien", mailbox: 'devon@example.test' },
      isRead: false,
      body: 'Older body.',
    },
    {
      ref: refOf('six-e'),
      subject: 'June thread',
      preview: 'Oldest body.',
      lastMessageAt: '2025-06-10T10:00:00Z',
      isRead: true,
      body: 'Oldest body.',
    },
  ];
  const inbox = conversations.map((c) => c.ref.conversationId);
  const commands: SetArchived[] = [];
  const readCommands: import('../src/lib/ipc/client').SetRead[] = [];
  const listeners = new Set<() => void>();
  let listFailure: import('../src/lib/ipc/client').MailError | null = null;
  let operationCounter = 0;

  const summaryOf = (conversation: SixConversation): InboxSnapshot['conversations'][number] => {
    const sender = conversation.primaryCorrespondent ?? { displayName: 'Someone', mailbox: 'someone@example.test' };
    const summary: InboxSnapshot['conversations'][number] = {
      ref: { ...conversation.ref },
      subject: conversation.subject,
      participants: [{ ...sender }],
      preview: conversation.preview,
      lastMessageAt: conversation.lastMessageAt,
      pendingOperationId: null,
    };
    if (conversation.primaryCorrespondent) summary.primaryCorrespondent = { ...conversation.primaryCorrespondent };
    if (conversation.isRead !== undefined) summary.isRead = conversation.isRead;
    return summary;
  };

  const detailOf = (conversation: SixConversation): import('../src/lib/ipc/client').Conversation => {
    const detail: import('../src/lib/ipc/client').Conversation = {
      ref: { ...conversation.ref },
      subject: conversation.subject,
      messages: [{
        id: `${conversation.ref.conversationId}-m1`,
        from: conversation.primaryCorrespondent
          ? { ...conversation.primaryCorrespondent }
          : { displayName: 'Someone', mailbox: 'someone@example.test' },
        to: [{ displayName: 'You', mailbox: 'you@example.test' }],
        sentAt: conversation.lastMessageAt,
        bodyText: conversation.body,
      }],
      isInInbox: inbox.includes(conversation.ref.conversationId),
      pendingOperationId: null,
    };
    if (conversation.isRead !== undefined) detail.isRead = conversation.isRead;
    return detail;
  };

  const notify = (): void => { listeners.forEach((listener) => listener()); };

  const client: MailClient = {
    getSavedSplit: async () => null,
    saveSavedSplit: async () => { throw { kind: 'storage_unavailable' }; },
    listProviderDestinations: () => Promise.reject({ kind: 'read_only' }),
    browseProviderDestination: () => Promise.reject({ kind: 'read_only' }),
    ...groupStub(),
    searchMail: async () => ({ conversations: [], nextCursor: null, coverage: 'cached_incomplete' }),
    cancelSearchMail: async () => {},
    listCachedTrash: async () => { throw { kind: 'read_only' }; },
    listAttachments: async () => [],
    saveAttachment: async () => { throw { kind: 'not_found' }; },
    cancelAttachment: async () => {},
    openExternalLink: async () => { throw { kind: 'provider_unavailable' }; },
    listCachedDone: async () => ({ conversations: conversations.filter((c) => !inbox.includes(c.ref.conversationId)).map(summaryOf), nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: SIX_NOW }),
    listConversations: () => {
      if (listFailure) {
        const error = listFailure;
        listFailure = null;
        return Promise.reject(error);
      }
      const rows = conversations
        .filter((c) => inbox.includes(c.ref.conversationId))
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt))
        .map(summaryOf);
      return Promise.resolve({ conversations: rows, activity: [] });
    },
    getConversation: (target) => {
      const conversation = conversations.find((c) => c.ref.conversationId === target.conversationId);
      if (!conversation) return Promise.reject({ kind: 'not_found' });
      return Promise.resolve(detailOf(conversation));
    },
    setArchived: (command) => {
      commands.push(command);
      const index = inbox.indexOf(command.conversation.conversationId);
      if (index >= 0 && command.archived) inbox.splice(index, 1);
      if (index < 0 && !command.archived) inbox.push(command.conversation.conversationId);
      operationCounter += 1;
      notify();
      return Promise.resolve({ operationId: `six-op-${operationCounter}`, acceptedAt: SIX_NOW });
    },
    setRead: (command) => {
      readCommands.push(command);
      const conversation = conversations.find((c) => c.ref.conversationId === command.conversation.conversationId);
      if (conversation) conversation.isRead = command.read;
      notify();
      return Promise.resolve({ operationId: `six-read-${readCommands.length}`, acceptedAt: SIX_NOW });
    },
    retryOperation: () => Promise.reject({ kind: 'invalid_request', field: 'mode' }),
    undoOperation: () => Promise.reject({ kind: 'not_found' }),
    enableMailboxActions: () => Promise.resolve(),
    cancelMailboxActionUpgrade: () => Promise.resolve(),
    subscribe: (listener) => {
      listeners.add(listener);
      return Promise.resolve(() => { listeners.delete(listener); });
    },
    getAccountStatus: () => Promise.resolve({
      mode: 'fixture',
      connection: 'connected',
      account: { accountId, emailAddress: 'six@example.test' },
      sync: { state: 'idle', lastSyncedAt: SIX_NOW, error: null, cachedConversations: 6, initialSyncComplete: true, coverageLimit: 0 },
    }),
    connectAccount: () => Promise.resolve(),
    disconnectAccount: () => Promise.resolve(),
    requestSync: () => Promise.resolve(),
    listDrafts: () => Promise.resolve([]),
    getDraft: () => Promise.reject({ kind: 'not_found' }),
    createDraft: (command) => Promise.resolve({
      ref: { accountId, draftId: `six-draft-${command.requestId}` },
      revision: 1,
      savedAt: SIX_NOW,
    }),
    saveDraft: (command) => Promise.resolve({ ref: command.ref, revision: command.expectedRevision + 1, savedAt: SIX_NOW }),
    deleteDraft: (command) => Promise.resolve({ ref: command.ref, revision: command.expectedRevision, deletedAt: SIX_NOW }),
    subscribeDrafts: () => Promise.resolve(() => undefined),
    subscribeAppClose: () => Promise.resolve(() => undefined),
    completeAppClose: () => Promise.resolve(),
    cancelAppClose: () => Promise.resolve(),
  };

  return {
    client,
    commands,
    readCommands,
    insertNewerConversation: (id, primaryCorrespondent) => {
      conversations.unshift({
        ref: refOf(id),
        subject: `Newer: ${id}`,
        preview: 'Newly arrived.',
        lastMessageAt: '2026-01-15T12:00:00Z',
        primaryCorrespondent,
        body: 'Newly arrived body.',
      });
      inbox.push(id);
      notify();
    },
    failNextList: (error) => { listFailure = error; },
  };
}
