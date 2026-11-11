/**
 * Reminders as a list context (not a drawer): entries, header tabs, Back to the
 * exact row, the picker from `h`, inert mailbox shortcuts, and the
 * transport gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import ReaderView from '../src/components/ReaderView.vue';
import RemindersList from '../src/components/RemindersList.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { ConversationRef, PutReminder, Reminder, ReminderPhase } from '../src/lib/ipc/client';
import { deferred, mountApp, press, useGmailMode } from './helpers';

let app: VueWrapper | null = null;
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; });

const ref = (id: string): ConversationRef => ({ accountId: 'fixture-account', conversationId: id });
function reminder(id: string, phase: ReminderPhase, patch: Partial<Reminder> = {}): Reminder {
  return { conversation: ref(id), subject: `Reminder ${id}`, revision: 2, sourceMessageId: `${id}-m1`, dueAt: '2030-01-01T00:00:00Z', condition: 'if_no_reply', phase, ...patch };
}
async function mountRemindersContext(rows: Reminder[] = [reminder('conv-02', 'pending'), reminder('conv-03', 'pending'), reminder('conv-04', 'returned')]) {
  const fake = createBrowserFakeMailClient();
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => ({ conversation: c.conversation, subject: 'Saved', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing' }));
  fake.reminders = { list: vi.fn(async () => structuredClone(rows)), put, cancel: vi.fn() };
  app = mountApp(fake, 'native', { attachTo: document.body });
  await flushPromises();
  return { fake, put, w: app };
}
const title = (w: VueWrapper) => w.get('[data-test="inbox-title"]').text();
const tabs = (w: VueWrapper) => w.findAll('[role="tab"]');
const rowButtons = (w: VueWrapper) => w.findAll('[data-drawer-row]');

describe('entering and leaving the Reminders context', () => {
  it('G then H and the header glyph enter it; the h1, the header tabs and the active glyph name it', async () => {
    const { w } = await mountRemindersContext();
    const glyph = w.get('[data-test="reminders-trigger"]');
    expect(glyph.attributes('title')).toBe('Reminders (G then H)');
    expect(glyph.attributes('aria-current')).toBeUndefined();
    press('g', { bubbles: true, cancelable: true }, window); await flushPromises(); press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(w)).toBe('Reminders');
    expect(w.find('[data-test="inbox-title"]').classes()).not.toContain('visually-hidden');
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(glyph.attributes('aria-current')).toBe('page');
    // The Inbox split strip gives way to the list's sections.
    expect(w.find('[data-test="split-inbox"]').exists()).toBe(false);
    expect(w.get('[role="tablist"]').attributes('aria-label')).toBe('Reminder membership');
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending 2', 'Returned 1', 'History 0']);
    expect(w.get('[data-test="reminders-coverage"]').text()).toContain('Saved on this device');
    expect(rowButtons(w)).toHaveLength(2);
    // The glyph is the way back out too: Back is on the header.
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(glyph.attributes('aria-current')).toBeUndefined();
    expect(w.find('[data-test="split-inbox"]').exists()).toBe(true);
    // And the glyph enters it again.
    await glyph.trigger('click'); await flushPromises();
    expect(title(w)).toBe('Reminders');
  });

  it('Escape returns to the Inbox row that was current', async () => {
    const { w } = await mountRemindersContext();
    press('j', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    expect(w.findComponent(RemindersList).exists()).toBe(true);
    press('Escape', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(w.findComponent(RemindersList).exists()).toBe(false);
    const row = w.get('[data-test="conversation-row-conv-02"]');
    expect(row.attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
  });

  it('puts focus on the current reminder row on entry and keeps G chords working from it', async () => {
    const { w } = await mountRemindersContext();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const first = rowButtons(w)[0]!;
    expect(document.activeElement).toBe(first.element);
    press('g', { bubbles: true, cancelable: true }, first.element); await flushPromises(); press('e', { bubbles: true, cancelable: true }, first.element); await flushPromises();
    expect(title(w)).toBe('Cached Done');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Reminders');
    expect(w.findComponent(RemindersList).exists()).toBe(true);
  });

  it('shows no entry and ignores G then H without a reminders transport; Gmail mode with one has the entry', async () => {
    const plain = createBrowserFakeMailClient();
    delete plain.reminders;
    app = mountApp(plain, 'native', { attachTo: document.body });
    await flushPromises();
    expect(app.find('[data-test="reminders-trigger"]').exists()).toBe(false);
    press('g', { bubbles: true, cancelable: true }, window); await flushPromises(); press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(app)).toBe('Inbox');
    app.unmount();
    const gmail = createBrowserFakeMailClient();
    gmail.reminders = { list: vi.fn(async () => []), put: vi.fn(), cancel: vi.fn() };
    useGmailMode(gmail);
    app = mountApp(gmail, 'native', { attachTo: document.body });
    await flushPromises();
    expect(app.find('[data-test="reminders-trigger"]').exists()).toBe(true);
    press('g', { bubbles: true, cancelable: true }, window); await flushPromises(); press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(app)).toBe('Reminders');
  });
});

describe('header tabs', () => {
  it('are a real tablist with counts, roving tabindex and arrow, Home and End keys', async () => {
    const { w } = await mountRemindersContext([reminder('a', 'pending'), reminder('b', 'removing'), reminder('c', 'returned'), reminder('d', 'cancelled'), reminder('e', 'suppressed'), reminder('f', 'failed')]);
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending 1 · 2 need attention', 'Returned 1', 'History 2']);
    expect(tabs(w).map((tab) => tab.attributes('aria-selected'))).toEqual(['true', 'false', 'false']);
    expect(tabs(w).map((tab) => tab.attributes('tabindex'))).toEqual(['0', '-1', '-1']);
    expect(w.get('[role="tabpanel"]').attributes('aria-labelledby')).toBe(tabs(w)[0]!.attributes('id'));
    expect(w.findAll('li[data-test^="reminder-row-"]')).toHaveLength(3);
    await tabs(w)[0]!.trigger('keydown', { key: 'ArrowRight' }); await flushPromises();
    expect(tabs(w)[1]!.attributes('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(tabs(w)[1]!.element);
    expect(w.findAll('li[data-test^="reminder-row-"]')).toHaveLength(1);
    await tabs(w)[1]!.trigger('keydown', { key: 'End' }); await flushPromises();
    expect(tabs(w)[2]!.attributes('aria-selected')).toBe('true');
    expect(w.findAll('li[data-test^="reminder-row-"]')).toHaveLength(2);
    await tabs(w)[2]!.trigger('keydown', { key: 'ArrowRight' }); await flushPromises();
    expect(tabs(w)[0]!.attributes('aria-selected')).toBe('true');
    await tabs(w)[0]!.trigger('keydown', { key: 'ArrowLeft' }); await flushPromises();
    expect(tabs(w)[2]!.attributes('aria-selected')).toBe('true');
    await tabs(w)[2]!.trigger('keydown', { key: 'Home' }); await flushPromises();
    expect(tabs(w)[0]!.attributes('aria-selected')).toBe('true');
    // Modified arrows are not the tabs'.
    await tabs(w)[0]!.trigger('keydown', { key: 'ArrowRight', shiftKey: true });
    expect(tabs(w)[0]!.attributes('aria-selected')).toBe('true');
  });

  it('keep the selected tab when the context is left and entered again', async () => {
    const { w } = await mountRemindersContext();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    await tabs(w)[1]!.trigger('click'); await flushPromises();
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    expect(tabs(w)[1]!.attributes('aria-selected')).toBe('true');
  });
});

describe('opening a reminder', () => {
  it('opens the reader without J/K neighbours, and Back returns to the same row', async () => {
    const { fake, w } = await mountRemindersContext();
    const get = vi.spyOn(fake, 'getConversation');
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const second = rowButtons(w)[1]!;
    (second.element as HTMLElement).focus();
    await flushPromises();
    await second.trigger('click'); await flushPromises();
    expect(w.findComponent(RemindersList).exists()).toBe(false);
    expect(w.findComponent(ReaderView).exists()).toBe(true);
    expect(get).toHaveBeenCalledWith(ref('conv-03'), false);
    const calls = get.mock.calls.length;
    press('j', { bubbles: true, cancelable: true }, window); await flushPromises(); press('k', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(get.mock.calls.length).toBe(calls);
    press('Escape', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(w.findComponent(ReaderView).exists()).toBe(false);
    const again = rowButtons(w)[1]!;
    expect(document.activeElement).toBe(again.element);
    expect(w.findAll('li[aria-current="true"]')).toHaveLength(1);
    expect(again.element.closest('li')!.getAttribute('aria-current')).toBe('true');
    // Esc once more is the context's Back.
    press('Escape', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(w)).toBe('Inbox');
  });
});

describe('Remind me from the list and the reader', () => {
  it('h from an Inbox row opens the Reminders context with the picker for that conversation; Back returns to the row', async () => {
    const { fake, w } = await mountRemindersContext([]);
    press('j', { bubbles: true, cancelable: true }, window); await flushPromises();
    press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(w)).toBe('Reminders');
    const form = w.get('[data-test="reminder-form"]');
    expect(form.attributes('data-source-conversation')).toBe('conv-02');
    expect(form.find('h2').text()).toBe('Remind me');
    const picker = document.querySelector('[data-reminder-picker]')!;
    expect(picker.querySelector('.reminder-subject')!.textContent).toContain((await fake.getConversation(ref('conv-02'))).subject);
    // Focus lands in the picker's time field, not on a row.
    expect(picker.contains(document.activeElement)).toBe(true);
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    const row = w.get('[data-test="conversation-row-conv-02"]');
    expect(row.attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
  });

  it('h from the open reader does the same, and Back returns to the Inbox list at that row', async () => {
    const { w } = await mountRemindersContext([]);
    press('j', { bubbles: true, cancelable: true }, window); await flushPromises(); press('Enter', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(w.findComponent(ReaderView).exists()).toBe(true);
    press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(w)).toBe('Reminders');
    expect(w.findComponent(ReaderView).exists()).toBe(false);
    expect(w.get('[data-test="reminder-form"]').attributes('data-source-conversation')).toBe('conv-02');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(w.findComponent(ReaderView).exists()).toBe(false);
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
  });

  it('Escape inside the picker of a new reminder ends the request and goes Back to the row it was asked from', async () => {
    const { w } = await mountRemindersContext([reminder('conv-03', 'pending')]);
    press('j', { bubbles: true, cancelable: true }, window); await flushPromises();
    press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    expect(title(w)).toBe('Reminders');
    const input = document.querySelector<HTMLInputElement>('#reminder-time-input')!;
    press('Escape', { bubbles: true, cancelable: true }, input); await flushPromises();
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(document.querySelector('[data-reminder-picker]')).toBeNull();
    expect(title(w)).toBe('Inbox');
    const row = w.get('[data-test="conversation-row-conv-02"]');
    expect(row.attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
  });

  it('Escape inside a Reschedule picker dismisses only the picker; the next Escape goes Back', async () => {
    const { w } = await mountRemindersContext([reminder('conv-03', 'pending')]);
    press('g', { bubbles: true, cancelable: true }, window); await flushPromises(); press('h', { bubbles: true, cancelable: true }, window); await flushPromises();
    const first = rowButtons(w)[0]!.element as HTMLElement;
    first.focus();
    press('h', { bubbles: true, cancelable: true }, first); await flushPromises();
    expect(w.get('[data-test="reminder-form"] h2').text()).toBe('Reschedule reminder');
    const input = document.querySelector<HTMLInputElement>('#reminder-time-input')!;
    press('Escape', { bubbles: true, cancelable: true }, input); await flushPromises();
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(title(w)).toBe('Reminders');
    expect(document.activeElement).toBe(rowButtons(w)[0]!.element);
    press('Escape', { bubbles: true, cancelable: true }, document.activeElement!); await flushPromises();
    expect(title(w)).toBe('Inbox');
  });
});

describe('mutation safety', () => {
  it('mailbox shortcuts do nothing in the Reminders list; the row actions (H, Shift+H) are its only mutations', async () => {
    const { fake, w } = await mountRemindersContext();
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const star = vi.spyOn(fake, 'setStarred');
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const target = rowButtons(w)[0]!.element;
    for (const [name, init] of [['e', {}], ['E', { shiftKey: true }], ['z', {}], ['s', {}], ['U', { shiftKey: true }], ['x', {}], ['J', { shiftKey: true }], ['r', {}]] as const) {
      press(name, { bubbles: true, cancelable: true, ...init }, target); await flushPromises();
    }
    expect(archive).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(star).not.toHaveBeenCalled();
    expect(w.find('[data-test="selection-live"]').exists()).toBe(false);
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(title(w)).toBe('Reminders');
  });

  it('Reschedule and Cancel reminder stay the row actions, available to the keyboard', async () => {
    const { fake, w } = await mountRemindersContext();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const actions = w.findAll('.context-row-actions button');
    expect(actions.map((button) => button.text())).toEqual(['Reschedule', 'Cancel reminder', 'Reschedule', 'Cancel reminder']);
    expect(actions.every((button) => button.attributes('tabindex') === undefined)).toBe(true);
    await actions[1]!.trigger('click'); await flushPromises();
    expect(fake.reminders!.cancel).toHaveBeenCalledWith(expect.objectContaining({ conversation: ref('conv-02'), expectedRevision: 2 }));
  });
});

describe('list region name', () => {
  it('names the central region Reminders in the context and Conversation list again after Back', async () => {
    const { w } = await mountRemindersContext();
    const region = () => w.get('[data-test="central-surface"]').attributes('aria-label');
    expect(region()).toBe('Conversation list');
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    expect(region()).toBe('Reminders');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(region()).toBe('Conversation list');
  });
});

describe('before the first successful read', () => {
  async function enter(list: () => Promise<Reminder[]>) {
    const fake = createBrowserFakeMailClient();
    fake.reminders = { list: vi.fn(list), put: vi.fn(), cancel: vi.fn() };
    app = mountApp(fake, 'native', { attachTo: document.body });
    await flushPromises();
    await app.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    return app;
  }

  it('shows the tab names with no counts while loading, then the counts', async () => {
    const gate = deferred<Reminder[]>();
    const w = await enter(() => gate.promise);
    expect(w.get('[data-test="reminders-panel"]').text()).toContain('Loading local reminders…');
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending', 'Returned', 'History']);
    gate.resolve([reminder('a', 'pending'), reminder('b', 'failed')]); await flushPromises();
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending 1 · 1 needs attention', 'Returned 0', 'History 0']);
  });

  it('shows no zero counts and no empty line beside the load error, and the counts after Refresh succeeds', async () => {
    let fail = true;
    const w = await enter(async () => { if (fail) throw new Error('offline'); return [reminder('a', 'pending'), reminder('b', 'returned')]; });
    expect(w.get('[data-test="reminders-error"]').text()).toBe('Could not load local reminders. Retry refresh.');
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending', 'Returned', 'History']);
    expect(w.find('[data-test="reminders-empty"]').exists()).toBe(false);
    fail = false;
    await w.get('[data-test="reminders-refresh"]').trigger('click'); await flushPromises();
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending 1', 'Returned 1', 'History 0']);
  });
});
