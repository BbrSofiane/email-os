import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, type VueWrapper } from '@vue/test-utils';
import type { MailClient } from '../../src/lib/ipc/client';
import { countingClient, createBrowserFakeMailClient, mountApp as mountSharedApp, press, useGmailMode, type BrowserFake } from '../helpers';
import { flushFakeClientWithMacrotasks } from '../support/ui-settle';

// Follow-ups left open by PR #34 that still reproduced on main: the g-chord hint
// offering a key that does nothing, the palette offering Create split and Show
// unread only on a zero-row Inbox, and Provider mail saying nothing about an
// expired sign-in. (The 16px inline hit areas are measured in a real browser:
// tests/layout/inline-action-targets.rendered.test.ts.)

/** A client whose inbox list is always empty, over a fake that keeps reporting its real account status. */
function withNoRows(client: MailClient): MailClient {
  return { ...client, listConversations: async () => ({ conversations: [], activity: [] }) };
}

describe('account UI follow-ups', () => {
  let fake: BrowserFake;
  let wrapper: VueWrapper | null = null;
  const none = { connection: 'disconnected', emailAddress: null, cachedConversations: 0, initialSyncComplete: false } as const;
  const expired = { connection: 'auth_required', cachedConversations: 0 } as const;

  async function mount(patch: Parameters<typeof useGmailMode>[1], noRows: boolean): Promise<VueWrapper> {
    useGmailMode(fake, patch);
    wrapper = mountSharedApp(noRows ? withNoRows(countingClient(fake).client) : countingClient(fake).client, 'browser-preview', { attachTo: document.body });
    await flushFakeClientWithMacrotasks(fake, 3);
    return wrapper;
  }
  const paletteIds = async (w: VueWrapper): Promise<string[]> => {
    await w.get('[data-test="palette-trigger"]').trigger('click');
    await flushPromises();
    return w.findAll('[role="option"]').map((option) => option.attributes('id')!);
  };
  const hint = (w: VueWrapper): string => w.get('[data-test="chord-hint"] .visually-hidden').text();

  beforeEach(() => { fake = createBrowserFakeMailClient(() => '2025-01-01T00:00:00.000Z'); });
  afterEach(() => { vi.restoreAllMocks(); wrapper?.unmount(); wrapper = null; });

  describe('g-chord hint offers only keys that work', () => {
    it('with no account it does not offer E for Done (Done needs an account): only Reminders and Account', async () => {
      const w = await mount(none, true);
      document.body.focus();
      press('g', { bubbles: true, cancelable: true }); await flushPromises();
      expect(hint(w)).toBe('g pressed. Press H for Reminders or A for Account, Escape to cancel.');
    });

    it('every key it offers does something with no account, and E is left to its plain meaning', async () => {
      const w = await mount(none, true);
      document.body.focus();
      press('g', { bubbles: true, cancelable: true });
      const e = press('e', { bubbles: true, cancelable: true }); await flushPromises();
      expect(e.defaultPrevented).toBe(false);
      expect(w.get('[data-test="inbox-title"]').text()).toBe('Inbox');

      press('g', { bubbles: true, cancelable: true });
      const a = press('a', { bubbles: true, cancelable: true }); await flushPromises();
      expect(a.defaultPrevented).toBe(true);
      expect(w.find('[data-test="account-panel"]').exists()).toBe(true);
    });

    it('with an account (expired sign-in) E for Done is still offered and works', async () => {
      const w = await mount(expired, false);
      (w.get('[data-test="conversation-row-conv-02"]').element as HTMLElement).focus();
      press('g', { bubbles: true, cancelable: true }); await flushPromises();
      expect(hint(w)).toContain('E for Done');
      press('e', { bubbles: true, cancelable: true }); await flushPromises();
      expect(w.get('[data-test="inbox-title"]').text()).toBe('Cached Done');
    });
  });

  describe('palette does not offer Create split or Show unread only on a zero-row Inbox', () => {
    it('hides both on a plain Inbox with no rows (connected, or an expired sign-in)', async () => {
      const w = await mount({ connection: 'connected', cachedConversations: 0 }, true);
      const ids = await paletteIds(w);
      expect(ids).not.toContain('action-create-split');
      expect(ids).not.toContain('action-toggle-unread-filter');
      // The rest of the palette is unchanged.
      expect(ids).toContain('action-compose');
      expect(ids).toContain('action-inbox');
      w.unmount();

      const e = await mount(expired, true);
      const expiredIds = await paletteIds(e);
      expect(expiredIds).not.toContain('action-create-split');
      expect(expiredIds).not.toContain('action-toggle-unread-filter');
    });

    it('offers both once the Inbox has rows', async () => {
      const w = await mount({ connection: 'connected' }, false);
      const ids = await paletteIds(w);
      expect(ids).toContain('action-create-split');
      expect(ids).toContain('action-toggle-unread-filter');
    });

    it('keeps the way out of the unread filter when the filter itself leaves the list empty', async () => {
      // Every row is read, so Unread only shows nothing: Show all conversations must stay offered.
      useGmailMode(fake, { connection: 'connected' });
      const allRead: MailClient = { ...fake, listConversations: async () => {
        const snapshot = await fake.listConversations();
        return { ...snapshot, conversations: snapshot.conversations.map((row) => ({ ...row, isRead: true })) };
      } };
      wrapper = mountSharedApp(allRead, 'browser-preview', { attachTo: document.body });
      await flushFakeClientWithMacrotasks(fake, 3);
      const w = wrapper;
      expect(await paletteIds(w)).toContain('action-toggle-unread-filter');
      await w.get('#action-toggle-unread-filter').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(w.find('[data-test="inbox-empty"]').exists()).toBe(true);
      expect(w.find('[data-test="unread-filter-status"]').exists()).toBe(true);
      const ids = await paletteIds(w);
      expect(ids).toContain('action-toggle-unread-filter');
      expect(w.get('#action-toggle-unread-filter').text()).toContain('Show all conversations');
    });
  });

  describe('Provider mail says when the sign-in has expired', () => {
    const openProviderMail = async (w: VueWrapper): Promise<void> => {
      await w.get('[data-test="rail-destinations"]').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
    };

    it('shows Sign-in expired. with a Sign in again action, above the still-readable catalog', async () => {
      const w = await mount(expired, false);
      await openProviderMail(w);
      const note = w.get('[data-test="destinations-sign-in-expired"]');
      expect(note.text()).toContain('Sign-in expired.');
      expect(note.get('button').text()).toBe('Sign in again');
      expect(note.get('button').classes()).toContain('inline-action');
      expect(w.find('.provider-destinations').exists()).toBe(true);
    });

    it('Sign in again reconnects, keeps focus in the drawer, and the note goes away', async () => {
      const w = await mount(expired, false);
      await openProviderMail(w);
      await w.get('[data-test="destinations-sign-in-expired"] button').trigger('click');
      await flushFakeClientWithMacrotasks(fake, 3);
      expect(fake.controls.accountState().connection).toBe('connected');
      expect(w.find('[data-test="destinations-sign-in-expired"]').exists()).toBe(false);
      expect(document.activeElement).not.toBe(document.body);
      expect(w.get('[data-test="utility-drawer"]').element.contains(document.activeElement)).toBe(true);
    });

    it('says nothing about sign-in while connected', async () => {
      const w = await mount({ connection: 'connected' }, false);
      await openProviderMail(w);
      expect(w.find('[data-test="destinations-sign-in-expired"]').exists()).toBe(false);
    });
  });
});
