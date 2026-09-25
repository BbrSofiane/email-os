import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { MailClient } from '../src/lib/ipc/client';
import {
  countingClient,
  createBrowserFakeMailClient,
  flushMacrotasks,
  deferred,
  fixtureRef,
  type BrowserFake,
} from './helpers';

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

  it('discloses memory-only preview and renders the seeded inbox', async () => {
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="preview-banner"]').text()).toContain('in-memory');
    expect(w.find('[data-test="preview-banner"]').text()).toContain('native core is not connected');
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('navigates with j/k and arrow keys, moving DOM focus with selection', async () => {
    const w = mountApp();
    await settle();
    const rows = w.findAll('[role="option"]');
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.trigger('focusin');
    await flushPromises();
    expect(document.activeElement).toBe(rows[0]!.element);

    window.dispatchEvent(keydown({ key: 'j' }));
    await flushPromises();
    expect(document.activeElement).toBe(rows[1]!.element);
    expect(rows[1]!.attributes('aria-selected')).toBe('true');

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
    expect(rows[0]!.attributes('aria-selected')).toBe('true');
  });

  it('opens with Enter, closes with Escape, and restores list focus', async () => {
    const w = mountApp();
    await settle();
    const rows = w.findAll('[role="option"]');
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
    expect(document.activeElement).toBe(rows[1]!.element);
  });

  it('archives with e: row leaves the inbox, selection and focus stay predictable', async () => {
    const w = mountApp();
    await settle();
    const rows = w.findAll('[role="option"]');
    expect(rows[0]!.text()).toContain('conv-01');
    (rows[0]!.element as HTMLElement).focus();
    rows[0]!.trigger('focusin');
    await flushPromises();

    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();

    const after = w.findAll('[role="option"]');
    expect(after).toHaveLength(17);
    expect(after[0]!.text()).toContain('conv-02');
    // selection index unchanged (0), focus moved to the row now at index 0
    expect(after[0]!.attributes('aria-selected')).toBe('true');
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
    expect(w.findAll('[role="option"]')).toHaveLength(17);

    // pause the fake provider, then unarchive: the row must reappear while the
    // operation is still visible as pending/applying
    fake.controls.behavior.hold = true;
    await w.find('[data-test^="activity-unarchive-"]').trigger('click');
    await flushPromises();
    const rows = w.findAll('[role="option"]');
    expect(rows).toHaveLength(18);
    expect(w.find('[data-test="row-pending"]').exists()).toBe(true);
    expect(w.text()).toContain('applying…');

    fake.controls.release();
    await settle();
    expect(w.find('[data-test="row-pending"]').exists()).toBe(false);
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('renders failed operations in activity and reverts the row to the inbox', async () => {
    const w = mountApp();
    await settle();
    fake.controls.behavior.failNext = 1;
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(w.find('[data-test="activity-failed"]').exists()).toBe(true);
    expect(w.find('[data-test="activity-failed"]').text()).toContain('failed (provider_rejected)');
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('unarchives from activity and opens archived conversations from activity', async () => {
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(w.findAll('[role="option"]')).toHaveLength(17);

    await w.find('[data-test^="activity-unarchive-"]').trigger('click');
    await settle();
    expect(w.findAll('[role="option"]')).toHaveLength(18);

    // Explicitly select the restored row: background insertion preserves focus on conv-02.
    const restored = w.findAll('[role="option"]')[0]!;
    (restored.element as HTMLElement).focus();
    await restored.trigger('focusin');
    // archive again, then Open from activity must still show the archived thread
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
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
    // selection did not move (still the first row selected via default index 0)
    expect(w.findAll('[role="option"]')[0]!.attributes('aria-selected')).toBe('true');
  });

  it('renders hostile markup as literal text with no script/img/link elements or remote assets', async () => {
    const w = mountApp();
    await settle();
    // conv-06 is the hostile fixture; move selection to index 5 and open
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
    expect(w.findAll('[role="option"]')).toHaveLength(0);
  });

  it('shows a loading state while the initial read is in flight', async () => {
    let resolveList!: (value: Awaited<ReturnType<MailClient['listConversations']>>) => void;
    const client: MailClient = {
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
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('advances from an archived reader to the next conversation', async () => {
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'Enter' }));
    await settle();
    await w.find('[data-test="reader-archive-toggle"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 2');
    expect(w.findAll('[role="option"]')).toHaveLength(17);
    expect(document.activeElement).toBe(w.find('[data-test="reader"]').element);
  });

  it('does not archive the previous conversation while the next detail is loading', async () => {
    const pending = deferred<Awaited<ReturnType<MailClient['getConversation']>>>();
    const client: MailClient = {
      ...counted.client,
      getConversation: (target) => target.conversationId === 'conv-02' ? pending.promise : fake.getConversation(target),
    };
    const w = mountApp(client);
    await settle();
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    await w.findAll('[role="option"]')[1]!.trigger('click');
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
    const first = w.findAll('[role="option"]')[0]!;
    (first.element as HTMLElement).focus();
    await first.trigger('focusin');
    window.dispatchEvent(keydown({ key: 'e' }));
    await flushPromises();
    const focused = document.activeElement;
    expect(focused?.textContent).toContain('conv-02');
    fake.controls.release();
    await settle();
    expect(document.activeElement).toBe(focused);
    expect(w.findAll('[role="option"]')[1]!.attributes('aria-selected')).toBe('true');
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
