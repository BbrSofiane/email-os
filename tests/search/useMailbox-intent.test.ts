import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises } from '@vue/test-utils';
import { useMailbox } from '../../src/composables/useMailbox';
import type { MailClient } from '../../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, useGmailMode } from '../helpers';

const scopes: ReturnType<typeof effectScope>[] = [];
afterEach(() => { for (const scope of scopes.splice(0)) scope.stop(); });

async function setup() {
  const fake = createBrowserFakeMailClient();
  useGmailMode(fake);
  const row = (await fake.listConversations()).conversations[0]!;
  let notify = () => {};
  const cancelSearchMail = vi.fn<MailClient['cancelSearchMail']>().mockResolvedValue(undefined);
  const searchMail = vi.fn<MailClient['searchMail']>().mockResolvedValue({
    conversations: [row], nextCursor: null, coverage: 'provider_candidates',
  });
  const getAccountStatus = vi.fn(() => fake.getAccountStatus());
  const client: MailClient = {
    ...fake, cancelSearchMail, searchMail, getAccountStatus,
    subscribe: async (listener) => { notify = listener; return () => { notify = () => {}; }; },
  };
  const scope = effectScope();
  scopes.push(scope);
  const mailbox = scope.run(() => useMailbox(client))!;
  await mailbox.ready;
  return { fake, client, mailbox, scope, row, cancelSearchMail, searchMail, getAccountStatus, notify: () => notify() };
}

describe('useMailbox deferred navigation ownership', () => {
  it('captures without revoking a pending query and survives background list/detail refresh', async () => {
    const h = await setup();
    await h.mailbox.openConversationByRef(h.row.ref);
    const cancellation = deferred<void>();
    h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
    const submission = h.mailbox.search('new query');
    const ownsNavigation = h.mailbox.captureNavigationIntent();
    h.notify();
    await flushPromises();
    expect(ownsNavigation()).toBe(true);
    cancellation.resolve();
    await submission;
    expect(h.searchMail).toHaveBeenCalledTimes(1);
    expect(h.mailbox.context.value).toBe('search');
    // Search's internal reader close does not represent a new explicit intent.
    expect(ownsNavigation()).toBe(true);
    await h.mailbox.openConversationByRef(h.row.ref);
    expect(ownsNavigation()).toBe(false);
  });

  it.each(['account round trip', 'disposal'] as const)('cannot regain captured ownership after %s', async (boundary) => {
    const h = await setup();
    const ownsNavigation = h.mailbox.captureNavigationIntent();
    expect(ownsNavigation()).toBe(true);
    if (boundary === 'disposal') h.scope.stop();
    else {
      const original = h.mailbox.accountStatus.value!;
      h.getAccountStatus.mockResolvedValue({ ...original, account: { accountId: 'other-account', emailAddress: 'other@example.test' } });
      await h.mailbox.refresh();
      h.getAccountStatus.mockResolvedValue(original);
      await h.mailbox.refresh();
    }
    expect(ownsNavigation()).toBe(false);
  });
});

describe('useMailbox explicit search intent during cancellation', () => {
  it.each(['refresh', 'subscription', 'focus', 'online'] as const)(
    'does not lose a submitted query to a background %s', async (trigger) => {
      const h = await setup();
      const cancellation = deferred<void>();
      h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
      const submission = h.mailbox.search('invoice', true);
      expect(h.searchMail).not.toHaveBeenCalled();

      if (trigger === 'refresh') await h.mailbox.refresh();
      else if (trigger === 'subscription') h.notify();
      else window.dispatchEvent(new Event(trigger));
      await flushPromises();
      expect(h.mailbox.context.value).toBe('inbox');
      expect(h.searchMail).not.toHaveBeenCalled();

      cancellation.resolve();
      await submission;
      expect(h.mailbox.context.value).toBe('search');
      expect(h.mailbox.searchQuery.value).toBe('invoice');
      expect(h.mailbox.listState.value).toBe('ready');
      expect(h.mailbox.listError.value).toBeNull();
      expect(h.mailbox.conversations.value).toEqual([h.row]);
      expect(h.searchMail).toHaveBeenCalledExactlyOnceWith({
        accountId: h.row.ref.accountId, query: 'invoice', cachedOnly: true, cursor: null,
      });
    },
  );

  it.each(['older-first', 'newer-first'] as const)(
    'keeps the newest explicit query when cancellations resolve %s', async (order) => {
      const h = await setup();
      const olderCancellation = deferred<void>();
      const newerCancellation = deferred<void>();
      h.cancelSearchMail.mockReturnValueOnce(olderCancellation.promise).mockReturnValueOnce(newerCancellation.promise);
      const older = h.mailbox.search('old invoice');
      const newer = h.mailbox.search('new invoice');
      // A refresh must not supersede either intent; only the newest may enter.
      await h.mailbox.refresh();
      if (order === 'older-first') {
        olderCancellation.resolve();
        await older;
        expect(h.mailbox.context.value).toBe('inbox');
        expect(h.searchMail).not.toHaveBeenCalled();
      }
      newerCancellation.resolve();
      await newer;
      olderCancellation.resolve();
      await older;
      expect(h.mailbox.searchQuery.value).toBe('new invoice');
      expect(h.mailbox.context.value).toBe('search');
      expect(h.searchMail).toHaveBeenCalledTimes(1);
      expect(h.searchMail.mock.calls[0]![0].query).toBe('new invoice');
    },
  );

  it.each(['current destination', 'Done', 'context round trip', 'restored search'] as const)(
    'cannot re-enter Search after choosing %s', async (destination) => {
      const h = await setup();
      if (destination === 'restored search') {
        // Restoring another query must win even when context remains Search.
        await h.mailbox.search('initial query');
        h.searchMail.mockClear();
      }
      const cancellation = deferred<void>();
      h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
      const submission = h.mailbox.search('stale invoice');
      if (destination === 'restored search') {
        await h.mailbox.restoreSearch({ query: 'saved query', cachedOnly: true, coverage: 'cached_incomplete', rows: [h.row], cursor: 'saved-cursor' });
      } else if (destination === 'current destination') {
        // setContext's no-op path still represents explicit navigation away
        // from the submitted-but-not-yet-entered search.
        await h.mailbox.setContext('inbox');
      } else {
        await h.mailbox.setContext('done');
        if (destination === 'context round trip') await h.mailbox.setContext('inbox');
      }
      const context = h.mailbox.context.value;
      const query = h.mailbox.searchQuery.value;
      const rows = h.mailbox.conversations.value;
      const cursor = h.mailbox.nextCursor.value;
      cancellation.resolve();
      await submission;
      expect(h.mailbox.context.value).toBe(context);
      expect(h.mailbox.searchQuery.value).toBe(query);
      expect(h.mailbox.conversations.value).toEqual(rows);
      expect(h.mailbox.nextCursor.value).toBe(cursor);
      expect(h.searchMail).not.toHaveBeenCalled();
    },
  );

  it.each(['replacement', 'removal', 'account round trip'] as const)(
    'invalidates a pending query on account %s observed by refresh', async (transition) => {
      const h = await setup();
      const original = h.mailbox.accountStatus.value!;
      const cancellation = deferred<void>();
      h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
      const submission = h.mailbox.search('stale invoice');
      h.getAccountStatus.mockResolvedValue({
        ...original,
        account: transition === 'removal' ? null : { accountId: 'other-account', emailAddress: 'other@example.test' },
      });
      await h.mailbox.refresh();
      await flushPromises();
      if (transition === 'account round trip') {
        h.getAccountStatus.mockResolvedValue(original);
        await h.mailbox.refresh();
        await flushPromises();
      }
      cancellation.resolve();
      await submission;
      expect(h.mailbox.context.value).toBe('inbox');
      expect(h.mailbox.searchQuery.value).toBe('');
      expect(h.searchMail).not.toHaveBeenCalled();
    },
  );

  it.each(['connect', 'disconnect'] as const)(
    'invalidates a pending query as soon as %s starts, before account status changes', async (action) => {
      const h = await setup();
      const lifecycle = deferred<void>();
      h.client[action === 'connect' ? 'connectAccount' : 'disconnectAccount'] = async () => {
        await lifecycle.promise;
        await h.fake[action === 'connect' ? 'connectAccount' : 'disconnectAccount']();
      };
      const cancellation = deferred<void>();
      h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
      const submission = h.mailbox.search('stale invoice');
      const changing = h.mailbox[action === 'connect' ? 'connectAccount' : 'disconnectAccount']();
      expect(h.mailbox.accountStatus.value?.account?.accountId).toBe(h.row.ref.accountId);
      cancellation.resolve();
      await submission;
      // Queries submitted during the account transition also cannot enter Search.
      await h.mailbox.search('during account transition');
      expect(h.mailbox.context.value).toBe('inbox');
      expect(h.searchMail).not.toHaveBeenCalled();
      lifecycle.resolve();
      await changing;
      await flushPromises();
      expect(h.mailbox.context.value).toBe('inbox');
      expect(h.searchMail).not.toHaveBeenCalled();
    },
  );

  it('cannot revive a submission after disconnect and reconnect to the same account', async () => {
    const h = await setup();
    const cancellation = deferred<void>();
    h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
    const submission = h.mailbox.search('stale invoice');
    await h.mailbox.disconnectAccount();
    await h.mailbox.connectAccount();
    await flushPromises();
    expect(h.mailbox.accountStatus.value?.account?.accountId).toBe(h.row.ref.accountId);
    cancellation.resolve();
    await submission;
    expect(h.mailbox.context.value).toBe('inbox');
    expect(h.mailbox.searchQuery.value).toBe('');
    expect(h.searchMail).not.toHaveBeenCalled();
  });

  it('does not submit without an active account', async () => {
    const h = await setup();
    await h.mailbox.disconnectAccount();
    h.cancelSearchMail.mockClear();
    await h.mailbox.search('invoice');
    expect(h.mailbox.context.value).toBe('inbox');
    expect(h.cancelSearchMail).not.toHaveBeenCalled();
    expect(h.searchMail).not.toHaveBeenCalled();
  });

  it('cannot enter Search when deferred cancellation completes after disposal', async () => {
    const h = await setup();
    const cancellation = deferred<void>();
    h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
    const submission = h.mailbox.search('stale invoice');
    h.scope.stop();
    const rows = h.mailbox.conversations.value;
    cancellation.resolve();
    await submission;
    expect(h.mailbox.context.value).toBe('inbox');
    expect(h.mailbox.searchQuery.value).toBe('');
    expect(h.mailbox.conversations.value).toEqual(rows);
    expect(h.searchMail).not.toHaveBeenCalled();
    await h.mailbox.search('after disposal');
    expect(h.searchMail).not.toHaveBeenCalled();
  });
});
