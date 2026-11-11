import { flushFakeClientWithMacrotasks } from './support/ui-settle';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { createBrowserFakeMailClient, type BrowserFake } from '../src/lib/ipc/browser-fake';
import { countingClient, useGmailMode, mountApp, press, createKeyEvent } from './helpers';

function button(wrapper: VueWrapper, text: string) {
  const result = wrapper.findAll('button').find((b) => b.text() === text);
  if (!result) throw new Error('Missing button: ' + text);
  return result;
}

describe('App: provider destinations drawer (native keyboard + account gate)', () => {
  let fake: BrowserFake;
  let counted: ReturnType<typeof countingClient>;
  let wrapper: VueWrapper | null = null;

  function mountNative(patch: Parameters<typeof useGmailMode>[1] = {}): VueWrapper {
    useGmailMode(fake, patch);
    const w = mountApp(counted.client, 'native', { attachTo: document.body });
    wrapper = w;
    return w;
  }

  beforeEach(() => {
    fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    counted = countingClient(fake);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('keeps native Cmd+K reachable from the covered drawer and fences ordinary mailbox shortcuts', async () => {
    const w = mountNative();
    await flushFakeClientWithMacrotasks(fake, 2);
    const archive = vi.spyOn(counted.client, 'setArchived');
    const read = vi.spyOn(counted.client, 'setRead');
    await w.get('[data-test="rail-destinations"]').trigger('click');
    await flushPromises();

    // Catalog search control: the native palette binding passes the drawer fence.
    const search = w.get('input');
    (search.element as HTMLElement).focus();
    const seen: string[] = [];
    const observer = (event: KeyboardEvent): void => { seen.push(event.key); };
    window.addEventListener('keydown', observer);
    press('k', { bubbles: true, cancelable: true, metaKey: true }); await flushPromises();
    expect(seen).toContain('k');
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    expect(document.activeElement).toBe(w.get('[data-test="action-query"]').element);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);

    // Destination row control: the binding still reaches App above the covered inbox.
    await button(w, 'Sent').trigger('click'); await flushPromises();
    const row = w.get('.destination-row');
    (row.element as HTMLElement).focus();
    press('k', { bubbles: true, cancelable: true, metaKey: true }); await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(true);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('[role="dialog"]').exists()).toBe(false);

    // Reader control: reader Escape returns to the list BEFORE the drawer closes.
    await row.trigger('click'); await flushPromises();
    expect(w.find('.destination-reader').exists()).toBe(true);
    (w.get('[data-test="destination-back"]').element as HTMLElement).focus();
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('.destination-reader').exists()).toBe(false);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
    press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);

    // Ordinary shortcuts (read/e, undo, list navigation) from a non-editable
    // drawer control never reach the window: no writes, no covered-inbox motion.
    await w.get('[data-test="rail-destinations"]').trigger('click'); await flushPromises();
    (button(w, 'Refresh catalog').element as HTMLElement).focus();
    seen.length = 0;
    press('e', { bubbles: true, cancelable: true }); await flushPromises();
    press('z', { bubbles: true, cancelable: true }); await flushPromises();
    press('j', { bubbles: true, cancelable: true }); await flushPromises();
    expect(seen).toEqual([]);
    expect(archive).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    window.removeEventListener('keydown', observer);
  });

  it.each([
    ['IME composition', { isComposing: true }],
    ['legacy IME key code', { keyCode: 229 }],
    ['Control', { ctrlKey: true }],
    ['Command', { metaKey: true }],
    ['Alt', { altKey: true }],
  ] satisfies [string, KeyboardEventInit][])(
    'leaves %s Escape untouched in the destination reader', async (_label, options) => {
      const w = mountNative();
      await flushFakeClientWithMacrotasks(fake, 2);
      await w.get('[data-test="rail-destinations"]').trigger('click'); await flushPromises();
      await button(w, 'Sent').trigger('click'); await flushPromises();
      await w.get('.destination-row').trigger('click'); await flushPromises();
      const back = w.get('[data-test="destination-back"]').element as HTMLElement;
      back.focus();

      const event = createKeyEvent('Escape', { bubbles: true, cancelable: true, ...options });
      back.dispatchEvent(event);
      await flushPromises();

      expect(event.defaultPrevented).toBe(false);
      expect(w.find('.destination-reader').exists()).toBe(true);
      expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
      expect(document.activeElement).toBe(back);

      // Unmodified Escape still owns reader Back, then closes the drawer.
      press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
      expect(w.find('.destination-reader').exists()).toBe(false);
      expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
      press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
      expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    },
  );

  it('gates the provider drawer behind a connected account, including mid-session disconnect', async () => {
    const w = mountNative({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
    await flushFakeClientWithMacrotasks(fake, 2);
    const list = vi.spyOn(counted.client, 'listProviderDestinations');
    expect(w.find('[data-test="rail-destinations"]').exists()).toBe(true);
    await w.get('[data-test="rail-destinations"]').trigger('click'); await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
    expect(w.find('[data-test="destinations-account-required"]').exists()).toBe(true);
    expect(w.find('.provider-destinations').exists()).toBe(false);
    expect(list).not.toHaveBeenCalled();

    // Connect, open the loaded surface, then let the account disappear under it.
    fake.controls.setAccount({ connection: 'connected', emailAddress: 'operator@example.test', cachedConversations: 18, initialSyncComplete: true });
    await flushFakeClientWithMacrotasks(fake, 2);
    expect(w.find('.provider-destinations').exists()).toBe(true);
    fake.controls.setAccount({ connection: 'disconnected', emailAddress: null, cachedConversations: 0 });
    await flushFakeClientWithMacrotasks(fake, 2);
    expect(w.find('.provider-destinations').exists()).toBe(false);
    expect(w.find('[data-test="destinations-account-required"]').exists()).toBe(true);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
  });
});
