import { afterEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { useMailbox } from '../src/composables/useMailbox';
import { createBrowserFakeMailClient, deferred, useGmailMode, mountApp } from './helpers';
import type { InboxSnapshot, SavedSplit } from '../src/lib/ipc/client';

let wrapper: VueWrapper | null = null;
const stops: (() => void)[] = [];
afterEach(() => { wrapper?.unmount(); wrapper = null; stops.splice(0).forEach(stop => stop()); });
const split: SavedSplit = { name: 'Clients', criterion: 'domain', value: 'example.test', enabled: true, hideWhenEmpty: false };
async function command(id: string) {
  await wrapper!.get('[data-test="palette-trigger"]').trigger('click');
  await wrapper!.get(`#action-${id}`).trigger('click');
  await flushPromises();
}

it('intersects independent cached filters, excludes unknowns, retains totals, and restores starred history without resetting session unread', async () => {
  const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
  const snap = await fake.listConversations();
  const account = snap.conversations[0]!.ref.accountId;
  await fake.saveSavedSplit(account, split);
  const rows = snap.conversations.slice(0, 4).map((row, i) => ({ ...row,
    isRead: i === 2 ? true : i === 3 ? undefined : false,
    stars: i === 1 ? undefined : { totalMessages: 1, knownMessages: 1, starredMessages: 1 },
  }));
  const client = { ...fake, listConversations: async () => ({ ...snap, conversations: rows }) };
  const read = vi.spyOn(client, 'setRead');
  wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await wrapper.get('[data-test="split-saved"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-test="starred-filter"]').trigger('click'); await flushPromises();
  expect(wrapper.findAll('.inbox-row')).toHaveLength(3);
  await command('toggle-unread-filter');
  expect(wrapper.findAll('.inbox-row').map(row => row.attributes('data-test'))).toEqual([`conversation-row-${rows[0]!.ref.conversationId}`]);
  expect(wrapper.get('[data-test="split-saved"]').text()).toContain('4');
  expect(wrapper.get('[data-test="starred-filter"]').attributes('aria-pressed')).toBe('true');
  await wrapper.get('[data-test="rail-starred"]').trigger('click'); await flushPromises();
  await wrapper.get('[data-test="context-back"]').trigger('click'); await flushPromises();
  expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Clients');
  expect(wrapper.get('[data-test="starred-filter"]').attributes('aria-pressed')).toBe('true');
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(true);
  expect(wrapper.findAll('.inbox-row')).toHaveLength(1);
  await command('toggle-unread-filter');
  expect(wrapper.findAll('.inbox-row')).toHaveLength(3); // starred remains active
  expect(read).not.toHaveBeenCalled();
  await command('toggle-unread-filter');
  expect(wrapper.findAll('.inbox-row')).toHaveLength(1);
  fake.controls.setAccount({ mode: 'fixture' });
  await flushPromises();
  expect(wrapper.find('[data-test="unread-filter-status"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="starred-filter"]').exists()).toBe(false);
  useGmailMode(fake, { mutationAccess: 'enabled' }); await flushPromises();
  expect(wrapper.get('[data-test="starred-filter"]').attributes('aria-pressed')).toBe('false');
  expect(wrapper.find('[data-test="context-back"]').exists()).toBe(false);
});

it('keeps command-only split editing with exact selected Star/Unstar groups, Undo and archived cached Starred', async () => {
  const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
  const snap = await fake.listConversations();
  await fake.saveSavedSplit(snap.conversations[0]!.ref.accountId, split);
  const group = vi.spyOn(fake, 'setStarredGroup'); const single = vi.spyOn(fake, 'setStarred');
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await wrapper.get('[data-test="split-saved"]').trigger('click'); await flushPromises();
  const targets = [snap.conversations[1]!.ref, snap.conversations[3]!.ref];
  for (const target of targets) await wrapper.get(`[data-test="row-select-${target.conversationId}"]`).setValue(true);
  await command('star'); await fake.controls.flush(); await flushPromises();
  expect(group).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ members: targets, starred: true }));
  expect(single).not.toHaveBeenCalled();
  await command('unstar'); await fake.controls.flush(); await flushPromises();
  expect(group.mock.calls[1]![0]).toMatchObject({ members: targets, starred: false });
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', bubbles: true }));
  await fake.controls.flush(); await flushPromises();
  for (const target of targets) expect((await fake.getConversation(target)).stars?.starredMessages).toBeGreaterThan(0);
  await fake.setArchived({ conversation: targets[0]!, archived: true, requestId: 'archive-combined' });
  await fake.controls.flush(); await flushPromises();
  expect(wrapper.find(`[data-test="conversation-row-${targets[0]!.conversationId}"]`).exists()).toBe(false);
  await wrapper.get('[data-test="rail-starred"]').trigger('click'); await flushPromises();
  expect(wrapper.find(`[data-test="conversation-row-${targets[0]!.conversationId}"]`).exists()).toBe(true);
  await wrapper.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
  expect(wrapper.find('#action-create-split').exists()).toBe(false);
  for (const id of ['edit-split', 'star', 'unstar', 'toggle-unread-filter']) expect(wrapper.find(`#action-${id}`).exists()).toBe(true);
  expect(wrapper.find('[data-test="split-settings"]').exists()).toBe(false);
  expect(wrapper.find('[data-test="star-action"]').exists()).toBe(false);
});

it('keeps cached Starred paging independent of failed split reads and advances unfiltered boundaries on empty filtered pages', async () => {
  const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
  const snapshot = await fake.listConversations();
  const rows = snapshot.conversations.slice(0, 3).map(row => ({ ...row, isRead: true,
    stars: { totalMessages: 1, knownMessages: 1, starredMessages: 1 },
  }));
  rows[2]!.isRead = false;
  const page = vi.fn(async (request: { cursor: string | null }) => {
    const i = request.cursor === 'page-2' ? 1 : request.cursor === 'page-3' ? 2 : 0;
    return { coverage: 'local_cache' as const, conversations: [rows[i]!], nextCursor: i < 2 ? `page-${i + 2}` : null, exactTotal: null, lastSyncedAt: null };
  });
  const client = { ...fake, listCachedStarred: page, getSavedSplit: async () => { throw { kind: 'storage_unavailable' }; } };
  const scope = effectScope(); stops.push(() => scope.stop());
  const box = scope.run(() => useMailbox(client))!; await box.ready;
  await box.setUnreadOnly(true); await box.setContext('starred');
  expect(box.listState.value).toBe('ready'); expect(box.conversations.value).toEqual([]);
  expect(box.nextCursor.value).toBe('page-2');
  await box.loadMore();
  expect(box.conversations.value).toEqual([]); expect(box.nextCursor.value).toBe('page-3');
  expect(box.loadedDoneBoundary.value).toEqual({ lastMessageAt: rows[1]!.lastMessageAt, conversationId: rows[1]!.ref.conversationId });
  await box.loadMore(); expect(box.conversations.value.map(row => row.ref)).toEqual([rows[2]!.ref]);
  expect(box.exactTotal.value).toBeNull(); expect(box.nextCursor.value).toBeNull();
});

it('fences stale single and frozen group stars after saved rule invalidation', async () => {
  const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
  const snap = await fake.listConversations(); await fake.saveSavedSplit(snap.conversations[0]!.ref.accountId, split);
  const single = vi.spyOn(fake, 'setStarred'); const group = vi.spyOn(fake, 'setStarredGroup');
  const scope = effectScope(); stops.push(() => scope.stop());
  const client = { ...fake, subscribe: async () => () => undefined };
  const box = scope.run(() => useMailbox(client))!; await box.ready; await box.setContext('saved');
  const target = box.conversations.value[0]!.ref;
  const gate = deferred<InboxSnapshot>();
  vi.spyOn(client, 'listConversations').mockReturnValueOnce(gate.promise);
  const saving = box.saveSplit({ ...split, value: 'absent.test' });
  await flushPromises();
  expect(box.listState.value).toBe('loading');
  expect(await box.setStarred(target, true)).toBeNull();
  expect(await box.setStarredGroup([target], true)).toBe(false);
  expect(single).not.toHaveBeenCalled(); expect(group).not.toHaveBeenCalled();
  gate.resolve(snap); await saving;
  expect(box.conversations.value).toEqual([]);
});
