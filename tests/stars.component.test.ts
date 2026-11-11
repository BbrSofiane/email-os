import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { createBrowserFakeMailClient, fixtureRef as nativeFixtureRef, useGmailMode, mountApp, flushFakeClientAndVueUpdates, press } from './helpers';

const fixtureRef = (conversationId: string) => ({accountId:'gmail-account',conversationId});
let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
async function command(w: VueWrapper, id: 'star' | 'unstar') {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  await w.get('[data-test="action-query"]').setValue(id);
  await w.get(`#action-${id}`).trigger('click');
  await flushPromises();
}
async function setup(mutationAccess: 'enabled' | 'read_only' | 'upgrading' = 'enabled') {
  const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess });
  wrapper = mountApp(fake, 'browser-preview', {attachTo:document.body });
  await flushFakeClientAndVueUpdates(fake); return {fake,w:wrapper};
}

describe('browses synthetic cached star facts in memory (UX-08)', () => {
  it('S stars without reading; archived mail appears in cache-scoped Starred; unstar removes it', async () => {
    const {fake,w} = await setup();
    const before = await fake.getConversation(fixtureRef('conv-01'));
    await w.find('[data-test="conversation-row-conv-01"]').trigger('keydown',{key:'s'}); await flushFakeClientAndVueUpdates(fake);
    expect((await fake.getConversation(before.ref)).isRead).toBe(before.isRead);
    expect(w.find('[data-test="row-stars"]').text()).toContain('★');
    await fake.setArchived({conversation:before.ref,archived:true,requestId:'archive'}); await flushFakeClientAndVueUpdates(fake);
    await w.find('[data-test="rail-starred"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="inbox-title"]').text()).toBe('Cached Starred');
    expect(w.find('[data-test="starred-coverage"]').text()).toContain('not provider-complete');
    expect(w.find('[data-test="conversation-row-conv-01"]').exists()).toBe(true);
    await command(w, 'unstar'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="inbox-empty"]').text()).toContain('No known starred');
    expect((await fake.getConversation(before.ref)).isInInbox).toBe(false);
    expect((await fake.getConversation(before.ref)).isRead).toBe(before.isRead);
    expect(w.find('[data-test="preview-banner"]').text()).toContain('memory');
  });

  it('bulk Star uses exactly selected references and group Undo, not a focused single', async () => {
    const {fake,w} = await setup();
    const group = vi.spyOn(fake,'setStarredGroup'); const single = vi.spyOn(fake,'setStarred');
    for(const id of ['conv-02','conv-04']) await w.find(`[data-test="row-select-${id}"]`).setValue(true);
    await command(w, 'star'); await flushFakeClientAndVueUpdates(fake);
    expect(group).toHaveBeenCalledTimes(1); expect(single).not.toHaveBeenCalled();
    expect(group.mock.calls[0]![0].members).toEqual(['conv-02','conv-04'].map(fixtureRef));
    expect(group.mock.calls[0]![0].starred).toBe(true);
    expect((await fake.getConversation(fixtureRef('conv-01'))).stars?.starredMessages).toBe(0);
    expect(w.find('[data-test="action-notice"]').text()).toContain('Star');
    press('z', { bubbles: true }, window); await flushFakeClientAndVueUpdates(fake);
    for(const id of ['conv-02','conv-04']) expect((await fake.getConversation(fixtureRef(id))).stars?.starredMessages).toBe(0);
  });

  it('unstar from the reader advances next then Back stays in Starred, and context Back restores Inbox', async () => {
    const {fake,w} = await setup();
    for(const id of ['conv-01','conv-02','conv-03']) await fake.setStarred({conversation:fixtureRef(id),starred:true,requestId:id});
    await flushFakeClientAndVueUpdates(fake);
    await w.find('[data-test="rail-starred"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    await w.find('[data-test="conversation-row-conv-02"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    await command(w, 'unstar'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 3');
    press('Escape', { bubbles: true }, window); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="inbox-title"]').text()).toBe('Cached Starred');
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-conv-03');
    await w.find('[data-test="context-back"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="inbox-title"]').text()).toBe('Inbox');
  });

  it('S does not mutate while typing in the palette or during IME/modifier input', async () => {
    const {fake,w} = await setup(); const setter = vi.spyOn(fake,'setStarred');
    await w.find('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    await w.find('[data-test="action-query"]').trigger('keydown',{key:'s'});
    expect(setter).not.toHaveBeenCalled();
    press('Escape', { bubbles: true }, window); await flushPromises();
    for(const init of [{key:'s',isComposing:true},{key:'s',metaKey:true},{key:'s',ctrlKey:true}]) {
      press(init.key ?? '', { ...init, bubbles: true }, window);
    }
    await flushFakeClientAndVueUpdates(fake); expect(setter).not.toHaveBeenCalled();
  });

  it('the single starred filter preserves Inbox membership, unstar empties it and Back restores the filter', async () => {
    const {fake,w} = await setup();
    await command(w, 'star'); await flushFakeClientAndVueUpdates(fake);
    await w.find('[data-test="starred-filter"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    expect(w.findAll('.inbox-row')).toHaveLength(1);
    await w.find('[data-test="rail-starred"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    await w.find('[data-test="context-back"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="starred-filter"]').attributes('aria-pressed')).toBe('true');
    await command(w, 'unstar'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[data-test="inbox-empty"]').text()).toContain('No known starred');
    expect((await fake.getConversation(fixtureRef('conv-01'))).isInInbox).toBe(true);
    await w.find('[data-test="starred-filter"]').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    expect(w.findAll('.inbox-row')).toHaveLength(18);
  });

  it('cache paging keeps a continuation on empty candidate pages and rejects cross-context/account cursors', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake, {mutationAccess:'enabled'});
    await fake.setStarred({conversation:fixtureRef('conv-02'),starred:true,requestId:'page-star'});
    await fake.controls.flush();
    const request = {accountId:'gmail-account',limit:1,cursor:null as string | null};
    const first = await fake.listCachedStarred(request);
    expect(first.conversations).toHaveLength(0);
    expect(first.nextCursor).toMatch(/^cached-starred-v1:/);
    const second = await fake.listCachedStarred({...request,cursor:first.nextCursor});
    expect(second.conversations.map(row=>row.ref)).toEqual([fixtureRef('conv-02')]);
    expect(second.exactTotal).toBeNull();
    await expect(fake.listCachedStarred({...request,cursor:first.nextCursor!.replace('cached-starred-v1:','cached-done-v1:')})).rejects.toMatchObject({kind:'invalid_request'});
    await expect(fake.listCachedStarred({...request,accountId:'other'})).rejects.toMatchObject({kind:'not_found'});
  });

  it('native Cmd+K → st → Enter dispatches Star on the focused target, without header action buttons', async () => {
    const {fake,w} = await setup();
    await w.setProps({mode:'native'});
    const setter = vi.spyOn(fake,'setStarred');
    const row = w.get('[data-test="conversation-row-conv-02"]');
    (row.element as HTMLElement).focus();
    await row.trigger('keydown',{key:'k',metaKey:true}); await flushPromises();
    await w.get('[data-test="action-query"]').setValue('st');
    expect(w.get('#action-star kbd').text()).toBe('S');
    expect(w.find('[data-test="star-action"]').exists()).toBe(false);
    expect(w.find('[data-test="unstar-action"]').exists()).toBe(false);
    await w.get('[data-test="action-query"]').trigger('keydown',{key:'Enter'}); await flushFakeClientAndVueUpdates(fake);
    expect(setter).toHaveBeenCalledTimes(1);
    expect(setter.mock.calls[0]![0]).toMatchObject({conversation:fixtureRef('conv-02'),starred:true});
    expect((await fake.getConversation(fixtureRef('conv-02'))).stars?.starredMessages).toBeGreaterThan(0);
    expect(w.find('[role="dialog"]').exists()).toBe(false);
  });

  it.each(['read_only','upgrading'] as const)('explains %s access in native commands; S opens Account without requesting permission or writing', async access => {
    const {fake,w} = await setup(access);
    await w.setProps({mode:'native'});
    const setter = vi.spyOn(fake,'setStarred');
    const group = vi.spyOn(fake,'setStarredGroup');
    const upgrade = vi.spyOn(fake,'enableMailboxActions');
    expect(w.get('[data-test="mailbox-access-hint"]').text()).toContain(access === 'upgrading' ? 'pending' : 'read-only');
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    await w.get('[data-test="action-query"]').setValue('st');
    expect(w.get('#action-star').attributes('aria-disabled')).toBe('true');
    expect(w.get('#action-unstar').attributes('aria-disabled')).toBe('true');
    expect(w.get('#action-star').text()).toContain(access === 'upgrading' ? 'Waiting for Google permission' : 'Enable mailbox actions');
    await w.get('[data-test="action-query"]').trigger('keydown',{key:'Enter'});
    await w.get('#action-star').trigger('click'); await flushFakeClientAndVueUpdates(fake);
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    await w.get('[data-test="action-query"]').trigger('keydown',{key:'Escape'}); await flushPromises();
    await w.get('[data-test="conversation-row-conv-01"]').trigger('keydown',{key:'s'}); await flushFakeClientAndVueUpdates(fake);
    expect(w.get('[data-test="account-panel"]').text()).toContain(access === 'upgrading' ? 'upgrade in progress' : 'Enable mailbox actions');
    expect(setter).not.toHaveBeenCalled(); expect(group).not.toHaveBeenCalled(); expect(upgrade).not.toHaveBeenCalled();
  });

  it('keeps commands guarded if permission changes while the palette is open', async () => {
    const {fake,w} = await setup(); const setter = vi.spyOn(fake,'setStarred');
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    await w.get('[data-test="action-query"]').setValue('star');
    fake.controls.setAccount({mutationAccess:'read_only'}); await flushFakeClientAndVueUpdates(fake);
    expect(w.get('#action-star').attributes('aria-disabled')).toBe('true');
    await w.get('[data-test="action-query"]').trigger('keydown',{key:'Enter'}); await flushFakeClientAndVueUpdates(fake);
    expect(setter).not.toHaveBeenCalled();
  });

  it('surfaces a native command permission rejection instead of reporting success', async () => {
    const {fake,w} = await setup(); await w.setProps({mode:'native'});
    vi.spyOn(fake,'setStarred').mockRejectedValueOnce({kind:'permission_required'});
    await command(w,'star'); await flushFakeClientAndVueUpdates(fake);
    expect(w.get('[data-test="command-error"]').text()).toContain('Google permission required');
    expect((await fake.getConversation(fixtureRef('conv-01'))).stars?.starredMessages).toBe(0);
  });

  it('fixture profile has no unsupported star controls or destination', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mountApp(fake, 'browser-preview', {}); await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="star-action"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="rail-starred"]').exists()).toBe(false);
    await expect(fake.setStarred({conversation:nativeFixtureRef('conv-01'),starred:true,requestId:'no'})).rejects.toMatchObject({kind:'read_only'});
  });
});
