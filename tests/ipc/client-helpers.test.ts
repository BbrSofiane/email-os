import { describe, expect, it, vi } from 'vitest';
import { accountMethods, countingClient, createBrowserFakeMailClient, groupMethods } from '../helpers';
import type { MailClient } from '../../src/lib/ipc/client';

describe('client test helpers', () => {
  it('preserves optional reminders when counting client calls', async () => {
    const inner = createBrowserFakeMailClient();
    const list = vi.spyOn(inner.reminders!, 'list');
    const counted = countingClient(inner);

    expect(counted.client.reminders).toBe(inner.reminders);
    await counted.client.reminders!.list();
    expect(list).toHaveBeenCalledOnce();
  });

  it('keeps method receiver binding while decorating the client', async () => {
    const inner = Object.assign(createBrowserFakeMailClient(), { receiver: 'bound' }) as MailClient & { receiver: string };
    const original = inner.getAccountStatus;
    inner.getAccountStatus = function () {
      if (this.receiver !== 'bound') throw new Error('receiver was lost');
      return original();
    };
    const delegated = accountMethods(inner);

    await expect(delegated.getAccountStatus()).resolves.toMatchObject({ connection: 'connected' });
  });

  it('forwards the optional conversation argument and preserves reminders across adapters', async () => {
    const inner = createBrowserFakeMailClient();
    const getConversation = vi.spyOn(inner, 'getConversation');
    const ref = { accountId: 'fixture-account', conversationId: 'missing' };
    await expect(countingClient(inner).client.getConversation(ref, true)).rejects.toBeDefined();
    expect(getConversation).toHaveBeenCalledWith(ref, true);

    expect(accountMethods(inner).reminders).toBe(inner.reminders);
    expect(groupMethods(inner).reminders).toBe(inner.reminders);
  });
});
