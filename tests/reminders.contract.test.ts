import { flushPromises } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import { mountReminders } from './reminders.helpers';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { parseReminderTime } from '../src/lib/reminder-time';

const now = '2025-01-06T09:00:00.000Z';
const matrix = [
  ['2030-08-08T10:00Z', true, false],
  ['2030-08-08T10:00+02:00', true, false],
  ['2030-08-08T10:00:00Z', true, true],
  ['2030-08-08T10:00:00.000Z', true, true],
  ['2030-08-08T10:00:00.500Z', false, false],
  ['2030-08-08T10:00:00.000000001Z', false, false],
  ['2030-08-08T10:00:00+24:00', false, false],
  ['2030-08-08T10:00:00.000000000Z', true, true],
  ['2030-08-08T10:00:00.000+02:00', true, true],
  ['2030-08-08t10:00:00z', true, true],
  ['2030-08-08t10:00:00+02:00', true, true],
  ['2030-08-08T10:00:60Z', false, false],
  ['2030-02-30T10:00:00Z', false, false],
  ['2030-08-08T24:00:00Z', false, false],
  [`2030-08-08T10:00:00.${'0'.repeat(25)}Z`, false, false],
] as const;
async function fixture(mode: 'gmail' | 'fixture' = 'gmail') {
  const client = createBrowserFakeMailClient(() => now);
  if (mode === 'gmail') client.controls.setAccount({ mode, connection: 'connected', emailAddress: 'synthetic@example.test' });
  const conversation = (await client.listConversations()).conversations[0]!.ref;
  const detail = await client.getConversation(conversation);
  const command = { conversation, sourceMessageId: detail.messages.at(-1)!.id, dueAt: null as string | null,
    condition: 'regardless' as const, expectedRevision: null as number | null, requestId: 'schedule' };
  return { client, command };
}
describe('reminder timestamp native admission contract', () => {
  it.each(matrix)('%s: parser=%s, transport=%s', async (input, parsed, admitted) => {
    const result = parseReminderTime(input, new Date(now), { hour: 8, minute: 0 });
    expect(result.ok).toBe(parsed);
    for (const mode of ['gmail', 'fixture'] as const) {
      const { client, command } = await fixture(mode);
      const direct = client.reminders!.put({ ...command, dueAt: input });
      if (admitted) expect(await direct).toMatchObject({ dueAt: input });
      else await expect(direct).rejects.toEqual({ kind: 'invalid_request', field: 'dueAt' });
      if (result.ok) {
        expect(await client.reminders!.put({ ...command, dueAt: result.dueAt, requestId: 'parsed', expectedRevision: admitted ? 1 : null })).toMatchObject({ dueAt: result.dueAt });
      }
    }
  });
});
describe.each(['gmail', 'fixture'] as const)('%s reminder error contract', mode => {
  it.each(['', 'x'.repeat(129), 'é'.repeat(65)])('validates put/cancel request IDs by UTF-8 bytes: %s', async requestId => {
    const { client, command } = await fixture(mode);
    await expect(client.reminders!.put({ ...command, requestId })).rejects.toEqual({ kind: 'invalid_request', field: 'requestId' });
    await expect(client.reminders!.cancel({ ...command, expectedRevision: 1, requestId })).rejects.toEqual({ kind: 'invalid_request', field: 'requestId' });
  });
  it('checks account and timestamp before revisions, and returns native revision errors', async () => {
    const { client, command } = await fixture(mode);
    const pending = await client.reminders!.put(command);
    await expect(client.reminders!.put({ ...command, dueAt: 'bad', requestId: 'invalid-due' })).rejects.toEqual({ kind: 'invalid_request', field: 'dueAt' });
    for (const patch of [{ expectedRevision: 99 }, { expectedRevision: pending.revision, sourceMessageId: 'stale' }, {}]) {
      await expect(client.reminders!.put({ ...command, ...patch, requestId: 'revision' })).rejects.toEqual({ kind: 'invalid_request', field: 'revision' });
    }
    await expect(client.reminders!.cancel({ ...command, expectedRevision: 99, requestId: 'cancel' })).rejects.toEqual({ kind: 'invalid_request', field: 'revision' });
    const foreign = { ...command.conversation, accountId: 'foreign' };
    await expect(client.reminders!.put({ ...command, conversation: foreign })).rejects.toEqual({ kind: 'not_found' });
    await expect(client.reminders!.cancel({ conversation: foreign, expectedRevision: 1, requestId: 'cancel' })).rejects.toEqual({ kind: 'not_found' });
  });
  it('returns not_found for a missing revision target', async () => {
    const { client, command } = await fixture(mode);
    await expect(client.reminders!.put({ ...command, expectedRevision: 1 })).rejects.toEqual({ kind: 'not_found' });
    await expect(client.reminders!.cancel({ ...command, expectedRevision: 1 })).rejects.toEqual({ kind: 'not_found' });
  });
  it('keeps profile-specific account/request validation order and accepts boundary IDs', async () => {
    const { client, command } = await fixture(mode);
    const foreign = { ...command.conversation, accountId: 'foreign' };
    const expected = mode === 'gmail' ? { kind: 'invalid_request', field: 'requestId' } : { kind: 'not_found' };
    await expect(client.reminders!.put({ ...command, conversation: foreign, requestId: '' })).rejects.toEqual(expected);
    await expect(client.reminders!.cancel({ conversation: foreign, expectedRevision: 1, requestId: '' })).rejects.toEqual(expected);
    // Native checks emptiness, not whitespace; limits count UTF-8 bytes.
    const saved = await client.reminders!.put({ ...command, requestId: ' ' });
    expect(saved.revision).toBe(1);
    expect(await client.reminders!.cancel({ ...command, expectedRevision: 1, requestId: 'é'.repeat(64) })).toMatchObject({ phase: 'cancelled' });
  });
  it('checks stale source before membership/pending intent and reports profile-specific conflict fields', async () => {
    const { client, command } = await fixture(mode);
    if (mode === 'gmail') await client.enableMailboxActions();
    client.controls.behavior.hold = true;
    await client.setArchived({ conversation: command.conversation, archived: true, requestId: 'archive' });
    await expect(client.reminders!.put({ ...command, sourceMessageId: 'stale' })).rejects.toEqual({ kind: 'invalid_request', field: 'sourceMessageId' });
    await expect(client.reminders!.put(command)).rejects.toEqual({ kind: 'invalid_request', field: mode === 'gmail' ? 'conversation' : 'pendingOperation' });
    client.controls.release();
    client.controls.behavior.hold = false;
    await client.controls.flush();
    await expect(client.reminders!.put(command)).rejects.toEqual({ kind: 'invalid_request', field: mode === 'gmail' ? 'conversation' : 'inbox' });
  });
  it('keeps exact offset receipts after cancel and rejects changed payload/key reuse', async () => {
    const { client, command } = await fixture(mode);
    command.dueAt = '2030-08-08t10:00:00+02:00';
    const receipt = await client.reminders!.put(command);
    const cancel = { conversation: command.conversation, expectedRevision: 1, requestId: 'cancel' };
    const cancelled = await client.reminders!.cancel(cancel);
    expect(await client.reminders!.put(command)).toEqual(receipt);
    expect(await client.reminders!.cancel(cancel)).toEqual(cancelled);
    await expect(client.reminders!.put({ ...command, dueAt: '2030-08-08T08:00:00Z' })).rejects.toEqual({ kind: 'request_id_conflict' });
    await expect(client.reminders!.cancel({ ...cancel, requestId: command.requestId })).rejects.toEqual({ kind: 'request_id_conflict' });
  });
});
it('rejects pending read intent even when Inbox membership is unchanged', async () => {
  const { client, command } = await fixture();
  await client.enableMailboxActions();
  client.controls.behavior.hold = true;
  await client.setRead({ conversation: command.conversation, read: true, requestId: 'read' });
  await expect(client.reminders!.put(command)).rejects.toEqual({ kind: 'invalid_request', field: 'conversation' });
  client.controls.release();
  client.controls.behavior.hold = false;
  await client.controls.flush();
  expect(await client.reminders!.put(command)).toMatchObject({ phase: 'pending' });
});
it('routes Gmail membership rejection through the list conflict branch, without stale-source recovery', async () => {
  const { client, command } = await fixture();
  const m = mountReminders(client, { target: command.conversation }); const panel = m.wrapper;
  try {
    await flushPromises();
    await client.enableMailboxActions();
    await client.setArchived({ conversation: command.conversation, archived: true, requestId: 'archive' });
    await panel.get('#reminder-time-option-someday').trigger('click');
    await panel.findAll('button').find(button => button.text() === 'Schedule reminder')!.trigger('click');
    await flushPromises();
    expect(panel.text()).toContain('This reminder is no longer actionable.');
    expect(panel.text()).not.toContain('Retry preparation / refresh conversation');
  } finally { m.unmount(); }
});
