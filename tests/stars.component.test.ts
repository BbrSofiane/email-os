import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient, fixtureRef as nativeFixtureRef, useGmailMode } from './helpers';
import type { BrowserFake } from './helpers';

const fixtureRef = (conversationId: string) => ({accountId:'gmail-account',conversationId});
let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
async function settle(fake: BrowserFake) { await flushPromises(); await fake.controls.flush(); await flushPromises(); }
async function setup() {
  const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
  wrapper = mount(App, { props:{client:fake,mode:'browser-preview'},attachTo:document.body });
  await settle(fake); return {fake,w:wrapper};
}

describe('UX-08 synthetic star browsing (memory only)', () => {
  it('S stars without reading; archived mail appears in cache-scoped Starred; unstar removes it', async () => {
    const {fake,w} = await setup();
    const before = await fake.getConversation(fixtureRef('conv-01'));
    await w.find('[data-test="conversation-row-conv-01"]').trigger('keydown',{key:'s'}); await settle(fake);
    expect((await fake.getConversation(before.ref)).isRead).toBe(before.isRead);
    expect(w.find('[data-test="row-stars"]').text()).toContain('★');
    await fake.setArchived({conversation:before.ref,archived:true,requestId:'archive'}); await settle(fake);
    await w.find('[data-test="rail-starred"]').trigger('click'); await settle(fake);
    expect(w.find('[data-test="inbox-title"]').text()).toBe('Cached Starred');
    expect(w.find('[data-test="starred-coverage"]').text()).toContain('not provider-complete');
    expect(w.find('[data-test="conversation-row-conv-01"]').exists()).toBe(true);
    await w.find('[data-test="unstar-action"]').trigger('click'); await settle(fake);
    expect(w.find('[data-test="inbox-empty"]').text()).toContain('No known starred');
    expect((await fake.getConversation(before.ref)).isInInbox).toBe(false);
    expect((await fake.getConversation(before.ref)).isRead).toBe(before.isRead);
    expect(w.find('[data-test="preview-banner"]').text()).toContain('memory');
  });

  it('bulk Star uses exactly selected references and group Undo, not a focused single', async () => {
    const {fake,w} = await setup();
    const group = vi.spyOn(fake,'setStarredGroup'); const single = vi.spyOn(fake,'setStarred');
    for(const id of ['conv-02','conv-04']) await w.find(`[data-test="row-select-${id}"]`).setValue(true);
    await w.find('[data-test="star-action"]').trigger('click'); await settle(fake);
    expect(group).toHaveBeenCalledTimes(1); expect(single).not.toHaveBeenCalled();
    expect(group.mock.calls[0]![0].members).toEqual(['conv-02','conv-04'].map(fixtureRef));
    expect(group.mock.calls[0]![0].starred).toBe(true);
    expect((await fake.getConversation(fixtureRef('conv-01'))).stars?.starredMessages).toBe(0);
    expect(w.find('[data-test="action-notice"]').text()).toContain('Star');
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',bubbles:true})); await settle(fake);
    for(const id of ['conv-02','conv-04']) expect((await fake.getConversation(fixtureRef(id))).stars?.starredMessages).toBe(0);
  });

  it('unstar from the reader advances next then Back stays in Starred, and context Back restores Inbox', async () => {
    const {fake,w} = await setup();
    for(const id of ['conv-01','conv-02','conv-03']) await fake.setStarred({conversation:fixtureRef(id),starred:true,requestId:id});
    await settle(fake);
    await w.find('[data-test="rail-starred"]').trigger('click'); await settle(fake);
    await w.find('[data-test="conversation-row-conv-02"]').trigger('click'); await settle(fake);
    await w.find('[data-test="unstar-action"]').trigger('click'); await settle(fake);
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 3');
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await settle(fake);
    expect(w.find('[data-test="inbox-title"]').text()).toBe('Cached Starred');
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-conv-03');
    await w.find('[data-test="context-back"]').trigger('click'); await settle(fake);
    expect(w.find('[data-test="inbox-title"]').text()).toBe('Inbox');
  });

  it('S does not mutate while typing in the palette or during IME/modifier input', async () => {
    const {fake,w} = await setup(); const setter = vi.spyOn(fake,'setStarred');
    await w.find('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    await w.find('[data-test="action-query"]').trigger('keydown',{key:'s'});
    expect(setter).not.toHaveBeenCalled();
    window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); await flushPromises();
    for(const init of [{key:'s',isComposing:true},{key:'s',metaKey:true},{key:'s',ctrlKey:true}]) {
      window.dispatchEvent(new KeyboardEvent('keydown',{...init,bubbles:true}));
    }
    await settle(fake); expect(setter).not.toHaveBeenCalled();
  });

  it('the single starred filter preserves Inbox membership, unstar empties it and Back restores the filter', async () => {
    const {fake,w} = await setup();
    await w.find('[data-test="star-action"]').trigger('click'); await settle(fake);
    await w.find('[data-test="starred-filter"]').trigger('click'); await settle(fake);
    expect(w.findAll('.inbox-row')).toHaveLength(1);
    await w.find('[data-test="rail-starred"]').trigger('click'); await settle(fake);
    await w.find('[data-test="context-back"]').trigger('click'); await settle(fake);
    expect(w.find('[data-test="starred-filter"]').attributes('aria-pressed')).toBe('true');
    await w.find('[data-test="unstar-action"]').trigger('click'); await settle(fake);
    expect(w.find('[data-test="inbox-empty"]').text()).toContain('No known starred');
    expect((await fake.getConversation(fixtureRef('conv-01'))).isInInbox).toBe(true);
    await w.find('[data-test="starred-filter"]').trigger('click'); await settle(fake);
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

  it('fixture profile has no unsupported star controls or destination', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mount(App,{props:{client:fake,mode:'browser-preview'}}); await settle(fake);
    expect(wrapper.find('[data-test="star-action"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="rail-starred"]').exists()).toBe(false);
    await expect(fake.setStarred({conversation:nativeFixtureRef('conv-01'),starred:true,requestId:'no'})).rejects.toMatchObject({kind:'read_only'});
  });
});
