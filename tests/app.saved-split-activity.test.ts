import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { createBrowserFakeMailClient, useGmailMode, mountApp } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

it.each(['matching', 'nonmatching', 'unread-filtered', 'unavailable'] as const)(
  'directly unarchives an Activity target with a %s saved projection and no reader', async (projection) => {
    const fake = createBrowserFakeMailClient();
    if (projection === 'unread-filtered') useGmailMode(fake, { mutationAccess: 'enabled' });
    const target = (await fake.listConversations()).conversations[0]!;
    if (projection === 'unread-filtered') {
      await fake.setRead({ conversation: target.ref, read: true, requestId: 'seed-read' });
      await fake.controls.flush();
    }
    await fake.saveSavedSplit(target.ref.accountId, {
      name: 'Clients', criterion: 'sender',
      value: projection === 'nonmatching' ? 'other@example.test' : target.primaryCorrespondent!.mailbox,
      enabled: true, hideWhenEmpty: false,
    });
    const archived = await fake.setArchived({ conversation: target.ref, archived: true, requestId: 'direct-activity-target' });
    await fake.controls.flush();
    let unavailable = false;
    const getConversation = vi.fn(fake.getConversation);
    const setArchived = vi.fn(fake.setArchived);
    const client = {
      ...fake, getConversation, setArchived,
      getSavedSplit: (account: string) => unavailable
        ? Promise.reject({ kind: 'storage_unavailable' }) : fake.getSavedSplit(account),
    };
    wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    if (projection === 'unread-filtered') {
      // Restoring Inbox membership must not change this known-read target.
      await wrapper.get('[data-test="palette-trigger"]').trigger('click');
      await wrapper.get('#action-toggle-unread-filter').trigger('click');
      await flushPromises();
    }
    await wrapper.get('[data-test="split-saved"]').trigger('click');
    await flushPromises();
    if (projection === 'unavailable') {
      unavailable = true;
      window.dispatchEvent(new Event('focus'));
      await flushPromises();
    }
    await wrapper.get('[data-test="rail-activity"]').trigger('click');
    await flushPromises();
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(false);
    await wrapper.get(`[data-test="activity-unarchive-${archived.operationId}"]`).trigger('click');
    await fake.controls.flush();
    await flushPromises();
    expect(setArchived).toHaveBeenCalledTimes(1);
    expect(setArchived.mock.calls[0]![0]).toMatchObject({ conversation: target.ref, archived: false });
    expect(getConversation).not.toHaveBeenCalled();
    expect((await fake.getConversation(target.ref)).isInInbox).toBe(true);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="utility-drawer"]').exists()).toBe(true);
    await wrapper.get('[data-test="drawer-close"]').trigger('click');
    await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Clients');
    expect(wrapper.find(`[data-test="conversation-row-${target.ref.conversationId}"]`).exists()).toBe(projection === 'matching');
    if (projection === 'unavailable') expect(wrapper.find('[data-test="inbox-error"]').exists()).toBe(true);
  },
);

it('opens an archived Activity target from a saved split and restores it without widening list membership', async () => {
  const fake = createBrowserFakeMailClient();
  const target = (await fake.listConversations()).conversations[0]!;
  await fake.saveSavedSplit(target.ref.accountId, { name: 'Clients', criterion: 'sender', value: target.primaryCorrespondent!.mailbox, enabled: true, hideWhenEmpty: false });
  const archived = await fake.setArchived({ conversation: target.ref, archived: true, requestId: 'activity-target' });
  await fake.controls.flush();
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await wrapper.get('[data-test="split-saved"]').trigger('click');
  await flushPromises();
  expect(wrapper.find(`[data-test="conversation-row-${target.ref.conversationId}"]`).exists()).toBe(false);
  await wrapper.get('[data-test="rail-activity"]').trigger('click');
  await flushPromises();
  await wrapper.get(`[data-test="activity-open-${archived.operationId}"]`).trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
  expect(wrapper.get('.reader-subject').text()).toBe(target.subject);
  await wrapper.get('[data-test="reader-archive-toggle"]').trigger('click');
  await fake.controls.flush();
  await flushPromises();
  expect((await fake.getConversation(target.ref)).isInInbox).toBe(true);
  await wrapper.get('[data-test="reader-close"]').trigger('click');
  await flushPromises();
  expect(wrapper.find('[data-test="utility-drawer"]').exists()).toBe(true);
});
