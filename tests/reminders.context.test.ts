/**
 * Reminders as a list context (not a drawer): entries, header tabs, Back to the
 * exact row, the in-flow picker from `h`, inert mailbox shortcuts, and the
 * fixture-only gate.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import ReaderView from '../src/components/ReaderView.vue';
import RemindersList from '../src/components/RemindersList.vue';
import { createBrowserFakeMailClient } from '../src/lib/ipc/browser-fake';
import type { ConversationRef, PutReminder, Reminder, ReminderPhase } from '../src/lib/ipc/client';
import { useGmailMode } from './helpers';

let app: VueWrapper | null = null;
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; });

const ref = (id: string): ConversationRef => ({ accountId: 'fixture-account', conversationId: id });
function reminder(id: string, phase: ReminderPhase, patch: Partial<Reminder> = {}): Reminder {
  return { conversation: ref(id), subject: `Reminder ${id}`, revision: 2, sourceMessageId: `${id}-m1`, dueAt: '2030-01-01T00:00:00Z', condition: 'if_no_reply', phase, ...patch };
}
async function mountApp(rows: Reminder[] = [reminder('conv-02', 'pending'), reminder('conv-03', 'pending'), reminder('conv-04', 'returned')]) {
  const fake = createBrowserFakeMailClient();
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => ({ conversation: c.conversation, subject: 'Saved', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing' }));
  fake.reminders = { list: vi.fn(async () => structuredClone(rows)), put, cancel: vi.fn() };
  app = mount(App, { props: { client: fake, mode: 'native' }, attachTo: document.body });
  await flushPromises();
  return { fake, put, w: app };
}
const key = async (value: string, init: KeyboardEventInit = {}, target: EventTarget = window) => {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init }));
  await flushPromises();
};
const title = (w: VueWrapper) => w.get('[data-test="inbox-title"]').text();
const tabs = (w: VueWrapper) => w.findAll('[role="tab"]');
const rowButtons = (w: VueWrapper) => w.findAll('[data-drawer-row]');

describe('entering and leaving the Reminders context', () => {
  it('G then H and the header glyph enter it; the h1, the header tabs and the active glyph name it', async () => {
    const { w } = await mountApp();
    const glyph = w.get('[data-test="reminders-trigger"]');
    expect(glyph.attributes('title')).toBe('Reminders (G then H)');
    expect(glyph.attributes('aria-current')).toBeUndefined();
    await key('g'); await key('h');
    expect(title(w)).toBe('Reminders');
    expect(w.find('[data-test="inbox-title"]').classes()).not.toContain('visually-hidden');
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(glyph.attributes('aria-current')).toBe('page');
    // The Inbox split strip gives way to the list's sections.
    expect(w.find('[data-test="split-inbox"]').exists()).toBe(false);
    expect(w.get('[role="tablist"]').attributes('aria-label')).toBe('Reminder membership');
    expect(tabs(w).map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending 2', 'Returned 1', 'History 0']);
    expect(w.get('[data-test="reminders-coverage"]').text()).toContain('Synthetic fixture only');
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
    const { w } = await mountApp();
    await key('j');
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    expect(w.findComponent(RemindersList).exists()).toBe(true);
    await key('Escape');
    expect(w.findComponent(RemindersList).exists()).toBe(false);
    const row = w.get('[data-test="conversation-row-conv-02"]');
    expect(row.attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
  });

  it('puts focus on the current reminder row on entry and keeps G chords working from it', async () => {
    const { w } = await mountApp();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const first = rowButtons(w)[0]!;
    expect(document.activeElement).toBe(first.element);
    await key('g', {}, first.element); await key('e', {}, first.element);
    expect(title(w)).toBe('Cached Done');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Reminders');
    expect(w.findComponent(RemindersList).exists()).toBe(true);
  });

  it('shows no entry and ignores G then H without the fixture reminders transport', async () => {
    const plain = createBrowserFakeMailClient();
    app = mount(App, { props: { client: plain, mode: 'native' }, attachTo: document.body });
    await flushPromises();
    expect(app.find('[data-test="reminders-trigger"]').exists()).toBe(false);
    await key('g'); await key('h');
    expect(title(app)).toBe('Inbox');
    app.unmount();
    const gmail = createBrowserFakeMailClient();
    gmail.reminders = { list: vi.fn(async () => []), put: vi.fn(), cancel: vi.fn() };
    useGmailMode(gmail);
    app = mount(App, { props: { client: gmail, mode: 'native' }, attachTo: document.body });
    await flushPromises();
    expect(app.find('[data-test="reminders-trigger"]').exists()).toBe(false);
    await key('g'); await key('h');
    expect(title(app)).not.toBe('Reminders');
  });
});

describe('header tabs', () => {
  it('are a real tablist with counts, roving tabindex and arrow, Home and End keys', async () => {
    const { w } = await mountApp([reminder('a', 'pending'), reminder('b', 'removing'), reminder('c', 'returned'), reminder('d', 'cancelled'), reminder('e', 'suppressed'), reminder('f', 'failed')]);
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
    const { w } = await mountApp();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    await tabs(w)[1]!.trigger('click'); await flushPromises();
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    expect(tabs(w)[1]!.attributes('aria-selected')).toBe('true');
  });
});

describe('opening a reminder', () => {
  it('opens the reader without J/K neighbours, and Back returns to the same row', async () => {
    const { fake, w } = await mountApp();
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
    await key('j'); await key('k');
    expect(get.mock.calls.length).toBe(calls);
    await key('Escape');
    expect(w.findComponent(ReaderView).exists()).toBe(false);
    const again = rowButtons(w)[1]!;
    expect(document.activeElement).toBe(again.element);
    expect(w.findAll('li[aria-current="true"]')).toHaveLength(1);
    expect(again.element.closest('li')!.getAttribute('aria-current')).toBe('true');
    // Esc once more is the context's Back.
    await key('Escape');
    expect(title(w)).toBe('Inbox');
  });
});

describe('Remind me from the list and the reader', () => {
  it('h from an Inbox row opens the Reminders context with the picker for that conversation; Back returns to the row', async () => {
    const { fake, w } = await mountApp([]);
    await key('j');
    await key('h');
    expect(title(w)).toBe('Reminders');
    const form = w.get('[data-test="reminder-form"]');
    expect(form.attributes('data-source-conversation')).toBe('conv-02');
    expect(form.find('h2').text()).toBe('Remind me');
    expect(form.get('.reminder-subject').text()).toBe((await fake.getConversation(ref('conv-02'))).subject);
    // Focus lands in the picker, not on a row.
    expect(form.element.contains(document.activeElement)).toBe(true);
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    const row = w.get('[data-test="conversation-row-conv-02"]');
    expect(row.attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(row.element);
  });

  it('h from the open reader does the same, and Back returns to the Inbox list at that row', async () => {
    const { w } = await mountApp([]);
    await key('j'); await key('Enter');
    expect(w.findComponent(ReaderView).exists()).toBe(true);
    await key('h');
    expect(title(w)).toBe('Reminders');
    expect(w.findComponent(ReaderView).exists()).toBe(false);
    expect(w.get('[data-test="reminder-form"]').attributes('data-source-conversation')).toBe('conv-02');
    await w.get('[data-test="context-back"]').trigger('click'); await flushPromises();
    expect(title(w)).toBe('Inbox');
    expect(w.findComponent(ReaderView).exists()).toBe(false);
    expect(w.get('[data-test="conversation-row-conv-02"]').attributes('aria-current')).toBe('true');
  });

  it('Escape inside the picker dismisses only the picker; the next Escape goes Back', async () => {
    const { w } = await mountApp([reminder('conv-03', 'pending')]);
    await key('h');
    const form = w.get('[data-test="reminder-form"]');
    const preset = form.get('[data-test="reminder-preset-tomorrow"]');
    (preset.element as HTMLElement).focus();
    await key('Escape', {}, preset.element);
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(title(w)).toBe('Reminders');
    expect(document.activeElement).toBe(rowButtons(w)[0]!.element);
    await key('Escape', {}, document.activeElement!);
    expect(title(w)).toBe('Inbox');
  });
});

describe('mutation safety', () => {
  it('mailbox shortcuts do nothing in the Reminders list; the row actions (H, Shift+H) are its only mutations', async () => {
    const { fake, w } = await mountApp();
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const star = vi.spyOn(fake, 'setStarred');
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const target = rowButtons(w)[0]!.element;
    for (const [name, init] of [['e', {}], ['E', { shiftKey: true }], ['z', {}], ['s', {}], ['U', { shiftKey: true }], ['x', {}], ['J', { shiftKey: true }], ['r', {}]] as const) {
      await key(name, init, target);
    }
    expect(archive).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(star).not.toHaveBeenCalled();
    expect(w.find('[data-test="selection-live"]').exists()).toBe(false);
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(title(w)).toBe('Reminders');
  });

  it('Reschedule and Cancel reminder stay the row actions, available to the keyboard', async () => {
    const { fake, w } = await mountApp();
    await w.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
    const actions = w.findAll('.context-row-actions button');
    expect(actions.map((button) => button.text())).toEqual(['Reschedule', 'Cancel reminder', 'Reschedule', 'Cancel reminder']);
    expect(actions.every((button) => button.attributes('tabindex') === undefined)).toBe(true);
    await actions[1]!.trigger('click'); await flushPromises();
    expect(fake.reminders!.cancel).toHaveBeenCalledWith(expect.objectContaining({ conversation: ref('conv-02'), expectedRevision: 2 }));
  });
});
