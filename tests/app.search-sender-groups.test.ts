import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';

/**
 * P5b: search results for a single non-excluded from: query render
 * sender-grouped (one "Name (count)" caption starting each exact-sender
 * group) with the date captions nested INSIDE each group; every other query
 * and context keeps the flat date captions. Captions stay non-actionable, so
 * j/k and focus move through conversation rows only, and the reader Back /
 * restoreSearch round trips keep working (with the entry form collapsed in
 * the results view, reopened via the results-header query button).
 */
let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

const key = (value: string) =>
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));

async function setup() {
  const fake = createBrowserFakeMailClient();
  wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  const openSearch = async () => {
    await wrapper!.get('[data-test="search-trigger"]').trigger('click');
    await flushPromises();
    return wrapper!.get('[data-test="search-input"]');
  };
  const submit = async (query: string) => {
    await wrapper!.get('[data-test="search-input"]').setValue(query);
    await wrapper!.get('form[role="search"]').trigger('submit');
    await flushPromises();
  };
  const captions = () => wrapper!.findAll('.row-group').map((h) => h.text());
  const rowIds = () => wrapper!.findAll('.inbox-row').map((r) => r.attributes('data-test'));
  return { w: wrapper, openSearch, submit, captions, rowIds };
}

const ADA_ROWS = ['conv-01', 'conv-02', 'conv-03', 'conv-04', 'conv-05', 'conv-07', 'conv-08', 'conv-09', 'conv-10', 'conv-11', 'conv-13', 'conv-14', 'conv-15', 'conv-16', 'conv-17']
  .map((id) => `conversation-row-${id}`);
const HOSTILE_ROWS = ['conv-06', 'conv-12', 'conv-18'].map((id) => `conversation-row-${id}`);

describe('search sender grouping (P5b)', () => {
  it('groups a single-sender from: search under one "Ada Fixture (15)" caption with date captions nested inside', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('from:"ada@example.test"');
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    // Sender caption starts the group; the date caption continues inside it.
    expect(h.captions()).toEqual(['Ada Fixture (15)', 'January 2025']);
    expect(h.rowIds()).toEqual(ADA_ROWS);
    // Captions are announced but non-actionable, like the date captions.
    for (const caption of h.w.findAll('.row-group')) {
      expect(caption.attributes('role')).toBe('presentation');
      expect((caption.element as HTMLElement).tabIndex).toBe(-1);
      expect(caption.find('button').exists()).toBe(false);
    }
  });

  it('groups a broader from: query into one caption per sender with correct counts, date captions nested in each group, rows keeping backend order inside each group', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('from:"example.test"');
    expect(h.captions()).toEqual([
      'Ada Fixture (15)', 'January 2025',
      '<script>alert("sender")</script> (3)', 'January 2025',
    ]);
    expect(h.rowIds()).toEqual([...ADA_ROWS, ...HOSTILE_ROWS]);
  });

  it.each([
    'subject:Fixture',
    'Fixture',
    'from:ada@example.test OR from:hostile@example.test',
    'from:ada@example.test AND subject:Fixture',
    '-from:ada@example.test',
  ])('renders NO sender captions for the query %j (date captions as today)', async (query) => {
    const h = await setup();
    await h.openSearch();
    await h.submit(query);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    const captions = h.captions();
    expect(captions.length).toBeGreaterThan(0);
    for (const caption of captions) {
      expect(caption).not.toMatch(/\(\d+\)$/);
      expect(caption).not.toContain('Ada Fixture');
    }
    expect(h.rowIds().length).toBeGreaterThan(0);
  });

  it('j/k move focus through conversation rows only, skipping sender captions across groups', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('from:"example.test"');
    expect(h.captions()).toHaveLength(4); // two sender + two nested date captions
    // Leave the search input so the list owns the keys, then walk down six
    // rows — the walk crosses the second sender caption (before conv-06, the
    // first row of the hostile group) and the nested date captions.
    (document.activeElement as HTMLElement).blur();
    const focusId = () => document.activeElement?.getAttribute('data-test') ?? null;
    const walked: (string | null)[] = [];
    for (let step = 0; step < 6; step += 1) {
      key('j');
      await flushPromises();
      walked.push(focusId());
      // Focus never lands on a caption: it is always a conversation row.
      expect(document.activeElement?.classList.contains('inbox-row')).toBe(true);
      expect(document.activeElement?.classList.contains('row-group')).toBe(false);
    }
    // The walk is six consecutive conversation rows in list order (the order
    // that has the sender captions between conv-05 and conv-06).
    const ids = h.rowIds();
    const start = ids.indexOf(walked[0]!);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(walked).toEqual(ids.slice(start, start + 6));
    key('k');
    await flushPromises();
    expect(focusId()).toBe(ids[start + 4]);
  });

  it('opening a result and Back keeps the sender captions, the query and the row focus; the header query button reopens the collapsed form', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('from:"ada@example.test"');
    const firstId = h.rowIds()[0];
    await h.w.find('.inbox-row').trigger('click');
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(true);
    await h.w.get('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    expect(h.w.find('[data-test="reader"]').exists()).toBe(false);
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    // The results view is collapsed after the submit; the query echoes in the header.
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: from:"ada@example.test"');
    expect(h.captions()).toEqual(['Ada Fixture (15)', 'January 2025']);
    expect(document.activeElement?.getAttribute('data-test')).toBe(firstId);
    // The header query button reopens the form, focused, with the query.
    await h.w.get('[data-test="search-results-query"]').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(h.w.get('[data-test="search-input"]').element);
    expect((h.w.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('from:"ada@example.test"');
  });

  it('the restoreSearch round trip (navigate away and context-back) keeps sender grouping and stays collapsed', async () => {
    const h = await setup();
    await h.openSearch();
    await h.submit('from:"ada@example.test"');
    await h.w.get('[data-test="rail-done"]').trigger('click');
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    await h.w.get('[data-test="context-back"]').trigger('click');
    await flushPromises();
    expect(h.w.get('[data-test="inbox-title"]').text()).toBe('Search');
    // Restored results view: query+rows+cursor+focus intact, form collapsed.
    expect(h.w.find('form[role="search"]').exists()).toBe(false);
    expect(h.w.get('[data-test="search-results-query"]').text()).toBe('Search: from:"ada@example.test"');
    expect(h.captions()).toEqual(['Ada Fixture (15)', 'January 2025']);
    expect(h.rowIds()).toEqual(ADA_ROWS);
    // The query stays editable: reopening seeds the input from the restored query.
    await h.w.get('[data-test="search-results-query"]').trigger('click');
    await flushPromises();
    expect(document.activeElement).toBe(h.w.get('[data-test="search-input"]').element);
    expect((h.w.get('[data-test="search-input"]').element as HTMLInputElement).value).toBe('from:"ada@example.test"');
  });
});
