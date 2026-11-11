/**
 * Drawer panels mounted by App (and the list contexts that left them): one region name and one visible h2 per drawer,
 * no nested landmark or repeated heading, the shared row keyboard model that
 * never reaches mailbox shortcuts, and Escape returning focus to the rail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import { createBrowserFakeMailClient } from '../../src/lib/ipc/browser-fake';
import type { PutReminder, Reminder } from '../../src/lib/ipc/client';
import { mountApp, press, useGmailMode } from '../helpers';
import { advanceUiUntil, useUiTestClock } from '../support/timers';

let app: VueWrapper | null = null;
afterEach(() => { app?.unmount(); app = null; document.body.innerHTML = ''; });
beforeEach(useUiTestClock);
afterEach(() => vi.useRealTimers());



async function mountPanels(fake = createBrowserFakeMailClient(), mode: 'native' | 'browser-preview' = 'browser-preview') {
  app = mountApp(fake, mode, { attachTo: document.body });
  await flushPromises();
  return app;
}
function drawerOf(w: VueWrapper) { return w.get('[data-test="utility-drawer"]'); }

function expectOneHeading(w: VueWrapper, region: string, heading: string) {
  const drawer = drawerOf(w);
  expect(drawer.attributes('aria-label')).toBe(region);
  expect(drawer.findAll('h2').map((h) => h.text())).toEqual([heading]);
  expect(drawer.findAll('aside')).toHaveLength(0);
  expect(drawer.findAll('[role="complementary"]')).toHaveLength(0);
  // Only the drawer itself is a named region in the drawer: panels add none.
  expect(drawer.findAll('section[aria-label], [role="region"]')).toHaveLength(0);
}

describe('drawer headings and landmarks', () => {
  it('Activity: one region name, one visible h2, no aside, no repeated title', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountPanels(fake);
    press('e', { bubbles: true, cancelable: true }, window); await flushPromises();
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    expectOneHeading(w, 'Operation activity', 'Activity');
    expect(drawerOf(w).findAll('h3').map((h) => h.text())).not.toContain('Activity');
  });

  it('Drafts is a list context, not a drawer: no drawer opens, the one h1 names the list and the editor is the inline card with its own h2', async () => {
    const w = await mountPanels();
    await w.get('[data-test="rail-drafts"]').trigger('click');
    await advanceUiUntil(() => w.find('[data-test="drafts-pane"]').exists());
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.findAll('h1').map((h) => h.text())).toEqual(['Drafts']);
    expect(w.get('[data-test="inbox-title"]').classes()).not.toContain('visually-hidden');
    expect(w.get('[data-test="rail-drafts"]').attributes('aria-current')).toBe('page');
    expect(w.get('[data-test="rail-drafts"]').attributes('aria-expanded')).toBeUndefined();
    await w.get('[data-test="new-draft"]').trigger('click');
    await advanceUiUntil(() => w.find('[data-test="compose-card"]').exists());
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.get('[data-test="compose-card"]').findAll('h2').map((h) => h.text())).toEqual(['New Message']);
    expect(w.get('[data-test="rail-drafts"]').attributes('aria-current')).toBeUndefined();
  });

  it('Reminders is a list context, not a drawer (fixture mode): no drawer opens and the one h1 names the list', async () => {
    const fake = createBrowserFakeMailClient();
    fake.reminders = { list: vi.fn(async () => [] as Reminder[]), put: vi.fn(async (c: PutReminder) => ({ ...c, subject: 's', revision: 1, phase: 'removing' as const }) as Reminder), cancel: vi.fn() };
    const w = await mountPanels(fake, 'native');
    await w.get('[data-test="reminders-trigger"]').trigger('click');
    await advanceUiUntil(() => w.find('[data-test="reminders-panel"]').exists());
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.findAll('h1').map((h) => h.text())).toEqual(['Reminders']);
    expect(w.get('[data-test="reminders-trigger"]').attributes('aria-current')).toBe('page');
  });

  it('Cached Trash is a list context, not a drawer: the rail opens no drawer and the one h1 names the list', async () => {
    const fake = createBrowserFakeMailClient();
    useGmailMode(fake, { mutationAccess: 'enabled' });
    fake.controls.markTriage('conv-04', 'trash');
    const w = await mountPanels(fake);
    await w.get('[data-test="rail-trash"]').trigger('click');
    await advanceUiUntil(() => w.find('[data-test="conversation-row-conv-04"]').exists());
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.findAll('h1').map((h) => h.text())).toEqual(['Cached Trash']);
    expect(w.find('[data-test="inbox-title"]').classes()).not.toContain('visually-hidden');
  });
});

describe('drawer keyboard', () => {
  it('J/K/arrows move between drawer rows and never reach mailbox shortcuts; Escape closes and focuses the rail toggle', async () => {
    const fake = createBrowserFakeMailClient();
    const archive = vi.spyOn(fake, 'setArchived');
    const read = vi.spyOn(fake, 'setRead');
    const w = await mountPanels(fake);
    // Two operations, so Activity has two rows.
    press('e', { bubbles: true, cancelable: true }, window); await flushPromises();
    press('j', { bubbles: true, cancelable: true }, window); press('e', { bubbles: true, cancelable: true }, window); await flushPromises();
    const callsBefore = archive.mock.calls.length;
    expect(callsBefore).toBeGreaterThanOrEqual(2);
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    const rows = drawerOf(w).findAll('[data-drawer-row]');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    (rows[0]!.element as HTMLElement).focus();
    press('j', { bubbles: true, cancelable: true }, rows[0]!.element);
    expect(document.activeElement).toBe(rows[1]!.element);
    press('k', { bubbles: true, cancelable: true }, rows[1]!.element);
    expect(document.activeElement).toBe(rows[0]!.element);
    press('ArrowDown', { bubbles: true, cancelable: true }, rows[0]!.element);
    expect(document.activeElement).toBe(rows[1]!.element);
    // Mailbox keys typed inside the drawer do nothing to mail.
    for (const letter of ['e', 'E', 'u', 'U', 'x', 'z', 's']) press(letter, { bubbles: true, cancelable: true }, document.activeElement ?? window);
    await flushPromises();
    expect(archive.mock.calls.length).toBe(callsBefore);
    expect(read).not.toHaveBeenCalled();
    // Escape closes the drawer and returns focus to the rail toggle.
    press('Escape', { bubbles: true, cancelable: true }, document.activeElement ?? window); await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect((document.activeElement as HTMLElement | null)?.dataset.test).toBe('rail-activity');
  });

  it('names mail by its cached subject in Activity once the row has been seen', async () => {
    const fake = createBrowserFakeMailClient();
    const w = await mountPanels(fake);
    const firstSubject = w.get('[data-test^="conversation-row-"]').text();
    press('e', { bubbles: true, cancelable: true }, window); await flushPromises();
    await w.get('[data-test="rail-activity"]').trigger('click'); await flushPromises();
    const row = drawerOf(w).get('[data-test^="activity-open-"]');
    expect(row.text()).not.toContain('Unknown conversation');
    expect(row.attributes('title')).toMatch(/^Conversation /);
    const subject = row.get('.drawer-subject').text();
    expect(subject.length).toBeGreaterThan(0);
    expect(firstSubject).toContain(subject);
  });
});
