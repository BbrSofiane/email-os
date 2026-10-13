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

  it('does not expose Gmail Retry for a failed fixture archive', async () => {
    fake.controls.behavior.failNext = 1;
    const w = mountApp();
    await settle();
    await w.find('[data-test="row-archive-conv-01"]').trigger('click');
    await settle();
    const failed = w.find('[data-test="activity-failed"]');
    expect(failed.exists()).toBe(true);
    expect(failed.find('[data-test^="activity-retry-"]').exists()).toBe(false);
  });

  it('moves focus to the empty inbox after archiving its last row with the row button', async () => {
    for (let index = 2; index <= 18; index += 1) {
      await fake.setArchived({
        conversation: fixtureRef(`conv-${String(index).padStart(2, '0')}`),
        archived: true,
        requestId: `setup-archive-${index}`,
      });
    }
    await fake.controls.flush();
    const w = mountApp();
    await settle();
    expect(w.findAll('[role="option"]')).toHaveLength(1);
    const archiveButton = w.find('[data-test="row-archive-conv-01"]');
    (archiveButton.element as HTMLButtonElement).focus();
    await archiveButton.trigger('click');
    await settle();
    const empty = w.find('[data-test="inbox-empty"]');
    expect(empty.exists()).toBe(true);
    expect(document.activeElement).toBe(empty.element);
  });

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

  it('requires explicit opt-in and keeps archive/read controls guarded until verified enablement', async () => {
    gmail();
    fake.controls.markReadUnknown('conv-01');
    const w = mountApp();
    await settle();
    expect(w.find('[data-test="account-mode"]').text()).toContain('read-only');
    expect(w.find('[data-test="row-read-unknown"]').exists()).toBe(true);
    expect(w.find('[data-test="action-upgrade-disclosure"]').text()).toContain('sending and deleting');
    expect(w.find('[data-test="row-archive-conv-01"]').exists()).toBe(false);
    expect(w.find('[data-test="row-toggle-read-conv-01"]').exists()).toBe(false);

    fake.controls.failNextEnable({ kind: 'permission_required' });
    await w.find('[data-test="enable-mailbox-actions"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-action-error"]').text()).toContain('remains read-only');
    expect(w.find('[data-test="account-mode"]').text()).toContain('read-only');
    expect(w.find('[data-test="row-archive-conv-01"]').exists()).toBe(false);

    // Cached reading stays available after denial; opening never sends a mutation.
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader-read-state"]').text()).toBe('Read state unknown');
    expect(w.find('[data-test="reader"]').exists()).toBe(true);
    expect(fake.controls.activity()).toHaveLength(0);
  });

  it('shows upgrading/cancel states and cancellation preserves the connected account', async () => {
    gmail();
    fake.controls.behavior.holdUpgrade = true;
    const w = mountApp();
    await settle();
    await w.find('[data-test="enable-mailbox-actions"]').trigger('click');
    await flushPromises();
    expect(w.find('[data-test="account-mode"]').text()).toContain('Permission upgrade');
    expect(w.find('[data-test="action-upgrading"]').exists()).toBe(true);
    expect(w.find('[data-test="cancel-action-upgrade"]').exists()).toBe(true);
    expect(w.find('[data-test="row-archive-conv-01"]').exists()).toBe(false);

    await w.find('[data-test="cancel-action-upgrade"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-mode"]').text()).toContain('read-only');
    expect(w.find('[data-test="account-email"]').text()).toBe('operator@example.test');
    expect(w.findAll('[role="option"]')).toHaveLength(18);
    fake.controls.releaseUpgrade();
    await settle();
    expect((await fake.getAccountStatus()).mutationAccess).toBe('read_only');
  });

  it('enables explicit Gmail actions only after status says enabled and opening does not mark read', async () => {
    gmail();
    const w = mountApp();
    await settle();
    await w.find('[data-test="enable-mailbox-actions"]').trigger('click');
    await settle();
    expect(w.find('[data-test="actions-enabled"]').exists()).toBe(true);
    expect(w.find('[data-test="row-archive-conv-01"]').exists()).toBe(true);
    expect(w.find('[data-test="row-toggle-read-conv-01"]').exists()).toBe(true);
    const before = fake.controls.activity().length;
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader-no-auto-read"]').exists()).toBe(true);
    expect(w.find('[data-test="reader-toggle-read"]').exists()).toBe(true);
    expect(fake.controls.activity()).toHaveLength(before);
  });

  it('discloses unknown read state and requires an explicit choice in list and reader', async () => {
    gmail({ mutationAccess: 'enabled' });
    fake.controls.markReadUnknown('conv-01');
    const w = mountApp();
    await settle();
    const unknownRow = w.find('[data-test="row-read-unknown"]');
    expect(unknownRow.exists()).toBe(true);
    expect(w.find('[data-test="row-mark-read-conv-01"]').exists()).toBe(true);
    expect(w.find('[data-test="row-mark-unread-conv-01"]').exists()).toBe(true);
    await w.find('[data-test="row-mark-read-conv-01"]').trigger('click');
    await settle();
    expect(w.find('[data-test="row-read"]').exists()).toBe(true);
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    expect(w.find('[data-test="reader-read-state"]').text()).toBe('Read');
    await w.find('[data-test="reader-toggle-read"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader-read-state"]').text()).toBe('Unread');
    expect(fake.controls.activity().map((op) => op.requestedRead)).toEqual([true, false]);
  });

  it('enables Gmail archive only after explicit grant and recovers archived mail from Activity', async () => {
    gmail();
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'e' }));
    await settle();
    expect(fake.controls.activity()).toHaveLength(0);
    await w.find('[data-test="enable-mailbox-actions"]').trigger('click');
    await settle();
    await w.find('[data-test="row-archive-conv-01"]').trigger('click');
    await settle();
    expect(w.findAll('[role="option"]')).toHaveLength(17);
    const archive = fake.controls.activity().find((op) => op.requestedArchived);
    expect(archive?.status).toBe('confirmed');
    fake.controls.markRetainedSnapshot('conv-01', '2025-02-03T04:05:06Z');
    await w.find(`[data-test="activity-open-${archive!.id}"]`).trigger('click');
    await settle();
    expect(w.find('[data-test="retained-snapshot-notice"]').text()).toBe(
      'Local recovery snapshot saved at 2025-02-03T04:05:06Z; Gmail may have newer messages or mailbox changes.',
    );
    expect(w.find('[data-test="reader-archive-toggle"]').text()).toContain('Unarchive');
    await w.find('[data-test="reader-archive-toggle"]').trigger('click');
    await settle();
    expect(w.findAll('[role="option"]')).toHaveLength(18);
  });

  it('documents Shift+U as explicit mark-unread and guards modifiers/IME/text fields', async () => {
    gmail();
    const w = mountApp();
    await settle();
    window.dispatchEvent(keydown({ key: 'U', shiftKey: true }));
    await settle();
    expect(fake.controls.activity()).toHaveLength(0); // readonly before explicit grant

    await w.find('[data-test="enable-mailbox-actions"]').trigger('click');
    await settle();
    window.dispatchEvent(keydown({ key: 'U', shiftKey: true, ctrlKey: true }));
    window.dispatchEvent(keydown({ key: 'U', shiftKey: true, metaKey: true }));
    window.dispatchEvent(keydown({ key: 'U', shiftKey: true, altKey: true }));
    const ime = keydown({ key: 'U', shiftKey: true });
    Object.defineProperty(ime, 'isComposing', { value: true });
    window.dispatchEvent(ime);
    const input = document.createElement('textarea');
    document.body.appendChild(input);
    input.dispatchEvent(keydown({ key: 'U', shiftKey: true }));
    input.remove();
    await settle();
    expect(fake.controls.activity()).toHaveLength(0);

    window.dispatchEvent(keydown({ key: 'U', shiftKey: true }));
    await settle();
    expect(fake.controls.activity()[0]).toMatchObject({ kind: 'read', requestedRead: false, status: 'confirmed' });
  });

  it('shows visibly different pending/unknown/retry/confirmed activity with a fresh retry key', async () => {
    gmail({ mutationAccess: 'enabled' });
    const w = mountApp();
    await settle();
    fake.controls.behavior.hold = true;
    const original = await fake.setArchived({ conversation: fixtureRef('conv-01'), archived: true, requestId: 'retry-original' });
    await flushPromises();
    expect(w.find('[data-test="activity-applying"]').exists()).toBe(true);
    expect(w.find('[data-test="activity-applying"]').text()).toContain('archive');
    fake.controls.release();
    await settle();
    expect(w.find('[data-test="activity-confirmed"]').exists()).toBe(true);
    fake.controls.behavior.hold = false;

    fake.controls.behavior.failureKind = 'outcome_unknown';
    fake.controls.behavior.failNext = 1;
    const unknown = await fake.setArchived({ conversation: fixtureRef('conv-02'), archived: true, requestId: 'uncertain-original' });
    await settle();
    const unknownRow = w.find(`[data-test="activity-outcome_unknown"]`);
    expect(unknownRow.exists()).toBe(true);
    expect(unknownRow.text()).toContain('outcome unknown');
    expect(unknownRow.text()).toContain('could not be confirmed');
    expect(unknownRow.find('[data-test="activity-unknown-warning"]').text()).toContain('may override');
    await unknownRow.find(`[data-test="activity-retry-${unknown.operationId}"]`).trigger('click');
    await settle();
    expect(counted.retryCommands).toHaveLength(1);
    expect(counted.retryCommands[0]?.operationId).toBe(unknown.operationId);
    expect(counted.retryCommands[0]?.requestId).not.toBe('uncertain-original');
    expect(w.find('[data-test="activity-confirmed"]').exists()).toBe(true);
    expect(fake.controls.activity().find((op) => op.id === original.operationId)?.status).toBe('confirmed');
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

  it('restores usable reader actions after a delayed receipt is invalidated by disconnect', async () => {
    gmail({ mutationAccess: 'enabled' });
    const receiptGate = deferred<Awaited<ReturnType<MailClient['setArchived']>>>();
    let staleReceipt: Awaited<ReturnType<MailClient['setArchived']>> | null = null;
    let setArchivedCalls = 0;
    const client: MailClient = {
      ...counted.client,
      setArchived: async (command) => {
        setArchivedCalls += 1;
        const receipt = await fake.setArchived(command);
        if (setArchivedCalls === 1) {
          staleReceipt = receipt;
          return receiptGate.promise;
        }
        return receipt;
      },
    };
    const w = mountApp(client);
    await settle();
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();
    const initialArchive = w.find('[data-test="reader-archive-toggle"]');
    expect((initialArchive.element as HTMLButtonElement).disabled).toBe(false);
    await initialArchive.trigger('click');
    expect(setArchivedCalls).toBe(1);
    await fake.controls.flush();

    await w.find('[data-test="account-disconnect"]').trigger('click');
    await settle();
    expect(w.find('[data-test="reader"]').exists()).toBe(false);
    expect(w.findAll('[role="option"]')).toHaveLength(0);
    const accepted = staleReceipt;
    if (!accepted) throw new Error('expected delayed mutation receipt');
    receiptGate.resolve(accepted);
    await settle();

    await w.find('[data-test="account-connect"]').trigger('click');
    await settle();
    await w.find('[data-test="enable-mailbox-actions"]').trigger('click');
    await settle();
    expect(w.find('[data-test="account-mode"]').text()).toContain('enabled');
    expect(w.findAll('[role="option"]').length).toBeGreaterThan(0);
    await w.findAll('[role="option"]')[0]!.trigger('click');
    await settle();

    const restoredArchive = w.find('[data-test="reader-archive-toggle"]');
    expect(restoredArchive.exists()).toBe(true);
    expect((restoredArchive.element as HTMLButtonElement).disabled).toBe(false);
    await restoredArchive.trigger('click');
    await settle();
    expect(setArchivedCalls).toBe(2);
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
