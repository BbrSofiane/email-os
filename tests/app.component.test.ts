import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { AccountStatus, MailClient } from '../src/lib/ipc/client';
import {
  accountMethods,
  closeUtilityDrawer,
  conversationRows,
  countingClient,
  createBrowserFakeMailClient,
  createSixConversationClient,
  flushMacrotasks,
  deferred,
  fixtureRef,
  focusedRow,
  openUtilityDrawer,
  type BrowserFake,
} from './helpers';
import { createReaderFixtureClient, type ReaderFixture } from './reader.fixture';

function keydown(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  }
  return event;
}

describe('App (Slice 01 shell)', () => {
  let fake: BrowserFake;
  let counted: ReturnType<typeof countingClient>;
  let wrapper: VueWrapper | null = null;

  function mountApp(client: MailClient = counted.client): VueWrapper {
    const w = mount(App, {
      props: { client, mode: 'browser-preview' },
      attachTo: document.body, // focus()/activeElement only work in an attached tree
    });
    wrapper = w;
    return w;
  }

  async function settle(): Promise<void> {
    await flushPromises();
    await fake.controls.flush();
    await flushPromises();
  }

  beforeEach(() => {
    fake = createBrowserFakeMailClient();
    counted = countingClient(fake);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('surfaces subscription failures at the fail-closed account gate with Retry', async () => {
    const broken: MailClient = {
      ...fake,
      subscribe: async () => { throw { kind: 'storage_unavailable' }; },
    };
    const w = mountApp(broken);
    await flushPromises();
    expect(w.find('[data-test="account-loading"]').exists()).toBe(false);
    expect(w.find('[data-test="account-error"]').text()).toContain('Could not subscribe to or load the inbox');
    expect(w.find('[data-test="account-error"]').text()).toContain('storage unavailable');
    expect(w.find('[data-test="account-retry"]').exists()).toBe(true);
    await w.find('[data-test="account-retry"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="account-retry"]').exists()).toBe(true);
  });

  it('discloses memory-only preview and renders the seeded inbox', async () => {
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="preview-banner"]').text()).toContain('in-memory');
    expect(w.find('[data-test="preview-banner"]').text()).toContain('native core is not connected');
    expect(conversationRows(w)).toHaveLength(18);
  });

  it('navigates with j/k and arrow keys, moving DOM focus with conversation focus', async () => {
    const w = mountApp();
    await settle();
    const rows = conversationRows(w);
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.trigger('focusin');
    await flushPromises();
    expect(document.activeElement).toBe(rows[0]!.element);
    expect(rows[0]!.attributes('aria-current')).toBe('true');

    window.dispatchEvent(keydown({ key: 'j' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[1]!.element);
    expect(rows[1]!.attributes('aria-current')).toBe('true');
    expect(rows[0]!.attributes('aria-current')).toBeUndefined();

    window.dispatchEvent(keydown({ key: 'ArrowDown' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[2]!.element);

    window.dispatchEvent(keydown({ key: 'k' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[1]!.element);

    window.dispatchEvent(keydown({ key: 'ArrowUp' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[0]!.element);

    // at the top edge, ArrowUp clamps and focus stays put
    window.dispatchEvent(keydown({ key: 'ArrowUp' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[0]!.element);
    expect(rows[0]!.attributes('aria-current')).toBe('true');
  });

  it('opens with Enter, closes with Escape, and restores list focus', async () => {
    const w = mountApp();
    await settle();
    const rows = conversationRows(w);
    (rows[1]!.element as HTMLElement).focus();
    rows[1]!.trigger('focusin');
    await flushPromises();

    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    const reader = w.find('[data-test="reader"]');
    expect(reader.exists()).toBe(true);
    expect(reader.text()).toContain('Fixture thread 2');

    window.dispatchEvent(keydown({ key: 'Escape' }));
    await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(document.activeElement).toBe(conversationRows(w)[1]!.element);
  });

  it('archives with e: row leaves the inbox, focus stays on the resolved survivor', async () => {
    const w = mountApp();
    await settle();
    const rows = conversationRows(w);
    expect(rows[0]!.text()).toContain('conv-01');
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.trigger('focusin');
    await flushPromises();

    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();

    const after = conversationRows(w);
    expect(after).toHaveLength(17);
    expect(after[0]!.text()).toContain('conv-02');
    // focus resolved to the surviving neighbor (conv-02), now the first row
    expect(after[0]!.attributes('aria-current')).toBe('true');
    expect(document.activeElement).toBe(after[0]!.element);
    const op = fake.controls.activity()[0];
    expect(op?.status).toBe('confirmed');
    expect(op?.requestedArchived).toBe(true);
  });

  it('shows a pending operation on a restored row and completes after release', async () => {
    const w = mountApp();
    await settle();
    // archive conv-01 to completion
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(conversationRows(w)).toHaveLength(17);

    // pause the fake provider, then unarchive: the row must reappear while the
    // operation is still visible as pending/applying
    fake.controls.behavior.hold = true;
    await openUtilityDrawer(w, 'activity');
    await w.find('[data-test^="activity-unarchive-"]').trigger('click');
    await flushPromises();
    const rows = conversationRows(w);
    expect(rows).toHaveLength(18);
    expect(w.find('[data-test="row-pending"]').exists()).toBe(true);
    expect(w.text()).toContain('applying…');

    fake.controls.release();
    await settle();
    expect(w.find('[data-test="row-pending"]').exists()).toBe(false);
    expect(conversationRows(w)).toHaveLength(18);
  });

  it('renders failed operations in activity and reverts the row to the inbox', async () => {
    const w = mountApp();
    await settle();
    fake.controls.behavior.failNext = 1;
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    await openUtilityDrawer(w, 'activity');
    expect(w.find('[data-test="activity-failed"]').exists()).toBe(true);
    expect(w.find('[data-test="activity-failed"]').text()).toContain('failed (provider_rejected)');
    expect(conversationRows(w)).toHaveLength(18);
  });

  it('unarchives from activity and opens archived conversations from activity', async () => {
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(conversationRows(w)).toHaveLength(17);

    await openUtilityDrawer(w, 'activity');
    await w.find('[data-test^="activity-unarchive-"]').trigger('click');
    await closeUtilityDrawer(w);
    await settle();
    expect(conversationRows(w)).toHaveLength(18);

    // Explicitly focus the restored row: background insertion preserves conversation focus.
    const restored = conversationRows(w)[0]!;
    (restored.element as HTMLElement).focus();
    await restored.trigger('focusin');
    // archive again, then Open from activity must still show the archived thread
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    await openUtilityDrawer(w, 'activity');
    await w.find('[data-test^="activity-open-"]').trigger('click');
    await settle();
    const reader = w.find('[data-test="reader"]');
    expect(reader.exists()).toBe(true);
    expect(reader.text()).toContain('conv-01');
  });

  it('ignores shortcuts with modifiers, during IME composition, in text fields, and when a button owns the key', async () => {
    const w = mountApp();
    await settle();
    const baseline = fake.controls.activity().length;

    window.dispatchEvent(keydown({ key: 'e', ctrlKey: true }));
    window.dispatchEvent(keydown({ key: 'j', metaKey: true }));
    window.dispatchEvent(keydown({ key: 'j', altKey: true }));
    const ime = keydown({ key: 'j' });
    Object.defineProperty(ime, 'isComposing', { value: true });
    window.dispatchEvent(ime);
    window.dispatchEvent(keydown({ key: 'j', keyCode: 229 }));

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(keydown({ key: 'j' }));
    input.dispatchEvent(keydown({ key: 'e' }));
    input.remove();

    const button = document.createElement('button');
    document.body.appendChild(button);
    button.dispatchEvent(keydown({ key: 'e' }));
    button.dispatchEvent(keydown({ key: 'Enter' }));
    button.remove();

    await flushMacrotasks();
    await flushPromises();
    expect(fake.controls.activity().length).toBe(baseline);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    // conversation focus did not move (still the first row from the initial load)
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-conv-01');
  });

  it('renders hostile markup as literal text with no script/img/link elements or remote assets', async () => {
    const w = mountApp();
    await settle();
    // conv-06 is the hostile fixture; move focus to it and open
    for (let i = 0; i < 5; i += 1) {
      window.dispatchEvent(keydown({ key: 'j' }));
      await flushPromises();
    }
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();

    const reader = w.find('[data-test="reader"]');
    expect(reader.exists()).toBe(true);
    expect(reader.text()).toContain('<img src=x onerror=alert(1)> subject with <b>markup</b>');
    expect(reader.text()).toContain('<script>alert("body")</script>');
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    expect(w.findAll('a')).toHaveLength(0);
    expect(document.querySelectorAll('link[rel="stylesheet"][href^="http"]')).toHaveLength(0);
  });

  it('shows the inbox empty state when everything is archived', async () => {
    const w = mountApp();
    await settle();
    for (let i = 0; i < 18; i += 1) {
      window.dispatchEvent(keydown({ key: 'e' }));
      await settle();
    }
    expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
    expect(w.find('[data-test="inbox-empty"]').text()).toContain('recoverable from Activity');
    expect(conversationRows(w)).toHaveLength(0);
  });

  it('shows a loading state while the initial read is in flight', async () => {
    let resolveList!: (value: Awaited<ReturnType<MailClient['listConversations']>>) => void;
    const client: MailClient = {
      ...accountMethods(fake),
      listConversations: () =>
        new Promise((resolve) => {
          resolveList = resolve;
        }),
      getConversation: fake.getConversation.bind(fake),
      setArchived: fake.setArchived.bind(fake),
      subscribe: (l) => fake.subscribe(l),
    };
    const w = mountApp(client);
    await flushPromises();
    expect(w.find('[data-test="inbox-loading"]').exists()).toBe(true);
    resolveList((await fake.listConversations()) as Awaited<ReturnType<MailClient['listConversations']>>);
    await settle();
    expect(w.find('[data-test="inbox-loading"]').exists()).toBe(false);
  });

  it('shows an error state with retry when the initial read fails', async () => {
    let fail = true;
    const client: MailClient = {
      ...accountMethods(fake),
      listConversations: () =>
        fail ? Promise.reject({ kind: 'storage_unavailable' }) : fake.listConversations(),
      getConversation: fake.getConversation.bind(fake),
      setArchived: fake.setArchived.bind(fake),
      subscribe: (l) => fake.subscribe(l),
    };
    const w = mountApp(client);
    await settle();
    const errorPane = w.find('[data-test="inbox-error"]');
    expect(errorPane.exists()).toBe(true);
    expect(errorPane.text()).toContain('storage unavailable');
    fail = false;
    await w.find('[data-test="inbox-retry"]').trigger('click');
    await settle();
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(conversationRows(w)).toHaveLength(18);
  });

  it('advances from an archived reader to the next conversation', async () => {
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    await w.find('[data-test="reader-archive-toggle"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 2');
    expect(conversationRows(w)).toHaveLength(0); // reader replaces the list
    // UX-02: the newly opened conversation focuses its newest message toggle.
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-conv-02-m3');
  });

  it('does not archive the previous conversation while the next detail is loading', async () => {
    const pending = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    const client: MailClient = {
      ...counted.client,
      getConversation: (target) => target.conversationId === 'conv-02' ? pending.promise : fake.getConversation(target),
    };
    const w = mountApp(client);
    await settle();
    await w.find('[data-test="conversation-row-conv-01"]').trigger('click');
    await settle();
    // Back to the list (the reader replaces it), then open the next conversation.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    await w.find('[data-test="conversation-row-conv-02"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="reader-loading"]').exists()).toBe(true);
    expect(w.find('[data-test="reader-archive-toggle"]').exists()).toBe(false);
    window.dispatchEvent(keydown({ key: 'e' }));
    await flushPromises();
    expect(counted.commands).toHaveLength(0);
    pending.resolve(await fake.getConversation(fixtureRef('conv-02')));
    await settle();
  });

  it('keeps keyboard commands aligned with the focused row after a delayed rejection', async () => {
    const w = mountApp();
    await settle();
    fake.controls.behavior.hold = true;
    fake.controls.behavior.failNext = 1;
    const first = conversationRows(w)[0]!;
    (first.element as HTMLElement).focus();
    await first.trigger('focusin');
    window.dispatchEvent(keydown({ key: 'e' }));
    await flushPromises();
    const focused = document.activeElement;
    expect(focused?.textContent).toContain('conv-02');
    fake.controls.release();
    await settle();
    expect(document.activeElement).toBe(focused);
    expect(conversationRows(w)[1]!.attributes('aria-current')).toBe('true');
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 2');
  });

  it('does not steal toolbar focus during a background reader refresh', async () => {
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    const close = w.find('[data-test="reader-close"]').element as HTMLElement;
    close.focus();
    window.dispatchEvent(new Event('focus'));
    await settle();
    expect(document.activeElement).toBe(close);
  });

  it('does not reopen the reader when an archive receipt arrives after Escape', async () => {
    const accepted = deferred<Awaited<ReturnType<MailClient['setArchived']>>>();
    let receipt: Awaited<ReturnType<MailClient['setArchived']>>;
    const client: MailClient = {
      ...counted.client,
      setArchived: async (command) => {
        receipt = await counted.client.setArchived(command);
        return accepted.promise;
      },
    };
    const w = mountApp(client);
    await settle();
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await flushPromises();
    window.dispatchEvent(keydown({ key: 'Escape' }));
    accepted.resolve(receipt!);
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
  });

  it('detaches the subscription and window listeners on unmount', async () => {
    const w = mountApp();
    await settle();
    expect(fake.controls.listenerCount()).toBe(1);
    const calls = counted.listCalls();
    w.unmount();
    wrapper = null;
    expect(fake.controls.listenerCount()).toBe(0);
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    await flushMacrotasks();
    expect(counted.listCalls()).toBe(calls);
  });
});

describe('App (UX-01 compact browsing shell journey)', () => {
  let six: ReturnType<typeof createSixConversationClient>;
  let wrapper: VueWrapper | null = null;
  const originalGetBCR = HTMLElement.prototype.getBoundingClientRect;
  const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  const scrollTopStore = new WeakMap<HTMLElement, number>();
  const rowDocTops = new Map<string, number>();

  function mockGeometry(): void {
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return scrollTopStore.get(this) ?? 0; },
      set(this: HTMLElement, value: number) { scrollTopStore.set(this, value); },
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.tagName === 'UL' && this.classList.contains('inbox-scroll')) {
        return domRect(0, 360);
      }
      const testId = this.getAttribute?.('data-test');
      if (testId?.startsWith('conversation-row-')) {
        // Realistic geometry: a row's viewport position depends on the owning
        // scrollport's current scrollTop, not a separately fixed variable.
        const scroller = this.closest('ul.inbox-scroll');
        const scroll = scroller instanceof HTMLElement ? (scrollTopStore.get(scroller) ?? 0) : 0;
        const docTop = rowDocTops.get(testId.slice('conversation-row-'.length)) ?? 0;
        return domRect(docTop - scroll, docTop - scroll + 34);
      }
      return originalGetBCR.call(this);
    };
  }

  function domRect(top: number, bottom: number): DOMRect {
    return {
      top, bottom, left: 0, right: 320, width: 320, height: bottom - top,
      x: 0, y: top, toJSON: () => ({}),
    } as DOMRect;
  }

  function seedRowTops(extraTopRows = 0): void {
    // six rows, each 36px apart; `extraTopRows` simulates rows inserted above.
    const ids = ['six-f', 'six-a', 'six-b', 'six-c', 'six-d', 'six-e'];
    ids.forEach((id, index) => rowDocTops.set(id, (index + extraTopRows) * 36));
  }

  async function focusRowById(w: VueWrapper, conversationId: string): Promise<void> {
    const row = w.find(`[data-test="conversation-row-${conversationId}"]`);
    (row.element as HTMLElement).focus();
    await row.trigger('focusin');
  }

  function mountSix(): VueWrapper {
    const w = mount(App, { props: { client: six.client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }

  function mountApp(client: MailClient = six.client): VueWrapper {
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }

  async function settle(): Promise<void> {
    await flushPromises();
    await flushMacrotasks(2);
    await flushPromises();
  }

  beforeEach(() => {
    six = createSixConversationClient();
    rowDocTops.clear();
    seedRowTops();
    mockGeometry();
    // The synthetic world is dated around 2026-01-15; freeze Date.now so the
    // viewer-local calendar buckets are deterministic (no fake timers).
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-01-15T12:00:00Z'));
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    HTMLElement.prototype.getBoundingClientRect = originalGetBCR;
    if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop);
    else delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
    vi.restoreAllMocks();
  });

  it('renders compact rows with non-selectable date group headings and no AI/calendar controls', async () => {
    const w = mountSix();
    await settle();
    const rows = conversationRows(w);
    expect(rows).toHaveLength(6);
    // Every row is a single compact line: sender, subject/snippet, trailing date.
    for (const row of rows) {
      expect(row.classes()).toContain('inbox-row');
      expect(row.find('.row-sender').exists()).toBe(true);
      expect(row.find('.row-subject-snippet').exists()).toBe(true);
      expect(row.find('.row-time').exists()).toBe(true);
    }
    const headings = w.findAll('.row-group');
    const captions = headings.map((h) => h.text());
    expect(captions).toContain('Today');
    expect(captions).toContain('Yesterday');
    expect(captions).toContain('Earlier this month');
    expect(captions).toContain('December 2025');
    expect(captions).toContain('June 2025');
    for (const heading of headings) {
      expect((heading.element as HTMLElement).tabIndex).toBe(-1);
      expect(heading.attributes('role')).toBe('presentation');
      expect(heading.find('button').exists()).toBe(false);
    }
    const buttonTexts = w.findAll('button').map((b) => b.text().toLowerCase());
    expect(buttonTexts.some((t) => t.includes('calendar'))).toBe(false);
    expect(buttonTexts.some((t) => t === 'ai' || t.startsWith('ai '))).toBe(false);
  });

  it('moves focus row to row, skipping group headings, with j/k', async () => {
    const w = mountSix();
    await settle();
    const rows = conversationRows(w);
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.trigger('focusin');
    await flushPromises();
    for (let i = 1; i < rows.length; i += 1) {
      window.dispatchEvent(keydown({ key: 'j' }));
      await flushPromises();
      expect(document.activeElement).toBe(rows[i]!.element);
    }
    window.dispatchEvent(keydown({ key: 'k' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[rows.length - 2]!.element);
  });

  it('focuses the fourth row, opens it, and returns to the same row with a restored anchor', async () => {
    const w = mountSix();
    await settle();
    await focusRowById(w, 'six-d');
    await flushPromises();
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-six-d');

    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // While reading, a newer conversation arrives above six-d in the inbox.
    six.insertNewerConversation('six-new', { displayName: 'Newer Sender', mailbox: 'newer@example.test' });
    await settle();
    seedRowTops(1); // six-d moved one row down

    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    // The surviving anchor row is focused again without scrolling it away.
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-six-d');
    // Approximate offset restoration: the row sits at its captured viewport offset.
    const scroller = w.find('ul.inbox-scroll').element as HTMLElement;
    expect(scroller.scrollTop).toBe(36);
  });

  it('keeps an action targeted at the original id when a newer row is inserted (BROWSE-17)', async () => {
    const w = mountSix();
    await settle();
    await focusRowById(w, 'six-d');
    await flushPromises();

    six.insertNewerConversation('six-new', { displayName: 'Newer Sender', mailbox: 'newer@example.test' });
    await settle();
    // focus survives the insertion, still addressing the original conversation
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-six-d');

    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(six.commands).toHaveLength(1);
    expect(six.commands[0]!.conversation.conversationId).toBe('six-d');
  });

  it('shows exact known contact context and never guesses a missing correspondent', async () => {
    const w = mountSix();
    await settle();
    // six-a: long display name plus mailbox
    await focusRowById(w, 'six-a');
    await flushPromises();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Anastasia Vasquez-Romanov of the Northern Reaches');
    expect(w.find('[data-test="contact-mailbox"]').text()).toBe('anastasia@example.test');

    // six-c: no primaryCorrespondent — an explicit disclosure, not a guess
    await focusRowById(w, 'six-c');
    await flushPromises();
    expect(w.find('[data-test="contact-unknown"]').exists()).toBe(true);

    // Reader mode uses the loaded latest message's From for the open ref only.
    await focusRowById(w, 'six-a');
    await flushPromises();
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Anastasia Vasquez-Romanov of the Northern Reaches');
  });

  it('keeps hover inert and inline row actions row-scoped', async () => {
    const w = mountSix();
    await settle();
    await focusRowById(w, 'six-f');
    await flushPromises();

    // Hovering another row changes neither focus nor read state.
    await w.find('[data-test="conversation-row-six-b"]').trigger('mouseover');
    await flushPromises();
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-six-f');
    expect(six.readCommands).toHaveLength(0);

    // The inline archive button stops propagation: no row open, one archive.
    await w.find('[data-test="row-archive-six-b"]').trigger('click');
    await settle();
    expect(six.commands.map((c) => c.conversation.conversationId)).toEqual(['six-b']);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
  });

  it('covers loading, error, and empty states in the central surface', async () => {
    // Loading
    let resolveList!: (value: Awaited<ReturnType<MailClient['listConversations']>>) => void;
    const loadingClient: MailClient = {
      ...six.client,
      listConversations: () => new Promise((resolve) => { resolveList = resolve; }),
    };
    let w: VueWrapper = mount(App, { props: { client: loadingClient, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await flushPromises();
    expect(w.find('[data-test="inbox-loading"]').exists()).toBe(true);
    resolveList(await six.client.listConversations());
    await settle();
    w.unmount();
    wrapper = null;

    // Error with retry
    six.failNextList({ kind: 'storage_unavailable' });
    w = mountSix();
    await settle();
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(true);
    expect(w.find('[data-test="inbox-error"]').text()).toContain('storage unavailable');
    await w.find('[data-test="inbox-retry"]').trigger('click');
    await settle();
    expect(w.find('[data-test="inbox-error"]').exists()).toBe(false);
    expect(conversationRows(w)).toHaveLength(6);
    w.unmount();
    wrapper = null;

    // Empty: archive every row through the keyboard; the last archive focuses
    // the empty state instead of a removed row.
    w = mountSix();
    await settle();
    const rows = conversationRows(w);
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.trigger('focusin');
    await flushPromises();
    for (let i = 0; i < 6; i += 1) {
      window.dispatchEvent(keydown({ key: 'e' }));
      await settle();
    }
    expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
    expect(w.find('[data-test="inbox-empty"]').text()).toContain('recoverable from Activity');
    expect(document.activeElement).toBe(w.find('[data-test="inbox-empty"]').element);
  });

  it('replaces the contact pane with a keyboard-operable disclosure strictly below 1000px', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountSix();
      await settle();
      expect(w.find('[data-test="contact-pane"]').exists()).toBe(false);
      expect(w.find('[data-test="contact-disclosure"]').exists()).toBe(true);

      await focusRowById(w, 'six-c'); // no known correspondent
      await flushPromises();
      await w.find('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
      expect(w.find('[data-test="contact-unknown"]').exists()).toBe(true);

      // Escape closes the disclosure with precedence and restores focus.
      window.dispatchEvent(keydown({ key: 'Escape' }));
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
      expect(document.activeElement).toBe(w.find('[data-test="contact-disclosure"]').element);
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('restores an anchor relative to the current scroll position, not the captured one (P2)', async () => {
    const w = mountSix();
    await settle();
    // Simulate a scrolled inbox: the sixth row is at absolute position 300.
    rowDocTops.set('six-e', 300);
    const list = w.find('ul.inbox-scroll').element as HTMLElement;
    list.scrollTop = 200; // the row's viewport offset is 100 (300 - 200).
    await focusRowById(w, 'six-e');
    await flushPromises();

    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // Opening a reader unmounts the list; returning recreates it at scrollTop 0.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    // The restored scroller must return the row to its captured viewport offset (100),
    // not 100 + (300 - 100) = 300 (double-counting the original offset).
    const scroller = w.find('ul.inbox-scroll').element as HTMLElement;
    expect(scroller.scrollTop).toBe(200);
    const restoredRow = w.find('[data-test="conversation-row-six-e"]').element as HTMLElement;
    expect(restoredRow.getBoundingClientRect().top).toBe(100);
  });

  it('suppresses revealRow during preventScroll focus restoration (P2)', async () => {
    const w = mountSix();
    await settle();
    // Focus a row and simulate an off-screen scroll position for it.
    await focusRowById(w, 'six-c');
    await flushPromises();
    rowDocTops.set('six-c', 500);
    const list = w.find('ul.inbox-scroll').element as HTMLElement;
    list.scrollTop = 0; // six-c is off-screen (docTop 500, viewport 0-360).

    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // The reader closed and focus restoration uses preventScroll: the row must
    // not be yanked back into view by an automatic reveal.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-six-c');
    // The row remains off-screen (focus restoration must not undo scroll positioning).
    const row = w.find('[data-test="conversation-row-six-c"]').element as HTMLElement;
    expect(row.getBoundingClientRect().top).toBe(500);
  });

  it('leaves the reader when the Inbox rail control is activated (P2)', async () => {
    const w = mountSix();
    await settle();
    await focusRowById(w, 'six-b');
    await flushPromises();
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // The rail Inbox button must route through the reader close path, not just
    // try to focus an unmounted list.
    await w.find('[data-test="rail-inbox"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="inbox-empty"]').exists()).toBe(false);
    expect(w.find('[data-test="conversation-row-six-b"]').exists()).toBe(true);
  });

  it('makes utility and Contact disclosures mutually exclusive (P2)', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountSix();
      await settle();
      await w.find('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);

      // Opening a utility drawer must dismiss the Contact disclosure so both
      // fixed regions never coexist.
      await openUtilityDrawer(w, 'activity');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
      expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);

      // Opening the Contact disclosure must dismiss the utility drawer.
      await w.find('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('hands off focus to a surviving contact surface when growing across the breakpoint (P2)', async () => {
    let matches = false;
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() { return matches; },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountSix();
      await settle();
      expect(w.find('[data-test="contact-disclosure"]').exists()).toBe(true);
      await w.find('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      // Focus is on the narrow contact panel.
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
      (w.find('[data-test="contact-disclosure-panel"]').element as HTMLElement).focus();
      expect(document.activeElement?.getAttribute('data-test')).toBe('contact-disclosure-panel');

      // Grow past 1000px: both the disclosure and trigger are removed by v-if,
      // so focus must be handed to the surviving wide contact surface.
      matches = true;
      listeners.forEach((cb) => cb({ matches: true } as MediaQueryListEvent));
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
      expect(w.find('[data-test="contact-disclosure"]').exists()).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('does not let a hidden draft editor own all mailbox shortcuts (P2)', async () => {
    const fake = createBrowserFakeMailClient();
    const w = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await openUtilityDrawer(w, 'drafts');
    await w.find('[data-test="new-draft"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('draft text');
    await flushPromises();

    // Close the drawer: the protected lifecycle flushes and closes the editor,
    // so the inbox is free and no hidden editor owns the mailbox shortcuts.
    await closeUtilityDrawer(w);
    await flushPromises();
    // A successful protected close leaves no active editor behind to hide.
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(false);
    w.unmount();
    wrapper = null;
  });

  it('keeps drafts recovery controls visible when the drawer is closed (P2)', async () => {
    const fake = createBrowserFakeMailClient();
    const client: MailClient = {
      ...fake,
      saveDraft: () => Promise.reject({ kind: 'storage_unavailable' }),
    };
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await openUtilityDrawer(w, 'drafts');
    await w.find('[data-test="new-draft"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('unsaved text');
    await flushPromises();

    // Switch to another utility: the guarded switch away from Drafts aborts
    // when the flush fails, so the user stays on Drafts where the local
    // recovery controls surface the failure rather than hiding it silently.
    await openUtilityDrawer(w, 'activity');
    await flushPromises();
    expect(w.find('[data-test="draft-close-recovery"]').exists()).toBe(false);
    expect(w.find('[data-test="draft-attention-open"]').exists()).toBe(false);
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(true);
    expect(w.find('[data-test="draft-error"]').exists()).toBe(true);
    w.unmount();
    wrapper = null;
  });

  it('hands off focus to the surviving contact disclosure when shrinking across the breakpoint (P2)', async () => {
    let matches = true;
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() { return matches; },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountSix();
      await settle();
      expect(w.find('[data-test="contact-column"]').exists()).toBe(true);
      (w.find('[data-test="contact-column"]').element as HTMLElement).focus();
      expect(document.activeElement?.getAttribute('data-test')).toBe('contact-column');

      // Shrink below 1000px: the wide contact column is removed by v-if, so
      // focus must be handed to the surviving narrow disclosure control.
      matches = false;
      listeners.forEach((cb) => cb({ matches: false } as MediaQueryListEvent));
      await flushPromises();
      expect(w.find('[data-test="contact-column"]').exists()).toBe(false);
      expect(w.find('[data-test="contact-disclosure"]').exists()).toBe(true);
      expect(document.activeElement).toBe(w.find('[data-test="contact-disclosure"]').element);
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('does not steal focus during breakpoint shrink when focus was elsewhere (P2)', async () => {
    let matches = true;
    const listeners: Array<(e: MediaQueryListEvent) => void> = [];
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      get matches() { return matches; },
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: (_: string, cb: (e: MediaQueryListEvent) => void) => { listeners.push(cb); },
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountSix();
      await settle();
      // Focus lives in the list, not the contact column.
      await focusRowById(w, 'six-a');
      expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-six-a');

      matches = false;
      listeners.forEach((cb) => cb({ matches: false } as MediaQueryListEvent));
      await flushPromises();
      // Focus ownership is respected: the row keeps focus, no disclosure theft.
      expect(document.activeElement?.getAttribute('data-test')).toBe('conversation-row-six-a');
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('leaves no Contact overlay after explicit Inbox navigation (P2)', async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountSix();
      await settle();
      await w.find('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);

      // Explicit Inbox destination dismisses the Contact overlay.
      await w.find('[data-test="rail-inbox"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
      expect(w.find('[data-test="conversation-row-six-a"]').exists()).toBe(true);
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it('returns to Inbox (not Activity) when navigating from an Activity-origin reader (P2)', async () => {
    const w = mountApp(createBrowserFakeMailClient());
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    await openUtilityDrawer(w, 'activity');
    await w.find('[data-test^="activity-open-"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // Explicit Inbox destination clears the utility drawer and restores the
    // Inbox list rather than reopening the Activity drawer from the origin.
    // conv-01 was archived at the start, so conv-02 is the surviving list row.
    await w.find('[data-test="rail-inbox"]').trigger('click');
    await settle();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="conversation-row-conv-02"]').exists()).toBe(true);
    w.unmount();
    wrapper = null;
  });

  it('still returns to Activity after an ordinary Escape from an Activity-origin reader (P2)', async () => {
    const w = mountApp(createBrowserFakeMailClient());
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    await openUtilityDrawer(w, 'activity');
    await w.find('[data-test^="activity-open-"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // An ordinary Escape from the reader restores the originating Activity
    // surface, keeping the drawer visible alongside the saved list anchor.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
    w.unmount();
    wrapper = null;
  });

  it('does not hide the draft editor when Inbox navigation is requested while save is pending (P2)', async () => {
    const fake = createBrowserFakeMailClient();
    let resolveSave: ((value: Awaited<ReturnType<MailClient['saveDraft']>>) => void) | null = null;
    const client: MailClient = {
      ...fake,
      saveDraft: async (command) => {
        await new Promise<typeof resolveSave extends null ? never : Awaited<ReturnType<MailClient['saveDraft']>>>((resolve) => {
          resolveSave = resolve as typeof resolveSave;
        });
        return fake.saveDraft(command);
      },
    };
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await openUtilityDrawer(w, 'drafts');
    await w.find('[data-test="new-draft"]').trigger('click');
    await flushPromises();
    await w.find('[data-test="draft-body"]').setValue('must survive pending save');
    await flushPromises();

    // An explicit Inbox destination must await the protected closure and abort
    // when the editor remains pending/active, leaving the exact buffer visible.
    await w.find('[data-test="rail-inbox"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="draft-body"]').exists()).toBe(true);
    expect((w.find('[data-test="draft-body"]').element as HTMLTextAreaElement).value).toBe('must survive pending save');
    expect(w.find('[data-test="drafts-pane"]').exists()).toBe(true);
    w.unmount();
    wrapper = null;
  });
});

// ---------------------------------------------------------------------------
// Covered central surface (P1): a utility drawer or narrow Contact disclosure
// must isolate central row/reader actions from native focus and activation
// while it overlays them, and normal central interaction must return after
// dismissal. The rail and the active disclosure stay interactive.
// ---------------------------------------------------------------------------
describe('App covered central surface (P1)', () => {
  let fake: BrowserFake;
  let wrapper: VueWrapper | null = null;

  function mountFakeApp(): VueWrapper {
    const w = mount(App, { props: { client: fake, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }

  async function settleFake(): Promise<void> {
    await flushPromises();
    await fake.controls.flush();
    await flushPromises();
  }

  function archiveConfirmed(conversationId: string): boolean {
    return fake.controls.activity().some(
      (op) => op.conversation.conversationId === conversationId
        && op.requestedArchived === true
        && op.status === 'confirmed',
    );
  }

  beforeEach(() => {
    fake = createBrowserFakeMailClient();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  it('marks the central surface inert while a utility drawer is open and restores interaction after dismissal', async () => {
    const w = mountFakeApp();
    await settleFake();
    const central = w.find('[data-test="central-surface"]').element as HTMLElement;
    expect(central.hasAttribute('inert')).toBe(false);

    await openUtilityDrawer(w, 'activity');
    expect(central.hasAttribute('inert')).toBe(true);
    // The rail and the active drawer themselves stay interactive.
    expect((w.find('.rail').element as HTMLElement).hasAttribute('inert')).toBe(false);
    expect((w.find('[data-test="utility-drawer"]').element as HTMLElement).hasAttribute('inert')).toBe(false);

    await closeUtilityDrawer(w);
    expect(central.hasAttribute('inert')).toBe(false);

    // Normal central interaction works after dismissal.
    await w.find('[data-test="row-archive-conv-01"]').trigger('click');
    await settleFake();
    expect(archiveConfirmed('conv-01')).toBe(true);
  });

  it('marks the central surface inert while the narrow Contact disclosure is open and restores interaction after dismissal', async () => {
    // jsdom has no matchMedia, so App boots wide by default; force narrow mode
    // the same way the other narrow-viewport tests do.
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
    try {
      const w = mountFakeApp();
      await settleFake();
      expect(w.find('[data-test="contact-disclosure"]').exists()).toBe(true);
      const central = w.find('[data-test="central-surface"]').element as HTMLElement;
      expect(central.hasAttribute('inert')).toBe(false);

      await w.find('[data-test="contact-disclosure"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
      expect(central.hasAttribute('inert')).toBe(true);
      expect((w.find('.rail').element as HTMLElement).hasAttribute('inert')).toBe(false);
      expect((w.find('[data-test="contact-disclosure-panel"]').element as HTMLElement).hasAttribute('inert')).toBe(false);

      await w.find('[data-test="contact-disclosure-close"]').trigger('click');
      await flushPromises();
      expect(w.find('[data-test="contact-disclosure-panel"]').exists()).toBe(false);
      expect(central.hasAttribute('inert')).toBe(false);
      expect(document.activeElement).toBe(w.find('[data-test="contact-disclosure"]').element);
      w.unmount();
      wrapper = null;
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });
});

// ---------------------------------------------------------------------------
// UX-02 reader session: message commands, J/K in the reader, origin Back.
// Uses the synthetic three-message reader fixture (tests/reader.fixture.ts).
// ---------------------------------------------------------------------------
describe('App UX-02 reader session', () => {
  let fixture: ReaderFixture;
  let wrapper: VueWrapper | null = null;
  const originalGetBCR = HTMLElement.prototype.getBoundingClientRect;
  const originalScrollTop = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollTop');
  const scrollTopStore = new WeakMap<HTMLElement, number>();
  const rowDocTops = new Map<string, number>();

  function domRect(top: number, bottom: number): DOMRect {
    return {
      top, bottom, left: 0, right: 320, width: 320, height: bottom - top,
      x: 0, y: top, toJSON: () => ({}),
    } as DOMRect;
  }

  function mockGeometry(): void {
    Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
      configurable: true,
      get(this: HTMLElement) { return scrollTopStore.get(this) ?? 0; },
      set(this: HTMLElement, value: number) { scrollTopStore.set(this, value); },
    });
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement): DOMRect {
      if (this.tagName === 'UL' && this.classList.contains('inbox-scroll')) {
        return domRect(0, 360);
      }
      const testId = this.getAttribute?.('data-test');
      if (testId?.startsWith('conversation-row-')) {
        const scroller = this.closest('ul.inbox-scroll');
        const scroll = scroller instanceof HTMLElement ? (scrollTopStore.get(scroller) ?? 0) : 0;
        const docTop = rowDocTops.get(testId.slice('conversation-row-'.length)) ?? 0;
        return domRect(docTop - scroll, docTop - scroll + 34);
      }
      return originalGetBCR.call(this);
    };
  }

  function seedRowTops(): void {
    ['read-01', 'read-02', 'read-03', 'read-04'].forEach((id, index) => rowDocTops.set(id, index * 36));
  }

  async function focusRowById(w: VueWrapper, conversationId: string): Promise<void> {
    const row = w.find(`[data-test="conversation-row-${conversationId}"]`);
    (row.element as HTMLElement).focus();
    await row.trigger('focusin');
  }

  function mountReaderApp(): VueWrapper {
    const w = mount(App, { props: { client: fixture.client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }

  async function settle(): Promise<void> {
    await flushPromises();
    await flushMacrotasks(2);
    await flushPromises();
  }

  async function openReader(w: VueWrapper, conversationId: string): Promise<void> {
    await focusRowById(w, conversationId);
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
  }

  function readerSubject(w: VueWrapper): string | null {
    const subject = w.find('.reader-subject');
    return subject.exists() ? subject.text() : null;
  }

  function activeMessageToggle(): string | null {
    return document.activeElement?.getAttribute('data-test') ?? null;
  }

  beforeEach(() => {
    fixture = createReaderFixtureClient();
    rowDocTops.clear();
    seedRowTops();
    mockGeometry();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    HTMLElement.prototype.getBoundingClientRect = originalGetBCR;
    if (originalScrollTop) Object.defineProperty(HTMLElement.prototype, 'scrollTop', originalScrollTop);
    else delete (HTMLElement.prototype as { scrollTop?: unknown }).scrollTop;
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  it('opens focused on the newest message toggle and keeps N/P distinct from J/K', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    expect(readerSubject(w)).toBe('Reader journey thread');
    // Initial focus/expansion: newest message toggle, only the newest expanded.
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m3');
    expect(w.find('[data-test="message-toggle-read-01-m3"]').attributes('aria-expanded')).toBe('true');
    expect(w.find('[data-test="message-toggle-read-01-m1"]').attributes('aria-expanded')).toBe('false');

    // P moves message focus without expanding.
    window.dispatchEvent(keydown({ key: 'p' }));
    await flushPromises();
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m2');
    expect(w.find('[data-test="message-toggle-read-01-m2"]').attributes('aria-expanded')).toBe('false');
    // N moves back, still without expanding.
    window.dispatchEvent(keydown({ key: 'n' }));
    await flushPromises();
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m3');
    expect(w.find('[data-test="message-toggle-read-01-m2"]').attributes('aria-expanded')).toBe('false');

    // J is conversation movement, not message movement: the conversation changes.
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    expect(fixture.controls.detailCalls.map((ref) => ref.conversationId)).toContain('read-02');
    // K returns to the previous conversation with its visit state preserved.
    window.dispatchEvent(keydown({ key: 'k' }));
    await settle();
    expect(readerSubject(w)).toBe('Reader journey thread');
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m3');
  });

  it('expands all with Shift+O idempotently and collapses only the focused message with O', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    window.dispatchEvent(keydown({ key: 'O', shiftKey: true }));
    await flushPromises();
    expect(w.findAll('.message-toggle').map((t) => t.attributes('aria-expanded'))).toEqual(['true', 'true', 'true']);
    window.dispatchEvent(keydown({ key: 'O', shiftKey: true }));
    await flushPromises();
    expect(w.findAll('.message-toggle').map((t) => t.attributes('aria-expanded'))).toEqual(['true', 'true', 'true']);
    window.dispatchEvent(keydown({ key: 'o' }));
    await flushPromises();
    expect(w.findAll('.message-toggle').map((t) => t.attributes('aria-expanded'))).toEqual(['true', 'true', 'false']);
  });

  it('renders hostile markup literally inside expanded message bodies', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    window.dispatchEvent(keydown({ key: 'p' })); // focus the hostile middle message
    await flushPromises();
    window.dispatchEvent(keydown({ key: 'o' })); // expand it
    await flushPromises();
    expect(w.find('[data-test="reader"]').text()).toContain('<script>alert("body")</script>');
    expect(w.find('[data-test="reader"]').text()).toContain('<img src=x onerror=alert(1)> subject with <b>markup</b>');
    expect(w.find('script').exists()).toBe(false);
    expect(w.find('img').exists()).toBe(false);
    expect(w.findAll('a')).toHaveLength(0);
    expect(document.querySelectorAll('link[rel="stylesheet"][href^="http"]')).toHaveLength(0);
  });

  it('restores the ORIGINAL entry reference and anchor at nonzero scroll on Back', async () => {
    const w = mountReaderApp();
    await settle();
    const list = w.find('ul.inbox-scroll').element as HTMLElement;
    list.scrollTop = 36; // read-03 sits at doc top 72 → viewport offset 36
    await focusRowById(w, 'read-03');
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // Move the reader cursor away, then Back: the ORIGINAL entry reference
    // (read-03) and the captured viewport anchor must be restored.
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-04');
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-read-03');
    const scroller = w.find('ul.inbox-scroll').element as HTMLElement;
    expect(scroller.scrollTop).toBe(36);
    const restored = w.find('[data-test="conversation-row-read-03"]').element as HTMLElement;
    expect(restored.getBoundingClientRect().top).toBe(36);
  });

  it('resolves a removed entry reference to the next surviving old neighbor on Back', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    // Both the entry row and its next neighbor vanish while reading.
    fixture.controls.removeFromInbox('read-01');
    await settle();
    fixture.controls.removeFromInbox('read-02');
    await settle();
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-read-03');
  });

  it('resolves a removed J/K cursor through the entry ordering without wrapping', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    fixture.controls.removeFromInbox('read-01');
    await settle();
    // The cursor (read-01) is no longer in the snapshot; the entry ordering
    // resolves J to the next surviving neighbor (read-02).
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    // K from the first snapshot row clamps (no wrap, no access to removed rows).
    window.dispatchEvent(keydown({ key: 'k' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
  });

  it('archives the actioned conversation (not the entry origin) and advances to its surviving neighbor', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(fixture.controls.archiveCommands).toHaveLength(1);
    expect(fixture.controls.archiveCommands[0]!.conversation.conversationId).toBe('read-02');
    // The reader advanced to read-03 (surviving neighbor of the actioned
    // conversation), and the origin (read-01) was untouched.
    expect(readerSubject(w)).toBe('Neighbor thread read-03');
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-read-01');
  });

  it('advances through the ACTION-TIME ordering after a concurrent reorder, while Back keeps the entry ordering (P2)', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    // Entry ordering [01,02,03,04]; move the reader cursor to read-03.
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-03');
    // A backend reorder lands BEFORE the archive: action-time ordering is
    // [01,03,02,04], so the next surviving neighbor of read-03 is read-02.
    fixture.controls.reorderInbox(['read-01', 'read-03', 'read-02', 'read-04']);
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(fixture.controls.archiveCommands).toHaveLength(1);
    expect(fixture.controls.archiveCommands[0]!.conversation.conversationId).toBe('read-03');
    // Advancement follows the action-time ordering: read-02, not read-04.
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    // Back still restores the ORIGINAL entry reference through the immutable
    // entry ordering — the archived read-03 and the reorder do not affect it.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(focusedRow(w).attributes('data-test')).toBe('conversation-row-read-01');
  });

  it('archives the open conversation with E from the initial message-toggle focus (bubbling target)', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    // The default reader focus is the newest message toggle — navigation
    // context, not a toolbar button — so E must still archive the CURRENT
    // open conversation.
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m3');
    const toggle = document.querySelector('[data-test="message-toggle-read-01-m3"]');
    toggle!.dispatchEvent(keydown({ key: 'e' })); // bubbles from the real target
    await settle();
    expect(fixture.controls.archiveCommands).toHaveLength(1);
    expect(fixture.controls.archiveCommands[0]!.conversation.conversationId).toBe('read-01');
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
  });

  it('keeps E usable after N/P moves message focus, and still blocks toolbar buttons', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    // A focused toolbar button keeps the generic exclusion.
    (w.find('[data-test="reader-archive-toggle"]').element as HTMLElement).focus();
    (w.find('[data-test="reader-archive-toggle"]').element as HTMLElement).dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(fixture.controls.archiveCommands).toHaveLength(0);
    window.dispatchEvent(keydown({ key: 'p' }));
    await settle();
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m2');
    const toggle = document.querySelector('[data-test="message-toggle-read-01-m2"]');
    toggle!.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    // The action targets the current open conversation, never the focused message.
    expect(fixture.controls.archiveCommands).toHaveLength(1);
    expect(fixture.controls.archiveCommands[0]!.conversation.conversationId).toBe('read-01');
  });

  it('marks the open conversation unread with Shift+U from message-toggle focus in enabled synthetic Gmail', async () => {
    // Test-only account-status wrapper supplies enabled synthetic Gmail without
    // changing production authority or fixture reply semantics.
    const client: MailClient = {
      ...fixture.client,
      getAccountStatus: (): Promise<AccountStatus> => Promise.resolve({
        mode: 'gmail',
        connection: 'connected',
        account: { accountId: 'reader-account', emailAddress: 'reader@example.test' },
        sync: { state: 'idle', lastSyncedAt: '2026-02-02T12:00:00Z', error: null, cachedConversations: 4, initialSyncComplete: true, coverageLimit: 0 },
        mutationAccess: 'enabled',
      }),
    };
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await openReader(w, 'read-01');
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m3');
    const toggle = document.querySelector('[data-test="message-toggle-read-01-m3"]');
    toggle!.dispatchEvent(keydown({ key: 'U', shiftKey: true }));
    await settle();
    expect(fixture.controls.readCommands).toHaveLength(1);
    expect(fixture.controls.readCommands[0]!.conversation.conversationId).toBe('read-01');
    expect(fixture.controls.readCommands[0]!.read).toBe(false);
    expect(fixture.controls.archiveCommands).toHaveLength(0);
  });

  it('keeps a stale delayed detail from replacing a newer cursor and refuses actions while loading', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    fixture.controls.delayNextDetail(60);
    window.dispatchEvent(keydown({ key: 'j' })); // read-02 → loading, response delayed
    await flushPromises();
    expect(w.find('[data-test="reader-loading"]').exists()).toBe(true);
    // A loading detail supplies no action target.
    window.dispatchEvent(keydown({ key: 'e' }));
    await flushPromises();
    expect(fixture.controls.archiveCommands).toHaveLength(0);
    // Move on: read-03 resolves immediately and becomes the current cursor.
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-03');
    // Make read-02 distinguishable while the stale (delayed) read-02 response
    // from the first J is still pending, so a stale replacement is observable.
    fixture.controls.replaceDetail('read-02', { subject: 'Changed neighbor read-02' });
    await settle();
    // Go back to read-02: the fresh fetch returns the CHANGED content.
    window.dispatchEvent(keydown({ key: 'k' }));
    await settle();
    expect(readerSubject(w)).toBe('Changed neighbor read-02');
    // Now let the stale read-02 response (old subject) settle: it must not
    // replace the newer cursor's state.
    await new Promise((resolve) => setTimeout(resolve, 80));
    await settle();
    expect(readerSubject(w)).toBe('Changed neighbor read-02');
    expect(w.find('[data-test="reader-loading"]').exists()).toBe(false);
  });

  it('does not reopen the reader when a late archive receipt arrives after Back', async () => {
    const accepted = deferred<Awaited<ReturnType<MailClient['setArchived']>>>();
    let receipt: Awaited<ReturnType<MailClient['setArchived']>> | undefined;
    const client: MailClient = {
      ...fixture.client,
      setArchived: async (command) => {
        receipt = await fixture.client.setArchived(command);
        return accepted.promise;
      },
    };
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    await settle();
    await openReader(w, 'read-01');
    window.dispatchEvent(keydown({ key: 'e' }));
    await flushPromises();
    window.dispatchEvent(keydown({ key: 'Escape' }));
    accepted.resolve(receipt!);
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
  });

  it('leaves reader ArrowUp/ArrowDown to native behavior with no fetch (inbox origin, P2)', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    const callsBefore = fixture.controls.detailCalls.length;
    const down = keydown({ key: 'ArrowDown', cancelable: true });
    window.dispatchEvent(down);
    await settle();
    const up = keydown({ key: 'ArrowUp', cancelable: true });
    window.dispatchEvent(up);
    await settle();
    // Native default: no preventDefault, no conversation fetch, no cursor move.
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(fixture.controls.detailCalls.length).toBe(callsBefore);
    expect(readerSubject(w)).toBe('Reader journey thread');
    // j/k still switch conversations inside the reader.
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
  });

  it('leaves reader ArrowUp/ArrowDown to native behavior with no fetch (Activity origin, P2)', async () => {
    const w = mountReaderApp();
    await settle();
    await openUtilityDrawer(w, 'activity');
    await w.find('[data-test="activity-open-read-op-1"]').trigger('click');
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    const callsBefore = fixture.controls.detailCalls.length;
    const down = keydown({ key: 'ArrowDown', cancelable: true });
    window.dispatchEvent(down);
    await settle();
    const up = keydown({ key: 'ArrowUp', cancelable: true });
    window.dispatchEvent(up);
    await settle();
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
    expect(fixture.controls.detailCalls.length).toBe(callsBefore);
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
  });

  it('treats J/K as a no-op for Activity-origin readers (duplicate references included) and returns to Activity on Back', async () => {
    const w = mountReaderApp();
    await settle();
    await openUtilityDrawer(w, 'activity');
    // The fixture carries duplicate Activity references to read-02.
    await w.find('[data-test="activity-open-read-op-1"]').trigger('click');
    await settle();
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    const callsBefore = fixture.controls.detailCalls.length;
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    window.dispatchEvent(keydown({ key: 'k' }));
    await settle();
    // No navigation and no getConversation calls for an Activity origin.
    expect(fixture.controls.detailCalls.length).toBe(callsBefore);
    expect(readerSubject(w)).toBe('Neighbor thread read-02');
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
    expect(w.find('[data-test="reader"]').exists()).false;
  });

  it('keeps Escape precedence: drawer first, then message details, then the reader', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    const details = w.find('[data-test="message-details-read-01-m3"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await flushPromises();
    // A drawer opened over the reader takes Escape precedence.
    await openUtilityDrawer(w, 'activity');
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await flushPromises();
    expect(w.find('[data-test="utility-drawer"]').exists()).toBe(false);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect((w.find('[data-test="message-details-read-01-m3"]').element as HTMLDetailsElement).open).toBe(true);
    // Next Escape dismisses the open details disclosure, keeping the reader.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect((w.find('[data-test="message-details-read-01-m3"]').element as HTMLDetailsElement).open).toBe(false);
    // Final Escape closes the reader.
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
  });

  it('suppresses reader message commands under the modifier, IME, editable, and overlay guards', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    const before = activeMessageToggle();
    window.dispatchEvent(keydown({ key: 'n', ctrlKey: true }));
    const ime = keydown({ key: 'n' });
    Object.defineProperty(ime, 'isComposing', { value: true });
    window.dispatchEvent(ime);
    window.dispatchEvent(keydown({ key: 'n', keyCode: 229 }));
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(keydown({ key: 'n' }));
    input.remove();
    await flushPromises();
    expect(activeMessageToggle()).toBe(before);
    // J under modifiers is equally suppressed.
    window.dispatchEvent(keydown({ key: 'j', metaKey: true }));
    await flushPromises();
    expect(readerSubject(w)).toBe('Reader journey thread');
    // With a drawer open, reader commands are suppressed underneath it.
    await openUtilityDrawer(w, 'activity');
    const callsBefore = fixture.controls.detailCalls.length;
    window.dispatchEvent(keydown({ key: 'n' }));
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    expect(activeMessageToggle()).not.toBe('message-toggle-read-01-m2');
    expect(fixture.controls.detailCalls.length).toBe(callsBefore);
  });

  it('keeps a participant override when focus lands directly on a newly focused message participant (P2)', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    // Baseline: newest message sender (m3, Ada).
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
    // Open the OLDEST message's details and focus its recipient Ravi directly,
    // without first focusing the message summary: the reader emits Ravi's
    // override BEFORE the active-message event, and App must not clear it.
    const details = w.find('[data-test="message-details-read-01-m1"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await flushPromises();
    const ravi = w.find('[data-test="participant-to-read-01-m1-ravi@example.test"]');
    (ravi.element as HTMLElement).focus();
    await flushPromises();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ravi Longname');
    // The override survives the active-message event that the same focus also
    // produced, including a full settle of background work.
    await settle();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ravi Longname');
    // Focus moved to the newly focused message identity (read-01-m1).
    expect(w.find('[data-test="message-read-01-m1"]').classes()).toContain('message-active');
    // Blur restores the baseline.
    (ravi.element as HTMLElement).blur();
    await flushPromises();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
  });

  it('temporarily overrides the reader contact from participant hover/focus and restores the baseline', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    // Baseline: the active (newest) message sender.
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
    // Open the oldest message's details and hover its nameless sender.
    const details = w.find('[data-test="message-details-read-01-m2"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await flushPromises();
    const participant = w.find('[data-test="participant-from-read-01-m2"]');
    await participant.trigger('mouseenter');
    await flushPromises();
    expect(w.find('[data-test="contact-name"]').text()).toBe('anon@example.test');
    await participant.trigger('mouseleave');
    await flushPromises();
    // Exit restores the baseline.
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
    // Keyboard focus tracks independently of hover.
    const named = w.find('[data-test="participant-from-read-01-m1"]');
    (named.element as HTMLElement).focus();
    await flushPromises();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
    (named.element as HTMLElement).blur();
    await flushPromises();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
    // An unknown-recipient hover on a removed message must never leak: removal
    // invalidates the override by identity.
    await participant.trigger('mouseenter');
    await flushPromises();
    fixture.controls.removeMessage('read-01', 'read-01-m2');
    await settle();
    expect(w.find('[data-test="contact-name"]').text()).toBe('Ada Fixture');
  });

  it('keeps the reply source fixed to the latest message even when an older message is focused', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    expect(w.find('[data-test="reply-source-label"]').text()).toContain('Ada Fixture');
    window.dispatchEvent(keydown({ key: 'p' }));
    window.dispatchEvent(keydown({ key: 'p' }));
    await flushPromises();
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m1');
    // The label still names the latest source.
    expect(w.find('[data-test="reply-source-label"]').text()).toContain('Ada Fixture');
    await w.find('[data-test="prepare-reply"]').trigger('click');
    await settle();
    expect(fixture.controls.draftCreations).toHaveLength(1);
    expect(fixture.controls.draftCreations[0]!.source).toEqual({
      kind: 'reply',
      conversation: { accountId: 'reader-account', conversationId: 'read-01' },
      sourceMessageId: 'read-01-m3',
    });
    expect(w.find('[data-test="draft-body"]').exists()).toBe(true);
  });

  it('preserves expansion, focus, and message identity through background replacement and message removal', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    window.dispatchEvent(keydown({ key: 'p' }));
    window.dispatchEvent(keydown({ key: 'p' }));
    window.dispatchEvent(keydown({ key: 'o' })); // expand the oldest message
    await flushPromises();
    expect(w.find('[data-test="message-toggle-read-01-m1"]').attributes('aria-expanded')).toBe('true');
    // Same-reference background replacement: no focus theft, expansion kept.
    fixture.controls.replaceDetail('read-01');
    await settle();
    expect(activeMessageToggle()).toBe('message-toggle-read-01-m1');
    expect(w.find('[data-test="message-toggle-read-01-m1"]').attributes('aria-expanded')).toBe('true');
    // Focused message removed remotely: identity resolves to the next survivor.
    window.dispatchEvent(keydown({ key: 'n' }));
    window.dispatchEvent(keydown({ key: 'n' }));
    await flushPromises(); // focus is back on the newest toggle
    fixture.controls.removeMessage('read-01', 'read-01-m3');
    await settle();
    expect(document.activeElement?.getAttribute('data-test')).toBe('message-toggle-read-01-m2');
    expect(w.find('[data-test="message-read-01-m2"]').classes()).toContain('message-active');
  });

  it('adds no mailbox writes during a pure reading journey (copy, hover, details, navigation)', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w, 'read-01');
    window.dispatchEvent(keydown({ key: 'p' }));
    window.dispatchEvent(keydown({ key: 'O', shiftKey: true }));
    const details = w.find('[data-test="message-details-read-01-m2"]');
    (details.element as HTMLDetailsElement).open = true;
    details.element.dispatchEvent(new Event('toggle'));
    await w.find('[data-test="participant-from-read-01-m2"]').trigger('mouseenter');
    await w.find('[data-test="participant-from-read-01-m2"]').trigger('mouseleave');
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    window.dispatchEvent(keydown({ key: 'j' }));
    await settle();
    window.dispatchEvent(keydown({ key: 'k' }));
    await settle();
    window.dispatchEvent(keydown({ key: 'Escape' }));
    await settle();
    expect(fixture.controls.archiveCommands).toHaveLength(0);
    expect(fixture.controls.readCommands).toHaveLength(0);
    expect(fixture.controls.draftCreations).toHaveLength(0);
  });
});

describe('App UX-02 contact copy controls', () => {
  let fixture: ReaderFixture;
  let wrapper: VueWrapper | null = null;

  async function settle(): Promise<void> {
    await flushPromises();
    await flushMacrotasks(2);
    await flushPromises();
  }

  beforeEach(() => {
    fixture = createReaderFixtureClient();
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    delete (navigator as { clipboard?: unknown }).clipboard;
  });

  function mountReaderApp(): VueWrapper {
    const w = mount(App, { props: { client: fixture.client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }

  async function openReader(w: VueWrapper): Promise<void> {
    const row = w.find('[data-test="conversation-row-read-01"]');
    (row.element as HTMLElement).focus();
    await row.trigger('focusin');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
  }

  it('reports unavailable clipboard APIs with an honest manual-copy notice and no side effects', async () => {
    expect(navigator.clipboard).toBeUndefined();
    const w = mountReaderApp();
    await settle();
    await openReader(w);
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    const status = w.find('[data-test="copy-status"]');
    expect(status.exists()).toBe(true);
    expect(status.text()).toContain('unavailable');
    expect(status.text()).toContain('manually');
    expect(status.attributes('data-copy-ok')).toBe('false');
    // No draft, no navigation, no mailbox write.
    expect(fixture.controls.draftCreations).toHaveLength(0);
    expect(fixture.controls.archiveCommands).toHaveLength(0);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('copies the exact displayed address only after explicit activation', async () => {
    const writes: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => { writes.push(text); } },
    });
    const w = mountReaderApp();
    await settle();
    await openReader(w);
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    expect(writes).toEqual(['ada@example.test']);
    expect(w.find('[data-test="copy-status"]').attributes('data-copy-ok')).toBe('true');
    expect(fixture.controls.draftCreations).toHaveLength(0);
  });

  it('reports a clipboard rejection accessibly without drafts or navigation', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async () => { throw new Error('denied'); } },
    });
    const w = mountReaderApp();
    await settle();
    await openReader(w);
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').attributes('data-copy-ok')).toBe('false');
    expect(w.find('[data-test="copy-status"]').text()).toContain('failed');
    expect(fixture.controls.draftCreations).toHaveLength(0);
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
  });

  it('hides the copy-name control when no display name is known', async () => {
    const w = mountReaderApp();
    await settle();
    await openReader(w);
    // The reader baseline contact (newest message sender) has a display name.
    expect(w.find('[data-test="copy-name"]').exists()).toBe(true);
    await w.find('[data-test="copy-email"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="copy-status"]').exists()).toBe(true);
  });
});
