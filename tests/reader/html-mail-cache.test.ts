// @vitest-environment jsdom
import { flushPromises, mount } from '@vue/test-utils';
import { beforeEach, expect, it, vi } from 'vitest';
import { effectScope } from 'vue';
import { useMailbox } from '../../src/composables/useMailbox';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import { flushMacrotasks, useGmailMode } from '../helpers';
import HtmlMessageFrame from '../../src/components/HtmlMessageFrame.vue';
import { cachedMail, cacheMail, clearMailCache, mailCacheEpoch } from '../../src/lib/html-mail/mail-cache';
import { sanitizeMailHtml } from '../../src/lib/html-mail/sanitize';
import type { MailClient } from '../../src/lib/ipc/client';

const theme = { fontFamily: 'sans-serif', fontSize: '15px', lineHeight: '24px', textColour: '#fff', linkColour: '#fff' };
const entry = (text: string) => ({
  body: { html: text, inlineImages: [] },
  mail: sanitizeMailHtml(text, { remoteImages: false }),
});

beforeEach(() => clearMailCache());

it('keeps the 20 most recently used messages', () => {
  for (let i = 0; i < 20; i += 1) cacheMail(String(i), entry('x'), mailCacheEpoch());
  cachedMail('0');
  cacheMail('20', entry('x'), mailCacheEpoch());
  expect(cachedMail('0')).toBeDefined();
  expect(cachedMail('1')).toBeUndefined();
});

it('keeps nothing after a clear, including reads already in flight', async () => {
  let finish: (body: unknown) => void = () => {};
  const getMessageHtml = vi.fn(() => new Promise(resolve => { finish = resolve; }));
  const props = {
    client: { getMessageHtml } as unknown as MailClient,
    conversation: { accountId: 'a', conversationId: 'c' },
    messageId: 'm',
    title: 'Message',
    remoteImages: false,
    quoteOpen: false,
    theme,
  };
  const first = mount(HtmlMessageFrame, { props });
  first.unmount();
  clearMailCache();
  finish({ html: '<p>old account</p>', inlineImages: [] });
  await flushPromises();

  const second = mount(HtmlMessageFrame, { props });
  await flushPromises();
  expect(getMessageHtml).toHaveBeenCalledTimes(2);
  expect(second.find('iframe').exists()).toBe(false);
  second.unmount();
});

it('is cleared when the account changes, disconnects or its mailbox closes', async () => {
  const fake = createBrowserFakeMailClient();
  useGmailMode(fake);
  const scope = effectScope();
  const mailbox = scope.run(() => useMailbox(fake))!;
  await mailbox.ready;
  const keep = (key: string) => cacheMail(key, entry('x'), mailCacheEpoch());

  keep('old identity');
  const status = await fake.getAccountStatus();
  const spy = vi.spyOn(fake, 'getAccountStatus').mockResolvedValue({
    ...status, account: { ...status.account!, accountId: 'another-account' },
  });
  await mailbox.refresh();
  await flushMacrotasks(2);
  expect(cachedMail('old identity')).toBeUndefined();
  spy.mockRestore();
  await mailbox.refresh();
  await flushMacrotasks(2);

  keep('disconnected');
  await mailbox.disconnectAccount();
  expect(cachedMail('disconnected')).toBeUndefined();

  keep('closed');
  scope.stop();
  expect(cachedMail('closed')).toBeUndefined();
});
