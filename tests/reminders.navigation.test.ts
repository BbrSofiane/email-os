import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import ReaderView from '../src/components/ReaderView.vue';
import RemindersPanel from '../src/components/RemindersPanel.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { Conversation, Reminder } from '../src/lib/ipc/client';
import { deferred } from './helpers';

let app: VueWrapper | undefined;

afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

async function fixture() {
  const client = createBrowserFakeMailClient();
  const snapshot = await client.listConversations();
  const [reminded, entry, neighbor] = snapshot.conversations.map(row => row.ref);
  if (!reminded || !entry || !neighbor) throw new Error('Expected three synthetic Inbox conversations');
  const detail = await client.getConversation(reminded);
  const reminder: Reminder = {
    conversation: reminded,
    subject: detail.subject,
    sourceMessageId: detail.messages.at(-1)!.id,
    revision: 1,
    dueAt: '2030-01-01T00:00:00Z',
    condition: 'regardless',
    phase: 'returned',
  };
  // Synthetic read-only transport: these tests never schedule or mutate mail.
  client.reminders = {
    list: vi.fn(async () => [reminder]),
    put: vi.fn(async () => { throw new Error('Unexpected reminder write'); }),
    cancel: vi.fn(async () => { throw new Error('Unexpected reminder cancellation'); }),
  };
  const pending = deferred<Conversation>();
  const getConversation = vi.spyOn(client, 'getConversation').mockImplementationOnce(() => pending.promise);
  const setRead = vi.spyOn(client, 'setRead');
  app = mount(App, { props: { client, mode: 'native' }, attachTo: document.body });
  await flushPromises();
  return { reminded, entry, neighbor, detail, pending, getConversation, setRead };
}

async function key(key: string) {
  window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  await flushPromises();
}

async function openReturnedReminder() {
  await app!.findAll('button').find(button => button.text() === 'Reminders')!.trigger('click');
  await flushPromises();
  const panel = app!.getComponent(RemindersPanel);
  await panel.findAll('nav button').find(button => button.text() === 'returned')!.trigger('click');
  await panel.get('li button').trigger('click');
  await flushPromises();
  expect(app!.findComponent(RemindersPanel).exists()).toBe(false);
  expect(app!.find('[data-test="reader-loading"]').exists()).toBe(true);
}

describe('reminder reader navigation ownership', () => {
  it('returns to the saved Reminders destination when Escape interrupts a deferred detail load', async () => {
    const { reminded, detail, pending, getConversation, setRead } = await fixture();
    try {
      await openReturnedReminder();
      expect(getConversation).toHaveBeenCalledExactlyOnceWith(reminded);
      await key('j');
      await key('k');
      expect(getConversation).toHaveBeenCalledTimes(1);

      // The transport is still pending: Back must already know its real origin.
      await key('Escape');
      expect(app!.findComponent(ReaderView).exists()).toBe(false);
      expect(app!.findComponent(RemindersPanel).exists()).toBe(true);
      const panel = app!.getComponent(RemindersPanel);
      expect(panel.findAll('nav button').find(button => button.text() === 'returned')!.attributes('aria-pressed')).toBe('true');
      expect(panel.get('li button').text()).toBe(`Open ${detail.subject}`);
      expect(app!.get('[data-test="rail-activity"]').attributes('aria-expanded')).toBe('false');

      pending.resolve(detail);
      await flushPromises();
      expect(app!.findComponent(ReaderView).exists()).toBe(false);
      expect(app!.findComponent(RemindersPanel).exists()).toBe(true);
      expect(getConversation).toHaveBeenCalledTimes(1);
      expect(setRead).not.toHaveBeenCalled();
    } finally {
      pending.resolve(detail);
      await flushPromises();
    }
  });

  it('does not let a late reminder completion overwrite a newer Inbox reader origin or J/K', async () => {
    const { entry, neighbor, detail, pending, getConversation, setRead } = await fixture();
    try {
      await openReturnedReminder();
      // Explicit Inbox navigation closes the loading reader without returning
      // to its utility destination. A new list entry owns the next reader.
      await app!.get('[data-test="rail-inbox"]').trigger('click');
      await flushPromises();
      await app!.get(`[data-test="conversation-row-${entry.conversationId}"]`).trigger('click');
      await flushPromises();
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(entry);
      expect(getConversation).toHaveBeenCalledTimes(2);

      pending.resolve(detail);
      await flushPromises();
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(entry);
      expect(app!.findComponent(RemindersPanel).exists()).toBe(false);
      await key('j');
      expect(getConversation).toHaveBeenCalledTimes(3);
      expect(getConversation).toHaveBeenLastCalledWith(neighbor);
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(neighbor);
      await key('k');
      expect(getConversation).toHaveBeenCalledTimes(4);
      expect(getConversation).toHaveBeenLastCalledWith(entry);
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(entry);

      await key('Escape');
      expect(app!.findComponent(ReaderView).exists()).toBe(false);
      expect(app!.findComponent(RemindersPanel).exists()).toBe(false);
      const row = app!.get(`[data-test="conversation-row-${entry.conversationId}"]`);
      expect(row.attributes('aria-current')).toBe('true');
      expect(document.activeElement).toBe(row.element);
      expect(setRead).not.toHaveBeenCalled();
    } finally {
      pending.resolve(detail);
      await flushPromises();
    }
  });
});
