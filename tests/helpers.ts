import { createBrowserFakeMailClient, type BrowserFake } from '../src/lib/ipc/browser-fake';
import type { ConversationRef, InboxSnapshot, MailClient, SetArchived } from '../src/lib/ipc/client';

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
  listCalls(): number;
}

/** Wraps a client to count list calls (covers event/focus/online-driven refetches). */
export function countingClient(inner: MailClient): CountingClient {
  let list = 0;
  const commands: SetArchived[] = [];
  const client: MailClient = {
    listConversations: () => {
      list += 1;
      return inner.listConversations();
    },
    getConversation: (ref) => inner.getConversation(ref),
    setArchived: (command) => {
      commands.push(command);
      return inner.setArchived(command);
    },
    subscribe: (listener) => inner.subscribe(listener),
  };
  return { client, commands, listCalls: () => list };
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
