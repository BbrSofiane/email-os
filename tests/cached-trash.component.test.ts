import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';

import CachedTrashPanel from '../src/components/CachedTrashPanel.vue';
import { emptyCachedTrash } from '../src/lib/cached-trash';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { deferred, useGmailMode, mountApp, press } from './helpers';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../src/lib/browsing-dates';
import type { CachedTrashSnapshot, ConversationSummary } from '../src/lib/ipc/client';

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
    // One Ash coverage line; the full caveat is its title and hidden text.
    const coverage = wrapper.get('[data-test="cached-trash-coverage"]');
    expect(coverage.text()).toContain('Cached Trash only, not your full Gmail Trash.');
    expect(coverage.attributes('title')).toContain('not your complete Gmail Trash');
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

  it('replaces the four disclaimers with one coverage line and keeps the whole caveat in its title and hidden text', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash');
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state: emptyCachedTrash() } });
    await flushPromises();
    const coverage = wrapper.get('[data-test="cached-trash-coverage"]');
    const caveat = coverage.attributes('title')!;
    for (const part of ['not your complete Gmail Trash', 'total is unknown', 'Trash is not Done', 'Recover', 'permanent delete', 'Empty Trash', 'refresh to see later cache changes', 'Reading does not mark mail read']) {
      expect(caveat).toContain(part);
    }
    expect(coverage.get('.visually-hidden').text()).toBe(caveat);
    expect(coverage.classes()).toContain('drawer-note');
    // The only prose before the first row is that line and the status fragment.
    expect(wrapper.findAll('p').map((p) => p.attributes('data-test'))).toEqual(['cached-trash-coverage', 'cached-trash-count']);
    expect(wrapper.get('[data-test="cached-trash-count"]').attributes('role')).toBe('status');
    expect(wrapper.get('[data-test="cached-trash-count"]').text()).toBe('1 cached · total unknown');
    expect(wrapper.find('section, aside, h1, h2').exists()).toBe(false);
  });

  it('renders one compact button per row: sender, subject and a compact date with its full-date title', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash');
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state: emptyCachedTrash() } });
    await flushPromises();
    const snapshot = await fake.listCachedTrash({ accountId: 'gmail-account', limit: 10, cursor: null });
    const summary = snapshot.conversations.find((row) => row.ref.conversationId === 'conv-04')!;
    const buttons = wrapper.findAll('li button');
    expect(buttons).toHaveLength(snapshot.conversations.length);
    const row = wrapper.get('button[data-id="conv-04"]');
    const sender = summary.primaryCorrespondent;
    expect(row.get('.drawer-sender').text()).toBe(sender ? (sender.displayName ?? sender.mailbox) : 'Unknown sender');
    expect(row.get('.drawer-subject').text()).toBe(summary.subject || '(No subject)');
    const date = row.get('time.drawer-date');
    expect(date.text()).toBe(compactDateLabel(summary.lastMessageAt));
    expect(date.attributes('title')).toBe(fullDateLabel(summary.lastMessageAt));
    expect(date.attributes('datetime')).toBe(machineDateTime(summary.lastMessageAt));
    // Nothing but the row button is interactive in a row (no second control).
    expect(wrapper.findAll('li button, li a')).toHaveLength(snapshot.conversations.length);
  });

  it('says "Unknown sender" and "(No subject)" instead of a blank', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    const state = emptyCachedTrash();
    state.loaded = true;
    state.rows = [{ ref: { accountId: 'gmail-account', conversationId: 'conv-x' }, subject: '', participants: [], lastMessageAt: '2026-01-02T03:04:00Z', pendingOperationId: null } as unknown as ConversationSummary];
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state } });
    await flushPromises();
    const row = wrapper.get('button[data-id="conv-x"]');
    expect(row.get('.drawer-sender').text()).toBe('Unknown sender');
    expect(row.get('.drawer-subject').text()).toBe('(No subject)');
  });

  it('shows the loading status before any data, then the count; the list is aria-busy while loading', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    const late = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash').mockReturnValue(late.promise);
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state: emptyCachedTrash() } });
    await flushPromises();
    const status = wrapper.get('[role="status"]');
    expect(status.text()).toBe('Loading cached Trash…');
    expect(wrapper.get('ul').attributes('aria-busy')).toBe('true');
    // Before data there is no count, no empty claim and no row.
    expect(wrapper.find('[data-test="cached-trash-count"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain('No known cached');
    expect(wrapper.findAll('li')).toHaveLength(0);
    // The status line comes before the list in document order.
    const order = wrapper.element.innerHTML;
    expect(order.indexOf('Loading cached Trash…')).toBeLessThan(order.indexOf('cached-trash-list'));
    late.resolve({ conversations: [], nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: null });
    await flushPromises();
    expect(wrapper.find('[role="status"]').exists()).toBe(false);
    expect(wrapper.get('ul').attributes('aria-busy')).toBe('false');
    expect(wrapper.text()).toContain('does not mean your Gmail Trash is empty');
  });

  it('names Refresh and Load more as cached-Trash actions and moves between rows with J/K and arrows', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash'); fake.controls.markTriage('conv-05', 'trash'); fake.controls.markTriage('conv-06', 'trash');
    wrapper = mount(CachedTrashPanel, { props: { client: fake, accountId: 'gmail-account', state: emptyCachedTrash() }, attachTo: document.body });
    await flushPromises();
    const refresh = wrapper.get('button[aria-label="Refresh cached Trash"]');
    expect(refresh.text()).toBe('Refresh');
    expect(refresh.attributes('title')).toBe('Refresh cached Trash');
    const rows = wrapper.findAll('button[data-id]');
    expect(rows.length).toBeGreaterThanOrEqual(3);
    expect(rows.map((row) => row.attributes('tabindex'))).toEqual(rows.map((_, index) => (index === 0 ? '0' : '-1')));
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rows[1]!.element);
    rows[1]!.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rows[2]!.element);
    rows[2]!.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rows[0]!.element);
    rows[0]!.element.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(rows.at(-1)!.element);
    await flushPromises();
    expect(rows.map((row) => row.attributes('tabindex')).filter((value) => value === '0')).toHaveLength(1);
    expect(rows.at(-1)!.attributes('tabindex')).toBe('0');
    // Enter is the native button activation: the row opens the conversation.
    await rows[1]!.trigger('click');
    expect(wrapper.emitted('open')![0]).toEqual([expect.objectContaining({ conversationId: rows[1]!.attributes('data-id') })]);
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
