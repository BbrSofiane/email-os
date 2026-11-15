import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, createBrowserFakeMailClient, flushFakeClientAndVueUpdates, useGmailMode } from '../helpers';
import { allMobileCss } from '../support/css-contract';

function stubLayout(compact: boolean): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: compact && query === '(max-width: 719px)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('App compact and regular frame', () => {
  it('teleports split tabs only in compact mode and keeps saved navigation active', async () => {
    const fake = createBrowserFakeMailClient();
    const first = (await fake.listConversations()).conversations[0]!;
    await fake.saveSavedSplit(first.ref.accountId, {
      name: 'Clients',
      criterion: 'sender',
      value: first.primaryCorrespondent!.mailbox,
      enabled: true,
      hideWhenEmpty: false,
    });

    stubLayout(true);
    const compact = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.get('[data-test="split-inbox"]').element.closest('.mobile-context-slot')).toBeTruthy();
    await compact.get('[data-test="split-saved"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.get('[data-test="inbox-title"]').text()).toBe('Clients');
    compact.unmount();

    stubLayout(false);
    const regular = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    expect(regular.get('[data-test="split-inbox"]').element.closest('.app-header')).toBeTruthy();
    expect(regular.get('[data-test="split-inbox"]').element.closest('.mobile-context-slot')).toBeFalsy();
    regular.unmount();
  });

  it('opens the compact drawer, closes it before the next Escape rung, and navigates', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    await wrapper.get('[data-test="mobile-menu"]').trigger('click');
    expect(wrapper.find('[role="dialog"][aria-label="Destinations"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="action-overlay"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="mobile-menu"]').attributes('aria-expanded')).toBe('true');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[role="dialog"][aria-label="Destinations"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="mobile-menu"]').attributes('aria-expanded')).toBe('false');

    await wrapper.get('[data-test="mobile-menu"]').trigger('click');
    const draftsRow = wrapper.findAll('.mobile-drawer-row').find((row) => row.text() === 'Drafts');
    expect(draftsRow).toBeDefined();
    await draftsRow!.trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="drafts-pane"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('keeps the regular menu button on the navigator overlay', async () => {
    stubLayout(false);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    await wrapper.get('[data-test="navigator-trigger"]').trigger('click');
    expect(wrapper.find('[data-test="action-query"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="mobile-drawer"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('keeps the status strip and moves reader teleports into mobile hosts', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'read_only' });
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    expect(wrapper.find('[data-test="mobile-top-bar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="mobile-bottom-region"]').exists()).toBe(true);
    expect(wrapper.get('.app').attributes('data-layout')).toBe('compact');
    expect(allMobileCss).toContain('.app[data-layout=\"compact\"] .app-main > .rail');
    expect(wrapper.find('[data-test="preview-banner"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);

    await wrapper.get('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.get('[data-test="reader-close"]').element.closest('[data-test="mobile-top-bar"]')).toBeTruthy();
    expect(wrapper.get('[data-test="reader-toolbar"]').element.closest('[data-test="mobile-reader-actions"]')).toBeTruthy();
    wrapper.unmount();
  });

  it('keeps the regular frame and reader toolbar in the desktop header', async () => {
    stubLayout(false);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    expect(wrapper.get('.app').attributes('data-layout')).toBe('regular');
    expect(wrapper.find('[data-test="mobile-top-bar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="mobile-bottom-region"]').exists()).toBe(false);
    expect(wrapper.find('.rail').exists()).toBe(true);
    await wrapper.get('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.get('[data-test="reader-toolbar"]').element.closest('.app-header')).toBeTruthy();
    wrapper.unmount();
  });

  it('opens compact compose as a local editor with status, footer, and protected Escape close', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    await wrapper.get('[data-test="mobile-compose"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="mobile-top-bar"]').attributes('inert')).toBeDefined();
    expect(wrapper.get('.app-main').attributes('inert')).toBeDefined();
    expect(wrapper.get('[data-test="mobile-bottom-region"]').attributes('inert')).toBeDefined();
    expect(wrapper.get('[data-test="draft-status"]').text()).toContain('not sent');
    expect(wrapper.find('[data-test="close-composer"]').text()).toContain('Save and close');
    expect(wrapper.find('[data-test="discard-draft"]').exists()).toBe(true);
    await wrapper.get('.app').trigger('keydown', { key: 'Escape' });
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="mobile-top-bar"]').attributes('inert')).toBeUndefined();
    expect(wrapper.get('.app-main').attributes('inert')).toBeUndefined();
    expect(wrapper.get('[data-test="mobile-bottom-region"]').attributes('inert')).toBeUndefined();
    wrapper.unmount();
  });

  it('makes app surfaces inert for compact replies and leaves regular compose unchanged', async () => {
    const fake = createBrowserFakeMailClient();
    stubLayout(true);
    const compact = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    await compact.get('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    await compact.get('[data-test="mobile-reply-bar"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.find('[data-test="reply-composer"]').exists()).toBe(true);
    expect(compact.get('[data-test="mobile-top-bar"]').attributes('inert')).toBeDefined();
    expect(compact.get('.app-main').attributes('inert')).toBeDefined();
    expect(compact.get('[data-test="mobile-bottom-region"]').attributes('inert')).toBeDefined();
    await compact.get('[data-test="close-composer"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.find('[data-test="reply-composer"]').exists()).toBe(false);
    expect(compact.get('[data-test="mobile-top-bar"]').attributes('inert')).toBeUndefined();
    expect(compact.get('.app-main').attributes('inert')).toBeUndefined();
    expect(compact.get('[data-test="mobile-bottom-region"]').attributes('inert')).toBeUndefined();
    compact.unmount();

    stubLayout(false);
    const regularFake = createBrowserFakeMailClient();
    const regular = mountApp(regularFake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(regularFake);
    await regular.get('[data-test="compose-trigger"]').trigger('click');
    await flushFakeClientAndVueUpdates(regularFake);
    expect(regular.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(regular.get('.app-main').attributes('inert')).toBeUndefined();
    regular.unmount();
  });
});
