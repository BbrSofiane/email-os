import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import App from '../src/App.vue';
import type { MailClient } from '../src/lib/ipc/client';
import {
  conversationRows,
  countingClient,
  createBrowserFakeMailClient,
  flushMacrotasks,
  useGmailMode,
  type BrowserFake,
  type CountingClient,
} from './helpers';

/** A client whose inbox list is always empty, over a fake that keeps reporting its real account status. */
function withNoRows(client: MailClient): MailClient {
  return { ...client, listConversations: async () => ({ conversations: [], activity: [] }) };
}

describe('account, connection and first-run (empty inbox, header status, commands)', () => {
  let fake: BrowserFake;
  let counted: CountingClient;
  let wrapper: VueWrapper | null = null;

  function mountApp(client: MailClient = counted.client): VueWrapper {
    const w = mount(App, { props: { client, mode: 'browser-preview' }, attachTo: document.body });
    wrapper = w;
    return w;
  }
  async function settle(): Promise<void> {
    await flushPromises();
    await fake.controls.flush();
    await flushPromises();
    await flushMacrotasks(3);
    await flushPromises();
  }
  function gmail(patch: Parameters<typeof useGmailMode>[1] = {}): void {
    useGmailMode(fake, patch);
  }
  const empty = (w: VueWrapper) => w.get('[data-test="inbox-empty"]');
  const note = (w: VueWrapper) => w.find('[data-test="account-status-note"]');
  const none = { connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false } as const;

  beforeEach(() => {
    fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    counted = countingClient(fake);
  });
  afterEach(() => {
    wrapper?.unmount();
    wrapper = null;
    vi.restoreAllMocks();
  });

  describe('P0: the empty inbox line tells the truth', () => {
    it('disconnected: says Not connected with an inline Connect Gmail instead of the inbox-empty claim', async () => {
      gmail(none);
      const w = mountApp();
      await settle();
      expect(empty(w).text()).toContain('Not connected.');
      expect(empty(w).text()).not.toContain('currently in the inbox');
      expect(empty(w).text()).not.toContain('Activity');
      const action = w.get('[data-test="inbox-empty-action"]');
      expect(action.text()).toBe('Connect Gmail');
      await action.trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(conversationRows(w)).toHaveLength(18);
      // Focus is not stranded on the removed button.
      expect(document.activeElement).not.toBe(document.body);
      expect(w.get('.inbox-list').element.contains(document.activeElement)).toBe(true);
    });

    it('keeps focus on the empty line while the same line changes state', async () => {
      gmail(none);
      const w = mountApp(withNoRows(counted.client));
      await settle();
      (w.get('[data-test="inbox-empty-action"]').element as HTMLElement).focus();
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await settle();
      // Connected, first sync complete, still zero rows: the real empty text, focus on the line.
      expect(empty(w).text()).toContain('No conversations in the cached inbox.');
      expect(document.activeElement).toBe(empty(w).element);
    });

    it('not_configured: no Connect action, only a link to Account', async () => {
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp();
      await settle();
      expect(empty(w).text()).toContain('Gmail is not configured on this device.');
      expect(empty(w).text()).not.toContain('Connect');
      const action = w.get('[data-test="inbox-empty-action"]');
      expect(action.text()).toBe('Account');
      await action.trigger('click');
      await settle();
      expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    it('auth_required with an empty cache: Sign-in expired with Sign in again', async () => {
      gmail({ connection: 'auth_required', cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toContain('Sign-in expired.');
      expect(w.get('[data-test="inbox-empty-action"]').text()).toBe('Sign in again');
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('connected');
    });

    it('authenticating: Finish sign-in in your browser with a Cancel that goes through the disconnect path', async () => {
      gmail({ connection: 'authenticating', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toContain('Finish sign-in in your browser.');
      expect(w.get('[data-test="inbox-empty-action"]').text()).toBe('Cancel');
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('disconnected');
      expect(empty(w).text()).toContain('Not connected.');
      expect(document.activeElement).toBe(empty(w).element);
    });

    it('first sync running: a count, no action', async () => {
      gmail({ syncState: 'syncing', cachedConversations: 7, initialSyncComplete: false });
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toContain('Syncing first mail… 7 cached.');
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
      expect(empty(w).text()).not.toContain('currently in the inbox');
    });

    it('first sync failed: names the cause and Retry calls the same sync request', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' }, cachedConversations: 0, initialSyncComplete: false });
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toContain('Sync failed: The network is unavailable.');
      const retry = w.get('[data-test="inbox-empty-action"]');
      expect(retry.text()).toBe('Retry');
      await retry.trigger('click');
      await settle();
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('connected but the first sync never finished: Initial sync has not finished with Sync now', async () => {
      gmail({ cachedConversations: 0, initialSyncComplete: false });
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toContain('Initial sync has not finished.');
      expect(empty(w).text()).not.toContain('currently in the inbox');
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await settle();
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('connected and synced: the real empty text, without an Activity promise where Mark not done is not offered', async () => {
      gmail({ cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toBe('No conversations in the cached inbox.');
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
    });

    it('connected with mailbox actions on keeps the exact recovery sentence; fixture mode is unchanged', async () => {
      gmail({ cachedConversations: 0, mutationAccess: 'enabled' });
      const w = mountApp(withNoRows(counted.client));
      await settle();
      expect(empty(w).text()).toBe('No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.');
      w.unmount();

      const fixture = createBrowserFakeMailClient();
      const f = mount(App, { props: { client: withNoRows(fixture), mode: 'browser-preview' }, attachTo: document.body });
      wrapper = f;
      await flushPromises();
      await flushMacrotasks(2);
      expect(f.get('[data-test="inbox-empty"]').text()).toBe('No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.');
      expect(f.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
    });

    it('other contexts keep their own wording (starred filter while disconnected)', async () => {
      gmail(none);
      const w = mountApp();
      await settle();
      await w.get('[data-test="starred-filter"]').trigger('click');
      await settle();
      expect(empty(w).text()).toContain('No known starred conversations');
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
    });
  });

  describe('reachability with no account (verified, ungated)', () => {
    it('the Account rail entry, the palette entries and the empty-state Connect all exist and work', async () => {
      gmail(none);
      const w = mountApp();
      await settle();
      expect(w.find('[data-test="rail-account"]').exists()).toBe(true);
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushPromises();
      expect(w.find('#action-account').exists()).toBe(true);
      expect(w.get('#action-connect').text()).toContain('Connect Gmail');
      await w.get('#action-connect').trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(conversationRows(w)).toHaveLength(18);
    });
  });

  describe('P1: one global status note in the header', () => {
    it('is absent in fixture mode and while connected and idle (the read-only hint stays)', async () => {
      const fixture = mountApp(fake);
      await settle();
      expect(note(fixture).exists()).toBe(false);
      fixture.unmount();
      gmail();
      const w = mountApp();
      await settle();
      expect(note(w).exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);
    });

    it('disconnected: Not connected with a Connect link, and the read-only hint steps aside', async () => {
      gmail(none);
      const w = mountApp();
      await settle();
      const n = note(w);
      expect(n.attributes('role')).toBe('status');
      expect(n.classes()).toContain('header-note');
      expect(n.find('[aria-hidden="true"]').text()).toContain('Not connected');
      expect(n.get('button').classes()).toContain('header-link');
      expect(n.get('button').text()).toBe('Connect');
      expect(n.attributes('title')).toBeTruthy();
      expect(n.get('.visually-hidden').text()).toBe(n.attributes('title'));
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      await n.get('button').trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(note(w).exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);
    });

    it('auth_required: Sign-in expired, a Sign in link, and only the honest reading fact (no claim that actions are off)', async () => {
      gmail({ connection: 'auth_required' });
      const w = mountApp();
      await settle();
      const n = note(w);
      expect(n.find('[aria-hidden="true"]').text()).toContain('Sign-in expired');
      expect(n.get('button').text()).toBe('Sign in');
      expect(n.attributes('title')).toContain('Cached mail stays readable; new mail will not sync until you sign in.');
      expect(n.text().toLowerCase()).not.toContain('actions off');
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      await n.get('button').trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('connected');
    });

    it('authenticating: Cancel stops the sign-in; not_configured offers a link to Account', async () => {
      gmail({ connection: 'authenticating' });
      const w = mountApp();
      await settle();
      expect(note(w).find('[aria-hidden="true"]').text()).toContain('Finish sign-in in your browser');
      await note(w).get('button').trigger('click');
      await settle();
      expect(fake.controls.accountState().connection).toBe('disconnected');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const nc = mountApp();
      await settle();
      expect(note(nc).find('[aria-hidden="true"]').text()).toContain('Gmail not configured');
      expect(nc.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      await note(nc).get('button').trigger('click');
      await settle();
      expect(nc.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    it('syncing: a quiet note that keeps the read-only hint, with no live churn while the count ticks', async () => {
      gmail({ syncState: 'syncing', cachedConversations: 7, initialSyncComplete: false });
      const w = mountApp();
      await settle();
      const n = note(w);
      expect(n.find('[aria-hidden="true"]').text()).toContain('Syncing first mail · 7 cached');
      expect(n.find('button').exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);
      const hiddenBefore = n.get('.visually-hidden').element.textContent;
      const hiddenNode = n.get('.visually-hidden').element;
      fake.controls.setAccount({ cachedConversations: 8 });
      await settle();
      expect(note(w).find('[aria-hidden="true"]').text()).toContain('8 cached');
      // The announced text neither changed nor was replaced, so nothing is re-announced.
      expect(note(w).get('.visually-hidden').element).toBe(hiddenNode);
      expect(note(w).get('.visually-hidden').element.textContent).toBe(hiddenBefore);
    });

    it('sync error: Offline only for network_unavailable, Sync failed otherwise, Retry runs a sync', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' } });
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp();
      await settle();
      expect(note(w).find('[aria-hidden="true"]').text()).toContain('Offline');
      expect(note(w).get('button').text()).toBe('Retry');
      fake.controls.setAccount({ syncError: { kind: 'provider_unavailable' } });
      await settle();
      expect(note(w).find('[aria-hidden="true"]').text()).toContain('Sync failed');
      expect(note(w).find('[aria-hidden="true"]').text()).not.toContain('Offline');
      expect(note(w).attributes('title')).toContain('The mail provider is temporarily unavailable.');
      await note(w).get('button').trigger('click');
      await settle();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(note(w).exists()).toBe(false);
    });

    it('does not strand focus when the header action disappears', async () => {
      gmail(none);
      const w = mountApp();
      await settle();
      (note(w).get('button').element as HTMLElement).focus();
      await note(w).get('button').trigger('click');
      await settle();
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  describe('P3: Connect and Sync now commands, and g a', () => {
    async function paletteIds(w: VueWrapper): Promise<string[]> {
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushPromises();
      const ids = w.findAll('[role="option"]').map((option) => option.attributes('id')!);
      return ids;
    }

    it('offers Connect Gmail only where Connect can run, and Sign in again after expiry', async () => {
      gmail(none);
      const w = mountApp();
      await settle();
      const ids = await paletteIds(w);
      expect(ids).toContain('action-connect');
      expect(ids).not.toContain('action-sync');
      expect(w.get('#action-connect').text()).toContain('Connect Gmail');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'auth_required' });
      const expired = mountApp();
      await settle();
      await paletteIds(expired);
      expect(expired.get('#action-connect').text()).toContain('Sign in again');
    });

    it('offers Sync now only while connected and not syncing, and runs the same sync request', async () => {
      gmail();
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp();
      await settle();
      const ids = await paletteIds(w);
      expect(ids).toContain('action-sync');
      expect(ids).not.toContain('action-connect');
      expect(w.get('#action-sync').text()).toContain('Sync now');
      await w.get('#action-sync').trigger('click');
      await settle();
      expect(sync).toHaveBeenCalledTimes(1);
      expect(fake.controls.accountState().lastSyncedAt).not.toBeNull();
    });

    it('hides Sync now while a sync runs and both commands in fixture mode and in the destinations navigator', async () => {
      gmail({ syncState: 'syncing' });
      const w = mountApp();
      await settle();
      expect(await paletteIds(w)).not.toContain('action-sync');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      const fixture = mountApp();
      await settle();
      const fixtureIds = await paletteIds(fixture);
      expect(fixtureIds).not.toContain('action-sync');
      expect(fixtureIds).not.toContain('action-connect');
      fixture.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail(none);
      const nav = mountApp();
      await settle();
      await nav.get('[data-test="navigator-trigger"]').trigger('click');
      await flushPromises();
      const navIds = nav.findAll('[role="option"]').map((option) => option.attributes('id'));
      expect(navIds).toContain('action-account');
      expect(navIds).not.toContain('action-connect');
      expect(navIds).not.toContain('action-sync');
    });

    it('labels the Account command with its chord', async () => {
      gmail();
      const w = mountApp();
      await settle();
      await paletteIds(w);
      expect(w.get('#action-account kbd').text()).toBe('G then A');
      expect(w.get('#action-account kbd').attributes('title')).toBe('G then A (within 1 second)');
      expect(w.get('[data-test="rail-account"]').attributes('title')).toContain('G then A');
    });
  });
});
