import { describe, expect, it } from 'vitest';
import { createBrowserFakeMailClient, fixtureRef, inboxIds } from './helpers';

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
