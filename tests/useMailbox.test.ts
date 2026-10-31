import { describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import type { ConversationRef, InboxSnapshot, MailClient, OperationReceipt } from '../src/lib/ipc/client';
import { accountMethods, countingClient, createBrowserFakeMailClient, deferred, fixtureRef, flushMacrotasks } from './helpers';
import { sameConversation } from '../src/composables/useMailbox';

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

  it('refreshes an older accepted receipt without clearing a newer command error', async () => {
    const inner = createBrowserFakeMailClient();
    const receiptGate = deferred<OperationReceipt>();
    let accepted: OperationReceipt | undefined;
    let archiveCalls = 0;
    let listCalls = 0;
    const client: MailClient = {
      ...accountMethods(inner),
      listConversations: async () => {
        listCalls += 1;
        return inner.listConversations();
      },
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: async (command) => {
        archiveCalls += 1;
        if (archiveCalls === 1) {
          accepted = await inner.setArchived(command);
          return receiptGate.promise;
        }
        throw { kind: 'request_id_conflict' };
      },
      // Deliberately omit event delivery: a successful receipt must refetch.
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    const initialListCalls = listCalls;

    const acceptedAction = result.setArchived(fixtureRef('conv-01'), true);
    await vi.waitFor(() => {
      if (accepted === undefined) throw new Error('first command receipt is delayed');
    });
    await inner.controls.flush();
    expect(result.activity.value).toHaveLength(0);
    expect(listCalls).toBe(initialListCalls);

    expect(await result.setArchived(fixtureRef('conv-02'), true)).toBeNull();
    expect(result.lastCommandError.value).toEqual({ kind: 'request_id_conflict' });
    const receipt = accepted;
    if (!receipt) throw new Error('expected accepted first receipt');
    receiptGate.resolve(receipt);
    await acceptedAction;

    expect(listCalls).toBeGreaterThan(initialListCalls);
    expect(result.conversations.value.some((row) => row.ref.conversationId === 'conv-01')).toBe(false);
    expect(result.activity.value.some((op) => op.id === receipt.operationId)).toBe(true);
    expect(result.lastCommandError.value).toEqual({ kind: 'request_id_conflict' });
    stop();
  });

  it('clears invalidated command guards on successful disconnect and keeps late receipts from clearing newer guards', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.setAccount({
      mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled',
    });
    const firstReceiptGate = deferred<OperationReceipt>();
    const secondReceiptGate = deferred<OperationReceipt>();
    let firstReceipt: OperationReceipt | undefined;
    let secondReceipt: OperationReceipt | undefined;
    let archiveCalls = 0;
    let listCalls = 0;
    const client: MailClient = {
      ...accountMethods(inner),
      listConversations: async () => {
        listCalls += 1;
        return inner.listConversations();
      },
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: async (command) => {
        archiveCalls += 1;
        const receipt = await inner.setArchived(command);
        if (archiveCalls === 1) {
          firstReceipt = receipt;
          return firstReceiptGate.promise;
        }
        if (archiveCalls === 2) {
          secondReceipt = receipt;
          return secondReceiptGate.promise;
        }
        return receipt;
      },
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    const firstAction = result.setArchived({ accountId: 'gmail-account', conversationId: 'conv-01' }, true);
    await vi.waitFor(() => {
      if (firstReceipt === undefined) throw new Error('first command receipt is delayed');
    });
    await inner.controls.flush();
    expect(result.inFlightCommandRef.value).toEqual({ accountId: 'gmail-account', conversationId: 'conv-01' });

    // A rejected local disconnect keeps the current session's action guard.
    inner.controls.failNextDisconnect({ kind: 'storage_unavailable' });
    await result.disconnectAccount();
    expect(result.inFlightCommandRef.value).toEqual({ accountId: 'gmail-account', conversationId: 'conv-01' });
    expect(result.accountStatus.value?.connection).toBe('connected');

    await result.disconnectAccount();
    expect(result.inFlightCommandRef.value).toBeNull();
    expect(result.conversations.value).toHaveLength(0);
    expect(result.activity.value).toHaveLength(0);

    // Reconnect and explicitly restore capability, then start a new reader action.
    await result.connectAccount();
    await result.enableMailboxActions();
    await vi.waitFor(() => expect(result.accountStatus.value?.mutationAccess).toBe('enabled'));
    await result.openConversationByRef({ accountId: 'gmail-account', conversationId: 'conv-02' });
    expect(result.conversation.value?.ref.conversationId).toBe('conv-02');
    const secondAction = result.setArchived({ accountId: 'gmail-account', conversationId: 'conv-02' }, true);
    await vi.waitFor(() => {
      if (secondReceipt === undefined) throw new Error('second command receipt is delayed');
    });
    expect(result.inFlightCommandRef.value).toEqual({ accountId: 'gmail-account', conversationId: 'conv-02' });
    const callsBeforeOldReceipt = listCalls;

    const oldReceipt = firstReceipt;
    if (!oldReceipt) throw new Error('expected first accepted receipt');
    firstReceiptGate.resolve(oldReceipt);
    await firstAction;
    expect(listCalls).toBe(callsBeforeOldReceipt);
    expect(result.inFlightCommandRef.value).toEqual({ accountId: 'gmail-account', conversationId: 'conv-02' });

    const newReceipt = secondReceipt;
    if (!newReceipt) throw new Error('expected second accepted receipt');
    secondReceiptGate.resolve(newReceipt);
    await secondAction;
    expect(result.inFlightCommandRef.value).toBeNull();
    expect(result.conversation.value?.ref.conversationId).toBe('conv-02');
    expect(await result.setRead({ accountId: 'gmail-account', conversationId: 'conv-02' }, true)).not.toBeNull();
    expect(result.conversation.value?.ref.conversationId).toBe('conv-02');
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

  it('preserves the focused identity when a rejected archive restores an earlier row', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.behavior.hold = true;
    inner.controls.behavior.failNext = 1;
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    await result.archiveFocused();
    expect(result.focusedSummary.value?.ref.conversationId).toBe('conv-02');
    inner.controls.release();
    await vi.waitFor(() => expect(result.conversations.value).toHaveLength(18));
    expect(result.focusedSummary.value?.ref.conversationId).toBe('conv-02');
    expect(result.focusedRef.value).toEqual(fixtureRef('conv-02'));
    stop();
  });

  it('keeps the focused reference when a newer row is inserted above it (BROWSE-17)', async () => {
    const inner = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    result.focusConversation(fixtureRef('conv-03'));
    expect(result.focusedSummary.value?.ref.conversationId).toBe('conv-03');
    // A brand-new conversation arrives and becomes the newest row.
    inner.controls.addMessage('conv-01');
    await vi.waitFor(() => expect(result.conversations.value[0]?.ref.conversationId).not.toBe('conv-03'));
    expect(result.focusedRef.value).toEqual(fixtureRef('conv-03'));
    expect(result.focusedSummary.value?.ref.conversationId).toBe('conv-03');
    stop();
  });

  it('resolves focus to the next surviving old row after multiple removals, and clears on the only row', async () => {
    const inner = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    // Remove the first two rows behind the fake's back, then refresh.
    await inner.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'rm-1' });
    await inner.setArchived({ conversation: fixtureRef('conv-02'), archived: true, requestId: 'rm-2' });
    await inner.controls.flush();
    result.focusConversation(fixtureRef('conv-01'));
    await result.refresh();
    expect(result.focusedRef.value).toEqual(fixtureRef('conv-03'));

    // Last row removal falls back to the previous survivor.
    const last = result.conversations.value[result.conversations.value.length - 1]!.ref;
    result.focusConversation(last);
    await inner.setArchived({ conversation: last, archived: true, requestId: 'rm-last' });
    await inner.controls.flush();
    await result.refresh();
    expect(result.conversations.value.some((row) => sameConversation(row.ref, last))).toBe(false);
    expect(result.focusedRef.value).not.toBeNull();
    stop();
  });

  it('clears focus when the list becomes empty and re-focuses the first row on reload', async () => {
    const inner = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    for (const row of result.conversations.value) {
      await inner.setArchived({ conversation: row.ref, archived: true, requestId: `empty-${row.ref.conversationId}` });
    }
    await inner.controls.flush();
    await result.refresh();
    expect(result.conversations.value).toHaveLength(0);
    expect(result.focusedRef.value).toBeNull();

    // A fresh account session reloads a nonempty list and focuses its first row.
    await inner.setArchived({ conversation: fixtureRef('conv-01'), archived: false, requestId: 'restore-1' });
    await inner.controls.flush();
    await result.refresh();
    expect(result.focusedRef.value).toEqual(fixtureRef('conv-01'));
    stop();
  });

  it('keeps focus account-scoped: foreign refs never resolve and disconnect clears it', async () => {
    const inner = createBrowserFakeMailClient();
    inner.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    const { result, stop } = scopeRun(() => useMailbox(inner));
    await result.ready;
    result.focusConversation({ accountId: 'other-account', conversationId: 'conv-01' });
    expect(result.focusedSummary.value).toBeNull();

    result.focusConversation({ accountId: 'gmail-account', conversationId: 'conv-01' });
    expect(result.focusedSummary.value?.ref.conversationId).toBe('conv-01');
    await result.disconnectAccount();
    expect(result.focusedRef.value).toBeNull();
    expect(result.focusedSummary.value).toBeNull();
    stop();
  });

  it('never fetches details or writes read state while focus moves', async () => {
    const inner = createBrowserFakeMailClient();
    let detailCalls = 0;
    let readCalls = 0;
    const client: MailClient = {
      ...inner,
      getConversation: (ref) => {
        detailCalls += 1;
        return inner.getConversation(ref);
      },
      setRead: (command) => {
        readCalls += 1;
        return inner.setRead(command);
      },
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    const before = detailCalls;
    result.focusConversation(fixtureRef('conv-02'));
    result.moveFocus(1);
    result.moveFocus(-1);
    result.moveFocus(1);
    expect(result.focusedRef.value).toEqual(fixtureRef('conv-03'));
    expect(detailCalls).toBe(before);
    expect(readCalls).toBe(0);
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
    await result.archiveFocused();
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
    await result.openConversationByRef({ accountId: 'gmail-account', conversationId: 'conv-01' });
    expect(result.conversation.value).not.toBeNull();

    const originalDetail = await inner.getConversation({ accountId: 'gmail-account', conversationId: 'conv-01' });
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
    staleDetail.resolve(originalDetail);
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

  it('does not record a last action when the account identity changes mid-call', async () => {
    const inner = createBrowserFakeMailClient();
    const gate = deferred<void>();
    // The status wrapper can report a changed account identity independently of
    // the fake's fixed fixture account id.
    let reportedAccount = 'fixture-account';
    let statusCall = 0;
    const client: MailClient = {
      ...accountMethods(inner),
      listConversations: () => inner.listConversations(),
      getConversation: (ref) => inner.getConversation(ref),
      setArchived: (command) => gate.promise.then(() => inner.setArchived(command)),
      getAccountStatus: async () => {
        statusCall += 1;
        const status = await inner.getAccountStatus();
        return status.account && reportedAccount !== status.account.accountId
          ? { ...status, account: { ...status.account, accountId: reportedAccount } }
          : status;
      },
      subscribe: () => Promise.resolve(() => undefined),
    };
    const { result, stop } = scopeRun(() => useMailbox(client));
    await result.ready;
    expect(statusCall).toBe(1);

    const pending = result.setArchived(fixtureRef('conv-01'), true);
    // The account identity changes while the setter round trip is pending; the
    // next status read lands and starts a new mailbox session.
    reportedAccount = 'fixture-account-2';
    await result.refresh();
    gate.resolve();
    await pending;
    // A late receipt from the previous account session must not repopulate the
    // notice with mail that is not in this mailbox.
    expect(result.lastAction.value).toBeNull();
    stop();
  });

  it('clears the last action on superseded when no activity row carries undoableUntil', async () => {
    const fake = createBrowserFakeMailClient();
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    await result.setArchived(fixtureRef('conv-01'), true);
    expect(result.lastAction.value?.receipt.operationId).toBe('op-0001');
    // A newer op is accepted externally and FAILS: it supersedes op-0001 and is
    // itself not undoable, so no row carries undoableUntil after the refresh.
    fake.controls.behavior.failNext = 1;
    await fake.setArchived({ conversation: fixtureRef('conv-02'), archived: true, requestId: 'external' });
    await fake.controls.flush();
    await result.refresh();
    await result.undoLastAction(); // rejected: superseded; the re-point finds nothing
    expect(result.lastAction.value).toBeNull();
    stop();
  });

  it('keeps the slot with a closed window when the backend reports expired', async () => {
    let offsetMs = 0;
    const fake = createBrowserFakeMailClient(() => new Date(Date.now() + offsetMs).toISOString());
    const { result, stop } = scopeRun(() => useMailbox(fake));
    await result.ready;
    await result.setArchived(fixtureRef('conv-01'), true);
    expect(result.lastAction.value?.undoableUntil).not.toBeNull();
    offsetMs = 11_000;
    await result.refresh(); // the refreshed row no longer carries undoableUntil
    await result.undoLastAction();
    const slot = result.lastAction.value;
    expect(slot?.receipt.operationId).toBe('op-0001');
    expect(slot?.undoableUntil).toBeNull();
    expect(slot?.hadWindow).toBe(true);
    stop();
  });
});
