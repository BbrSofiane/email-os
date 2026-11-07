import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { MailClient } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

async function setup(options: { singleRow?: boolean; activityOrigin?: boolean } = {}) {
  const fake = createBrowserFakeMailClient();
  const rows = (await fake.listConversations()).conversations;
  if (options.activityOrigin) {
    // An accepted unarchive gives Activity an actual link to an Inbox reader.
    await fake.setArchived({ conversation: rows[0]!.ref, archived: false, requestId: 'activity-origin' });
  }
  const setArchived = vi.fn<MailClient['setArchived']>((command) => fake.setArchived(command));
  const cancelSearchMail = vi.fn<MailClient['cancelSearchMail']>(() => fake.cancelSearchMail());
  const searchMail = vi.fn<MailClient['searchMail']>((request) => fake.searchMail(request));
  const getConversation = vi.fn<MailClient['getConversation']>((...args) => fake.getConversation(...args));
  let notify = () => {};
  const client: MailClient = {
    ...fake, cancelSearchMail, searchMail, getConversation, setArchived,
    listConversations: async () => {
      const snapshot = await fake.listConversations();
      if (options.singleRow) snapshot.conversations = snapshot.conversations.filter((row) => row.ref.conversationId === rows[0]!.ref.conversationId);
      return snapshot;
    },
    subscribe: async (listener) => { notify = listener; return () => { notify = () => {}; }; },
  };
  const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
  wrapper = w;
  await flushPromises();
  const openRow = async (index = 0) => {
    await w.findAll('.inbox-row')[index]!.trigger('click');
    await flushPromises();
    expect(w.get('.reader-subject').text()).toBe(rows[index]!.subject);
  };
  const senderSearch = async () => {
    const cancellation = deferred<void>();
    cancelSearchMail.mockReturnValueOnce(cancellation.promise);
    await w.get('[data-test="contact-name"]').trigger('click');
    await flushPromises();
    expect(cancelSearchMail).toHaveBeenCalled();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    return cancellation;
  };
  const startArchive = async () => {
    const accepted = deferred<Awaited<ReturnType<MailClient['setArchived']>>>();
    let receipt!: Awaited<ReturnType<MailClient['setArchived']>>;
    setArchived.mockImplementationOnce(async (command) => {
      receipt = await fake.setArchived(command);
      return accepted.promise;
    });
    await w.get('[data-test="reader-archive-toggle"]').trigger('click');
    await flushPromises();
    expect(setArchived).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ conversation: rows[0]!.ref, archived: true }));
    return async () => {
      accepted.resolve(receipt);
      await flushPromises();
      // Acceptance must stand even when its deferred navigation loses ownership.
      expect((await fake.getConversation(rows[0]!.ref)).isInInbox).toBe(false);
    };
  };
  const openActivityReader = async () => {
    await w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    await w.get('[data-test^="activity-open-"]').trigger('click');
    await flushPromises();
    expect(w.get('.reader-subject').text()).toBe(rows[0]!.subject);
  };
  // Contact-history reads are real cached fake searches; these are distinct
  // from the user's submitted traversal (cachedOnly=false at entry).
  const submissions = () => searchMail.mock.calls.filter(([request]) => !request.cachedOnly);
  const press = async (key: string) => {
    w.get('[data-test="reader"]').element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
    await flushPromises();
  };
  return { w, rows, openRow, openActivityReader, startArchive, senderSearch, submissions, getConversation, press, notify: () => notify(), cancelSearchMail };
}

describe('App archive continuation ownership', () => {
  it.each(['neighbor', 'no neighbor', 'Activity origin'] as const)(
    'old archive receipt cannot revoke a newer pending sender search (%s)', async (branch) => {
      const h = await setup({ singleRow: branch === 'no neighbor', activityOrigin: branch === 'Activity origin' });
      if (branch === 'Activity origin') await h.openActivityReader();
      else await h.openRow();
      const sender = h.w.get('[data-test="contact-mailbox"]').text();
      const completeArchive = await h.startArchive();
      const cancellation = await h.senderSearch();
      expect(h.submissions()).toHaveLength(0);
      await completeArchive();
      cancellation.resolve();
      await flushPromises();
      expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
      expect(h.w.find('[data-test="reader"]').exists()).toBe(false);
      expect(h.submissions()).toHaveLength(1);
      expect(h.submissions()[0]![0]).toMatchObject({ query: `from:"${sender}"`, cursor: null, cachedOnly: false });
      expect(h.w.get('[data-test="search-input"]').element).toHaveProperty('value', `from:"${sender}"`);
    },
  );

  it.each(['Close', 'Inbox', 'Done', 'recent link', 'j', 'Activity'] as const)(
    'archive receipt preserves a newer explicit %s destination', async (destination) => {
      const h = await setup();
      await h.openRow();
      const completeArchive = await h.startArchive();
      if (destination === 'Close') await h.w.get('[data-test="reader-close"]').trigger('click');
      else if (destination === 'recent link') await h.w.get('.contact-recent button').trigger('click');
      else if (destination === 'j') await h.press('j');
      else await h.w.get(`[data-test="rail-${destination.toLowerCase()}"]`).trigger('click');
      await flushPromises();
      const location = () => ({
        title: h.w.get('[data-test="inbox-title"]').text(),
        subject: h.w.find('.reader-subject').exists() ? h.w.get('.reader-subject').text() : null,
        activity: h.w.get('[data-test="rail-activity"]').attributes('aria-expanded'),
      });
      const chosen = location();
      if (destination === 'Close' || destination === 'Inbox' || destination === 'Done') expect(chosen.subject).toBeNull();
      else expect(chosen.subject).toBe(h.rows[destination === 'j' ? 1 : 0]!.subject);
      expect(chosen.title).toBe(destination === 'Done' ? 'Cached Done' : 'Inbox');
      expect(chosen.activity).toBe(destination === 'Activity' ? 'true' : 'false');
      await completeArchive();
      expect(location()).toEqual(chosen);
      expect(h.submissions()).toHaveLength(0);
    },
  );

  it.each(['neighbor', 'no neighbor', 'Activity origin'] as const)(
    'archive still navigates normally with no newer intent (%s)', async (branch) => {
      const h = await setup({ singleRow: branch === 'no neighbor', activityOrigin: branch === 'Activity origin' });
      if (branch === 'Activity origin') await h.openActivityReader();
      else await h.openRow();
      const completeArchive = await h.startArchive();
      // Background detail reads must not take ownership from the archive.
      const calls = h.getConversation.mock.calls.length;
      h.notify();
      await flushPromises();
      expect(h.getConversation.mock.calls.length).toBeGreaterThan(calls);
      await completeArchive();
      expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
      if (branch === 'neighbor') expect(h.w.get('.reader-subject').text()).toBe(h.rows[1]!.subject);
      else expect(h.w.find('[data-test="reader"]').exists()).toBe(false);
      expect(h.w.find('[data-test="utility-drawer"]').exists()).toBe(branch === 'Activity origin');
      expect(h.submissions()).toHaveLength(0);
    },
  );
});

describe('App explicit navigation during deferred search cancellation', () => {
  it('Inbox reader → sender search → same-context Inbox rail abandons search and restores the list', async () => {
    const h = await setup();
    const rowId = h.w.get('.inbox-row').attributes('data-test');
    await h.openRow();
    const cancellation = await h.senderSearch();
    await h.w.get('[data-test="rail-inbox"]').trigger('click');
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(false);
    cancellation.resolve();
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.submissions()).toHaveLength(0);
    expect(document.activeElement?.getAttribute('data-test')).toBe(rowId);
  });

  it('submitted query → Inbox row open keeps the newly opened reader after cancellation resolves', async () => {
    const h = await setup();
    await h.w.get('[data-test="search-trigger"]').trigger('click');
    await h.w.get('[data-test="search-input"]').setValue('subject:Fixture');
    const cancellation = deferred<void>();
    h.cancelSearchMail.mockReturnValueOnce(cancellation.promise);
    await h.w.get('form[role="search"]').trigger('submit');
    await flushPromises();
    await h.openRow(1);
    cancellation.resolve();
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(true);
    expect(h.w.get('.reader-subject').text()).toBe(h.rows[1]!.subject);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.submissions()).toHaveLength(0);
  });

  it.each(['Close', 'Escape'] as const)('reader %s abandons a pending sender search and restores entry focus', async (action) => {
    const h = await setup();
    const rowId = h.w.findAll('.inbox-row')[1]!.attributes('data-test');
    await h.openRow(1);
    const cancellation = await h.senderSearch();
    if (action === 'Close') await h.w.get('[data-test="reader-close"]').trigger('click');
    else await h.press('Escape');
    await flushPromises();
    cancellation.resolve();
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.w.find('[data-test="reader"]').exists()).toBe(false);
    expect(h.submissions()).toHaveLength(0);
    expect(document.activeElement?.getAttribute('data-test')).toBe(rowId);
  });

  it('a contact recent-mail link supersedes pending sender search even when reopening the same reader', async () => {
    const h = await setup();
    await h.openRow();
    const cancellation = await h.senderSearch();
    const recent = h.w.get('.contact-recent button');
    const subject = recent.text();
    await recent.trigger('click');
    await flushPromises();
    cancellation.resolve();
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(true);
    expect(h.w.get('.reader-subject').text()).toBe(subject);
    expect(h.submissions()).toHaveLength(0);
  });

  it.each(['j', 'k'])('reader %s movement supersedes pending sender search without changing the Back origin', async (key) => {
    const h = await setup();
    const rowId = h.w.findAll('.inbox-row')[1]!.attributes('data-test');
    await h.openRow(1);
    const cancellation = await h.senderSearch();
    await h.press(key);
    const expected = h.rows[key === 'j' ? 2 : 0]!.subject;
    expect(h.w.get('.reader-subject').text()).toBe(expected);
    cancellation.resolve();
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(true);
    expect(h.w.get('.reader-subject').text()).toBe(expected);
    expect(h.submissions()).toHaveLength(0);
    await h.w.get('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe(rowId);
  });

  it('choosing Activity as a destination supersedes pending sender search', async () => {
    const h = await setup();
    await h.openRow();
    const cancellation = await h.senderSearch();
    await h.w.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    cancellation.resolve();
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(true);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.submissions()).toHaveLength(0);
  });

  it.each(['subscription', 'focus', 'online'] as const)('background reader detail %s refresh allows sender search; a later explicit Close still wins', async (trigger) => {
    const h = await setup();
    await h.openRow();
    const cancellation = await h.senderSearch();
    const detailCalls = h.getConversation.mock.calls.length;
    if (trigger === 'subscription') h.notify();
    else window.dispatchEvent(new Event(trigger));
    await flushPromises();
    expect(h.getConversation.mock.calls.length).toBeGreaterThan(detailCalls);
    expect(h.w.get('.reader-subject').text()).toBe(h.rows[0]!.subject);
    expect(h.submissions()).toHaveLength(0);
    cancellation.resolve();
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect(h.submissions()).toHaveLength(1);
    await h.w.get('[data-test="rail-inbox"]').trigger('click');
    await flushPromises();
    await h.openRow();
    const abandoned = await h.senderSearch();
    await h.w.get('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    abandoned.resolve();
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.submissions()).toHaveLength(1);
  });
});
