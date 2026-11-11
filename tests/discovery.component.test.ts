import { press } from "./helpers";
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { InboxSnapshot } from "../src/lib/ipc/client";
import { createDiscoveryFixture } from "./support/fixtures/discovery.fixture";
import { mountApp } from "./helpers";
import { useUiTestClock } from "./support/timers";

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });
beforeEach(useUiTestClock);
afterEach(() => vi.useRealTimers());

async function setup() {
  const fixture = createDiscoveryFixture();
  await fixture.seedDone();
  wrapper = mountApp(fixture.client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  return { fixture, w: wrapper };
}
async function palette(w: VueWrapper, query = '') {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  await w.get('[data-test="action-query"]').setValue(query);
}

describe("preserves discovery focus and context history (UX-03)", () => {
  it('focuses the actual palette input, owns ordinary typing, highlights and restores origin', async () => {
    const { fixture, w } = await setup();
    const row = w.get('[data-test="conversation-row-read-02"]').element as HTMLElement;
    row.focus();
    await palette(w);
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    await w.get('[data-test="action-query"]').setValue('e/s/h');
    for (const value of ['e', 's', 'h', 'ArrowLeft', 'Enter']) press(value, { bubbles: true, cancelable: true });
    await flushPromises();
    expect(w.get('[data-test="action-query"]').element).toBe(document.activeElement);
    expect(fixture.controls.archiveCommands).toEqual([]);
    expect(fixture.controls.readCommands).toEqual([]);
    expect(w.get('.app-main').attributes('inert')).toBeDefined();
    press('Escape', { bubbles: true, cancelable: true });
    await flushPromises();
    expect(document.activeElement).toBe(row);
  });

  it('restores surviving focus when the overlay origin row disappears in a background update', async () => {
    const { fixture, w } = await setup();
    (w.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
    await palette(w);
    fixture.controls.removeFromInbox('read-02'); await flushPromises();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-read-03');
  });

  it('palette → Done → reader Back → context Back restores the account-scoped Inbox focus', async () => {
    const { fixture, w } = await setup();
    (w.get('[data-test="conversation-row-read-03"]').element as HTMLElement).focus();
    await palette(w, 'Go to cached Done');
    expect(w.get('[role="option"]').attributes('aria-selected')).toBe('true');
    press('Enter', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    expect(w.get('[data-test="done-coverage"]').text()).toContain('Total unknown');
    await w.get('[data-test="conversation-row-read-01"]').trigger('click'); await flushPromises();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('[data-test="conversation-row-read-01"]').exists()).toBe(true);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-read-03');
    expect(fixture.controls.archiveCommands).toEqual([]);
    expect(fixture.controls.readCommands).toEqual([]);
  });

  it('supports Left and pointer navigator, Arrow highlight/Enter, and Escape without leaving the reader', async () => {
    const { w } = await setup();
    const row = w.get('[data-test="conversation-row-read-02"]').element as HTMLElement;
    row.focus(); press('ArrowLeft', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[role="dialog"]').attributes('aria-label')).toBe('Destination navigator');
    press('ArrowDown', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[aria-selected="true"]').text()).toContain('cached Done');
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises(); expect(document.activeElement).toBe(row);
    await w.get('[data-test="conversation-row-read-02"]').trigger('click'); await flushPromises();
    press('ArrowLeft', { bubbles: true, cancelable: true }); await flushPromises(); expect(w.find('[role="dialog"]').exists()).toBe(false);
    await w.get('[data-test="navigator-trigger"]').trigger('click'); await flushPromises();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises(); expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('lists Provider mail in the navigator like the rail and opens its drawer', async () => {
    const { w } = await setup();
    (w.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
    press('ArrowLeft', { bubbles: true, cancelable: true }); await flushPromises();
    await w.get('[data-test="action-query"]').setValue('provider'); await flushPromises();
    expect(w.findAll('[role="option"]').map((o) => o.text())).toEqual([expect.stringContaining('Go to Provider mail (read only)')]);
    press('Enter', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    expect(w.get('[data-test="utility-drawer"]').attributes('aria-label')).toBe('Provider mail — read only');
  });

  it('names the archive action "Mark done" once and keeps "archive" as a search alias', async () => {
    const { w } = await setup();
    (w.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
    await palette(w, 'archive'); await flushPromises();
    expect(w.findAll('[role="option"]').map((o) => o.find('.action-copy > span').text())).toEqual(['Mark done']);
  });

  it('G then E is cancelled by unrelated keys, modifiers, IME, overlays, blur and timeout; no GH', async () => {
    const { fixture, w } = await setup();
    const focus = () => (w.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
    focus();
    // 'x' is now the UX-05 selection toggle; use a non-shortcut key as the
    // plain-typing cancel scenario.
    for (const cancel of [() => press('h', { bubbles: true, cancelable: true }), () => press('m', { bubbles: true, cancelable: true }), () => press('Control', { bubbles: true, cancelable: true, ...{ ctrlKey: true } }), () => press('Process', { bubbles: true, cancelable: true, ...{ isComposing: true } }), () => window.dispatchEvent(new Event('blur'))]) {
      press('g', { bubbles: true, cancelable: true }); cancel(); press('e', { bubbles: true, cancelable: true, ...{ ctrlKey: true } }); press('h', { bubbles: true, cancelable: true });
    }
    press('g', { bubbles: true, cancelable: true }); await palette(w); press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    press('e', { bubbles: true, cancelable: true, ...{ ctrlKey: true } });
    // Past the chord window AND the swallow grace, a plain e is Archive again.
    focus(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(2200); vi.useRealTimers(); press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(fixture.doneCalls()).toBe(0);
    expect(fixture.controls.archiveCommands.map((command) => command.conversation.conversationId)).toEqual(['read-02']);
    press('g', { bubbles: true, cancelable: true }); press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
  });

  it('fences delayed Done responses/errors on context transition and keeps error targets unavailable', async () => {
    const { fixture, w } = await setup();
    fixture.delayDone(50); fixture.failDone({ kind: 'storage_unavailable' });
    await w.get('[data-test="rail-done"]').trigger('click');
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    await vi.advanceTimersByTimeAsync(70); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(false);
    fixture.failDone({ kind: 'storage_unavailable' });
    await w.get('[data-test="rail-done"]').trigger('click'); await vi.advanceTimersByTimeAsync(70); await flushPromises();
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
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    fixture.controls.delayNextDetail(50);
    await w.get('[data-test="conversation-row-read-02"]').trigger('click');
    await palette(w);
    expect(w.find('#action-unread').exists()).toBe(false);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    await vi.advanceTimersByTimeAsync(60); await flushPromises();
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    await w.get('[data-test^="activity-open-"]').trigger('click');
    await flushPromises();
    const calls = fixture.controls.detailCalls.length;
    press('j', { bubbles: true, cancelable: true }); press('k', { bubbles: true, cancelable: true }); await flushPromises();
    expect(fixture.controls.detailCalls).toHaveLength(calls);
  });
});

describe("revalidates query and lifecycle targets (UX-03)", () => {
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
    wrapper = mountApp(fixture.client, 'browser-preview', { attachTo: document.body });
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
    press('j', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('.reader-subject').text()).toContain('read-04');
    expect(fixture.controls.detailCalls.slice(before).map((ref) => ref.conversationId)).toEqual(['read-04']);
    press('k', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('.reader-subject').text()).toBe('Reader journey thread');
    expect(fixture.controls.archiveCommands).toEqual([]);
  });

  it('revalidates targets across slow reader navigation so palette cannot mutate the previous thread', async () => {
    const { fixture, w } = await setup();
    await w.get('[data-test="conversation-row-read-03"]').trigger('click'); await flushPromises();
    // The next neighbor (read-04) is prefetched; K targets the uncached read-02.
    fixture.controls.delayNextDetail(50);
    press('k', { bubbles: true, cancelable: true });
    await palette(w);
    expect(w.find('#action-archive').exists()).toBe(false);
    expect(w.find('#action-unread').exists()).toBe(false);
    await w.get('[data-test="action-query"]').setValue('e/s/h'); press('e', { bubbles: true, cancelable: true }); press('Enter', { bubbles: true, cancelable: true }); await flushPromises();
    expect(fixture.controls.archiveCommands).toEqual([]);
    expect(fixture.controls.readCommands).toEqual([]);
    // Advance beyond both the 50ms detail delay and the 120ms hold.
    await vi.advanceTimersByTimeAsync(250); await flushPromises();
    await w.get('[data-test="action-query"]').setValue('Mark done'); press('Enter', { bubbles: true, cancelable: true }); await flushPromises();
    expect(fixture.controls.archiveCommands.map((command) => command.conversation.conversationId)).toEqual(['read-02']);
  });

  it('keeps dirty draft recovery visible and aborts a palette destination when save fails', async () => {
    const { fixture, w } = await setup();
    await w.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    await w.get('[data-test="new-draft"]').trigger('click'); await flushPromises();
    await w.get('[data-test="draft-body"]').setValue('Exact unsaved buffer ✓');
    fixture.client.saveDraft = async () => { throw { kind: 'storage_unavailable' }; };
    await palette(w, 'Go to cached Done'); press('Enter', { bubbles: true, cancelable: true }); await flushPromises();
    // The aborted destination leaves the Drafts context and its editor card in place.
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Drafts');
    expect((w.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('Exact unsaved buffer ✓');
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
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
    await vi.advanceTimersByTimeAsync(70); await flushPromises();
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
    const callsBeforeK = fixture.controls.detailCalls.length;
    press('k', { bubbles: true, cancelable: true }); await flushPromises();
    // K requests read-01 first; a neighbor prefetch may follow it.
    expect(fixture.controls.detailCalls[callsBeforeK]?.conversationId).toBe('read-01');
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
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
    const callsBeforeK = fixture.controls.detailCalls.length;
    press('k', { bubbles: true, cancelable: true }); await flushPromises();
    // K requests read-01 first; a neighbor prefetch may follow it.
    expect(fixture.controls.detailCalls[callsBeforeK]?.conversationId).toBe('read-01');
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
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
      press('j', { bubbles: true, cancelable: true }); press('k', { bubbles: true, cancelable: true }); press('E', { bubbles: true, cancelable: true, ...{ shiftKey: true } }); press('U', { bubbles: true, cancelable: true, ...{ shiftKey: true } }); await flushPromises();
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
    press('k', { bubbles: true, cancelable: true, ...{ metaKey: true } }); await flushPromises();
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(document.activeElement).toBe(row);
    expect(reveals).toBe(0);
  });

  it('supports native Cmd+K without capturing the browser-reserved command and dismisses only the top overlay', async () => {
    const { w } = await setup();
    const row = w.get('[data-test="conversation-row-read-02"]').element as HTMLElement;
    row.focus(); press('k', { bubbles: true, cancelable: true, ...{ metaKey: true } }); await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);
    await w.setProps({ mode: 'native' });
    press('k', { bubbles: true, cancelable: true, ...{ metaKey: true } }); await flushPromises();
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises(); expect(document.activeElement).toBe(row);
    await w.get('[data-test="conversation-row-read-02"]').trigger('click'); await flushPromises();
    press('k', { bubbles: true, cancelable: true, ...{ metaKey: true } }); await flushPromises(); press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });
});
