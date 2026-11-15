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
});
