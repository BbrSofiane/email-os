/**
 * Smooth J/K reader navigation: neighbor prefetch + cache, delayed loading
 * presentation, list-row identity while loading, always-mounted (disabled)
 * header actions, stable focus and scroll. Synthetic fixture only; no writes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { effectScope } from 'vue';
import App from '../src/App.vue';
import ContactPane from '../src/components/ContactPane.vue';
import {
  DETAIL_CACHE_MAX,
  DETAIL_CACHE_TTL_MS,
  READER_LOADING_DELAY_MS,
  useMailbox,
} from '../src/composables/useMailbox';
import type { Conversation, ConversationRef, MailClient } from '../src/lib/ipc/client';
import { deferred, openUtilityDrawer } from './helpers';
import { createReaderFixtureClient, readerRef, type ReaderFixture } from './reader.fixture';

type Gate = ReturnType<typeof deferred<Conversation>>;

let fixture: ReaderFixture;
let wrapper: VueWrapper | null = null;
let calls: string[];
let gates: Map<string, Gate[]>;
let client: MailClient;

/** Next call for `id` waits on the returned gate (FIFO per conversation). */
function gate(id: string): Gate {
  const entry = deferred<Conversation>();
  gates.set(id, [...(gates.get(id) ?? []), entry]);
  return entry;
}

function detailOf(id: string): Promise<Conversation> {
  return fixture.client.getConversation(readerRef(id));
}

function key(value: string): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: value, bubbles: true, cancelable: true }));
}

async function settle(): Promise<void> {
  await flushPromises();
  await vi.advanceTimersByTimeAsync(0);
  await flushPromises();
}

async function openReader(w: VueWrapper, id = 'read-01'): Promise<void> {
  const row = w.get(`[data-test="conversation-row-${id}"]`);
  (row.element as HTMLElement).focus();
  await row.trigger('focusin');
  key('Enter');
  await settle();
}

function mountApp(): VueWrapper {
  wrapper = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
  return wrapper;
}

function subject(): string | null {
  return document.querySelector('.reader-subject')?.textContent ?? null;
}

const loadingShown = (): boolean => document.querySelector('[data-test="reader-loading"]') !== null;
const focusName = (): string | null => document.activeElement?.getAttribute('data-test') ?? null;
const headerIds = ['reader-archive-toggle', 'files-links', 'prepare-reply', 'reader-prev', 'reader-next'];
const headerButton = (id: string): HTMLButtonElement | null => document.querySelector(`[data-test="${id}"]`);

/** Records every DOM mutation batch (a stand-in for painted frames) and every focus target. */
function recordFrames() {
  const frames: Array<{ subject: string | null; loading: boolean; messages: number; icons: number }> = [];
  const focus: Array<string | null> = [];
  const snap = () => ({
    subject: subject(),
    loading: loadingShown(),
    messages: document.querySelectorAll('[data-test="reader-messages"] > li').length,
    icons: headerIds.filter((id) => headerButton(id)).length,
  });
  const observer = new MutationObserver(() => frames.push(snap()));
  observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  const onFocus = (event: FocusEvent): void => {
    focus.push((event.target as HTMLElement).getAttribute?.('data-test') ?? null);
  };
  document.addEventListener('focusin', onFocus);
  return {
    frames,
    focus,
    stop: () => { observer.disconnect(); document.removeEventListener('focusin', onFocus); },
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  fixture = createReaderFixtureClient();
  calls = [];
  gates = new Map();
  const real = fixture.client.getConversation.bind(fixture.client);
  client = {
    ...fixture.client,
    getConversation: (target: ConversationRef, searchContext?: boolean) => {
      calls.push(target.conversationId);
      const held = gates.get(target.conversationId)?.shift();
      return held ? held.promise : real(target, searchContext);
    },
  };
});

afterEach(() => {
  wrapper?.unmount();
  wrapper = null;
  vi.useRealTimers();
});

describe('delayed loading presentation (J/K)', () => {
  it('renders no intermediate loading frame when the response lands inside the delay', async () => {
    const slow = gate('read-02'); // the prefetch of the next neighbor stays in flight
    const w = mountApp();
    await settle();
    await openReader(w);
    expect(subject()).toBe('Reader journey thread');
    const recorder = recordFrames();
    key('j');
    await settle();
    // The previous conversation stays rendered; nothing is empty or loading.
    expect(subject()).toBe('Reader journey thread');
    expect(loadingShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS - 20);
    expect(loadingShown()).toBe(false);
    slow.resolve(await detailOf('read-02'));
    await settle();
    expect(subject()).toBe('Neighbor thread read-02');
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS * 2);
    recorder.stop();
    expect(recorder.frames.length).toBeGreaterThan(0);
    expect(recorder.frames.every((frame) => !frame.loading && frame.subject !== null && frame.messages > 0)).toBe(true);
    expect(recorder.frames.every((frame) => frame.icons === headerIds.length)).toBe(true);
  });

  it('shows the target list identity after the delay, never the held body under the new subject', async () => {
    const slow = gate('read-02');
    const w = mountApp();
    await settle();
    await openReader(w);
    key('j');
    await settle();
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS + 1);
    await settle();
    expect(loadingShown()).toBe(true);
    expect(document.querySelector('[data-test="reader-loading-subject"]')?.textContent).toBe('Neighbor thread read-02');
    expect(document.querySelector('[data-test="reader-loading-sender"]')?.textContent).toBe('Ada Fixture');
    expect(document.querySelector('[data-test="reader-loading"]')?.textContent).toBe('Loading conversation…');
    expect(document.querySelectorAll('[data-test="reader-messages"]')).toHaveLength(0);
    expect(w.text()).not.toContain('Oldest message: short body.');
    // The contact pane names the list row's sender instead of claiming nothing is known.
    expect(w.find('[data-test="contact-unknown"]').exists()).toBe(false);
    expect(w.get('[data-test="contact-name"]').text()).toBe('Ada Fixture');
    slow.resolve(await detailOf('read-02'));
    await settle();
    expect(loadingShown()).toBe(false);
    expect(subject()).toBe('Neighbor thread read-02');
    expect(w.find('[data-test="reader-loading-identity"]').exists()).toBe(false);
  });

  it('keeps the loading presentation without an identity when no list row matches', async () => {
    const w = mountApp();
    await settle();
    const pane = mount(ContactPane, { props: { contact: null, context: 'open', loading: true } });
    expect(pane.find('[data-test="contact-unknown"]').exists()).toBe(false);
    await pane.setProps({ loading: false });
    expect(pane.find('[data-test="contact-unknown"]').exists()).toBe(true);
    pane.unmount();
    w.unmount();
    wrapper = null;
  });

  it('keeps header actions mounted and disabled while not ready, enabled when ready', async () => {
    const slow = gate('read-02');
    const w = mountApp();
    await settle();
    await openReader(w);
    for (const id of headerIds) expect(headerButton(id), id).not.toBeNull();
    expect(headerButton('reader-archive-toggle')!.disabled).toBe(false);
    expect(headerButton('files-links')!.disabled).toBe(false);
    expect(headerButton('prepare-reply')!.disabled).toBe(false);
    key('j');
    await settle();
    // Held window, then the loading presentation: mounted and disabled in both.
    for (const phase of ['held', 'loading']) {
      if (phase === 'loading') {
        await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS + 1);
        await settle();
        expect(loadingShown()).toBe(true);
      }
      for (const id of ['reader-archive-toggle', 'files-links', 'prepare-reply']) {
        expect(headerButton(id), `${phase} ${id}`).not.toBeNull();
        expect(headerButton(id)!.disabled, `${phase} ${id}`).toBe(true);
        // Held actions stay disabled but are not dimmed (no sub-120ms flicker);
        // they dim only once the loading presentation shows.
        expect(headerButton(id)!.classList.contains('header-glyph-held'), `${phase} ${id}`).toBe(phase === 'held');
      }
      expect(headerButton('reader-prev')).not.toBeNull();
      expect(headerButton('reader-next')).not.toBeNull();
    }
    expect(headerButton('reader-archive-toggle')!.textContent).toContain('Mark done (E)');
    slow.resolve(await detailOf('read-02'));
    await settle();
    for (const id of ['reader-archive-toggle', 'files-links', 'prepare-reply']) expect(headerButton(id)!.disabled, id).toBe(false);
  });

  it('does not make held content actionable as if it were the new thread', async () => {
    gate('read-02');
    const w = mountApp();
    await settle();
    await openReader(w);
    const toggle = w.get('[data-test="message-toggle-read-01-m3"]');
    const expandedBefore = toggle.attributes('aria-expanded');
    const recent = w.findAll('[data-test="message-toggle-read-01-m1"]')[0]!;
    const m1Expanded = recent.attributes('aria-expanded');
    key('j');
    await settle();
    expect(subject()).toBe('Reader journey thread'); // held, not the open thread
    key('e');
    key('o');
    key('p');
    key('n');
    await settle();
    await w.get('[data-test="reader-archive-toggle"]').trigger('click');
    await w.get('[data-test="files-links"]').trigger('click');
    await w.get('[data-test="prepare-reply"]').trigger('click');
    await recent.trigger('click');
    await settle();
    expect(fixture.controls.archiveCommands).toHaveLength(0);
    expect(fixture.controls.readCommands).toHaveLength(0);
    expect(fixture.controls.draftCreations).toHaveLength(0);
    expect(w.find('[data-test="attachment-chooser"]').exists()).toBe(false);
    expect(toggle.attributes('aria-expanded')).toBe(expandedBefore);
    expect(w.get('[data-test="message-toggle-read-01-m1"]').attributes('aria-expanded')).toBe(m1Expanded);
    expect(w.get('[data-test="message-toggle-read-01-m3"]').attributes('aria-disabled')).toBe('true');
  });
});

describe('neighbor prefetch and cache', () => {
  it('prefetches exactly one neighbor (next by default) once the reader is ready', async () => {
    const w = mountApp();
    await settle();
    await openReader(w);
    expect(calls).toEqual(['read-01', 'read-02']);
    expect(fixture.controls.archiveCommands).toHaveLength(0);
    expect(fixture.controls.readCommands).toHaveLength(0);
  });

  it('swaps a cached neighbor in instantly, then revalidates in the background and prefetches the next one', async () => {
    const w = mountApp();
    await settle();
    await openReader(w);
    const recorder = recordFrames();
    key('j');
    await flushPromises(); // no timers: an instant swap needs no delay window
    expect(subject()).toBe('Neighbor thread read-02');
    expect(loadingShown()).toBe(false);
    recorder.stop();
    expect(recorder.frames.every((frame) => !frame.loading && frame.subject !== null)).toBe(true);
    await settle();
    expect(calls).toEqual(['read-01', 'read-02', 'read-02', 'read-03']);
    expect(subject()).toBe('Neighbor thread read-02');
  });

  it('prefetches in the direction of the last move', async () => {
    const w = mountApp();
    await settle();
    await openReader(w, 'read-03');
    expect(calls).toEqual(['read-03', 'read-04']);
    key('k');
    await settle();
    expect(subject()).toBe('Neighbor thread read-02');
    expect(calls.slice(2)).toEqual(['read-02', 'read-01']);
  });

  it('does not serve an entry older than the TTL as fresh', async () => {
    const slow = gate('read-02');
    slow.resolve(await detailOf('read-02')); // the prefetch resolves immediately
    const w = mountApp();
    await settle();
    await openReader(w);
    await vi.advanceTimersByTimeAsync(DETAIL_CACHE_TTL_MS + 1);
    const refetch = gate('read-02');
    key('j');
    await settle();
    expect(subject()).toBe('Reader journey thread'); // held: nothing came from the expired cache
    refetch.resolve(await detailOf('read-02'));
    await settle();
    expect(subject()).toBe('Neighbor thread read-02');
  });

  it('invalidates the cache on a list refresh so stale neighbor state is never shown as fresh', async () => {
    const w = mountApp();
    await settle();
    await openReader(w);
    expect(calls).toEqual(['read-01', 'read-02']); // read-02 is cached
    const refreshed = gate('read-02'); // the next read-02 request is a post-refresh one
    fixture.controls.replaceDetail('read-02', { subject: 'Changed neighbor read-02' }); // notifies -> refresh
    await settle();
    key('j');
    await settle();
    // The earlier cached copy (old subject) must not appear, even for a frame.
    expect(subject()).toBe('Reader journey thread');
    refreshed.resolve({ ...(await detailOf('read-02')) });
    await settle();
    expect(subject()).toBe('Changed neighbor read-02');
  });

  it('keeps at most three entries', async () => {
    expect(DETAIL_CACHE_MAX).toBe(3);
    const w = mountApp();
    await settle();
    await openReader(w);
    for (let i = 0; i < 3; i += 1) { key('j'); await settle(); }
    expect(subject()).toBe('Neighbor thread read-04');
    // read-01 was evicted (oldest of four loaded): K x3 walks back through cache + one fetch.
    const before = calls.length;
    for (let i = 0; i < 3; i += 1) { key('k'); await settle(); }
    expect(subject()).toBe('Reader journey thread');
    expect(calls.length).toBeGreaterThan(before);
  });

  it('never surfaces a prefetch failure and leaves no cache entry', async () => {
    const failing = gate('read-02');
    const w = mountApp();
    await settle();
    await openReader(w);
    failing.reject({ kind: 'network_unavailable' });
    await settle();
    expect(w.find('[data-test="reader-error"]').exists()).toBe(false);
    expect(w.find('[role="alert"]').exists()).toBe(false);
    expect(subject()).toBe('Reader journey thread');
    key('j'); // no cache entry: an ordinary fetch happens
    await settle();
    expect(subject()).toBe('Neighbor thread read-02');
    expect(calls.filter((id) => id === 'read-02').length).toBeGreaterThanOrEqual(2);
  });

  it('never prefetches for an Activity-origin reader', async () => {
    const w = mountApp();
    await settle();
    await openUtilityDrawer(w, 'activity');
    await w.get('[data-test="activity-open-read-op-1"]').trigger('click');
    await settle();
    expect(subject()).toBe('Neighbor thread read-02');
    expect(calls).toEqual(['read-02']);
    key('j');
    key('k');
    await settle();
    expect(calls).toEqual(['read-02']);
  });
});

describe('prefetch request budget (useMailbox)', () => {
  function mailboxHarness() {
    const archiveCalls: ConversationRef[] = [];
    const inFlight: Array<{ id: string; gate: Gate }> = [];
    let concurrent = 0;
    let peak = 0;
    const detailClient: MailClient = {
      ...fixture.client,
      // Never settles: the mutation stays pending while the cache is probed.
      setArchived: (command) => { archiveCalls.push(command.conversation); return new Promise(() => {}); },
      getConversation: (target) => {
        calls.push(target.conversationId);
        const entry = { id: target.conversationId, gate: deferred<Conversation>() };
        inFlight.push(entry);
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        return entry.gate.promise.finally(() => { concurrent -= 1; });
      },
    };
    const scope = effectScope();
    const mailbox = scope.run(() => useMailbox(detailClient))!;
    return { mailbox, inFlight, scope, archiveCalls, peak: () => peak };
  }

  it('runs at most one prefetch at a time and keeps only the latest wanted target', async () => {
    const h = mailboxHarness();
    await h.mailbox.ready;
    const open = h.mailbox.openConversationByRef(readerRef('read-01'));
    h.inFlight[0]!.gate.resolve(await detailOf('read-01'));
    await open;
    expect(h.mailbox.detailState.value).toBe('ready');
    h.mailbox.prefetchConversation(readerRef('read-02'));
    h.mailbox.prefetchConversation(readerRef('read-03'));
    h.mailbox.prefetchConversation(readerRef('read-04'));
    h.mailbox.prefetchConversation(readerRef('read-02')); // duplicate of the in-flight one
    expect(calls).toEqual(['read-01', 'read-02']);
    h.inFlight[1]!.gate.resolve(await detailOf('read-02'));
    await flushPromises();
    // Only the newest wanted target follows; the superseded one is dropped.
    expect(calls).toEqual(['read-01', 'read-02', 'read-04']);
    expect(h.peak()).toBe(1);
    h.scope.stop();
  });

  it('drops an in-flight prefetch result after the reader closes', async () => {
    const h = mailboxHarness();
    await h.mailbox.ready;
    const open = h.mailbox.openConversationByRef(readerRef('read-01'));
    h.inFlight[0]!.gate.resolve(await detailOf('read-01'));
    await open;
    h.mailbox.prefetchConversation(readerRef('read-02'));
    h.mailbox.closeReader();
    h.inFlight[1]!.gate.resolve(await detailOf('read-02'));
    await flushPromises();
    // A later neighbor open must fetch fresh: nothing was cached.
    const reopen = h.mailbox.openConversationByRef(readerRef('read-01'));
    h.inFlight[2]!.gate.resolve(await detailOf('read-01'));
    await reopen;
    void h.mailbox.openNeighbor(readerRef('read-02'));
    expect(h.mailbox.detailState.value).toBe('loading');
    h.scope.stop();
  });

  it('invalidates the cache when a mailbox mutation starts', async () => {
    const h = mailboxHarness();
    await h.mailbox.ready;
    const open = h.mailbox.openConversationByRef(readerRef('read-01'));
    h.inFlight[0]!.gate.resolve(await detailOf('read-01'));
    await open;
    h.mailbox.prefetchConversation(readerRef('read-02'));
    h.inFlight[1]!.gate.resolve(await detailOf('read-02'));
    await flushPromises();
    // Pending (never-resolving) archive of another row: invalidation happens at dispatch.
    void h.mailbox.setArchived(readerRef('read-04'), true);
    await flushPromises();
    expect(h.archiveCalls).toHaveLength(1);
    void h.mailbox.openNeighbor(readerRef('read-02'));
    expect(h.mailbox.detailState.value).toBe('loading'); // not served from the old cache
    expect(h.mailbox.conversation.value).toBeNull();
    h.scope.stop();
  });

  it('does not prefetch for an Activity-source reader', async () => {
    const h = mailboxHarness();
    await h.mailbox.ready;
    const open = h.mailbox.openConversationByRef(readerRef('read-02'), 'activity');
    h.inFlight[0]!.gate.resolve(await detailOf('read-02'));
    await open;
    h.mailbox.prefetchConversation(readerRef('read-03'));
    expect(calls).toEqual(['read-02']);
    h.scope.stop();
  });
});

describe('rapid navigation', () => {
  it('renders only the final target for J J J and discards out-of-order responses', async () => {
    const first = gate('read-02'); // prefetch, adopted by the first J
    const second = gate('read-03');
    const third = gate('read-04');
    const w = mountApp();
    await settle();
    await openReader(w);
    key('j'); key('j'); key('j');
    await settle();
    expect(calls).toEqual(['read-01', 'read-02', 'read-03', 'read-04']);
    third.resolve(await detailOf('read-04'));
    await settle();
    expect(subject()).toBe('Neighbor thread read-04');
    second.resolve(await detailOf('read-03'));
    first.resolve(await detailOf('read-02'));
    await settle();
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS * 2);
    expect(subject()).toBe('Neighbor thread read-04');
    expect(loadingShown()).toBe(false);
    expect(w.findAll('[data-test="reader-messages"]')).toHaveLength(1);
  });

  it('keeps the original loading deadline across repeated J presses', async () => {
    gate('read-02');
    gate('read-03');
    const w = mountApp();
    await settle();
    await openReader(w);
    key('j');
    await vi.advanceTimersByTimeAsync(80);
    key('j');
    await settle();
    expect(loadingShown()).toBe(false);
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS - 80 + 1);
    await settle();
    expect(loadingShown()).toBe(true);
    expect(document.querySelector('[data-test="reader-loading-subject"]')?.textContent).toBe('Neighbor thread read-03');
    void w;
  });
});

describe('focus and scroll across a swap', () => {
  const scrollStore = new WeakMap<HTMLElement, number>();
  let original: PropertyDescriptor | undefined;
  beforeEach(() => {
    original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return scrollStore.get(this) ?? 0; },
      set(this: HTMLElement, value: number) { scrollStore.set(this, value); },
    });
  });
  afterEach(() => {
    if (original) Object.defineProperty(HTMLElement.prototype, 'scrollTop', original);
    else delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
  });

  it('never passes focus through the reader container on an instant swap and focuses the new newest toggle once', async () => {
    const w = mountApp();
    await settle();
    await openReader(w);
    expect(focusName()).toBe('message-toggle-read-01-m3');
    const scroller = w.get('[data-test="reader-scroll"]').element as HTMLElement;
    scroller.scrollTop = 150;
    const recorder = recordFrames();
    key('j');
    await settle();
    recorder.stop();
    expect(recorder.focus).toEqual(['message-toggle-read-02-m1']);
    expect(focusName()).toBe('message-toggle-read-02-m1');
    expect((w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop).toBe(0);
  });

  it('keeps focus on the previous toggle while held, then moves once to the new toggle', async () => {
    const slow = gate('read-02');
    const w = mountApp();
    await settle();
    await openReader(w);
    (w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop = 150;
    const recorder = recordFrames();
    key('j');
    await settle();
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS - 20);
    expect(focusName()).toBe('message-toggle-read-01-m3');
    expect((w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop).toBe(150);
    slow.resolve(await detailOf('read-02'));
    await settle();
    recorder.stop();
    expect(recorder.focus).toEqual(['message-toggle-read-02-m1']);
    expect(recorder.focus).not.toContain('reader');
    expect((w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop).toBe(0);
  });

  it('parks focus on the reader container only while the loading presentation shows, then moves once', async () => {
    const slow = gate('read-02');
    const w = mountApp();
    await settle();
    await openReader(w);
    key('j');
    await settle();
    await vi.advanceTimersByTimeAsync(READER_LOADING_DELAY_MS + 1);
    await settle();
    expect(loadingShown()).toBe(true);
    expect(focusName()).toBe('reader');
    slow.resolve(await detailOf('read-02'));
    await settle();
    expect(focusName()).toBe('message-toggle-read-02-m1');
  });

  it('restores the saved scroll position when returning to the same conversation', async () => {
    const w = mountApp();
    await settle();
    await openReader(w);
    (w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop = 150;
    key('j');
    await settle();
    expect((w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop).toBe(0);
    key('k');
    await settle();
    expect(subject()).toBe('Reader journey thread');
    expect((w.get('[data-test="reader-scroll"]').element as HTMLElement).scrollTop).toBe(150);
  });
});
