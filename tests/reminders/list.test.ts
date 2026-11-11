/**
 * Reminders list structure: compact context rows with a status word, quiet row
 * actions, and the shared ReminderPicker (suggestions plus a typed time) that
 * sits behind Remind me and Reschedule. The tabs live in the app header; see
 * reminders.context.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { press } from '../helpers';
import { fullDateLabel } from '../../src/lib/browsing-dates';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import type { ConversationRef, PutReminder, Reminder, ReminderPhase } from '../../src/lib/ipc/client';
import { deferred } from '../helpers';
import ReminderPicker from '../../src/components/ReminderPicker.vue';
import { mountReminders, pickTime, submitPicker } from './helpers';

const target: ConversationRef = { accountId: 'fixture-account', conversationId: 'conv-01' };
const NOW = new Date('2026-11-06T15:07:00Z');

function reminder(id: string, phase: ReminderPhase, patch: Partial<Reminder> = {}): Reminder {
  return {
    conversation: { accountId: 'fixture-account', conversationId: id },
    subject: `Subject ${id}`, revision: 3, sourceMessageId: `${id}-m1`, dueAt: '2030-01-01T00:00:00Z',
    condition: 'if_no_reply', phase, ...patch,
  };
}

function fixture(initial: Reminder[] = []) {
  const fake = createBrowserFakeMailClient();
  const rows: Reminder[] = [...initial];
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => ({
    conversation: c.conversation, subject: 'Saved', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing',
  }));
  fake.reminders = { list: vi.fn(async () => structuredClone(rows)), put, cancel: vi.fn(async (c) => ({ ...rows[0]!, revision: c.expectedRevision + 1, phase: 'cancelling' as const })) };
  return { fake, rows, put };
}

type Mounted = ReturnType<typeof mountReminders>;
let mounted: Mounted | null = null;
let panel: Mounted['wrapper'] | null = null;
function show(client: ReturnType<typeof createBrowserFakeMailClient>, options: Parameters<typeof mountReminders>[1] = {}) {
  mounted = mountReminders(client, options);
  panel = mounted.wrapper;
  return mounted;
}
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { mounted?.unmount(); mounted = null; panel = null; vi.useRealTimers(); document.body.innerHTML = ''; });

describe('Reminders rows', () => {
  it('show the subject, a due time or Someday, a one-word phase, and only the condition that is not the default', async () => {
    const { fake } = fixture([
      reminder('a', 'pending', { condition: 'regardless' }),
      reminder('b', 'removing', { dueAt: null }),
      reminder('c', 'failed'),
    ]);
    panel = show(fake).wrapper;
    await flushPromises();
    const a = panel.get('[data-test="reminder-row-a"]');
    expect(a.get('.context-subject').text()).toBe('Subject a');
    expect(a.get('time').text()).toBe(fullDateLabel('2030-01-01T00:00:00Z'));
    expect(a.get('[data-test="reminder-phase-pending"]').text()).toBe('Waiting');
    expect(a.get('[data-test="reminder-condition"]').text()).toBe('Returns regardless of reply');
    // Revision is evidence for a title, never text.
    expect(a.get('.context-row-main').attributes('title')).toBe('Revision 3');
    expect(a.text()).not.toMatch(/revision/i);
    const b = panel.get('[data-test="reminder-row-b"]');
    expect(b.find('time').exists()).toBe(false);
    expect(b.get('.context-date').text()).toBe('Someday');
    expect(b.get('[data-test="reminder-phase-removing"]').text()).toBe('Hiding from Inbox');
    expect(b.get('[data-test="reminder-phase-removing"]').classes()).toContain('tone-warn');
    expect(b.find('[data-test="reminder-condition"]').exists()).toBe(false);
    const c = panel.get('[data-test="reminder-row-c"]');
    expect(c.get('[data-test="reminder-phase-failed"]').text()).toBe('Needs attention');
    expect(c.get('[data-test="reminder-phase-failed"]').classes()).toContain('tone-fault');
    // The failed explanation is an exception and stays inline.
    expect(c.text()).toContain('Cancel does not override newer triage.');
    expect(c.find('button[aria-label="Cancel and show original inbox messages"]').exists()).toBe(true);
  });

  it('makes the subject the Open button and keeps Reschedule and Cancel reminder as quiet ghosts', async () => {
    const { fake } = fixture([reminder('a', 'pending')]);
    panel = show(fake).wrapper;
    await flushPromises();
    const open = panel.get('.context-row-main');
    expect(open.text()).toBe('Open Subject a');
    await open.trigger('click');
    expect(panel!.emitted('open')![0]).toEqual([{ accountId: 'fixture-account', conversationId: 'a' }]);
    const quiet = panel.findAll('.context-row-actions button');
    expect(quiet.map((button) => button.text())).toEqual(['Reschedule', 'Cancel reminder']);
    expect(quiet.every((button) => button.classes().includes('drawer-quiet'))).toBe(true);
  });

  it('shows the device-local note once, with the rest in its title, and no landmark or heading', async () => {
    const { fake } = fixture();
    panel = show(fake).wrapper;
    await flushPromises();
    const note = panel.get('[data-test="reminders-coverage"]');
    expect(note.text()).toContain('Saved on this device');
    expect(note.attributes('title')).toContain('New incoming mail stays visible');
    expect(note.attributes('title')).toContain('Overdue reminders are checked when Email OS starts');
    expect(panel.element.tagName).toBe('DIV');
    expect(panel.find('section, aside, h1, h2, nav').exists()).toBe(false);
  });

  it('moves between row buttons with J/K and arrows, leaving the quiet buttons to native keys', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'pending')]);
    panel = show(fake, { attachTo: document.body }).wrapper;
    await flushPromises();
    const [first, second] = panel.findAll('[data-drawer-row]');
    expect([first!.attributes('tabindex'), second!.attributes('tabindex')]).toEqual(['0', '-1']);
    (first!.element as HTMLElement).focus();
    await first!.trigger('keydown', { key: 'j' });
    expect(document.activeElement).toBe(second!.element);
    await second!.trigger('keydown', { key: 'ArrowUp' });
    expect(document.activeElement).toBe(first!.element);
    const reschedule = panel.findAll('button').find((button) => button.text() === 'Reschedule')!;
    (reschedule.element as HTMLElement).focus();
    const event = press('j', { bubbles: true, cancelable: true }, reschedule.element);
    expect(event.defaultPrevented).toBe(false);
    expect(document.activeElement).toBe(reschedule.element);
  });
});

describe('Reminders Needs attention group', () => {
  const captions = () => panel!.findAll('[data-test="context-group"]').map((el) => el.text());
  const order = () => panel!.findAll('li[data-test^="reminder-row-"]').map((el) => el.attributes('data-test'));

  it('lists failed rows, then in-flight rows, before the calm pending rows, under one caption with its own count', async () => {
    const { fake } = fixture([
      reminder('a', 'pending'),
      reminder('b', 'removing'),
      reminder('c', 'pending'),
      reminder('d', 'failed'),
      reminder('e', 'returned'),
    ]);
    const { model } = show(fake);
    await flushPromises();
    expect(captions()).toEqual(['Needs attention 2', 'Pending 2']);
    expect(order()).toEqual(['reminder-row-d', 'reminder-row-b', 'reminder-row-a', 'reminder-row-c']);
    expect(panel!.findAll('li[data-test^="reminder-row-"]').map((el) => el.get('.context-subject').text())).toEqual(['Subject d', 'Subject b', 'Subject a', 'Subject c']);
    // Captions are not rows: one list, rows only in listitems. The second caption ends the attention group.
    const items = [...panel!.get('ul').element.children];
    expect(items.map((el) => el.getAttribute('role'))).toEqual(['presentation', 'listitem', 'listitem', 'presentation', 'listitem', 'listitem']);
    expect(panel!.findAll('[role="listitem"]')).toHaveLength(4);
    expect(model.attentionCount.value).toBe(2);
    // J/K keep moving across the caption: the caption is no row stop.
    expect(panel!.findAll('[data-drawer-row]')).toHaveLength(4);
  });

  it('counts only phase pending in the tab, and keeps failed and removing rows in the tab', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'removing'), reminder('c', 'failed'), reminder('d', 'returning'), reminder('e', 'cancelling'), reminder('f', 'returned'), reminder('g', 'cancelled')]);
    const { model } = show(fake);
    await flushPromises();
    expect(model.counts.value).toEqual({ pending: 1, returned: 1, history: 1 });
    expect(model.displayed.value).toHaveLength(5);
    expect(captions()).toEqual(['Needs attention 4', 'Pending 1']);
  });

  it('shows no caption when nothing needs attention, and none in the other tabs', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'pending'), reminder('c', 'returned'), reminder('d', 'cancelled')]);
    const { model } = show(fake);
    await flushPromises();
    expect(captions()).toEqual([]);
    expect(panel!.find('[role="presentation"]').exists()).toBe(false);
    expect(model.attentionCount.value).toBe(0);
    model.destination.value = 'returned'; await flushPromises();
    expect(captions()).toEqual([]);
    model.destination.value = 'history'; await flushPromises();
    expect(captions()).toEqual([]);
  });

  it('shows the caption alone when every pending-tab row needs attention', async () => {
    const { fake } = fixture([reminder('a', 'failed')]);
    show(fake);
    await flushPromises();
    // One group only: no second caption.
    expect(captions()).toEqual(['Needs attention 1']);
    expect(panel!.find('[data-test="reminders-empty"]').exists()).toBe(false);
  });

  it('gives each row a test id of its own, even when phases repeat', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'pending'), reminder('c', 'failed')]);
    show(fake);
    await flushPromises();
    expect(order()).toEqual(['reminder-row-c', 'reminder-row-a', 'reminder-row-b']);
  });

  it('names what is known on a failed row, claims no cause, and offers Cancel only', async () => {
    const { fake } = fixture([reminder('a', 'failed')]);
    show(fake);
    await flushPromises();
    const row = panel!.get('[data-test="reminder-row-a"]');
    const note = row.get('.context-row-note');
    expect(note.classes()).toContain('tone-fault');
    expect(note.text()).toBe('A mailbox change failed or newer triage superseded it; which one is not recorded. Cancel does not override newer triage.');
    expect(row.findAll('.context-row-actions button').map((button) => button.text())).toEqual(['Cancel reminder']);
    expect(row.get('.context-row-actions button').attributes('aria-label')).toBe('Cancel and show original inbox messages');
  });
});

describe('Reminders picker', () => {
  it('hosts the shared picker for the conversation, names it by subject, and keeps the ids out of the text', async () => {
    const { fake } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    const detail = await fake.getConversation(target);
    const form = panel.get('[data-test="reminder-form"]');
    expect(form.get('h2').text()).toBe('Remind me');
    expect(panel.findComponent(ReminderPicker).exists()).toBe(true);
    expect(form.text()).toContain(detail.subject);
    expect(form.text()).not.toContain('conv-01');
    expect(form.text()).not.toContain(detail.messages.at(-1)!.id);
    expect(form.attributes('data-source-conversation')).toBe('conv-01');
    expect(form.attributes('data-source-message')).toBe(detail.messages.at(-1)!.id);
  });

  it('arms Schedule reminder only after the picker chose a time, and sends that time in the usual put payload', async () => {
    const { fake, put } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    const detail = await fake.getConversation(target);
    const schedule = () => panel!.findAll('button').find((button) => button.text() === 'Schedule reminder')!;
    expect(schedule().attributes('disabled')).toBeDefined();
    await pickTime(panel);
    expect(schedule().attributes('disabled')).toBeUndefined();
    expect(panel.get('.chosen-time').text()).toContain('2035');
    await submitPicker(panel);
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toEqual({
      conversation: target, sourceMessageId: detail.messages.at(-1)!.id, expectedRevision: null,
      dueAt: '2035-11-03T01:30:00-05:00', condition: 'if_no_reply', requestId: expect.any(String),
    });
    expect(Object.keys(put.mock.calls[0]![0]).sort()).toEqual(['condition', 'conversation', 'dueAt', 'expectedRevision', 'requestId', 'sourceMessageId']);
  });

  it('Someday sends dueAt null and the chosen return condition', async () => {
    const { fake, put } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    await panel.findAll('[aria-label="Suggested reminder times"] [role="option"]').find((option) => option.text().includes('Someday'))!.trigger('click');
    await panel.get('select').setValue('regardless');
    await submitPicker(panel);
    expect(put.mock.calls[0]![0]).toMatchObject({ dueAt: null, condition: 'regardless' });
  });

  it('Reschedule shows the saved time in the picker, names the row, and keeps an untouched save exact', async () => {
    const { fake, put } = fixture([reminder('conv-01', 'pending', { dueAt: '2999-11-03T09:00:00-05:00' })]);
    panel = show(fake).wrapper;
    await flushPromises();
    await panel.findAll('button').find((button) => button.text() === 'Reschedule')!.trigger('click');
    expect((panel.get('#reminder-time-input').element as HTMLInputElement).value).toContain('November 3, 2999');
    expect(panel.get('[data-test="reminder-form"] h2').text()).toBe('Reschedule reminder');
    expect(panel.get('[data-reminder-picker]').text()).toContain('Subject conv-01');
    await submitPicker(panel);
    expect(put.mock.calls[0]![0]).toMatchObject({ expectedRevision: 3, dueAt: '2999-11-03T09:00:00-05:00', conversation: { conversationId: 'conv-01' } });
  });

  it('keeps exact-retry semantics: the lost-ACK retry replays the identical request', async () => {
    const { fake, put } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await pickTime(panel);
    await submitPicker(panel);
    const first = put.mock.calls[0]![0];
    const retry = panel.findAll('button').find((button) => button.text() === 'Retry exact request')!;
    await retry.trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(first);
    expect(panel.findAll('button').some((button) => button.text() === 'Inspect saved state')).toBe(false);
  });

  it('keeps the picker open and focused while the request cannot be dismissed, and closes it on Escape otherwise', async () => {
    const { fake, put } = fixture();
    const model = show(fake, { target, attachTo: document.body }).model;
    panel = mounted!.wrapper;
    await flushPromises();
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await pickTime(panel);
    await submitPicker(panel);
    expect(model.dismissBlocked.value).toBe(true);
    await panel.get('#reminder-time-input').trigger('keydown', { key: 'Escape' });
    expect(panel.find('[data-test="reminder-form"]').exists()).toBe(true);
    await panel.findAll('button').find((button) => button.text() === 'Inspect saved state')!.trigger('click'); await flushPromises();
    expect(panel.find('[data-test="reminder-form"]').exists()).toBe(false);
  });
});

describe('Reminders row descriptions', () => {
  /** The text of the elements an open button's aria-describedby points at. */
  const described = (button: { attributes: (name: string) => string | undefined }): string[] =>
    (button.attributes('aria-describedby') ?? '').split(' ').filter(Boolean)
      .map((id) => panel!.element.querySelector(`[id="${id}"]`)?.textContent?.trim() ?? `MISSING ${id}`);

  it('ties a pending row to its phase, due time and condition', async () => {
    const { fake } = fixture([reminder('a', 'pending', { condition: 'regardless' }), reminder('b', 'pending', { dueAt: null })]);
    panel = show(fake).wrapper;
    await flushPromises();
    const a = panel.get('[data-test="reminder-row-a"] .context-row-main');
    expect(a.text()).toBe('Open Subject a');
    expect(described(a)).toEqual(['Waiting', fullDateLabel('2030-01-01T00:00:00Z'), 'Returns regardless of reply']);
    // No condition line and no due time: only what is on the row.
    expect(described(panel.get('[data-test="reminder-row-b"] .context-row-main'))).toEqual(['Waiting', 'Someday']);
  });

  it('ties a failed row to Needs attention, its due time and the failed note, whatever its caption says', async () => {
    const { fake } = fixture([reminder('c', 'failed'), reminder('d', 'pending')]);
    panel = show(fake).wrapper;
    await flushPromises();
    const c = panel.get('[data-test="reminder-row-c"] .context-row-main');
    const words = described(c);
    expect(words[0]).toBe('Needs attention');
    expect(words[1]).toBe(fullDateLabel('2030-01-01T00:00:00Z'));
    expect(words[2]).toContain('A mailbox change failed or newer triage superseded it');
    expect(words).toHaveLength(3);
    // The caption is a presentation item; the state is not left to it.
    expect(panel.get('[data-test="context-group"]').attributes('role')).toBe('presentation');
    expect(described(panel.get('[data-test="reminder-row-d"] .context-row-main'))).toEqual(['Waiting', fullDateLabel('2030-01-01T00:00:00Z')]);
  });

  it('gives every row its own ids', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'pending')]);
    panel = show(fake).wrapper;
    await flushPromises();
    const ids = panel.findAll('.context-row-main').flatMap((button) => (button.attributes('aria-describedby') ?? '').split(' '));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
  });
});

describe('Reminders action status', () => {
  const status = () => panel!.get('[data-test="reminders-action-status"]');
  const cancelButton = () => panel!.findAll('button').find((button) => button.text() === 'Cancel reminder')!;

  it('is a polite, empty status line until an action resolves', async () => {
    const { fake } = fixture([reminder('a', 'pending')]);
    panel = show(fake).wrapper;
    await flushPromises();
    expect(status().attributes('role')).toBe('status');
    expect(status().attributes('aria-live')).toBe('polite');
    expect(status().classes()).toContain('visually-hidden');
    expect(status().text()).toBe('');
  });

  it('says "Reminder cancelled" only after Cancel reminder resolved as cancelled, and "Cancelling reminder" while it still moves', async () => {
    const { fake } = fixture([reminder('a', 'pending')]);
    const gate = deferred<Reminder>();
    vi.mocked(fake.reminders!.cancel).mockReturnValueOnce(gate.promise);
    panel = show(fake).wrapper;
    await flushPromises();
    await cancelButton().trigger('click'); await flushPromises();
    // Not resolved yet: nothing is claimed.
    expect(status().text()).toBe('');
    gate.resolve(reminder('a', 'cancelled'));
    await flushPromises();
    expect(status().text()).toBe('Reminder cancelled');
    vi.mocked(fake.reminders!.cancel).mockResolvedValueOnce(reminder('a', 'cancelling'));
    await cancelButton().trigger('click'); await flushPromises();
    expect(status().text()).toBe('Cancelling reminder');
  });

  it('says "Could not cancel reminder" when the cancel fails, beside the existing alert', async () => {
    const { fake } = fixture([reminder('a', 'failed')]);
    vi.mocked(fake.reminders!.cancel).mockRejectedValueOnce({ kind: 'storage_unavailable' });
    panel = show(fake).wrapper;
    await flushPromises();
    await cancelButton().trigger('click'); await flushPromises();
    expect(status().text()).toBe('Could not cancel reminder');
    expect(panel.get('[data-test="reminders-error"]').text()).toContain('Reminder change was not acknowledged');
  });

  it('says "Reminder rescheduled" after Save new time resolves, and a failure after a lost ACK and its retry', async () => {
    const { fake, put } = fixture([reminder('a', 'pending')]);
    panel = show(fake).wrapper;
    await flushPromises();
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await panel.findAll('button').find((button) => button.text() === 'Reschedule')!.trigger('click');
    await pickTime(panel);
    await submitPicker(panel);
    expect(status().text()).toBe('Could not reschedule reminder');
    await panel.findAll('button').find((button) => button.text() === 'Retry exact request')!.trigger('click'); await flushPromises();
    expect(status().text()).toBe('Reminder rescheduled');
  });
});

describe('Reminders before the first successful read', () => {
  it('shows the load error and no "No pending reminders." beside it, then the empty line after a retry succeeds', async () => {
    const { fake } = fixture();
    vi.mocked(fake.reminders!.list).mockRejectedValueOnce(new Error('offline'));
    panel = show(fake).wrapper;
    await flushPromises();
    expect(panel.get('[data-test="reminders-error"]').text()).toBe('Could not load local reminders. Retry refresh.');
    expect(panel.find('[data-test="reminders-empty"]').exists()).toBe(false);
    await panel.get('[data-test="reminders-refresh"]').trigger('click'); await flushPromises();
    expect(panel.get('[data-test="reminders-empty"]').text()).toBe('No pending reminders.');
  });
});
