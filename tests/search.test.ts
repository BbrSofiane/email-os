import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { parseSearch, matchesSearch } from '../src/lib/search';
import { useMailbox } from '../src/composables/useMailbox';
import type { MailClient, SearchPage } from '../src/lib/ipc/client';
import { deferred } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
const key = (value: string) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));

describe('UX-07 search', () => {
  it('rejects unsupported syntax and preserves AND/OR, quoted phrases and exclusions', async () => {
    for (const query of ['', 'OR a', 'a OR', 'a AND OR b', 'label:work', 'cc:x', 'after:2020', '(a)', '"oops', 'subject:']) {
      expect(() => parseSearch(query), query).toThrow();
    }
    const fake = createBrowserFakeMailClient();
    const row = (await fake.listConversations()).conversations[0]!;
    const c = await fake.getConversation(row.ref);
    expect(matchesSearch(parseSearch('subject:"' + c.subject + '" OR from:nobody -hello'), c)).toBe(true);
    expect(matchesSearch(parseSearch('subject:"' + c.subject + '" AND -subject:"' + c.subject + '"'), c)).toBe(false);
  });

  it('/ → archived result → reader → Back retains query/results/focus → previous Inbox', async () => {
    const fake = createBrowserFakeMailClient();
    const rows = (await fake.listConversations()).conversations;
    const archived = rows[3]!;
    fake.controls.behavior.holdQueued = true;
    await fake.setArchived({ conversation: archived.ref, archived: true, requestId: 'search-archive' });
    expect((await fake.listConversations()).conversations.some((r) => r.ref.conversationId === archived.ref.conversationId)).toBe(false);
    wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    const previous = wrapper.get('.inbox-row').element as HTMLElement;
    previous.focus();
    const previousId = previous.getAttribute('data-test');
    key('/'); await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-test="search-input"]').element);
    const query = 'subject:"' + archived.subject + '"';
    await wrapper.get('[data-test="search-input"]').setValue(query);
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect(wrapper.get('[data-test="search-coverage"]').text()).toContain('incomplete');
    const result = wrapper.get('.inbox-row');
    const resultId = result.attributes('data-test');
    await result.trigger('click'); await flushPromises();
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
    await wrapper.get('[data-test="reader-close"]').trigger('click'); await flushPromises();
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe(query);
    expect(document.activeElement?.getAttribute('data-test')).toBe(resultId);
    key('Escape'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(document.activeElement?.getAttribute('data-test')).toBe(previousId);
  });

  it('typing action keys in search never mutates mail; invalid syntax is not empty success', async () => {
    const fake = createBrowserFakeMailClient();
    const archive = vi.spyOn(fake, 'setArchived');
    wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="search-trigger"]').trigger('click'); await flushPromises();
    for (const k of ['e', 'z', '/', 'j']) key(k);
    expect(archive).not.toHaveBeenCalled();
    await wrapper.get('[data-test="search-input"]').setValue('label:unsupported');
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-error"]').text()).toContain('unsupported search syntax');
    expect(wrapper.find('[data-test="inbox-empty"]').exists()).toBe(false);
  });

  it('fences stale query and context responses; deduplicates continuation and retains rows on rate limit', async () => {
    const fake = createBrowserFakeMailClient();
    const row = (await fake.listConversations()).conversations[0]!;
    const late = deferred<SearchPage>();
    let moreFails = false;
    const client: MailClient = { ...fake, searchMail: async (request) => {
      if (request.query === 'late') return late.promise;
      if (request.cursor && moreFails) throw { kind: 'rate_limited' };
      return { conversations: [row], nextCursor: request.cursor ? null : 'page2', coverage: 'provider_candidates' };
    } };
    const scope = effectScope();
    const mailbox = scope.run(() => useMailbox(client))!;
    try {
      await mailbox.ready;
      const old = mailbox.search('late'); await flushPromises();
      await mailbox.search('current');
      moreFails = true;
      await mailbox.loadMore();
      expect(mailbox.conversations.value).toHaveLength(1);
      expect(mailbox.listError.value?.kind).toBe('rate_limited');
      expect(mailbox.nextCursor.value).toBe('page2');
      moreFails = false;
      await mailbox.loadMore();
      expect(mailbox.conversations.value).toHaveLength(1);
      expect(mailbox.nextCursor.value).toBeNull();
      late.resolve({ conversations: [], nextCursor: null, coverage: 'cached_incomplete' });
      await old;
      expect(mailbox.searchQuery.value).toBe('current');
      expect(mailbox.conversations.value).toHaveLength(1);
      await mailbox.setContext('inbox');
      expect(mailbox.conversations.value.length).toBeGreaterThan(1);
    } finally { scope.stop(); }
  });

  it('loads an exact missing search result visibly and keeps the query on reader failure', async () => {
    const fake = createBrowserFakeMailClient();
    const row = (await fake.listConversations()).conversations[0]!;
    const getConversation = vi.fn(async () => { throw { kind: 'not_found' }; });
    const client: MailClient = { ...fake, getConversation };
    wrapper = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="search-trigger"]').trigger('click');
    await wrapper.get('[data-test="search-input"]').setValue('subject:"' + row.subject + '"');
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    await wrapper.get('.inbox-row').trigger('click'); await flushPromises();
    expect(getConversation).toHaveBeenCalledWith(row.ref, true);
    expect(wrapper.get('[data-test="reader"]').text()).toContain('no longer available');
    await wrapper.get('[data-test="reader-close"]').trigger('click'); await flushPromises();
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toContain(row.subject);
  });

  it('restores the loaded search visit after navigating to another destination', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="search-trigger"]').trigger('click');
    await wrapper.get('[data-test="search-input"]').setValue('subject:Fixture');
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    const firstId = wrapper.get('.inbox-row').attributes('data-test');
    await wrapper.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('subject:Fixture');
    expect(wrapper.get('.inbox-row').attributes('data-test')).toBe(firstId);
  });

  it('contact search and up to four real recent links do not hijack Copy', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    const pane = wrapper.get('[data-test="contact-pane"]');
    expect(pane.findAll('.contact-recent li')).toHaveLength(4);
    await pane.get('[data-test="copy-email"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    await pane.get('[data-test="contact-name"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toMatch(/^from:/);
  });
});
