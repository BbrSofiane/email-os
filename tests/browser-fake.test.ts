import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, fixtureRef, flushMacrotasks, inboxIds } from './helpers';

const gmailRef = (conversationId: string) => ({ accountId: 'gmail-account', conversationId });

describe('browser fake MailClient (core-like semantics, memory-only)', () => {
  it('lists only locally evidenced archived mail, paginates and keeps recovery restrictions', async () => {
    const fake = createBrowserFakeMailClient();
    const request = { accountId: 'fixture-account', limit: 1, cursor: null as string | null };
    expect(await fake.listCachedDone(request)).toEqual({ conversations: [], nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: null });
    for (const id of ['conv-01', 'conv-02']) {
      await fake.setArchived({ conversation: fixtureRef(id), archived: true, requestId: `done-${id}` });
    }
    fake.controls.markRetainedSnapshot('conv-01', '2026-01-01T00:00:00Z');
    fake.controls.markUnsupported('conv-01', 'incomplete cached body', false);
    const first = await fake.listCachedDone(request);
    expect(first.conversations.map((c) => c.ref.conversationId)).toEqual(['conv-01']);
    expect(first.nextCursor).not.toBeNull();
    const detail = await fake.getConversation(first.conversations[0]!.ref);
    expect(detail).toMatchObject({ retainedSnapshotAt: '2026-01-01T00:00:00Z', contextComplete: false, unsupportedReason: 'incomplete cached body' });
    expect(detail.replyContext).toBeUndefined();
    request.cursor = first.nextCursor;
    expect((await fake.listCachedDone(request)).conversations.map((c) => c.ref.conversationId)).toEqual(['conv-02']);
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: false, requestId: 'restore' });
    request.cursor = null;
    const sparse = await fake.listCachedDone(request);
    expect(sparse.conversations).toEqual([]);
    expect(sparse.nextCursor).not.toBeNull();
    fake.controls.addMessage('conv-02');
    request.limit = 100;
    expect((await fake.listCachedDone(request)).conversations).toEqual([]);
  });

  it('rejects foreign accounts and malformed/foreign cursors and invalid page bounds', async () => {
    const fake = createBrowserFakeMailClient();
    const request = { accountId: 'fixture-account', limit: 100, cursor: null as string | null };
    await expect(fake.listCachedDone({ ...request, accountId: 'other' })).rejects.toEqual({ kind: 'not_found' });
    for (const limit of [0, 101, 1.5, NaN]) {
      await expect(fake.listCachedDone({ ...request, limit })).rejects.toEqual({ kind: 'invalid_request', field: 'limit' });
    }
    for (const cursor of ['bad', 'cached-done-v1:[]', 'cached-done-v1:["other","date","id"]', 'x'.repeat(8193)]) {
      await expect(fake.listCachedDone({ ...request, cursor })).rejects.toEqual({ kind: 'invalid_request', field: 'cursor' });
    }
  });

  it('excludes definite failures while keeping queued archive intent discoverable', async () => {
    const fake = createBrowserFakeMailClient();
    const request = { accountId: 'fixture-account', limit: 100, cursor: null };
    fake.controls.behavior.failNext = 1;
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'fail' });
    await fake.controls.flush();
    expect((await fake.listCachedDone(request)).conversations).toEqual([]);
    fake.controls.behavior.hold = true;
    await fake.setArchived({ conversation: fixtureRef('conv-02'), archived: true, requestId: 'pending' });
    const pending = await fake.listCachedDone(request);
    expect(pending.conversations[0]?.ref.conversationId).toBe('conv-02');
    expect(pending.conversations[0]?.pendingOperationId).not.toBeNull();
    fake.controls.release();
    await fake.controls.flush();
  });

  it('uses one active synthetic identity across status/list/Done/reader/actions and clears prior-account intent', async () => {
    const fake = createBrowserFakeMailClient();
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'old-account' });
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled' });
    const accountId = (await fake.getAccountStatus()).account!.accountId;
    expect(accountId).toBe('gmail-account');
    const request = { accountId, limit: 100, cursor: null };
    expect((await fake.listCachedDone(request)).conversations).toEqual([]);
    expect((await fake.listConversations()).conversations.every((row) => row.ref.accountId === accountId)).toBe(true);
    await expect(fake.getConversation(fixtureRef('conv-01'))).rejects.toEqual({ kind: 'not_found' });
    await expect(fake.listCachedDone({ ...request, accountId: 'fixture-account' })).rejects.toEqual({ kind: 'not_found' });
    await fake.setArchived({ conversation: gmailRef('conv-01'), archived: true, requestId: 'new-account' });
    const page = await fake.listCachedDone(request);
    expect(page.conversations[0]?.ref).toEqual(gmailRef('conv-01'));
    expect((await fake.getConversation(page.conversations[0]!.ref)).isInInbox).toBe(false);
    expect((await fake.listConversations()).activity.every((op) => op.conversation.accountId === accountId)).toBe(true);
    await fake.disconnectAccount();
    await expect(fake.listCachedDone(request)).rejects.toEqual({ kind: 'not_found' });
    await expect(fake.getConversation(gmailRef('conv-01'))).rejects.toEqual({ kind: 'not_found' });
  });

  it('seeds 18 conversations once, newest first', async () => {
    const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    const snap = await fake.listConversations();
    expect(snap.conversations).toHaveLength(18);
    const ids = inboxIds(snap);
    expect(ids[0]).toBe('conv-01');
    const times = snap.conversations.map((c) => c.lastMessageAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it('derives primaryCorrespondent from the newest message, matching the ordered detail stack', async () => {
    const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    // A self-authored newest message and a nullable display name exercise the
    // backend-derived contract end to end.
    fake.controls.addMessage('conv-01', true, { displayName: 'You', mailbox: 'you@fixture.emailos' });
    fake.controls.addMessage('conv-02', false, { displayName: null, mailbox: 'anon@example.test' });
    const snap = await fake.listConversations();
    for (const row of snap.conversations) {
      const detail = await fake.getConversation(row.ref);
      expect(row.primaryCorrespondent).toEqual(detail.messages[detail.messages.length - 1]!.from);
    }
    const conv01 = snap.conversations.find((c) => c.ref.conversationId === 'conv-01');
    expect(conv01?.primaryCorrespondent).toEqual({ displayName: 'You', mailbox: 'you@fixture.emailos' });
    const conv02 = snap.conversations.find((c) => c.ref.conversationId === 'conv-02');
    expect(conv02?.primaryCorrespondent).toEqual({ displayName: null, mailbox: 'anon@example.test' });
  });

  it('returns the full conversation, including hostile markup as literal text', async () => {
    const fake = createBrowserFakeMailClient();
    const conv = await fake.getConversation(fixtureRef('conv-06'));
    expect(conv.subject).toContain('<img src=x onerror=alert(1)>');
    const last = conv.messages[conv.messages.length - 1];
    expect(last?.bodyText).toContain('<script>alert("body")</script>');
  });

  it('rejects getConversation for unknown conversations', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.getConversation(fixtureRef('conv-99'))).rejects.toEqual({ kind: 'not_found' });
  });

  it('returns a receipt only after the operation is accepted and queued', async () => {
    const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    const receipt = await fake.setArchived({
      conversation: fixtureRef('conv-03'),
      archived: true,
      requestId: 'r1',
    });
    expect(receipt.operationId).toBe('op-0001');
    expect(receipt.acceptedAt).toBe('2025-01-01T00:00:00.000Z');
    const ops = fake.controls.activity();
    expect(ops).toHaveLength(1);
    expect(ops[0]?.status).toBe('confirmed');
    await expect(fake.getConversation(fixtureRef('conv-03'))).resolves.toMatchObject({ isInInbox: false });
  });

  it('dedups identical request IDs and rejects conflicting payloads', async () => {
    const fake = createBrowserFakeMailClient();
    const command = { conversation: fixtureRef('conv-02'), archived: true, requestId: 'same' };
    const receipt = await fake.setArchived(command);
    const again = await fake.setArchived({ ...command });
    expect(again).toEqual(receipt);
    expect(fake.controls.activity()).toHaveLength(1);
    await expect(
      fake.setArchived({ conversation: fixtureRef('conv-02'), archived: false, requestId: 'same' }),
    ).rejects.toEqual({ kind: 'request_id_conflict' });
  });

  it('applies the queued overlay immediately: archived intent removes the row from the inbox', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.hold = true;
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-hold' });
    let snap = await fake.listConversations();
    expect(inboxIds(snap)).not.toContain('conv-01');
    const conv = await fake.getConversation(fixtureRef('conv-01'));
    expect(conv.isInInbox).toBe(false);
    expect(conv.pendingOperationId).toBe('op-0001');
    const summary = snap.conversations.find((c) => c.ref.conversationId === 'conv-02');
    expect(summary?.pendingOperationId).toBeNull();

    fake.controls.release();
    await fake.controls.flush();
    snap = await fake.listConversations();
    expect(inboxIds(snap)).not.toContain('conv-01');
  });

  it('keeps failed operations discoverable in activity and reverts the overlay', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'provider_rejected';
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-fail' });
    await fake.controls.flush();
    const ops = fake.controls.activity();
    expect(ops[0]?.status).toBe('failed');
    expect(ops[0]?.failure).toEqual({ kind: 'provider_rejected' });
    await expect(fake.retryOperation({ operationId: ops[0]!.id, requestId: 'fixture-retry' }))
      .rejects.toEqual({ kind: 'invalid_request', field: 'mode' });
    const snap = await fake.listConversations();
    // overlay reverted: the conversation is back in the inbox
    expect(inboxIds(snap)).toContain('conv-01');
    expect(snap.conversations.find((c) => c.ref.conversationId === 'conv-01')?.pendingOperationId).toBeNull();
  });

  it('unarchive from activity restores the conversation to the inbox', async () => {
    const fake = createBrowserFakeMailClient();
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-a' });
    await fake.controls.flush();
    let snap = await fake.listConversations();
    expect(inboxIds(snap)).not.toContain('conv-01');

    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: false, requestId: 'r-u' });
    await fake.controls.flush();
    snap = await fake.listConversations();
    expect(inboxIds(snap)).toContain('conv-01');
    const ops = fake.controls.activity();
    expect(ops.map((o) => o.requestedArchived)).toEqual([true, false]);
    expect(ops.every((o) => o.status === 'confirmed')).toBe(true);
  });

  it('notifies subscribers on every state transition and detaches cleanly', async () => {
    const fake = createBrowserFakeMailClient();
    const events: number[] = [];
    const unlisten = await fake.subscribe(() => events.push(fake.controls.activity().length));
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-n' });
    await fake.controls.flush();
    // queued + applying + confirmed = at least 3 notifications
    expect(events.length).toBeGreaterThanOrEqual(3);
    expect(fake.controls.listenerCount()).toBe(1);
    unlisten();
    expect(fake.controls.listenerCount()).toBe(0);
  });
});

describe('browser fake MailClient (Slice 02 account lifecycle)', () => {
  it('reports a connected fixture-mode status by default', async () => {
    const fake = createBrowserFakeMailClient();
    const status = await fake.getAccountStatus();
    expect(status.mode).toBe('fixture');
    expect(status.connection).toBe('connected');
    expect(status.account).toEqual({ accountId: 'fixture-account', emailAddress: 'you@fixture.emailos' });
    expect(status.sync).toMatchObject({ state: 'idle', error: null, cachedConversations: 18, initialSyncComplete: true, coverageLimit: 0 });
  });

  it('rejects archive commands with read_only in gmail mode and records no operation', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    await expect(fake.setArchived({ conversation: gmailRef('conv-01'), archived: true, requestId: 'r-g' }))
      .rejects.toEqual({ kind: 'read_only' });
    expect(fake.controls.activity()).toHaveLength(0);
    // Snapshot stays untouched: gmail is read-only end to end.
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
  });

  it('transitions authenticating -> connected on connect and notifies listeners', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'disconnected', emailAddress: null });
    const events: ConnectionState[] = [];
    const unlisten = await fake.subscribe(() => events.push(fake.controls.accountState().connection));
    await fake.connectAccount();
    expect(fake.controls.accountState().connection).toBe('connected');
    expect(events).toContain('authenticating');
    expect(events[events.length - 1]).toBe('connected');
    expect((await fake.getAccountStatus()).account?.emailAddress).toBe('operator@example.test');
    unlisten();
  });

  it('reverts to the prior connection when connect fails', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'disconnected', emailAddress: null });
    fake.controls.failNextConnect({ kind: 'auth_cancelled' });
    await expect(fake.connectAccount()).rejects.toEqual({ kind: 'auth_cancelled' });
    expect(fake.controls.accountState().connection).toBe('disconnected');
  });

  it('disconnect clears the simulated cache and the reported account', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', lastSyncedAt: '2025-01-01T00:00:00.000Z' });
    await fake.disconnectAccount();
    const status = await fake.getAccountStatus();
    expect(status).toMatchObject({ mode: 'gmail', connection: 'disconnected', account: null });
    expect(status.sync).toMatchObject({ cachedConversations: 0, lastSyncedAt: null, initialSyncComplete: false });
    expect(inboxIds(await fake.listConversations())).toEqual([]);
    // In fixture mode the lifecycle commands are refused; core owns the mode.
    const fixtureFake = createBrowserFakeMailClient();
    await expect(fixtureFake.connectAccount()).rejects.toEqual({ kind: 'invalid_request', field: 'mode' });
    await expect(fixtureFake.requestSync()).rejects.toEqual({ kind: 'invalid_request', field: 'mode' });
  });

  it('rejects disconnect when the injected failure fires and keeps state', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    fake.controls.failNextDisconnect({ kind: 'storage_unavailable' });
    await expect(fake.disconnectAccount()).rejects.toEqual({ kind: 'storage_unavailable' });
    expect(fake.controls.accountState().connection).toBe('connected');
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
  });

  it('requestSync resolves as acceptance and reports the outcome through status', async () => {
    const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    await fake.requestSync(); // acceptance, not completion
    expect(fake.controls.accountState().syncState).toBe('syncing');
    await flushMacrotasks(2);
    expect(fake.controls.accountState().syncState).toBe('idle');
    expect(fake.controls.accountState().lastSyncedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('reports a failed sync through sync state and error', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    fake.controls.failNextSync({ kind: 'network_unavailable' });
    await fake.requestSync();
    await flushMacrotasks(2);
    const status = await fake.getAccountStatus();
    expect(status.sync.state).toBe('error');
    expect(status.sync.error).toEqual({ kind: 'network_unavailable' });
    // Cached content stays readable after a sync error.
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
  });

  it('holds and fails status reads for gate/race tests', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.holdNextStatus();
    const pending = fake.getAccountStatus();
    let resolved = false;
    void pending.then(() => { resolved = true; });
    await flushMacrotasks(2);
    expect(resolved).toBe(false);
    fake.controls.releaseStatus();
    await pending;
    expect(resolved).toBe(true);

    fake.controls.failNextStatus({ kind: 'storage_unavailable' });
    await expect(fake.getAccountStatus()).rejects.toEqual({ kind: 'storage_unavailable' });
    // The failure is consumed: the next read succeeds.
    await expect(fake.getAccountStatus()).resolves.toMatchObject({ mode: 'fixture' });
  });

  it('discloses gmail plain-text limitations on the flagged conversation only', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.markUnsupported('conv-02', 'HTML-only messages are not shown', false);
    const flagged = await fake.getConversation(fixtureRef('conv-02'));
    expect(flagged.unsupportedReason).toBe('HTML-only messages are not shown');
    expect(flagged.contextComplete).toBe(false);
    const plain = await fake.getConversation(fixtureRef('conv-01'));
    expect(plain.unsupportedReason).toBeUndefined();
    expect(plain.contextComplete).toBeUndefined();
  });

  it('keeps unknown read state absent and returns detached immutable read snapshots', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.markReadUnknown('conv-01');
    const first = await fake.listConversations();
    expect(first.conversations.find((row) => row.ref.conversationId === 'conv-01')?.isRead).toBeUndefined();
    first.conversations[0]!.subject = 'mutated by caller';
    expect((await fake.listConversations()).conversations[0]?.subject).not.toBe('mutated by caller');
    const detail = await fake.getConversation(fixtureRef('conv-01'));
    detail.messages[0]!.bodyText = 'caller mutation';
    expect((await fake.getConversation(fixtureRef('conv-01'))).messages[0]?.bodyText).not.toBe('caller mutation');
  });

  it('snapshots archive targets so a later incoming message remains in the inbox', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.behavior.hold = true;
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'snapshot-archive' });
    fake.controls.addMessage('conv-01', false);
    fake.controls.release();
    await fake.controls.flush();
    const snap = await fake.listConversations();
    expect(inboxIds(snap)).toContain('conv-01');
    expect(await fake.getConversation(fixtureRef('conv-01'))).toMatchObject({ isInInbox: true, isRead: false });
  });

  it('models synthetic explicit action grants, denial, and cancellation without disconnecting', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    expect((await fake.getAccountStatus()).mutationAccess).toBe('read_only');
    await expect(fake.setArchived({ conversation: gmailRef('conv-01'), archived: true, requestId: 'readonly' }))
      .rejects.toEqual({ kind: 'read_only' });
    fake.controls.failNextEnable({ kind: 'permission_required' });
    await expect(fake.enableMailboxActions()).rejects.toEqual({ kind: 'permission_required' });
    expect((await fake.getAccountStatus()).mutationAccess).toBe('read_only');

    fake.controls.behavior.holdUpgrade = true;
    await fake.enableMailboxActions();
    expect((await fake.getAccountStatus()).mutationAccess).toBe('upgrading');
    await fake.cancelMailboxActionUpgrade();
    expect((await fake.getAccountStatus()).mutationAccess).toBe('read_only');
    expect((await fake.getAccountStatus()).account?.emailAddress).toBe('operator@example.test');
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
    fake.controls.releaseUpgrade();
    expect((await fake.getAccountStatus()).mutationAccess).toBe('read_only');
  });

  it('requires enabled grant for synthetic read setters and applies read/unread explicitly', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    await expect(fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'read-denied' }))
      .rejects.toEqual({ kind: 'read_only' });
    await fake.enableMailboxActions();
    await fake.controls.flush();
    await fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'read-1' });
    await fake.controls.flush();
    expect(await fake.getConversation(gmailRef('conv-01'))).toMatchObject({ isRead: true });
    await fake.setRead({ conversation: gmailRef('conv-01'), read: false, requestId: 'unread-1' });
    await fake.controls.flush();
    expect(await fake.getConversation(gmailRef('conv-01'))).toMatchObject({ isRead: false });
    expect(fake.controls.activity().map((op) => [op.kind, op.requestedRead, op.status])).toEqual([
      ['read', true, 'confirmed'], ['read', false, 'confirmed'],
    ]);
  });

  it('disconnect removes pending fake actions but preserves confirmed provider changes', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled' });
    await fake.setArchived({ conversation: gmailRef('conv-02'), archived: true, requestId: 'confirmed-before-disconnect' });
    await fake.controls.flush();
    fake.controls.behavior.hold = true;
    await fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'pending-before-disconnect' });
    await fake.disconnectAccount();
    expect(fake.controls.activity()).toHaveLength(0);
    expect(inboxIds(await fake.listConversations())).toEqual([]);
    fake.controls.release();
    await fake.controls.flush();
    await fake.connectAccount();
    const afterReconnect = await fake.listConversations();
    expect(inboxIds(afterReconnect)).not.toContain('conv-02');
    expect(inboxIds(afterReconnect)).toContain('conv-01');
    expect(afterReconnect.activity).toHaveLength(0);
  });

  it('keeps unknown outcomes visible and retries as a fresh operation over the original state', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled' });
    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'outcome_unknown';
    const receipt = await fake.setArchived({ conversation: gmailRef('conv-01'), archived: true, requestId: 'unknown-1' });
    await fake.controls.flush();
    expect(fake.controls.activity()[0]).toMatchObject({ id: receipt.operationId, status: 'outcome_unknown', lastError: { kind: 'outcome_unknown' } });
    fake.controls.addMessage('conv-01', false);
    fake.controls.behavior.failureKind = 'provider_rejected';
    const retry = await fake.retryOperation({ operationId: receipt.operationId, requestId: 'retry-new-key' });
    await fake.controls.flush();
    expect(retry.operationId).not.toBe(receipt.operationId);
    expect(fake.controls.activity()).toHaveLength(2);
    expect(fake.controls.activity().find((op) => op.id === retry.operationId)).toMatchObject({ status: 'confirmed', requestedArchived: true, kind: 'archive' });
    expect(fake.controls.activity().find((op) => op.id === receipt.operationId)).toMatchObject({ status: 'outcome_unknown', lastError: { kind: 'outcome_unknown' } });
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
  });
});

describe('browser fake undo model (UX-04)', () => {
  const T0 = Date.parse('2025-01-01T00:00:00.000Z');
  let clockMs = T0;
  const now = (): string => new Date(clockMs).toISOString();
  const undo = (fake: ReturnType<typeof createBrowserFakeMailClient>, operationId: string, requestId: string) =>
    fake.undoOperation({ operationId, requestId });

  it('captures the per-message preimage at acceptance and compensates with explicit targets', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled' });
    // conv-01 seeds: m1 read, m2 read, m3 unread — a mixed read preimage.
    const receipt = await fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'r1' });
    await fake.controls.flush();
    expect(await fake.getConversation(gmailRef('conv-01'))).toMatchObject({ isRead: true });
    const undoReceipt = await undo(fake, receipt.operationId, 'z1');
    expect(undoReceipt.outcome).toBe('compensating');
    expect(undoReceipt.undoneOperationId).toBe(receipt.operationId);
    // One compensating operation per DISTINCT prior value: true (m1, m2) and false (m3).
    expect(undoReceipt.operationIds).toHaveLength(2);
    await fake.controls.flush();
    const compensating = fake.controls.activity().filter((op) => op.undoOf === receipt.operationId);
    expect(compensating.map((op) => [op.kind, op.requestedRead, op.status]).sort()).toEqual([['read', false, 'confirmed'], ['read', true, 'confirmed']]);
    expect(await fake.getConversation(gmailRef('conv-01'))).toMatchObject({ isRead: false });
  });

  it('compensates from the effective preimage at acceptance, not stale cached facts', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    await fake.controls.flush();
    const notDone = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: false, requestId: 'a2' });
    await fake.controls.flush();
    // The unarchive's effective prior value is "archived" (the queued/confirmed
    // archive), not the stale seeded inbox fact: undo must re-archive.
    const undoReceipt = await undo(fake, notDone.operationId, 'z1');
    expect(undoReceipt.outcome).toBe('compensating');
    expect(undoReceipt.operationIds).toHaveLength(1);
    await fake.controls.flush();
    expect(fake.controls.activity().find((op) => op.undoOf === notDone.operationId)).toMatchObject({ requestedArchived: true });
    expect(await fake.getConversation(fixtureRef('conv-01'))).toMatchObject({ isInInbox: false });
  });

  it('keeps later arrivals out of compensating targets', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    const receipt = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    await fake.controls.flush();
    fake.controls.addMessage('conv-01', false);
    const undoReceipt = await undo(fake, receipt.operationId, 'z1');
    expect(undoReceipt.outcome).toBe('compensating');
    await fake.controls.flush();
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
    expect(await fake.getConversation(fixtureRef('conv-01'))).toMatchObject({ isInInbox: true, isRead: false });
  });

  it('cancels a still-queued operation in place and drops it from the pending overlay', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    fake.controls.behavior.holdQueued = true;
    const receipt = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    expect(inboxIds(await fake.listConversations())).not.toContain('conv-01');
    const undoReceipt = await undo(fake, receipt.operationId, 'z1');
    expect(undoReceipt).toMatchObject({ undoneOperationId: receipt.operationId, outcome: 'cancelled', operationIds: [] });
    // Overlay gone, row back, still visible in Activity as cancelled.
    expect(inboxIds(await fake.listConversations())).toContain('conv-01');
    expect(await fake.getConversation(fixtureRef('conv-01'))).toMatchObject({ pendingOperationId: null, isInInbox: true });
    expect(fake.controls.activity().find((op) => op.id === receipt.operationId)?.status).toBe('cancelled');
    expect(fake.controls.activity().find((op) => op.id === receipt.operationId)?.undoableUntil).toBeUndefined();
    fake.controls.release();
    await fake.controls.flush();
    expect(fake.controls.activity().find((op) => op.id === receipt.operationId)).toMatchObject({ status: 'cancelled' });
  });

  it('derives undoableUntil from the injected clock (10 s) and drops it once ineligible', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    const receipt = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    await fake.controls.flush();
    expect(fake.controls.activity().find((op) => op.id === receipt.operationId)?.undoableUntil)
      .toBe(new Date(T0 + 10_000).toISOString());
    clockMs = T0 + 10_001;
    const snap = await fake.listConversations();
    expect(snap.activity.find((op) => op.id === receipt.operationId)?.undoableUntil).toBeUndefined();
  });

  it('rejects expired with nothing enqueued, and failed/compensating as not_applicable, unknown outcome as uncertain', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    const receipt = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    await fake.controls.flush();
    clockMs = T0 + 10_001;
    await expect(undo(fake, receipt.operationId, 'z1')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'expired' });
    expect(fake.controls.activity()).toHaveLength(1);

    fake.controls.behavior.failNext = 1;
    fake.controls.behavior.failureKind = 'provider_rejected';
    const failed = await fake.setArchived({ conversation: fixtureRef('conv-02'), archived: true, requestId: 'a2' });
    await fake.controls.flush();
    clockMs = T0 + 10_001; // past failed op's own window; failed blocks before expiry matters less
    clockMs = T0 + 5_000;
    await expect(undo(fake, failed.operationId, 'z2')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'not_applicable' });

    fake.controls.behavior.failureKind = 'outcome_unknown';
    fake.controls.behavior.failNext = 1;
    const uncertain = await fake.setArchived({ conversation: fixtureRef('conv-03'), archived: true, requestId: 'a3' });
    await fake.controls.flush();
    await expect(undo(fake, uncertain.operationId, 'z3')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'uncertain' });
  });

  it('rejects superseded until the newest op is undone, then already_undone; retry preimage copies', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    const first = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    await fake.controls.flush();
    const second = await fake.setArchived({ conversation: fixtureRef('conv-02'), archived: true, requestId: 'a2' });
    await fake.controls.flush();
    await expect(undo(fake, first.operationId, 'z1')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'superseded' });
    const undoReceipt = await undo(fake, second.operationId, 'z2');
    expect(undoReceipt.outcome).toBe('compensating');
    await fake.controls.flush();
    // Idempotent under the same requestId; a fresh requestId is already_undone.
    expect(await undo(fake, second.operationId, 'z2')).toEqual(undoReceipt);
    await expect(undo(fake, second.operationId, 'z3')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'already_undone' });
    // The compensating operation itself is never undoable.
    await expect(undo(fake, undoReceipt.operationIds[0]!, 'z4')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'not_applicable' });
    // Undoing the older op now still fails: it was superseded and stays rejected.
    await expect(undo(fake, first.operationId, 'z5')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'superseded' });
  });

  it('rejects undo when a target prior fact is unknown', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled' });
    fake.controls.markReadUnknown('conv-01');
    const receipt = await fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'r1' });
    await fake.controls.flush();
    await expect(undo(fake, receipt.operationId, 'z1')).rejects.toEqual({ kind: 'undo_unavailable', reason: 'unknown_prior' });
    expect(fake.controls.activity().find((op) => op.id === receipt.operationId)?.undoableUntil).toBeUndefined();
  });

  it('a retry copies the original preimage so undo restores the same prior world', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test', mutationAccess: 'enabled' });
    fake.controls.behavior.failNext = 1;
    const original = await fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'r1' });
    await fake.controls.flush();
    // The world moves on after the definite failure: everything becomes read.
    await fake.setRead({ conversation: gmailRef('conv-01'), read: true, requestId: 'r2' });
    await fake.controls.flush();
    const retry = await fake.retryOperation({ operationId: original.operationId, requestId: 'r3' });
    await fake.controls.flush();
    // Copied mixed preimage (m3 was unread) → two groups; a fresh capture would be one.
    const undoReceipt = await undo(fake, retry.operationId, 'z1');
    expect(undoReceipt.outcome).toBe('compensating');
    expect(undoReceipt.operationIds).toHaveLength(2);
    await fake.controls.flush();
    expect(await fake.getConversation(gmailRef('conv-01'))).toMatchObject({ isRead: false });
  });

  it('excludes cancelled archives from cached Done evidence', async () => {
    const fake = createBrowserFakeMailClient(now);
    clockMs = T0;
    fake.controls.behavior.holdQueued = true;
    const receipt = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'a1' });
    await undo(fake, receipt.operationId, 'z1');
    fake.controls.release();
    await fake.controls.flush();
    const page = await fake.listCachedDone({ accountId: 'fixture-account', limit: 100, cursor: null });
    expect(page.conversations.map((c) => c.ref.conversationId)).not.toContain('conv-01');
  });

  it('isMailErrorShape accepts undo_unavailable only with a valid reason', async () => {
    const { isMailErrorShape } = await import('../src/lib/ipc/client');
    expect(isMailErrorShape({ kind: 'undo_unavailable', reason: 'expired' })).toBe(true);
    for (const reason of ['superseded', 'already_undone', 'not_applicable', 'uncertain', 'unknown_prior']) {
      expect(isMailErrorShape({ kind: 'undo_unavailable', reason })).toBe(true);
    }
    expect(isMailErrorShape({ kind: 'undo_unavailable', reason: 'other' })).toBe(false);
    expect(isMailErrorShape({ kind: 'undo_unavailable' })).toBe(false);
  });
});
