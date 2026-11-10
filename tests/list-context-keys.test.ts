/**
 * Keyboard reach for the list contexts: the G chords for Trash and Drafts and
 * their hint, `[` / `]` for the Reminders tabs, H / Shift+H on a Reminders row
 * and Delete / Backspace on a Drafts row. Every row key acts on the focused row
 * only and is ignored in editable targets, during IME composition, with
 * modifiers, from the in-flow picker or confirmation, and for rows that do not
 * offer the action. Cached Trash stays read-only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import DraftsList from '../src/components/DraftsList.vue';
import type { CancelReminder, ConversationRef, DraftSummary, PutReminder, Reminder, ReminderPhase } from '../src/lib/ipc/client';
import { createBrowserFakeMailClient, deferred, useGmailMode, waitFor, type BrowserFake } from './helpers';

let app: VueWrapper | null = null;
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; });

const key = async (value: string, init: KeyboardEventInit = {}, target: EventTarget = document.body) => {
  const event = new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  await flushPromises();
  return event;
};
const title = (w: VueWrapper) => w.get('[data-test="inbox-title"]').text();
const hint = (w: VueWrapper) => w.get('[data-test="chord-hint"] .visually-hidden').text();
const active = () => document.activeElement as HTMLElement;

async function mountPlain(mode: 'plain' | 'gmail' | 'reminders' = 'plain'): Promise<{ fake: BrowserFake; w: VueWrapper }> {
  const fake = createBrowserFakeMailClient();
  if (mode === 'gmail') useGmailMode(fake, { mutationAccess: 'enabled' });
  if (mode === 'reminders') fake.reminders = { list: vi.fn(async () => []), put: vi.fn(), cancel: vi.fn() };
  app = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  return { fake, w: app };
}

describe('G chords for Trash and Drafts', () => {
  it('G then T opens cached Trash when the rail has it, and G then D opens Drafts', async () => {
    const { w } = await mountPlain('gmail');
    expect(w.find('[data-test="rail-trash"]').exists()).toBe(true);
    await key('g'); await key('t');
    expect(title(w)).toBe('Cached Trash');
    await key('Escape');
    expect(title(w)).toBe('Inbox');
    await key('g'); await key('d');
    expect(title(w)).toBe('Drafts');
    expect(w.get('[data-test="rail-drafts"]').attributes('aria-current')).toBe('page');
  });

  it('works from a Drafts row, so the chords chain between list contexts', async () => {
    const { w } = await mountPlain('gmail');
    await key('g'); await key('d');
    await key('g', {}, active()); await key('t', {}, active());
    expect(title(w)).toBe('Cached Trash');
  });

  it('G then T does nothing without the Trash rail item, and plain t and d keep no meaning', async () => {
    const { w } = await mountPlain('plain');
    expect(w.find('[data-test="rail-trash"]').exists()).toBe(false);
    await key('g'); await key('t');
    expect(title(w)).toBe('Inbox');
    await key('t'); await key('d');
    expect(title(w)).toBe('Inbox');
    // Drafts needs no Gmail mode.
    await key('g'); await key('d');
    expect(title(w)).toBe('Drafts');
  });

  it('ignores the second key in an editable target, with a modifier and during IME composition', async () => {
    const { w } = await mountPlain('gmail');
    const input = document.createElement('input');
    document.body.appendChild(input);
    await key('g'); await key('d', {}, input);
    expect(title(w)).toBe('Inbox');
    await key('g'); await key('d', { shiftKey: true });
    expect(title(w)).toBe('Inbox');
    await key('g'); await key('d', { isComposing: true });
    expect(title(w)).toBe('Inbox');
    await key('g'); await key('t', { ctrlKey: true });
    expect(title(w)).toBe('Inbox');
    input.remove();
  });

  it('does not arm the chord from a button that is not the list row', async () => {
    // Reminders: the trailing Cancel button is a button, not the row.
    const { w } = await mountReminders();
    expect(title(w)).toBe('Reminders');
    const cancelButton = w.get('.context-row-actions button[aria-label^="Cancel reminder"]').element as HTMLElement;
    cancelButton.focus();
    await key('g', {}, cancelButton);
    expect(w.find('[data-test="chord-hint"] .visually-hidden').exists()).toBe(false);
    await key('d', {}, cancelButton);
    expect(title(w)).toBe('Reminders');
  });

  it('does not arm the chord from the Confirm discard button of a Drafts row', async () => {
    const { w } = await mountDrafts();
    await key('Delete', {}, active());
    const confirm = active();
    expect(confirm.dataset.test).toBe('confirm-discard-draft');
    await key('g', {}, confirm);
    expect(w.find('[data-test="chord-hint"] .visually-hidden').exists()).toBe(false);
    await key('e', {}, confirm);
    expect(title(w)).toBe('Drafts');
    expect(confirmOpen(w)).toHaveLength(1);
  });

  it('names only the available second keys in the polite hint', async () => {
    const plain = await mountPlain('plain');
    await key('g');
    expect(hint(plain.w)).toBe('g pressed. Press E for Done or D for Drafts, Escape to cancel.');
    plain.w.unmount(); app = null;
    const gmail = await mountPlain('gmail');
    await key('g');
    expect(hint(gmail.w)).toBe('g pressed. Press E for Done, T for Trash or D for Drafts, Escape to cancel.');
    gmail.w.unmount(); app = null;
    const reminders = await mountPlain('reminders');
    await key('g');
    expect(hint(reminders.w)).toBe('g pressed. Press E for Done, D for Drafts or H for Reminders, Escape to cancel.');
  });

  it('shows the chords in the palette and the rail titles', async () => {
    const { w } = await mountPlain('gmail');
    expect(w.get('[data-test="rail-trash"]').attributes('title')).toBe('Go to cached Trash (read only) — G then T');
    expect(w.get('[data-test="rail-drafts"]').attributes('title')).toBe('Go to local Drafts — G then D');
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect(w.get('#action-trash kbd').text()).toBe('G then T');
    expect(w.get('#action-drafts kbd').text()).toBe('G then D');
    expect(w.get('#action-drafts kbd').attributes('title')).toBeUndefined();
  });
});

describe('Cached Trash stays read-only', () => {
  it('G then T only navigates; the new list keys do nothing there', async () => {
    const { fake, w } = await mountPlain('gmail');
    fake.controls.markTriage('conv-04', 'trash');
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const star = vi.spyOn(fake, 'setStarred');
    await key('g'); await key('t');
    await waitFor(() => w.find('[data-test="conversation-row-conv-04"]').exists());
    (w.get('[data-test="conversation-row-conv-04"]').element as HTMLElement).focus();
    for (const [name, init] of [['Delete', {}], ['Backspace', {}], ['h', {}], ['H', { shiftKey: true }], ['[', {}], [']', {}]] as const) {
      const event = await key(name, init, active());
      expect(event.defaultPrevented).toBe(false);
    }
    expect(archive).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(star).not.toHaveBeenCalled();
    expect(title(w)).toBe('Cached Trash');
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
  });

  it('does not show the list-context row keys in its palette', async () => {
    const { w } = await mountPlain('gmail');
    await key('g'); await key('t');
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    expect(w.get('.action-keys').text()).not.toContain('reminders tab');
    expect(w.get('.action-keys').text()).not.toContain('Discard focused draft');
  });
});

// ---- Reminders -------------------------------------------------------------

const ref = (id: string): ConversationRef => ({ accountId: 'fixture-account', conversationId: id });
function reminder(id: string, phase: ReminderPhase, patch: Partial<Reminder> = {}): Reminder {
  return { conversation: ref(id), subject: `Reminder ${id}`, revision: 2, sourceMessageId: `${id}-m1`, dueAt: '2030-01-01T00:00:00Z', condition: 'if_no_reply', phase, ...patch };
}
const rowButtons = (w: VueWrapper) => w.findAll('[data-drawer-row]');
const tabState = (w: VueWrapper) => w.findAll('[role="tab"]').find((tab) => tab.attributes('aria-selected') === 'true')!.text().replace(/\s+/g, ' ');

async function mountReminders(rows: Reminder[] = [reminder('conv-02', 'pending'), reminder('conv-03', 'pending'), reminder('conv-04', 'returned')], gate: Promise<void> = Promise.resolve(), failList = false) {
  const fake = createBrowserFakeMailClient();
  const cancel = vi.fn(async (command: CancelReminder) => {
    await gate;
    const index = rows.findIndex((row) => row.conversation.conversationId === command.conversation.conversationId);
    if (index >= 0) rows.splice(index, 1);
    return undefined as never;
  });
  const put = vi.fn(async (c: PutReminder): Promise<Reminder> => ({ conversation: c.conversation, subject: 'Saved', revision: 1, sourceMessageId: c.sourceMessageId, dueAt: c.dueAt, condition: c.condition, phase: 'removing' }));
  fake.reminders = { list: vi.fn(async () => { if (failList) throw new Error('offline'); return structuredClone(rows); }), put, cancel };
  app = mount(App, { props: { client: fake, mode: 'native' }, attachTo: document.body });
  await flushPromises();
  await app.get('[data-test="reminders-trigger"]').trigger('click'); await flushPromises();
  return { fake, cancel, w: app };
}
const status = (w: VueWrapper) => w.get('[data-test="reminders-tab-status"]').text();

describe('[ and ] step the Reminders tabs', () => {
  it('wraps like the tablist arrows, hands focus to the first row, and announces the tab politely', async () => {
    const { w } = await mountReminders();
    expect(tabState(w)).toBe('Pending 2');
    expect(w.get('[data-test="reminders-tab-status"]').attributes('role')).toBe('status');
    expect(w.get('[data-test="reminders-tab-status"]').attributes('aria-live')).toBe('polite');
    // From the second Pending row: the next tab starts at its first row, not at the remembered row.
    await key('j', {}, active());
    expect(active().dataset.drawerRow).toBe('conv-03');
    const next = await key(']', {}, active());
    expect(next.defaultPrevented).toBe(true);
    expect(tabState(w)).toBe('Returned 1');
    expect(active()).toBe(rowButtons(w)[0]!.element);
    expect(active().dataset.drawerRow).toBe('conv-04');
    expect(status(w)).toBe('Returned, 1 reminder');
    // Empty History: focus lands on the pane, which is the empty state.
    await key(']', {}, active());
    expect(tabState(w)).toBe('History 0');
    expect(active()).toBe(w.get('[data-test="reminders-panel"]').element);
    expect(w.get('[data-test="reminders-empty"]').text()).toBe('No history reminders.');
    expect(status(w)).toBe('History, no reminders');
    // Past the last tab: wrap to the first. And back with [.
    await key(']', {}, active());
    expect(tabState(w)).toBe('Pending 2');
    expect(active().dataset.drawerRow).toBe('conv-02');
    expect(status(w)).toBe('Pending, 2 reminders');
    await key('[', {}, active());
    expect(tabState(w)).toBe('History 0');
    expect(status(w)).toBe('History, no reminders');
  });

  it('announces the same counts as the tabs: calm rows first, then Needs attention', async () => {
    const { w } = await mountReminders([reminder('conv-02', 'failed'), reminder('conv-03', 'pending'), reminder('conv-04', 'returned')]);
    expect(tabState(w)).toBe('Pending 1 · 1 needs attention');
    await key(']', {}, active());
    await key(']', {}, active());
    await key(']', {}, active());
    expect(tabState(w)).toBe('Pending 1 · 1 needs attention');
    expect(status(w)).toBe('Pending, 1 reminder. Needs attention 1');
  });

  it('does not say "no reminders" when only attention rows exist', async () => {
    const { w } = await mountReminders([reminder('conv-02', 'failed'), reminder('conv-04', 'returned')]);
    expect(tabState(w)).toBe('Pending 0 · 1 needs attention');
    await key(']', {}, active());
    await key(']', {}, active());
    await key(']', {}, active());
    expect(status(w)).toBe('Pending, 1 needs attention');
    expect(status(w)).not.toMatch(/no reminders/);
  });

  it('announces only the tab name before the first successful read', async () => {
    const { w } = await mountReminders([], Promise.resolve(), true);
    expect(w.get('[data-test="reminders-error"]').text()).toBe('Could not load local reminders. Retry refresh.');
    expect(w.findAll('[role="tab"]').map((tab) => tab.text().replace(/\s+/g, ' '))).toEqual(['Pending', 'Returned', 'History']);
    await key(']', {}, w.get('[data-test="reminders-panel"]').element as HTMLElement);
    expect(status(w)).toBe('Returned');
    await key('[', {}, active());
    expect(status(w)).toBe('Pending');
    expect(status(w)).not.toMatch(/no reminders/);
  });

  it('leaves the tablist arrows, Home and End as they are', async () => {
    const { w } = await mountReminders();
    const pending = w.get('[data-test="reminder-tab-pending"]');
    (pending.element as HTMLElement).focus();
    await key('ArrowLeft', {}, pending.element);
    expect(tabState(w)).toBe('History 0');
    expect(active().id).toBe('reminder-tab-history');
    await key('Home', {}, active());
    expect(tabState(w)).toBe('Pending 2');
    await key('End', {}, active());
    expect(tabState(w)).toBe('History 0');
    // The tabs are buttons: a bracket typed there is not a list key.
    const ignored = await key(']', {}, active());
    expect(ignored.defaultPrevented).toBe(false);
    expect(tabState(w)).toBe('History 0');
  });

  it('is ignored in editable targets, the picker, with modifiers, during IME composition and for auto-repeat', async () => {
    const { w } = await mountReminders();
    // Auto-repeat, IME, modifier keys.
    await key(']', { repeat: true }, active());
    await key(']', { isComposing: true }, active());
    await key(']', { ctrlKey: true }, active());
    await key(']', { metaKey: true }, active());
    await key(']', { altKey: true }, active());
    expect(tabState(w)).toBe('Pending 2');
    // Picker: a preset button and the custom time input own their keys.
    await key('h', {}, active());
    const form = w.get('[data-test="reminder-form"]');
    const preset = form.get('[data-test="reminder-preset-tomorrow"]');
    (preset.element as HTMLElement).focus();
    await key(']', {}, preset.element);
    expect(tabState(w)).toBe('Pending 2');
    await form.get('[data-test="reminder-custom"]').trigger('click'); await flushPromises();
    const input = form.get('input[type="text"]');
    (input.element as HTMLElement).focus();
    const typed = await key(']', {}, input.element);
    expect(typed.defaultPrevented).toBe(false);
    expect(tabState(w)).toBe('Pending 2');
  });

  it('does nothing in other contexts', async () => {
    const { w } = await mountPlain('reminders');
    const before = active();
    const event = await key(']', {}, active());
    expect(event.defaultPrevented).toBe(false);
    await key('[', {}, active());
    expect(title(w)).toBe('Inbox');
    expect(active()).toBe(before);
    expect(w.find('[role="tablist"][aria-label="Reminder membership"]').exists()).toBe(false);
  });
});

describe('H and Shift+H on a Reminders row', () => {
  it('H opens Reschedule for the focused row only and moves focus into the picker', async () => {
    const { w } = await mountReminders();
    await key('j', {}, active());
    const event = await key('h', {}, active());
    expect(event.defaultPrevented).toBe(true);
    const form = w.get('[data-test="reminder-form"]');
    expect(form.attributes('data-source-conversation')).toBe('conv-03');
    expect(form.get('h2').text()).toBe('Reschedule');
    expect(form.element.contains(active())).toBe(true);
  });

  it('is shown on the row buttons: aria-keyshortcuts and a title', async () => {
    const { w } = await mountReminders();
    const actions = w.findAll('.context-row-actions button');
    expect(actions[0]!.attributes('aria-keyshortcuts')).toBe('H');
    expect(actions[0]!.attributes('title')).toBe('Reschedule — H');
    expect(actions[1]!.attributes('aria-keyshortcuts')).toBe('Shift+H');
    expect(actions[1]!.attributes('title')).toBe('Cancel and restore original inbox messages — Shift+H');
    // The accessible name keeps saying what the button does.
    expect(actions[1]!.attributes('aria-label')).toBe('Cancel reminder and restore original inbox messages');
  });

  it('Shift+H cancels the focused row at once, with no confirmation, and focus moves to the next row', async () => {
    const { cancel, w } = await mountReminders();
    const event = await key('H', { shiftKey: true }, active());
    expect(event.defaultPrevented).toBe(true);
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(expect.objectContaining({ conversation: ref('conv-02'), expectedRevision: 2 }));
    expect(w.find('[role="alertdialog"]').exists()).toBe(false);
    await waitFor(() => rowButtons(w).length === 1);
    expect(active()).toBe(rowButtons(w)[0]!.element);
    expect(active().dataset.drawerRow).toBe('conv-03');
    // The last row of the tab: focus falls back to the pane.
    await key('H', { shiftKey: true }, active());
    await waitFor(() => rowButtons(w).length === 0);
    expect(active()).toBe(w.get('[data-test="reminders-panel"]').element);
  });

  it('Shift+H announces the result politely only after the cancel resolved, and names a failure', async () => {
    const release = deferred<void>();
    const { cancel, w } = await mountReminders(undefined, release.promise);
    const announced = () => w.get('[data-test="reminders-action-status"]').text();
    expect(w.get('[data-test="reminders-action-status"]').attributes('role')).toBe('status');
    expect(w.get('[data-test="reminders-action-status"]').attributes('aria-live')).toBe('polite');
    await key('H', { shiftKey: true }, active());
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(announced()).toBe('');
    release.resolve(); await flushPromises();
    expect(announced()).toBe('Reminder cancelled');
    cancel.mockRejectedValueOnce({ kind: 'storage_unavailable' });
    await key('H', { shiftKey: true }, active());
    expect(announced()).toBe('Could not cancel reminder');
  });

  it('does not steal focus the user moved elsewhere before the cancelled row left', async () => {
    const release = deferred<void>();
    const { w } = await mountReminders([reminder('conv-02', 'pending'), reminder('conv-03', 'pending')], release.promise);
    await key('H', { shiftKey: true }, active());
    const tab = w.get('[data-test="reminder-tab-returned"]').element as HTMLElement;
    tab.focus();
    release.resolve(); await flushPromises();
    await waitFor(() => rowButtons(w).length === 1);
    expect(active()).toBe(tab);
  });

  it('is ignored for rows that do not offer the action, without feedback', async () => {
    const { cancel, w } = await mountReminders([reminder('conv-02', 'returning'), reminder('conv-03', 'returned'), reminder('conv-04', 'cancelled')]);
    // A returning row can be cancelled but not rescheduled.
    const resched = await key('h', {}, active());
    expect(resched.defaultPrevented).toBe(false);
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    // Returned and History rows offer neither.
    await key(']', {}, active());
    expect(tabState(w)).toBe('Returned 1');
    for (const init of [{}, { shiftKey: true }]) {
      const ignored = await key(init.shiftKey ? 'H' : 'h', init, active());
      expect(ignored.defaultPrevented).toBe(false);
    }
    await key(']', {}, active());
    for (const init of [{}, { shiftKey: true }]) await key(init.shiftKey ? 'H' : 'h', init, active());
    expect(cancel).not.toHaveBeenCalled();
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(w.find('[role="alert"]').exists()).toBe(false);
  });

  it('is ignored with modifiers, during IME composition, for auto-repeat and from an editable target or a row button', async () => {
    const { cancel, w } = await mountReminders();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }] as const) {
      await key('h', init, active());
      await key('H', { shiftKey: true, ...init }, active());
    }
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
    // The Reschedule button is not a row: it keeps its own keys.
    const reschedule = w.get('.context-row-actions button').element as HTMLElement;
    reschedule.focus();
    await key('H', { shiftKey: true }, reschedule);
    expect(cancel).not.toHaveBeenCalled();
    // An editable target (the picker's own field) keeps every key.
    await w.get('.context-row-actions button').trigger('click'); await flushPromises();
    await w.get('[data-test="reminder-custom"]').trigger('click'); await flushPromises();
    const input = w.get('[data-test="reminder-form"] input[type="text"]');
    (input.element as HTMLElement).focus();
    for (const init of [{}, { shiftKey: true }]) {
      const typed = await key(init.shiftKey ? 'H' : 'h', init, input.element);
      expect(typed.defaultPrevented).toBe(false);
    }
    expect(cancel).not.toHaveBeenCalled();
    expect(w.get('[data-test="reminder-form"]').attributes('data-source-conversation')).toBe('conv-02');
  });

  it('is ignored from the picker controls', async () => {
    const { cancel, w } = await mountReminders();
    await key('h', {}, active());
    const form = w.get('[data-test="reminder-form"]');
    const preset = form.get('[data-test="reminder-preset-tomorrow"]').element as HTMLElement;
    preset.focus();
    await key('H', { shiftKey: true }, preset);
    await key('h', {}, preset);
    expect(cancel).not.toHaveBeenCalled();
    expect(form.attributes('data-source-conversation')).toBe('conv-02');
  });

  it('G then H still works from a row and does not reschedule it', async () => {
    const { w } = await mountReminders();
    await key('g', {}, active()); await key('h', {}, active());
    expect(title(w)).toBe('Reminders');
    expect(w.find('[data-test="reminder-form"]').exists()).toBe(false);
  });

  it('lists its keys in the palette only while the Reminders list is showing', async () => {
    const { w } = await mountReminders();
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    const keys = w.get('.action-keys');
    expect(keys.text()).toContain('Previous and next reminders tab');
    expect(keys.text()).toContain('Reschedule focused reminder');
    expect(keys.text()).toContain('Cancel focused reminder');
    expect(keys.findAll('kbd').map((kbd) => kbd.text())).toEqual(expect.arrayContaining(['[', ']', 'H', 'Shift+H']));
    expect(keys.text()).not.toContain('Discard focused draft');
  });
});

// ---- Drafts ----------------------------------------------------------------

async function seedDrafts(fake: BrowserFake): Promise<DraftSummary[]> {
  await fake.createDraft({ requestId: 'k-a', source: { kind: 'new_message' }, initialContent: { to: 'ada@example.test', cc: '', subject: 'First', bodyText: 'one' } });
  await fake.createDraft({ requestId: 'k-b', source: { kind: 'new_message' }, initialContent: { to: 'bo@example.test', cc: '', subject: 'Second', bodyText: 'two' } });
  return fake.listDrafts();
}
async function mountDrafts() {
  const fake = createBrowserFakeMailClient();
  const drafts = await seedDrafts(fake);
  app = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
  await flushPromises();
  await app.get('[data-test="rail-drafts"]').trigger('click'); await flushPromises();
  await waitFor(() => app!.find('[data-test="drafts-pane"]').exists());
  return { fake, drafts, w: app };
}
const draftRows = (w: VueWrapper) => w.findAll('[data-test="draft-list"] [data-drawer-row]');
const confirmOpen = (w: VueWrapper) => w.findAll('[data-test="draft-discard-confirm"]');

describe('Delete and Backspace on a Drafts row', () => {
  it.each(['Delete', 'Backspace'])('%s opens the Discard confirmation of the focused row only, and discards nothing', async (name) => {
    const { fake, w } = await mountDrafts();
    await key('j', {}, active());
    const target = draftRows(w)[1]!;
    expect(active()).toBe(target.element);
    const event = await key(name, {}, active());
    expect(event.defaultPrevented).toBe(true);
    expect(confirmOpen(w)).toHaveLength(1);
    expect(w.find(`[data-test="draft-row-${target.attributes('data-drawer-row')!.split(':')[1]}"] [data-test="draft-discard-confirm"]`).exists()).toBe(true);
    expect(active().dataset.test).toBe('confirm-discard-draft');
    expect(await fake.listDrafts()).toHaveLength(2);
    // Escape inside the confirmation closes it and returns to the Discard button, as for a click.
    await key('Escape', {}, active());
    expect(confirmOpen(w)).toHaveLength(0);
    expect(active().dataset.test).toBe('discard-draft');
    expect(title(w)).toBe('Drafts');
    expect(await fake.listDrafts()).toHaveLength(2);
  });

  it('the confirmation still decides: Enter on Confirm discards, Delete inside it does nothing', async () => {
    const { fake, w } = await mountDrafts();
    await key('Delete', {}, active());
    const confirm = active();
    expect(confirm.dataset.test).toBe('confirm-discard-draft');
    const inside = await key('Delete', {}, confirm);
    expect(inside.defaultPrevented).toBe(false);
    expect(await fake.listDrafts()).toHaveLength(2);
    await w.get('[data-test="confirm-discard-draft"]').trigger('click'); await flushPromises();
    expect(await fake.listDrafts()).toHaveLength(1);
    expect(w.get('[data-test="draft-discard-status"]').text()).toBe('Local draft deleted');
  });

  it('shows the key on the Discard button and keeps its accessible name', async () => {
    const { w } = await mountDrafts();
    const button = w.get('[data-test="discard-draft"]');
    expect(button.attributes('aria-keyshortcuts')).toBe('Delete Backspace');
    expect(button.attributes('title')).toBe('Discard this local draft — Delete or Backspace');
    expect(button.attributes('aria-label')).toMatch(/^Discard draft /);
  });

  it('is ignored with modifiers, Shift, IME composition and auto-repeat, and outside a row', async () => {
    const { fake, w } = await mountDrafts();
    for (const init of [{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { isComposing: true }, { repeat: true }] as const) {
      const event = await key('Delete', init, active());
      expect(event.defaultPrevented).toBe(false);
    }
    // The Discard button and the New draft button are not rows.
    const discard = w.get('[data-test="discard-draft"]').element as HTMLElement;
    discard.focus();
    await key('Delete', {}, discard);
    // A stray editable target keeps its keys.
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    await key('Backspace', {}, input);
    input.remove();
    expect(confirmOpen(w)).toHaveLength(0);
    expect(await fake.listDrafts()).toHaveLength(2);
  });

  it('does nothing in the Inbox', async () => {
    const fake = createBrowserFakeMailClient();
    await seedDrafts(fake);
    app = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    await flushPromises();
    await key('Delete', {}, active()); await key('Backspace', {}, active());
    expect(title(app)).toBe('Inbox');
    expect(await fake.listDrafts()).toHaveLength(2);
  });

  it('lists its key in the palette only while the Drafts list is showing', async () => {
    const { w } = await mountDrafts();
    await w.get('[data-test="palette-trigger"]').trigger('click'); await flushPromises();
    const keys = w.get('.action-keys');
    expect(keys.text()).toContain('Discard focused draft (asks first)');
    expect(keys.findAll('kbd').map((kbd) => kbd.text())).toEqual(expect.arrayContaining(['Delete', 'Backspace']));
    expect(keys.text()).not.toContain('reminders tab');
  });

  it('ignores a draft that is open in the editor, a missing discard handler and a busy list', async () => {
    const fake = createBrowserFakeMailClient();
    const [first, second] = await seedDrafts(fake);
    const mountList = (props: Record<string, unknown>) => mount(DraftsList, {
      attachTo: document.body,
      props: {
        summaries: [first!, second!], activeKey: null, activeRef: null, conflict: false, suspendedEditor: false, busy: false,
        createError: null, listError: null, subscriptionError: null, closeError: null, closeRetryAvailable: false, closeSetupError: null,
        discardDraft: vi.fn(async () => null),
        ...props,
      },
    });
    const keyOf = (draft: DraftSummary) => `${draft.ref.accountId}:${draft.ref.draftId}`;
    const open = mountList({ activeRef: first!.ref });
    expect((open.vm as unknown as { discardRow: (k: string) => boolean }).discardRow(keyOf(first!))).toBe(false);
    expect(open.find('[data-test="draft-discard-confirm"]').exists()).toBe(false);
    expect((open.vm as unknown as { discardRow: (k: string) => boolean }).discardRow(keyOf(second!))).toBe(true);
    await flushPromises();
    expect(open.findAll('[data-test="draft-discard-confirm"]')).toHaveLength(1);
    open.unmount();
    const none = mountList({ discardDraft: undefined });
    expect((none.vm as unknown as { discardRow: (k: string) => boolean }).discardRow(keyOf(first!))).toBe(false);
    none.unmount();
    const busy = mountList({ busy: true });
    expect((busy.vm as unknown as { discardRow: (k: string) => boolean }).discardRow(keyOf(first!))).toBe(false);
    expect((busy.vm as unknown as { discardRow: (k: string) => boolean }).discardRow('unknown:key')).toBe(false);
    busy.unmount();
  });
});
