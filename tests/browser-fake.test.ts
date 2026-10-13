import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, fixtureRef, flushMacrotasks, inboxIds } from './helpers';

describe('browser fake MailClient (core-like semantics, memory-only)', () => {
  it('seeds 18 conversations once, newest first', async () => {
    const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    const snap = await fake.listConversations();
    expect(snap.conversations).toHaveLength(18);
    const ids = inboxIds(snap);
    expect(ids[0]).toBe('conv-01');
    const times = snap.conversations.map((c) => c.lastMessageAt);
    expect([...times].sort().reverse()).toEqual(times);
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
    expect(status.account).toEqual({ accountId: 'fixture-account', emailAddress: 'fixture@example.test' });
    expect(status.sync).toMatchObject({ state: 'idle', error: null, cachedConversations: 18, initialSyncComplete: true, coverageLimit: 0 });
  });

  it('rejects archive commands with read_only in gmail mode and records no operation', async () => {
    const fake = createBrowserFakeMailClient();
    fake.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    await expect(fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'r-g' }))
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
});
