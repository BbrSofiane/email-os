import { describe, expect, it } from 'vitest';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';

describe('models local reminders as synthetic memory (UX-11)', () => {
  it('hides locally while pending and returns the conversation when due', async () => {
    let instant = '2025-01-06T09:00:00.000Z';
    const client = createBrowserFakeMailClient(() => instant);
    const row = (await client.listConversations()).conversations[0]!;
    const detail = await client.getConversation(row.ref);
    const reminder = await client.reminders!.put({
      conversation: row.ref, sourceMessageId: detail.messages.at(-1)!.id,
      dueAt: '2025-01-06T09:01:00.000Z', condition: 'regardless',
      expectedRevision: null, requestId: 'fake-reminder-1',
    });
    expect(reminder.phase).toBe('pending');
    expect((await client.listConversations()).conversations.some(item => item.ref.conversationId === row.ref.conversationId)).toBe(false);
    expect((await client.listConversations()).activity).toEqual([]);

    instant = '2025-01-06T09:01:00.000Z';
    expect((await client.reminders!.list())[0]).toMatchObject({ phase: 'returned', revision: 2 });
    expect((await client.listConversations()).conversations.some(item => item.ref.conversationId === row.ref.conversationId)).toBe(true);
  });

  it('releases local Inbox visibility on cancel and supports synthetic Gmail mode', async () => {
    const client = createBrowserFakeMailClient(() => '2025-01-06T09:00:00.000Z');
    client.controls.setAccount({ mode: 'gmail', connection: 'connected', emailAddress: 'operator@example.test' });
    const ref = (await client.listConversations()).conversations[0]!.ref;
    const detail = await client.getConversation(ref);
    const reminder = await client.reminders!.put({ conversation: ref, sourceMessageId: detail.messages.at(-1)!.id,
      dueAt: null, condition: 'if_no_reply', expectedRevision: null, requestId: 'fake-someday' });
    expect((await client.listConversations()).conversations.some(item => item.ref.conversationId === ref.conversationId)).toBe(false);
    const cancelled = await client.reminders!.cancel({ conversation: ref, expectedRevision: reminder.revision, requestId: 'fake-cancel' });
    expect(cancelled.phase).toBe('cancelled');
    expect((await client.listConversations()).conversations.some(item => item.ref.conversationId === ref.conversationId)).toBe(true);
    expect((await client.listConversations()).activity).toEqual([]);
  });

  it('suppresses a conditional reminder after a synthetic external reply', async () => {
    let instant = '2025-01-06T09:00:00.000Z';
    const client = createBrowserFakeMailClient(() => instant);
    const row = (await client.listConversations()).conversations[0]!;
    const detail = await client.getConversation(row.ref);
    const scheduled = await client.reminders!.put({ conversation: row.ref,
      sourceMessageId: detail.messages.at(-1)!.id, dueAt: '2025-01-06T09:01:00.000Z',
      condition: 'if_no_reply', expectedRevision: null, requestId: 'conditional-reminder' });
    client.controls.addMessage(row.ref.conversationId, false, { displayName: 'External reply', mailbox: 'reply@example.test' });
    instant = '2025-01-06T09:01:00.000Z';
    expect((await client.reminders!.list())[0]).toMatchObject({ phase: 'suppressed', revision: scheduled.revision + 1 });
    expect((await client.listConversations()).conversations.some(item => item.ref.conversationId === row.ref.conversationId)).toBe(true);
  });
});


it('shows new incoming mail immediately and preserves its original reply baseline when rescheduled', async () => {
  let instant = '2025-01-06T09:00:00.000Z';
  const client = createBrowserFakeMailClient(() => instant);
  const row = (await client.listConversations()).conversations[0]!;
  const detail = await client.getConversation(row.ref);
  const command = { conversation: row.ref, sourceMessageId: detail.messages.at(-1)!.id,
    dueAt: '2025-01-06T10:00:00Z', condition: 'if_no_reply' as const, expectedRevision: null, requestId: 'initial' };
  const pending = await client.reminders!.put(command);
  client.controls.addMessage(row.ref.conversationId);
  expect((await client.listConversations()).conversations.some(item => item.ref.conversationId === row.ref.conversationId)).toBe(true);
  await client.reminders!.put({ ...command, expectedRevision: pending.revision, requestId: 'reschedule', dueAt: '2025-01-06T11:00:00Z' });
  instant = '2025-01-06T11:00:00Z';
  expect((await client.reminders!.list())[0]?.phase).toBe('suppressed');
  expect((await client.reminders!.put(command)).revision).toBe(1);
});

it('clears reminder state when the synthetic account identity changes', async () => {
  const client = createBrowserFakeMailClient(() => '2025-01-06T09:00:00Z');
  const row = (await client.listConversations()).conversations[0]!;
  const detail = await client.getConversation(row.ref);
  await client.reminders!.put({ conversation: row.ref, sourceMessageId: detail.messages.at(-1)!.id,
    dueAt: null, condition: 'regardless', expectedRevision: null, requestId: 'isolated' });
  client.controls.setAccount({ mode: 'gmail', emailAddress: 'other@example.test' });
  expect(await client.reminders!.list()).toEqual([]);
});

it('defers conditional return when the simulated account is offline', async () => {
  let instant = '2025-01-06T09:00:00Z';
  const client = createBrowserFakeMailClient(() => instant);
  const row = (await client.listConversations()).conversations[0]!;
  const detail = await client.getConversation(row.ref);
  await client.reminders!.put({ conversation: row.ref, sourceMessageId: detail.messages.at(-1)!.id,
    dueAt: '2025-01-06T10:00:00Z', condition: 'if_no_reply', expectedRevision: null, requestId: 'offline' });
  client.controls.setAccount({ syncError: { kind: 'network_unavailable' } });
  instant = '2025-01-06T10:00:00Z';
  expect((await client.reminders!.list())[0]?.phase).toBe('pending');
  client.controls.setAccount({ syncError: null });
  expect((await client.reminders!.list())[0]?.phase).toBe('returned');
});
