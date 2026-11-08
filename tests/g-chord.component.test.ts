import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import { createDiscoveryFixture } from './discovery.fixture';
import { createBrowserFakeMailClient, flushMacrotasks, useGmailMode } from './helpers';

// The g-chord must never fall through to the plain-key meaning of its second
// key (e = Archive). Timers are faked after mount so only the chord timers are
// under test control (flushPromises keeps its real scheduler).
const WINDOW_MS = 1500;
const GRACE_MS = 600;

let wrapper: VueWrapper | null = null;
beforeEach(() => { vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
afterEach(() => { vi.useRealTimers(); wrapper?.unmount(); wrapper = null; });

function key(name: string, options: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: name, ...options });
  (document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}
async function setup() {
  vi.useRealTimers();
  const fixture = createDiscoveryFixture();
  await fixture.seedDone();
  wrapper = mount(App, { props: { client: fixture.client, mode: 'browser-preview' }, attachTo: document.body });
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
    key('g'); vi.advanceTimersByTime(WINDOW_MS - 100); key('e'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    expect(archived(fixture)).toEqual([]);
  });

  it('a late e just after the window lapses is swallowed: no Archive and no Done', async () => {
    const { fixture, w } = await setup();
    key('g'); vi.advanceTimersByTime(WINDOW_MS + 100);
    const late = key('e'); await flushPromises();
    expect(late.defaultPrevented).toBe(true);
    expect(archived(fixture)).toEqual([]);
    expect(fixture.doneCalls()).toBe(0);
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');
    // The swallow is one-shot: the next deliberate e archives again.
    key('e'); await flushPromises();
    expect(archived(fixture)).toEqual(['read-02']);
  });

  it('after the grace window a plain e archives as usual', async () => {
    const { fixture } = await setup();
    key('g'); vi.advanceTimersByTime(WINDOW_MS + GRACE_MS + 1);
    key('e'); await flushPromises();
    expect(archived(fixture)).toEqual(['read-02']);
  });

  it('another key during the grace window ends it, so a following e archives', async () => {
    const { fixture } = await setup();
    key('g'); vi.advanceTimersByTime(WINDOW_MS + 100);
    key('j'); key('e'); await flushPromises(); // j moves focus to the next row
    expect(archived(fixture)).toEqual(['read-03']);
  });

  it('Escape cancels the armed chord, is consumed, and leaves no grace behind', async () => {
    const { fixture, w } = await setup();
    key('g');
    expect(w.get('[data-test="chord-hint"]').text()).toBe('');
    const escape = key('Escape'); await flushPromises();
    expect(escape.defaultPrevented).toBe(true);
    expect(w.get('[data-test="chord-hint"]').element.textContent).toBe('');
    key('e'); await flushPromises();
    expect(fixture.doneCalls()).toBe(0);
    expect(archived(fixture)).toEqual(['read-02']);
  });

  it('shows a polite hint only while armed and announces the available keys', async () => {
    const { w } = await setup();
    const hint = () => w.get('[data-test="chord-hint"]');
    expect(hint().attributes('role')).toBe('status');
    expect(hint().element.textContent).toBe('');
    key('g'); await flushPromises();
    expect(hint().find('[aria-hidden="true"]').text()).toBe('g…');
    expect(hint().find('.visually-hidden').text()).toContain('Press E for Done');
    expect(hint().find('.visually-hidden').text()).toContain('Escape to cancel');
    vi.advanceTimersByTime(WINDOW_MS); await flushPromises();
    expect(hint().element.textContent).toBe('');
  });

  it('keeps the hint cleared and the chord disarmed when the second key completes it', async () => {
    const { w } = await setup();
    key('g'); key('e'); await flushPromises();
    expect(w.get('[data-test="chord-hint"]').element.textContent).toBe('');
  });

  it('IME and modifier keys still cancel without a grace swallow', async () => {
    const { fixture } = await setup();
    key('g'); key('Process', { isComposing: true }); key('e'); await flushPromises();
    expect(archived(fixture)).toEqual(['read-02']);
  });
});

// `g a` -> Go to Account, in the same chord machinery, Gmail mode only.
async function setupGmail(patch: Parameters<typeof useGmailMode>[1] = {}, gmailMode = true) {
  vi.useRealTimers();
  const fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
  if (gmailMode) useGmailMode(fake, patch);
  wrapper = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
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
    key('g'); vi.advanceTimersByTime(WINDOW_MS - 100); const second = key('a'); await flushPromises();
    expect(second.defaultPrevented).toBe(true);
    expect(hasAccountDrawer(w)).toBe(true);
    expect(fake.controls.activity()).toHaveLength(0);
  });

  it('announces A for Account in the hint, and only in Gmail mode', async () => {
    const { w } = await setupGmail();
    key('g'); await flushPromises();
    expect(w.get('[data-test="chord-hint"] .visually-hidden').text()).toBe('g pressed. Press E for Done or A for Account, Escape to cancel.');
    w.unmount(); wrapper = null;
    const { w: fixtureWrapper } = await setupGmail({}, false);
    key('g'); await flushPromises();
    expect(fixtureWrapper.get('[data-test="chord-hint"] .visually-hidden').text()).toBe('g pressed. Press E for Done, Escape to cancel.');
  });

  it('does nothing in fixture mode: a is an ordinary key there', async () => {
    const { fake, w } = await setupGmail({}, false);
    key('g'); const second = key('a'); await flushPromises();
    expect(second.defaultPrevented).toBe(false);
    expect(w.find('[data-test="account-panel"]').exists()).toBe(false);
    expect(fake.controls.activity()).toHaveLength(0);
  });

  it('a late a just after the window lapses is swallowed, then the grace ends', async () => {
    const { w } = await setupGmail();
    key('g'); vi.advanceTimersByTime(WINDOW_MS + 100);
    const late = key('a'); await flushPromises();
    expect(late.defaultPrevented).toBe(true);
    expect(hasAccountDrawer(w)).toBe(false);
  });

  it('g e still opens Done in Gmail mode; Escape and a modified a cancel the chord', async () => {
    const { w } = await setupGmail();
    key('g'); key('e'); await flushPromises();
    expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    w.unmount(); wrapper = null;

    const second = await setupGmail();
    key('g'); key('Escape'); key('a'); await flushPromises();
    expect(hasAccountDrawer(second.w)).toBe(false);
    key('g'); key('a', { metaKey: true }); await flushPromises();
    expect(hasAccountDrawer(second.w)).toBe(false);
  });

  it('works with no account at all (disconnected)', async () => {
    const { w } = await setupGmail({ connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
    document.body.focus();
    key('g'); key('a'); await flushPromises();
    expect(hasAccountDrawer(w)).toBe(true);
  });
});
