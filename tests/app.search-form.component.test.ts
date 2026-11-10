import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { validateSearch } from '../src/lib/search';
import type { MailClient, SearchPage, SearchRequest } from '../src/lib/ipc/client';
import { deferred, mountApp, press } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

type SearchMailImpl = (request: SearchRequest, fake: ReturnType<typeof createBrowserFakeMailClient>) => ReturnType<MailClient['searchMail']>;

async function setup(options: { searchMail?: SearchMailImpl } = {}) {
  const fake = createBrowserFakeMailClient();
  const searchMail = vi.fn<MailClient['searchMail']>((request: SearchRequest) =>
    options.searchMail ? options.searchMail(request, fake) : fake.searchMail(request));
  const setArchived = vi.spyOn(fake, 'setArchived');
  const client: MailClient = { ...fake, searchMail };
  wrapper = mountApp(client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  // The contact pane also calls searchMail (from:"…", cachedOnly); filter by
  // query for submitted-query assertions, or by cachedOnly for provider
  // traversals the user's own submits triggered.
  const submissions = (query?: string) =>
    searchMail.mock.calls.map(([request]) => request).filter((request) => query === undefined || request.query === query);
  const providerSubmissions = () =>
    searchMail.mock.calls.map(([request]) => request).filter((request) => !request.cachedOnly);
  const openSearch = async () => {
    await wrapper!.get('[data-test="search-trigger"]').trigger('click');
    await flushPromises();
    return wrapper!.get('[data-test="search-input"]');
  };
  const submit = async (query: string) => {
    // A successful submit auto-collapses the form; reopen it first, exactly as
    // a user would (/, glyph, palette or the results-header query button).
    if (!wrapper!.find('form[role="search"]').exists()) await openSearch();
    await wrapper!.get('[data-test="search-input"]').setValue(query);
    await wrapper!.get('form[role="search"]').trigger('submit');
    await flushPromises();
  };
  return { w: wrapper, fake, searchMail, setArchived, submissions, providerSubmissions, openSearch, submit };
}

describe('search form inline validation (P1)', () => {
  it.each([
    ['subject:', /"subject:" needs a value/],
    ['(a)', /not supported/],
    ['"oops', /[Uu]nmatched/],
    ['label:work', /Unknown operator "label:"/],
    ['a OR', /term/],
    ['é'.repeat(600), /1200 bytes.*512 bytes/s],
  ] as const)('shows a specific inline error for %j and never calls searchMail', async (query, pattern) => {
    const h = await setup();
    const input = await h.openSearch();
    await input.setValue(query);
    expect(h.w.get('[data-test="search-error"]').text()).toMatch(pattern);
    expect(h.w.get('[data-test="search-error"]').attributes('role')).toBe('alert');
    await h.w.get('form[role="search"]').trigger('submit'); await flushPromises();
    expect(h.providerSubmissions()).toHaveLength(0);
    expect(h.w.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
  });

  it('clears the inline error for a valid query and submits it', async () => {
    const h = await setup();
    const input = await h.openSearch();
    await input.setValue('subject:');
    expect(h.w.find('[data-test="search-error"]').exists()).toBe(true);
    await input.setValue('subject:Fixture');
    expect(h.w.find('[data-test="search-error"]').exists()).toBe(false);
    await h.w.get('form[role="search"]').trigger('submit'); await flushPromises();
    expect(h.submissions('subject:Fixture')).toEqual([expect.objectContaining({ query: 'subject:Fixture', cursor: null })]);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
  });

  it('blocks an empty submit with the empty-query message instead of searching', async () => {
    const h = await setup();
    await h.openSearch();
    await h.w.get('form[role="search"]').trigger('submit'); await flushPromises();
    expect(h.providerSubmissions()).toHaveLength(0);
    expect(h.w.get('[data-test="search-error"]').text()).toContain('empty');
  });
});

describe('search help operator+gloss list (P2)', () => {
  it('renders one row per supported operator plus the not-supported line', async () => {
    const h = await setup();
    await h.openSearch();
    const help = h.w.get('[data-test="search-help"]');
    expect(help.element.tagName).toBe('UL');
    const rows = help.findAll('li');
    expect(rows).toHaveLength(6);
    expect(help.findAll('.search-op').map((op) => op.text())).toEqual(['from:', 'to:', 'subject:', '"…"', 'AND / OR', '-term']);
    expect(rows.map((row) => row.find('.search-gloss').text())).toEqual([
      'from sender', 'to recipient', 'in subject', 'exact phrase in straight quotes', 'combine terms — AND binds before OR', 'exclude a term or field',
    ]);
    expect(h.w.get('.search-unsupported').text()).toBe('Not supported: dates, labels, Cc/Bcc, parentheses.');
    // The input still describes itself against the help list.
    const input = h.w.get('[data-test="search-input"]');
    expect(input.attributes('aria-describedby')).toContain('search-help');
    // One-line example placeholder (valid grammar, not a value) + the 512-char cap.
    expect(input.attributes('placeholder')).toBe('from:ada "weekly status" -invoice');
    expect(validateSearch('from:ada "weekly status" -invoice')).toBeNull();
    expect(input.attributes('maxlength')).toBe('512');
  });
});

describe('search suggestions (P3)', () => {
  it('shows recent submitted queries when the input is empty and applies one with arrows + Enter', async () => {
    const h = await setup();
    await h.openSearch();
    // Nothing submitted yet: the listbox stays mounted but hidden, so
    // aria-controls never references an unmounted node.
    const emptyInput = h.w.get('[data-test="search-input"]');
    expect(h.w.get('[data-test="search-suggestions"]').isVisible()).toBe(false);
    expect(emptyInput.attributes('aria-controls')).toBe('mail-query-suggestions');
    expect(h.w.find('#mail-query-suggestions').exists()).toBe(true);
    expect(emptyInput.attributes('aria-expanded')).toBe('false');
    await h.submit('invoice');
    expect(h.submissions('invoice')).toHaveLength(1);
    // Reopen the form over the results and clear the input: the recent query appears.
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    await input.setValue('');
    const suggestions = h.w.findAll('[data-test="search-suggestion"]');
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]!.text()).toBe('invoice');
    expect(h.w.get('[data-test="search-suggestions"]').attributes('role')).toBe('listbox');
    expect(suggestions[0]!.attributes('role')).toBe('option');
    // ArrowDown highlights the row (aria-activedescendant + fill class).
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(input.attributes('aria-activedescendant')).toBe('mail-query-suggestion-0');
    expect(suggestions[0]!.classes()).toContain('highlighted');
    expect(suggestions[0]!.attributes('aria-selected')).toBe('true');
    // Enter fills the input with the suggestion AND submits it.
    h.searchMail.mockClear();
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    // Applying the suggestion auto-collapses the form; the header echoes it.
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: invoice');
    expect(h.submissions('invoice')).toEqual([expect.objectContaining({ query: 'invoice', cursor: null })]);
    // Reopening (header glyph) seeds the input with the submitted query.
    await h.openSearch();
    expect((h.w.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('invoice');
  });

  it('dedupes recent queries most-recent-first and caps at 8', async () => {
    const h = await setup();
    await h.openSearch();
    for (const q of ['a', 'b', 'a', 'c', 'd', 'e', 'f', 'g', 'h', 'i']) await h.submit(q);
    await h.openSearch();
    await h.w.get('[data-test="search-input"]').setValue('');
    const values = h.w.findAll('[data-test="search-suggestion"] .suggestion-query').map((row) => row.text());
    expect(values).toEqual(['i', 'h', 'g', 'f', 'e', 'd', 'c', 'a']);
  });

  it('matches cached correspondents and query prefixes while typing, and clicking fills+submits', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('subject:Fixture');
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    await input.setValue('ada');
    const rows = h.w.findAll('[data-test="search-suggestion"]');
    // Correspondent rows come from the loaded conversations' senders/recipients…
    const correspondent = rows.find((row) => row.text().includes('ada@example.test'));
    expect(correspondent).toBeTruthy();
    expect(correspondent!.text()).toContain('Ada Fixture');
    // …and no recent query starts with "ada".
    expect(rows.filter((row) => row.find('.suggestion-query').exists())).toHaveLength(0);
    h.searchMail.mockClear();
    await correspondent!.trigger('click');
    await flushPromises();
    // Clicking fills the input with the from: query AND submits it (the
    // contact pane's own cached from:"…" read may add a same-query call).
    expect(h.submissions('from:"ada@example.test"').length).toBeGreaterThan(0);
    expect(h.submissions('from:"ada@example.test"').at(-1)).toEqual(expect.objectContaining({ query: 'from:"ada@example.test"', cursor: null }));
    // The submit auto-collapsed the form; the header echoes the query.
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: from:"ada@example.test"');
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    // Reopening seeds the input with the submitted query.
    await h.openSearch();
    expect((h.w.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('from:"ada@example.test"');
    // A prefix of a recent query also matches it as a query row.
    await h.openSearch();
    await h.w.get('[data-test="search-input"]').setValue('subject:fi');
    expect(h.w.findAll('[data-test="search-suggestion"] .suggestion-query').map((row) => row.text())).toEqual(['subject:Fixture']);
  });

  it('keeps single-letter shortcuts inert inside the input while suggestions are open (BROWSE-10)', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('invoice');
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    await input.setValue('');
    expect(h.w.get('[data-test="search-suggestions"]').isVisible()).toBe(true);
    await input.trigger('keydown', { key: 'ArrowDown' });
    for (const k of ['e', 'z', 'j', 'k', 's', '/']) press(k, { bubbles: true, cancelable: true }, input.element);
    expect(h.setArchived).not.toHaveBeenCalled();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
  });

  it('Esc closes the suggestion list first, then collapses the form without leaving the search context, then exits', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('Fixture');
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    await input.setValue('');
    expect(h.w.get('[data-test="search-suggestions"]').isVisible()).toBe(true);
    // First Esc: suggestions close; form, focus and search context remain.
    await input.trigger('keydown', { key: 'Escape' });
    expect(h.w.get('[data-test="search-suggestions"]').isVisible()).toBe(false);
    expect(h.w.find('form[role="search"]').exists()).toBe(true);
    expect(document.activeElement).toBe(input.element);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: Fixture');
    // Second Esc while the input is still focused: the form collapses, the
    // search context (list + query header) remains, focus moves to the list.
    press('Escape', { bubbles: true, cancelable: true });
    await flushPromises();
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: Fixture');
    expect(document.activeElement?.getAttribute('data-test')).toMatch(/^conversation-row-/);
    // Third Esc on the list: exits the search context via the Back path.
    press('Escape', { bubbles: true, cancelable: true });
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
  });

  it('outside search context Esc just hides the form', async () => {
    const h = await setup();
    const input = await h.openSearch();
    await input.trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    // Revealing again restores focus to the input.
    await h.openSearch();
    expect(document.activeElement).toBe(h.w.get('[data-test="search-input"]').element);
  });
});

describe('search results chrome (P4)', () => {
  it('echoes the query in the results header as an edit button with an X exit, and auto-collapses the form after a valid submit', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('subject:Fixture');
    expect(h.w.find('[data-test="search-results-header"]').exists()).toBe(true);
    // A valid submit leaves the slim chrome: header + coverage + list, no form.
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.find('[data-test="search-coverage"]').exists()).toBe(true);
    expect(h.w.find('.inbox-row').exists()).toBe(true);
    expect(document.activeElement?.getAttribute('data-test')).toMatch(/^conversation-row-/);
    // The query echo is a keyboard-reachable edit button (reopens revealSearch).
    const queryButton = h.w.get('[data-test="search-results-query"]');
    expect(queryButton.text()).toBe('Search: subject:Fixture');
    expect(queryButton.element.tagName).toBe('BUTTON');
    expect(queryButton.attributes('title')).toBe('Edit search query');
    expect(queryButton.attributes('aria-label')).toBe('Edit search query: subject:Fixture');
    expect((queryButton.element as HTMLButtonElement).tabIndex).toBe(0);
    // The header Back glyph stays reachable; the X remains the exit.
    expect(h.w.find('[data-test="context-back"]').exists()).toBe(true);
    await h.w.get('[data-test="search-clear"]').trigger('click'); await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.w.find('[data-test="search-results-header"]').exists()).toBe(false);
  });

  it('keeps the query editable across a reader round trip (UX-07 restore)', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('subject:Fixture');
    const firstId = h.w.get('.inbox-row').attributes('data-test');
    await h.w.get('.inbox-row').trigger('click'); await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(true);
    await h.w.get('[data-test="reader-close"]').trigger('click'); await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    // The restored results view stays collapsed; query, rows and focus survive.
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: subject:Fixture');
    expect(h.w.get('.inbox-row').attributes('data-test')).toBe(firstId);
    expect(document.activeElement?.getAttribute('data-test')).toBe(firstId);
    // The header query button reopens the form, focused, with the query.
    await h.w.get('[data-test="search-results-query"]').trigger('click'); await flushPromises();
    expect(document.activeElement).toBe(h.w.get('[data-test="search-input"]').element);
    expect((h.w.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('subject:Fixture');
    // Back from the restored search returns to the previous context.
    await h.w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
  });
});

describe('search form auto-collapse and reopen paths (re-run P2)', () => {
  it('auto-collapses after a valid submit, keeps header+coverage+list and focuses the first result row', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('subject:Fixture');
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: subject:Fixture');
    expect(h.w.find('[data-test="search-coverage"]').exists()).toBe(true);
    expect(h.w.find('.inbox-row').exists()).toBe(true);
    expect(document.activeElement?.getAttribute('data-test')).toMatch(/^conversation-row-/);
  });

  it('keeps the form open when the submit errored', async () => {
    const h = await setup({ searchMail: async () => { throw { kind: 'rate_limited' }; } });
    await h.openSearch();
    await h.submit('invoice');
    expect(h.w.find('form[role="search"]').exists()).toBe(true);
    expect(h.w.find('[data-test="inbox-error"]').exists()).toBe(true);
    expect(document.activeElement).toBe(h.w.get('[data-test="search-input"]').element);
  });

  it('keeps the form open when the draft changed while the submit was in flight', async () => {
    const gate = deferred<SearchPage>();
    const h = await setup({ searchMail: (request, fake) => (request.query === 'invoice' ? gate.promise : fake.searchMail(request)) });
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    await input.setValue('invoice');
    void h.w.get('form[role="search"]').trigger('submit');
    await flushPromises(); // the submit is now parked on the gate
    await input.setValue('invoice receipt'); // the user keeps typing a new query
    gate.resolve({ conversations: [], nextCursor: null, coverage: 'cached_incomplete' });
    await flushPromises();
    expect(h.w.find('form[role="search"]').exists()).toBe(true);
    expect((h.w.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('invoice receipt');
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: invoice');
  });

  it('reopens the collapsed form with the current query, focused, via /, the glyph, the palette and the header query button', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('subject:Fixture');
    const reopeners: Record<string, () => Promise<void>> = {
      'slash key': async () => { press('/', { bubbles: true, cancelable: true }); await flushPromises(); },
      'header search glyph': async () => { await h.w.get('[data-test="search-trigger"]').trigger('click'); await flushPromises(); },
      'palette command': async () => {
        await h.w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
        await h.w.get('[data-test="action-query"]').setValue('older');
        const option = h.w.findAll('[role="option"]').find((o) => (o.attributes('id') ?? '').endsWith('action-search'));
        expect(option, 'palette search command').toBeTruthy();
        await option!.trigger('click'); await flushPromises();
      },
      'results-header query button': async () => { await h.w.get('[data-test="search-results-query"]').trigger('click'); await flushPromises(); },
    };
    for (const [name, reopen] of Object.entries(reopeners)) {
      expect(h.w.find('form[role="search"]').exists(), name).toBe(false);
      await reopen();
      expect(h.w.find('form[role="search"]').exists(), name).toBe(true);
      const input = h.w.get('[data-test="search-input"]');
      expect((input.element as HTMLInputElement).value, name).toBe('subject:Fixture');
      expect(document.activeElement, name).toBe(input.element);
      // Collapse again (Esc closes the listbox, then the form) for the next path.
      await input.trigger('keydown', { key: 'Escape' });
      press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
      expect(h.w.find('form[role="search"]').exists(), name).toBe(false);
      expect(document.activeElement?.getAttribute('data-test'), name).toMatch(/^conversation-row-/);
    }
  });

  it('after auto-collapse a single Esc on the list exits the search context', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('Fixture');
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-test')).toMatch(/^conversation-row-/);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(h.w.find('[data-test="search-results-header"]').exists()).toBe(false);
  });
});

describe('suggestion listbox hardening (re-run P2)', () => {
  it('keeps the listbox mounted (v-show) so aria-controls never dangles', async () => {
    const h = await setup();
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    const listbox = h.w.get('[data-test="search-suggestions"]');
    // No suggestions yet: hidden but mounted; aria-controls resolves to it.
    expect(listbox.isVisible()).toBe(false);
    expect(input.attributes('aria-controls')).toBe('mail-query-suggestions');
    expect(h.w.find('#mail-query-suggestions').exists()).toBe(true);
    expect(input.attributes('aria-expanded')).toBe('false');
    await input.setValue('ada');
    expect(listbox.isVisible()).toBe(true);
    expect(input.attributes('aria-expanded')).toBe('true');
    // The ul is capped at six 28px rows and scrolls (pinned in style.css).
    const css = readFileSync('src/assets/style.css', 'utf8');
    expect(css).toMatch(/\.search-suggestions\s*\{[^}]*max-height:\s*168px;[^}]*overflow-y:\s*auto;/);
  });

  it('scrolls the highlighted option into view on arrows and pointer moves; ArrowDown reopens a listbox closed by Esc', async () => {
    const h = await setup();
    await h.openSearch();
    for (const q of ['aa', 'bb', 'cc', 'dd', 'ee', 'ff', 'gg', 'hh']) await h.submit(q);
    await h.openSearch();
    const input = h.w.get('[data-test="search-input"]');
    await input.setValue('');
    const listbox = h.w.get('[data-test="search-suggestions"]');
    expect(listbox.isVisible()).toBe(true);
    const options = h.w.findAll('[data-test="search-suggestion"]');
    expect(options).toHaveLength(8);
    // Per-option spies: the highlight scrolls its own option into view.
    const spies = options.map((option) => {
      const spy = vi.fn();
      (option.element as HTMLElement).scrollIntoView = spy;
      return spy;
    });
    // ArrowDown walks the highlight; each step scrolls the option into view.
    for (let step = 0; step < 8; step += 1) {
      await input.trigger('keydown', { key: 'ArrowDown' });
      expect(input.attributes('aria-activedescendant')).toBe(`mail-query-suggestion-${step}`);
      expect(spies[step]).toHaveBeenCalledWith({ block: 'nearest' });
      expect(options[step]!.classes()).toContain('highlighted');
    }
    // Pointer highlight scrolls into view too.
    await options[5]!.trigger('pointermove');
    expect(input.attributes('aria-activedescendant')).toBe('mail-query-suggestion-5');
    expect(spies[5]).toHaveBeenCalledWith({ block: 'nearest' });
    // Esc closes the listbox (still mounted, aria correct)…
    await input.trigger('keydown', { key: 'Escape' });
    expect(listbox.isVisible()).toBe(false);
    expect(input.attributes('aria-expanded')).toBe('false');
    expect(input.attributes('aria-activedescendant')).toBeUndefined();
    expect(h.w.find('#mail-query-suggestions').exists()).toBe(true);
    // …and ArrowDown reopens it with the first option highlighted.
    await input.trigger('keydown', { key: 'ArrowDown' });
    expect(listbox.isVisible()).toBe(true);
    expect(input.attributes('aria-expanded')).toBe('true');
    expect(input.attributes('aria-activedescendant')).toBe('mail-query-suggestion-0');
    expect(spies[0]).toHaveBeenCalledWith({ block: 'nearest' });
  });
});

describe('search error banner honesty (P1)', () => {
  it('hides Retry for a searchQuery parse error, points at the query, and keeps a single period', async () => {
    const h = await setup({
      searchMail: async () => { throw { kind: 'invalid_request', field: 'searchQuery' }; },
    });
    await h.openSearch();
    // A syntactically valid query passes the inline gate, reaches the provider,
    // and the provider rejects it with field searchQuery.
    await h.submit('invoice');
    const banner = h.w.get('[data-test="inbox-error"]');
    expect(banner.text()).toContain('unsupported search syntax');
    expect(banner.text()).toContain('Edit the query above');
    expect(banner.text()).not.toMatch(/\.\./); // no double period
    expect(banner.text()).toMatch(/exclusions\. Edit the query above/);
    expect(h.w.find('[data-test="inbox-retry"]').exists()).toBe(false);
  });

  it('keeps Retry for a real provider error', async () => {
    const h = await setup({
      searchMail: async () => { throw { kind: 'rate_limited' }; },
    });
    await h.openSearch();
    await h.submit('invoice');
    const banner = h.w.get('[data-test="inbox-error"]');
    expect(banner.text()).toContain('rate limited');
    expect(banner.text()).not.toMatch(/\.\./);
    expect(h.w.find('[data-test="inbox-retry"]').exists()).toBe(true);
    await h.w.get('[data-test="inbox-retry"]').trigger('click'); await flushPromises();
    expect(h.submissions('invoice')).toHaveLength(2);
  });

  it('points the banner at the reopen paths once the form is collapsed', async () => {
    const h = await setup({
      searchMail: async () => { throw { kind: 'invalid_request', field: 'searchQuery' }; },
    });
    await h.openSearch();
    await h.submit('invoice');
    // The submit errored, so the form stays open and the banner can say "above".
    expect(h.w.find('form[role="search"]').exists()).toBe(true);
    expect(h.w.get('[data-test="inbox-error"]').text()).toContain('Edit the query above — the same query fails again.');
    // Collapsing the form (Esc) swaps the copy: it names the reopen paths instead.
    await h.w.get('[data-test="search-input"]').trigger('keydown', { key: 'Escape' });
    await flushPromises();
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    const banner = h.w.get('[data-test="inbox-error"]');
    expect(banner.text()).toContain('Press / or choose the query in the results header to edit it — the same query fails again.');
    expect(banner.text()).not.toContain('Edit the query above');
    expect(banner.text()).not.toMatch(/\.\./);
    expect(h.w.find('[data-test="inbox-retry"]').exists()).toBe(false);
  });
});
