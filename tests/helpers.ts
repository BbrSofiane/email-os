import { createBrowserFakeMailClient, type BrowserFake, type FakeAccountState } from '../src/lib/ipc/browser-fake';
import type { ConversationRef, InboxSnapshot, MailClient, SetArchived } from '../src/lib/ipc/client';

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
  const client: MailClient = {
    ...accountMethods(inner),
    listConversations: () => {
      list += 1;
      return inner.listConversations();
    },
    getConversation: (ref) => inner.getConversation(ref),
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
    subscribe: (listener) => inner.subscribe(listener),
    enableMailboxActions: () => inner.enableMailboxActions(),
    cancelMailboxActionUpgrade: () => inner.cancelMailboxActionUpgrade(),
  };
  return { client, commands, readCommands, retryCommands, listCalls: () => list };
}

/**
 * Supplies the Slice 02 account-lifecycle methods for hand-written partial clients
 * in tests; spread into a literal so the full MailClient shape stays satisfied.
 */
export function accountMethods(
  inner: MailClient,
): Pick<MailClient, 'getAccountStatus' | 'connectAccount' | 'disconnectAccount' | 'requestSync' | 'enableMailboxActions' | 'cancelMailboxActionUpgrade' | 'setRead' | 'retryOperation'> {
  return {
    getAccountStatus: () => inner.getAccountStatus(),
    connectAccount: () => inner.connectAccount(),
    disconnectAccount: () => inner.disconnectAccount(),
    requestSync: () => inner.requestSync(),
    enableMailboxActions: () => inner.enableMailboxActions(),
    cancelMailboxActionUpgrade: () => inner.cancelMailboxActionUpgrade(),
    setRead: (command) => inner.setRead(command),
    retryOperation: (command) => inner.retryOperation(command),
  };
}

export function fixtureRef(conversationId: string): ConversationRef {
  return { accountId: 'fixture-account', conversationId };
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
