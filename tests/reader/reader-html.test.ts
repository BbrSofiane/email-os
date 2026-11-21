import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import HtmlMessageFrame from '../../src/components/HtmlMessageFrame.vue';
import type { Conversation, MailClient } from '../../src/lib/ipc/client';
import { mountReaderView } from '../support/reader.mount';

const client = { getMessageHtml: vi.fn().mockResolvedValue({ html: '<p>Formatted</p>', inlineImages: [] }) } as unknown as MailClient;
function conversation(id: string, htmlBody?: 'available' | 'too_large'): Conversation {
  return {
    ref: { accountId: 'account', conversationId: id },
    subject: 'Subject', isInInbox: true, pendingOperationId: null,
    messages: [{ id: 'message', from: { displayName: 'Ada', mailbox: 'ada@example.test' }, to: [], sentAt: '2026-01-01T00:00:00Z', bodyText: 'Plain', htmlBody }],
  };
}
afterEach(() => { document.body.innerHTML = ''; });

describe.each([false, true])('HTML reader compact=%s', (compact) => {
  it('renders formats and forwards frame events', async () => {
    const first = conversation(`first-${compact}`, 'available');
    const w = mountReaderView(first, { client, compact });
    await flushPromises();
    expect(w.find('iframe[data-test="message-html"]').exists()).toBe(true);
    expect(w.find('[data-test="message-body"]').exists()).toBe(false);
    await w.get('[data-test="message-format-toggle-message"]').trigger('click');
    expect(w.get('[data-test="message-body"]').text()).toBe('Plain');
    await w.get('[data-test="message-format-toggle-message"]').trigger('click');
    await flushPromises();
    let frame = w.findComponent(HtmlMessageFrame);
    frame.vm.$emit('state', { remoteBlocked: 2, hasTrailingQuote: true });
    await w.vm.$nextTick();
    await w.get('[data-test="load-images"]').trigger('click');
    expect(frame.props('remoteImages')).toBe(true);
    expect(w.find('[data-test="remote-images-bar"]').exists()).toBe(false);
    await w.get('[data-test="message-quote-toggle-message"]').trigger('click');
    expect(frame.props('quoteOpen')).toBe(true);
    frame.vm.$emit('link', 'https://example.test', 'Example');
    expect(w.emitted('openLink')).toEqual([['https://example.test', 'Example']]);
    const second = conversation(`second-${compact}`, 'available');
    await w.setProps({ conversation: second, openRef: second.ref });
    await w.setProps({ conversation: first, openRef: first.ref });
    await flushPromises();
    frame = w.findComponent(HtmlMessageFrame);
    expect(frame.props('remoteImages')).toBe(false);
    frame.vm.$emit('fallback', 'unavailable');
    await w.vm.$nextTick();
    expect(w.get('[data-test="html-fallback"]').text()).toBe('Formatted view unavailable on this device.');
    expect(w.get('[data-test="message-body"]').text()).toBe('Plain');
    w.unmount();
  });
  it.each([undefined, 'too_large'] as const)('renders plain body for %s', async (htmlBody) => {
    const w = mountReaderView(conversation(`plain-${compact}-${htmlBody}`, htmlBody), { client, compact });
    await flushPromises();
    expect(w.get('[data-test="message-body"]').text()).toBe('Plain');
    expect(w.find('[data-test="html-too-large"]').exists()).toBe(htmlBody === 'too_large');
    w.unmount();
  });
  it('renders retained snapshots as plain text', async () => {
    const w = mountReaderView({ ...conversation(`retained-${compact}`, 'available'), retainedSnapshotAt: '2026-01-01T00:00:00Z' }, { client, compact });
    await flushPromises();
    expect(w.get('[data-test="message-body"]').text()).toBe('Plain');
    w.unmount();
  });
});
