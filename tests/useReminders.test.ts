/**
 * useReminders: the session, fencing and request semantics behind the
 * Reminders list, without App or any component.
 */
import { effectScope } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { useReminders } from '../src/composables/useReminders';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { Conversation, ConversationRef, PutReminder, Reminder } from '../src/lib/ipc/client';
import { deferred } from './helpers';

const target: ConversationRef = { accountId: 'fixture-account', conversationId: 'conv-01' };
const other: ConversationRef = { accountId: 'fixture-account', conversationId: 'conv-02' };
function row(id: string, patch: Partial<Reminder> = {}): Reminder {
  return { conversation: { accountId: 'fixture-account', conversationId: id }, subject: `S ${id}`, revision: 3, sourceMessageId: `${id}-m`, dueAt: null, condition: 'if_no_reply', phase: 'pending', ...patch };
}
function setup(initial: Reminder[] = []) {
  const fake = createBrowserFakeMailClient();
  const rows = [...initial];
  const listeners: Array<() => void> = [];
  const unsubscribe = vi.fn();
  vi.spyOn(fake, 'subscribe').mockImplementation(async (listener) => { listeners.push(listener); return unsubscribe; });
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => ({ conversation: c.conversation, subject: 'Saved', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing' }));
  const list = vi.fn(async () => structuredClone(rows));
  fake.reminders = { list, put, cancel: vi.fn() };
  const scope = effectScope();
  const model = scope.run(() => useReminders(fake))!;
  return { fake, rows, listeners, unsubscribe, put, list, model, scope };
}
let stop: (() => void) | null = null;
afterEach(() => { stop?.(); stop = null; });

describe('useReminders session', () => {
  it('counts a row in Pending only while it waits calmly; a row that fails leaves the count but stays in the tab', async () => {
    const { rows, listeners, model, scope } = setup([row('a'), row('b')]);
    stop = () => scope.stop();
    await model.activate();
    expect(model.counts.value.pending).toBe(2);
    expect(model.attentionCount.value).toBe(0);
    rows[1] = row('b', { phase: 'failed' });
    listeners[0]!();
    await flushPromises();
    expect(model.counts.value).toEqual({ pending: 1, returned: 0, history: 0 });
    expect(model.attentionCount.value).toBe(1);
    expect(model.displayed.value.map((r) => r.conversation.conversationId)).toEqual(['b', 'a']);
    model.destination.value = 'history';
    expect(model.attentionCount.value).toBe(0);
  });

  it('totals the rows that need attention whichever tab is selected', async () => {
    const { model, scope } = setup([row('a'), row('b', { phase: 'failed' }), row('c', { phase: 'removing' })]);
    stop = () => scope.stop();
    await model.activate();
    expect(model.attentionTotal.value).toBe(2);
    model.destination.value = 'history';
    expect(model.attentionCount.value).toBe(0);
    expect(model.attentionTotal.value).toBe(2);
  });

  it('loads on activate, follows live changes, and unsubscribes when deactivated', async () => {
    const { rows, listeners, unsubscribe, list, model, scope } = setup([row('a')]);
    stop = () => scope.stop();
    expect(model.loading.value).toBe(true);
    await model.activate();
    expect(model.loading.value).toBe(false);
    expect(model.rows.value.map((r) => r.conversation.conversationId)).toEqual(['a']);
    // Idempotent while live: one subscription, one load.
    await model.activate();
    expect(listeners).toHaveLength(1);
    expect(list).toHaveBeenCalledTimes(1);
    rows.push(row('b', { phase: 'returned' }));
    listeners[0]!();
    await flushPromises();
    expect(model.counts.value).toEqual({ pending: 1, returned: 1, history: 0 });
    model.deactivate();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    scope.stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('drops a list answer that lands after deactivation, and a subscription that settles late is stopped', async () => {
    const { fake, list, model, scope } = setup([row('a')]);
    stop = () => scope.stop();
    const late = deferred<Reminder[]>();
    list.mockReturnValueOnce(late.promise);
    const stopLate = vi.fn();
    const subscribe = deferred<() => void>();
    vi.mocked(fake.subscribe).mockReturnValueOnce(subscribe.promise);
    void model.activate();
    model.deactivate();
    subscribe.resolve(stopLate);
    late.resolve([row('stale')]);
    await flushPromises();
    expect(stopLate).toHaveBeenCalledTimes(1);
    expect(model.rows.value).toEqual([]);
  });

  it('keeps the selected tab across sessions but starts each session empty and loading', async () => {
    const { model, scope } = setup([row('a'), row('b', { phase: 'returned' })]);
    stop = () => scope.stop();
    await model.activate();
    model.destination.value = 'returned';
    expect(model.displayed.value.map((r) => r.conversation.conversationId)).toEqual(['b']);
    model.deactivate();
    const again = model.activate();
    expect(model.rows.value).toEqual([]);
    expect(model.loading.value).toBe(true);
    await again;
    expect(model.destination.value).toBe('returned');
  });
});

describe('useReminders picker', () => {
  it('prepares the requested conversation after the first load and selects Pending', async () => {
    const { fake, model, scope } = setup();
    stop = () => scope.stop();
    const detail = await fake.getConversation(target);
    model.destination.value = 'history';
    model.setTarget(target);
    expect(model.destination.value).toBe('pending');
    expect(model.source.value).toBeNull();
    await model.activate();
    expect(model.source.value).toMatchObject({ conversation: target, sourceMessageId: detail.messages.at(-1)!.id, revision: null, subject: detail.subject });
  });

  it('a changed target replaces the open picker with a clean one; the same target changes nothing', async () => {
    const { model, scope } = setup();
    stop = () => scope.stop();
    await model.activate();
    model.setTarget(target); await flushPromises();
    model.due.value = '2035-01-01T09:00:00Z'; model.someday.value = true; model.condition.value = 'regardless';
    const before = model.source.value;
    model.setTarget({ ...target }); await flushPromises();
    expect(model.source.value).toBe(before);
    expect(model.due.value).toBe('2035-01-01T09:00:00Z');
    model.setTarget(other); await flushPromises();
    expect(model.source.value?.conversation).toEqual(other);
    expect([model.due.value, model.someday.value, model.condition.value]).toEqual(['', false, 'if_no_reply']);
    model.setTarget(null);
    expect(model.source.value).toBeNull();
  });

  it('leaving the session closes the picker and clears the request, and a late preparation never reopens it', async () => {
    const { fake, model, scope } = setup();
    stop = () => scope.stop();
    await model.activate();
    const detail = await fake.getConversation(target);
    const pending = deferred<Conversation>();
    vi.spyOn(fake, 'getConversation').mockReturnValueOnce(pending.promise);
    model.setTarget(target);
    model.deactivate();
    pending.resolve(detail); await flushPromises();
    expect(model.source.value).toBeNull();
    expect(model.target.value).toBeNull();
    expect(model.busy.value).toBe(false);
  });

  it('sends the typed or preset time as one put payload and replays a lost ACK exactly', async () => {
    const { put, model, scope } = setup();
    stop = () => scope.stop();
    await model.activate();
    model.setTarget(target); await flushPromises();
    const at = model.presetList.value.find((preset) => preset.id === 'tomorrow')!.at;
    model.choosePreset(at);
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    model.submit(); await flushPromises();
    expect(model.retrying.value).toBe(true);
    expect(model.error.value).toContain('not acknowledged');
    // A second submit cannot start a new request while one is unresolved.
    model.submit(); await flushPromises();
    expect(put).toHaveBeenCalledTimes(1);
    model.retryOrRefresh(); await flushPromises();
    expect(put).toHaveBeenCalledTimes(2);
    expect(put.mock.calls[1]![0]).toEqual(put.mock.calls[0]![0]);
    expect(put.mock.calls[0]![0]).toMatchObject({ conversation: target, dueAt: at, condition: 'if_no_reply', expectedRevision: null });
    expect(model.retrying.value).toBe(false);
    expect(model.source.value).toBeNull();
  });

  it('Inspect durable state drops the retry and the picker and reloads', async () => {
    const { put, list, model, scope } = setup();
    stop = () => scope.stop();
    await model.activate();
    model.setTarget(target); await flushPromises();
    model.someday.value = true;
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    model.submit(); await flushPromises();
    const loads = list.mock.calls.length;
    model.inspectDurableState(); await flushPromises();
    expect(model.retrying.value).toBe(false);
    expect(model.source.value).toBeNull();
    expect(model.error.value).toBe('');
    expect(list.mock.calls.length).toBe(loads + 1);
  });

  it('cancel sends the row revision with a fresh request id', async () => {
    const { fake, model, scope } = setup([row('a', { revision: 5 })]);
    stop = () => scope.stop();
    vi.mocked(fake.reminders!.cancel).mockResolvedValue(row('a', { phase: 'cancelling' }));
    await model.activate();
    model.cancel(model.rows.value[0]!); await flushPromises();
    expect(fake.reminders!.cancel).toHaveBeenCalledWith({ conversation: { accountId: 'fixture-account', conversationId: 'a' }, expectedRevision: 5, requestId: expect.any(String) });
  });
});

describe('useReminders loadedOnce', () => {
  it('is false until the first list read succeeds, stays false after a failed read, and resets with each session', async () => {
    const { list, model, scope } = setup([row('a')]);
    stop = () => scope.stop();
    const gate = deferred<Reminder[]>();
    list.mockReturnValueOnce(gate.promise);
    const loaded = model.activate();
    expect(model.loadedOnce.value).toBe(false);
    gate.reject(new Error('offline'));
    await loaded;
    expect(model.loading.value).toBe(false);
    expect(model.error.value).toBe('Could not load local reminders. Retry refresh.');
    expect(model.loadedOnce.value).toBe(false);
    await model.refresh();
    expect(model.loadedOnce.value).toBe(true);
    // A later failed read keeps the rows and the flag: they were read.
    list.mockRejectedValueOnce(new Error('offline'));
    await model.refresh();
    expect(model.loadedOnce.value).toBe(true);
    model.deactivate();
    const second = deferred<Reminder[]>();
    list.mockReturnValueOnce(second.promise);
    const again = model.activate();
    expect(model.loadedOnce.value).toBe(false);
    second.resolve([]);
    await again;
    expect(model.loadedOnce.value).toBe(true);
  });

  it('announces only the tab name on a step before the first successful read, and the counts after', async () => {
    const { list, model, scope } = setup([row('a'), row('b', { phase: 'failed' }), row('c', { phase: 'returned' })]);
    stop = () => scope.stop();
    list.mockRejectedValueOnce(new Error('offline'));
    await model.activate();
    model.stepDestination(1); await flushPromises();
    expect(model.tabAnnouncement.value).toBe('Returned');
    model.stepDestination(1); await flushPromises();
    expect(model.tabAnnouncement.value).toBe('History');
    await model.refresh();
    model.stepDestination(-1); await flushPromises();
    expect(model.tabAnnouncement.value).toBe('Returned, 1 reminder');
    model.stepDestination(1); await flushPromises();
    expect(model.tabAnnouncement.value).toBe('History, no reminders');
  });
});

describe('useReminders action announcement', () => {
  it('names a cancel only after it resolved, from the phase it returned', async () => {
    const { fake, model, scope } = setup([row('a')]);
    stop = () => scope.stop();
    await model.activate();
    const cancel = vi.mocked(fake.reminders!.cancel);
    const gate = deferred<Reminder>();
    cancel.mockReturnValueOnce(gate.promise);
    model.cancel(model.rows.value[0]!); await flushPromises();
    expect(model.actionAnnouncement.value).toBe('');
    gate.resolve(row('a', { phase: 'cancelled' })); await flushPromises();
    expect(model.actionAnnouncement.value).toBe('Reminder cancelled');
    cancel.mockResolvedValueOnce(row('a', { phase: 'cancelling' }));
    model.cancel(model.rows.value[0]!); await flushPromises();
    expect(model.actionAnnouncement.value).toBe('Cancelling reminder');
  });

  it('names a failed cancel, a failed reschedule, and nothing for a new reminder', async () => {
    const { fake, put, model, scope } = setup([row('a')]);
    stop = () => scope.stop();
    await model.activate();
    vi.mocked(fake.reminders!.cancel).mockRejectedValueOnce({ kind: 'storage_unavailable' });
    model.cancel(model.rows.value[0]!); await flushPromises();
    expect(model.actionAnnouncement.value).toBe('Could not cancel reminder');
    model.retryOrRefresh(); await flushPromises();
    // The exact retry keeps its words: the cancel mock now resolves to undefined.
    expect(model.actionAnnouncement.value).toBe('Reminder cancelled');
    model.reschedule(model.rows.value[0]!);
    model.due.value = '2030-05-05T09:00:00Z';
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    model.submit(); await flushPromises();
    expect(model.actionAnnouncement.value).toBe('Could not reschedule reminder');
    put.mockResolvedValueOnce(row('a'));
    model.retryOrRefresh(); await flushPromises();
    expect(model.actionAnnouncement.value).toBe('Reminder rescheduled');
    model.deactivate();
    expect(model.actionAnnouncement.value).toBe('');
    await model.activate();
    model.setTarget(other); await flushPromises();
    model.due.value = '2030-05-05T09:00:00Z';
    model.submit(); await flushPromises();
    expect(put).toHaveBeenCalledTimes(3);
    expect(model.actionAnnouncement.value).toBe('');
  });
});
