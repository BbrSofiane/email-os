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
  it('marks an open Search form as the current page and restores Inbox on Escape', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    await wrapper.get('[data-test="mobile-search"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.get('[data-test="mobile-context-slot"]').element.childElementCount).toBe(0);
    expect(wrapper.get('[data-test="mobile-search"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('[data-test="mobile-mail"]').attributes('aria-current')).toBeUndefined();
    expect(wrapper.get('[data-test="mobile-top-bar"]').text()).toContain('Search');

    await wrapper.get('[data-test="search-input"]').trigger('keydown', { key: 'Escape' });
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="search-input"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="mobile-search"]').attributes('aria-current')).toBeUndefined();
    expect(wrapper.get('[data-test="mobile-mail"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('[data-test="split-inbox"]').element.closest('.mobile-context-slot')).toBeTruthy();
    wrapper.unmount();
  });

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

  it('replaces the compact split pill with the selection bar but keeps regular split navigation', async () => {
    const fake = createBrowserFakeMailClient();

    stubLayout(true);
    const compact = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.get('[data-test="split-inbox"]').element.closest('.mobile-context-slot')).toBeTruthy();
    await compact.get('[data-test="row-select-conv-01"]').setValue(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.find('[data-test="selection-bar"]').exists()).toBe(true);
    expect(compact.get('[data-test="mobile-context-slot"]').element.childElementCount).toBe(0);
    await compact.get('[data-test="selection-clear"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(compact.get('[data-test="split-inbox"]').element.closest('.mobile-context-slot')).toBeTruthy();
    compact.unmount();

    stubLayout(false);
    const regular = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    await regular.get('[data-test="row-select-conv-01"]').setValue(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(regular.find('[data-test="selection-bar"]').exists()).toBe(true);
    expect(regular.get('[data-test="split-inbox"]').element.closest('.app-header')).toBeTruthy();
    regular.unmount();
  });

  it('enters empty selection, selects by tapping a row, and exits with Clear', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    await wrapper.get('[data-test="mobile-select"]').trigger('click');
    expect(wrapper.find('[data-test="mobile-select"]').exists()).toBe(false);
    expect(wrapper.get('.inbox-list').classes()).toContain('selecting');
    expect(wrapper.get('[data-test="row-select-conv-01"]').element).toHaveProperty('checked', false);
    expect(wrapper.find('[data-test="selection-bar"]').exists()).toBe(true);
    expect(wrapper.find('[data-test="split-inbox"]').exists()).toBe(false);

    await wrapper.get('[data-test="conversation-row-conv-01"]').trigger('click');
    expect(wrapper.get('[data-test="row-select-conv-01"]').element).toHaveProperty('checked', true);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(false);
    await wrapper.get('[data-test="selection-clear"]').trigger('click');
    expect(wrapper.find('[data-test="selection-bar"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="split-inbox"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('marks Search current without Inbox tabs in the context slot, then restores Inbox', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    await wrapper.get('[data-test="mobile-search"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    await wrapper.get('[data-test="search-input"]').setValue('from:ada');
    await wrapper.get('[data-test="search-submit"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.get('[data-test="mobile-context-slot"]').element.childElementCount).toBe(0);
    expect(wrapper.get('[data-test="mobile-search"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('[data-test="mobile-mail"]').attributes('aria-current')).toBeUndefined();

    await wrapper.get('[data-test="mobile-mail"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.get('[data-test="split-inbox"]').element.closest('.mobile-context-slot')).toBeTruthy();
    expect(wrapper.get('[data-test="mobile-mail"]').attributes('aria-current')).toBe('page');
    expect(wrapper.get('[data-test="mobile-search"]').attributes('aria-current')).toBeUndefined();
    wrapper.unmount();
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
    expect(wrapper.find('[data-test="mobile-select"]').exists()).toBe(false);
    wrapper.unmount();
  });

  it('opens Contact details from the reader More sheet and returns to the reader', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);
    await wrapper.get('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="mobile-select"]').exists()).toBe(false);
    await wrapper.get('[data-test="reader-more"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    const contactAction = wrapper.findAll('[data-test="action-sheet"] button').find(button => button.text().includes('Contact details'));
    expect(contactAction).toBeDefined();
    const commandsAction = wrapper.findAll('[data-test="action-sheet"] button').find(button => button.text().includes('Commands'));
    expect(contactAction?.find('svg').attributes('data-glyph')).toBe('contact');
    expect(commandsAction?.find('svg').attributes('data-glyph')).toBe('prompt');
    await contactAction!.trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.get('[data-test="contact-disclosure-panel"]').text()).toContain('Ada Fixture');
    const contactHeader = wrapper.get('[data-test="contact-disclosure-panel"] .drawer-header').element;
    expect(contactHeader.firstElementChild).toBe(wrapper.get('[data-test="contact-disclosure-close"]').element);
    expect(wrapper.get('[data-test="contact-disclosure-close"]').attributes('aria-label')).toBe('Back');
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
    await wrapper.get('[data-test="contact-disclosure-close"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
    wrapper.unmount();
  });

  it('uses Back first in compact Settings and Activity headers and returns to the list', async () => {
    stubLayout(true);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    for (const pageName of ['Settings', 'Activity']) {
      await wrapper.get('[data-test="mobile-menu"]').trigger('click');
      await flushFakeClientAndVueUpdates(fake);
      const pageRow = wrapper.findAll('.mobile-drawer-row').find(row => row.text().trim() === pageName);
      expect(pageRow).toBeDefined();
      await pageRow!.trigger('click');
      await flushFakeClientAndVueUpdates(fake);

      const page = wrapper.get('[data-test="utility-drawer"]');
      const back = page.get('[data-test="drawer-close"]');
      expect(page.get('.drawer-header').element.firstElementChild).toBe(back.element);
      expect(back.attributes('aria-label')).toBe('Back');
      expect(back.find('svg').attributes('data-glyph')).toBe('back');
      await back.trigger('click');
      await flushFakeClientAndVueUpdates(fake);
      expect(wrapper.find('[data-test="utility-drawer"]').exists()).toBe(false);
    }

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

  it('keeps regular pushed-page Close text buttons and header order', async () => {
    stubLayout(false);
    const fake = createBrowserFakeMailClient();
    const wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
    await flushFakeClientAndVueUpdates(fake);

    await wrapper.get('[data-test="rail-activity"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    const activityHeader = wrapper.get('[data-test="utility-drawer"] .drawer-header');
    expect(activityHeader.element.firstElementChild).toBe(activityHeader.get('h2').element);
    expect(activityHeader.get('[data-test="drawer-close"]').text()).toBe('Close');

    await wrapper.get('[data-test="drawer-close"]').trigger('click');
    await wrapper.get('[data-test="contact-disclosure"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    const contactHeader = wrapper.get('[data-test="contact-disclosure-panel"] .drawer-header');
    expect(contactHeader.element.firstElementChild).toBe(contactHeader.get('h2').element);
    expect(contactHeader.get('[data-test="contact-disclosure-close"]').text()).toBe('Close');
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

  it('opens compact compose as a local editor with status and a protected header close', async () => {
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
    expect(wrapper.get('[data-test="draft-status"]').text()).toContain('never sent');
    expect(wrapper.find('[data-test="close-composer"]').exists()).toBe(false);
    expect(wrapper.get('[data-test="compose-sheet-close"]').attributes('aria-label')).toBe('Save and close');
    expect(wrapper.get('[data-test="compose-sheet-close"]').attributes('title')).toBe('Save and close');
    expect(wrapper.get('[data-test="compose-sheet-close"]').attributes('aria-keyshortcuts')).toBe('Escape');
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
    expect(compact.find('[data-test="close-composer"]').exists()).toBe(false);
    expect(compact.get('[data-test="reply-sheet-close"]').attributes('title')).toBe('Save and close');
    expect(compact.get('[data-test="reply-sheet-close"]').attributes('aria-keyshortcuts')).toBe('Escape');
    await compact.get('[data-test="reply-sheet-close"]').trigger('click');
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
