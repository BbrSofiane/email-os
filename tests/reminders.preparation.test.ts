import { nextTick } from 'vue';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
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
const recovery = 'Retry preparation / refresh source';

describe('in-panel reminder preparation recovery', () => {
  it('retries a transient conversation-read failure explicitly, not via list refresh', async () => {
    const { fake, put } = fixture();
    const get = vi.spyOn(fake, 'getConversation').mockRejectedValueOnce({ kind: 'storage_unavailable' });
    const { wrapper: panel, unmount } = mountReminders(fake, { target });
    await flushPromises();
    expect(panel.find('form').exists()).toBe(false);
    expect(panel.get('[role="alert"]').text()).toContain('Retry preparation');
    await button(panel, 'Refresh reminders').trigger('click'); await flushPromises();
    expect(get).toHaveBeenCalledTimes(1);
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(get).toHaveBeenNthCalledWith(2, target);
    expect(panel.find('form').exists()).toBe(true);
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(put).not.toHaveBeenCalled();
    unmount();
  });

  it('reprepares the same account+conversation after source rejection, preserving choices and requiring explicit resubmission with a new key', async () => {
    const { fake, rows, put } = fixture();
    // Recovery must not select a different active row from the refreshed list.
    rows.push({ conversation: { ...target, conversationId: 'conv-02' }, sourceMessageId: 'other-source', revision: 9, phase: 'pending', dueAt: null, condition: 'if_no_reply', subject: 'Other reminder' });
    const initial = await fake.getConversation(target);
    const latest: Conversation = { ...initial, messages: [...initial.messages, { ...initial.messages.at(-1)!, id: 'new-incoming-id' }] };
    const get = vi.spyOn(fake, 'getConversation').mockResolvedValueOnce(initial).mockResolvedValueOnce(latest);
    const { wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    await panel.get('[data-test="reminder-custom"]').trigger('click');
    await panel.get('input[type="text"]').setValue('2035-11-03T01:30:00-05:00');
    await panel.get('select').setValue('regardless');
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'sourceMessageId' });
    await panel.get('form').trigger('submit'); await flushPromises();
    const first = put.mock.calls[0]![0];
    expect(first.sourceMessageId).toBe(initial.messages.at(-1)!.id);
    expect(panel.find('form').exists()).toBe(false);
    expect(panel.get('[role="alert"]').text()).toContain('newer message');
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(get.mock.calls).toEqual([[target], [target]]);
    expect(put).toHaveBeenCalledTimes(1);
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    // The source ids are evidence, never visible text: attributes and a title only.
    expect(panel.get('form').attributes('data-source-message')).toBe('new-incoming-id');
    expect(panel.get('form').text()).not.toContain('new-incoming-id');
    // The typed time stays visible: the saved choice is never hidden.
    expect((panel.get('input[type="text"]').element as HTMLInputElement).value).toBe(first.dueAt);
    expect((panel.get('select').element as HTMLSelectElement).value).toBe('regardless');
    await panel.get('form').trigger('submit'); await flushPromises();
    const second = put.mock.calls[1]![0];
    expect(second).toEqual({ ...first, sourceMessageId: 'new-incoming-id', requestId: expect.any(String) });
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.expectedRevision).toBeNull();
    expect(first.sourceMessageId).toBe(initial.messages.at(-1)!.id);
    unmount();
  });

  it('preserves Someday across preparation recovery', async () => {
    const { fake, put } = fixture();
    const { wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    await panel.get('input[type="checkbox"]').setValue(true);
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'sourceMessageId' });
    await panel.get('form').trigger('submit'); await flushPromises();
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect((panel.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(true);
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[1]![0].dueAt).toBeNull(); unmount();
  });

  it('keeps ambiguous ACK retries exact and retains source-validation context on retry', async () => {
    const { fake, put } = fixture();
    const get = vi.spyOn(fake, 'getConversation');
    const { wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    await panel.get('input[type="checkbox"]').setValue(true);
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' }).mockRejectedValueOnce({ kind: 'invalid_request', field: 'sourceMessageId' });
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(panel.text()).not.toContain(recovery);
    await button(panel, 'Retry exact request').trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(put.mock.calls[0]![0]);
    expect(get).toHaveBeenCalledTimes(1);
    expect(button(panel, recovery).exists()).toBe(true); unmount();
  });

  it.each(['revision', 'sourceMessageId'])('never converts revisioned %s rejection into preparation or a new schedule', async field => {
    const { fake, rows, put } = fixture();
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, sourceMessageId: detail.messages.at(-1)!.id, revision: 4, phase: 'pending', dueAt: null, condition: 'regardless', subject: 'Existing' });
    const get = vi.spyOn(fake, 'getConversation');
    const { wrapper: panel, unmount } = mountReminders(fake, { target: null }); await flushPromises();
    await button(panel, 'Reschedule').trigger('click');
    put.mockRejectedValueOnce({ kind: 'invalid_request', field });
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[0]![0].expectedRevision).toBe(4);
    expect(panel.text()).toContain('revision is no longer actionable');
    expect(panel.find('form').exists()).toBe(false);
    expect(panel.text()).not.toContain(recovery);
    expect(get).not.toHaveBeenCalled(); unmount();
  });

  it('does not turn an active existing reminder conflict into source refresh', async () => {
    const { fake, put } = fixture();
    const { wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    put.mockRejectedValueOnce({ kind: 'invalid_request', field: 'revision' });
    await panel.get('input[type="checkbox"]').setValue(true);
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[0]![0].expectedRevision).toBeNull();
    expect(panel.text()).not.toContain(recovery);
    expect(panel.find('form').exists()).toBe(false); unmount();
  });

  it.each(['success', 'failure'])('ignores stale retry %s after the target changes and cannot overwrite an existing revision editor', async outcome => {
    const { fake, rows } = fixture();
    const detail = await fake.getConversation(target);
    rows.push({ conversation: target, sourceMessageId: 'original-existing-source', revision: 7, phase: 'pending', dueAt: null, condition: 'regardless', subject: 'Existing' });
    const pending = deferred<Conversation>();
    vi.spyOn(fake, 'getConversation').mockRejectedValueOnce(new Error('transient')).mockReturnValueOnce(pending.promise);
    const { model, wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    await button(panel, recovery).trigger('click');
    model.setTarget(null); await nextTick();
    await button(panel, 'Reschedule').trigger('click');
    if (outcome === 'success') pending.resolve(detail);
    else pending.reject(new Error('late failure'));
    await flushPromises();
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(panel.get('h2').text()).toBe('Reschedule');
    expect(panel.get('form').attributes('data-source-message')).toBe('original-existing-source');
    expect(panel.text()).not.toContain(recovery); unmount();
  });

  it('ignores a retry response after unmount', async () => {
    const { fake } = fixture();
    const detail = await fake.getConversation(target);
    const pending = deferred<Conversation>();
    vi.spyOn(fake, 'getConversation').mockRejectedValueOnce(new Error('transient')).mockReturnValueOnce(pending.promise);
    const { model, wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    await button(panel, recovery).trigger('click');
    unmount(); pending.resolve(detail); await flushPromises();
    expect(model.source.value).toBeNull();
    expect(panel.find('form').exists()).toBe(false);
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
    const { wrapper: panel, unmount } = mountReminders(fake, { target }); await flushPromises();
    expect(panel.find('form').exists()).toBe(false);
    expect(panel.find('[role="alert"]').exists()).toBe(true);
    await button(panel, recovery).trigger('click'); await flushPromises();
    expect(panel.find('form').exists()).toBe(true);
    expect(panel.find('[role="alert"]').exists()).toBe(false);
    expect(put).not.toHaveBeenCalled(); unmount();
  });
});
