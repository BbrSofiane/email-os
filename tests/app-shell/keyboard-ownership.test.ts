/**
 * Characterization tests for the ownership rules of App.vue `onKeydown`. They pin
 * what the keyboard handler does today (client calls, surfaces, defaultPrevented,
 * focus) for the rules that no other suite pins. The rule numbers refer to the
 * ownership table kept with the P5b action-registry refactor. Synthetic fake only.
 */
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { VueWrapper } from '@vue/test-utils';
import { createBrowserFakeMailClient, deferred, mountApp, press, useGmailMode, type BrowserFake } from '../helpers';
import { flushFakeClientAndVueUpdates } from '../support/ui-settle';
import { useUiTestClock } from '../support/timers';

let app: VueWrapper | null = null;
beforeEach(useUiTestClock);
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; vi.useRealTimers(); vi.restoreAllMocks(); });

/** Dispatch a bubbling, cancelable keydown. Without a target it goes to the focused element (or body). */
const key = (name: string, init: KeyboardEventInit = {}, target?: EventTarget): KeyboardEvent =>
  press(name, { bubbles: true, cancelable: true, ...init }, target);
const settle = async (fake: BrowserFake): Promise<void> => { await flushFakeClientAndVueUpdates(fake); };
const title = (w: VueWrapper): string => w.get('[data-test="inbox-title"]').text();
const rowEl = (w: VueWrapper, id: string): HTMLElement => w.get(`[data-test="conversation-row-${id}"]`).element as HTMLElement;
const isReaderOpen = (w: VueWrapper): boolean => w.find('[data-test="reader"]').exists();
const focusedId = (): string | null => document.activeElement?.closest('[data-test^="conversation-row-"]')?.getAttribute('data-test')?.replace('conversation-row-', '') ?? null;

interface MountOptions { gmail?: boolean; mutationAccess?: 'enabled' | 'read_only'; noReminders?: boolean; savedSplit?: boolean; mode?: 'native' | 'browser-preview' }
async function mountInbox(options: MountOptions = {}): Promise<{ fake: BrowserFake; w: VueWrapper }> {
  const fake = createBrowserFakeMailClient();
  if (options.gmail) useGmailMode(fake, { mutationAccess: options.mutationAccess ?? 'enabled' });
  if (options.noReminders) delete fake.reminders;
  if (options.savedSplit) {
    const first = (await fake.listConversations()).conversations[0]!;
    await fake.saveSavedSplit(first.ref.accountId, { name: 'Clients', criterion: 'sender', value: first.primaryCorrespondent!.mailbox, enabled: true, hideWhenEmpty: false });
  }
  app = mountApp(fake, options.mode ?? 'browser-preview', { attachTo: document.body });
  await settle(fake);
  return { fake, w: app };
}
async function openReader(fake: BrowserFake, w: VueWrapper, id = 'conv-01'): Promise<void> {
  rowEl(w, id).focus();
  key('Enter');
  await settle(fake);
  expect(isReaderOpen(w)).toBe(true);
}
async function openAccountDrawer(fake: BrowserFake, w: VueWrapper): Promise<void> {
  await w.get('[data-test="rail-account"]').trigger('click');
  await settle(fake);
  expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
}

const navigatorOpen = (w: VueWrapper): boolean => w.find('[role="dialog"][aria-label="Destination navigator"]').exists();
const chordHint = (w: VueWrapper): string => w.get('[data-test="chord-hint"]').element.textContent ?? '';

describe('rule 13: the Escape ladder', () => {
  it('rule 13: Escape with no reader, selection or history is consumed but not prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const escape = key('Escape');
    await settle(fake);
    expect(escape.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Inbox');
    expect(focusedId()).toBe('conv-02');
  });

  it('rule 13: Escape in the reader clears the selection before it goes Back', async () => {
    const { fake, w } = await mountInbox();
    await w.get('[data-test="row-select-conv-03"]').setValue(true);
    await settle(fake);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(true);
    await openReader(fake, w, 'conv-01');
    const first = key('Escape');
    await settle(fake);
    expect(first.defaultPrevented).toBe(true);
    expect(isReaderOpen(w)).toBe(true);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
    const second = key('Escape');
    await settle(fake);
    expect(second.defaultPrevented).toBe(true);
    expect(isReaderOpen(w)).toBe(false);
  });

  it('rule 13: Escape without a reader clears the selection and keeps the Inbox', async () => {
    const { fake, w } = await mountInbox();
    await w.get('[data-test="row-select-conv-03"]').setValue(true);
    await settle(fake);
    rowEl(w, 'conv-03').focus();
    const escape = key('Escape');
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
    expect(title(w)).toBe('Inbox');
  });

  it('rule 13: Escape from a focused reader toolbar button still goes Back (only editable fields are exempt)', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const escape = key('Escape');
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(isReaderOpen(w)).toBe(false);
  });

  it('rule 13: Shift+Escape runs the ladder like Escape (Shift is not checked)', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    const escape = key('Escape', { shiftKey: true });
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(isReaderOpen(w)).toBe(false);
  });

  it('rule 13: Escape in an editable field is ignored by the app while a reader is open', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const escape = key('Escape');
    await settle(fake);
    expect(escape.defaultPrevented).toBe(false);
    expect(isReaderOpen(w)).toBe(true);
  });

  it('rule 13: Escape closes the drawer first and leaves the reader open, then the next Escape goes Back', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    await openReader(fake, w, 'conv-01');
    await openAccountDrawer(fake, w);
    const first = key('Escape', {}, document.body);
    await settle(fake);
    expect(first.defaultPrevented).toBe(true);
    expect(w.find('[data-test="account-panel"]').exists()).toBe(false);
    expect(isReaderOpen(w)).toBe(true);
    const second = key('Escape', {}, document.body);
    await settle(fake);
    expect(second.defaultPrevented).toBe(true);
    expect(isReaderOpen(w)).toBe(false);
  });
});

describe('rule 14: a drawer owns every remaining key', () => {
  it('rule 14: with the Account drawer open, j, e, s, c, h, x, g and Shift+E reach nothing and are not prevented', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    const archived = vi.spyOn(fake, 'setArchived');
    const starred = vi.spyOn(fake, 'setStarred');
    rowEl(w, 'conv-02').focus();
    await openAccountDrawer(fake, w);
    const before = focusedId();
    const events = [key('j', {}, document.body), key('e', {}, document.body), key('s', {}, document.body), key('c', {}, document.body),
      key('h', {}, document.body), key('x', {}, document.body), key('g', {}, document.body), key('E', { shiftKey: true }, document.body)];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(archived).not.toHaveBeenCalled();
    expect(starred).not.toHaveBeenCalled();
    expect(title(w)).toBe('Inbox');
    expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
    expect(chordHint(w)).toBe('');
    expect(focusedId()).toBe(before);
  });

  it('rule 14: with the drawer open, ArrowLeft does not open the navigator', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    await openAccountDrawer(fake, w);
    const left = key('ArrowLeft', {}, document.body);
    await settle(fake);
    expect(left.defaultPrevented).toBe(false);
    expect(navigatorOpen(w)).toBe(false);
  });
});

describe('rule 14: the narrow contact disclosure owns every remaining key', () => {
  const originalMatchMedia = window.matchMedia;
  afterEach(() => { window.matchMedia = originalMatchMedia; });

  it('rule 14: below the wide breakpoint, an open contact disclosure ignores j, e, s, x, h and ArrowLeft, and Escape closes it', async () => {
    window.matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: () => undefined, removeListener: () => undefined,
      addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    const { fake, w } = await mountInbox({ gmail: true });
    const archived = vi.spyOn(fake, 'setArchived');
    const starred = vi.spyOn(fake, 'setStarred');
    rowEl(w, 'conv-02').focus();
    await w.get('[data-test="contact-disclosure"]').trigger('click');
    await settle(fake);
    expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
    const events = ['j', 'e', 's', 'x', 'h', 'ArrowLeft'].map((name) => key(name, {}, document.body));
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(archived).not.toHaveBeenCalled();
    expect(starred).not.toHaveBeenCalled();
    expect(title(w)).toBe('Inbox');
    expect(navigatorOpen(w)).toBe(false);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
    const escape = key('Escape', {}, document.body);
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
  });
});

describe('rule 15: h (Remind)', () => {
  it('rule 15: h from a focused rail button is left alone (button-blocked), and Shift+H and auto-repeat do nothing from a row', async () => {
    const { fake, w } = await mountInbox();
    const rail = w.get('[data-test="rail-drafts"]').element as HTMLElement;
    rail.focus();
    const fromButton = key('h');
    await settle(fake);
    expect(fromButton.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Inbox');
    rowEl(w, 'conv-02').focus();
    const shifted = key('H', { shiftKey: true });
    const repeated = key('h', { repeat: true });
    await settle(fake);
    expect(shifted.defaultPrevented).toBe(false);
    expect(repeated.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Inbox');
  });

  it('rule 15: h from a list row opens the Reminders context and is prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const remind = key('h');
    await settle(fake);
    expect(remind.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Reminders');
  });

  it('rule 15: h from a reader message toggle still reminds (message toggles are not toolbar buttons)', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    const toggle = w.get('.message-toggle').element as HTMLElement;
    toggle.focus();
    const remind = key('h');
    await settle(fake);
    expect(remind.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Reminders');
  });

  it('rule 15: h is neither prevented nor acted on when Remind is unavailable (no reminders transport)', async () => {
    const { fake, w } = await mountInbox({ noReminders: true });
    rowEl(w, 'conv-02').focus();
    const remind = key('h');
    await settle(fake);
    expect(remind.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Inbox');
  });
});

describe('rule 20: browsing keys (ArrowLeft and g)', () => {
  it('rule 20: Shift+ArrowLeft does not open the navigator and Shift+G does not arm the chord', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const left = key('ArrowLeft', { shiftKey: true });
    const arm = key('G', { shiftKey: true });
    await settle(fake);
    expect(left.defaultPrevented).toBe(false);
    expect(arm.defaultPrevented).toBe(false);
    expect(navigatorOpen(w)).toBe(false);
    expect(chordHint(w)).toBe('');
  });

  it('rule 20: ArrowLeft and g are not browsing keys from a toolbar button or from the open reader', async () => {
    const { fake, w } = await mountInbox();
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const fromButton = [key('ArrowLeft'), key('g')];
    await settle(fake);
    expect(fromButton.map((event) => event.defaultPrevented)).toEqual([false, false]);
    expect(navigatorOpen(w)).toBe(false);
    expect(chordHint(w)).toBe('');
    await openReader(fake, w, 'conv-01');
    (w.get('.message-toggle').element as HTMLElement).focus();
    const inReader = [key('ArrowLeft'), key('g')];
    await settle(fake);
    expect(inReader.map((event) => event.defaultPrevented)).toEqual([false, false]);
    expect(navigatorOpen(w)).toBe(false);
    expect(chordHint(w)).toBe('');
  });

  it('rule 20: ArrowLeft and g dispatched on window (not a Node) are not browsing keys, so a following e archives', async () => {
    const { fake, w } = await mountInbox();
    const archived = vi.spyOn(fake, 'setArchived');
    rowEl(w, 'conv-02').focus();
    const left = key('ArrowLeft', {}, window);
    const arm = key('g', {}, window);
    expect(left.defaultPrevented).toBe(false);
    expect(arm.defaultPrevented).toBe(false);
    expect(navigatorOpen(w)).toBe(false);
    const archive = key('e', {}, window);
    await settle(fake);
    expect(archive.defaultPrevented).toBe(true);
    expect(archived).toHaveBeenCalledTimes(1);
    expect(archived.mock.calls[0]![0]).toMatchObject({ archived: true });
  });

  it('rule 20: ArrowLeft from a list row opens the navigator and g arms the chord, both prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const arm = key('g');
    await settle(fake);
    expect(arm.defaultPrevented).toBe(true);
    expect(chordHint(w)).not.toBe('');
    key('Escape');
    const left = key('ArrowLeft');
    await settle(fake);
    expect(left.defaultPrevented).toBe(true);
    expect(navigatorOpen(w)).toBe(true);
  });
});

type ArchiveSpy = MockInstance<BrowserFake['setArchived']>;
type UndoSpy = MockInstance<BrowserFake['undoOperation']>;
const starRef = (id: string) => ({ accountId: 'gmail-account', conversationId: id });

describe('rule 21: s (Star or Unstar)', () => {
  it('rule 21: s on an unstarred row stars it, prevented', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    const single = vi.spyOn(fake, 'setStarred');
    rowEl(w, 'conv-02').focus();
    const event = key('s');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single.mock.calls[0]![0]).toMatchObject({ conversation: starRef('conv-02'), starred: true });
  });

  it('rule 21: s on a fully known, starred row unstars it', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    await fake.setStarred({ conversation: starRef('conv-02'), starred: true, requestId: 'seed-star' });
    await settle(fake);
    const single = vi.spyOn(fake, 'setStarred');
    rowEl(w, 'conv-02').focus();
    const event = key('s');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single.mock.calls[0]![0]).toMatchObject({ conversation: starRef('conv-02'), starred: false });
  });

  it('rule 21: with a selection s always stars the selected group, even when the focused row is starred', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    await fake.setStarred({ conversation: starRef('conv-02'), starred: true, requestId: 'seed-star' });
    await settle(fake);
    const single = vi.spyOn(fake, 'setStarred');
    const group = vi.spyOn(fake, 'setStarredGroup');
    await w.get('[data-test="row-select-conv-04"]').setValue(true);
    await settle(fake);
    rowEl(w, 'conv-02').focus();
    key('s');
    await settle(fake);
    expect(single).not.toHaveBeenCalled();
    expect(group).toHaveBeenCalledTimes(1);
    expect(group.mock.calls[0]![0]).toMatchObject({ members: [starRef('conv-04')], starred: true });
  });

  it('rule 21: s in the reader chooses Unstar from the open conversation star facts', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    await fake.setStarred({ conversation: starRef('conv-01'), starred: true, requestId: 'seed-star' });
    await settle(fake);
    await openReader(fake, w, 'conv-01');
    const single = vi.spyOn(fake, 'setStarred');
    key('s');
    await settle(fake);
    expect(single).toHaveBeenCalledTimes(1);
    expect(single.mock.calls[0]![0]).toMatchObject({ conversation: starRef('conv-01'), starred: false });
  });

  it('rule 21: s is not handled with Shift, on auto-repeat, or from a toolbar button', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    const single = vi.spyOn(fake, 'setStarred');
    rowEl(w, 'conv-02').focus();
    const shifted = key('S', { shiftKey: true });
    const repeated = key('s', { repeat: true });
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const fromButton = key('s');
    await settle(fake);
    expect([shifted, repeated, fromButton].map((event) => event.defaultPrevented)).toEqual([false, false, false]);
    expect(single).not.toHaveBeenCalled();
  });

  it('rule 21: s from a reader message toggle still stars (the toggle is not a toolbar button)', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    await openReader(fake, w, 'conv-01');
    const single = vi.spyOn(fake, 'setStarred');
    (w.get('.message-toggle').element as HTMLElement).focus();
    key('s');
    await settle(fake);
    expect(single).toHaveBeenCalledTimes(1);
  });

  it('rule 21: in fixture mode s is still prevented but reaches no client star call', async () => {
    const { fake, w } = await mountInbox();
    const single = vi.spyOn(fake, 'setStarred');
    const group = vi.spyOn(fake, 'setStarredGroup');
    rowEl(w, 'conv-02').focus();
    const event = key('s');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(single).not.toHaveBeenCalled();
    expect(group).not.toHaveBeenCalled();
  });
});

describe('rule 22: Shift+E (Unarchive) and Shift+U (Unread)', () => {
  async function mountDone(): Promise<{ fake: BrowserFake; w: VueWrapper; setArchived: ArchiveSpy }> {
    const { fake, w } = await mountInbox({ gmail: true });
    await fake.setArchived({ conversation: starRef('conv-03'), archived: true, requestId: 'seed-done' });
    await settle(fake);
    key('g', {}, document.body);
    key('e', {}, document.body);
    await settle(fake);
    expect(title(w)).toBe('Cached Done');
    return { fake, w, setArchived: vi.spyOn(fake, 'setArchived') };
  }

  it('rule 22: Shift+E on a Done row restores it, prevented', async () => {
    const { fake, w, setArchived } = await mountDone();
    rowEl(w, 'conv-03').focus();
    const event = key('E', { shiftKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(setArchived).toHaveBeenCalledTimes(1);
    expect(setArchived.mock.calls[0]![0]).toMatchObject({ conversation: starRef('conv-03'), archived: false });
  });

  it('rule 22: Shift+E restores from the reader even when a message toggle has focus', async () => {
    const { fake, w, setArchived } = await mountDone();
    await openReader(fake, w, 'conv-03');
    (w.get('.message-toggle').element as HTMLElement).focus();
    const event = key('E', { shiftKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(setArchived).toHaveBeenCalledTimes(1);
    expect(setArchived.mock.calls[0]![0]).toMatchObject({ conversation: starRef('conv-03'), archived: false });
  });

  it('rule 22: Shift+E and Shift+U are left alone when a toolbar button owns focus', async () => {
    const { fake, w, setArchived } = await mountDone();
    const read = vi.spyOn(fake, 'setRead');
    await openReader(fake, w, 'conv-03');
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const restore = key('E', { shiftKey: true });
    const unread = key('U', { shiftKey: true });
    await settle(fake);
    expect([restore.defaultPrevented, unread.defaultPrevented]).toEqual([false, false]);
    expect(setArchived).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
  });

  it('rule 22: Shift+U marks the focused row unread, prevented, and a plain u does nothing', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    const read = vi.spyOn(fake, 'setRead');
    rowEl(w, 'conv-02').focus();
    const plain = key('u');
    expect(plain.defaultPrevented).toBe(false);
    const event = key('U', { shiftKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[0]![0]).toMatchObject({ conversation: starRef('conv-02'), read: false });
  });

  it('rule 22: Shift+E in the Inbox is prevented but issues no restore (the action is unavailable)', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    const setArchived = vi.spyOn(fake, 'setArchived');
    rowEl(w, 'conv-02').focus();
    const event = key('E', { shiftKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Inbox');
    expect(setArchived).not.toHaveBeenCalled();
  });
});

describe('rule 23: c (Compose)', () => {
  it('rule 23: c is not handled on auto-repeat or from a toolbar button', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const repeated = key('c', { repeat: true });
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const fromButton = key('c');
    await settle(fake);
    expect([repeated.defaultPrevented, fromButton.defaultPrevented]).toEqual([false, false]);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(await fake.listDrafts()).toHaveLength(0);
  });

  it('rule 23: c from a list row opens the compose card and is prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const event = key('c');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
  });

  it('rule 23: c from a reader message toggle opens the docked compose card and keeps the reader', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    (w.get('.message-toggle').element as HTMLElement).focus();
    const event = key('c');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
    expect(isReaderOpen(w)).toBe(true);
  });
});

describe('rule 25: z (Undo)', () => {
  async function archiveOne(fake: BrowserFake, w: VueWrapper): Promise<UndoSpy> {
    rowEl(w, 'conv-02').focus();
    key('e');
    await settle(fake);
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(false);
    return vi.spyOn(fake, 'undoOperation');
  }

  it('rule 25: an auto-repeating z is consumed without prevention and does not undo', async () => {
    const { fake, w } = await mountInbox();
    const undo = await archiveOne(fake, w);
    const repeated = key('z', { repeat: true }, document.body);
    await settle(fake);
    expect(repeated.defaultPrevented).toBe(false);
    expect(undo).not.toHaveBeenCalled();
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(false);
  });

  it('rule 25: Shift+Z and z from a toolbar button do not undo', async () => {
    const { fake, w } = await mountInbox();
    const undo = await archiveOne(fake, w);
    const shifted = key('Z', { shiftKey: true }, document.body);
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const fromButton = key('z');
    await settle(fake);
    expect([shifted.defaultPrevented, fromButton.defaultPrevented]).toEqual([false, false]);
    expect(undo).not.toHaveBeenCalled();
  });

  it('rule 25: a plain z undoes, prevented, from any list focus', async () => {
    const { fake, w } = await mountInbox();
    const undo = await archiveOne(fake, w);
    const event = key('z', {}, document.body);
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(undo).toHaveBeenCalledTimes(1);
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(true);
  });

  it('rule 25: z with nothing to undo is still prevented and reaches no client call', async () => {
    const { fake } = await mountInbox();
    const undo = vi.spyOn(fake, 'undoOperation');
    const event = key('z', {}, document.body);
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(undo).not.toHaveBeenCalled();
  });
});

const activeToggleId = (): string | null =>
  document.activeElement?.closest('[data-test^="message-toggle-"]')?.getAttribute('data-test')?.replace('message-toggle-', '') ?? null;
const readerSubject = (w: VueWrapper): string => w.get('.reader-subject').text();

describe('rule 12: / (Search)', () => {
  it('rule 12: / from a focused rail button opens Search and is prevented', async () => {
    const { fake, w } = await mountInbox();
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const event = key('/');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(w.get('[data-test="search-input"]').element);
  });

  it('rule 12: / is ignored with Ctrl, and not handled while a drawer is open', async () => {
    const { fake, w } = await mountInbox({ gmail: true });
    rowEl(w, 'conv-02').focus();
    const withCtrl = key('/', { ctrlKey: true });
    await openAccountDrawer(fake, w);
    const withDrawer = key('/', {}, document.body);
    await settle(fake);
    expect([withCtrl.defaultPrevented, withDrawer.defaultPrevented]).toEqual([false, false]);
    expect(document.activeElement?.getAttribute('data-test')).not.toBe('search-input');
  });
});

describe('rule 26: reader keys', () => {
  it('rule 26: Shift+N and Shift+P move the message cursor like n and p, prevented', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    const start = activeToggleId();
    expect(start).toBe('conv-01-m3');
    const back = key('P', { shiftKey: true });
    await settle(fake);
    expect(back.defaultPrevented).toBe(true);
    expect(activeToggleId()).toBe('conv-01-m2');
    const forward = key('N', { shiftKey: true });
    await settle(fake);
    expect(forward.defaultPrevented).toBe(true);
    expect(activeToggleId()).toBe('conv-01-m3');
  });

  it('rule 26: n and p from a focused toolbar button still move the message cursor (only e is button-blocked)', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const event = key('p');
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(activeToggleId()).toBe('conv-01-m2');
  });

  it('rule 26: j and k from a focused toolbar button still move the reader to the neighbouring conversation', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    const first = readerSubject(w);
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const next = key('j');
    await settle(fake);
    expect(next.defaultPrevented).toBe(true);
    const second = readerSubject(w);
    expect(second).not.toBe(first);
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const previous = key('k');
    await settle(fake);
    expect(previous.defaultPrevented).toBe(true);
    expect(readerSubject(w)).toBe(first);
  });

  it('rule 26: e from a message toggle is consumed without archiving when mailbox actions are disabled', async () => {
    const { fake, w } = await mountInbox({ gmail: true, mutationAccess: 'read_only' });
    await openReader(fake, w, 'conv-01');
    const archived = vi.spyOn(fake, 'setArchived');
    (w.get('.message-toggle').element as HTMLElement).focus();
    const event = key('e');
    await settle(fake);
    expect(event.defaultPrevented).toBe(false);
    expect(archived).not.toHaveBeenCalled();
    expect(isReaderOpen(w)).toBe(true);
  });

  it('rule 26: every other key is consumed by the reader: x selects nothing, Enter, ArrowDown, Shift+J and u are not prevented', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    const subject = readerSubject(w);
    (w.get('.message-toggle').element as HTMLElement).focus();
    const events = [key('x'), key('X', { shiftKey: true }), key('J', { shiftKey: true }), key('K', { shiftKey: true }),
      key('Enter'), key('ArrowDown'), key('ArrowUp'), key('u'), key('t')];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
    expect(isReaderOpen(w)).toBe(true);
    expect(readerSubject(w)).toBe(subject);
  });

  it('rule 26: o toggles only the focused message and Shift+O expands all, both prevented, from a toolbar button too', async () => {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const expanded = () => w.findAll('.message-toggle').map((toggle) => toggle.attributes('aria-expanded'));
    const open = key('O', { shiftKey: true });
    await settle(fake);
    expect(open.defaultPrevented).toBe(true);
    expect(expanded()).toEqual(['true', 'true', 'true']);
    const toggle = key('o');
    await settle(fake);
    expect(toggle.defaultPrevented).toBe(true);
    expect(expanded()).toEqual(['true', 'true', 'false']);
  });
});

describe('rule 27: selection keys', () => {
  it('rule 27: x dispatched on window toggles the focused row (a non-Node target is list-owned)', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const event = key('x', {}, window);
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(w.get('[data-test="selection-count"]').text()).toContain('1 selected');
    expect((w.get('[data-test="row-select-conv-02"]').element as HTMLInputElement).checked).toBe(true);
  });

  it('rule 27: Shift+X toggles like x, and a second x on the same row clears it', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const first = key('X', { shiftKey: true });
    await settle(fake);
    expect(first.defaultPrevented).toBe(true);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(true);
    const second = key('x');
    await settle(fake);
    expect(second.defaultPrevented).toBe(true);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
  });

  it('rule 27: x and Shift+J from a focused toolbar button neither select nor are prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const toggle = key('x');
    const extend = key('J', { shiftKey: true });
    await settle(fake);
    expect([toggle.defaultPrevented, extend.defaultPrevented]).toEqual([false, false]);
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
  });

  it('rule 27: Shift+K moves up one row and extends the range, prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-03').focus();
    const event = key('K', { shiftKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(focusedId()).toBe('conv-02');
    expect(w.get('[data-test="selection-count"]').text()).toContain('2 selected');
  });

  it('rule 27: Shift+K on the first row is prevented but moves nothing and selects nothing', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-01').focus();
    const event = key('K', { shiftKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(focusedId()).toBe('conv-01');
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
  });

  it('rule 27: a plain K or J (no Shift flag) is list focus movement only, never selection', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    key('j');
    await settle(fake);
    expect(focusedId()).toBe('conv-03');
    key('k');
    await settle(fake);
    expect(focusedId()).toBe('conv-02');
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
  });
});

describe('rule 29: list keys', () => {
  it('rule 29: j, k and the arrows still move list focus from a toolbar button, but Enter and e do nothing there', async () => {
    const { fake, w } = await mountInbox();
    const archived = vi.spyOn(fake, 'setArchived');
    rowEl(w, 'conv-02').focus();
    await settle(fake);
    const rail = w.get('[data-test="rail-drafts"]').element as HTMLElement;
    rail.focus();
    const down = key('ArrowDown');
    await settle(fake);
    expect(down.defaultPrevented).toBe(true);
    expect(focusedId()).toBe('conv-03');
    rail.focus();
    const enter = key('Enter');
    const archive = key('e');
    await settle(fake);
    expect([enter.defaultPrevented, archive.defaultPrevented]).toEqual([false, false]);
    expect(isReaderOpen(w)).toBe(false);
    expect(archived).not.toHaveBeenCalled();
    expect(title(w)).toBe('Inbox');
  });

  it('rule 29: e with mailbox actions disabled (Gmail read-only) is consumed without archiving', async () => {
    const { fake, w } = await mountInbox({ gmail: true, mutationAccess: 'read_only' });
    const archived = vi.spyOn(fake, 'setArchived');
    rowEl(w, 'conv-02').focus();
    const event = key('e');
    await settle(fake);
    expect(event.defaultPrevented).toBe(false);
    expect(archived).not.toHaveBeenCalled();
  });

  it('rule 29: keys with no list meaning (q, Space, Tab on a row) are not prevented', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const events = [key('q'), key(' '), key('Tab'), key('Home')];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(isReaderOpen(w)).toBe(false);
  });

  it('rule 29: an auto-repeating e still archives the focused row (the list e has no repeat guard)', async () => {
    const { fake, w } = await mountInbox();
    const archived = vi.spyOn(fake, 'setArchived');
    rowEl(w, 'conv-02').focus();
    const repeated = key('e', { repeat: true });
    await settle(fake);
    expect(repeated.defaultPrevented).toBe(true);
    expect(archived).toHaveBeenCalledTimes(1);
    expect(archived.mock.calls[0]![0]).toMatchObject({ archived: true });
  });
});

describe('rule 1: a reminder request in flight owns the keyboard', () => {
  async function holdReminderPut(): Promise<{ fake: BrowserFake; w: VueWrapper; picker: () => Element | null; release: () => void }> {
    const { fake, w } = await mountInbox();
    const pending = deferred<never>();
    vi.spyOn(fake.reminders!, 'put').mockImplementationOnce(() => pending.promise);
    key('h', {}, window);
    await settle(fake);
    (document.querySelector('#reminder-time-option-someday') as HTMLElement).click();
    await settle(fake);
    const schedule = [...document.querySelectorAll('button')].find((button) => button.textContent === 'Schedule reminder')!;
    schedule.click();
    await settle(fake);
    expect((document.querySelector('#reminder-time-input') as HTMLInputElement).disabled).toBe(true);
    (document.activeElement as HTMLElement).blur();
    return { fake, w, picker: () => document.querySelector('[data-reminder-picker]'), release: () => pending.reject({ kind: 'storage_unavailable' }) };
  }

  it('rule 1: Escape and Tab on body are prevented and hand focus back to the picker', async () => {
    const { fake, picker, release } = await holdReminderPut();
    expect(document.activeElement).toBe(document.body);
    const escape = key('Escape', {}, document.body);
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(picker()!.contains(document.activeElement)).toBe(true);
    (document.activeElement as HTMLElement).blur();
    const tab = key('Tab', {}, document.body);
    await settle(fake);
    expect(tab.defaultPrevented).toBe(true);
    expect(picker()!.contains(document.activeElement)).toBe(true);
    release();
    await settle(fake);
  });

  it('rule 1: every other key is consumed without prevention: j, e, /, c, z, g and Tab from a non-body target do nothing', async () => {
    const { fake, w, release } = await holdReminderPut();
    const archived = vi.spyOn(fake, 'setArchived');
    const events = [key('j', {}, document.body), key('e', {}, document.body), key('/', {}, document.body), key('c', {}, document.body),
      key('z', {}, document.body), key('g', {}, document.body), key('Tab', {}, window), key('Escape', { isComposing: true }, document.body)];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(archived).not.toHaveBeenCalled();
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(chordHint(w)).toBe('');
    expect(title(w)).toBe('Reminders');
    expect(document.querySelector('[data-reminder-picker]')).not.toBeNull();
    release();
    await settle(fake);
  });
});

describe('rule 2: the attachment chooser owns the keyboard', () => {
  async function openChooser(): Promise<{ fake: BrowserFake; w: VueWrapper }> {
    const { fake, w } = await mountInbox();
    await openReader(fake, w, 'conv-01');
    await w.get('[data-test="files-links"]').trigger('click');
    await settle(fake);
    expect(w.find('.attachment-chooser').exists()).toBe(true);
    (document.activeElement as HTMLElement).blur();
    return { fake, w };
  }

  it('rule 2: Escape on body is prevented and closes the chooser, leaving the reader open', async () => {
    const { fake, w } = await openChooser();
    expect(document.activeElement).toBe(document.body);
    const escape = key('Escape', {}, document.body);
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(w.find('.attachment-chooser').exists()).toBe(false);
    expect(isReaderOpen(w)).toBe(true);
  });

  it('rule 2: an IME Escape and every other key are consumed: the chooser stays and nothing is archived or moved', async () => {
    const { fake, w } = await openChooser();
    const archived = vi.spyOn(fake, 'setArchived');
    const subject = readerSubject(w);
    const events = [key('Escape', { isComposing: true }, document.body), key('j', {}, document.body), key('e', {}, document.body),
      key('s', {}, document.body), key('h', {}, document.body), key('Enter', {}, document.body), key('Tab', {}, document.body)];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(w.find('.attachment-chooser').exists()).toBe(true);
    expect(archived).not.toHaveBeenCalled();
    expect(readerSubject(w)).toBe(subject);
    expect(title(w)).toBe('Inbox');
  });
});

describe('rule 4: the split editor owns the keyboard', () => {
  async function openSplitEditor(): Promise<{ fake: BrowserFake; w: VueWrapper }> {
    const { fake, w } = await mountInbox();
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await settle(fake);
    await w.get('[data-test="action-query"]').setValue('create split');
    await w.get('[data-test="action-query"]').trigger('keydown', { key: 'Enter' });
    await settle(fake);
    expect(w.find('.split-editor').exists()).toBe(true);
    return { fake, w };
  }

  it('rule 4: Escape on body is prevented and closes the editor', async () => {
    const { fake, w } = await openSplitEditor();
    (document.activeElement as HTMLElement).blur();
    const escape = key('Escape', {}, document.body);
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(w.find('.split-editor').exists()).toBe(false);
  });

  it('rule 4: Escape with a modifier or during IME composition is not handled and the editor stays', async () => {
    const { fake, w } = await openSplitEditor();
    (document.activeElement as HTMLElement).blur();
    const events = [key('Escape', { ctrlKey: true }, document.body), key('Escape', { altKey: true }, document.body),
      key('Escape', { metaKey: true }, document.body), key('Escape', { isComposing: true }, document.body)];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(w.find('.split-editor').exists()).toBe(true);
  });

  it('rule 4: every other key is consumed and Tab stays native: j, e, x, s, c, /, g, ArrowLeft, z and Tab reach nothing', async () => {
    const { fake, w } = await openSplitEditor();
    const archived = vi.spyOn(fake, 'setArchived');
    const starred = vi.spyOn(fake, 'setStarred');
    const undo = vi.spyOn(fake, 'undoOperation');
    (document.activeElement as HTMLElement).blur();
    const events = ['j', 'e', 'x', 's', 'c', '/', 'g', 'ArrowLeft', 'z', 'Tab', 'Enter'].map((name) => key(name, {}, document.body));
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(archived).not.toHaveBeenCalled();
    expect(starred).not.toHaveBeenCalled();
    expect(undo).not.toHaveBeenCalled();
    expect(w.find('.split-editor').exists()).toBe(true);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    expect(navigatorOpen(w)).toBe(false);
    expect(chordHint(w)).toBe('');
    expect(w.find('[data-test="selection-count"]').exists()).toBe(false);
  });

  it('rule 4: while a save is in flight, Escape is prevented but does not close, and Enter on body is prevented', async () => {
    const { fake, w } = await openSplitEditor();
    const first = (await fake.listConversations()).conversations[0]!;
    const pending = deferred<never>();
    vi.spyOn(fake, 'saveSavedSplit').mockImplementationOnce(() => pending.promise);
    await w.get('[data-test="split-name"]').setValue('Clients');
    await w.get('[data-test="split-value"]').setValue(first.primaryCorrespondent!.mailbox);
    await w.get('[data-test="split-save"]').trigger('submit');
    await settle(fake);
    (document.activeElement as HTMLElement).blur();
    const enter = key('Enter', {}, document.body);
    const escape = key('Escape', {}, document.body);
    const other = key('j', {}, document.body);
    await settle(fake);
    expect(enter.defaultPrevented).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    expect(other.defaultPrevented).toBe(false);
    expect(w.find('.split-editor').exists()).toBe(true);
    pending.reject({ kind: 'storage_unavailable' });
    await settle(fake);
  });
});

describe('rule 5 and rule 7: native Cmd+O and Cmd+K', () => {
  it('rule 5: native Cmd+O is not handled from the list, with Shift, or from an editable field, even in the reader', async () => {
    const { fake, w } = await mountInbox({ mode: 'native' });
    rowEl(w, 'conv-02').focus();
    const fromList = key('o', { metaKey: true });
    await settle(fake);
    expect(fromList.defaultPrevented).toBe(false);
    expect(w.find('.attachment-chooser').exists()).toBe(false);
    await openReader(fake, w, 'conv-01');
    const shifted = key('O', { metaKey: true, shiftKey: true });
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const fromField = key('o', { metaKey: true });
    await settle(fake);
    expect([shifted.defaultPrevented, fromField.defaultPrevented]).toEqual([false, false]);
    expect(w.find('.attachment-chooser').exists()).toBe(false);
  });

  it('rule 5: native Cmd+O in the reader opens the chooser even from a focused toolbar button, prevented', async () => {
    const { fake, w } = await mountInbox({ mode: 'native' });
    await openReader(fake, w, 'conv-01');
    (w.get('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    const event = key('o', { metaKey: true });
    await settle(fake);
    expect(event.defaultPrevented).toBe(true);
    expect(w.find('.attachment-chooser').exists()).toBe(true);
  });

  it('rule 7: native Cmd+K opens the palette, prevented, even from a toolbar button; Cmd+Shift+K and browser preview do not', async () => {
    const native = await mountInbox({ mode: 'native' });
    (native.w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const shifted = key('K', { metaKey: true, shiftKey: true });
    await settle(native.fake);
    expect(shifted.defaultPrevented).toBe(false);
    expect(native.w.find('[data-test="action-query"]').exists()).toBe(false);
    const event = key('k', { metaKey: true });
    await settle(native.fake);
    expect(event.defaultPrevented).toBe(true);
    expect(native.w.find('[data-test="action-query"]').exists()).toBe(true);
    native.w.unmount();
    app = null;
    document.body.innerHTML = '';
    const preview = await mountInbox();
    const ignored = key('k', { metaKey: true }, document.body);
    await settle(preview.fake);
    expect(ignored.defaultPrevented).toBe(false);
    expect(preview.w.find('[data-test="action-query"]').exists()).toBe(false);
  });
});

describe('rule 9: the chord grace window', () => {
  it('rule 9: a late h just after the window lapses is swallowed (prevented, no Reminders), and the swallow is one-shot', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    key('g');
    vi.advanceTimersByTime(1500 + 100);
    const late = key('h');
    await settle(fake);
    expect(late.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Inbox');
    const again = key('h');
    await settle(fake);
    expect(again.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Reminders');
  });

  it('rule 9: a late key in an editable field is not swallowed but still ends the grace, so a following e archives', async () => {
    const { fake, w } = await mountInbox();
    const archived = vi.spyOn(fake, 'setArchived');
    rowEl(w, 'conv-02').focus();
    key('g');
    vi.advanceTimersByTime(1500 + 100);
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    const typed = key('e', {}, input);
    expect(typed.defaultPrevented).toBe(false);
    rowEl(w, 'conv-02').focus();
    const archive = key('e');
    await settle(fake);
    expect(archive.defaultPrevented).toBe(true);
    expect(archived).toHaveBeenCalledTimes(1);
  });

  it('rule 9: a late Shift+E is not a chord key, so it ends the grace and runs its own meaning', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    key('g');
    vi.advanceTimersByTime(1500 + 100);
    const late = key('E', { shiftKey: true });
    await settle(fake);
    expect(late.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Inbox');
    const plain = key('e');
    await settle(fake);
    expect(plain.defaultPrevented).toBe(true);
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(false);
  });
});

describe('rule 10: a visible compose surface owns Escape and every other key', () => {
  async function openCard(): Promise<{ fake: BrowserFake; w: VueWrapper }> {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    key('c');
    await settle(fake);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
    return { fake, w };
  }

  it('rule 10: Escape typed inside the card body closes it through the protected flush, prevented', async () => {
    const { fake, w } = await openCard();
    const body = w.get('[data-test="draft-body"]').element as HTMLTextAreaElement;
    body.focus();
    const escape = key('Escape');
    await settle(fake);
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
  });

  it('rule 10: Escape with Ctrl, Alt or Meta or during IME composition does not close the card', async () => {
    const { fake, w } = await openCard();
    const events = [key('Escape', { ctrlKey: true }), key('Escape', { altKey: true }), key('Escape', { metaKey: true }), key('Escape', { isComposing: true })];
    await settle(fake);
    expect(events.map((event) => event.defaultPrevented)).toEqual(events.map(() => false));
    expect(w.find('[data-test="compose-card"]').exists()).toBe(true);
  });

  it('rule 10: Shift+Escape closes the card like Escape (Shift is not checked)', async () => {
    const { fake, w } = await openCard();
    const escape = key('Escape', { shiftKey: true });
    await settle(fake);
    await settle(fake);
    expect(escape.defaultPrevented).toBe(true);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
  });

  it('rule 10: Escape from a focused card button closes the card, and the next Escape finds a plain Inbox', async () => {
    const { fake, w } = await openCard();
    (w.get('[data-test="close-composer"]').element as HTMLElement).focus();
    const first = key('Escape');
    await settle(fake);
    await settle(fake);
    expect(first.defaultPrevented).toBe(true);
    expect(w.find('[data-test="compose-card"]').exists()).toBe(false);
    document.body.focus();
    const second = key('Escape', {}, document.body);
    await settle(fake);
    expect(second.defaultPrevented).toBe(false);
  });
});

describe('rule 17: split Tab navigation', () => {
  it('rule 17: Tab moves Inbox to the saved split and Shift+Tab back, prevented, and never wraps at either end', async () => {
    const { fake, w } = await mountInbox({ savedSplit: true });
    expect(w.find('[data-test="split-saved"]').exists()).toBe(true);
    rowEl(w, 'conv-01').focus();
    const backAtStart = key('Tab', { shiftKey: true });
    expect(backAtStart.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Inbox');
    const forward = key('Tab');
    await settle(fake);
    expect(forward.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Clients');
    const row = document.querySelector('.inbox-row') as HTMLElement;
    row.focus();
    const forwardAtEnd = key('Tab');
    await settle(fake);
    expect(forwardAtEnd.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Clients');
    const back = key('Tab', { shiftKey: true });
    await settle(fake);
    expect(back.defaultPrevented).toBe(true);
    expect(title(w)).toBe('Inbox');
  });

  it('rule 17: without a saved split Tab on a row is not handled', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const forward = key('Tab');
    const backward = key('Tab', { shiftKey: true });
    await settle(fake);
    expect([forward.defaultPrevented, backward.defaultPrevented]).toEqual([false, false]);
    expect(title(w)).toBe('Inbox');
  });

  it('rule 17: Tab from a toolbar button, from body, with a modifier, or in the reader does not switch splits', async () => {
    const { fake, w } = await mountInbox({ savedSplit: true });
    (w.get('[data-test="rail-drafts"]').element as HTMLElement).focus();
    const fromButton = key('Tab');
    const fromBody = key('Tab', {}, document.body);
    rowEl(w, 'conv-01').focus();
    const withCtrl = key('Tab', { ctrlKey: true });
    await settle(fake);
    expect([fromButton.defaultPrevented, fromBody.defaultPrevented, withCtrl.defaultPrevented]).toEqual([false, false, false]);
    expect(title(w)).toBe('Inbox');
    await openReader(fake, w, 'conv-01');
    (w.get('.message-toggle').element as HTMLElement).focus();
    const inReader = key('Tab');
    await settle(fake);
    expect(inReader.defaultPrevented).toBe(false);
    expect(isReaderOpen(w)).toBe(true);
    expect(title(w)).toBe('Inbox');
  });
});

describe('rule 18: [ and ] in the Reminders list', () => {
  async function openReminders(): Promise<{ fake: BrowserFake; w: VueWrapper }> {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    key('g');
    key('h');
    await settle(fake);
    expect(title(w)).toBe('Reminders');
    return { fake, w };
  }
  const selectedTab = (w: VueWrapper): string => w.findAll('[role="tab"]').find((tab) => tab.attributes('aria-selected') === 'true')?.text() ?? '';

  it('rule 18: ] and [ from body step the destination tab, prevented', async () => {
    const { fake, w } = await openReminders();
    (document.activeElement as HTMLElement | null)?.blur();
    const first = selectedTab(w);
    const next = key(']', {}, document.body);
    await settle(fake);
    expect(next.defaultPrevented).toBe(true);
    const second = selectedTab(w);
    expect(second).not.toBe(first);
    const previous = key('[', {}, document.body);
    await settle(fake);
    expect(previous.defaultPrevented).toBe(true);
    expect(selectedTab(w)).toBe(first);
  });

  it('rule 18: ] from a focused tab button is not handled (a button owns it)', async () => {
    const { fake, w } = await openReminders();
    const first = selectedTab(w);
    (w.findAll('[role="tab"]')[0]!.element as HTMLElement).focus();
    const event = key(']');
    await settle(fake);
    expect(event.defaultPrevented).toBe(false);
    expect(selectedTab(w)).toBe(first);
  });

  it('rule 18: ] outside the Reminders list is not handled', async () => {
    const { fake, w } = await mountInbox();
    rowEl(w, 'conv-02').focus();
    const event = key(']');
    await settle(fake);
    expect(event.defaultPrevented).toBe(false);
    expect(title(w)).toBe('Inbox');
  });
});
