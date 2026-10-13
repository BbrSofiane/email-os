import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import type { ConversationRef, InboxSnapshot, MailClient, OperationReceipt } from '../src/lib/ipc/client';
import { accountMethods, countingClient, createBrowserFakeMailClient, deferred, fixtureRef, flushMacrotasks } from './helpers';

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
      ...accountMethods(inner),
      listConversations: () => {
        order.push('list');
        return inner.listConversations();
      },
      getAccountStatus: () => {
        order.push('status');
        return inner.getAccountStatus();
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
    // Subscription-before-read still holds: events are registered before ANY read.
    expect(order).toEqual(['subscribe', 'status', 'list']);
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
      ...accountMethods(inner),
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
      ...accountMethods(inner),
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
      ...accountMethods(inner),
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

  it('refuses archive commands until account status is known', async () => {
    const inner = createBrowserFakeMailClient();
    const status = deferred<Awaited<ReturnType<MailClient['getAccountStatus']>>>();
    let archiveCalls = 0;
    const client: MailClient = {
      ...accountMethods(inner),
      getAccountStatus: () => status.promise,
      listConversations: () => inner.listConversations(),
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: async (command) => {
        archiveCalls += 1;
        return inner.setArchived(command);
      },
      subscribe: (listener) => inner.subscribe(listener),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    expect(await result.setArchived(fixtureRef('conv-01'), true)).toBeNull();
    expect(result.lastCommandError.value).toEqual({ kind: 'invalid_request', field: 'accountStatus' });
    expect(archiveCalls).toBe(0);
    status.resolve(await inner.getAccountStatus());
    await result.ready;
    expect(await result.setArchived(fixtureRef('conv-01'), true)).not.toBeNull();
    expect(archiveCalls).toBe(1);
    stop();
  });

  it('surfaces a subscription failure as an error state instead of loading forever', async () => {
    const inner = createBrowserFakeMailClient();
    const client: MailClient = {
      ...accountMethods(inner),
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

describe('useMailbox (Slice 02 account status and lifecycle)', () => {
  it('loads account status and gates visibly on a status failure', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.failNextStatus({ kind: 'storage_unavailable' });
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    expect(result.accountState.value).toBe('error');
    expect(result.accountError.value).toEqual({ kind: 'storage_unavailable' });
    expect(result.mode.value).toBeNull(); // fail closed: mode unknown, no fixture fallback

    await result.refresh(); // the failure was consumed; the refetch succeeds
    expect(result.accountState.value).toBe('ready');
    expect(result.mode.value).toBe('fixture');
    stop();
  });

  it('guards stale status responses (older status never clobbers newer)', async () => {
    const inner = createBrowserFakeMailClient();
    const stale = deferred<Awaited<ReturnType<MailClient['getAccountStatus']>>>();
    let call = 0;
    const client: MailClient = {
      ...inner,
      getAccountStatus: () => {
        call += 1;
        return call === 1 ? stale.promise : inner.getAccountStatus();
      },
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    const p1 = result.refresh(); // status call 1 (stale, held)
    const p2 = result.refresh(); // status call 2 (fresh)
    await p2;
    // A status claiming gmail while core says fixture must never win.
    stale.resolve({
      mode: 'gmail',
      connection: 'connected',
      account: { accountId: 'gmail-account', emailAddress: 'attacker@example.test' },
      sync: {
        state: 'idle', lastSyncedAt: null, error: null,
        cachedConversations: 0, initialSyncComplete: true, coverageLimit: 0,
      },
    });
    await p1;
    expect(result.accountStatus.value?.mode).toBe('fixture');
    stop();
  });

  it('refetches status on window focus, reconnect, and change events', async () => {
    const inner = createBrowserFakeMailClient();
    let statusCalls = 0;
    const client: MailClient = {
      ...inner,
      getAccountStatus: () => {
        statusCalls += 1;
        return inner.getAccountStatus();
      },
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    const afterInitial = statusCalls;

    window.dispatchEvent(new Event('focus'));
    await vi.waitFor(() => expect(statusCalls).toBeGreaterThan(afterInitial));
    const afterFocus = statusCalls;

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(statusCalls).toBeGreaterThan(afterFocus));
    const afterOnline = statusCalls;

    await inner.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-ev' });
    await inner.controls.flush();
    await vi.waitFor(() => expect(statusCalls).toBeGreaterThan(afterOnline));
    stop();
  });

  it('refuses archive commands in gmail mode without touching the transport', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    const counted = countingClient(inner);
    const { result, stop } = scopeRun(() => useMailbox(counted.client));
    await result.ready;
    expect(result.isGmail.value).toBe(true);

    const receipt = await result.setArchived(fixtureRef('conv-01'), true);
    await result.archiveSelected();
    expect(receipt).toBeNull();
    expect(counted.commands).toHaveLength(0); // no mutation ever reached the transport
    expect(result.lastCommandError.value).toEqual({ kind: 'read_only' });
    stop();
  });

  it('connectAccount refetches status and surfaces typed failures', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.setAccount({ mode: 'gmail', connection: 'disconnected', emailAddress: null });
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    expect(result.accountStatus.value?.connection).toBe('disconnected');

    inner.controls.failNextConnect({ kind: 'auth_cancelled' });
    await result.connectAccount();
    // The optimistic authenticating flip was corrected by the status refetch.
    expect(result.accountStatus.value?.connection).toBe('disconnected');
    expect(result.lastCommandError.value).toEqual({ kind: 'auth_cancelled' });

    await result.connectAccount();
    expect(result.accountStatus.value?.connection).toBe('connected');
    expect(result.accountStatus.value?.account?.emailAddress).toBe('operator@example.test');
    stop();
  });

  it('disconnect clears the list and reader and drops stale in-flight responses', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    let deferNextList = false;
    let deferNextDetail = false;
    const staleList = deferred<InboxSnapshot>();
    const staleDetail = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    const client: MailClient = {
      ...inner,
      listConversations: () => {
        if (deferNextList) {
          deferNextList = false;
          return staleList.promise;
        }
        return inner.listConversations();
      },
      getConversation: (ref) => {
        if (deferNextDetail) {
          deferNextDetail = false;
          return staleDetail.promise;
        }
        return inner.getConversation(ref);
      },
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    await result.openConversationByRef(fixtureRef('conv-01'));
    expect(result.conversation.value).not.toBeNull();

    // One deferred list + one deferred detail response are left in flight when the
    // disconnect lands; both are stale afterwards and must never repopulate the UI.
    deferNextList = true;
    deferNextDetail = true;
    const background = result.refresh();
    await flushMacrotasks(1);

    const disconnecting = result.disconnectAccount();
    await disconnecting;
    expect(result.openRef.value).toBeNull();
    expect(result.conversation.value).toBeNull();
    expect(result.conversations.value).toEqual([]);
    expect(result.accountStatus.value?.connection).toBe('disconnected');

    // The stale responses arrive after the disconnect; they must not repopulate.
    staleList.resolve(await inner.listConversations());
    staleDetail.resolve(await inner.getConversation(fixtureRef('conv-01')));
    await background;
    await flushMacrotasks(2);
    expect(result.conversations.value).toEqual([]);
    expect(result.conversation.value).toBeNull();
    stop();
  });

  it('requestSync accepts without inventing a sync result', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    await result.requestSync();
    // Acceptance only; the authoritative outcome arrives through status refetches.
    await vi.waitFor(() => expect(result.accountStatus.value?.sync.state).toBe('idle'));
    expect(result.accountBusy.value).toBeNull();
    stop();
  });
});
