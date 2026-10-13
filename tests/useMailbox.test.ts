import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import type { ConversationRef, InboxSnapshot, MailClient, OperationReceipt } from '../src/lib/ipc/client';
import { countingClient, createBrowserFakeMailClient, deferred, fixtureRef } from './helpers';

function scopeRun<T>(fn: () => T): { result: T; stop: () => void } {
  const scope = effectScope();
  const result = scope.run(fn) as T;
  return { result, stop: () => scope.stop() };
}

describe('useMailbox', () => {
  it('subscribes before the initial read', async () => {
    const order: string[] = [];
    const inner = createBrowserFakeMailClient();
    const client: MailClient = {
      listConversations: () => {
        order.push('list');
        return inner.listConversations();
      },
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: (c) => inner.setArchived(c),
      subscribe: (listener) => {
        order.push('subscribe');
        return inner.subscribe(listener);
      },
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    expect(order).toEqual(['subscribe', 'list']);
    expect(result.conversations.value).toHaveLength(18);
    stop();
  });

  it('refetches on subscription event, window focus, and reconnect', async () => {
    const inner = createBrowserFakeMailClient();
    const counted = countingClient(inner);
    const { result, stop } = scopeRun(() => useMailbox(counted.client));
    await result.ready;
    const afterInitial = counted.listCalls();

    // subscription event
    await inner.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-ev' });
    await inner.controls.flush();
    await vi.waitFor(() => {
      expect(result.conversations.value.some((c) => c.ref.conversationId === 'conv-01')).toBe(false);
    });
    expect(counted.listCalls()).toBeGreaterThan(afterInitial);
    const afterEvent = counted.listCalls();

    // window focus
    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(counted.listCalls()).toBeGreaterThan(afterEvent));
    const afterFocus = counted.listCalls();

    // reconnect
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(counted.listCalls()).toBeGreaterThan(afterFocus));
    stop();
  });

  it('guards out-of-order list responses (older snapshot never clobbers newer)', async () => {
    const older: InboxSnapshot = { conversations: [], activity: [] };
    const inner = createBrowserFakeMailClient();
    const d1 = deferred<InboxSnapshot>();
    const d2 = deferred<InboxSnapshot>();
    let call = 0;
    const client: MailClient = {
      listConversations: () => {
        call += 1;
        return call === 1 ? d1.promise : d2.promise;
      },
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: (c) => inner.setArchived(c),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    const p1 = result.refresh();
    const p2 = result.refresh();
    d2.resolve((await inner.listConversations()) as InboxSnapshot); // newer resolves first
    d1.resolve(older); // stale, must be ignored
    await Promise.all([p1, p2]);
    expect(result.conversations.value).toHaveLength(18);
    expect(result.listState.value).toBe('ready');
    stop();
  });

  it('guards out-of-order detail responses (stale conversation never wins)', async () => {
    const inner = createBrowserFakeMailClient();
    const d1 = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    let call = 0;
    const client: MailClient = {
      listConversations: () => inner.listConversations(),
      getConversation: (ref: ConversationRef) => {
        call += 1;
        return call === 1 ? d1.promise : inner.getConversation(ref);
      },
      setArchived: (c) => inner.setArchived(c),
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;

    const p1 = result.openConversationByRef(fixtureRef('conv-01'));
    const p2 = result.openConversationByRef(fixtureRef('conv-02'));
    await p2;
    expect(result.conversation.value?.ref.conversationId).toBe('conv-02');
    d1.resolve(await inner.getConversation(fixtureRef('conv-01'))); // stale, must be ignored
    await p1;
    expect(result.conversation.value?.ref.conversationId).toBe('conv-02');
    stop();
  });

  it('shows loading/error detail states and surfaces command errors', async () => {
    const inner = createBrowserFakeMailClient();
    const client: MailClient = {
      listConversations: () => inner.listConversations(),
      getConversation: (ref) =>
        ref.conversationId === 'conv-01'
          ? Promise.reject({ kind: 'storage_unavailable' })
          : inner.getConversation(ref),
      setArchived: () => Promise.reject({ kind: 'request_id_conflict' }),
      subscribe: (l) => inner.subscribe(l),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.openConversationByRef(fixtureRef('conv-01'));
    expect(result.detailState.value).toBe('error');
    expect(result.detailError.value).toEqual({ kind: 'storage_unavailable' });

    const receipt: OperationReceipt | null = await result.setArchived(fixtureRef('conv-02'), true);
    expect(receipt).toBeNull();
    expect(result.lastCommandError.value).toEqual({ kind: 'request_id_conflict' });
    stop();
  });

  it('issues a fresh request ID for every explicit user action', async () => {
    const inner = createBrowserFakeMailClient();
    const counted = countingClient(inner);
    const { result, stop } = scopeRun(() => useMailbox(counted.client));
    await result.ready;
    await result.setArchived(fixtureRef('conv-01'), true);
    await result.setArchived(fixtureRef('conv-01'), false);
    expect(counted.commands).toHaveLength(2);
    expect(counted.commands[0]?.requestId).not.toBe(counted.commands[1]?.requestId);
    stop();
  });

  it('surfaces a subscription failure as an error state instead of loading forever', async () => {
    const inner = createBrowserFakeMailClient();
    const client: MailClient = {
      listConversations: () => inner.listConversations(),
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: (c) => inner.setArchived(c),
      subscribe: () => Promise.reject({ kind: 'storage_unavailable' }),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready.catch(() => undefined);
    expect(result.listState.value).toBe('error');
    expect(result.listError.value).toEqual({ kind: 'storage_unavailable' });
    stop();
  });

  it.each(['confirm', 'reject'] as const)('refreshes the open reader after delayed provider %s', async (outcome) => {
    const inner = createBrowserFakeMailClient();
    inner.controls.behavior.hold = true;
    if (outcome === 'reject') inner.controls.behavior.failNext = 1;
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    await result.openConversationByRef(fixtureRef('conv-01'));
    await result.setArchived(fixtureRef('conv-01'), true);
    expect(result.conversation.value?.pendingOperationId).not.toBeNull();
    inner.controls.release();
    await vi.waitFor(() => {
      expect(result.conversation.value?.pendingOperationId).toBeNull();
      expect(result.conversation.value?.isInInbox).toBe(outcome === 'reject');
    });
    stop();
  });

  it('clears old content while a different reader is loading', async () => {
    const inner = createBrowserFakeMailClient();
    const next = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    const client: MailClient = {
      ...inner,
      getConversation: (target) => target.conversationId === 'conv-02' ? next.promise : inner.getConversation(target),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.openConversationByRef(fixtureRef('conv-01'));
    const loading = result.openConversationByRef(fixtureRef('conv-02'));
    expect(result.detailState.value).toBe('loading');
    expect(result.conversation.value).toBeNull();
    result.closeReader();
    next.resolve(await inner.getConversation(fixtureRef('conv-02')));
    await loading;
    expect(result.openRef.value).toBeNull();
    expect(result.conversation.value).toBeNull();
    stop();
  });

  it('preserves the selected identity when a rejected archive restores an earlier row', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.behavior.hold = true;
    inner.controls.behavior.failNext = 1;
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    await result.archiveSelected();
    expect(result.selectedSummary.value?.ref.conversationId).toBe('conv-02');
    inner.controls.release();
    await vi.waitFor(() => expect(result.conversations.value).toHaveLength(18));
    expect(result.selectedSummary.value?.ref.conversationId).toBe('conv-02');
    expect(result.selectedIndex.value).toBe(1);
    stop();
  });

  it('retries subscriptions before recovering from a subscribe failure', async () => {
    const inner = createBrowserFakeMailClient();
    let broken = true;
    let attempts = 0;
    const client: MailClient = {
      ...inner,
      subscribe: (listener) => {
        attempts += 1;
        return broken ? Promise.reject({ kind: 'storage_unavailable' }) : inner.subscribe(listener);
      },
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.refresh();
    expect(result.listState.value).toBe('error');
    expect(inner.controls.listenerCount()).toBe(0);
    broken = false;
    await Promise.all([result.refresh(), result.refresh()]);
    expect(attempts).toBe(3);
    expect(inner.controls.listenerCount()).toBe(1);
    expect(result.listState.value).toBe('ready');
    stop();
    expect(inner.controls.listenerCount()).toBe(0);
  });

  it('does not reopen a closed reader when a background refresh finishes', async () => {
    const inner = createBrowserFakeMailClient();
    const response = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    let deferDetail = false;
    const client: MailClient = { ...inner, getConversation: (target) => deferDetail ? response.promise : inner.getConversation(target) };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.openConversationByRef(fixtureRef('conv-01'));
    deferDetail = true;
    const refreshing = result.refresh();
    await Promise.resolve();
    result.closeReader();
    response.resolve(await inner.getConversation(fixtureRef('conv-01')));
    await refreshing;
    expect(result.openRef.value).toBeNull();
    expect(result.conversation.value).toBeNull();
    stop();
  });

  it('detaches subscriptions and window listeners on scope disposal', async () => {
    const inner = createBrowserFakeMailClient();
    const counted = countingClient(inner);
    const { result, stop } = scopeRun(() => useMailbox(counted.client));
    await result.ready;
    expect(inner.controls.listenerCount()).toBe(1);
    const callsAtRest = counted.listCalls();
    stop();
    expect(inner.controls.listenerCount()).toBe(0);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(counted.listCalls()).toBe(callsAtRest);
  });
});
