import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { MailClient } from '../../src/lib/ipc/client';
import {
  conversationRows,
  countingClient,
  createBrowserFakeMailClient,
  flushMacrotasks,
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

describe('account, connection and first-run (empty inbox, header status, commands)', () => {
  let fake: BrowserFake;
  let counted: CountingClient;

  const mountApp = (client: MailClient = counted.client): VueWrapper => mountSharedApp(client, 'browser-preview', { attachTo: document.body });
  function gmail(patch: Parameters<typeof useGmailMode>[1] = {}): void {
    useGmailMode(fake, patch);
  }
  const empty = (w: VueWrapper) => w.get('[data-test="inbox-empty"]');
  const note = (w: VueWrapper) => w.find('[data-test="account-status-note"]');
  /** Visible = not visually hidden: what a sighted person reads in the header. */
  const visibleNote = (w: VueWrapper) => w.find('[data-test="account-status-note"]:not(.visually-hidden)');
  const openAccountDrawer = async (w: VueWrapper): Promise<void> => {
    await w.get('[data-test="rail-account"]').trigger('click');
    await flushFakeClientWithMacrotasks(fake, 3);
  };
  const none = { connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false } as const;

  beforeEach(() => {
    fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
    counted = countingClient(fake);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('P0: the empty inbox line tells the truth', () => {
    it('disconnected: says Not connected with an inline Connect Gmail instead of the inbox-empty claim', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Not connected.');
      expect(empty(w).text()).not.toContain('currently in the inbox');
      expect(empty(w).text()).not.toContain('Activity');
      const action = w.get('[data-test="inbox-empty-action"]');
      expect(action.text()).toBe('Connect Gmail');
      await action.trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(conversationRows(w)).toHaveLength(18);
      // Focus is not stranded on the removed button.
      expect(document.activeElement).not.toBe(document.body);
      expect(w.get('.inbox-list').element.contains(document.activeElement)).toBe(true);
    });

    it('disconnected: one Ash line says what Connect does; no other state gets it', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const hint = w.get('[data-test="inbox-empty-hint"]');
      expect(hint.text()).toBe("Opens Google sign-in in your browser. Starts read-only: Email OS can't change your mail until you enable mailbox actions in Account.");
      expect(hint.classes()).toContain('list-state-hint');
      expect(empty(w).text()).toContain('Not connected.');
      w.unmount();

      for (const [patch, withRows] of [
        [{ connection: 'auth_required', cachedConversations: 0 }, true],
        [{ connection: 'authenticating', emailAddress: null, cachedConversations: 0, initialSyncComplete: false }, true],
      ] as const) {
        fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
        counted = countingClient(fake);
        gmail(patch);
        const other = mountApp(withRows ? withNoRows(counted.client) : counted.client);
        await flushFakeClientWithMacrotasks(fake, 3);
        expect(other.find('[data-test="inbox-empty"]').exists()).toBe(true);
        expect(other.find('[data-test="inbox-empty-hint"]').exists(), patch.connection).toBe(false);
        other.unmount();
      }
    });

    it('keeps focus on the empty line while the same line changes state', async () => {
      gmail(none);
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      (w.get('[data-test="inbox-empty-action"]').element as HTMLElement).focus();
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      // Connected, first sync complete, still zero rows: the real empty text, focus on the line.
      expect(empty(w).text()).toContain('No conversations in the cached inbox.');
      expect(document.activeElement).toBe(empty(w).element);
    });

    it('not_configured: no Connect action, only a link to Account', async () => {
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Gmail is not configured on this device.');
      expect(empty(w).text()).not.toContain('Connect');
      // A next step, not only a link: what to do about it, in one quiet line.
      expect(w.get('[data-test="inbox-empty-hint"]').text()).toBe('Add a Google client ID to the launch environment, then restart.');
      const action = w.get('[data-test="inbox-empty-action"]');
      expect(action.text()).toBe('Account');
      await action.trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    describe('tone: the empty line echoes the header note tone, the words stay', () => {
      const cases: Array<[string, Parameters<typeof useGmailMode>[1], string]> = [
        ['sync failed (cause known)', { syncState: 'error', syncError: { kind: 'network_unavailable' }, cachedConversations: 0, initialSyncComplete: false }, 'danger'],
        ['sync failed (cause unknown)', { syncState: 'error', syncError: null, cachedConversations: 0, initialSyncComplete: false }, 'danger'],
        ['sign-in expired', { connection: 'auth_required', cachedConversations: 0 }, 'warning'],
        ['not connected', none, 'neutral'],
        ['not configured', { connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false }, 'neutral'],
        ['finishing sign-in', { connection: 'authenticating' }, 'neutral'],
        ['first sync running', { syncState: 'syncing', cachedConversations: 3, initialSyncComplete: false }, 'neutral'],
        ['first sync unfinished', { cachedConversations: 0, initialSyncComplete: false }, 'neutral'],
        ['connected and empty', { cachedConversations: 0 }, 'neutral'],
      ];
      it.each(cases)('%s is %s', async (_label, patch, tone) => {
        gmail(patch);
        const w = mountApp(withNoRows(counted.client));
        await flushFakeClientWithMacrotasks(fake, 3);
        expect(empty(w).attributes('data-tone')).toBe(tone);
        expect(empty(w).classes()).toContain(`tone-${tone}`);
        // The action link and the quieter hint are not recoloured: only the sentence carries the tone.
        for (const part of [w.find('[data-test="inbox-empty-action"]'), w.find('[data-test="inbox-empty-hint"]')]) {
          if (part.exists()) expect(part.classes().some((name) => name.startsWith('tone-'))).toBe(false);
        }
        // Where the header note exists its tone is the same one.
        if (note(w).exists()) expect(note(w).classes()).toContain(`tone-${tone}`);
      });

      it('keeps the empty-line focus handling when the tone changes under it', async () => {
        gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' }, cachedConversations: 0, initialSyncComplete: false });
        const w = mountApp(withNoRows(counted.client));
        await flushFakeClientWithMacrotasks(fake, 3);
        expect(empty(w).attributes('tabindex')).toBe('-1');
        await w.get('[data-test="inbox-empty-action"]').trigger('click');
        await flushFakeClientWithMacrotasks(fake, 3);
        expect(empty(w).attributes('data-tone')).toBe('neutral');
        expect(document.activeElement).not.toBe(document.body);
      });
    });

    it('auth_required with an empty cache: Sign-in expired with Sign in again', async () => {
      gmail({ connection: 'auth_required', cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Sign-in expired.');
      expect(w.get('[data-test="inbox-empty-action"]').text()).toBe('Sign in again');
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
    });

    it('authenticating: Finish sign-in in your browser with a Cancel that goes through the disconnect path', async () => {
      gmail({ connection: 'authenticating', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Finish sign-in in your browser.');
      expect(w.get('[data-test="inbox-empty-action"]').text()).toBe('Cancel sign-in');
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('disconnected');
      expect(empty(w).text()).toContain('Not connected.');
      expect(document.activeElement).toBe(empty(w).element);
    });

    it('first sync running: a count, no action', async () => {
      gmail({ syncState: 'syncing', cachedConversations: 7, initialSyncComplete: false });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Syncing first mail… 7 cached.');
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
      expect(empty(w).text()).not.toContain('currently in the inbox');
    });

    it('first sync failed: names the cause and Retry calls the same sync request', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' }, cachedConversations: 0, initialSyncComplete: false });
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Sync failed: no network.');
      expect(empty(w).text()).not.toContain('The network is unavailable');
      const retry = w.get('[data-test="inbox-empty-action"]');
      expect(retry.text()).toBe('Retry');
      await retry.trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('connected but the first sync never finished: Initial sync has not finished with Sync now', async () => {
      gmail({ cachedConversations: 0, initialSyncComplete: false });
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Initial sync has not finished.');
      expect(empty(w).text()).not.toContain('currently in the inbox');
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(sync).toHaveBeenCalledTimes(1);
    });

    it('connected and synced: the real empty text, without an Activity promise where Mark not done is not offered', async () => {
      gmail({ cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toBe('No conversations in the cached inbox.');
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
    });

    it('connected with mailbox actions on keeps the exact recovery sentence; fixture mode is unchanged', async () => {
      gmail({ cachedConversations: 0, mutationAccess: 'enabled' });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toBe('No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.');
      w.unmount();

      const fixture = createBrowserFakeMailClient();
      const f = mountSharedApp(withNoRows(fixture), 'browser-preview', { attachTo: document.body });
      await flushPromises();
      await flushMacrotasks(2);
      expect(f.get('[data-test="inbox-empty"]').text()).toBe('No conversations are currently in the inbox. Archived conversations stay recoverable from Activity.');
      expect(f.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
    });

    it('other contexts keep their own wording (starred filter while disconnected)', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="starred-filter"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('No known starred conversations');
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
    });
  });

  describe('reachability with no account (verified, ungated)', () => {
    it('the Account rail entry, the palette entries and the empty-state Connect all exist and work', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="rail-account"]').exists()).toBe(true);
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushPromises();
      expect(w.find('#action-account').exists()).toBe(true);
      expect(w.get('#action-connect').text()).toContain('Connect Gmail');
      await w.get('#action-connect').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(conversationRows(w)).toHaveLength(18);
    });
  });

  describe('P1: one global status note in the header', () => {
    it('is absent in fixture mode and while connected and idle (the read-only hint stays)', async () => {
      const fixture = mountApp(fake);
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(fixture).exists()).toBe(false);
      fixture.unmount();
      gmail();
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(w).exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);
    });

    it('disconnected, no rows: the empty line owns the status sentence; the header drops its words and keeps one announcement', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Not connected.');
      const n = note(w);
      // Not visible: the words are the empty line's. Kept in the DOM only as the one polite announcement.
      expect(n.classes()).toContain('visually-hidden');
      expect(visibleNote(w).exists()).toBe(false);
      expect(n.attributes('role')).toBe('status');
      expect(n.get('span.visually-hidden').text()).toBe(n.attributes('title'));
      expect(empty(w).attributes('role')).toBeUndefined();
      expect(empty(w).find('[role="status"], [aria-live]').exists()).toBe(false);
      // One Connect on the page: the empty line owns it, so the header has no duplicate link.
      expect(n.find('button').exists()).toBe(false);
      expect(w.findAll('button').filter((b) => /^Connect/.test(b.text()) && b.element.closest('.app-main') && !b.element.closest('.utility-drawer'))).toHaveLength(1);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      await w.get('[data-test="inbox-empty-action"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(note(w).exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);
    });

    it('with rows the header note is visible and announces, exactly as before', async () => {
      const donor = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      useGmailMode(donor);
      const snapshot = await donor.listConversations();
      gmail(none);
      const w = mountApp({ ...counted.client, listConversations: async () => snapshot });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(conversationRows(w).length).toBeGreaterThan(0);
      const n = visibleNote(w);
      expect(n.exists()).toBe(true);
      expect(n.attributes('role')).toBe('status');
      expect(n.find('[aria-hidden="true"]').text()).toContain('Not connected');
    });

    it('never shows the ticking cached count twice: first sync with no rows counts in the empty line only', async () => {
      gmail({ syncState: 'syncing', cachedConversations: 7, initialSyncComplete: false });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Syncing first mail… 7 cached.');
      expect(visibleNote(w).exists()).toBe(false);
      const hidden = note(w);
      expect(hidden.classes()).toContain('visually-hidden');
      // The announced text carries no count, so a ticking count is never announced.
      expect(hidden.get('span.visually-hidden').text()).not.toMatch(/\d/);
      fake.controls.setAccount({ cachedConversations: 9 });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('9 cached');
      expect(visibleNote(w).exists()).toBe(false);
    });

    it('a zero-row inbox that is connected and synced leaves a later sync note visible (the empty line says no status)', async () => {
      gmail({ cachedConversations: 0, syncState: 'syncing' });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toBe('No conversations in the cached inbox.');
      expect(visibleNote(w).get('[aria-hidden="true"]').text()).toBe('Syncing…');
    });

    it('keeps its action link when the empty line does not carry one (cached rows are shown)', async () => {
      const donor = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      useGmailMode(donor);
      const snapshot = await donor.listConversations();
      gmail(none);
      const w = mountApp({ ...counted.client, listConversations: async () => snapshot });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(conversationRows(w).length).toBeGreaterThan(0);
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
      const link = note(w).get('button');
      expect(link.text()).toBe('Connect Gmail');
      expect(link.classes()).toContain('header-link');
      await link.trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
    });

    it('auth_required: Sign-in expired, a Sign in again link, and only the honest reading fact (no claim that actions are off)', async () => {
      gmail({ connection: 'auth_required' });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const n = note(w);
      expect(n.find('[aria-hidden="true"]').text()).toContain('Sign-in expired');
      expect(n.get('button').text()).toBe('Sign in again');
      expect(n.attributes('title')).toContain('Cached mail stays readable; new mail will not sync until you sign in.');
      expect(n.text().toLowerCase()).not.toContain('actions off');
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      await n.get('button').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
    });

    it('authenticating: Cancel stops the sign-in; not_configured offers a link to Account', async () => {
      gmail({ connection: 'authenticating' });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(w).find('[aria-hidden="true"]').text()).toContain('Finish sign-in in your browser');
      expect(note(w).get('button').text()).toBe('Cancel sign-in');
      await note(w).get('button').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('disconnected');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const nc = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(nc).find('[aria-hidden="true"]').text()).toContain('Gmail not configured');
      expect(nc.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      // Exactly one Account link: the empty line has it, the header says nothing visible.
      expect(note(nc).find('button').exists()).toBe(false);
      expect(visibleNote(nc).exists()).toBe(false);
      const accountLinks = [...nc.findAll('[data-test="account-status-action"], [data-test="inbox-empty-action"]')].filter((b) => b.text() === 'Account');
      expect(accountLinks).toHaveLength(1);
      await nc.get('[data-test="inbox-empty-action"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(nc.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    it('not_configured with another context in the list keeps the header Account link (no empty line carries it)', async () => {
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="starred-filter"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="inbox-empty-action"]').exists()).toBe(false);
      expect(note(w).get('button').text()).toBe('Account');
      await note(w).get('button').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    it('syncing: a quiet note that replaces the read-only hint, with no live churn while the count ticks', async () => {
      gmail({ syncState: 'syncing', cachedConversations: 7, initialSyncComplete: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const n = note(w);
      expect(n.find('[aria-hidden="true"]').text()).toContain('Syncing first mail · 7 cached');
      expect(n.find('button').exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      const hiddenBefore = n.get('.visually-hidden').element.textContent;
      const hiddenNode = n.get('.visually-hidden').element;
      fake.controls.setAccount({ cachedConversations: 8 });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(w).find('[aria-hidden="true"]').text()).toContain('8 cached');
      // The announced text neither changed nor was replaced, so nothing is re-announced.
      expect(note(w).get('.visually-hidden').element).toBe(hiddenNode);
      expect(note(w).get('.visually-hidden').element.textContent).toBe(hiddenBefore);
    });

    it('sync error: Sync failed with the cause in words (no hover needed), no Offline, the hint steps aside, Retry runs a sync', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' } });
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(w).find('[aria-hidden="true"]').text()).toBe('Sync failed · no network');
      expect(note(w).classes()).toContain('tone-danger');
      expect(note(w).text()).not.toMatch(/offline/i);
      expect(note(w).attributes('title')).not.toMatch(/offline/i);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(false);
      expect(note(w).get('button').text()).toBe('Retry');
      expect(note(w).attributes('title')).toContain('Sync failed: no network.');
      fake.controls.setAccount({ syncError: { kind: 'provider_unavailable' } });
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(w).find('[aria-hidden="true"]').text()).toBe('Sync failed · provider unavailable');
      expect(note(w).attributes('title')).toContain('The mail provider is temporarily unavailable.');
      await note(w).get('button').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(note(w).exists()).toBe(false);
      expect(w.find('[data-test="mailbox-access-hint"]').exists()).toBe(true);
    });

    it('sync error with no rows: the empty line carries the sentence and Retry; the header shows no words', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' }, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(empty(w).text()).toContain('Sync failed: no network.');
      expect(w.get('[data-test="inbox-empty-action"]').text()).toBe('Retry');
      expect(visibleNote(w).exists()).toBe(false);
      expect(note(w).classes()).toContain('visually-hidden');
      expect(note(w).find('button').exists()).toBe(false);
    });

    it('does not show or announce a sync failure twice while the Account drawer shows it as an alert', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' } });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(w).attributes('role')).toBe('status');
      expect(visibleNote(w).exists()).toBe(true);
      expect(note(w).get('button').text()).toBe('Retry');
      await openAccountDrawer(w);
      expect(w.get('[data-test="account-sync-error"]').attributes('role')).toBe('alert');
      // The drawer's Retry is the one visible fix: the header shows no words and no link, and says nothing to assistive tech.
      expect(visibleNote(w).exists()).toBe(false);
      expect(note(w).classes()).toContain('visually-hidden');
      expect(note(w).find('button').exists()).toBe(false);
      expect(note(w).attributes('role')).toBeUndefined();
      expect(note(w).get('span.visually-hidden').attributes('aria-hidden')).toBe('true');
      expect(w.findAll('[role="status"], [role="alert"]').filter((n) => n.text().includes('Sync failed'))).toHaveLength(1);
      expect(w.findAll('button').filter((b) => b.text() === 'Retry' && !b.element.closest('.utility-drawer'))).toHaveLength(0);
      expect(w.findAll('button').filter((b) => b.text() === 'Retry')).toHaveLength(1);
      // Closing the drawer gives the words, the link and the announcement back.
      await w.get('[data-test="drawer-close"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(visibleNote(w).exists()).toBe(true);
      expect(note(w).get('button').text()).toBe('Retry');
      expect(note(w).attributes('role')).toBe('status');
      expect(note(w).get('span.visually-hidden').attributes('aria-hidden')).toBeUndefined();
    });

    it('keeps the Preview tag visible while the drawer hides the duplicate failure', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' } });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openAccountDrawer(w);
      const tag = w.get('[data-test="preview-banner"]');
      expect(tag.classes()).not.toContain('visually-hidden');
      expect(tag.get('[aria-hidden="true"]').text()).toContain('Preview');
    });

    it('does not hide the words of a failure the drawer does not repeat (no typed cause, or a connection note)', async () => {
      gmail({ syncState: 'error', syncError: null });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openAccountDrawer(w);
      expect(w.find('[data-test="account-sync-error"]').exists()).toBe(false);
      expect(visibleNote(w).exists()).toBe(true);
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'auth_required' });
      const expired = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openAccountDrawer(expired);
      expect(visibleNote(expired).exists()).toBe(true);
    });

    it('does not strand focus when the header action disappears', async () => {
      gmail({ connection: 'auth_required' });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      (note(w).get('button').element as HTMLElement).focus();
      await note(w).get('button').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(document.activeElement).not.toBe(document.body);
    });
  });

  describe('P1: header tab floor (markup; the widths are CSS and cannot be measured in jsdom)', () => {
    it('gives a long saved-split name its full text as a title, since the label stops at 12ch', async () => {
      gmail({ mutationAccess: 'enabled' });
      const snap = await fake.listConversations();
      await fake.saveSavedSplit(snap.conversations[0]!.ref.accountId, { name: 'Clients and partners 2026', criterion: 'domain', value: 'example.test', enabled: true, hideWhenEmpty: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const tab = w.get('[data-test="split-saved"]');
      expect(tab.get('.split-label').text()).toBe('Clients and partners 2026');
      expect(tab.attributes('title')).toBe('Clients and partners 2026');
    });

    it('splits the status words into a lead that stays whole and a detail that yields, without changing the text', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'network_unavailable' }, initialSyncComplete: false, cachedConversations: 4 });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const words = note(w).get('.note-text');
      expect(words.text()).toBe('Sync failed · no network · 4 cached');
      expect(words.get('.note-lead').text()).toBe('Sync failed');
      expect(words.get('.note-detail').text()).toBe('· no network · 4 cached');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'auth_required' });
      const expired = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(note(expired).get('.note-lead').text()).toBe('Sign-in expired');
      expect(note(expired).find('.note-detail').exists()).toBe(false);
    });

    it('splits the Preview tag into a short word and a detail the narrow breakpoint can drop, keeping the full disclosure', async () => {
      gmail();
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const tag = w.get('[data-test="preview-banner"]');
      expect(tag.get('[aria-hidden="true"]').text()).toBe('Preview · in-memory');
      expect(tag.get('.preview-word').text()).toBe('Preview');
      expect(tag.get('.preview-detail').text()).toBe('· in-memory');
      expect(tag.get('.visually-hidden').text()).toContain('in-memory');
      expect(tag.attributes('title')).toBeTruthy();
    });

    it('wraps the read-only hint words so they can collapse to the Review access link without losing the state', async () => {
      gmail();
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const hint = w.get('[data-test="mailbox-access-hint"]');
      expect(hint.get('.hint-text').text()).toBe('Gmail is read-only');
      expect(hint.get('button').text()).toContain('Review access');
      // Under the narrow breakpoint the words are visually hidden by CSS, not removed: they stay in the accessibility tree.
      expect(hint.text()).toContain('Gmail is read-only');
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
      await flushFakeClientWithMacrotasks(fake, 3);
      const ids = await paletteIds(w);
      expect(ids).toContain('action-connect');
      expect(ids).not.toContain('action-sync');
      expect(w.get('#action-connect').text()).toContain('Connect Gmail');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'auth_required' });
      const expired = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await paletteIds(expired);
      expect(expired.get('#action-connect').text()).toContain('Sign in again');
    });

    it('offers Sync now only while connected and not syncing, and runs the same sync request', async () => {
      gmail();
      const sync = vi.spyOn(fake, 'requestSync');
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const ids = await paletteIds(w);
      expect(ids).toContain('action-sync');
      expect(ids).not.toContain('action-connect');
      expect(w.get('#action-sync').text()).toContain('Sync now');
      await w.get('#action-sync').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(sync).toHaveBeenCalledTimes(1);
      expect(fake.controls.accountState().lastSyncedAt).not.toBeNull();
    });

    it('hides Sync now while a sync runs and both commands in fixture mode and in the destinations navigator', async () => {
      gmail({ syncState: 'syncing' });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(await paletteIds(w)).not.toContain('action-sync');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      const fixture = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      const fixtureIds = await paletteIds(fixture);
      expect(fixtureIds).not.toContain('action-sync');
      expect(fixtureIds).not.toContain('action-connect');
      fixture.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail(none);
      const nav = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
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
      await flushFakeClientWithMacrotasks(fake, 3);
      await paletteIds(w);
      expect(w.get('#action-account kbd').text()).toBe('G then A');
      expect(w.get('#action-account kbd').attributes('title')).toBeUndefined(); // no timing note to carry: the chord is the whole shortcut
      expect(w.get('[data-test="rail-account"]').attributes('title')).toContain('G then A');
    });
  });
  describe('P3: palette order, Keys, contact pane and Provider mail without an account', () => {
    async function openPalette(w: VueWrapper): Promise<void> {
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushPromises();
    }
    const optionIds = (w: VueWrapper) => w.findAll('[role="option"]').map((o) => o.attributes('id'));

    it('ranks Connect Gmail above Go to Account while disconnected', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openPalette(w);
      const ids = optionIds(w);
      expect(ids.indexOf('action-connect')).toBeGreaterThanOrEqual(0);
      expect(ids.indexOf('action-connect')).toBeLessThan(ids.indexOf('action-account'));
      // The highlighted (Enter) row is the one the person most likely wants.
      expect(w.get('[role="option"].highlighted').attributes('id')).toBe('action-connect');
    });

    it('keeps conversation commands first for a signed-out account that still shows cached rows, with Connect above Go to Account', async () => {
      gmail({ connection: 'auth_required' });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openPalette(w);
      const ids = optionIds(w);
      expect(ids.indexOf('action-connect')).toBeLessThan(ids.indexOf('action-account'));
      expect(ids.indexOf('action-open')).toBeLessThan(ids.indexOf('action-connect'));
    });

    it('ranks Sync now first while a sync failure shows (it is the one fix), and keeps it below Go to Account otherwise', async () => {
      gmail({ syncState: 'error', syncError: { kind: 'rate_limited' } });
      const failed = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openPalette(failed);
      const ids = optionIds(failed);
      expect(ids.indexOf('action-sync')).toBe(0);
      expect(ids.indexOf('action-sync')).toBeLessThan(ids.indexOf('action-open'));
      expect(ids.indexOf('action-sync')).toBeLessThan(ids.indexOf('action-account'));
      expect(failed.get('[role="option"].highlighted').attributes('id')).toBe('action-sync');
      failed.unmount();

      fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      counted = countingClient(fake);
      gmail();
      const idle = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openPalette(idle);
      const idleIds = optionIds(idle);
      expect(idleIds.indexOf('action-sync')).toBeGreaterThan(idleIds.indexOf('action-account'));
    });

    it('hides the row Keys when there are no rows, and keeps the one that is not about rows', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(conversationRows(w)).toHaveLength(0);
      await openPalette(w);
      const keys = w.find('.action-keys');
      expect(keys.text()).not.toContain('Next and previous conversation');
      expect(keys.text()).not.toContain('Select conversation');
      expect(keys.text()).not.toContain('Extend selection');
      w.unmount();

      fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      counted = countingClient(fake);
      gmail();
      const rows = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(conversationRows(rows).length).toBeGreaterThan(0);
      await openPalette(rows);
      expect(rows.get('.action-keys').text()).toContain('Next and previous conversation');
    });

    it('does not show "No correspondent information is available." when the list has no rows, in any state', async () => {
      const states: Array<[string, Parameters<typeof useGmailMode>[1], boolean]> = [
        ['disconnected', none, false],
        ['not configured', { connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false }, false],
        ['signed out, no rows', { connection: 'auth_required', cachedConversations: 0 }, true],
        ['first sync running', { syncState: 'syncing', cachedConversations: 3, initialSyncComplete: false }, true],
        ['sync failed', { syncState: 'error', syncError: { kind: 'network_unavailable' } }, true],
        ['connected and empty', { cachedConversations: 0 }, true],
      ];
      for (const [label, patch, empty] of states) {
        fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
        counted = countingClient(fake);
        gmail(patch);
        const w = mountApp(empty ? withNoRows(counted.client) : counted.client);
        await flushFakeClientWithMacrotasks(fake, 3);
        expect(conversationRows(w), label).toHaveLength(0);
        expect(w.find('[data-test="contact-unknown"]').exists(), label).toBe(false);
        w.unmount();
      }
    });

    it('keeps the correspondent line when rows exist, so a real unknown sender is still disclosed', async () => {
      gmail();
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(conversationRows(w).length).toBeGreaterThan(0);
      // Rows exist, so the pane is in its normal mode: the known contact shows, not the empty-list silence.
      expect(w.find('[data-test="contact-identity"]').exists()).toBe(true);
    });

    it('the left-arrow key still opens the navigator when there is no account (the Keys row is live)', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      (w.get('[data-test="inbox-empty"]').element as HTMLElement).focus();
      press('ArrowLeft', { bubbles: true, cancelable: true });
      await flushPromises();
      expect(w.find('[role="dialog"]').exists()).toBe(true);
      expect(w.find('#action-account').exists()).toBe(true);
    });

    it('Provider mail without an account: disconnected offers Connect Gmail (read-only start), not configured offers Account', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="rail-destinations"]').trigger('click');
      await flushPromises();
      const required = w.get('[data-test="destinations-account-required"]');
      expect(required.text()).toContain('Provider mail needs a connected Gmail account.');
      const connect = w.get('[data-test="destinations-account-action"]');
      expect(connect.text()).toBe('Connect Gmail');
      expect(connect.classes()).toContain('inline-action');
      await connect.trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(w.find('.provider-destinations').exists()).toBe(true);
      // Focus did not fall to <body> when the button went away.
      expect(document.activeElement).not.toBe(document.body);
      expect(w.get('[data-test="utility-drawer"]').element.contains(document.activeElement)).toBe(true);
      w.unmount();

      fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      counted = countingClient(fake);
      gmail({ connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const nc = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await nc.get('[data-test="rail-destinations"]').trigger('click');
      await flushPromises();
      const account = nc.get('[data-test="destinations-account-action"]');
      expect(account.text()).toBe('Account');
      await account.trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(nc.find('[data-test="account-panel"]').exists()).toBe(true);
      expect(nc.find('[data-test="destinations-account-required"]').exists()).toBe(false);
    });
  });
  describe('not configured offers no Connect anywhere (there is nothing to connect with)', () => {
    const notConfigured = { connection: 'not_configured', emailAddress: null, cachedConversations: 0, initialSyncComplete: false } as const;

    it('has no Connect palette command, but Go to Account stays', async () => {
      gmail(notConfigured);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushPromises();
      const ids = w.findAll('[role="option"]').map((option) => option.attributes('id'));
      expect(ids).not.toContain('action-connect');
      expect(ids).toContain('action-account');
      expect(ids).not.toContain('action-sync');
    });

    it('shows the next-step note in the Account drawer and no Connect button', async () => {
      gmail(notConfigured);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openAccountDrawer(w);
      expect(w.get('[data-test="account-not-configured"]').text()).toContain('Add a Google client ID to the launch environment, then restart.');
      expect(w.find('[data-test="account-connect"]').exists()).toBe(false);
      expect(w.get('[data-test="account-panel"]').text()).not.toMatch(/Connect Gmail/);
    });

    it('Provider mail while a sign-in is in progress says to finish it, not to connect one', async () => {
      gmail({ connection: 'authenticating', emailAddress: null, cachedConversations: 0, initialSyncComplete: false });
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await w.get('[data-test="rail-destinations"]').trigger('click');
      await flushPromises();
      const required = w.get('[data-test="destinations-account-required"]');
      expect(required.text()).toBe('Provider mail needs a connected Gmail account. Finish sign-in in your browser.');
      expect(required.text()).not.toContain('Connect one');
      expect(w.find('[data-test="destinations-account-action"]').exists()).toBe(false);
    });

    it('offers no Connect on any surface; the one link is Account, and Provider mail says the same', async () => {
      gmail(notConfigured);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.findAll('button').filter((b) => /connect/i.test(b.text()) && !/disconnect/i.test(b.text()))).toHaveLength(0);
      await w.get('[data-test="rail-destinations"]').trigger('click');
      await flushPromises();
      expect(w.get('[data-test="destinations-account-action"]').text()).toBe('Account');
      expect(w.get('[data-test="destinations-account-required"]').text()).not.toMatch(/Connect Gmail/);
    });

    it('still offers Connect Gmail while disconnected and Sign in again after expiry', async () => {
      gmail(none);
      const w = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openAccountDrawer(w);
      expect(w.get('[data-test="account-connect"]').text()).toBe('Connect Gmail');
      w.unmount();

      fake = createBrowserFakeMailClient();
      counted = countingClient(fake);
      gmail({ connection: 'auth_required' });
      const expired = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      await openAccountDrawer(expired);
      expect(expired.get('[data-test="account-connect"]').text()).toBe('Sign in again');
    });
  });

  describe('contact column: nothing to have a contact when the list has no rows', () => {
    const originalMatchMedia = window.matchMedia;
    afterEach(() => { window.matchMedia = originalMatchMedia; });
    function narrowViewport(): void {
      window.matchMedia = ((query: string) => ({
        matches: false, media: query, onchange: null,
        addListener: () => undefined, removeListener: () => undefined,
        addEventListener: () => undefined, removeEventListener: () => undefined, dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }

    it('wide: collapses the column (not a blank slab) in a zero-row inbox, and keeps it with rows', async () => {
      gmail({ cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
      expect(w.find('[data-test="contact-column"]').exists()).toBe(false);
      expect(w.get('.app-main').classes()).toContain('contact-collapsed');
      w.unmount();

      fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      counted = countingClient(fake);
      gmail();
      const rows = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(conversationRows(rows).length).toBeGreaterThan(0);
      expect(rows.find('[data-test="contact-column"]').exists()).toBe(true);
      expect(rows.get('.app-main').classes()).not.toContain('contact-collapsed');
    });

    it('collapses in every zero-row status, not only when connected', async () => {
      for (const patch of [none, { connection: 'auth_required' as const, cachedConversations: 0 }, { syncState: 'error' as const, syncError: { kind: 'network_unavailable' as const }, cachedConversations: 0, initialSyncComplete: false }]) {
        fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
        counted = countingClient(fake);
        gmail(patch);
        const w = mountApp(withNoRows(counted.client));
        await flushFakeClientWithMacrotasks(fake, 3);
        expect(w.find('[data-test="contact-column"]').exists(), JSON.stringify(patch)).toBe(false);
        w.unmount();
      }
    });

    it('does not collapse while the list is still loading or has failed (rows may still arrive)', async () => {
      gmail();
      const never = { ...counted.client, listConversations: () => new Promise<never>(() => undefined) } as MailClient;
      const w = mountApp(never);
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="inbox-loading"]').exists()).toBe(true);
      expect(w.find('[data-test="contact-column"]').exists()).toBe(true);
      expect(w.get('.app-main').classes()).not.toContain('contact-collapsed');
    });

    it('narrow: the rail has no Contact button when the list has no rows, and has it with rows', async () => {
      narrowViewport();
      gmail({ cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
      expect(w.find('[data-test="contact-disclosure"]').exists()).toBe(false);
      expect(w.find('[data-test="contact-column"]').exists()).toBe(false);
      w.unmount();

      fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z');
      counted = countingClient(fake);
      gmail();
      const rows = mountApp();
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(rows.find('[data-test="contact-disclosure"]').exists()).toBe(true);
      await rows.get('[data-test="contact-disclosure"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(rows.find('[data-test="contact-disclosure-panel"]').exists()).toBe(true);
    });

    it('the rest of the rail stays reachable by keyboard when the Contact button is gone', async () => {
      narrowViewport();
      gmail({ cachedConversations: 0 });
      const w = mountApp(withNoRows(counted.client));
      await flushFakeClientWithMacrotasks(fake, 3);
      const items = w.findAll('.rail-item').map((item) => item.attributes('data-test'));
      expect(items).toContain('rail-inbox');
      expect(items).toContain('rail-account');
      expect(items).not.toContain('contact-disclosure');
    });

    it('hands focus to the empty line when the column is removed under focus (last row gone)', async () => {
      gmail();
      let rowsOn = true;
      const client = { ...counted.client, listConversations: (...args: Parameters<MailClient['listConversations']>) => (rowsOn ? counted.client.listConversations(...args) : Promise.resolve({ conversations: [], activity: [] })) } as MailClient;
      const w = mountApp(client);
      await flushFakeClientWithMacrotasks(fake, 3);
      const column = w.get('[data-test="contact-column"]').element as HTMLElement;
      column.focus();
      expect(document.activeElement).toBe(column);
      rowsOn = false;
      await w.get('[data-test="palette-trigger"]').trigger('click');
      await flushPromises();
      await w.get('#action-sync').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
      expect(w.find('[data-test="contact-column"]').exists()).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
    });
  });
});
