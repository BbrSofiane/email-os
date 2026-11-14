import { createBrowserFakeMailClient, flushMacrotasks, mountApp, press, useGmailMode } from './helpers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';

import { createDiscoveryFixture } from './support/fixtures/discovery.fixture';

// The g-chord must never fall through to the plain-key meaning of its second
// key (e = Archive). Timers are faked after mount so only the chord timers are
// under test control (flushPromises keeps its real scheduler).
const WINDOW_MS = 1500;
const GRACE_MS = 600;

let wrapper: VueWrapper | null = null;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); wrapper?.unmount(); wrapper = null; });

async function setup() {
  vi.useRealTimers();
  const fixture = createDiscoveryFixture();
  await fixture.seedDone();
  wrapper = mountApp(fixture.client, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  (wrapper.get('[data-test="conversation-row-read-02"]').element as HTMLElement).focus();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { fixture, w: wrapper };
}
const archived = (fixture: Awaited<ReturnType<typeof setup>>['fixture']) =>
  fixture.controls.archiveCommands.map((command) => command.conversation.conversationId);

describe('g-chord safety', () => {
  it('g then e inside the window opens Done, even when the second key is slow', async () => {
    const { fixture, w } = await setup();
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(WINDOW_MS - 100); press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    expect(archived(fixture)).toEqual([]);
  });

  it('a late e just after the window lapses is swallowed: no Archive and no Done', async () => {
    const { fixture, w } = await setup();
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(WINDOW_MS + 100);
    const late = press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(late.defaultPrevented).toBe(true);
    expect(archived(fixture)).toEqual([]);
    expect(fixture.doneCalls()).toBe(0);
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    // The swallow is one-shot: the next deliberate e archives again.
    press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(archived(fixture)).toEqual(['read-02']);
  });

  it('after the grace window a plain e archives as usual', async () => {
    const { fixture } = await setup();
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(WINDOW_MS + GRACE_MS + 1);
    press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(archived(fixture)).toEqual(['read-02']);
  });

  it('another key during the grace window ends it, so a following e archives', async () => {
    const { fixture } = await setup();
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(WINDOW_MS + 100);
    press('j', { bubbles: true, cancelable: true }); press('e', { bubbles: true, cancelable: true }); await flushPromises(); // j moves focus to the next row
    expect(archived(fixture)).toEqual(['read-03']);
  });

  it('Escape cancels the armed chord, is consumed, and leaves no grace behind', async () => {
    const { fixture, w } = await setup();
    press('g', { bubbles: true, cancelable: true });
    expect(w.get('[data-test="chord-hint"]').text()).toBe('');
    const escape = press('Escape', { bubbles: true, cancelable: true }); await flushPromises();
    expect(escape.defaultPrevented).toBe(true);
    expect(w.get('[data-test="chord-hint"]').element.textContent).toBe('');
    press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(fixture.doneCalls()).toBe(0);
    expect(archived(fixture)).toEqual(['read-02']);
  });

  it('shows a polite hint only while armed and announces the available keys', async () => {
    const { w } = await setup();
    const hint = () => w.get('[data-test="chord-hint"]');
    expect(hint().attributes('role')).toBe('status');
    expect(hint().element.textContent).toBe('');
    press('g', { bubbles: true, cancelable: true }); await flushPromises();
    expect(hint().find('[aria-hidden="true"]').text()).toBe('g…');
    expect(hint().find('.visually-hidden').text()).toContain('Press E for Done');
    expect(hint().find('.visually-hidden').text()).toContain('Escape to cancel');
    vi.advanceTimersByTime(WINDOW_MS); await flushPromises();
    expect(hint().element.textContent).toBe('');
  });

  it('keeps the hint cleared and the chord disarmed when the second key completes it', async () => {
    const { w } = await setup();
    press('g', { bubbles: true, cancelable: true }); press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="chord-hint"]').element.textContent).toBe('');
  });

  it('IME and modifier keys still cancel without a grace swallow', async () => {
    const { fixture } = await setup();
    press('g', { bubbles: true, cancelable: true }); press('Process', { bubbles: true, cancelable: true,  isComposing: true  }); press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(archived(fixture)).toEqual(['read-02']);
  });
});

// `g a` -> Go to Account, in the same chord machinery, Gmail mode only.
async function setupGmail(patch: Parameters<typeof useGmailMode>[1] = {}, gmailMode = true) {
  vi.useRealTimers();
  const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
  if (gmailMode) useGmailMode(fake, patch);
  wrapper = mountApp(fake, 'browser-preview', { attachTo: document.body });
  await flushPromises();
  await flushMacrotasks(2);
  await flushPromises();
  wrapper.find('[data-test="conversation-row-conv-02"]').exists()
    && (wrapper.get('[data-test="conversation-row-conv-02"]').element as HTMLElement).focus();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  return { fake, w: wrapper };
}
const hasAccountDrawer = (w: VueWrapper) => w.find('[data-test="account-panel"]').exists();

describe('g a (Go to Account, Gmail only)', () => {
  it('opens the Account drawer, even with a slow second key, and does not touch the mailbox', async () => {
    const { fake, w } = await setupGmail({ mutationAccess: 'enabled' });
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(WINDOW_MS - 100); const second = press('a', { bubbles: true, cancelable: true }); await flushPromises();
    expect(second.defaultPrevented).toBe(true);
    expect(hasAccountDrawer(w)).toBe(true);
    expect(fake.controls.activity()).toHaveLength(0);
  });

  it('announces A for Account in the hint, and only in Gmail mode', async () => {
    const { w } = await setupGmail();
    press('g', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="chord-hint"] .visually-hidden').text()).toBe('g pressed. Press E for Done, T for Trash, D for Drafts, H for Reminders or A for Account, Escape to cancel.');
    w.unmount(); wrapper = null;
    const { w: fixtureWrapper } = await setupGmail({}, false);
    press('g', { bubbles: true, cancelable: true }); await flushPromises();
    expect(fixtureWrapper.get('[data-test="chord-hint"] .visually-hidden').text()).toBe('g pressed. Press E for Done, D for Drafts or H for Reminders, Escape to cancel.');
  });

  it('does nothing in fixture mode: a is an ordinary key there', async () => {
    const { fake, w } = await setupGmail({}, false);
    press('g', { bubbles: true, cancelable: true }); const second = press('a', { bubbles: true, cancelable: true }); await flushPromises();
    expect(second.defaultPrevented).toBe(false);
    expect(w.find('[data-test="account-panel"]').exists()).toBe(false);
    expect(fake.controls.activity()).toHaveLength(0);
  });

  it('a late a just after the window lapses is swallowed, then the grace ends', async () => {
    const { w } = await setupGmail();
    press('g', { bubbles: true, cancelable: true }); vi.advanceTimersByTime(WINDOW_MS + 100);
    const late = press('a', { bubbles: true, cancelable: true }); await flushPromises();
    expect(late.defaultPrevented).toBe(true);
    expect(hasAccountDrawer(w)).toBe(false);
  });

  it('g e still opens Done in Gmail mode; Escape and a modified a cancel the chord', async () => {
    const { w } = await setupGmail();
    press('g', { bubbles: true, cancelable: true }); press('e', { bubbles: true, cancelable: true }); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    w.unmount(); wrapper = null;

    const second = await setupGmail();
    press('g', { bubbles: true, cancelable: true }); press('Escape', { bubbles: true, cancelable: true }); press('a', { bubbles: true, cancelable: true }); await flushPromises();
    expect(hasAccountDrawer(second.w)).toBe(false);
    press('g', { bubbles: true, cancelable: true }); press('a', { bubbles: true, cancelable: true, metaKey: true }); await flushPromises();
    expect(hasAccountDrawer(second.w)).toBe(false);
  });

  it('works with no account at all (disconnected)', async () => {
    const { w } = await setupGmail({ connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
    document.body.focus();
    press('g', { bubbles: true, cancelable: true }); press('a', { bubbles: true, cancelable: true }); await flushPromises();
    expect(hasAccountDrawer(w)).toBe(true);
  });
});
