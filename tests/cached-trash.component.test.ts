import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import CachedTrashPanel from '../src/components/CachedTrashPanel.vue';
import { emptyCachedTrash } from '../src/lib/cached-trash';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { deferred, useGmailMode, mountApp, press } from './helpers';
import type { CachedTrashSnapshot } from '../src/lib/ipc/client';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
async function goTrash(w: VueWrapper) {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await w.get('[data-test="action-query"]').setValue('Go to cached Trash');
  press('Enter', { bubbles: true, cancelable: true });
  await flushPromises();
}

describe('UX-10 A read-only cached Trash', () => {
  it('opens the exact account+ID, suppresses mailbox shortcuts/reply and returns to the saved Trash row', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash');
    fake.controls.markTriage('conv-07', 'spam');
    const get = vi.spyOn(fake, 'getConversation');
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const group = vi.spyOn(fake, 'setArchivedGroup');
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    expect(wrapper.find('[data-test="conversation-row-conv-04"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="conversation-row-conv-07"]').exists()).toBe(false);
    await wrapper.get('[data-test="row-select-conv-01"]').setValue(true);
    await goTrash(wrapper);
    expect(wrapper.text()).toContain('not your complete Gmail Trash');
    const row = wrapper.get('button[data-id="conv-04"]');
    expect(wrapper.find('button[data-id="conv-07"]').exists()).toBe(false);
    await row.trigger('click'); await flushPromises();
    expect(get).toHaveBeenLastCalledWith({ accountId: 'gmail-account', conversationId: 'conv-04' }, false);
    expect(wrapper.find('[data-test="prepare-reply"]').exists()).toBe(false);
    const calls = get.mock.calls.length;
    for (const value of ['e', 'E', 'U', 'z', 'j', 'k']) press(value, { bubbles: true, cancelable: true });
    await flushPromises();
    expect(get).toHaveBeenCalledTimes(calls);
    expect(archive).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(group).not.toHaveBeenCalled();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(wrapper.get('[data-test="utility-drawer"]').text()).toContain('Cached Trash');
    expect(document.activeElement?.getAttribute('data-id')).toBe('conv-04');
    await wrapper.get('[data-test="drawer-close"]').trigger('click'); await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('rail-trash');
    expect(wrapper.find('[data-test="selection-bar"]').exists()).toBe(false);
  });

  it('omits the destination for unsupported fixture mode and rejects direct fake calls', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.listCachedTrash({ accountId: 'gmail-account', limit: 10, cursor: null })).rejects.toEqual({ kind: 'invalid_request', field: 'mode' });
    wrapper = mountApp(fake, 'browser-preview', {  }); await flushPromises();
    await wrapper.get('[data-test="palette-trigger"]').trigger('click');
    await wrapper.get('[data-test="action-query"]').setValue('Trash');
    expect(wrapper.find('[role="option"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="rail-trash"]').exists()).toBe(false);
  });

  it('keeps Trash distinct from archived Done and validates account, bound and cursor', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
    await fake.setArchived({ conversation: { accountId: 'gmail-account', conversationId: 'conv-01' }, archived: true, requestId: 'done-before-trash' });
    fake.controls.markTriage('conv-01', 'trash'); fake.controls.markTriage('conv-02', 'trash');
    const request = { accountId: 'gmail-account', limit: 1, cursor: null };
    const first = await fake.listCachedTrash(request);
    const next = await fake.listCachedTrash({ ...request, cursor: first.nextCursor });
    expect(first.conversations).toHaveLength(1); expect(next.conversations).toHaveLength(1);
    expect(first.conversations[0]!.ref).not.toEqual(next.conversations[0]!.ref);
    expect((await fake.listCachedDone({ ...request, limit: 100 })).conversations).toEqual([]);
    await expect(fake.listCachedTrash({ ...request, accountId: 'foreign' })).rejects.toEqual({ kind: 'not_found' });
    await expect(fake.listCachedTrash({ ...request, limit: 101 })).rejects.toEqual({ kind: 'invalid_request', field: 'limit' });
    await expect(fake.listCachedTrash({ ...request, cursor: 'cached-done-v1:[]' })).rejects.toEqual({ kind: 'invalid_request', field: 'cursor' });
  });

  it('distinguishes failure from empty results and retries the same read query', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    const query = vi.spyOn(fake, 'listCachedTrash').mockRejectedValueOnce({ kind: 'storage_unavailable' });
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state: emptyCachedTrash() } });
    await flushPromises();
    expect(wrapper.get('[role="alert"]').text()).toContain('storage_unavailable');
    expect(wrapper.text()).not.toContain('No known cached');
    await wrapper.get('[role="alert"] button').trigger('click'); await flushPromises();
    expect(query).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain('does not mean your Gmail Trash is empty');
  });

  it('does not apply a delayed page after unmount/account departure', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    const late = deferred<CachedTrashSnapshot>(); vi.spyOn(fake, 'listCachedTrash').mockReturnValue(late.promise);
    const state = emptyCachedTrash();
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state } });
    wrapper.unmount(); wrapper = null;
    late.resolve({ conversations: [], nextCursor: 'stale', coverage: 'local_cache', exactTotal: null, lastSyncedAt: null });
    await flushPromises(); expect(state.loaded).toBe(false); expect(state.cursor).toBeNull();
  });
});
