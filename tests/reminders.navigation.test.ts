import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import ReaderView from '../src/components/ReaderView.vue';
import RemindersPanel from '../src/components/RemindersPanel.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { Conversation, Reminder } from '../src/lib/ipc/client';
import { deferred, mountApp, press } from './helpers';

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
  app = mountApp(client, 'native', { attachTo: document.body });
  await flushPromises();
  return { reminded, entry, neighbor, detail, pending, getConversation, setRead };
}

async function openReturnedReminder() {
  await app!.findAll('button').find(button => button.text() === 'Reminders')!.trigger('click');
  await flushPromises();
  const panel = app!.getComponent(RemindersPanel);
  await panel.findAll('[role="tab"]').find(button => button.text().startsWith('Returned'))!.trigger('click');
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
      expect(getConversation).toHaveBeenCalledExactlyOnceWith(reminded, false);
      press('j', { bubbles: true, cancelable: true }, window); await flushPromises();
      press('k', { bubbles: true, cancelable: true }, window); await flushPromises();
      expect(getConversation).toHaveBeenCalledTimes(1);

      // The transport is still pending: Back must already know its real origin.
      press('Escape', { bubbles: true, cancelable: true }, window); await flushPromises();
      expect(app!.findComponent(ReaderView).exists()).toBe(false);
      expect(app!.findComponent(RemindersPanel).exists()).toBe(true);
      const panel = app!.getComponent(RemindersPanel);
      expect(panel.findAll('[role="tab"]').find(button => button.text().startsWith('Returned'))!.attributes('aria-selected')).toBe('true');
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
    const { reminded, entry, neighbor, detail, pending, getConversation, setRead } = await fixture();
    try {
      await openReturnedReminder();
      // Explicit Inbox navigation closes the loading reader without returning
      // to its utility destination. A new list entry owns the next reader.
      await app!.get('[data-test="rail-inbox"]').trigger('click');
      await flushPromises();
      await app!.get(`[data-test="conversation-row-${entry.conversationId}"]`).trigger('click');
      await flushPromises();
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(entry);
      // Opening the Inbox reader also prefetched its next neighbor (read-only).
      expect(getConversation.mock.calls.map(([target]) => target)).toEqual([reminded, entry, neighbor]);

      pending.resolve(detail);
      await flushPromises();
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(entry);
      expect(app!.findComponent(RemindersPanel).exists()).toBe(false);
      const before = getConversation.mock.calls.length;
      press('j', { bubbles: true, cancelable: true }, window); await flushPromises();
      // The prefetched neighbor swaps in from cache; one background revalidation
      // follows, then the next prefetch. The late reminder detail was never reused.
      expect(getConversation.mock.calls.slice(before)[0]).toEqual([neighbor, false]);
      expect(getConversation.mock.calls.slice(before).every(([target]) => target.conversationId !== reminded.conversationId)).toBe(true);
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(neighbor);
      const beforeK = getConversation.mock.calls.length;
      press('k', { bubbles: true, cancelable: true }, window); await flushPromises();
      expect(getConversation.mock.calls.slice(beforeK)[0]).toEqual([entry, false]);
      expect(app!.getComponent(ReaderView).props('conversation')?.ref).toEqual(entry);

      press('Escape', { bubbles: true, cancelable: true }, window); await flushPromises();
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

it.each(['list', 'reader'])('restores %s shortcut focus after H then Escape', async surface => {
  const client = createBrowserFakeMailClient();
  const archive = vi.spyOn(client, 'setArchived');
  app = mountApp(client, 'native', { attachTo: document.body });
  await flushPromises();
  const row = app.find('[data-test^="conversation-row-"]');
  if (surface === 'reader') { await row.trigger('click'); await flushPromises(); }
  else (row.element as HTMLElement).focus();
  press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
  const input = document.querySelector('#reminder-time-input')!;
  expect(input).not.toBeNull();
  press('Escape', { bubbles: true }, input);
  await flushPromises();
  expect(app.findComponent(RemindersPanel).exists()).toBe(false);
  if (surface === 'list') expect(document.activeElement).toBe(row.element);
  else expect(app.getComponent(ReaderView).element.contains(document.activeElement)).toBe(true);
  press('e', { bubbles: true }, document.activeElement!);
  await flushPromises();
  expect(archive).toHaveBeenCalledTimes(1);
});

it.each(['ack', 'lost ACK', 'unmount'])('keeps BODY Escape and drawer Close from discarding a put; handles %s', async outcome => {
  const client = createBrowserFakeMailClient();
  const pending = deferred<Reminder>();
  const put = vi.spyOn(client.reminders!, 'put').mockImplementationOnce(() => pending.promise);
  app = mountApp(client, 'native', { attachTo: document.body });
  await flushPromises();
  press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
  (document.querySelector('#reminder-time-option-someday') as HTMLElement).click();
  await flushPromises();
  const schedule = [...document.querySelectorAll('button')].find(b => b.textContent === 'Schedule reminder')!;
  schedule.click(); await flushPromises();
  const command = put.mock.calls[0]![0];
  const input = document.querySelector('#reminder-time-input') as HTMLInputElement;
  expect(input.disabled).toBe(true);
  expect(document.querySelector('[data-reminder-picker]')!.contains(document.activeElement)).toBe(true);
  (document.activeElement as HTMLElement).blur();
  press('Escape', { bubbles: true, cancelable: true }, document.body);
  await flushPromises();
  await app.get('[data-test="drawer-close"]').trigger('click');
  expect(document.querySelector('[data-reminder-picker]')).not.toBeNull();
  expect(document.querySelector('[data-reminder-picker]')!.contains(document.activeElement)).toBe(true);
  expect(app.find('[data-test="reminder-confirmation"]').exists()).toBe(false);
  if (outcome === 'unmount') {
    app.unmount(); app = undefined;
    const other = document.createElement('button'); document.body.append(other); other.focus();
    pending.resolve({ ...command, subject: 'Saved', revision: 1, phase: 'pending' });
    await flushPromises();
    expect(document.activeElement).toBe(other);
    expect(document.querySelector('[data-reminder-picker]')).toBeNull();
    return;
  }
  if (outcome === 'ack') pending.resolve({ ...command, subject: 'Saved', revision: 1, phase: 'pending' });
  else pending.reject({ kind: 'storage_unavailable' });
  await flushPromises();
  if (outcome === 'ack') {
    expect(app.get('[data-test="reminder-confirmation"]').text()).toContain('Someday');
    expect(document.querySelector('[data-reminder-picker]')).toBeNull();
  } else {
    (document.activeElement as HTMLElement).blur();
    press('Escape', { bubbles: true, cancelable: true }, window); await flushPromises();
    await app.get('[data-test="drawer-close"]').trigger('click');
    expect(document.querySelector('[data-reminder-picker]')).not.toBeNull();
    expect(app.find('[data-test="reminder-confirmation"]').exists()).toBe(false);
    const picker = document.querySelector('[data-reminder-picker]')!;
    const inspect = [...picker.querySelectorAll('button')].find(b => b.textContent === 'Inspect saved state')!;
    inspect.click(); await flushPromises();
    expect(document.querySelector('[data-reminder-picker]')).toBeNull();
    expect(app.findComponent(RemindersPanel).exists()).toBe(true);
  }
});

it.each(['inactive workspace', 'new drawer'])('does not restore origin focus after dismissal when a %s takes ownership', async owner => {
  const client = createBrowserFakeMailClient();
  app = mountApp(client, 'native', { attachTo: document.body });
  await flushPromises(); press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
  const input = document.querySelector('#reminder-time-input')!;
  press('Escape', { bubbles: true }, input);
  if (owner === 'inactive workspace') {
    const other = document.createElement('button'); document.body.append(other); other.focus();
    await app.setProps({ active: false });
    await flushPromises();
    expect(document.activeElement).toBe(other);
  } else {
    (app.get('[data-test="rail-activity"]').element as HTMLElement).click();
    await flushPromises();
    expect(app.get('[data-test="rail-activity"]').attributes('aria-expanded')).toBe('true');
    expect(document.activeElement?.closest('.utility-drawer')).not.toBeNull();
  }
});
