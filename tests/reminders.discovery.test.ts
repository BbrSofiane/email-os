import { mountApp } from './helpers';
import { afterEach, expect, it } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import RemindersPanel from '../src/components/RemindersPanel.vue';
import ReminderSettings from '../src/components/ReminderSettings.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';

let app: VueWrapper | undefined;
afterEach(() => { app?.unmount(); app = undefined; document.body.innerHTML = ''; localStorage.clear(); });

it('opens the clicked row reminder in read-only Gmail mode without provider writes', async () => {
  const client = createBrowserFakeMailClient();
  client.controls.setAccount({ mode: 'gmail', connection: 'connected' });
  const rows = (await client.listConversations()).conversations;
  const target = rows[1]!.ref;
  app = mountApp(client, 'native', { attachTo: document.body });
  await flushPromises();
  await app.get(`[data-test="row-remind-${target.conversationId}"]`).trigger('click');
  await flushPromises();
  expect(app.getComponent(RemindersPanel).props('target')).toEqual(target);
  expect((await client.listConversations()).activity).toEqual([]);
});

it('opens settings through the palette and persists chosen preset time', async () => {
  const client = createBrowserFakeMailClient();
  app = mountApp(client, 'native', { attachTo: document.body });
  await flushPromises();
  await app.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  await app.get('[data-test="action-query"]').setValue('Reminder Settings');
  await app.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  const settings = app.getComponent(ReminderSettings);
  await settings.get('[aria-label="Default reminder hour"]').setValue('17');
  await settings.get('form').trigger('submit');
  await flushPromises();
  expect(app.findComponent(ReminderSettings).exists()).toBe(false);
  expect(JSON.parse(localStorage.getItem('email-os.reminder-preferences.v1')!).hour).toBe(17);
});

it('schedules from the picker and returns focus to a surviving Inbox row', async () => {
  const client = createBrowserFakeMailClient();
  const target = (await client.listConversations()).conversations[0]!.ref;
  app = mountApp(client, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body });
  await flushPromises();
  await app.get(`[data-test="row-remind-${target.conversationId}"]`).trigger('click');
  await flushPromises();
  const panel = app.getComponent(RemindersPanel);
  await panel.get('#reminder-time-input').setValue('3 days');
  await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' });
  await panel.get('select').setValue('regardless');
  await panel.findAll('button').find(button => button.text() === 'Schedule reminder')!.trigger('click');
  await flushPromises();
  expect(app.findComponent(RemindersPanel).exists()).toBe(false);
  expect(app.find(`[data-test="conversation-row-${target.conversationId}"]`).exists()).toBe(false);
  expect(document.activeElement?.getAttribute('data-test')).toMatch(/^conversation-row-/);
  expect((await client.reminders!.list())[0]).toMatchObject({ condition: 'regardless', phase: 'pending' });
  const savedDueAt = (await client.reminders!.list())[0]!.dueAt;
  await app.get('[data-test="palette-trigger"]').trigger('click');
  await flushPromises();
  await app.get('[data-test="action-query"]').setValue('Reminder Settings');
  await app.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
  await flushPromises();
  const settings = app.getComponent(ReminderSettings);
  await settings.get('[aria-label="Default reminder hour"]').setValue('17');
  await settings.get('form').trigger('submit');
  await flushPromises();
  expect((await client.reminders!.list())[0]!.dueAt).toBe(savedDueAt);
  expect((await client.listConversations()).activity).toEqual([]);
});
