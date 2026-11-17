import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountApp, createBrowserFakeMailClient, flushFakeClientAndVueUpdates } from '../helpers';

interface AndroidBackWindow extends Window {
  __emailOsAndroidBack?: () => boolean;
  __TAURI_INTERNALS__?: object;
}

function stubCompactLayout(): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query === '(max-width: 719px)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }) as unknown as MediaQueryList);
}

async function mountAndroidApp() {
  stubCompactLayout();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android' });
  Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
  const fake = createBrowserFakeMailClient();
  const wrapper = mountApp(fake, 'native');
  await flushFakeClientAndVueUpdates(fake);
  const back = (window as AndroidBackWindow).__emailOsAndroidBack;
  expect(back).toBeTypeOf('function');
  return { fake, wrapper, back: back! };
}

async function openReader(wrapper: Awaited<ReturnType<typeof mountAndroidApp>>['wrapper'], fake: Awaited<ReturnType<typeof mountAndroidApp>>['fake']): Promise<void> {
  await wrapper.get('[data-test="conversation-row-conv-01"]').trigger('click');
  await flushFakeClientAndVueUpdates(fake);
}

afterEach(() => {
  delete (window as AndroidBackWindow).__emailOsAndroidBack;
  delete (window as AndroidBackWindow).__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe('compact Android Back', () => {
  it('closes Search when focus is on the body or a row', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await wrapper.get('[data-test="mobile-search"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    document.body.focus();
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="search-input"]').exists()).toBe(false);

    await wrapper.get('[data-test="mobile-search"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    document.body.focus();
    (wrapper.get('[data-test="conversation-row-conv-01"]').element as HTMLElement).focus();
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="search-input"]').exists()).toBe(false);
  });

  it('closes Search suggestions before closing its form', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await wrapper.get('[data-test="mobile-search"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    await wrapper.get('[data-test="search-input"]').setValue('ada');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="search-suggestion"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="search-input"]').exists()).toBe(true);
    expect(wrapper.get('[data-test="search-input"]').attributes('aria-expanded')).toBe('false');
  });

  it('clears selection mode', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await wrapper.get('[data-test="row-select-conv-01"]').setValue(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="selection-bar"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="selection-bar"]').exists()).toBe(false);
  });

  it('closes the navigation drawer', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await wrapper.get('[data-test="mobile-menu"]').trigger('click');
    expect(wrapper.find('[role="dialog"][aria-label="Destinations"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[role="dialog"][aria-label="Destinations"]').exists()).toBe(false);
  });

  it('closes a pushed Settings page', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await wrapper.get('[data-test="mobile-menu"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    const settings = wrapper.findAll('.mobile-drawer-row').find(row => row.text().trim() === 'Settings');
    expect(settings).toBeDefined();
    await settings!.trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="utility-drawer"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="utility-drawer"]').exists()).toBe(false);
  });

  it('closes Contact and leaves the reader open', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await openReader(wrapper, fake);
    await wrapper.get('[data-test="reader-more"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    const contact = wrapper.findAll('[data-test="action-sheet"] button').find(button => button.text().includes('Contact details'));
    expect(contact).toBeDefined();
    await contact!.trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('closes the reader', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await openReader(wrapper, fake);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(false);
  });

  it('closes the reader More sheet and leaves the reader open', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await openReader(wrapper, fake);
    await wrapper.get('[data-test="reader-more"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="action-sheet"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="action-sheet"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('closes the per-message sheet and leaves the reader open', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await openReader(wrapper, fake);
    await wrapper.get('[data-test="message-more"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="action-sheet"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="action-sheet"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('closes the Reminder picker and leaves the reader open', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await openReader(wrapper, fake);
    await wrapper.get('[data-test="reader-remind"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(document.querySelector('[data-reminder-picker]')).not.toBeNull();
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(document.querySelector('[data-reminder-picker]')).toBeNull();
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('closes Compose', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await wrapper.get('[data-test="mobile-compose"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="compose-card"]').exists()).toBe(false);
  });

  it('closes Reply', async () => {
    const { fake, wrapper, back } = await mountAndroidApp();
    await openReader(wrapper, fake);
    await wrapper.get('[data-test="mobile-reply-bar"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="reply-composer"]').exists()).toBe(true);
    expect(back()).toBe(true);
    await flushFakeClientAndVueUpdates(fake);
    expect(wrapper.find('[data-test="reply-composer"]').exists()).toBe(false);
    expect(wrapper.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('returns false at the Inbox root', async () => {
    const { wrapper, back } = await mountAndroidApp();
    expect(wrapper.find('[data-test="mobile-drawer"]').exists()).toBe(false);
    expect(back()).toBe(false);
  });
});
