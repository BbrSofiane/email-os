/**
 * Reminders list structure: compact context rows with a status word, quiet row
 * actions, preset times that fill the same `dueAt` the typed field fills (so
 * `put` payloads are unchanged), and the typed field behind Custom. The tabs
 * live in the app header; see reminders.context.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises } from '@vue/test-utils';
import { fullDateLabel } from '../src/lib/browsing-dates';
import { reminderPresets } from '../src/lib/reminder-presets';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { ConversationRef, PutReminder, Reminder, ReminderPhase } from '../src/lib/ipc/client';
import { deferred } from './helpers';
import { mountReminders } from './reminders.helpers';

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
    expect(a.get('[data-test="reminder-phase-pending"]').text()).toBe('Pending');
    expect(a.get('[data-test="reminder-condition"]').text()).toBe('Returns regardless of reply');
    // Revision is evidence for a title, never text.
    expect(a.get('.context-row-main').attributes('title')).toBe('Revision 3');
    expect(a.text()).not.toMatch(/revision/i);
    const b = panel.get('[data-test="reminder-row-b"]');
    expect(b.find('time').exists()).toBe(false);
    expect(b.get('.context-date').text()).toBe('Someday');
    expect(b.get('[data-test="reminder-phase-removing"]').text()).toBe('Removing…');
    expect(b.get('[data-test="reminder-phase-removing"]').classes()).toContain('tone-warn');
    expect(b.find('[data-test="reminder-condition"]').exists()).toBe(false);
    const c = panel.get('[data-test="reminder-row-c"]');
    expect(c.get('[data-test="reminder-phase-failed"]').text()).toBe('Failed');
    expect(c.get('[data-test="reminder-phase-failed"]').classes()).toContain('tone-fault');
    // The failed explanation is an exception and stays inline.
    expect(c.text()).toContain('Cancel does not override newer triage.');
    expect(c.find('button[aria-label="Cancel reminder and recover original inbox messages"]').exists()).toBe(true);
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

  it('shows the fixture disclosure once, with the rest in its title, and no landmark or heading', async () => {
    const { fake } = fixture();
    panel = show(fake).wrapper;
    await flushPromises();
    const note = panel.get('[data-test="reminders-coverage"]');
    expect(note.text()).toContain('Synthetic fixture only');
    expect(note.attributes('title')).toContain('New incoming mail stays in Inbox');
    expect(note.attributes('title')).toContain('while fully quit');
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
    const event = new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true });
    reschedule.element.dispatchEvent(event);
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
    expect(row.get('.context-row-actions button').attributes('aria-label')).toBe('Cancel reminder and recover original inbox messages');
  });
});

describe('Reminders picker', () => {
  it('names the mail by subject and keeps the ids out of the text', async () => {
    const { fake } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    const detail = await fake.getConversation(target);
    const form = panel.get('form');
    expect(form.get('.reminder-subject').text()).toBe(detail.subject);
    expect(form.text()).not.toContain('conv-01');
    expect(form.text()).not.toContain(detail.messages.at(-1)!.id);
    expect(form.get('.reminder-subject').attributes('title')).toContain('conv-01');
    expect(form.attributes('data-source-conversation')).toBe('conv-01');
  });

  it('offers Later today, Tomorrow, Next week and Someday, and Custom hides the typed field until asked', async () => {
    const { fake } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    expect(panel.findAll('.reminder-presets button').map((button) => button.text())).toEqual(['Later today', 'Tomorrow', 'Next week', 'Custom']);
    expect(panel.get('.reminder-someday').text()).toBe('Someday');
    expect(panel.find('input[type="text"]').exists()).toBe(false);
    const custom = panel.get('[data-test="reminder-custom"]');
    expect(custom.attributes('aria-expanded')).toBe('false');
    await custom.trigger('click');
    expect(custom.attributes('aria-expanded')).toBe('true');
    expect(panel.get('input[type="text"]').attributes('placeholder')).toBe('2030-11-03T09:00:00-05:00');
    // Nothing is chosen yet: scheduling is not offered with an empty time.
    expect(panel.get('button[type="submit"]').attributes('disabled')).toBeDefined();
  });

  it.each([
    ['later', 'laterToday'],
    ['tomorrow', 'tomorrow'],
    ['next-week', 'nextWeek'],
  ] as const)('the %s preset sends a real RFC3339 dueAt in the same put payload shape as the typed field', async (id, key) => {
    const { fake, put } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    const detail = await fake.getConversation(target);
    const expected = reminderPresets(NOW)[key]!;
    expect(expected).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00(Z|[+-]\d{2}:\d{2})$/);
    const button = panel.get(`[data-test="reminder-preset-${id}"]`);
    expect(button.attributes('title')).toBe(fullDateLabel(expected));
    await button.trigger('click');
    expect(button.attributes('aria-pressed')).toBe('true');
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put).toHaveBeenCalledTimes(1);
    expect(put.mock.calls[0]![0]).toEqual({
      conversation: target, sourceMessageId: detail.messages.at(-1)!.id, expectedRevision: null,
      dueAt: expected, condition: 'if_no_reply', requestId: expect.any(String),
    });
    expect(Object.keys(put.mock.calls[0]![0]).sort()).toEqual(['condition', 'conversation', 'dueAt', 'expectedRevision', 'requestId', 'sourceMessageId']);
    // A preset is a real instant at 09:00 local (or the rounded quarter hour for Later today).
    const at = new Date(expected);
    if (id !== 'later') expect(at.getHours()).toBe(9);
    else expect(at.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('Someday still sends dueAt null; a preset after Someday replaces it', async () => {
    const { fake, put } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    await panel.get('input[type="checkbox"]').setValue(true);
    expect(panel.find('[data-test="reminder-custom"]').exists()).toBe(false);
    await panel.get('[data-test="reminder-preset-tomorrow"]').trigger('click');
    expect((panel.get('input[type="checkbox"]').element as HTMLInputElement).checked).toBe(false);
    await panel.get('input[type="checkbox"]').setValue(true);
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[0]![0].dueAt).toBeNull();
  });

  it('opens Custom by itself for a saved time that is not a preset, so saved data is never hidden', async () => {
    const { fake, put } = fixture([reminder('conv-01', 'pending', { dueAt: '2030-11-03T09:00:00-05:00' })]);
    panel = show(fake).wrapper;
    await flushPromises();
    await panel.findAll('button').find((button) => button.text() === 'Reschedule')!.trigger('click');
    expect((panel.get('input[type="text"]').element as HTMLInputElement).value).toBe('2030-11-03T09:00:00-05:00');
    expect(panel.get('[data-test="reminder-custom"]').attributes('disabled')).toBeDefined();
    expect(panel.get('h2').text()).toBe('Reschedule');
    expect(panel.get('.reminder-subject').text()).toBe('Subject conv-01');
    await panel.get('form').trigger('submit'); await flushPromises();
    expect(put.mock.calls[0]![0]).toMatchObject({ expectedRevision: 3, dueAt: '2030-11-03T09:00:00-05:00', conversation: { conversationId: 'conv-01' } });
  });

  it('keeps exact-retry semantics for a preset: the lost-ACK retry replays the identical request', async () => {
    const { fake, put } = fixture();
    panel = show(fake, { target }).wrapper;
    await flushPromises();
    put.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await panel.get('[data-test="reminder-preset-tomorrow"]').trigger('click');
    await panel.get('form').trigger('submit'); await flushPromises();
    const first = put.mock.calls[0]![0];
    const retry = panel.findAll('button').find((button) => button.text() === 'Retry exact request')!;
    await retry.trigger('click'); await flushPromises();
    expect(put.mock.calls[1]![0]).toEqual(first);
    expect(panel.findAll('button').some((button) => button.text() === 'Inspect durable state')).toBe(false);
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
    expect(described(a)).toEqual(['Pending', fullDateLabel('2030-01-01T00:00:00Z'), 'Returns regardless of reply']);
    // No condition line and no due time: only what is on the row.
    expect(described(panel.get('[data-test="reminder-row-b"] .context-row-main'))).toEqual(['Pending', 'Someday']);
  });

  it('ties a failed row to Failed, its due time and the failed note, whatever its caption says', async () => {
    const { fake } = fixture([reminder('c', 'failed'), reminder('d', 'pending')]);
    panel = show(fake).wrapper;
    await flushPromises();
    const c = panel.get('[data-test="reminder-row-c"] .context-row-main');
    const words = described(c);
    expect(words[0]).toBe('Failed');
    expect(words[1]).toBe(fullDateLabel('2030-01-01T00:00:00Z'));
    expect(words[2]).toContain('A mailbox change failed or newer triage superseded it');
    expect(words).toHaveLength(3);
    // The caption is a presentation item; the state is not left to it.
    expect(panel.get('[data-test="context-group"]').attributes('role')).toBe('presentation');
    expect(described(panel.get('[data-test="reminder-row-d"] .context-row-main'))).toEqual(['Pending', fullDateLabel('2030-01-01T00:00:00Z')]);
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
    await panel.get('[data-test="reminder-preset-tomorrow"]').trigger('click');
    await panel.get('form').trigger('submit'); await flushPromises();
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
