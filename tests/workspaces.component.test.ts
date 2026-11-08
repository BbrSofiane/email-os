import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import FixtureWorkspaces from '../src/FixtureWorkspaces.vue';
import App from '../src/App.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { Conversation, MailClient, OperationReceipt } from '../src/lib/ipc/client';
import { deferred, flushMacrotasks } from './helpers';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; vi.restoreAllMocks(); });
const identity = (accountId: string) => ({ accountId, emailAddress: `${accountId}@example.test` });
const aId = 'fixture-a';
const bId = 'fixture-b';
function key(value: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...options });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}
async function setup(adaptA: (client: MailClient) => MailClient = (c) => c) {
  const a = createBrowserFakeMailClient(undefined, identity(aId));
  const b = createBrowserFakeMailClient(undefined, identity(bId));
  const clientA = adaptA(a);
  wrapper = mount(FixtureWorkspaces, { props: { sessions: [
    { ...identity(aId), client: clientA }, { ...identity(bId), client: b },
  ] }, attachTo: document.body });
  await flushPromises();
  return { w: wrapper, a, b, pa: wrapper.get(`[data-workspace="${aId}"]`), pb: wrapper.get(`[data-workspace="${bId}"]`) };
}
async function switchTo(w: VueWrapper, id: string) {
  await w.get(`[data-test="switch-${id}"]`).trigger('click');
  await flushPromises();
}

describe('UX-13A independent synthetic sessions', () => {
  it('keeps identical IDs, focus, selection, reader, Back and scroll independent; hidden keys do nothing', async () => {
    const { w, a, b, pa, pb } = await setup();
    const rowA = pa.get('[data-test="conversation-row-conv-03"]').element as HTMLElement;
    rowA.focus(); key('x'); await flushPromises();
    const scroller = pa.get('.inbox-list').element as HTMLElement;
    scroller.scrollTop = 120;
    await switchTo(w, bId);
    // Browsers drop scroll offsets of display:none subtrees; jsdom does not, so simulate it.
    scroller.scrollTop = 0;
    expect(pa.attributes('inert')).toBeDefined();
    expect(pb.findAll('[aria-checked="true"]')).toHaveLength(0);
    const rowB = pb.get('[data-test="conversation-row-conv-01"]').element as HTMLElement;
    rowB.focus(); key('j'); await flushPromises();
    expect(pb.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-conv-02');
    await pb.get('[data-test="conversation-row-conv-02"]').trigger('click'); await flushPromises();
    expect(pb.get('[data-test="reader"]').text()).toContain('Fixture thread 2');
    await switchTo(w, aId);
    expect(pa.find('[data-test="reader"]').exists()).toBe(false);
    expect(document.activeElement).toBe(rowA);
    expect(scroller.scrollTop).toBe(120);
    expect((pa.get('[data-test="row-select-conv-03"]').element as HTMLInputElement).checked).toBe(true);
    expect(pa.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-conv-03');
    await switchTo(w, bId);
    key('Escape'); await flushPromises();
    expect(pb.get('[aria-current="true"]').attributes('data-test')).toBe('conversation-row-conv-02');
    expect((await a.listConversations()).conversations).toHaveLength(18);
    expect((await b.listConversations()).conversations).toHaveLength(18);
  });

  it('keeps duplicate DOM ids unique with the same conversation open in both accounts', async () => {
    const { w, pa, pb } = await setup();
    await pa.get('[data-test="conversation-row-conv-02"]').trigger('click'); await flushPromises();
    await switchTo(w, bId);
    await pb.get('[data-test="conversation-row-conv-02"]').trigger('click'); await flushPromises();
    expect(pa.find('[data-test="reader"]').exists()).toBe(true);
    expect(pb.find('[data-test="reader"]').exists()).toBe(true);
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('attachment chooser keeps unique ids and restores its own reader scroll per workspace (UX-12 merge)', async () => {
    const { w, pa, pb } = await setup();
    await pa.get('[data-test="conversation-row-conv-02"]').trigger('click'); await flushPromises();
    const scrollA = pa.get('[data-test="reader-scroll"]').element as HTMLElement;
    scrollA.scrollTop = 40;
    await pa.get('[data-test="files-links"]').trigger('click'); await flushPromises();
    await switchTo(w, bId);
    await pb.get('[data-test="conversation-row-conv-02"]').trigger('click'); await flushPromises();
    const scrollB = pb.get('[data-test="reader-scroll"]').element as HTMLElement;
    scrollB.scrollTop = 77;
    await pb.get('[data-test="files-links"]').trigger('click'); await flushPromises();
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
    expect(pa.get('.attachment-chooser').attributes('aria-labelledby')).not.toBe(pb.get('.attachment-chooser').attributes('aria-labelledby'));
    // Closing B's chooser must restore B's scroller, never A's (first in the DOM).
    scrollB.scrollTop = 0; scrollA.scrollTop = 0;
    await pb.get('.attachment-chooser header button').trigger('click'); await flushPromises();
    expect(scrollB.scrollTop).toBe(77);
    expect(scrollA.scrollTop).toBe(0);
  });

  it('search stays inside its own account workspace', async () => {
    const searchA = vi.fn<MailClient['searchMail']>();
    const { w, b, pa, pb } = await setup((inner) => {
      searchA.mockImplementation((request) => inner.searchMail(request));
      return { ...inner, searchMail: searchA };
    });
    const searchB = vi.spyOn(b, 'searchMail');
    await pa.get('[data-test="search-trigger"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="search-input"]').setValue('thread');
    await pa.get('form').trigger('submit'); await flushPromises();
    expect(searchA).toHaveBeenCalled();
    expect(searchB).not.toHaveBeenCalled();
    expect(pa.find('[data-test="search-coverage"]').exists()).toBe(true);
    await switchTo(w, bId);
    expect(pb.find('[data-test="search-input"]').exists()).toBe(false);
    expect(pb.find('[data-test="search-coverage"]').exists()).toBe(false);
    expect(w.get('#workspace-boundary').text()).toContain('no cross-account search');
  });

  it('late detail and action ACKs stay with their owning client and cannot steal focus', async () => {
    const detail = deferred<Conversation>();
    const action = deferred<OperationReceipt>();
    let real!: MailClient;
    const commands: string[] = [];
    const { w, a, b, pa, pb } = await setup((inner) => {
      real = inner;
      return { ...inner,
        getConversation: () => detail.promise,
        setArchived: async (command) => {
          commands.push(command.conversation.accountId);
          const receipt = await inner.setArchived(command);
          await action.promise;
          return receipt;
        },
      };
    });
    await pa.get('[data-test="conversation-row-conv-01"]').trigger('click'); await flushPromises();
    await switchTo(w, bId);
    const focusB = pb.get('[data-test="conversation-row-conv-04"]').element as HTMLElement;
    focusB.focus();
    detail.resolve(await real.getConversation({ accountId: aId, conversationId: 'conv-01' }));
    await flushPromises();
    expect(document.activeElement).toBe(focusB);
    expect(pb.find('[data-test="reader"]').exists()).toBe(false);
    await switchTo(w, aId);
    key('Escape'); await flushPromises();
    (pa.get('[data-test="conversation-row-conv-01"]').element as HTMLElement).focus(); key('e');
    await flushPromises();
    await switchTo(w, bId);
    focusB.focus();
    action.resolve({ operationId: 'only-a', acceptedAt: new Date().toISOString() });
    await flushPromises(); await flushMacrotasks();
    expect(commands).toEqual([aId]);
    expect(document.activeElement).toBe(focusB);
    expect((await b.listConversations()).conversations).toHaveLength(18);
    expect((await a.listConversations()).conversations).toHaveLength(17);
    expect(pb.get('[data-test="action-notice"]').text()).toBe('');
  });

  it('isolates delayed list failures and empty Done', async () => {
    const firstList = deferred<Awaited<ReturnType<MailClient['listConversations']>>>();
    let held = true;
    const { w, pa, pb } = await setup((inner) => ({ ...inner, listConversations: () => {
      if (held) { held = false; return firstList.promise; }
      return inner.listConversations();
    } }));
    await switchTo(w, bId);
    const bFocus = pb.get('[data-test="conversation-row-conv-05"]').element as HTMLElement;
    bFocus.focus();
    firstList.reject({ kind: 'storage_unavailable' }); await flushPromises();
    expect(document.activeElement).toBe(bFocus);
    expect(pb.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(pa.get('[data-test="inbox-error"]').text()).toContain('storage unavailable');
    await pb.get('[data-test="rail-done"]').trigger('click'); await flushPromises();
    expect(pb.get('[data-test="inbox-title"]').text()).toContain('Cached Done');
    expect(pb.findAll('[data-test^="conversation-row-"]')).toHaveLength(0);
  });

  it('retains independent command queries after dismiss/switch/return/reopen and palette switching', async () => {
    const { w, pa, pb } = await setup();
    await switchTo(w, bId);
    await pb.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    await pb.get('[data-test="action-query"]').setValue('cached');
    key('Escape'); await flushPromises();
    expect(pb.find('[data-test="action-query"]').exists()).toBe(false);
    await switchTo(w, aId);
    await pa.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect((pa.get('[data-test="action-query"]').element as HTMLInputElement).value).toBe('');
    await pa.get('[data-test="action-query"]').setValue('local Drafts');
    const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    key('Escape'); await flushPromises();
    await pa.get('[data-test="navigator-trigger"]').trigger('click'); await flushPromises();
    expect((pa.get('[data-test="action-query"]').element as HTMLInputElement).value).toBe('');
    await pa.get('[data-test="action-query"]').setValue('Inbox');
    key('Escape'); await flushPromises();
    await switchTo(w, bId);
    await pb.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    const retained = pb.get('[data-test="action-query"]').element as HTMLInputElement;
    expect(retained.value).toBe('cached');
    expect([retained.selectionStart, retained.selectionEnd]).toEqual([0, 'cached'.length]);
    await pb.get('[data-test="action-query"]').setValue('Switch account');
    key('Enter'); await flushPromises();
    expect(pa.attributes('style') ?? '').not.toContain('display: none');
    await pa.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect((pa.get('[data-test="action-query"]').element as HTMLInputElement).value).toBe('local Drafts');
    key('Escape'); await flushPromises();
    await switchTo(w, bId);
    await pb.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect((pb.get('[data-test="action-query"]').element as HTMLInputElement).value).toBe('Switch account');
  });

  it('flushes exact draft text before switching and blocks failed saves without hiding the editor', async () => {
    let fail = true;
    const save = vi.fn<MailClient['saveDraft']>();
    const { w, a, b, pa, pb } = await setup((inner) => {
      save.mockImplementation(async (command) => {
        // Chromium blurs a focused element once its ancestor is inert; jsdom does not, so simulate it.
        if (fail) { (document.activeElement as HTMLElement | null)?.blur(); throw { kind: 'storage_unavailable' }; }
        return inner.saveDraft(command);
      });
      return { ...inner, saveDraft: save };
    });
    await pa.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="new-draft"]').trigger('click'); await flushPromises();
    const text = '  exact λ\n<script>not executable</script>  ';
    (pa.get('[data-test="draft-body"]').element as HTMLElement).focus();
    await pa.get('[data-test="draft-body"]').setValue(text);
    await switchTo(w, bId);
    expect(w.get('[role="alert"]').text()).toContain('switch blocked');
    expect(pa.attributes('style') ?? '').not.toContain('display: none');
    expect(document.activeElement).toBe(pa.get('[data-test="draft-body"]').element);
    expect((pa.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe(text);
    expect((await b.listDrafts())).toEqual([]);
    fail = false;
    await pa.get('[data-test="draft-body"]').trigger('input');
    expect(w.find('[role="alert"]').exists()).toBe(false);
    await switchTo(w, bId);
    expect(pb.attributes('style') ?? '').not.toContain('display: none');
    const [draft] = await a.listDrafts();
    expect((await a.getDraft(draft!.ref)).content.bodyText).toBe(text);
    expect(save.mock.calls.every(([command]) => command.ref.accountId === aId)).toBe(true);
    expect(save.mock.calls[0]![0].requestId).toBe(save.mock.calls[1]![0].requestId);
    await switchTo(w, aId);
    await pa.get('[data-test="open-draft-draft-0001"]').trigger('click'); await flushPromises();
    expect((pa.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe(text);
  });

  it('blocks a stale-revision editor transition without silently rebasing or leaking the buffer', async () => {
    const { w, pa, pb, b } = await setup((inner) => ({ ...inner, saveDraft: async () => {
      throw { kind: 'draft_conflict', currentRevision: 2 };
    } }));
    await pa.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="new-draft"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="draft-body"]').setValue('keep my exact conflicting buffer');
    await switchTo(w, bId);
    expect(pb.attributes('style')).toContain('display: none');
    expect(pa.find('[data-test="draft-conflict-actions"]').exists()).toBe(true);
    expect((pa.get('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('keep my exact conflicting buffer');
    expect(await b.listDrafts()).toEqual([]);
  });

  it('serializes switches behind a pending save and cannot hide an unacknowledged buffer', async () => {
    const gate = deferred<void>();
    const { w, pa, pb } = await setup((inner) => ({ ...inner, saveDraft: async (command) => {
      await gate.promise; return inner.saveDraft(command);
    } }));
    await pa.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="new-draft"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="draft-body"]').setValue('pending');
    await switchTo(w, bId);
    expect(w.get(`[data-test="switch-${aId}"]`).attributes('disabled')).toBeDefined();
    expect(pa.find('[data-test="composer"]').exists()).toBe(true);
    expect(pb.attributes('style')).toContain('display: none');
    gate.resolve(); await flushPromises();
    expect(pb.attributes('style') ?? '').not.toContain('display: none');
  });

  it('offers an account switch palette command and account-aware loaded titles, not mailbox totals/search', async () => {
    const { w, pa, pb } = await setup();
    await pa.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    await pa.get('[data-test="action-query"]').setValue('Switch account');
    expect(pa.get('[role="option"]').text()).toContain(`${bId}@example.test`);
    key('Enter'); await flushPromises();
    expect(pb.attributes('style') ?? '').not.toContain('display: none');
    expect(document.title).toContain(`${bId}@example.test`);
    expect(document.title).toContain('18 loaded');
    expect(w.text()).toContain('not native tabs');
    for (const options of [{ key: 't', metaKey: true }, { key: '1', metaKey: true }, { key: 'Tab', metaKey: true }, { key: ']', metaKey: true, shiftKey: true }]) {
      expect(key(options.key, options).defaultPrevented).toBe(false);
    }
    // Standalone/native has no account-switch command despite the shared catalog.
    const single = mount(App, { props: { client: createBrowserFakeMailClient(), mode: 'native' } });
    await flushPromises();
    await single.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect(single.text()).not.toContain('Switch account');
    await single.get('[data-test="action-query"]').setValue('cached');
    await single.get('[data-test="action-query"]').trigger('keydown', { key: 'Escape' }); await flushPromises();
    await single.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect((single.get('[data-test="action-query"]').element as HTMLInputElement).value).toBe('');
    single.unmount();
  });
  it('shows a short boundary banner, keeps the full sentence as the nav description, and names the real switch route', async () => {
    const { w } = await setup();
    const banner = w.get('#workspace-boundary');
    const visible = banner.findAll('[aria-hidden="true"]').map((node) => node.text());
    expect(visible).toEqual(['Synthetic workspaces · memory only', 'Search stays in the active account.']);
    // The full existing sentence survives as visually hidden text for assistive technology.
    expect(banner.get('.visually-hidden').text()).toBe('Synthetic in-app workspaces · memory only · not native tabs · search stays inside the active account; no cross-account search');
    expect(w.get('nav[aria-label="Fixture accounts"]').attributes('aria-describedby')).toBe('workspace-boundary');

    // The inactive account's button says where else the switch lives; there is no shortcut, so none is invented.
    const other = w.get(`[data-test="switch-${bId}"]`);
    expect(other.attributes('title')).toBe('Switch account — also in Commands');
    expect(other.attributes('title')).not.toMatch(/[⌘⌃⌥]|Cmd|Ctrl|Alt|Shift/);
    expect(w.get(`[data-test="switch-${aId}"]`).attributes('aria-current')).toBe('true');
    expect(w.get(`[data-test="switch-${aId}"]`).attributes('title')).toBeUndefined();
    await switchTo(w, bId);
    expect(w.get(`[data-test="switch-${bId}"]`).attributes('aria-current')).toBe('true');
    expect(w.get(`[data-test="switch-${aId}"]`).attributes('title')).toBe('Switch account — also in Commands');
  });
});
