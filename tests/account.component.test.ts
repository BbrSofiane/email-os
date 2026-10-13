import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { Conversation, InboxSnapshot, MailClient } from '../src/lib/ipc/client';
import {
  countingClient,
  createBrowserFakeMailClient,
  deferred,
  fixtureRef,
  flushMacrotasks,
  useGmailMode,
  type BrowserFake,
  type CountingClient,
} from './helpers';

function keydown(init: KeyboardEventInit & { keyCode?: number }): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { bubbles: true, ...init });
  if (init.keyCode !== undefined) {
    Object.defineProperty(event, 'keyCode', { value: init.keyCode });
  }
  return event;
}

describe('App (Slice 02 Gmail account states)', () => {
  let fake: BrowserFake;
  let counted: CountingClient;
  let wrapper: VueWrapper | null = null;

  function mountApp(client: MailClient = counted.client): VueWrapper {
    const w = mount(App, {
      props: { client, mode: 'browser-preview' },
      attachTo: document.body,
    });
    wrapper = w;
    return w;
  }

  async function settle(): Promise<void> {
    await flushPromises();
    await fake.controls.flush();
    await flushPromises();
    await flushMacrotasks(2);
    await flushPromises();
  }

  beforeEach(() => {
    fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    counted = countingClient(fake);
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
  });

  /** Switches the fake into gmail mode before mounting. */
  function gmail(patch: Parameters<typeof useGmailMode>[1] = {}): void {
    useGmailMode(fake, patch);
  }

  it('shows the account panel, read-only inbox, and no archive controls when connected', async () => {
    gmail();
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    expect(w.find('[data-test="account-email"]').text()).toBe('operator@example.test');
    expect(w.find('[data-test="disposable-account-note"]').text()).toContain('Disposable test account');
    expect(w.find('[data-test="account-connection"]').text()).toContain('Connected');
    expect(w.find('[data-test="account-mode"]').text()).toContain('read-only');
    expect(w.findAll('[role="option"]')).toHaveLength(18);

    // Opening a conversation: no archive toggle, an explicit read-only note.
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader-archive-toggle"]').exists()).toBe(false);
    expect(w.find('[data-test="reader-readonly"]').exists()).toBe(true);

    // Keyboard e must not mutate from the list or the reader.
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(counted.commands).toHaveLength(0);

    // Activity never offers unarchive in gmail mode.
    expect(w.find('[data-test^="activity-unarchive-"]').exists()).toBe(false);
    expect(w.find('[data-test="activity-empty"]').exists()).toBe(true);
  });

  it('shows a visible not_configured state with no mailbox content and no fallback', async () => {
    gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-not-configured"]').exists()).toBe(true);
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    const connect = w.find('[data-test="account-connect"]');
    expect(connect.exists()).toBe(true);

    await connect.trigger('click');
    await settle();
    expect(w.find('[data-test="account-connection"]').text()).toContain('Connected');
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('moves from disconnected to connected through the connect control', async () => {
    gmail({ connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-connection"]').text()).toContain('Disconnected');
    expect(w.findAll('[role="option"]')).toHaveLength(0);

    await w.find('[data-test="account-connect"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-connection"]').text()).toContain('Connected');
    expect(w.find('[data-test="account-email"]').text()).toBe('operator@example.test');
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it.each(['disconnected', 'not_configured'] as const)(
    'keeps local disconnect available for a retained account in %s state',
    async (connection) => {
      gmail({ connection, emailAddress: 'retained@example.test' });
      const w = mountApp();
      await settle();
      expect(w.find('[data-test="account-email"]').text()).toBe('retained@example.test');
      expect(w.find('[data-test="account-disconnect"]').exists()).toBe(true);
      expect(w.find('[data-test="account-disconnect"]').text()).toBe('Disconnect');

      await w.find('[data-test="account-disconnect"]').trigger('click');
      await settle();
      expect(w.find('[data-test="account-email"]').exists()).toBe(false);
      expect(w.find('[data-test="account-connection"]').text()).toContain('Disconnected');
      expect(w.find('[data-test="account-disconnect"]').exists()).toBe(false);
    },
  );

  it('keeps the cached reader usable while sign-in is required (auth_required)', async () => {
    gmail({ connection: 'auth_required', lastSyncedAt: '2025-01-01T00:00:00.000Z' });
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-connection"]').text()).toContain('Sign-in required');
    expect(w.find('[data-test="account-auth-required"]').exists()).toBe(true);
    expect(w.find('[data-test="account-connect"]').text()).toContain('Sign in again');
    // Cached content stays readable.
    expect(w.findAll('[role="option"]')).toHaveLength(18);
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 1');
    expect(w.find('[data-test="reader-archive-toggle"]').exists()).toBe(false);
  });

  it('allows canceling sign-in while authenticating without offering a second connect', async () => {
    gmail({ connection: 'authenticating' });
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-connection"]').text()).toContain('Signing in');
    expect(w.find('[data-test="account-connect"]').exists()).toBe(false);
    expect(w.find('[data-test="account-disconnect"]').text()).toContain('Cancel sign-in');
    await w.find('[data-test="account-disconnect"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-connection"]').text()).toContain('Disconnected');
  });

  it('runs an explicit sync and discloses failures while cached mail stays readable', async () => {
    gmail();
    const w = mountApp();
    await settle();
    await w.find('[data-test="account-sync"]').trigger('click');
    expect(w.find('[data-test="account-sync-state"]').text()).toContain('Syncing');
    await settle();
    expect(w.find('[data-test="account-sync-state"]').text()).toContain('Idle');
    expect(w.find('[data-test="account-last-synced"]').text()).toContain('2025-01-01');

    fake.controls.failNextSync({ kind: 'network_unavailable' });
    await w.find('[data-test="account-sync"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-sync-error"]').exists()).toBe(true);
    expect(w.find('[data-test="account-sync-error"]').text()).toContain('network is unavailable');
    // The cached reader is still fully usable after the sync error.
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').text()).toContain('Fixture thread 1');
  });

  it('discloses limited cached coverage and freshness', async () => {
    gmail({ cachedConversations: 7, initialSyncComplete: false, lastSyncedAt: null, coverageLimit: 100 });
    const w = mountApp();
    await settle();
    const coverage = w.find('[data-test="account-coverage"]').text();
    expect(coverage).toContain('7');
    expect(coverage).toContain('100');
    expect(coverage).toContain('may be incomplete');
    expect(coverage).not.toContain('most recent');
    expect(w.find('[data-test="account-last-synced"]').text()).toContain('Never synced');
  });

  it('discloses unsupported plain-text context in the reader', async () => {
    gmail();
    fake.controls.markUnsupported('conv-01', 'HTML-only messages are not shown', false);
    const w = mountApp();
    await settle();
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="unsupported-notice"]').text()).toContain('HTML-only messages are not shown');

    // A conversation without limitations shows no notice.
    await w.find('[data-test="reader-close"]').trigger('click');
    await flushPromises();
    await w.findAll('[role="option"]')[1]!.trigger('click');
    await settle();
    expect(w.find('[data-test="unsupported-notice"]').exists()).toBe(false);
    expect(w.find('[data-test="context-incomplete"]').exists()).toBe(false);
  });

  it('fails closed with a visible retry when the status read errors', async () => {
    gmail();
    fake.controls.failNextStatus({ kind: 'storage_unavailable' });
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-error"]').exists()).toBe(true);
    expect(w.find('[data-test="account-error"]').text()).toContain('storage unavailable');
    expect(w.findAll('[role="option"]')).toHaveLength(0); // no mailbox content, no fallback

    await w.find('[data-test="account-retry"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-error"]').exists()).toBe(false);
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('disconnect closes the reader, clears the list, and ignores stale responses', async () => {
    gmail();
    const pending = deferred<Conversation>();
    const staleSnapshot = deferred<InboxSnapshot>();
    let deferDetailOnce = false;
    let deferListOnce = false;
    const client: MailClient = {
      ...counted.client,
      getConversation: (ref) => {
        if (deferDetailOnce) {
          deferDetailOnce = false;
          return pending.promise;
        }
        return counted.client.getConversation(ref);
      },
      listConversations: () => {
        if (deferListOnce) {
          deferListOnce = false;
          return staleSnapshot.promise;
        }
        return counted.client.listConversations();
      },
    };
    const w = mountApp(client);
    await settle();
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(true);

    // Leave one deferred list + one deferred detail response in flight.
    deferListOnce = true;
    deferDetailOnce = true;
    window.dispatchEvent(new Event('focus'));
    await flushPromises();
    expect(w.find('[data-test="reader"]').exists()).toBe(true); // deferred detail still loading

    await w.find('[data-test="account-disconnect"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    expect(w.find('[data-test="account-connection"]').text()).toContain('Disconnected');
    expect(w.find('[data-test="account-connect"]').exists()).toBe(true);

    // The stale responses arrive after the disconnect; nothing may repopulate.
    pending.resolve(await fake.getConversation(fixtureRef('conv-01')));
    staleSnapshot.resolve(await fake.listConversations());
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.findAll('[role="option"]')).toHaveLength(0);
  });
});
