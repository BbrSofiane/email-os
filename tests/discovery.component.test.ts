import { afterEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { InboxSnapshot } from '../src/lib/ipc/client';
import { createDiscoveryFixture } from './discovery.fixture';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
function key(key: string, options: KeyboardEventInit = {}) {
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key, ...options }));
}
async function setup() {
  const fixture = createDiscoveryFixture();
  await fixture.seedDone();
  wrapper = mount(App, { props: { client: fixture.client, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  return { fixture, w: wrapper };
}
async function palette(w: VueWrapper, query = '') {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  await w.get('[data-test="action-query"]').setValue(query);
}

describe('UX-03 discovery and context history', () => {
  it('focuses the actual palette input, owns ordinary typing, highlights and restores origin', async () => {
    const { fixture, w } = await setup();
    const row = w.get('[data-test="conversation-row-read-02"]').element as HTMLElement;
    row.focus();
    await palette(w);
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    await w.get('[data-test="action-query"]').setValue('e/s/h');
    for (const value of ['e', 's', 'h', 'ArrowLeft', 'Enter']) key(value);
    await flushPromises();
    expect(w.get('[data-test="action-query"]').element).toBe(document.activeElement);
    expect(fixture.controls.archiveCommands).toEqual([]);
    expect(fixture.controls.readCommands).toEqual([]);
    expect(w.get('.app-main').attributes('inert')).toBeDefined();
    key('Escape');
    await flushPromises();
    expect(document.activeElement).toBe(row);
  });

  it('restores surviving focus when the overlay origin row disappears in a background update', async () => {
    const { fixture, w } = await setup();
    (w.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
    await palette(w);
    fixture.controls.removeFromInbox('read-02'); await flushPromises();
    key('Escape'); await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-read-03');
  });

  it('palette → Done → reader Back → context Back restores the account-scoped Inbox focus', async () => {
    const { fixture, w } = await setup();
    (w.get('[data-test="conversation-row-read-03"]').element as HTMLElement).focus();
    await palette(w, 'Go to cached Done');
    expect(w.get('[role="option"]').attributes('aria-selected')).toBe('true');
    key('Enter'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    expect(w.get('[data-test="done-coverage"]').text()).toContain('Total unknown');
    await w.get('[data-test="conversation-row-read-01"]').trigger('click'); await flushPromises();
    key('Escape'); await flushPromises();
    expect(w.find('[data-test="conversation-row-read-01"]').exists()).toBe(true);
    key('Escape'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-03');
    expect(fixture.controls.archiveCommands).toEqual([]);
    expect(fixture.controls.readCommands).toEqual([]);
  });

  it('supports Left and pointer navigator, Arrow highlight/Enter, and Escape without leaving the reader', async () => {
    const { w } = await setup();
    const row = w.get('[data-test="conversation-row-read-02"]').element as HTMLElement;
    row.focus(); key('ArrowLeft'); await flushPromises();
    expect(w.get('[role="dialog"]').attributes('aria-label')).toBe('Destination navigator');
    key('ArrowDown'); await flushPromises();
    expect(w.get('[aria-selected="true"]').text()).toContain('cached Done');
    key('Escape'); await flushPromises(); expect(document.activeElement).toBe(row);
    await w.get('[data-test="conversation-row-read-02"]').trigger('click'); await flushPromises();
    key('ArrowLeft'); await flushPromises(); expect(w.find('[role="dialog"]').exists()).toBe(false);
    await w.get('[data-test="navigator-trigger"]').trigger('click'); await flushPromises();
    key('Escape'); await flushPromises(); expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('G then E is cancelled by unrelated keys, modifiers, IME, overlays, blur and timeout; no GH', async () => {
    const { fixture, w } = await setup();
    const focus = () => (w.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
    focus();
    // 'x' is now the UX-05 selection toggle; use a non-shortcut key as the
    // plain-typing cancel scenario.
    for (const cancel of [() => key('h'), () => key('m'), () => key('Control', { ctrlKey: true }), () => key('Process', { isComposing: true }), () => window.dispatchEvent(new Event('blur'))]) {
      key('g'); cancel(); key('e', { ctrlKey: true }); key('h');
    }
    key('g'); await palette(w); key('Escape'); await flushPromises();
    key('e', { ctrlKey: true });
    focus(); key('g'); await new Promise((resolve) => setTimeout(resolve, 1050)); key('e'); await flushPromises();
    expect(fixture.doneCalls()).toBe(0);
    expect(fixture.controls.archiveCommands.map((command) => command.conversation.conversationId)).toEqual(['read-02']);
    key('g'); key('e'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
  });

  it('fences delayed Done responses/errors on context transition and keeps error targets unavailable', async () => {
    const { fixture, w } = await setup();
    fixture.delayDone(50); fixture.failDone({ kind: 'storage_unavailable' });
    await w.get('[data-test="rail-done"]').trigger('click');
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 70)); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(false);
    fixture.failDone({ kind: 'storage_unavailable' });
    await w.get('[data-test="rail-done"]').trigger('click'); await new Promise((resolve) => setTimeout(resolve, 70)); await flushPromises();
    expect(w.get('[data-test="inbox-error"]').text()).toContain('storage unavailable');
    await palette(w);
    expect(w.find('#action-archive').exists()).toBe(false);
    expect(w.find('#action-unarchive').exists()).toBe(false);
    expect(fixture.controls.archiveCommands).toEqual([]);
  });

  it('rechecks capability and reader-loading targets and leaves Activity-origin JK a strict no-op', async () => {
    const { fixture, w } = await setup();
    await palette(w);
    expect(w.find('#action-archive').exists()).toBe(true);
    fixture.setEnabled(false); await flushPromises();
    expect(w.find('#action-archive').exists()).toBe(false);
    key('Escape'); await flushPromises();
    fixture.controls.delayNextDetail(50);
    await w.get('[data-test="conversation-row-read-02"]').trigger('click');
    await palette(w);
    expect(w.find('#action-unread').exists()).toBe(false);
    key('Escape'); await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 60)); await flushPromises();
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    await w.get('[data-test^="activity-open-"]').trigger('click');
    await flushPromises();
    const calls = fixture.controls.detailCalls.length;
    key('j'); key('k'); await flushPromises();
    expect(fixture.controls.detailCalls).toHaveLength(calls);
  });
});

describe('UX-03 query and lifecycle guarantees', () => {
  it('handles an empty page with nextCursor, loads more, resolves focus, and retains independent Activity', async () => {
    const fixture = createDiscoveryFixture();
    await fixture.seedDone();
    const original = fixture.client.listCachedDone;
    const requests: Array<string | null> = [];
    fixture.client.listCachedDone = async (request) => {
      requests.push(request.cursor);
      if (request.cursor === null) return { conversations: [], nextCursor: 'next', coverage: 'local_cache', exactTotal: null, lastSyncedAt: null };
      return original(request);
    };
    wrapper = mount(App, { props: { client: fixture.client, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await wrapper.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    expect(wrapper.get('[data-test="inbox-empty"]').text()).toContain('more cached candidates');
    await wrapper.get('[data-test="done-more"]').trigger('click'); await flushPromises();
    expect(requests).toEqual([null, 'next']);
    expect(wrapper.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-01');
    await wrapper.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    expect(wrapper.findAll('[data-test^="activity-open-"]').length).toBeGreaterThan(0);
  });

  it('does not fence independently pending Activity behind a Done pagination request', async () => {
    const { fixture, w } = await setup();
    const inbox = await fixture.client.listConversations();
    const done = await fixture.client.listCachedDone({ accountId: 'reader-account', limit: 100, cursor: null });
    let resolveActivity!: (snapshot: InboxSnapshot) => void;
    fixture.client.listConversations = () => new Promise((resolve) => { resolveActivity = resolve; });
    fixture.client.listCachedDone = async (request) => ({ ...done, nextCursor: request.cursor === null ? 'more' : null });
    await w.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    await w.get('[data-test="done-more"]').trigger('click'); await flushPromises();
    resolveActivity({ ...inbox, activity: inbox.activity.map((operation) => ({ ...operation, status: 'failed' })) });
    await flushPromises();
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="activity-failed"]').exists()).toBe(true);
  });

  it('Done reader JK stays in its source list even if Inbox has other neighbors', async () => {
    const { fixture, w } = await setup();
    await fixture.seedDone('read-04'); await flushPromises();
    await w.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    await w.get('[data-test="conversation-row-read-01"]').trigger('click'); await flushPromises();
    const before = fixture.controls.detailCalls.length;
    key('j'); await flushPromises();
    expect(w.get('.reader-subject').text()).toContain('read-04');
    expect(fixture.controls.detailCalls.slice(before).map((ref) => ref.conversationId)).toEqual(['read-04']);
    key('k'); await flushPromises();
    expect(w.get('.reader-subject').text()).toBe('Reader journey thread');
    expect(fixture.controls.archiveCommands).toEqual([]);
  });

  it('revalidates targets across slow reader navigation so palette cannot mutate the previous thread', async () => {
    const { fixture, w } = await setup();
    await w.get('[data-test="conversation-row-read-02"]').trigger('click'); await flushPromises();
    fixture.controls.delayNextDetail(50);
    key('j');
    await palette(w);
    expect(w.find('#action-archive').exists()).toBe(false);
    expect(w.find('#action-unread').exists()).toBe(false);
    await w.get('[data-test="action-query"]').setValue('e/s/h'); key('e'); key('Enter'); await flushPromises();
    expect(fixture.controls.archiveCommands).toEqual([]);
    expect(fixture.controls.readCommands).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 60)); await flushPromises();
    await w.get('[data-test="action-query"]').setValue('Mark Done'); key('Enter'); await flushPromises();
    expect(fixture.controls.archiveCommands.map((command) => command.conversation.conversationId)).toEqual(['read-03']);
  });

  it('keeps dirty draft recovery visible and aborts a palette destination when save fails', async () => {
    const { fixture, w } = await setup();
    await w.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    await w.get('[data-test="new-draft"]').trigger('click'); await flushPromises();
    await w.get('[data-test="draft-body"]').setValue('Exact unsaved buffer ✓');
    fixture.client.saveDraft = async () => { throw { kind: 'storage_unavailable' }; };
    await palette(w, 'Go to cached Done'); key('Enter'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect((w.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('Exact unsaved buffer ✓');
    expect(w.get('[data-test="utility-drawer"]').attributes('aria-label')).toBe('Local drafts');
    expect(fixture.doneCalls()).toBe(0);
  });

  it('clears account-scoped history and rejects a late Done snapshot after account identity changes', async () => {
    const { fixture, w } = await setup();
    fixture.delayDone(50);
    await w.get('[data-test="rail-done"]').trigger('click');
    const previousStatus = await fixture.client.getAccountStatus();
    fixture.client.getAccountStatus = async () => ({ ...previousStatus, account: { accountId: 'replacement-account', emailAddress: 'replacement@example.test' } });
    fixture.client.listConversations = async () => ({ conversations: [], activity: [] });
    fixture.controls.notify();
    await new Promise((resolve) => setTimeout(resolve, 70)); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.find('[data-test="context-back"]').exists()).toBe(false);
    expect(w.find('[data-test="conversation-row-read-01"]').exists()).toBe(false);
    await palette(w);
    expect(w.find('#action-archive').exists()).toBe(false);
    expect(w.find('#action-back').exists()).toBe(false);
  });

  it('revalidates loaded Done pages on refresh and restores page-two history before focus fallback', async () => {
    const { fixture, w } = await setup();
    await fixture.seedDone('read-04');
    const full = await fixture.client.listCachedDone({ accountId: 'reader-account', limit: 100, cursor: null });
    expect(full.conversations.map((row) => row.ref.conversationId)).toEqual(['read-01', 'read-04']);
    const requests: Array<string | null> = [];
    fixture.client.listCachedDone = async (request) => {
      requests.push(request.cursor);
      return { ...full, conversations: full.conversations.slice(request.cursor ? 1 : 0, request.cursor ? 2 : 1), nextCursor: request.cursor ? null : 'page-two' };
    };
    await w.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="conversation-row-read-04"]').exists()).toBe(false);
    await w.get('[data-test="done-more"]').trigger('click'); await flushPromises();
    (w.get('[data-test="conversation-row-read-04"]').element as HTMLElement).focus();
    fixture.controls.notify(); await flushPromises();
    expect(requests.slice(-2)).toEqual([null, 'page-two']);
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-04');
    await w.get('[data-test="conversation-row-read-04"]').trigger('click'); await flushPromises();
    fixture.controls.notify(); await flushPromises();
    key('k'); await flushPromises();
    expect(fixture.controls.detailCalls.at(-1)?.conversationId).toBe('read-01');
    key('Escape'); await flushPromises();
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(requests.slice(-2)).toEqual([null, 'page-two']);
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-04');
    expect(fixture.controls.archiveCommands).toEqual([]);
  });

  it('recovers surviving focus across shifted page edges on refresh and Context Back', async () => {
    const { fixture, w } = await setup();
    await fixture.seedDone('read-04');
    const full = await fixture.client.listCachedDone({ accountId: 'reader-account', limit: 100, cursor: null });
    const inbox = await fixture.client.listConversations();
    const firstInsertion = { ...inbox.conversations.find((row) => row.ref.conversationId === 'read-02')!, lastMessageAt: '2099-01-01T00:00:00Z' };
    const secondInsertion = { ...inbox.conversations.find((row) => row.ref.conversationId === 'read-03')!, lastMessageAt: '2100-01-01T00:00:00Z' };
    let insertions = 0;
    const requests: Array<string | null> = [];
    fixture.client.listCachedDone = async (request) => {
      requests.push(request.cursor);
      const rows = [...(insertions > 1 ? [secondInsertion] : []), ...(insertions ? [firstInsertion] : []), ...full.conversations];
      const index = request.cursor ? Number(request.cursor) : 0;
      return { ...full, conversations: rows.slice(index, index + 1), nextCursor: index + 1 < rows.length ? String(index + 1) : null };
    };
    await w.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    await w.get('[data-test="done-more"]').trigger('click'); await flushPromises();
    (w.get('[data-test="conversation-row-read-04"]').element as HTMLElement).focus();
    insertions = 1; fixture.controls.notify(); await flushPromises();
    expect(requests.slice(-3)).toEqual([null, '1', '2']);
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-04');
    await w.get('[data-test="conversation-row-read-04"]').trigger('click'); await flushPromises();
    fixture.controls.notify(); await flushPromises();
    key('k'); await flushPromises();
    expect(fixture.controls.detailCalls.at(-1)?.conversationId).toBe('read-01');
    key('Escape'); await flushPromises();
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    insertions = 2;
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(requests.slice(-4)).toEqual([null, '1', '2', '3']);
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-04');
    expect(fixture.controls.archiveCommands).toEqual([]);
  });

  it.each([false, true])('fails visibly rather than inventing a removed target if range recovery exceeds its bound (reader=%s)', async (reader) => {
    const { fixture, w } = await setup();
    await w.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="conversation-row-read-01"]').exists()).toBe(true);
    if (reader) {
      await w.get('[data-test="conversation-row-read-01"]').trigger('click'); await flushPromises();
      expect(w.find('[data-test="reader"]').exists()).toBe(true);
    }
    let requests = 0;
    fixture.client.listCachedDone = async () => {
      requests += 1;
      return { conversations: [], nextCursor: String(requests), coverage: 'local_cache', exactTotal: null, lastSyncedAt: null };
    };
    fixture.controls.notify(); await flushPromises();
    expect(requests).toBe(11);
    expect(w.get(reader ? '[data-test="reader-navigation-error"]' : '[data-test="inbox-error"]').text()).toContain('restoration limit');
    if (reader) {
      expect(w.get('[data-test="reader-navigation-error"]').text()).toContain('Retry list');
      expect(w.get('[data-test="reader-archive-toggle"]').attributes('disabled')).toBeDefined();
      expect(w.get('[data-test="reader-toggle-read"]').attributes('disabled')).toBeDefined();
      const calls = fixture.controls.detailCalls.length;
      key('j'); key('k'); key('E', { shiftKey: true }); key('U', { shiftKey: true }); await flushPromises();
      expect(fixture.controls.detailCalls).toHaveLength(calls);
    }
    await palette(w);
    expect(w.find('#action-unarchive').exists()).toBe(false);
    expect(fixture.controls.archiveCommands).toEqual([]);
  });

  it('clears Done pagination on explicit disconnect before issuing another destination query', async () => {
    const { fixture, w } = await setup();
    const status = await fixture.client.getAccountStatus();
    let disconnected = false;
    fixture.client.disconnectAccount = async () => { disconnected = true; };
    fixture.client.getAccountStatus = async () => disconnected ? { ...status, account: null, connection: 'disconnected' } : status;
    const original = fixture.client.listConversations;
    fixture.client.listConversations = async () => disconnected ? { conversations: [], activity: [] } : original();
    await w.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    const calls = fixture.doneCalls();
    await w.get('[data-test="rail-account"]').trigger('click'); await flushPromises();
    await w.get('[data-test="account-disconnect"]').trigger('click'); await flushPromises();
    await w.get('[data-test="drawer-close"]').trigger('click'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.find('[data-test="done-more"]').exists()).toBe(false);
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(fixture.doneCalls()).toBe(calls);
  });

  it('restores a row-origin palette without triggering the row reveal handler', async () => {
    const { w } = await setup();
    await w.setProps({ mode: 'native' });
    const row = w.get('[data-test="conversation-row-read-03"]').element as HTMLElement;
    let reveals = 0;
    row.scrollIntoView = () => { reveals += 1; };
    row.focus(); reveals = 0;
    key('k', { metaKey: true }); await flushPromises();
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    key('Escape'); await flushPromises();
    expect(document.activeElement).toBe(row);
    expect(reveals).toBe(0);
  });

  it('supports native Cmd+K without capturing the browser-reserved command and dismisses only the top overlay', async () => {
    const { w } = await setup();
    const row = w.get('[data-test="conversation-row-read-02"]').element as HTMLElement;
    row.focus(); key('k', { metaKey: true }); await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    await w.setProps({ mode: 'native' });
    key('k', { metaKey: true }); await flushPromises();
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    key('Escape'); await flushPromises(); expect(document.activeElement).toBe(row);
    await w.get('[data-test="conversation-row-read-02"]').trigger('click'); await flushPromises();
    key('k', { metaKey: true }); await flushPromises(); key('Escape'); await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });
});
