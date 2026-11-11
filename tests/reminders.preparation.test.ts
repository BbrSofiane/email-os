import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import ReminderPicker from '../src/components/ReminderPicker.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import { formatReminderDateTime } from '../src/lib/reminder-timezone';
import type { Conversation, PutReminder, Reminder } from '../src/lib/ipc/client';
import { mountReminders } from './reminders.helpers';

const target = { accountId: 'fixture-account', conversationId: 'conv-01' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function button(panel: VueWrapper, text: string) {
  const result = panel.findAll('button').find(b => b.text() === text);
  if (!result) throw new Error(`Missing button: ${text}`);
  return result;
}
function fixture() {
  const fake = createBrowserFakeMailClient();
  const rows: Reminder[] = [];
  const put = vi.fn(async (command: PutReminder): Promise<Reminder> => ({
    conversation: command.conversation, sourceMessageId: command.sourceMessageId,
    revision: 1, dueAt: command.dueAt, condition: command.condition,
    phase: 'removing', subject: 'Synthetic reminder',
  }));
  fake.reminders = { list: vi.fn(async () => structuredClone(rows)), put, cancel: vi.fn() };
  return { fake, rows, put };
}
const recovery = 'Retry preparation / refresh conversation';

describe('in-list reminder preparation recovery', () => {
  it('shows exact prepared subject and latest sender as safe, accessible dialog context', async () => {
    const { fake } = fixture();
    const detail = await fake.getConversation(target);
    detail.subject = ('<img src=x onerror=alert(1)> ' + 'A long subject that must remain readable '.repeat(5)).trimEnd();
    detail.messages.at(-1)!.from = { displayName: 'Exact Sender', mailbox: 'sender@example.test' };
    const get = vi.spyOn(fake, 'getConversation').mockResolvedValue(detail);
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    const picker = panel.findComponent(ReminderPicker);
    expect(get).toHaveBeenCalledTimes(1);
    expect(picker.props()).toMatchObject({ subject: detail.subject, sender: 'Exact Sender' });
    expect(picker.get('details summary').text()).toBe(detail.subject);
    expect(picker.text()).toContain('Exact Sender');
    expect(picker.text()).not.toContain(target.conversationId);
    expect(picker.text()).not.toContain(detail.messages.at(-1)!.id);
    expect(picker.get('[role="dialog"]').attributes('aria-describedby')).toContain('reminder-target-description');
    expect(picker.find('img').exists()).toBe(false);
    expect(picker.get('details summary').element.tagName).toBe('SUMMARY');
    m.unmount();
  });

  it('uses the stored reminder subject for reschedule without reading a conversation', async () => {
    const { fake, rows } = fixture();
    rows.push({ conversation: target, sourceMessageId: 'stored-source', revision: 8, phase: 'pending', dueAt: null, condition: 'regardless', subject: 'Stored reminder subject' });
    const get = vi.spyOn(fake, 'getConversation');
    const m = mountReminders(fake, { target: null }); const panel = m.wrapper; await flushPromises();
    await button(panel, 'Reschedule').trigger('click');
    expect(panel.findComponent(ReminderPicker).props()).toMatchObject({ subject: 'Stored reminder subject', sender: null });
    expect(panel.findComponent(ReminderPicker).get('#reminder-target-description').text()).toContain('Stored reminder subject');
    expect(get).not.toHaveBeenCalled();
    m.unmount();
  });

  it('uses the no-subject convention and never leaks stale context when the target changes', async () => {
    const { fake } = fixture();
    const other = { ...target, conversationId: 'conv-02' };
    const first = deferred<Conversation>();
    const second = await fake.getConversation(other);
    second.subject = '';
    vi.spyOn(fake, 'getConversation').mockReturnValueOnce(first.promise).mockResolvedValueOnce(second);
    const m = mountReminders(fake, { target }); const panel = m.wrapper;
    await flushPromises();
    m.model.setTarget(other); await flushPromises();
    const picker = panel.findComponent(ReminderPicker);
    expect(picker.props('subject')).toBe('');
    expect(picker.get('#reminder-target-description').text()).toContain('(No subject)');
    const old = await fake.getConversation(target); old.subject = 'Stale subject';
    first.resolve(old); await flushPromises();
    expect(panel.findComponent(ReminderPicker).props('subject')).toBe('');
    expect(panel.text()).not.toContain('Stale subject');
    m.unmount();
  });

  it('retries a transient conversation-read failure explicitly, not via list refresh', async () => {
    const { fake, put } = fixture();
    const get = vi.spyOn(fake, 'getConversation').mockRejectedValueOnce({ kind: 'storage_unavailable' });
    const m = mountReminders(fake, { target }); const panel = m.wrapper;
    await flushPromises();
    expect(panel.findComponent(ReminderPicker).exists()).toBe(false);
    expect(panel.get('[role="alert"]').text()).toContain('Retry preparation');
    await button(panel, 'Refresh reminders').trigger('click'); await flushPromises();
    expect(get).toHaveBeenCalledTimes(1);
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(get).toHaveBeenNthCalledWith(2, target);
    expect(panel.findComponent(ReminderPicker).exists()).toBe(true);
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(put).not.toHaveBeenCalled();
    m.unmount();
  });

  it('reprepares the same account+conversation after source rejection, preserving choices and requiring explicit resubmission with a new key', async () => {
    const { fake, rows, put } = fixture();
    // Recovery must not select a different active row from the refreshed list.
    rows.push({ conversation: { ...target, conversationId: 'conv-02' }, sourceMessageId: 'other-source', revision: 9, phase: 'pending', dueAt: null, condition: 'if_no_reply', subject: 'Other reminder' });
    const initial = await fake.getConversation(target);
    const latest: Conversation = { ...initial, messages: [...initial.messages, { ...initial.messages.at(-1)!, id: 'new-incoming-id' }] };
    const get = vi.spyOn(fake, 'getConversation').mockResolvedValueOnce(initial).mockResolvedValueOnce(latest);
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    await panel.get('#reminder-time-input').setValue('2035-11-03T01:30:00-05:00');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Enter' });
    await panel.get('select').setValue('regardless');
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'sourceMessageId' });
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    const first = put.mock.calls[0]![0];
    expect(first.sourceMessageId).toBe(initial.messages.at(-1)!.id);
    expect(panel.findComponent(ReminderPicker).exists()).toBe(false);
    expect(panel.get('[role="alert"]').text()).toContain('newer message');
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(get.mock.calls).toEqual([[target], [target]]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(panel.text()).not.toContain('new-incoming-id');
    expect(panel.get('.chosen-time').text()).toContain(formatReminderDateTime(first.dueAt!));
    expect((panel.get('select').element as HTMLSelectElement).value).toBe('regardless');
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    const second = put.mock.calls[1]![0];
    expect(second).toEqual({ ...first, sourceMessageId: 'new-incoming-id', requestId: expect.any(String) });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.expectedRevision).toBeNull();
    expect(first.sourceMessageId).toBe(initial.messages.at(-1)!.id);
    m.unmount();
  });

  it('preserves Someday across preparation recovery', async () => {
    const { fake, put } = fixture();
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    await panel.findAll('[aria-label="Suggested reminder times"] [role="option"]').find(b => b.text().includes('Someday'))!.trigger('click');
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'sourceMessageId' });
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(panel.text()).toContain('Someday');
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0].dueAt).toBeNull(); m.unmount();
  });

  it('keeps ambiguous ACK retries exact and retains source-validation context on retry', async () => {
    const { fake, put } = fixture();
    const get = vi.spyOn(fake, 'getConversation');
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    await panel.findAll('[aria-label="Suggested reminder times"] [role="option"]').find(b => b.text().includes('Someday'))!.trigger('click');
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' }).mockRejectedValueOnce({ kind: 'invalid_request', field: 'sourceMessageId' });
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    expect(panel.text()).not.toContain(recovery);
    await button(panel, 'Retry exact request').trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(put.mock.calls[0]![0]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(button(panel, recovery).exists()).toBe(true); m.unmount();
  });

  it.each(['revision', 'sourceMessageId'])('never converts revisioned %s rejection into preparation or a new schedule', async field => {
    const { fake, rows, put } = fixture();
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, sourceMessageId: detail.messages.at(-1)!.id, revision: 4, phase: 'pending', dueAt: null, condition: 'regardless', subject: 'Existing' });
    const get = vi.spyOn(fake, 'getConversation');
    const m = mountReminders(fake, { target: null }); const panel = m.wrapper; await flushPromises();
    await button(panel, 'Reschedule').trigger('click');
    put.mockRejectedValueOnce({ kind: 'invalid_request', field });
    await button(panel, 'Save new time').trigger('click'); await flushPromises();
    expect(put.mock.calls[0]![0].expectedRevision).toBe(4);
    expect(panel.text()).toContain('no longer actionable');
    expect(panel.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(panel.text()).not.toContain(recovery);
    expect(get).not.toHaveBeenCalled(); m.unmount();
  });

  it('does not turn an active existing reminder conflict into source refresh', async () => {
    const { fake, put } = fixture();
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'revision' });
    await panel.findAll('[aria-label="Suggested reminder times"] [role="option"]').find(b => b.text().includes('Someday'))!.trigger('click');
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    expect(put.mock.calls[0]![0].expectedRevision).toBeNull();
    expect(panel.text()).not.toContain(recovery);
    expect(panel.findComponent(ReminderPicker).exists()).toBe(false); m.unmount();
  });

  it.each(['success', 'failure'])('ignores stale retry %s after the target changes and cannot overwrite an existing revision editor', async outcome => {
    const { fake, rows } = fixture();
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, sourceMessageId: 'original-existing-source', revision: 7, phase: 'pending', dueAt: null, condition: 'regardless', subject: 'Existing' });
    const pending = deferred<Conversation>();
    vi.spyOn(fake, 'getConversation').mockRejectedValueOnce(new Error('transient')).mockReturnValueOnce(pending.promise);
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    await button(panel, recovery).trigger('click');
    m.model.setTarget(null); await flushPromises();
    await button(panel, 'Reschedule').trigger('click');
    if (outcome === 'success') pending.resolve(detail);
    else pending.reject(new Error('late failure'));
    await flushPromises();
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(panel.get('[data-test="reminder-form"] h2').text()).toBe('Reschedule reminder');
    expect(m.dismissed).toHaveLength(0);
    expect(panel.text()).not.toContain(recovery); m.unmount();
  });

  it('ignores a retry response after unmount', async () => {
    const { fake } = fixture();
    const detail = await fake.getConversation(target);
    const pending = deferred<Conversation>();
    vi.spyOn(fake, 'getConversation').mockRejectedValueOnce(new Error('transient')).mockReturnValueOnce(pending.promise);
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    await button(panel, recovery).trigger('click');
    const state = m.model;
    m.unmount(); pending.resolve(detail); await flushPromises();
    expect(state.source.value).toBeNull();
    expect(panel.findComponent(ReminderPicker).exists()).toBe(false);
  });

  it.each(['retained', 'incomplete', 'wrong account', 'wrong conversation', 'empty'] as const)('keeps %s responses out of preparation and allows a later explicit retry', async kind => {
    const { fake, put } = fixture();
    const detail = await fake.getConversation(target);
    const invalid: Conversation = { ...detail,
      ...(kind === 'retained' ? { retainedSnapshotAt: '2030-01-01T00:00:00Z' } : {}),
      ...(kind === 'incomplete' ? { contextComplete: false } : {}),
      ...(kind === 'wrong account' ? { ref: { ...target, accountId: 'another-account' } } : {}),
      ...(kind === 'wrong conversation' ? { ref: { ...target, conversationId: 'conv-02' } } : {}),
      ...(kind === 'empty' ? { messages: [] } : {}),
    };
    vi.spyOn(fake, 'getConversation').mockResolvedValueOnce(invalid).mockResolvedValueOnce(detail);
    const m = mountReminders(fake, { target }); const panel = m.wrapper; await flushPromises();
    expect(panel.findComponent(ReminderPicker).exists()).toBe(false);
    expect(panel.find('[role="alert"]').exists()).toBe(true);
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(panel.findComponent(ReminderPicker).exists()).toBe(true);
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(put).not.toHaveBeenCalled(); m.unmount();
  });
});

it.each(['ack', 'lost ACK'])('protects a pending put from Escape/backdrop and preserves recovery after %s', async outcome => {
  const { fake, put } = fixture();
  const pending = deferred<Reminder>();
  put.mockImplementationOnce(() => pending.promise);
  const m = mountReminders(fake, { target, attachTo: document.body }); const panel = m.wrapper;
  try {
    await flushPromises();
    await panel.get('#reminder-time-option-someday').trigger('click');
    await button(panel, 'Schedule reminder').trigger('click');
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Escape' });
    await panel.get('.backdrop').trigger('click');
    expect(panel.findComponent(ReminderPicker).exists()).toBe(true);
    expect(m.dismissed).toHaveLength(0);
    expect(m.scheduled).toHaveLength(0);
    const command = put.mock.calls[0]![0];
    if (outcome === 'ack') pending.resolve({ ...command, revision: 1, subject: 'Accepted', phase: 'pending' });
    else pending.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    if (outcome === 'ack') expect(m.scheduled).toHaveLength(1);
    else {
      expect(m.scheduled).toHaveLength(0);
      await panel.get('#reminder-time-input').trigger('keydown', { key: 'Escape' });
      await panel.get('.backdrop').trigger('click');
      expect(panel.findComponent(ReminderPicker).exists()).toBe(true);
      await button(panel.findComponent(ReminderPicker), 'Retry exact request').trigger('click');
      await flushPromises();
      expect(put.mock.calls[1]![0]).toEqual(command);
      expect(m.scheduled).toHaveLength(1);
    }
  } finally { m.unmount(); }
});

it.each(['resolve', 'reject'])('fences put %s after the session ends (account or context change)', async outcome => {
  const { fake, put } = fixture();
  const pending = deferred<Reminder>(); put.mockImplementationOnce(() => pending.promise);
  const m = mountReminders(fake, { target, attachTo: document.body }); const panel = m.wrapper;
  try {
    await flushPromises();
    await panel.get('#reminder-time-option-someday').trigger('click');
    await button(panel, 'Schedule reminder').trigger('click');
    const command = put.mock.calls[0]![0];
    // Leaving the context (or the account) ends the session: the picker closes and the late answer is dropped.
    m.model.deactivate(); await flushPromises();
    if (outcome === 'resolve') pending.resolve({ ...command, subject: 'Old account', revision: 1, phase: 'pending' });
    else pending.reject({ kind: 'storage_unavailable' });
    await flushPromises();
    expect(m.scheduled).toHaveLength(0);
    expect(panel.text()).not.toContain('not acknowledged');
    expect(panel.findComponent(ReminderPicker).exists()).toBe(false);
    expect(m.model.retrying.value).toBe(false);
    // A new session for another conversation starts clean and sends its own request.
    const otherTarget = { ...target, conversationId: 'conv-02' };
    m.model.setTarget(otherTarget);
    await m.model.activate(); await flushPromises();
    await panel.get('#reminder-time-option-someday').trigger('click');
    await button(panel, 'Schedule reminder').trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0].conversation).toEqual(otherTarget);
    expect(put.mock.calls[1]![0].requestId).not.toBe(command.requestId);
  } finally { m.unmount(); }
});
