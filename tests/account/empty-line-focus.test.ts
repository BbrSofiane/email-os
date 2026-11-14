import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { MailClient } from '../../src/lib/ipc/client';
import {
  countingClient,
  createBrowserFakeMailClient,
  deferred,
  mountApp as mountSharedApp,
  press,
  useGmailMode,
  type BrowserFake,
  type CountingClient,
} from '../helpers';
import { flushFakeClientWithMacrotasks } from '../support/ui-settle';

/** A client whose inbox list is always empty, over a fake that keeps reporting its real account status. */
function withNoRows(client: MailClient): MailClient {
  return { ...client, listConversations: async () => ({ conversations: [], activity: [] }) };
}

describe('empty line action: keyboard reach and one live action', () => {
  let fake: BrowserFake;
  let counted: CountingClient;

  const mountApp = (client: MailClient = withNoRows(counted.client)): VueWrapper => mountSharedApp(client, 'browser-preview', { attachTo: document.body });
  const gmail = (patch: Parameters<typeof useGmailMode>[1] = {}): void => useGmailMode(fake, patch);
  const action = (w: VueWrapper) => w.find('[data-test="inbox-empty-action"]');
  const none = { connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false } as const;
  const failed = { syncState: 'error', syncError: { kind: 'network_unavailable' }, cachedConversations: 0, initialSyncComplete: false } as const;
  const expired = { connection: 'auth_required', cachedConversations: 0 } as const;

  /** A client whose first inbox list waits for the test, so focus can be placed before the empty line appears. */
  function slowList(): { client: MailClient; release: () => Promise<void> } {
    const gate = deferred<void>();
    const client: MailClient = {
      ...counted.client,
      listConversations: async () => { await gate.promise; return { conversations: [], activity: [] }; },
    };
    return { client, release: async () => { gate.resolve(); await flushFakeClientWithMacrotasks(fake, 3); } };
  }

  /** A real focusable control that is not part of the app, standing in for any input the user is already in. */
  function outsideInput(): HTMLInputElement {
    const input = document.createElement('input');
    document.body.append(input);
    input.focus();
    return input;
  }

  beforeEach(() => {
    fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    counted = countingClient(fake);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.querySelectorAll(':scope > input').forEach((input) => input.remove());
  });

  describe('focus lands on the action when the line becomes its owner and nothing is focused', () => {
    it.each([
      ['not connected', none, 'Connect Gmail'],
      ['sign-in expired', expired, 'Sign in again'],
      ['sync failed', failed, 'Retry'],
      ['sign-in in progress', { connection: 'authenticating', emailAddress: null, cachedConversations: 0, initialSyncComplete: false }, 'Cancel sign-in'],
      ['first sync unfinished', { cachedConversations: 0, initialSyncComplete: false }, 'Sync now'],
      ['not configured', { connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false }, 'Account'],
    ] as const)('%s: focus moves to %s at once', async (_label, patch, label) => {
      gmail(patch);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(action(w).text()).toBe(label);
      expect(document.activeElement).toBe(action(w).element);
    });

    it('leaves focus alone when the line only reports an empty inbox (no action to reach)', async () => {
      gmail({ cachedConversations: 0 });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(action(w).exists()).toBe(false);
      expect(document.activeElement).toBe(document.body);
    });

    it('does not scroll the page to the action', async () => {
      const focus = vi.spyOn(HTMLElement.prototype, 'focus');
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const calls = focus.mock.instances.map((instance, index) => [instance, focus.mock.calls[index]] as const)
        .filter(([instance]) => instance === action(w).element);
      expect(calls.length).toBeGreaterThan(0);
      for (const [, args] of calls) expect(args[0]).toEqual({ preventScroll: true });
    });
  });

  describe('focus never moves when the user is already somewhere', () => {
    it('an input holds focus: the action is not taken from it', async () => {
      gmail(none);
      const slow = slowList();
      const w = mountApp(slow.client);
      await flushPromises();
      const input = outsideInput();
      await slow.release();
      expect(action(w).exists()).toBe(true);
      expect(document.activeElement).toBe(input);
    });

    it('the Account drawer is open with focus on <body>: no steal', async () => {
      gmail(none);
      const slow = slowList();
      const w = mountApp(slow.client);
      await flushPromises();
      await w.get('[data-test="rail-account"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="utility-drawer"]').exists()).toBe(true);
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      await slow.release();
      expect(action(w).exists()).toBe(true);
      expect(document.activeElement).toBe(document.body);
    });

    it('the palette is open with focus on <body>: no steal', async () => {
      gmail(none);
      const slow = slowList();
      const w = mountApp(slow.client);
      await flushPromises();
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[role="listbox"]').exists()).toBe(true);
      (document.activeElement as HTMLElement).blur();
      expect(document.activeElement).toBe(document.body);
      await slow.release();
      expect(action(w).exists()).toBe(true);
      expect(document.activeElement).toBe(document.body);
    });

    it('is not taken again after the user moves focus: it happens once per transition into the state', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(document.activeElement).toBe(action(w).element);
      const input = outsideInput();
      // Opening and closing the drawer re-renders the line (its action is hidden or shown around it).
      await w.get('[data-test="rail-account"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="drawer-close"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(document.activeElement).not.toBe(action(w).element);
      input.focus();
      input.blur();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(document.activeElement).toBe(document.body);
    });

    it('keeps focus on the empty line while the same line changes state (Connect, then Cancel sign-in)', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(document.activeElement).toBe(action(w).element);
      await action(w).trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.get('[data-test="inbox-empty"]').text()).toContain('No conversations in the cached inbox.');
      expect(document.activeElement).toBe(w.get('[data-test="inbox-empty"]').element);
    });
  });

  describe('Enter and Space on the focused empty line run its action', () => {
    it.each([['Enter'], [' ']])('%j connects from the empty line', async (key) => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      (w.get('[data-test="inbox-empty"]').element as HTMLElement).focus();
      const event = press(key, { bubbles: true, cancelable: true });
      expect(event.defaultPrevented).toBe(true);
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
    });

    it('Enter retries a failed sync once, through the same request as the button', async () => {
      gmail(failed);
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      (w.get('[data-test="inbox-empty"]').element as HTMLElement).focus();
      press('Enter', { bubbles: true, cancelable: true });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('with the Account action, Enter opens the drawer', async () => {
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      (w.get('[data-test="inbox-empty"]').element as HTMLElement).focus();
      press('Enter', { bubbles: true, cancelable: true });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    it('does nothing with a modifier or on repeat', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      (w.get('[data-test="inbox-empty"]').element as HTMLElement).focus();
      press('Enter', { metaKey: true, bubbles: true, cancelable: true });
      press('Enter', { ctrlKey: true, bubbles: true, cancelable: true });
      press('Enter', { repeat: true, bubbles: true, cancelable: true });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('disconnected');
    });
  });

  describe('one live action: the line behind the Account drawer drops its Retry while the drawer has its own', () => {
    it('hides the empty line Retry (keeping the sentence) while the drawer shows the same failure, and restores it on close', async () => {
      gmail(failed);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(action(w).text()).toBe('Retry');
      await w.get('[data-test="rail-account"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="account-sync-error"]').exists()).toBe(true);
      expect(action(w).exists()).toBe(false);
      expect(w.get('[data-test="inbox-empty"]').text()).toContain('Sync failed: no network.');
      await w.get('[data-test="drawer-close"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(action(w).text()).toBe('Retry');
    });

    it('keeps the Retry when the drawer has no failure alert of its own (a failure with no typed cause)', async () => {
      gmail({ syncState: 'error', syncError: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="rail-account"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(action(w).text()).toBe('Retry');
    });

    it('keeps the connection actions: the drawer does not repeat them as an alert', async () => {
      gmail(expired);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="rail-account"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(action(w).text()).toBe('Sign in again');
    });
  });
});
