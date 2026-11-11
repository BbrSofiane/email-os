import { flushPromises } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import RemindersList from '../src/components/RemindersList.vue';
import ReminderPicker from '../src/components/ReminderPicker.vue';
import { fullDateLabel } from '../src/lib/browsing-dates';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { PutReminder, Reminder } from '../src/lib/ipc/client';
import { deferred, useGmailMode, mountApp, press } from './helpers';
import { mountReminders } from './reminders.helpers';
import { flushVueMacrotasks } from './support/ui-settle';

function fixture() {
  const fake = createBrowserFakeMailClient();
  const rows: Reminder[] = [];
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => {
    const r: Reminder = { conversation: c.conversation, subject: '<script>literal</script>', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing' };
    rows.splice(0, rows.length, r); return r;
  });
  fake.reminders = { list: vi.fn(async () => JSON.parse(JSON.stringify(rows)) as Reminder[]), put, cancel: vi.fn(async c => ({ ...rows[0]!, revision: c.expectedRevision + 1, phase: 'cancelling' as const })) };
  return { fake, rows, put };
}
/** H, choose Someday in the shared picker, press Schedule reminder: the keyboard path of a new reminder. */
async function scheduleSomeday(app: ReturnType<typeof mountApp>) {
  press('h', { bubbles: true  }, window); await flushPromises();
  const input = app.get('#reminder-time-input');
  await input.setValue('Someday'); await input.trigger('keydown', { key: 'ArrowDown' }); await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
  await app.findAll('button').find(button => button.text() === 'Schedule reminder')!.trigger('click'); await flushPromises();
}
describe('bounded local reminder journey', () => {
  it('keeps an untouched reschedule exact and disarms Save while visible edits are invalid', async () => {
    const { fake, rows, put } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    rows.push({ conversation: target, subject: 'Stored subject', revision: 7, sourceMessageId: 'message-1', dueAt: '2030-11-03T01:30:00-05:00', condition: 'if_no_reply', phase: 'pending' });
    const m = mountReminders(fake, { target: null }); const panel = m.wrapper;
    await flushPromises();
    await panel.findAll('button').find(b => b.text() === 'Reschedule')!.trigger('click');
    const input = panel.get('#reminder-time-input');
    expect((input.element as HTMLInputElement).value).toContain('November 3, 2030');
    expect((input.element as HTMLInputElement).value).not.toContain('2030-11-03T01:30:00-05:00');
    expect(panel.text()).not.toContain('No matching suggestions');
    await input.setValue('not a valid time');
    const save = panel.findAll('button').find(b => b.text() === 'Save new time')!;
    expect(save.attributes('disabled')).toBeDefined();
    await input.trigger('keydown', { key: 'Enter' });
    expect(panel.findAll('[role="alert"]').some(alert => alert.text().includes('Try'))).toBe(true);
    expect(put).not.toHaveBeenCalled();
    await input.setValue('2030-11-03T01:30:00-05:00');
    await input.trigger('keydown', { key: 'Enter' });
    await flushPromises();
    const resolvedSave = panel.findAll('button').find(b => b.text() === 'Save new time')!;
    expect((resolvedSave.element as HTMLButtonElement).disabled).toBe(false);
    await resolvedSave.trigger('click');
    await flushPromises();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ dueAt: '2030-11-03T01:30:00-05:00', expectedRevision: 7 }));
    m.unmount();
  });

  it('requires a future replacement before saving a reminder whose stored time has passed', async () => {
    const { fake, rows, put } = fixture();
    rows.push({ conversation: { accountId: 'fixture-account', conversationId: 'conv-01' }, subject: 'Past reminder', revision: 2, sourceMessageId: 'message-1', dueAt: '2000-01-01T00:00:00Z', condition: 'if_no_reply', phase: 'pending' });
    const m = mountReminders(fake, { target: null }); const panel = m.wrapper;
    await flushPromises();
    await panel.findAll('button').find(b => b.text() === 'Reschedule')!.trigger('click');
    const save = panel.findAll('button').find(b => b.text() === 'Save new time')!;
    expect((save.element as HTMLButtonElement).disabled).toBe(true);
    expect(panel.text()).not.toContain('No matching suggestions');
    await panel.get('#reminder-time-input').setValue('2030-11-03T01:30:00-05:00');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' });
    await flushPromises();
    expect((panel.findAll('button').find(b => b.text() === 'Save new time')!.element as HTMLButtonElement).disabled).toBe(false);
    await panel.findAll('button').find(b => b.text() === 'Save new time')!.trigger('click');
    await flushPromises();
    expect(put).toHaveBeenCalledWith(expect.objectContaining({ dueAt: '2030-11-03T01:30:00-05:00', expectedRevision: 2 }));
    m.unmount();
  });

  it('prepares an immutable source, defaults conditional, retries exact lost ACK and separates returned membership', async () => {
    const { fake, rows, put } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const m = mountReminders(fake, { target }); const panel = m.wrapper;
    await flushPromises();
    const detail = await fake.getConversation(target);
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await panel.get('#reminder-time-input').setValue('2030-11-03T01:30:00-05:00');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' }); await flushPromises();
    { const save = panel.findAll('button').find(b => b.text() === 'Schedule reminder');
    if (save && !save.attributes('disabled')) { await save.trigger('click'); await flushPromises(); } }
    expect(panel.get('[role="alert"]').text()).toContain('not acknowledged');
    const first = put.mock.calls[0]![0];
    expect(first).toMatchObject({ conversation: target, sourceMessageId: detail.messages.at(-1)!.id, condition: 'if_no_reply', expectedRevision: null });
    const retry = panel.findAll('button').find(b => b.text() === 'Retry exact request')!;
    await retry.trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(first);
    expect(m.scheduled).toEqual([[rows[0], false]]);
    expect(panel.text()).toContain('Hiding from Inbox'); expect(panel.find('script').exists()).toBe(false);
    rows[0]!.phase = 'returned';
    await panel.findAll('button').find(b => b.text() === 'Refresh reminders')!.trigger('click'); await flushPromises();
    expect(panel.text()).toContain('No pending reminders');
    m.model.destination.value = 'returned'; await flushPromises();
    expect(panel.text()).toContain('<script>literal</script>');
    await panel.get('.context-row-main').trigger('click'); expect(panel.emitted('open')![0]).toEqual([target]);
    m.unmount();
  });
  it('emits dismiss for a new picker and does not change destination when browsing', async () => {
    const { fake } = fixture();
    const m = mountReminders(fake, { target: { accountId: 'fixture-account', conversationId: 'conv-01' } }); const panel = m.wrapper;
    await flushPromises();
    m.model.destination.value = 'returned';
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Escape' });
    expect(m.dismissed).toHaveLength(1);
    expect(m.model.destination.value).toBe('returned');
    m.unmount();
  });
  it('keeps a rejected time editable rather than endlessly replaying a validation error', async () => {
    const { fake, put } = fixture();
    const m = mountReminders(fake, { target: { accountId: 'fixture-account', conversationId: 'conv-01' } }); const panel = m.wrapper; await flushPromises();
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'dueAt' });
    await panel.get('#reminder-time-input').setValue('2030-11-03T01:30:00');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' }); await flushPromises();
    { const save = panel.findAll('button').find(b => b.text() === 'Schedule reminder');
    if (save && !save.attributes('disabled')) { await save.trigger('click'); await flushPromises(); } }
    expect(panel.get('[role="alert"]').text()).toContain('offset');
    expect(put).not.toHaveBeenCalled();
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'dueAt' });
    await panel.get('#reminder-time-input').setValue('2030-11-03T01:30:00-05:00');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' }); await flushPromises();
    { const save = panel.findAll('button').find(b => b.text() === 'Schedule reminder');
    if (save && !save.attributes('disabled')) { await save.trigger('click'); await flushPromises(); } }
    expect(put).toHaveBeenCalledTimes(1);
    expect(panel.get('[role="alert"]').text()).toContain('numeric timezone offset');
    expect(panel.get('#reminder-time-input').attributes('disabled')).toBeUndefined();
    await panel.get('#reminder-time-input').setValue('2030-11-03T01:30:00-05:00');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' }); await flushPromises();
    { const save = panel.findAll('button').find(b => b.text() === 'Schedule reminder');
    if (save && !save.attributes('disabled')) { await save.trigger('click'); await flushPromises(); } }
    expect(put.mock.calls[1]![0].requestId).not.toBe(put.mock.calls[0]![0].requestId);
    m.unmount();
  });

  it('offers someday and revisioned cancel / reschedule against authoritative rows', async () => {
    const { fake, rows, put } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    await panel.findAll('[aria-label="Suggested reminder times"] [role="option"]').find(b => b.text().includes('Someday'))!.trigger('click');
    await panel.get('select').setValue('regardless'); await panel.findAll('button').find(b => b.text() === 'Schedule reminder')!.trigger('click'); await flushPromises();
    expect(put.mock.calls[0]![0]).toMatchObject({ dueAt: null, condition: 'regardless' });
    rows[0]!.phase = 'pending'; rows[0]!.revision = 3;
    await panel.findAll('button').find(b => b.text() === 'Refresh reminders')!.trigger('click'); await flushPromises();
    await panel.findAll('button').find(b => b.text() === 'Reschedule')!.trigger('click');
    await panel.findAll('button').find(b => b.text() === 'Save new time')!.trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0].expectedRevision).toBe(3);
    expect(m.scheduled.at(-1)).toEqual([rows[0], true]);
    const confirmations = m.scheduled.length;
    const cancelButton = panel.findAll('button').find(b => b.text().startsWith('Cancel reminder'))!;
    expect(cancelButton.attributes('disabled')).toBeUndefined();
    await cancelButton.trigger('click'); await flushPromises();
    expect(m.scheduled).toHaveLength(confirmations);
    expect(fake.reminders!.cancel).toHaveBeenCalledWith(expect.objectContaining({ conversation: target, expectedRevision: 1 }));
    m.unmount();
  });
  it('opens a returned conversation and Back restores the returned destination without auto-read', async () => {
    const { fake, rows } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, subject: 'Returned fixture', revision: 4, sourceMessageId: detail.messages.at(-1)!.id, dueAt: '2030-01-01T00:00:00Z', condition: 'regardless', phase: 'returned' });
    const setRead = vi.spyOn(fake, 'setRead');
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    await app.findAll('button').find(b => b.text() === 'Reminders')!.trigger('click'); await flushPromises();
    await app.findAll('[role="tab"]')[1]!.trigger('click'); await flushPromises();
    // Due times are the full viewer-local form with a machine-readable datetime.
    expect(app.findComponent(RemindersList).get('time[datetime="2030-01-01T00:00:00.000Z"]').text()).toBe(fullDateLabel('2030-01-01T00:00:00Z'));
    await app.findComponent(RemindersList).get('.context-row-main').trigger('click'); await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    press('Escape', {}, window); await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(true);
    expect(app.findAll('[role="tab"]')[1]!.attributes('aria-selected')).toBe('true');
    expect(setRead).not.toHaveBeenCalled(); app.unmount();
  });

  it('H opens a capable fixture or Gmail picker and guards bulk, text input, IME, and absent transport', async () => {
    const { fake } = fixture();
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    press('h', { bubbles: true  }, window); await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(true);
    expect(app.findComponent(RemindersList).findComponent(ReminderPicker).exists()).toBe(true);
    const input = app.findComponent(RemindersList).get('#reminder-time-input');
    await input.setValue('h'); await input.trigger('keydown', { key: 'h' });
    expect((input.element as HTMLInputElement).value).toBe('h');
    // Escape in the picker of a new reminder ends the request and goes Back to the Inbox row.
    await input.trigger('keydown', { key: 'Escape' }); await flushPromises();
    press('h', { isComposing: true  }, window); await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    press('x', {}, window); await flushPromises();
    expect(app.get('[data-test="selection-live"]').text()).toContain('1 selected');
    press('h', {}, window); await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    app.unmount();
    const gmail = fixture(); useGmailMode(gmail.fake);
    const gated = mountApp(gmail.fake, 'native'); await flushPromises();
    press('h', {}, window); await flushPromises();
    expect(gated.findComponent(RemindersList).exists()).toBe(true); gated.unmount();
    const unsupported = createBrowserFakeMailClient();
    delete unsupported.reminders;
    const preview = mountApp(unsupported, 'browser-preview'); await flushPromises();
    expect(preview.text()).not.toContain('Remind me'); preview.unmount();
  });

  it('returns an acknowledged schedule from list and reader to Inbox with receipt-based status', async () => {
    const { fake, put } = fixture();
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    const row = app.find('[data-test^="conversation-row-"]');
    const rowTestId = row.attributes('data-test');
    await row.trigger('click'); await flushPromises();
    expect(app.find('[data-test="reader"]').exists()).toBe(true);
    press('h', { bubbles: true  }, window); await flushPromises();
    const input = app.get('#reminder-time-input');
    await input.setValue('2030-11-03T01:30:00-05:00'); await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
    await app.findAll('button').find(b => b.text() === 'Schedule reminder')!.trigger('click'); await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    expect(app.find('[data-test="reminder-confirmation"]').attributes('role')).toBe('status');
    expect(app.find('[data-test="reminder-confirmation"]').text()).toMatch(/^Reminder scheduled for /);
    expect(app.find('[data-test="reader"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-test')).toBe(rowTestId);
    expect(put).toHaveBeenCalledTimes(1);
    app.unmount();
  });

  it('returns a reschedule from the Reminders manager to Inbox with a brief confirmation', async () => {
    const { fake, rows, put } = fixture();
    const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, subject: 'Existing reminder', revision: 3, sourceMessageId: detail.messages.at(-1)!.id, dueAt: '2030-11-03T01:30:00-05:00', condition: 'regardless', phase: 'pending' });
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    await app.findAll('button').find(button => button.text() === 'Reminders')!.trigger('click'); await flushPromises();
    await app.findAll('button').find(button => button.text() === 'Reschedule')!.trigger('click'); await flushPromises();
    await app.findAll('button').find(button => button.text() === 'Save new time')!.trigger('click'); await flushPromises();
    expect(put.mock.calls[0]![0]).toMatchObject({ expectedRevision: 3, dueAt: rows[0]!.dueAt });
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    expect(app.find('[data-test="inbox-title"]').text()).toContain('Inbox');
    expect(app.get('[data-test="reminder-confirmation"]').text()).toMatch(/^Reminder rescheduled for /);
    expect(document.activeElement?.getAttribute('data-test')).toMatch(/^conversation-row-/);
    app.unmount();
  });

  it('keeps failure and dismissal silent, then confirms Someday only after exact retry succeeds', async () => {
    const { fake, put } = fixture();
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    press('h', { bubbles: true  }, window); await flushPromises();
    const picker = app.findComponent(RemindersList);
    const input = picker.get('#reminder-time-input');
    await input.setValue('Someday'); await input.trigger('keydown', { key: 'ArrowDown' }); await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
    await app.findAll('button').find(button => button.text() === 'Schedule reminder')!.trigger('click'); await flushPromises();
    expect(app.find('[data-test="reminder-confirmation"]').exists()).toBe(false);
    expect(picker.text()).toContain('not acknowledged');
    const exact = put.mock.calls[0]![0];
    await app.findAll('button').find(button => button.text() === 'Retry exact request')!.trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(exact);
    expect(app.find('[data-test="reminder-confirmation"]').text()).toBe('Reminder scheduled for Someday');
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    app.unmount();

    const dismissed = fixture();
    const second = mountApp(dismissed.fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    press('h', { bubbles: true  }, window); await flushPromises();
    await second.get('#reminder-time-input').trigger('keydown', { key: 'Escape' }); await flushPromises();
    expect(second.find('[data-test="reminder-confirmation"]').exists()).toBe(false);
    expect(second.findComponent(RemindersList).exists()).toBe(false);
    second.unmount();
  });

  it('expires the brief confirmation and ignores a refresh that finishes after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const timeout = vi.spyOn(globalThis, 'setTimeout');
    const { fake } = fixture();
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body });
    try {
      await flushPromises();
      await scheduleSomeday(app);
      expect(app.get('[data-test="reminder-confirmation"]').text()).toBe('Reminder scheduled for Someday');
      await vi.advanceTimersByTimeAsync(6000);
      expect(app.find('[data-test="reminder-confirmation"]').exists()).toBe(false);
      const snapshot = await fake.listConversations();
      const pendingList = deferred<typeof snapshot>();
      vi.spyOn(fake, 'listConversations').mockImplementationOnce(() => pendingList.promise);
      await scheduleSomeday(app);
      const confirmationTimers = timeout.mock.calls.filter(call => call[1] === 6000).length;
      app.unmount();
      pendingList.resolve(snapshot); await flushPromises();
      expect(timeout.mock.calls.filter(call => call[1] === 6000)).toHaveLength(confirmationTimers);
    } finally {
      if (app.exists()) app.unmount();
      timeout.mockRestore();
      vi.useRealTimers();
    }
  });

  it('does not let a late acknowledged schedule replace newer Inbox navigation', async () => {
    const { fake } = fixture();
    const app = mountApp(fake, 'native', { global: { stubs: { Teleport: true } }, attachTo: document.body }); await flushPromises();
    const originalList = fake.listConversations.bind(fake);
    const pendingList = deferred<Awaited<ReturnType<typeof fake.listConversations>>>();
    press('h', { bubbles: true  }, window); await flushPromises();
    const input = app.get('#reminder-time-input');
    await input.setValue('Someday'); await input.trigger('keydown', { key: 'ArrowDown' }); await input.trigger('keydown', { key: 'Enter' }); await flushPromises();
    // Only the refresh that follows the acknowledged schedule is held back.
    const list = vi.spyOn(fake, 'listConversations').mockImplementationOnce(() => pendingList.promise);
    await app.findAll('button').find(button => button.text() === 'Schedule reminder')!.trigger('click');
    await flushVueMacrotasks();
    expect(list).toHaveBeenCalledTimes(1);
    await app.get('[data-test="rail-inbox"]').trigger('click'); await flushPromises();
    pendingList.resolve(await originalList());
    await flushPromises();
    expect(app.findComponent(RemindersList).exists()).toBe(false);
    expect(app.find('[data-test="inbox-title"]').text()).toContain('Inbox');
    expect(app.find('[data-test="reminder-confirmation"]').text()).toBe('Reminder scheduled for Someday');
    app.unmount();
  });
});
