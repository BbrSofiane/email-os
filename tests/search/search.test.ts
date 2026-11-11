import { afterEach, describe, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import { parseSearch, matchesSearch, validateSearch, isSingleFromQuery } from '../../src/lib/search';
import { useMailbox } from '../../src/composables/useMailbox';
import type { MailClient, SearchPage } from '../../src/lib/ipc/client';
import { deferred, mountApp, press } from '../helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('searches known results with coverage disclosures (UX-07)', () => {
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
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    const previous = wrapper.get('.inbox-row').element as HTMLElement;
    previous.focus();
    const previousId = previous.getAttribute('data-test');
    press('/', { bubbles: true, cancelable: true }); await flushPromises();
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
    // The restored results view is collapsed (auto-collapse on submit): the
    // query echoes in the header and focus returns to the result row.
    expect(wrapper.find('form[role="search"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="search-results-query"]').text()).toBe(`Search: ${query}`);
    expect(document.activeElement?.getAttribute('data-test')).toBe(resultId);
    // The query stays editable: the header query button reopens the form focused.
    await wrapper.get('[data-test="search-results-query"]').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(wrapper.get('[data-test="search-input"]').element);
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe(query);
    // Esc on the reopened form: listbox closes, then the form collapses (focus
    // back to the row); the next Esc on the list exits the search context.
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(wrapper.find('form[role="search"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-test')).toBe(resultId);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(document.activeElement?.getAttribute('data-test')).toBe(previousId);
  });

  it('validateSearch mirrors the grammar inline, including the 512-byte cap, and agrees with parseSearch', () => {
    // Valid queries pass both.
    for (const q of ['invoice', 'from:ada@example.test "exact phrase" -newsletter', 'a OR b AND c', 'text:hello', 'subject:x OR to:y']) {
      expect(validateSearch(q), q).toBeNull();
      expect(() => parseSearch(q), q).not.toThrow();
    }
    // Empty query.
    expect(validateSearch('')).toContain('empty');
    expect(validateSearch('   ')).toContain('empty');
    // Byte cap: maxlength=512 counts characters, the grammar counts UTF-8 bytes.
    expect(validateSearch('é'.repeat(256))).toBeNull(); // exactly 512 bytes
    expect(validateSearch('é'.repeat(257))).toMatch(/514 bytes/);
    expect(validateSearch('é'.repeat(512))).toMatch(/1024 bytes/);
    // Unmatched quote.
    expect(validateSearch('"oops')).toMatch(/[Uu]nmatched/);
    // Parentheses / braces / backslashes.
    expect(validateSearch('(a)')).toContain('not supported');
    expect(validateSearch('a{b}')).toContain('not supported');
    expect(validateSearch('a\\b')).toContain('not supported');
    // Missing value after an operator.
    expect(validateSearch('subject:')).toContain('"subject:" needs a value');
    expect(validateSearch('from:')).toMatch(/needs a value/);
    // Unknown operators.
    expect(validateSearch('label:work')).toContain('Unknown operator "label:"');
    expect(validateSearch('cc:x')).toContain('Unknown operator "cc:"');
    expect(validateSearch('after:2020')).toContain('Unknown operator');
    // Dangling AND/OR.
    expect(validateSearch('a OR')).toMatch(/term/);
    expect(validateSearch('OR a')).toMatch(/term/);
    expect(validateSearch('a AND OR b')).toMatch(/term/);
    // Quote inside a value.
    expect(validateSearch('from:"a"b')).toMatch(/whole phrase/);
    // Every rejection is a specific message AND parseSearch agrees (throws).
    for (const q of ['', '  ', 'subject:', '(a)', '"oops', 'label:x', 'a OR', 'OR a', 'é'.repeat(600), 'from:"a"b']) {
      const problem = validateSearch(q);
      expect(problem, q).toBeTruthy();
      expect(problem!.length, q).toBeGreaterThan(10);
      expect(() => parseSearch(q), q).toThrow();
    }
  });

  it('typing action keys in search never mutates mail; invalid syntax is blocked inline and never submitted', async () => {
    const fake = createBrowserFakeMailClient();
    const archive = vi.spyOn(fake, 'setArchived');
    const searchMail = vi.spyOn(fake, 'searchMail');
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="search-trigger"]').trigger('click'); await flushPromises();
    for (const k of ['e', 'z', '/', 'j']) press(k, { bubbles: true, cancelable: true });
    expect(archive).not.toHaveBeenCalled();
    // The inline error appears while typing, before any submit.
    await wrapper.get('[data-test="search-input"]').setValue('label:unsupported');
    expect(wrapper.get('[data-test="search-error"]').text()).toContain('Unknown operator "label:"');
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    // P1 error honesty: an invalid query never reaches searchMail (the contact
    // pane's cached from:"…" read is the only allowed call), so there is no
    // error banner and no empty-success result list either.
    expect(searchMail.mock.calls.filter(([request]) => !request.cachedOnly)).toHaveLength(0);
    expect(wrapper.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="inbox-empty"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
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
    wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="search-trigger"]').trigger('click');
    await wrapper.get('[data-test="search-input"]').setValue('subject:"' + row.subject + '"');
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    await wrapper.get('.inbox-row').trigger('click'); await flushPromises();
    expect(getConversation).toHaveBeenCalledWith(row.ref, true);
    expect(wrapper.get('[data-test="reader"]').text()).toContain('no longer available');
    await wrapper.get('[data-test="reader-close"]').trigger('click'); await flushPromises();
    // The results view stays collapsed; the query is echoed and still editable.
    expect(wrapper.find('form[role="search"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="search-results-query"]').text()).toContain(row.subject);
    await wrapper.get('[data-test="search-results-query"]').trigger('click'); await flushPromises();
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toContain(row.subject);
  });

  it('restores the loaded search visit after navigating to another destination', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="search-trigger"]').trigger('click');
    await wrapper.get('[data-test="search-input"]').setValue('subject:Fixture');
    await wrapper.get('form[role="search"]').trigger('submit'); await flushPromises();
    const firstId = wrapper.get('.inbox-row').attributes('data-test');
    await wrapper.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    await wrapper.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Search');
    // The restored visit keeps query+rows+focus and stays collapsed; the
    // header query button reopens the editable query.
    expect(wrapper.find('form[role="search"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="search-results-query"]').text()).toBe('Search: subject:Fixture');
    expect(wrapper.get('.inbox-row').attributes('data-test')).toBe(firstId);
    await wrapper.get('[data-test="search-results-query"]').trigger('click'); await flushPromises();
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('subject:Fixture');
  });

  it('contact search and up to four real recent links do not hijack Copy', async () => {
    const fake = createBrowserFakeMailClient();
    wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushPromises();
    const pane = wrapper.get('[data-test="contact-pane"]');
    expect(pane.findAll('.contact-recent li')).toHaveLength(4);
    await pane.get('[data-test="copy-email"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    await pane.get('[data-test="contact-name"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-title"]').text()).toBe('Search');
    // The contact sender search auto-collapses the form; the query echoes in
    // the header and reopening via the glyph seeds the input with it.
    expect(wrapper.find('form[role="search"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="search-results-query"]').text()).toMatch(/^Search: from:/);
    await wrapper.get('[data-test="search-trigger"]').trigger('click'); await flushPromises();
    expect((wrapper.get('[data-test="search-input"]').element as HTMLInputElement).value).toMatch(/^from:/);
  });
});

describe('isSingleFromQuery (P5b sender-grouping trigger)', () => {
  it.each([
    ['from:ada@example.test', 'ada@example.test'],
    ['from:"ada@example.test"', 'ada@example.test'],
    ['from:ADA@EXAMPLE.TEST', 'ada@example.test'], // values lowercase like parseSearch
    ['from:example.test', 'example.test'],
  ] as const)('returns the from value for the single non-excluded from: query %j', (query, value) => {
    expect(isSingleFromQuery(query)).toBe(value);
  });

  it.each([
    'subject:ada', // other field
    'to:ada@example.test',
    'text:ada',
    'ada', // plain text
    'from:a OR from:b', // two OR-groups
    'from:a OR subject:b',
    'from:a AND from:b', // one group, two terms
    'from:a subject:b',
    'from:a -subject:b',
    '-from:ada@example.test', // excluded from:
    'FROM:ada', // operator fields are case-sensitive: invalid query
    'from:', // invalid: missing value
    '', // invalid: empty
    'label:x',
    '(a)',
    'a OR',
    '"oops',
  ] as const)('returns null for %j', (query) => {
    expect(isSingleFromQuery(query)).toBeNull();
  });
});
