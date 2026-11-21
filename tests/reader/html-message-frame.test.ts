import { flushPromises, mount } from '@vue/test-utils';
import { expect, it, vi } from 'vitest';
import HtmlMessageFrame from '../../src/components/HtmlMessageFrame.vue';
import type { MailClient } from '../../src/lib/ipc/client';

const theme = { fontFamily: 'sans-serif', fontSize: '15px', lineHeight: '24px', textColour: '#fff', linkColour: '#fff' };
const conversation = { accountId: 'test', conversationId: 'frame-test' };

it('renders a sandboxed sanitized document', async () => {
  const client = { getMessageHtml: vi.fn().mockResolvedValue({ html: '<script>bad()</script><a href="https://example.test">Link</a>', inlineImages: [] }) } as unknown as MailClient;
  const wrapper = mount(HtmlMessageFrame, { props: { client, conversation, messageId: 'one', title: 'Message from Ana', remoteImages: false, quoteOpen: false, theme } });
  await flushPromises();
  const iframe = wrapper.get('iframe');
  expect(iframe.attributes('sandbox')).toBe('allow-same-origin');
  expect(iframe.attributes('referrerpolicy')).toBe('no-referrer');
  expect(iframe.attributes('title')).toBe('Message from Ana');
  const doc = iframe.attributes('srcdoc') ?? '';
  expect(doc.startsWith('<!doctype html>')).toBe(true);
  expect(doc).toContain('Content-Security-Policy');
  expect(doc).not.toMatch(/\shref=/);
  expect(doc).not.toContain('<script');
  wrapper.unmount();
});

it('reports fetch failures', async () => {
  const client = { getMessageHtml: vi.fn().mockRejectedValue(new Error('failed')) } as unknown as MailClient;
  const wrapper = mount(HtmlMessageFrame, { props: { client, conversation, messageId: 'error', title: 'Message', remoteImages: false, quoteOpen: false, theme } });
  await flushPromises();
  expect(wrapper.emitted('fallback')).toEqual([['error']]);
  wrapper.unmount();
});
