import { expect, it } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import ReaderView from '../../src/components/ReaderView.vue';
import { createBrowserFakeMailClient, flushFakeClientAndVueUpdates, mountApp } from '../helpers';

it('closes a message link on Escape and composes to a mailto address', async () => {
  const fake = createBrowserFakeMailClient();
  const w = mountApp(fake, 'browser-preview', { attachTo: document.body });
  try {
    await flushFakeClientAndVueUpdates(fake);
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    w.findComponent(ReaderView).vm.$emit('openLink', 'https://example.test', 'example.test');
    await flushPromises();
    expect(w.find('[aria-label="Open link"]').exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await flushPromises();
    expect(w.find('[aria-label="Open link"]').exists()).toBe(false);
    w.findComponent(ReaderView).vm.$emit('openLink', 'mailto:a@b.test?subject=Ignored', 'a@b.test');
    await flushPromises();
    await w.findAll('button').find((button) => button.text() === 'New message to a@b.test')!.trigger('click');
    await flushFakeClientAndVueUpdates(fake);
    expect((w.find('[data-test="draft-to"]').element as HTMLInputElement).value).toBe('a@b.test');
  } finally {
    w.unmount();
  }
});

it('closes the link dialog after a native hand-off and keeps it in the preview', async () => {
  for (const mode of ['native', 'browser-preview'] as const) {
    const fake = createBrowserFakeMailClient();
    const w = mountApp(fake, mode, { attachTo: document.body });
    try {
      await flushFakeClientAndVueUpdates(fake);
      await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
      await flushFakeClientAndVueUpdates(fake);
      w.findComponent(ReaderView).vm.$emit('openLink', 'https://example.test/a', 'example.test');
      await flushPromises();
      await w.findAll('button').find((button) => button.text() === 'Open in browser')!.trigger('click');
      await flushPromises();
      await flushPromises();
      expect(w.find('[aria-label="Open link"]').exists()).toBe(mode === 'browser-preview');
    } finally {
      w.unmount();
    }
  }
});
