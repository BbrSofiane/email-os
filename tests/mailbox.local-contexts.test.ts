/**
 * Contexts that do not use the Inbox projection (Drafts, Reminders) must not
 * leave an unhandled rejection when the Inbox read fails. Synthetic only.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../src/composables/useMailbox';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { MailClient } from '../src/lib/ipc/client';
import { flushMacrotasks } from './helpers';

// The repository ships no @types/node; declare only the process events used here.
const proc = process as unknown as {
  on(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
  off(event: 'unhandledRejection', listener: (reason: unknown) => void): void;
};

describe('useMailbox contexts that skip the Inbox projection', () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
  beforeEach(() => {
    unhandled.length = 0;
    proc.on('unhandledRejection', onUnhandled);
  });
  afterEach(() => { proc.off('unhandledRejection', onUnhandled); });

  function failingClient(initiallyFailing: boolean) {
    const fake = createBrowserFakeMailClient();
    const state = { failing: initiallyFailing };
    const client: MailClient = Object.assign(Object.create(fake) as MailClient, {
      listConversations: () => (state.failing ? Promise.reject({ kind: 'storage_unavailable' }) : fake.listConversations()),
    });
    return { client, state };
  }

  it.each(['drafts', 'reminders'] as const)('leaves no unhandled rejection when listConversations rejects while entering %s', async (context) => {
    const { client, state } = failingClient(false);
    const scope = effectScope();
    const box = scope.run(() => useMailbox(client))!;
    await box.ready;
    state.failing = true;
    await box.setContext(context);
    await flushMacrotasks(3);
    scope.stop();
    expect(box.context.value).toBe(context);
    expect(box.listState.value).toBe('ready');
    expect(unhandled).toEqual([]);
  });

  it('still reports the Inbox failure where the Inbox list uses it', async () => {
    const { client } = failingClient(true);
    const scope = effectScope();
    const box = scope.run(() => useMailbox(client))!;
    await box.ready;
    await flushMacrotasks(3);
    scope.stop();
    expect(box.listState.value).toBe('error');
    expect(box.listError.value).toMatchObject({ kind: 'storage_unavailable' });
    expect(unhandled).toEqual([]);
  });
});
