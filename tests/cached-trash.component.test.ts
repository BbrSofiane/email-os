import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { deferred, useGmailMode } from './helpers';
import { compactDateLabel, fullDateLabel, machineDateTime } from '../src/lib/browsing-dates';
import type { CachedTrashSnapshot, ConversationSummary } from '../src/lib/ipc/client';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; document.body.innerHTML = ''; });
const key = (value: string, init: KeyboardEventInit = {}) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
const active = () => (document.activeElement as HTMLElement | null)?.dataset.test;
const rowTest = (id: string) => `[data-test="conversation-row-${id}"]`;
async function goTrash(w: VueWrapper) {
  await w.get('[data-test="palette-trigger"]').trigger('click');
  await w.get('[data-test="action-query"]').setValue('Go to cached Trash');
  key('Enter');
  await flushPromises();
}
async function mountApp(fake = createBrowserFakeMailClient()) {
  wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}
function emptySnapshot(over: Partial<CachedTrashSnapshot> = {}): CachedTrashSnapshot {
  return { conversations: [], nextCursor: null, coverage: 'local_cache', exactTotal: null, lastSyncedAt: null, ...over };
}
async function trashRows(fake: ReturnType<typeof createBrowserFakeMailClient>): Promise<ConversationSummary[]> {
  return (await fake.listCachedTrash({ accountId: 'gmail-account', limit: 100, cursor: null })).conversations;
}

describe('UX-10 A read-only cached Trash list context', () => {
  it('opens the exact account+ID, suppresses mailbox shortcuts/reply and returns to the saved Trash row', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash');
    fake.controls.markTriage('conv-07', 'spam');
    const get = vi.spyOn(fake, 'getConversation');
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const group = vi.spyOn(fake, 'setArchivedGroup');
    const w = await mountApp(fake);
    expect(w.find(rowTest('conv-04')).exists()).toBe(false);
    expect(w.find(rowTest('conv-07')).exists()).toBe(false);
    await w.get('[data-test="row-select-conv-01"]').setValue(true);
    await goTrash(w);
    // The selection never follows the user into the read-only list.
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    // One Ash coverage line; the full caveat is its title and hidden text.
    const coverage = w.get('[data-test="trash-coverage"]');
    expect(coverage.text()).toContain('Cached Trash only, not your full Gmail Trash.');
    expect(coverage.attributes('title')).toContain('not your complete Gmail Trash');
    // It is the main list pane, not a drawer.
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    const row = w.get(rowTest('conv-04'));
    expect(w.find(rowTest('conv-07')).exists()).toBe(false);
    await row.trigger('click'); await flushPromises();
    expect(get).toHaveBeenLastCalledWith({ accountId: 'gmail-account', conversationId: 'conv-04' }, false);
    expect(w.find('[data-test="prepare-reply"]').exists()).toBe(false);
    // The reader carries its own Cached Trash line; the list's coverage line is not repeated above it.
    expect(w.find('[data-test="trash-coverage"]').exists()).toBe(false);
    expect(w.get('.reader-readonly').text()).toBe('Cached Trash — read only. Recovery is not available here; use your provider client.');
    const calls = get.mock.calls.length;
    for (const value of ['e', 'E', 'U', 'z', 'j', 'k']) key(value);
    await flushPromises();
    expect(get).toHaveBeenCalledTimes(calls);
    expect(archive).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled(); expect(group).not.toHaveBeenCalled();
    // Back returns to the Trash list at the same row, not to a drawer.
    key('Escape'); await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Trash');
    expect(active()).toBe('conversation-row-conv-04');
    expect(w.find('[data-test="trash-coverage"]').exists()).toBe(true);
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    // A second Back returns to the context the user came from.
    key('Escape'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.find('[data-test="trash-coverage"]').exists()).toBe(false);
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
  });

  it('opens from the rail as a plain navigation item: aria-current, no aria-expanded, same Back path', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash');
    const w = await mountApp(fake);
    const rail = w.get('[data-test="rail-trash"]');
    expect(rail.attributes('aria-current')).toBeUndefined();
    expect(rail.attributes('aria-expanded')).toBeUndefined();
    expect(rail.attributes('title')).toBe('Go to cached Trash (read only) — G then T (within 1 second)');
    await rail.trigger('click'); await flushPromises();
    expect(w.get('[data-test="rail-trash"]').attributes('aria-current')).toBe('page');
    expect(w.get('[data-test="rail-trash"]').attributes('aria-expanded')).toBeUndefined();
    expect(w.get('[data-test="rail-inbox"]').attributes('aria-current')).toBeUndefined();
    expect(w.get('h1').text()).toBe('Cached Trash');
    expect(w.get('h1').classes()).not.toContain('visually-hidden');
    expect(w.get('ul.inbox-list').attributes('aria-label')).toBe('Cached Trash conversations (read only)');
    // While a Trash row is open the rail no longer claims the list is current.
    await w.get(rowTest('conv-04')).trigger('click'); await flushPromises();
    expect(w.get('[data-test="rail-trash"]').attributes('aria-current')).toBeUndefined();
    key('Escape'); await flushPromises();
    expect(w.get('[data-test="rail-trash"]').attributes('aria-current')).toBe('page');
    // Back from the list (header button) returns to Inbox; the rail follows.
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.get('[data-test="rail-trash"]').attributes('aria-current')).toBeUndefined();
    expect(w.get('[data-test="rail-inbox"]').attributes('aria-current')).toBe('page');
  });

  it('is not a mutation surface: no row actions, checkboxes, selection or mutation keys in the list', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash'); fake.controls.markTriage('conv-05', 'trash');
    const writes = ['setArchived', 'setRead', 'setStarred', 'setArchivedGroup', 'setReadGroup', 'setStarredGroup', 'createDraft'] as const;
    const spies = writes.map((name) => vi.spyOn(fake, name));
    const get = vi.spyOn(fake, 'getConversation');
    const w = await mountApp(fake);
    await goTrash(w);
    expect(w.findAll('li.inbox-row')).toHaveLength(2);
    const list = w.get('ul.inbox-list');
    expect(list.find('button, input, .row-action, .row-actions, .row-actions-toggle').exists()).toBe(false);
    for (const letter of ['e', 'E', 'u', 'U', 'z', 's', 'S', 'h', 'x', 'X', 'r']) key(letter);
    key('J', { shiftKey: true }); key('K', { shiftKey: true });
    await flushPromises();
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    expect(w.find('[data-test="selection-live"]').exists()).toBe(false);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.find('.inbox-row.selected').exists()).toBe(false);
    // Pointer selection gestures only open the row.
    await w.get(rowTest('conv-05')).trigger('click', { shiftKey: true }); await flushPromises();
    expect(w.find('[data-test="selection-bar"]').exists()).toBe(false);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    // The palette offers navigation, never a mailbox mutation, selection or undo.
    key('Escape'); await flushPromises();
    await w.get('[data-test="palette-trigger"]').trigger('click');
    const ids = w.findAll('[role="option"]').map((option) => option.attributes('id'));
    expect(ids).toContain('action-inbox');
    for (const forbidden of ['archive', 'unarchive', 'read', 'unread', 'star', 'unstar', 'select-all-loaded', 'clear-selection', 'undo', 'remind', 'reply']) {
      expect(ids, forbidden).not.toContain(`action-${forbidden}`);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it('keeps the Trash reader read-only: no mutation or reply, J/K inert, no action notice', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash'); fake.controls.markTriage('conv-05', 'trash');
    const spies = (['setArchived', 'setRead', 'setStarred', 'createDraft'] as const).map((name) => vi.spyOn(fake, name));
    const w = await mountApp(fake);
    // An Inbox action leaves a live Undo notice behind.
    key('e'); await flushPromises();
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(true);
    const archived = spies[0]!.mock.calls.length;
    await goTrash(w);
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    await w.get(rowTest('conv-04')).trigger('click'); await flushPromises();
    expect(w.find('[data-test="action-notice-undo"]').exists()).toBe(false);
    for (const letter of ['e', 'E', 'u', 'U', 'z', 's', 'h', 'r', 'j', 'k']) key(letter);
    await flushPromises();
    expect(spies[0]!.mock.calls.length).toBe(archived);
    for (const spy of spies.slice(1)) expect(spy).not.toHaveBeenCalled();
    expect(w.find('[data-test="prepare-reply"]').exists()).toBe(false);
    expect(w.find('[data-test="reader-prev"], [data-test="reader-next"]').exists()).toBe(false);
  });

  it('does not open Account on S in Cached Trash when mailbox actions are not enabled', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash');
    const w = await mountApp(fake);
    await goTrash(w);
    key('s'); await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    await w.get(rowTest('conv-04')).trigger('click'); await flushPromises();
    key('s'); await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
  });

  it('puts the one coverage line above the list with the whole caveat in its title and hidden text', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash'); fake.controls.markTriage('conv-05', 'trash'); fake.controls.markTriage('conv-06', 'trash');
    const w = await mountApp(fake);
    await goTrash(w);
    const coverage = w.get('[data-test="trash-coverage"]');
    const caveat = coverage.attributes('title')!;
    for (const part of ['not your complete Gmail Trash', 'total is unknown', 'loaded snapshot', 'Trash is not Done', 'Recover', 'permanent delete', 'Empty Trash', 'use your provider client', 'Reading does not mark mail read']) {
      expect(caveat).toContain(part);
    }
    expect(coverage.get('.visually-hidden').text()).toBe(caveat);
    expect(coverage.attributes('role')).toBe('note');
    expect(coverage.classes()).toContain('cached-coverage');
    // The loaded count rides on the same line; the total is never invented.
    expect(coverage.text()).toContain('3 cached · total unknown');
    expect(coverage.text()).not.toContain('Last synced');
    // One note only, before the list in document order.
    expect(w.findAll('[data-test$="-coverage"]').map((el) => el.attributes('data-test'))).toEqual(['trash-coverage']);
    const html = w.element.innerHTML;
    expect(html.indexOf('data-test="trash-coverage"')).toBeLessThan(html.indexOf('inbox-list'));
  });

  it('shows the last sync on the coverage line only when the cache reports it', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash');
    const [first] = await trashRows(fake);
    vi.spyOn(fake, 'listCachedTrash').mockResolvedValue(emptySnapshot({ conversations: [first!], lastSyncedAt: '2026-01-02T03:04:00Z' }));
    const w = await mountApp(fake);
    await goTrash(w);
    expect(w.get('[data-test="trash-coverage"]').text()).toMatch(/1 cached · total unknown · Last synced .+\./);
  });

  it('renders the shared Done row: sender, subject, snippet, compact date and attachment glyph', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash');
    const w = await mountApp(fake);
    await goTrash(w);
    const [summary] = await trashRows(fake);
    const row = w.get(rowTest('conv-04'));
    expect(row.element.tagName).toBe('LI');
    const sender = summary!.primaryCorrespondent;
    expect(row.get('.row-sender').text()).toBe(sender ? (sender.displayName ?? sender.mailbox) : 'Unknown sender');
    expect(row.get('.row-subject').text()).toBe(summary!.subject);
    expect(row.get('.row-preview').text()).toBe(summary!.preview);
    const date = row.get('time.row-time');
    expect(date.text()).toBe(compactDateLabel(summary!.lastMessageAt));
    expect(date.attributes('title')).toBe(fullDateLabel(summary!.lastMessageAt));
    expect(date.attributes('datetime')).toBe(machineDateTime(summary!.lastMessageAt));
    expect(row.find('[data-test="row-attachment"], [data-test="row-attachment-unknown"]').exists() || summary!.hasAttachments === false).toBe(true);
    expect(w.findAll('li.inbox-row')).toHaveLength((await trashRows(fake)).length);
  });

  it('says "Unknown sender" instead of a blank', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    vi.spyOn(fake, 'listCachedTrash').mockResolvedValue(emptySnapshot({
      conversations: [{ ref: { accountId: 'gmail-account', conversationId: 'conv-x' }, subject: '', participants: [], lastMessageAt: '2026-01-02T03:04:00Z', pendingOperationId: null } as unknown as ConversationSummary],
    }));
    const w = await mountApp(fake);
    await goTrash(w);
    expect(w.get(rowTest('conv-x')).get('.row-sender').text()).toBe('Unknown sender');
  });

  it('shows the loading state before any data, then the empty claim without overreaching', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    const late = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash').mockReturnValue(late.promise);
    const w = await mountApp(fake);
    await goTrash(w);
    expect(w.get('[data-test="inbox-loading"]').text()).toBe('Loading Cached Trash…');
    // Before data there is no count, no empty claim and no row.
    expect(w.get('[data-test="trash-coverage"]').text()).not.toContain('cached ·');
    expect(w.text()).not.toContain('No known cached');
    expect(w.findAll('li.inbox-row')).toHaveLength(0);
    late.resolve(emptySnapshot());
    await flushPromises();
    expect(w.find('[data-test="inbox-loading"]').exists()).toBe(false);
    expect(w.get('[data-test="inbox-empty"]').text()).toBe('No known cached Trash conversations. This does not mean your Gmail Trash is empty.');
    expect(w.get('[data-test="trash-coverage"]').text()).not.toContain('cached ·');
  });

  it('moves between rows with J/K and arrows and opens with Enter, without any mutation', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash'); fake.controls.markTriage('conv-05', 'trash'); fake.controls.markTriage('conv-06', 'trash');
    const get = vi.spyOn(fake, 'getConversation');
    const archive = vi.spyOn(fake, 'setArchived');
    const w = await mountApp(fake);
    await goTrash(w);
    const ids = w.findAll('li.inbox-row').map((li) => li.attributes('data-test'));
    expect(ids).toHaveLength(3);
    expect(active()).toBe(ids[0]);
    key('j'); await flushPromises();
    expect(active()).toBe(ids[1]);
    key('ArrowDown'); await flushPromises();
    expect(active()).toBe(ids[2]);
    key('k'); await flushPromises();
    expect(active()).toBe(ids[1]);
    expect(w.findAll('li.inbox-row').map((li) => li.attributes('tabindex'))).toEqual(['-1', '0', '-1']);
    expect(get).not.toHaveBeenCalled();
    key('Enter'); await flushPromises();
    expect(get).toHaveBeenLastCalledWith({ accountId: 'gmail-account', conversationId: ids[1]!.replace('conversation-row-', '') }, false);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    key('Escape'); await flushPromises();
    expect(active()).toBe(ids[1]);
    expect(archive).not.toHaveBeenCalled();
  });

  it('omits the destination for unsupported fixture mode and rejects direct fake calls', async () => {
    const fake = createBrowserFakeMailClient();
    await expect(fake.listCachedTrash({ accountId: 'gmail-account', limit: 10, cursor: null })).rejects.toEqual({ kind: 'invalid_request', field: 'mode' });
    wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' } }); await flushPromises();
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
    const w = await mountApp(fake);
    await goTrash(w);
    const alert = w.get('[data-test="inbox-error"] [role="alert"]');
    expect(alert.text()).toBe('Could not load Cached Trash: storage unavailable.');
    expect(w.text()).not.toContain('No known cached');
    expect(w.findAll('li.inbox-row')).toHaveLength(0);
    await w.get('[data-test="inbox-retry"]').trigger('click'); await flushPromises();
    expect(query).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenLastCalledWith({ accountId: 'gmail-account', limit: 100, cursor: null });
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(w.text()).toContain('does not mean your Gmail Trash is empty');
  });

  it('pages with Load more, appends without duplicates and keeps the focused row', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    for (const id of ['conv-04', 'conv-05', 'conv-06']) fake.controls.markTriage(id, 'trash');
    const [a, b, c] = await trashRows(fake);
    const query = vi.spyOn(fake, 'listCachedTrash')
      .mockResolvedValueOnce(emptySnapshot({ conversations: [a!, b!], nextCursor: 'page-2' }))
      .mockResolvedValueOnce(emptySnapshot({ conversations: [b!, c!], nextCursor: null }));
    const w = await mountApp(fake);
    await goTrash(w);
    expect(w.findAll('li.inbox-row')).toHaveLength(2);
    const more = w.get('[data-test="done-more"]');
    expect(more.text()).toBe('Load more Cached Trash');
    expect(w.get('[data-test="trash-coverage"]').text()).toContain('2 cached · total unknown');
    key('j'); await flushPromises();
    const focused = active();
    await more.trigger('click'); await flushPromises();
    expect(query).toHaveBeenLastCalledWith({ accountId: 'gmail-account', limit: 100, cursor: 'page-2' });
    expect(w.findAll('li.inbox-row')).toHaveLength(3);
    expect(w.find('[data-test="done-more"]').exists()).toBe(false);
    expect(w.get('[data-test="trash-coverage"]').text()).toContain('3 cached · total unknown');
    expect(w.get('li.inbox-row[aria-current="true"]').attributes('data-test')).toBe(focused);
  });

  it('does not apply a delayed page after leaving the list or unmounting', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake);
    fake.controls.markTriage('conv-04', 'trash');
    const [row] = await trashRows(fake);
    const late = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash').mockReturnValue(late.promise);
    const w = await mountApp(fake);
    await goTrash(w);
    expect(w.find('[data-test="inbox-loading"]').exists()).toBe(true);
    await w.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    late.resolve(emptySnapshot({ conversations: [row!], nextCursor: 'stale' }));
    await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    expect(w.find(rowTest('conv-04')).exists()).toBe(false);
    expect(w.find('[data-test="done-more"]').exists()).toBe(false);
    expect(w.find('[data-test="trash-coverage"]').exists()).toBe(false);
    // Unmount with a request in flight: the late page settles silently.
    const later = deferred<CachedTrashSnapshot>();
    vi.spyOn(fake, 'listCachedTrash').mockReturnValue(later.promise);
    await goTrash(w);
    w.unmount(); wrapper = null;
    const problems: Event[] = [];
    const onProblem = (event: Event) => { problems.push(event); };
    window.addEventListener('unhandledrejection', onProblem); window.addEventListener('error', onProblem);
    later.resolve(emptySnapshot({ conversations: [row!], nextCursor: 'stale' }));
    await flushPromises();
    window.removeEventListener('unhandledrejection', onProblem); window.removeEventListener('error', onProblem);
    expect(problems).toEqual([]);
  });

  it('teaches the Activity subject index from Trash rows', async () => {
    const fake = createBrowserFakeMailClient(); useGmailMode(fake, { mutationAccess: 'enabled' });
    // An archive leaves an Activity row for conv-04; it then lands in Trash, so the Inbox never lists it.
    await fake.setArchived({ conversation: { accountId: 'gmail-account', conversationId: 'conv-04' }, archived: true, requestId: 'before-trash' });
    fake.controls.markTriage('conv-04', 'trash');
    const [row] = await trashRows(fake);
    const w = await mountApp(fake);
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    expect(w.get('[data-test="utility-drawer"]').text()).toContain('Unknown conversation');
    key('Escape'); await flushPromises();
    await goTrash(w);
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    const drawer = w.get('[data-test="utility-drawer"]');
    expect(drawer.text()).not.toContain('Unknown conversation');
    expect(drawer.text()).toContain(row!.subject);
  });
});
