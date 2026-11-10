/**
 * Reminders drawer structure: real tabs with counts, compact rows with a status
 * word, and quiet actions. Scheduling itself (the picker) is covered by
 * reminders.component.test.ts and reminder-picker.component.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import RemindersPanel from '../src/components/RemindersPanel.vue';
import { fullDateLabel } from '../src/lib/browsing-dates';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { PutReminder, Reminder, ReminderPhase } from '../src/lib/ipc/client';

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

let panel: VueWrapper | null = null;
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'], now: NOW }); });
afterEach(() => { panel?.unmount(); panel = null; vi.useRealTimers(); });
const tabs = () => panel!.findAll('[role="tab"]');

describe('Reminders tabs', () => {
  it('are a real tablist titled Pending, Returned and History with counts of the loaded rows', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'removing'), reminder('c', 'returned'), reminder('d', 'cancelled'), reminder('e', 'suppressed'), reminder('f', 'failed')]);
    panel = mount(RemindersPanel, { props: { client: fake, target: null } });
    await flushPromises();
    expect(panel.find('[role="tablist"]').exists()).toBe(true);
    expect(tabs().map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending 3', 'Returned 1', 'History 2']);
    expect(tabs().map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs().map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(panel.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(tabs()[0]!.attributes('id'));
    // Counts match what each tab shows.
    expect(panel.findAll('li.reminder-row')).toHaveLength(3);
    await tabs()[2]!.trigger('click');
    expect(panel.findAll('li.reminder-row')).toHaveLength(2);
  });

  it('move with ArrowLeft/ArrowRight, Home and End, select what they focus and report the destination', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('c', 'returned')]);
    panel = mount(RemindersPanel, { props: { client: fake, target: null }, attachTo: document.body });
    await flushPromises();
    await tabs()[0]!.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(tabs()[1]!.attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs()[1]!.element);
    await tabs()[1]!.trigger('keydown', { key: 'End' });
    await flushPromises();
    expect(tabs()[2]!.attributes('aria-selected')).toBe('true');
    await tabs()[2]!.trigger('keydown', { key: 'ArrowRight' });
    await flushPromises();
    expect(tabs()[0]!.attributes('aria-selected')).toBe('true');
    await tabs()[0]!.trigger('keydown', { key: 'ArrowLeft' });
    await flushPromises();
    expect(tabs()[2]!.attributes('aria-selected')).toBe('true');
    expect(panel.emitted('destinationChange')!.map(([value]) => value)).toEqual(['returned', 'history', 'pending', 'history']);
    // Modified arrows are not the tabs'.
    await tabs()[2]!.trigger('keydown', { key: 'ArrowLeft', shiftKey: true });
    expect(tabs()[2]!.attributes('aria-selected')).toBe('true');
  });
});

describe('Reminders rows', () => {
  it('show the subject, a due time or Someday, a one-word phase, and only the condition that is not the default', async () => {
    const { fake } = fixture([
      reminder('a', 'pending', { condition: 'regardless' }),
      reminder('b', 'removing', { dueAt: null }),
      reminder('c', 'failed'),
    ]);
    panel = mount(RemindersPanel, { props: { client: fake, target: null } });
    await flushPromises();
    const a = panel.get('[data-test="reminder-row-pending"]');
    expect(a.get('.drawer-subject').text()).toBe('Subject a');
    expect(a.get('time').text()).toBe(fullDateLabel('2030-01-01T00:00:00Z'));
    expect(a.get('[data-test="reminder-phase-pending"]').text()).toBe('Waiting');
    expect(a.get('[data-test="reminder-condition"]').text()).toBe('Returns regardless of reply');
    // Revision is evidence for a title, never text.
    expect(a.get('.drawer-row-main').attributes('title')).toBe('Revision 3');
    expect(a.text()).not.toMatch(/revision/i);
    const b = panel.get('[data-test="reminder-row-removing"]');
    expect(b.find('time').exists()).toBe(false);
    expect(b.get('.drawer-date').text()).toBe('Someday');
    expect(b.get('[data-test="reminder-phase-removing"]').text()).toBe('Hiding from Inbox');
    expect(b.get('[data-test="reminder-phase-removing"]').classes()).toContain('tone-warn');
    expect(b.find('[data-test="reminder-condition"]').exists()).toBe(false);
    const c = panel.get('[data-test="reminder-row-failed"]');
    expect(c.get('[data-test="reminder-phase-failed"]').text()).toBe('Needs attention');
    expect(c.get('[data-test="reminder-phase-failed"]').classes()).toContain('tone-fault');
    // The failed explanation is an exception and stays inline.
    expect(c.text()).toContain('Cancel does not override newer triage.');
    expect(c.find('button[aria-label="Cancel and show original inbox messages"]').exists()).toBe(true);
  });

  it('makes the subject the Open button and keeps Reschedule and Cancel reminder as quiet ghosts', async () => {
    const { fake } = fixture([reminder('a', 'pending')]);
    panel = mount(RemindersPanel, { props: { client: fake, target: null } });
    await flushPromises();
    const open = panel.get('.drawer-row-main');
    expect(open.text()).toBe('Open Subject a');
    await open.trigger('click');
    expect(panel.emitted('open')![0]).toEqual([{ accountId: 'fixture-account', conversationId: 'a' }]);
    const quiet = panel.findAll('.drawer-row-actions button');
    expect(quiet.map((button) => button.text())).toEqual(['Reschedule', 'Cancel reminder']);
    expect(quiet.every((button) => button.classes().includes('drawer-quiet'))).toBe(true);
  });

  it('shows the device-local note once, with the rest in its title, and no landmark or heading', async () => {
    const { fake } = fixture();
    panel = mount(RemindersPanel, { props: { client: fake, target: null } });
    await flushPromises();
    const note = panel.get('[role="note"]');
    expect(note.text()).toContain('Saved on this device');
    expect(note.attributes('title')).toContain('New incoming mail stays visible');
    expect(note.attributes('title')).toContain('Overdue reminders are checked when Email OS starts');
    expect(panel.element.tagName).toBe('DIV');
    expect(panel.find('section, aside, h1, h2, nav').exists()).toBe(false);
  });

  it('moves between row buttons with J/K and arrows, leaving the quiet buttons to native keys', async () => {
    const { fake } = fixture([reminder('a', 'pending'), reminder('b', 'pending')]);
    panel = mount(RemindersPanel, { props: { client: fake, target: null }, attachTo: document.body });
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
