import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { createBrowserFakeMailClient, useGmailMode, mountApp } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

async function toggleFilter(w: VueWrapper, label: string): Promise<void> {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await w.get('[data-test="action-query"]').setValue(label);
  await w.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
}

it('filters through Commands without a button, excludes unknowns, preserves total badges and follows contexts', async () => {
  const fake = createBrowserFakeMailClient();
  const snapshot = await fake.listConversations();
  await fake.saveSavedSplit(snapshot.conversations[0]!.ref.accountId, {
    name: 'Clients', criterion: 'domain', value: 'example.test', enabled: true, hideWhenEmpty: false,
  });
  const unknown = { ...snapshot.conversations[2]! };
  delete unknown.isRead;
  const rows = [{ ...snapshot.conversations[0]!, isRead: false }, { ...snapshot.conversations[1]!, isRead: true }, unknown];
  const client = { ...fake, listConversations: async () => ({ ...snapshot, conversations: rows }) };
  const archive = vi.spyOn(client, 'setArchived');
  const read = vi.spyOn(client, 'setRead');
  wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  expect(wrapper.find('[data-test="unread-filter"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(false);
  await wrapper.get('[data-test="navigator-trigger"]').trigger('click');
  expect(wrapper.find('#action-toggle-unread-filter').exists()).toBe(false);
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Escape' });
  await wrapper.get(`[data-test="row-select-${rows[0]!.ref.conversationId}"]`).setValue(true);
  await toggleFilter(wrapper, 'Show unread only');
  expect(wrapper.find('[data-test="selection-live"]').exists()).toBe(false);
  expect(wrapper.findAll('.inbox-row')).toHaveLength(1);
  expect(document.activeElement).toBe(wrapper.get('.inbox-row').element);
  expect(wrapper.get('[data-test="unread-filter-status"]').text()).toBe('Unread only');
  expect(wrapper.get('[data-test="split-inbox"]').text()).toContain('3');
  expect(wrapper.get('[data-test="split-saved"]').text()).toContain('3');
  await wrapper.get('[data-test="split-saved"]').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.inbox-row')).toHaveLength(1);
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(true);
  await wrapper.get('[data-test="rail-done"]').trigger('click');
  await flushPromises();
  expect(wrapper.get('[data-test="inbox-empty"]').text()).toContain('Commands → Show all conversations');
  await toggleFilter(wrapper, 'Show all conversations');
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(false);
  await wrapper.get('[data-test="split-saved"]').trigger('click');
  await flushPromises();
  expect(wrapper.findAll('.inbox-row')).toHaveLength(3);
  expect(archive).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

it('can turn off an empty unread view and restores keyboard focus', async () => {
  const fake = createBrowserFakeMailClient();
  const snapshot = await fake.listConversations();
  const client = { ...fake, listConversations: async () => ({ ...snapshot, conversations: snapshot.conversations.map((row) => ({ ...row, isRead: true })) }) };
  wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await toggleFilter(wrapper, 'Show unread only');
  expect(document.activeElement).toBe(wrapper.get('[data-test="inbox-empty"]').element);
  expect(wrapper.get('[data-test="inbox-empty"]').text()).toContain('Show all conversations');
  await toggleFilter(wrapper, 'Show all conversations');
  expect(wrapper.findAll('.inbox-row')).toHaveLength(snapshot.conversations.length);
  expect(document.activeElement).toBe(wrapper.get('.inbox-row').element);
});

it('is available in read-only Gmail and resets on account change', async () => {
  const fake = createBrowserFakeMailClient();
  useGmailMode(fake, { mutationAccess: 'read_only' });
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await toggleFilter(wrapper, 'Show unread only');
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(true);
  fake.controls.setAccount({ mode: 'fixture' });
  await flushPromises();
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(false);
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  expect(wrapper.get('#action-toggle-unread-filter .action-copy > span').text()).toBe('Show unread only');
});

it('closes the reader when filtering without marking or archiving mail', async () => {
  const fake = createBrowserFakeMailClient();
  const read = vi.spyOn(fake, 'setRead');
  const archive = vi.spyOn(fake, 'setArchived');
  wrapper = mountApp(fake, 'native', { attachTo: document.body });
  await flushPromises();
  await wrapper.get('.inbox-row').trigger('click');
  await flushPromises();
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true }));
  await flushPromises();
  await wrapper.get('[data-test="action-query"]').setValue('Show unread only');
  await wrapper.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  expect(wrapper.find('[data-test="reader"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(true);
  expect(read).not.toHaveBeenCalled();
  expect(archive).not.toHaveBeenCalled();
});

it('does not steal focus from a palette opened during a delayed filter refresh', async () => {
  const fake = createBrowserFakeMailClient();
  const snapshot = await fake.listConversations();
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  let release!: () => void;
  vi.spyOn(fake, 'listConversations').mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(snapshot); }));
  await toggleFilter(wrapper, 'Show unread only');
  expect(wrapper.find('[data-test="inbox-loading"]').exists()).toBe(true);
  await wrapper.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  release();
  await flushPromises();
  expect(document.activeElement).toBe(wrapper.get('[data-test="action-query"]').element);
});
